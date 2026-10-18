// Route-specific observations, verified against the Desktop adapters on 2026-10-02.
// A model catalog's image flag is transport permission, not a grounding test.
export function feedbackRoute (exec) {
  const routed = exec?.agent?.session?.requestHeader?.()?.config
  return {
    provider: routed?.provider ?? exec?.agent?.options?.provider,
    model: routed?.model ?? exec?.agent?.options?.model,
  }
}

export function unverifiedVisionRoute (exec) {
  const { provider, model } = feedbackRoute(exec)
  return provider === 'bigmodel-anthropic' && model === 'glm-5.3'
}

export async function feedbackMode (ctx, exec, enabled = true) {
  if (!enabled || exec?.signal?.aborted) return null
  if (unverifiedVisionRoute(exec)) return 'state'
  const { provider, model } = feedbackRoute(exec)
  const tested = (provider === 'bigmodel-anthropic' && model === 'glm-5.3-flash') ||
    (provider === 'deepseek-official' && model === 'deepseek-flash')
  if (!tested) return null
  try {
    if (!ctx.get?.('attachments')?.saveImage) return null
    const active = await ctx.get?.('llm')?.resolveModelInfo?.(provider, model, exec?.signal)
    return !exec?.signal?.aborted && active?.inputModalities?.includes('image') ? 'image' : null
  } catch { return null }
}

export const feedbackActions = new Set([
  'computer_click', 'computer_type', 'computer_key', 'computer_move',
  'computer_drag', 'computer_scroll', 'computer_select',
])

export const feedbackVerification = 'Inspect this post-action observation before claiming the task effect. An input receipt alone is not verification. If observation failed, inspect before repeating the input.'
