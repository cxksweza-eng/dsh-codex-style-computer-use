// ---------------------------------------------------------------------------------------------
// Lightweight action registry (2026-10-16)
//
// WHY THIS EXISTS. One rule matters more than every other in this plugin: an action that reaches the
// operating system must reach it exactly ONCE. The settle/verify/retry work made that true by
// construction, but "true by construction" is not the same as "impossible to break": any future edit
// to the retry path could re-dispatch an action whose first attempt may already have landed, and
// nothing would say so.
//
// This registry makes the rule explicit and checkable:
//   * every action gets a unique id and a legal-transition state machine;
//   * `beginDispatch()` refuses unless the action is in a state that may still dispatch, and records
//     the attempt, so a second dispatch is impossible rather than merely unintended;
//   * `unknown` is TERMINAL FOR DISPATCH: an outcome that might have landed can never be replayed;
//   * `CANCELLED` is terminal: a cancelled action is never revived by a resume;
//   * `VERIFIED` is terminal: an action that has been proven done is never executed again.
//
// Deliberately NOT a workflow engine. It holds no timers, performs no I/O, and keeps only the last
// N actions. It answers exactly one question — "may this action still be dispatched?" — and every
// other API exists to keep that answer honest.
// ---------------------------------------------------------------------------------------------

export const STATES = Object.freeze({
  CREATED: 'CREATED',
  WAITING_APPROVAL: 'WAITING_APPROVAL',
  APPROVED: 'APPROVED',
  EXECUTING: 'EXECUTING',
  VERIFYING: 'VERIFYING',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  HUMAN_HANDOFF: 'HUMAN_HANDOFF',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
})

// The ONLY legal transitions. Anything absent here is refused, which is what keeps the dispatch
// invariant from being quietly widened by a later change.
const TRANSITIONS = Object.freeze({
  [STATES.CREATED]: [STATES.WAITING_APPROVAL, STATES.APPROVED, STATES.EXECUTING, STATES.CANCELLED, STATES.FAILED, STATES.HUMAN_HANDOFF],
  [STATES.WAITING_APPROVAL]: [STATES.APPROVED, STATES.REJECTED, STATES.CANCELLED, STATES.HUMAN_HANDOFF, STATES.FAILED],
  [STATES.APPROVED]: [STATES.EXECUTING, STATES.CANCELLED, STATES.HUMAN_HANDOFF, STATES.FAILED, STATES.WAITING_APPROVAL],
  [STATES.EXECUTING]: [STATES.VERIFYING, STATES.VERIFIED, STATES.UNKNOWN, STATES.FAILED, STATES.HUMAN_HANDOFF, STATES.CANCELLED],
  [STATES.VERIFYING]: [STATES.VERIFIED, STATES.UNKNOWN, STATES.FAILED, STATES.CANCELLED, STATES.HUMAN_HANDOFF],
  // Terminal states — listed explicitly so the table itself documents the intent.
  [STATES.VERIFIED]: [],
  [STATES.REJECTED]: [],
  [STATES.CANCELLED]: [],
  [STATES.UNKNOWN]: [],
  [STATES.HUMAN_HANDOFF]: [STATES.APPROVED, STATES.WAITING_APPROVAL, STATES.CANCELLED, STATES.FAILED],
  [STATES.FAILED]: [STATES.WAITING_APPROVAL, STATES.APPROVED, STATES.CANCELLED],
})

/** States from which an action may still send its FIRST (and therefore only) dispatch. */
const DISPATCHABLE = new Set([STATES.CREATED, STATES.APPROVED, STATES.HUMAN_HANDOFF])

export const TERMINAL = new Set([
  STATES.VERIFIED, STATES.REJECTED, STATES.CANCELLED, STATES.UNKNOWN,
])

// ---------------------------------------------------------------------------------------------
// HOST CALL-ID BRIDGE (D4)
//
// The audit trail and the action registry number the same tool call differently, and neither number can
// be computed from the other:
//
//   * the Host's `callId` exists BEFORE the tool body runs — it is the token an approval is asked about;
//   * the registry id exists only once `create()` runs INSIDE the tool body.
//
// A probe on the real instance settled it: when `approvalActionId()` ran, `registrySize` was 0 and
// `pendingPresent` was false — there was simply no record yet to name. So the two are LINKED, not
// unified: this queue carries the call id from the approval hook to the moment the record is minted.
//
// PER-TOOL QUEUES, CONSUMED ONCE. Keying by tool name and shifting on use is what keeps N calls of the
// same tool from all joining to the first call's id — a wrong join is worse than no join, because it
// makes two different actions look like one.
// ---------------------------------------------------------------------------------------------
const pendingHostCallIds = new Map()   // tool name -> array of call ids, oldest first

