// Offline tests for the lightweight action registry (2026-10-16).
//
// The invariant under test is the one that matters most: an action that reaches the operating system
// reaches it exactly ONCE, and an outcome that might have landed is never replayed.

import { ActionRegistry, STATES, stateForError }
  from '../lib/action-registry.js'

let failures = 0
let checks = 0
const ok = (cond, label, detail) => {
  checks++
  if (cond) console.log(`  PASS  ${label}`)
  else { failures++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`) }
}
const section = (t) => console.log(`\n--- ${t} ---`)
const newReg = () => new ActionRegistry({ log: () => {} })

// ---------------------------------------------------------------------------------------------
section('R1  creation and unique ids')
{
  const r = newReg()
  const a = r.create('computer_move')
  const b = r.create('computer_move')
  ok(a.id !== b.id, 'two actions get different ids', `${a.id} vs ${b.id}`)
  ok(a.id.startsWith('computer_move#'), 'the id names the tool', a.id)
  ok(a.state === STATES.CREATED, 'a new action starts CREATED')
  ok(a.dispatches === 0, 'a new action has dispatched nothing')
  ok(r.snapshot(a.id) !== null, 'the record is retrievable')
}

// ---------------------------------------------------------------------------------------------
section('R2  legal transitions are accepted')
{
  const r = newReg()
  const a = r.create('computer_move')
  ok(r.transition(a.id, STATES.WAITING_APPROVAL).ok, 'CREATED -> WAITING_APPROVAL')
  ok(r.transition(a.id, STATES.APPROVED).ok, 'WAITING_APPROVAL -> APPROVED')
  ok(r.beginDispatch(a.id).ok, 'APPROVED -> EXECUTING (dispatch claimed)')
  ok(r.transition(a.id, STATES.VERIFIED, 'readback confirmed').ok, 'EXECUTING -> VERIFIED')
  ok(r.get(a.id).state === STATES.VERIFIED, 'the record ends VERIFIED')
  const t = r.snapshot(a.id).transitions
  ok(t.length >= 5, `the transition trail is recorded (${t.length} entries)`)
}

// ---------------------------------------------------------------------------------------------
section('R3  illegal transitions are refused, never silently applied')
{
  const r = newReg()
  const a = r.create('computer_move')
  const v = r.transition(a.id, STATES.VERIFIED)
  ok(v.ok === false, 'CREATED -> VERIFIED is refused (nothing was dispatched)', v.reason)
  ok(r.get(a.id).state === STATES.CREATED, 'the state is unchanged after a refusal')
  ok(r.transition(a.id, 'NOT_A_STATE').ok === false, 'an unknown state is refused')
  ok(r.transition('no-such-id', STATES.APPROVED).ok === false, 'an unknown action is refused')
}

// ---------------------------------------------------------------------------------------------
section('R4  THE CORE INVARIANT: one action, one dispatch')
{
  const r = newReg()
  const a = r.create('computer_click')
  const first = r.beginDispatch(a.id)
  ok(first.ok === true, 'the first dispatch is granted')
  const second = r.beginDispatch(a.id)
  ok(second.ok === false, 'a second dispatch is REFUSED', second.reason)
  ok(r.get(a.id).dispatches === 1, 'the dispatch counter stayed at 1')

  // The OTHER way a second dispatch can be attempted: the state has become dispatchable again (a
  // pre-dispatch handoff put it back to APPROVED) but the counter is already spent. That is the path
  // the counter exists for, and it must name itself.
  const b = r.create('computer_click')
  r.beginDispatch(b.id)
  r.transition(b.id, STATES.HUMAN_HANDOFF, 'yielded before dispatch')
  r.transition(b.id, STATES.APPROVED, 'a re-validation would have approved a retry')
  const third = r.beginDispatch(b.id)
  ok(third.ok === false, 'a re-approved action whose counter is spent is refused')
  ok(/already been dispatched/.test(third.reason), 'the reason names the spent counter', third.reason)
}

// ---------------------------------------------------------------------------------------------
section('R5  VERIFIED is terminal: a proven action is never executed again')
{
  const r = newReg()
  const a = r.create('computer_move')
  r.beginDispatch(a.id)
  r.transition(a.id, STATES.VERIFIED)
  ok(r.canDispatch(a.id).ok === false, 'a VERIFIED action cannot dispatch')
  ok(r.beginDispatch(a.id).ok === false, 'beginDispatch refuses a VERIFIED action')
  ok(r.transition(a.id, STATES.EXECUTING).ok === false, 'VERIFIED -> EXECUTING is illegal')
}

// ---------------------------------------------------------------------------------------------
section('R6  UNKNOWN is terminal for dispatch: a maybe-landed write is never replayed')
{
  const r = newReg()
  const a = r.create('computer_type')
  r.beginDispatch(a.id)
  ok(r.markUnknown(a.id, 'HUMAN_YIELD with outcome=unknown').ok, 'the action is marked UNKNOWN')
  ok(r.get(a.id).state === STATES.UNKNOWN, 'the state is UNKNOWN')
  ok(r.canDispatch(a.id).ok === false, 'an UNKNOWN action cannot dispatch', 'the whole point of the state')
  ok(r.beginDispatch(a.id).ok === false, 'beginDispatch refuses an UNKNOWN action')
  ok(r.transition(a.id, STATES.VERIFIED).ok === false, 'UNKNOWN -> VERIFIED is illegal (no evidence was gathered)')
}

// ---------------------------------------------------------------------------------------------
section('R7  CANCELLED is terminal: a cancelled action is never revived')
{
  const r = newReg()
  const a = r.create('computer_move')
  r.transition(a.id, STATES.CANCELLED, 'user pressed Ctrl+Alt+Q')
  ok(r.canDispatch(a.id).ok === false, 'a CANCELLED action cannot dispatch')
  ok(r.transition(a.id, STATES.APPROVED).ok === false, 'CANCELLED -> APPROVED is illegal', 'no resume may revive it')
  ok(r.transition(a.id, STATES.EXECUTING).ok === false, 'CANCELLED -> EXECUTING is illegal')
}

// ---------------------------------------------------------------------------------------------
section('R8  REJECTED is terminal: a denied action never runs')
{
  const r = newReg()
  const a = r.create('computer_move')
  r.transition(a.id, STATES.WAITING_APPROVAL)
  r.transition(a.id, STATES.REJECTED, 'human refused the card')
  ok(r.canDispatch(a.id).ok === false, 'a REJECTED action cannot dispatch')
  ok(r.beginDispatch(a.id).ok === false, 'beginDispatch refuses a REJECTED action')
}

// ---------------------------------------------------------------------------------------------
section('R9  HUMAN_HANDOFF: a never-sent action may dispatch; a sent one never may')
{
  // (a) The action yielded BEFORE anything was sent — the counter is still 0, so this is its one and
  //     only dispatch. This is the case the whole settle path is built to reach.
  const r = newReg()
  const a = r.create('computer_move')
  r.transition(a.id, STATES.WAITING_APPROVAL)
  ok(r.transition(a.id, STATES.HUMAN_HANDOFF, 'the desktop was busy before dispatch').ok, 'WAITING_APPROVAL -> HUMAN_HANDOFF')
  ok(r.get(a.id).dispatches === 0, 'nothing was sent, so the counter is still 0')
  ok(r.beginDispatch(a.id).ok === true, 'the retry path may claim the single dispatch it never used')
  ok(r.get(a.id).dispatches === 1, 'the counter is 1 after the claim')
  ok(r.beginDispatch(a.id).ok === false, 'and a further attempt is refused')

  // (b) The action DID send before yielding. The counter is spent; the retry path must not reach the
  //     worker again, however the state is dressed up.
  const r2 = newReg()
  const b = r2.create('computer_move')
  r2.beginDispatch(b.id)
  r2.transition(b.id, STATES.HUMAN_HANDOFF, 'yielded mid-flight')
  ok(r2.canDispatch(b.id).ok === false, 'a sent action cannot dispatch again', 'the counter is the authority')
  ok(r2.beginDispatch(b.id).ok === false, 'the retry path is refused outright')

  // (c) The outcome is UNKNOWN: a maybe-landed write. `stateForError` sends it straight to UNKNOWN,
  //     which is terminal for dispatch — verification must come from observation, never from replay.
  const r3 = newReg()
  const c = r3.create('computer_type')
  r3.beginDispatch(c.id)
  const mapped = stateForError('HUMAN_YIELD', 'unknown')
  ok(mapped === STATES.UNKNOWN, 'an unknown outcome maps to UNKNOWN, not to HUMAN_HANDOFF')
  ok(r3.transition(c.id, mapped, 'outcome=unknown').ok, 'EXECUTING -> UNKNOWN is a legal edge')
  ok(r3.canDispatch(c.id).ok === false, 'an UNKNOWN outcome refuses any further dispatch')
  ok(r3.beginDispatch(c.id).ok === false, 'the retry path cannot claim it either', 'verify by observation, never replay')
}

// ---------------------------------------------------------------------------------------------
section('R10 stateForError maps worker refusals onto the right terminal state')
{
  ok(stateForError('HUMAN_YIELD', 'unknown') === STATES.UNKNOWN, 'unknown outcome wins over the code')
  ok(stateForError('INPUT_CANCELLED', 'not-dispatched') === STATES.CANCELLED, 'cancellation maps to CANCELLED')
  ok(stateForError('ABORTED', 'not-dispatched') === STATES.CANCELLED, 'a brake maps to CANCELLED')
  ok(stateForError('HUMAN_YIELD', 'not-dispatched') === STATES.HUMAN_HANDOFF, 'a pre-dispatch yield maps to HUMAN_HANDOFF')
  ok(stateForError('SETTLE_TIMEOUT', 'not-dispatched') === STATES.APPROVED, 'a settle timeout leaves it re-plannable')
  ok(stateForError('REFRESH_REQUIRED', 'not-dispatched') === STATES.APPROVED, 'a stale target leaves it re-plannable')
  ok(stateForError('SOMETHING_ELSE', 'not-dispatched') === STATES.FAILED, 'anything else is FAILED')
}

// ---------------------------------------------------------------------------------------------
section('R11 a full successful lifecycle, in order')
{
  const r = newReg()
  const a = r.create('computer_uia_act')
  const path = [STATES.WAITING_APPROVAL, STATES.APPROVED]
  for (const s of path) ok(r.transition(a.id, s).ok, `-> ${s}`)
  ok(r.beginDispatch(a.id).ok, '-> EXECUTING (claim)')
  ok(r.transition(a.id, STATES.VERIFIED).ok, '-> VERIFIED')
  const trail = r.snapshot(a.id).transitions.map(t => t.to)
  ok(trail.join('>') === 'CREATED>WAITING_APPROVAL>APPROVED>EXECUTING>VERIFIED',
    'the recorded path matches the required lifecycle', trail.join('>'))
}

// ---------------------------------------------------------------------------------------------
section('R12 the registry is bounded and never leaks')
{
  const r = new ActionRegistry({ capacity: 8, log: () => {} })
  const first = r.create('a').id
  for (let i = 0; i < 20; i++) r.create('b')
  ok(r.list().length <= 8, `the registry stayed bounded (${r.list().length})`)
  ok(r.get(first) === undefined, 'oldest records are evicted first')
}

// ---------------------------------------------------------------------------------------------
section('R13 dispatching is refused outright for an action never minted')
{
  const r = newReg()
  ok(r.canDispatch(undefined).ok === false, 'undefined is refused')
  ok(r.canDispatch('made-up').ok === false, 'an unknown id is refused')
  ok(r.beginDispatch('made-up').ok === false, 'beginDispatch refuses an unknown id')
}

// ---------------------------------------------------------------------------------------------
section('R14 REGRESSION: a record reaches its own registry (live wiring bug, 2026-10-16)')
{
  // The bug: `actuate` read `act.action.registry` as the SOURCE of the registry. It was always
  // undefined, the guard was skipped WITHOUT an error, and the action executed while still reporting
  // `actionMayDispatch: true` — so the invariant was not enforced at all, silently. This test pins
  // the property that made the bug silent, so the same shape cannot come back unnoticed.
  const r = newReg()
  const a = r.create('cu_execute:move')
  ok(a.registry !== undefined && a.registry !== null, 'a record carries a registry back-reference')
  ok(a.registry === r, 'the back-reference is the registry that minted it')
  ok(typeof a.registry.beginDispatch === 'function', 'and it is directly usable')
  ok(a.registry.beginDispatch(a.id).ok === true, 'a claim through the back-reference works')
  ok(a.dispatches === 1, 'the claim is reflected on the record')
  ok(a.registry.beginDispatch(a.id).ok === false, 'a second claim through it is refused')
}

// ---------------------------------------------------------------------------------------------
console.log(`\n================ ${checks - failures}/${checks} checks passed ================`)
if (failures > 0) { console.log(`${failures} FAILURE(S)`); process.exit(1) }
console.log('ALL PASS')
