// Offline harness for the approval ⇄ human-handoff state machine (2026-10-16).
//
// WHY A STUB AND NOT THE REAL WORKER: the point of these tests is the ORDER of operations —
// when the native hold is armed, when it is released, whether a dispatch is attempted at all.
// A stub lets us assert that order deterministically and observe it in a log. The native half is
// covered separately by `worker.exe --op approvalHold ...` and by the integration tests.
//
// The stub respects the one invariant that matters: `call('approvalHold', {on:true})` makes the
// simulated machine report `cooperation.active === false` even when a human burst is in flight.

import { ComputerUse } from 'file:///C:/Users/liu/Documents/deepseek-harness/default-workspace/cu-release/lib/core/index.js'

let failures = 0
let checks = 0
const log = []
const ok = (cond, label, detail) => {
  checks++
  if (cond) { console.log(`  PASS  ${label}`) } else { failures++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`) }
}
const section = (t) => console.log(`\n--- ${t} ---`)

/**
 * Build a ComputerUse whose worker is simulated.
 * @param {object} script behaviour knobs:
 *   burstAt:      op index at which a "human burst" becomes active (worker-side yield)
 *   outcome:      outcome attached to a HUMAN_YIELD refusal
 *   holdEffective: whether approvalHold:{on:true} actually suppresses the burst
 */
function makeCore (script = {}) {
  const cu = new ComputerUse({ dryRun: false, log: () => {}, approvalSettleMs: 0, approvalQuietTimeoutMs: 2000 })
  const calls = []
  let humanActive = false
  let hold = false
  let dispatchCount = 0

  const coop = () => ({
    phase: humanActive && !hold ? 'yielding' : 'idle',
    active: humanActive && !hold,
    approvalHold: hold,
    revision: humanActive ? 1 : 0,
  })
  // The real core learns `cooperation` from worker EVENTS (ready/handoff/response payloads). The stub
  // has to publish it the same way, or `waitInputQuietBefore` would see a permanent idle and the
  // settle path would never be exercised. Publishing on every state change keeps the stub honest.
  const publish = () => { cu.cooperation = coop() }

  cu.ensureWorker = async () => { calls.push('ensureWorker'); return undefined }
  cu.call = async (op, args = {}) => {
    calls.push(`${op}${args.on === undefined ? '' : `:${args.on}`}`)
    if (op === 'approvalHold') {
      hold = !!args.on
      if (!hold) humanActive = false           // release re-baselines the handoff
      publish()
      return { approvalHold: hold, cooperation: coop() }
    }
    if (op === 'ping') { publish(); return { pong: true, cooperation: coop() } }
    if (op === 'windowInfo') return args.hwnd === script.windowHwnd ? { hwnd: args.hwnd, minimized: false } : undefined
    if (op === 'focus') return { match: script.focusMatch !== false }
    if (script.yieldOn && script.yieldOn.includes(op)) {
      if (!hold && humanActive) {
        const e = new Error('HUMAN_YIELD: physical input owns the desktop')
        e.code = 'HUMAN_YIELD'
        e.outcome = script.outcome || 'not-dispatched'
        throw e
      }
    }
    if (script.humanActive !== false && !hold) { humanActive = true; publish() }
    dispatchCount++
    return { ok: true, dispatched: dispatchCount }
  }

  cu.simulateHumanBurst = () => { humanActive = true; publish() }
  cu.simulateHumanIdle = () => { humanActive = false; publish() }
  // The human lets go WHILE the tool is waiting — the realistic sequence, and the only one that
  // exercises the settle path. Going idle before `actuate` would make the settle a no-op.
  cu.simulateIdleAfter = (ms) => { setTimeout(() => { humanActive = false; publish() }, ms) }
  cu.getCalls = () => calls.slice()
  cu.dispatchCount = () => dispatchCount
  cu.isHeld = () => hold
  publish()
  return cu
}

// ---------------------------------------------------------------------------------------------
section('T1  no human activity: behaviour is unchanged (zero regression)')
{
  const cu = makeCore({ humanActive: false })
  const act = { verify: null, budget: 1000, retried: false }
  const out = await cu.actuate('move', { x: 1, y: 2 }, act)
  ok(out && out.dispatched === 1, 'dispatches exactly once')
  ok(cu.getCalls().filter(c => c === 'move').length === 1, 'one move op reached the worker')
  ok(!cu.getCalls().some(c => c.startsWith('approvalHold')), 'no approval hold was armed')
}

// ---------------------------------------------------------------------------------------------
section('T2  approval hold defers takeover classification (the deadlock fix)')
{
  const cu = makeCore({ humanActive: false })
  await cu.beginApprovalHold('computer_move')
  ok(cu.isHeld() === true, 'hold is armed after beginApprovalHold')
  cu.simulateHumanBurst()                       // the click that reaches "approve once"
  ok(cu.cooperation.active === false, 'a burst during the hold does NOT report a takeover')
  const settled = await cu.endApprovalHold()
  ok(settled && settled.settled === true, 'endApprovalHold reports quiet')
  ok(cu.isHeld() === false, 'hold is released')
}

// ---------------------------------------------------------------------------------------------
section('T3  a real handoff is waited out, then the target must be re-proved')
{
  const cu = makeCore({ humanActive: false })
  cu.simulateHumanBurst()
  cu.simulateIdleAfter(60)                      // the human lets go while the tool waits
  const verified = []
  const act = { verify: async () => { verified.push(1); return { ok: true, how: 'window-identity' } }, budget: 1500, retried: false }
  const out = await cu.actuate('move', { x: 1, y: 2 }, act)
  ok(out && out.dispatched === 1, 'dispatches after the desktop becomes quiet')
  ok(verified.length === 1, 'the verifier ran exactly once before dispatch')
}

// ---------------------------------------------------------------------------------------------
section('T4  target changed during the handoff: NOTHING is dispatched')
{
  const cu = makeCore({ humanActive: false })
  cu.simulateHumanBurst()
  cu.simulateIdleAfter(60)
  const act = { verify: async () => ({ ok: false, reason: 'window contents changed' }), budget: 1500, retried: false }
  let err = null
  try { await cu.actuate('move', { x: 1, y: 2 }, act) } catch (e) { err = e }
  ok(err && err.code === 'REFRESH_REQUIRED', 'refuses with REFRESH_REQUIRED', err && err.code)
  ok(err && err.outcome === 'not-dispatched', 'the refusal is marked not-dispatched')
  ok(cu.dispatchCount() === 0, 'no input was sent')
}

// ---------------------------------------------------------------------------------------------
section('T5  a bare coordinate has no verifier: it is never replayed')
{
  const cu = makeCore({ humanActive: false })
  cu.simulateHumanBurst()
  cu.simulateIdleAfter(60)
  let err = null
  try { await cu.actuate('move', { x: 1, y: 2 }, { verify: null, budget: 1500, retried: false }) } catch (e) { err = e }
  ok(err && err.code === 'REFRESH_REQUIRED', 'coordinate-only target is refused after a handoff', err && err.code)
  ok(cu.dispatchCount() === 0, 'no blind dispatch happened')
}

// ---------------------------------------------------------------------------------------------
section('T6  HUMAN_YIELD return value: behaviour follows the outcome')
{
  // ORDER MATTERS IN THESE TWO CASES. The settle check runs BEFORE dispatch, so a burst that is
  // already active when the tool is invoked is caught by the settle and never reaches the worker's
  // HUMAN_YIELD path at all. To exercise that path the human must appear AFTER the settle passed —
  // which is exactly the real race the retry exists for.
  const buildRace = (outcome) => {
    const cu = makeCore({ humanActive: false, yieldOn: ['move'], outcome })
    const original = cu.call
    let moveSeen = 0
    cu.call = async (op, args) => {
      if (op === 'move') {
        moveSeen++
        // CASE A: the human is mid-gesture as the op is dispatched → the worker refuses.
        // CASE B: same, but the human lets go while the tool is reacting.
        if (moveSeen === 1) { cu.simulateHumanBurst(); if (outcome === 'not-dispatched') cu.simulateIdleAfter(60) }
      }
      return original(op, args)
    }
    return cu
  }

  // outcome=unknown → the worker MAY have dispatched. It must never be retried.
  const a = buildRace('unknown')
  const actA = { verify: async () => ({ ok: true }), budget: 1500, retried: false }
  let errA = null
  try { await a.actuate('move', { x: 1, y: 2 }, actA) } catch (e) { errA = e }
  ok(errA !== null, 'outcome=unknown surfaces an error', 'no error was raised')
  ok(a.dispatchCount() === 0, 'outcome=unknown is NOT retried (a double action would be worse)')
  ok(actA.retried === false, 'the retry flag was NOT consumed for an unknown outcome')

  // outcome=not-dispatched + verifier → at most one extra attempt, through the verifier.
  const b = buildRace('not-dispatched')
  const actB = { verify: async () => ({ ok: true }), budget: 1500, retried: false }
  let outB = null, errB = null
  try { outB = await b.actuate('move', { x: 1, y: 2 }, actB) } catch (e) { errB = e }
  const moveCalls = b.getCalls().filter(c => c === 'move').length
  ok(moveCalls <= 3, `the attempt count stayed bounded (got ${moveCalls})`)
  ok(actB.retried === true, 'the retry flag was consumed')
  ok(outB !== null || errB !== null, 'the call settled either way (never hung)')
  ok(b.dispatchCount() <= 1, `dispatched at most once (got ${b.dispatchCount()})`)
  await new Promise(r => setTimeout(r, 80))
}

// ---------------------------------------------------------------------------------------------
section('T7  emergency stop and cancellation win over everything')
{
  const cu = makeCore({ humanActive: false })
  cu.stopped = true
  let err = null
  try { await cu.actuate('move', { x: 1, y: 2 }, { budget: 800, retried: false }) } catch (e) { err = e }
  ok(err && err.code === 'ABORTED', 'a raised brake aborts before anything else', err && err.code)
  ok(cu.dispatchCount() === 0, 'nothing dispatched while stopped')

  const cu2 = makeCore({ humanActive: false })
  const ac = new AbortController(); ac.abort()
  let err2 = null
  try { await cu2.actuate('move', { x: 1, y: 2 }, { signal: ac.signal, budget: 800, retried: false }) } catch (e) { err2 = e }
  ok(err2 && err2.code === 'INPUT_CANCELLED', 'a cancelled tool refuses with INPUT_CANCELLED', err2 && err2.code)
  ok(cu2.dispatchCount() === 0, 'nothing dispatched after cancellation')
}

// ---------------------------------------------------------------------------------------------
section('T8  a handoff that never becomes quiet is bounded (no infinite wait)')
{
  const cu = makeCore({ humanActive: false })
  cu.simulateHumanBurst()                       // never goes idle
  const t0 = Date.now()
  let err = null
  try { await cu.actuate('move', { x: 1, y: 2 }, { budget: 300, retried: false }) } catch (e) { err = e }
  const elapsed = Date.now() - t0
  ok(err && err.code === 'SETTLE_TIMEOUT', 'refuses with SETTLE_TIMEOUT', err && err.code)
  ok(elapsed < 5000, `the wait was bounded (${elapsed} ms)`)
  ok(cu.dispatchCount() === 0, 'nothing dispatched')
}

// ---------------------------------------------------------------------------------------------
section('T9  nested approvals keep the hold until the last one settles')
{
  const cu = makeCore({ humanActive: false })
  await cu.beginApprovalHold('a')
  await cu.beginApprovalHold('b')
  ok(cu.approvalsPending === 2, 'two approvals are counted')
  const first = await cu.endApprovalHold()
  ok(first && first.settled === false, 'the first settle does not release the hold')
  ok(cu.isHeld() === true, 'the hold is still armed')
  const second = await cu.endApprovalHold()
  ok(second && second.settled === true, 'the last settle releases the hold')
  ok(cu.isHeld() === false, 'the hold is released')
}

// ---------------------------------------------------------------------------------------------
section('T10 dry run stays a dry run')
{
  const cu = makeCore({ humanActive: false })
  cu.dryRun = true
  const out = await cu.actuate('move', { x: 1, y: 2 }, { budget: 800, retried: false })
  ok(out && out.dryRun === true, 'dry run returns the simulation marker')
  ok(cu.dispatchCount() === 0, 'dry run dispatched nothing')
}

// ---------------------------------------------------------------------------------------------
console.log(`\n================ ${checks - failures}/${checks} checks passed ================`)
if (failures > 0) { console.log(`${failures} FAILURE(S)`); process.exit(1) }
console.log('ALL PASS')