/** Called by the approval hook: this tool is about to be approved under this Host call id. */
export function noteHostCallId (toolName, callId) {
  if (!toolName || !callId) return
  const key = String(toolName)
  const list = pendingHostCallIds.get(key) || []
  list.push(String(callId))
  // A bounded queue: an approval that is never followed by a tool body (rejected, cancelled, host
  // error) would otherwise leave an id behind and shift the queue for every later call of that tool.
  if (list.length > 8) list.shift()
  pendingHostCallIds.set(key, list)
}

/** Called by `create()`: take the oldest unclaimed call id for this tool, or null. */
export function consumeHostCallId (toolName) {
  const key = String(toolName || '')
  const list = pendingHostCallIds.get(key)
  if (!list || list.length === 0) return null
  const id = list.shift()
  if (list.length === 0) pendingHostCallIds.delete(key)
  return id
}

export class ActionRegistry {
  constructor ({ capacity = 256, log = () => {} } = {}) {
    this.actions = new Map()
    this.order = []
    this.capacity = Math.max(8, capacity)
    this.log = log
    this.seq = 0
  }

  /** Mint a unique action id. The tool name is included so a log line is readable on its own. */
  create (toolName, detail = {}) {
    const id = `${toolName || 'computer_*'}#a${++this.seq}-${Date.now().toString(36)}`
    // ---- HOST CALL-ID CORRELATION (D4) ------------------------------------------------------
    // The two id spaces are generated at different times and neither can be derived from the other:
    // the Host's `callId` exists BEFORE the tool body runs (it is what an approval is asked about),
    // and the registry id only exists once `create` runs INSIDE the tool body. So they are LINKED
    // rather than unified — the record carries the call id it belongs to, and the audit line carries
    // the registry id, which makes the pair joinable from either side.
    //
    // The link is consumed (removed from the queue) so it is used exactly once. That matters: without
    // consuming, a later call of the same tool would inherit an earlier call's id and the two would
    // join to the WRONG action — worse than not joining at all.
    const hostCallId = consumeHostCallId(toolName)
    const record = {
      id, tool: toolName || null, state: STATES.CREATED,
      hostCallId: hostCallId || null,
      attempts: 0, dispatches: 0, transitions: [],
      createdAt: Date.now(), detail,
      // Back-reference so a caller holding only the record can still reach the machine that governs
      // it. Added after a LIVE WIRING BUG (2026-10-16) in which `act.action.registry` was read as the
      // source of the registry, was always undefined, silently skipped the whole guard, and let the
      // action execute while still reporting `actionMayDispatch: true`. With both references present,
      // that shape of mistake cannot recur: either lookup resolves.
      registry: this,
    }
    record.transitions.push({ to: STATES.CREATED, at: record.createdAt })
    this.actions.set(id, record)
    this.order.push(id)
    this.#trim()
    return record
  }

  get (id) { return id ? this.actions.get(id) : undefined }

  /**
   * Number of retained records. `actions` is a PRIVATE field, so an external reader that touched it
   * directly silently sees `undefined` — which is exactly how a diagnostic once reported
   * `registrySize: 0` for a registry that was working correctly. A public accessor removes the trap
   * that made a healthy component look broken.
   */
  get size () { return this.actions.size }

  /**
   * Move an action to `next`. Returns { ok, reason } — never throws, because a state-machine refusal
   * must surface as a tool-level refusal, not as an exception that could be swallowed by a catch-all.
   */
  transition (id, next, note) {
    const rec = this.get(id)
    if (!rec) return { ok: false, reason: `unknown action ${id}` }
    if (!STATES[next]) return { ok: false, reason: `unknown state ${next}` }
    if (rec.state === next) return { ok: true, reused: true }
    const allowed = TRANSITIONS[rec.state] || []
    if (!allowed.includes(next)) {
      this.log(`[registry] illegal transition ${rec.state} -> ${next} for ${id}`)
      return { ok: false, reason: `illegal transition ${rec.state} -> ${next}` }
    }
    rec.state = next
    rec.transitions.push({ from: rec.transitions[rec.transitions.length - 1].to, to: next, at: Date.now(), note })
    return { ok: true }
  }

