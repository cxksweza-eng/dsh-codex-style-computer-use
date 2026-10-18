// Serial execution and observation selection; no desktop or lifecycle side effects here.
const reads = new Set(['computer_state', 'computer_uia', 'computer_marks', 'computer_shot', 'computer_wait'])
const isRead = (step) => reads.has(step?.tool) || (step?.tool === 'computer_clip' && step.args?.text === undefined)
const isReadback = (step) => ['computer_state', 'computer_uia', 'computer_marks', 'computer_shot'].includes(step.tool) ||
  (step.tool === 'computer_clip' && step.args?.text === undefined)

export function actionRefusal (step, result) {
  if (result?.ok === false || result?.success === false) return result.error || 'action reported failure'
  if (step.tool === 'computer_window' && (step.args?.op || 'activate') === 'activate' && result?.activated !== true) {
    return 'target window activation was not confirmed; subsequent actions were not dispatched'
  }
  if (step.tool === 'computer_ctrl' && step.args?.action === 'recover' && result?.recovered !== true) return result.reason || 'temporary pause recovery refused'
  return null
}

export async function runBatch ({ steps, handlers, signal, stopped, screenshot, shot = 'auto', exec }) {
  if (!Array.isArray(steps) || !['auto', 'always', 'never'].includes(shot)) throw new Error('invalid batch actions or shot mode')
  const actions = []
  let failed = false
  for (const step of steps) {
    const name = step?.tool
    if (failed || signal?.aborted) {
      actions.push({ tool: name || '', ok: false, outcome: 'not-dispatched', error: signal?.aborted ? 'cancelled' : 'earlier action failed' })
      failed = true
      continue
    }
    const fn = Object.hasOwn(handlers, name) && handlers[name]
    if (!fn) { actions.push({ tool: name || '', ok: false, outcome: 'not-dispatched', error: 'unknown tool' }); failed = true; continue }
    try {
      const stoppedBefore = stopped()
      const result = await fn(step.args || {}, exec)
      const refusal = actionRefusal(step, result)
      actions.push({ tool: name, ok: !refusal, result, ...(refusal ? { error: refusal } : {}) })
      failed = !!refusal || (!stoppedBefore && stopped()) ||
        (name === 'computer_ctrl' && ['stop', 'exit'].includes(step.args?.action))
    } catch (error) {
      actions.push({ tool: name, ok: false, error: String(error.message || error),
        code: error.code || 'action-error', outcome: error.outcome || 'unknown' })
      failed = true
    }
  }
  const needsShot = shot === 'always' || (shot === 'auto' && steps.some(s => !isRead(s)) && !isReadback(steps.at(-1) || {}))
  const result = { actions, attachedShot: null }
  if (!failed && !signal?.aborted && !stopped() && needsShot) {
    try { result.attachedShot = await screenshot() }
    catch (error) { result.observationError = String(error.message || error) }
  }
  // A transport/provider return does not prove that a form was saved or a message was sent.
  if (steps.some(s => s && !isRead(s))) result.verification = 'Inspect returned readback or image before claiming the task effect; ok only means the action returned.'
  if (result.attachedShot) result.view = 'read_image the attachedShot if visual verification is needed'
  return result
}
