// Cycle end decision — pure, so the lifecycle rules can be tested without a Host.
//
// WHY THIS IS A SEPARATE PURE MODULE: the rule "a completed Computer Use turn ends its own cycle" lives
// inside `lib/index.js`, which is a Cordis plugin entry point and cannot be imported without a Host. A
// rule that can only be observed by restarting the application is a rule nobody can test. The DECISION is
// therefore extracted here as a pure function of the facts the caller already has; `index.js` performs the
// side effects (`gate.mark`, `cu.calm`) only after this function says the transition is legal.
//
// THE ORDER OF THE CHECKS IS THE SAFETY ORDER. Each early return is a reason NOT to cut the activity
// border, and the reasons are ordered from "not ours at all" to "ours but currently protected":
//
//   not-owner        the cycle belongs to another session, or to a later turn. Never touch it. This is what
//                    prevents a late turn/end from ending the cycle a NEW turn just opened.
//   not-open         paused / asking / already ended. Ending is not ours to do, and `ended` is terminal.
//   paused-or-asking the human's red border stays until they resume with Ctrl+Alt+R or answer.
//   human-stop       a stop or a latched brake is never released by plugin code.
//   in-flight        a tool call is still running; the request is DEFERRED and re-checked when it settles.
//
// Only when every one of those is clear does the answer become `end`.

/** The only state a turn boundary may transition out of. */
export const ENDABLE_STATE = 'open'

/**
 * Decide whether a turn boundary may end the cycle it was asked about.
 *
 * @param {object} facts
 * @param {string|null} facts.cycleState   'open' | 'paused' | 'asking' | 'ended' | null
 * @param {boolean} facts.ownsSession      is this cycle owned by the session whose turn just ended?
 * @param {boolean} facts.pausedOrAsking   is the machine paused or asking?
 * @param {boolean} facts.stopped          has the human stopped it?
 * @param {boolean} facts.brakeLatched     is a human brake latched?
 * @param {number}  facts.inFlight         tool calls currently running
 * @returns {{end: boolean, defer?: boolean, reason: string}}
 */
export function cycleEndVerdict (facts = {}) {
  const {
    cycleState = null,
    ownsSession = false,
    pausedOrAsking = false,
    stopped = false,
    brakeLatched = false,
    inFlight = 0,
  } = facts || {}

  // Never another session's cycle, and never a cycle a later turn has already opened.
  if (!ownsSession) return { end: false, reason: 'not-owner' }
  // PRIVILEGED STATES ARE CHECKED BEFORE THE CYCLE STATE. They describe the HUMAN's grip on the machine,
  // not the existence of a cycle object, and they must win whatever the JS state machine believes: a
  // paused ask keeps its red border until Ctrl+Alt+R.
  if (pausedOrAsking) return { end: false, reason: 'paused-or-asking' }
  // A human stop or brake latch is never cleared by plugin code.
  if (stopped || brakeLatched) return { end: false, reason: 'human-stop' }
  // Still driving: remember the request and re-validate when the call settles. Dropping it here was the
  // historical bug — the turn ended mid-call, nothing revisited it, and the border stayed lit.
  if (inFlight > 0) return { end: false, defer: true, reason: 'in-flight' }
  // A live cycle owned by this session: end it AND cut the light.
  if (cycleState === ENDABLE_STATE) return { end: true, reason: 'owner-turn-ended' }

  // ---- THE RESIDUE PATH (2026-10-19): JS gate says ENDED, worker light is still ON ----------------
  //
  // THE CONTRADICTION THIS RESOLVES. `cu.calm()` used to be reachable only after `gate.mark('ended')`
  // succeeded, so a worker whose light survived a JS-side transition could never be cleared: the JS gate
  // said `ended`, the verdict said `not-open`, and the border stayed lit forever. That is what the real
  // run measured — `turn-end-diag` printed `state=ended` while the worker audit printed `cycleLit=1`.
  //
  // The two pieces of state are NOT the same fact and must not gate each other:
  //   * `gate.state()` = "does the plugin believe a cycle is live?"  (JS memory, one slot)
  //   * `CycleLit`     = "is the native overlay drawing a border?"   (worker memory)
  // Only the worker can extinguish its own light, so the request must be sent whenever the cycle is OURS
  // and no human hold is in force — even when the JS side already considers it finished.
  //
  // WHY THIS CANNOT TOUCH A NEW CYCLE (the race that made "calm unconditionally" unsafe):
  //   * `ownsSession` was checked above against the CURRENT cycle, so another session's live cycle is
  //     never calmed;
  //   * `cycleState === 'open'` was handled above and returns `end`, so a NEW live cycle takes that
  //     branch instead of this one;
  //   * this branch is reached only when the current cycle is `ended` or absent — the plugin holds no
  //     live cycle, so there is no later turn's light to extinguish here;
  //   * `calm` is idempotent in the worker (`CycleLit=false; Disarm(); Glow.Kill()`) and is explicitly
  //     excluded from the "a signed call lights a cycle" gate (`worker.cs` `cycleOp`), so it can neither
  //     create nor resurrect a border. The next real `computer_*` call lights the next cycle as usual.
  return { end: false, calmWorker: true, reason: 'not-open' }
}

/**
 * Is a deferred request still actionable at execution time?
 *
 * A deferred end is re-evaluated against the CURRENT cycle, never replayed against the one that was
 * current when it was queued. That is what makes an old turn's cleanup unable to touch a new turn.
 */
export function deferredCycleEndVerdict (facts = {}) {
  return cycleEndVerdict({ ...(facts || {}), inFlight: 0 })
}