  /** May this action still be dispatched? The single question the registry exists to answer. */
  canDispatch (id) {
    const rec = this.get(id)
    if (!rec) return { ok: false, reason: `unknown action ${id}` }
    if (TERMINAL.has(rec.state)) return { ok: false, reason: `the action is ${rec.state} and cannot be dispatched` }
    if (!DISPATCHABLE.has(rec.state)) return { ok: false, reason: `the action is ${rec.state}, which may not dispatch` }
    if (rec.dispatches > 0) return { ok: false, reason: `the action has already been dispatched ${rec.dispatches} time(s)` }
    return { ok: true }
  }

  /**
   * Claim the one permitted dispatch. THIS is the idempotency guarantee: it increments the counter
   * before the caller is allowed to send anything, so a re-entry sees `dispatches > 0` and is refused
   * even if the first attempt is still in flight.
   */
  beginDispatch (id) {
    const verdict = this.canDispatch(id)
    if (!verdict.ok) return verdict
    const rec = this.get(id)
    rec.dispatches++
    rec.attempts++
    rec.lastDispatchAt = Date.now()
    rec.state = STATES.EXECUTING
    rec.transitions.push({ from: rec.transitions[rec.transitions.length - 1].to, to: STATES.EXECUTING, at: rec.lastDispatchAt, note: `dispatch #${rec.dispatches}` })
    return { ok: true, attempt: rec.attempts }
  }

  /** An outcome that might have landed. Terminal for dispatch. */
  markUnknown (id, reason) {
    const rec = this.get(id)
    if (!rec) return { ok: false, reason: `unknown action ${id}` }
    rec.unknownReason = reason || null
    return this.transition(id, STATES.UNKNOWN, reason)
  }

  snapshot (id) {
    const rec = this.get(id)
    if (!rec) return null
    return { id: rec.id, tool: rec.tool, state: rec.state, attempts: rec.attempts, dispatches: rec.dispatches, transitions: rec.transitions.slice() }
  }

  list () { return this.order.map(id => this.snapshot(id)) }

  #trim () {
    while (this.order.length > this.capacity) {
      const id = this.order.shift()
      this.actions.delete(id)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// PROCESS-WIDE SINGLETON (root cause of the ID-correlation gap, 2026-10-16)
//
// The registry was created per `apply()` call, and so was the `cu` object that publishes
// `pendingAction`. Two probes settled it: the WRAPPER created a record and published it
// (`sizeAfter: 1`, `pendingAfter: "computer_move#a1-…"`), while the APPROVAL HOOK — 200 seconds away
// in the same log — read `pendingActionPresent: false, registrySize: 0`. Two separate instances were
// serving the two paths, so the hook could never see the action the tool had just registered.
//
// A per-instance registry cannot answer "may THIS action still be dispatched?" across the whole
// process, which is the question it exists for. Hoisting it to module scope makes every consumer
// — tool wrapper, approval hook, cu_* tools — talk about the same actions. The accessor is exposed
// through a getter so a reloaded module still hands out the live instance.
// ---------------------------------------------------------------------------------------------
let sharedRegistry = null
export function getSharedRegistry (opts) {
  if (!sharedRegistry) sharedRegistry = new ActionRegistry(opts)
  return sharedRegistry
}

/** Map a worker/core error onto the terminal state it implies. */
export function stateForError (code, outcome) {
  if (outcome === 'unknown') return STATES.UNKNOWN
  switch (code) {
    case 'INPUT_CANCELLED': return STATES.CANCELLED
    case 'ABORTED': return STATES.CANCELLED
    case 'HUMAN_YIELD':
    case 'HUMAN_REOBSERVE': return STATES.HUMAN_HANDOFF
    case 'REFRESH_REQUIRED':
    case 'SETTLE_TIMEOUT': return STATES.APPROVED
    default: return STATES.FAILED
  }
}
