import { basename } from 'node:path'
import { unverifiedVisionRoute } from './feedback.js'

// DSH image blocks reference the host's durable attachment store. Paths and raw
// base64 are not image blocks. Keep a usable file when a route cannot accept one.
export async function attachScreenshot (ctx, exec, value, data) {
  const fallback = (reason) => {
    value.imageStatus = 'path-only'
    value.imageReason = reason
    value.view = reason === 'model-text-only'
      ? 'Image not attached: this model does not declare image input. Use UIA/text or switch to an image-capable model.'
      : 'Image not attached. Use read_image on path if visual inspection is needed.'
    if (value.settled === false) value.view = 'NOT settled — re-shoot. ' + value.view
    return value
  }
  try {
    const attachments = ctx.get?.('attachments')
    const llm = ctx.get?.('llm')
    if (!attachments?.saveImage) return fallback('attachments-unavailable')
    const routed = exec?.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec?.agent?.options?.provider
    const model = routed?.model ?? exec?.agent?.options?.model
    if (!llm?.resolveModelInfo || !provider || !model) return fallback('route-unavailable')
    const active = await llm.resolveModelInfo(provider, model, exec?.signal)
    if (!active.inputModalities?.includes('image')) return fallback('model-text-only')
    if (exec?.signal?.aborted) return fallback('cancelled')
    if (!attachments.imageLimits?.mediaTypes?.includes(value.mime)) return fallback('media-type-unavailable')
    const image = await attachments.saveImage({ data, mediaType: value.mime, name: basename(value.path) })
    if (exec?.signal?.aborted) return fallback('cancelled')
    value.image = image
    value.imageStatus = 'attached'
    const r = value.region
    if (r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && image.width > 0 && image.height > 0) {
      value.coordinates = {
        screenOrigin: [r.x, r.y], imageSize: [image.width, image.height],
        screenPerImagePixel: [r.width / image.width, r.height / image.height],
      }
    }
    value.view = value.settled === false
      ? 'NOT settled — may be a partial render; re-shoot.'
      : 'Image attached. Inspect it directly; no read_image needed. Coordinates for clicks are screen pixels.'
    if (unverifiedVisionRoute(exec)) {
      value.visionStatus = 'unverified-route'
      value.view = 'Image transport succeeded, but this GLM 5.3 route failed grounding tests. Use UIA/text readback; do not infer coordinates or success from unseen pixels. The image and path are retained for inspection.'
    }
    return value
  } catch (error) {
    // Capturing succeeded; an optional image channel must not discard its path.
    return fallback(exec?.signal?.aborted ? 'cancelled' : 'attachment-failed')
  }
}

export function renderScreenshot (value) {
  const { image, ...text } = value
  return [
    { type: 'text', text: JSON.stringify(text) },
    ...(image ? [{ type: 'image', attachment: image }] : []),
  ]
}

// A batch exposes one latest image as its checkpoint. Earlier explicit captures
// keep their paths for deliberate later reads, without multiplying vision input.
export function selectBatchScreenshot (result, automatic, kind = 'image') {
  let latest = automatic
  let index
  if (!latest) {
    for (const [i, action] of result.actions.entries()) {
      if (action.tool === 'computer_shot' && action.result?.path) {
        latest = action.result
        index = i
      }
    }
  }
  for (const action of result.actions) {
    const shot = action.result
    if (shot?.image && shot !== latest) {
      delete shot.image
      shot.imageStatus = 'path-only'
      shot.imageReason = 'earlier-batch-image'
      shot.view = kind === 'state'
        ? 'A newer UIA state is returned. This earlier image remains at its path.'
        : 'Only the latest batch screenshot is attached. Use read_image on this path if this earlier frame is needed.'
    }
  }
  if (latest) {
    result.observation = latest
    if (kind === 'state') result.observationSource = 'automatic final UIA state'
    else result.imageSource = automatic ? 'automatic final screenshot' : `action ${index + 1}; captured before any later actions`
    result.view = latest.view
  }
  return result
}
