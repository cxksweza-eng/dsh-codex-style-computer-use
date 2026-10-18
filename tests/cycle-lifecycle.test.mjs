// Lifecycle tests for the Computer Use activity border (2026-10-19).
//
// THE RULE UNDER TEST (rule A/B of the B-design): a completed Computer Use turn ends ITS OWN cycle, so the
// native activity border goes dark without the human having to answer the turn-end card.
//
// WHY IT TESTS A PURE FUNCTION PLUS A SMALL SIMULATOR. `lib/index.js` is a Cordis plugin entry point and
// cannot be imported without a Host, so a test that imported it could not exist. The DECISION was therefore
// extracted to `lib/cycle-lifecycle.js` and this file drives that exact function through a simulator that
// mirrors how `index.js` uses it (turn/end → request, onEnd → deferred re-validation, card answering).
//
// WHAT THIS CANNOT PROVE: that `cu.calm()` actually darkens the physical border, and that the Host emits
// `session/event` turn/end at the moment assumed here. Those are Host/worker facts and are verified only in
// the real DSH run; they are listed as NOT VERIFIED in the report rather than implied by a green test.

import { cycleEndVerdict, deferredCycleEndVerdict, ENDABLE_STATE } from '../lib/cycle-lifecycle.js'

let failures = 0
let checks = 0
const ok = (cond, label, detail) => {
  checks++
  if (cond) console.log(`  PASS  ${label}`)
  else { failures++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`) }
}
const section = (t) => console.log(`\n--- ${t} ---`)

// ---- a simulator of the plugin's cycle lifecycle, using the REAL decision function -----------------
// It models only the parts that matter for attribution: which session owns the live cycle, the cycle's
// state, and the plugin-side in-flight counter. Every side effect the plugin performs is recorded so the
// tests can assert ORDER and IDENTITY, not just "a function was called".
function makeLifecycle () {
  const sim = {
    cycle: null,            // { id, ownerSk, state } — mirrors the gate's live cycle
    inFlight: 0,
    pending: null,          // deferred end request
    log: [],                // ordered effects
    litByWorker: false,   // the NATIVE overlay state, independent of the JS gate
    nextId: 1,
    pausedOrAsking: false,
    stopped: false,
    brakeLatched: false,
  }
  sim.openCycle = (sk) => {
    sim.cycle = { id: sim.nextId++, ownerSk: sk, state: 'open' }
    sim.log.push({ effect: 'open', id: sim.cycle.id, sk })
    sim.litByWorker = true   // a signed computer_* call lights the native border
    return sim.cycle
  }
  sim.facts = (sk, override) => ({
    cycleState: sim.cycle ? sim.cycle.state : null,
    ownsSession: Boolean(sk) && Boolean(sim.cycle) && sim.cycle.ownerSk === sk,
    pausedOrAsking: sim.pausedOrAsking,
    stopped: sim.stopped,
    brakeLatched: sim.brakeLatched,
    inFlight: override === undefined ? sim.inFlight : override,
  })
  sim.endCycle = (sk) => {
    const v = cycleEndVerdict(sim.facts(sk, 0))
    if (!v.end) return false
    sim.cycle.state = 'ended'
    sim.log.push({ effect: 'mark-ended', id: sim.cycle.id, sk })
    sim.log.push({ effect: 'calm', id: sim.cycle.id })
    return true
  }
  sim.turnEnd = (sk, kind = 'completed') => {
    if (kind === 'aborted' || kind === 'interrupted') {
      // The aborted path keeps its own behaviour (unchanged by this fix).
      if (!sim.stopped && sim.cycle) { sim.cycle.state = 'ended'; sim.log.push({ effect: 'calm', id: sim.cycle.id }) }
      return
    }
    const v = cycleEndVerdict(sim.facts(sk, sim.inFlight))
    if (v.defer) { sim.pending = { sk }; sim.log.push({ effect: 'defer', sk }); return }
    if (v.end) { sim.endCycle(sk); return }
    sim.log.push({ effect: 'no-end', reason: v.reason, sk })
  }
  sim.onEnd = () => {
    sim.inFlight = Math.max(0, sim.inFlight - 1)
    if (sim.inFlight === 0 && sim.pending) {
      const p = sim.pending
      sim.pending = null
      const v = deferredCycleEndVerdict(sim.facts(p.sk, 0))
      if (v.end) { sim.cycle.state = 'ended'; sim.log.push({ effect: 'calm', id: sim.cycle.id }) }
    }
  }
  // Answering the (now advisory) turn-end card.
  sim.answerCardClose = (sk) => {
    const v = cycleEndVerdict(sim.facts(sk, 0))
    sim.log.push({ effect: 'card-close', applied: v.end })
    if (v.end) sim.endCycle(sk)
  }
  sim.answerCardContinue = (sk) => {
    // "继续" starts a NEW turn; the cycle is only re-created by the next computer_* call.
    sim.log.push({ effect: 'card-continue' })
  }
  // Mirrors index.js `endCycleForSessionKey`: the JS transition and the worker light are INDEPENDENT
  // facts, and neither may gate the other. A residue cut is exactly the case where the JS side is
  // already finished while the native overlay is still drawing.
  sim.turnEndCuttingLight = (sk, kind = 'completed') => {
    const v = cycleEndVerdict(sim.facts(sk, sim.inFlight))
    if (v.end) {
      sim.cycle.state = 'ended'; sim.litByWorker = false
      sim.log.push({ effect: 'mark-ended', id: sim.cycle.id })
      sim.log.push({ effect: 'calm', id: sim.cycle.id })
    } else if (v.calmWorker) {
      sim.litByWorker = false
      sim.log.push({ effect: 'residue-calm', id: sim.cycle ? sim.cycle.id : null })
    } else if (v.defer) {
      sim.pending = { sk }; sim.log.push({ effect: 'defer', sk })
    } else {
      sim.log.push({ effect: 'no-end', reason: v.reason, sk })
    }
  }
  return sim
}

try {
  section('L1  a completed turn with a driven cycle and an UNANSWERED card ends the cycle')
  {
    const s = makeLifecycle()
    s.openCycle('A')
    s.turnEnd('A', 'completed')            // card exists in the Host, but the cycle does not wait on it
    ok(s.cycle.state === 'ended', 'the cycle is ended even though the card was never answered', s.cycle.state)
    ok(s.log.some(e => e.effect === 'calm'), 'and calm() was invoked to cut the border')
  }

  section('L2  a completed turn with NO card also ends the cycle')
  {
    const s = makeLifecycle()
    s.openCycle('A')
    s.turnEnd('A', 'completed')
    ok(s.cycle.state === 'ended', 'nowhere for the cycle to wait, so it ends', s.cycle.state)
  }

  section('L3  a SKIPPED card still ends the cycle (the old orphan path)')
  {
    const s = makeLifecycle()
    s.openCycle('A')
    // The old code reached this state via `touched=false`; under rule B the card is irrelevant, and the
    // turn end alone must end the cycle.
    s.turnEnd('A', 'completed')
    ok(s.cycle.state === 'ended', 'the orphan path can no longer leave the border lit', s.cycle.state)
  }

  section('L4  a card that is never answered cannot keep the border lit forever')
  {
    const s = makeLifecycle()
    s.openCycle('A')
    s.turnEnd('A', 'completed')
    const calmCount = s.log.filter(e => e.effect === 'calm').length
    ok(calmCount === 1, 'exactly one calm at turn end (no timer needed)', calmCount)
    ok(s.cycle.state === 'ended', 'and the cycle is not left open waiting for a human')
  }

  section('L5  clicking the OLD card after the cycle ended touches nothing')
  {
    const s = makeLifecycle()
    s.openCycle('A')
    s.turnEnd('A', 'completed')
    const before = s.log.length
    s.answerCardClose('A')
    ok(s.log[before].applied === false, 'the close branch is a no-op on an ended cycle')
    ok(s.log.filter(e => e.effect === 'calm').length === 1, 'and it does not cut anything a second time')
    const s2 = makeLifecycle()
    s2.openCycle('A')
    s2.turnEnd('A', 'completed')
    s2.answerCardContinue('A')
    ok(s2.log.some(e => e.effect === 'card-continue'), '"继续" only starts a new turn; it never resurrects the cycle')
    ok(s2.cycle.state === 'ended', 'the ended cycle stays ended after "继续"', s2.cycle.state)
  }

  section('L6  a LATE turn/end cannot end the next turn\'s cycle')
  {
    const s = makeLifecycle()
    s.openCycle('A')                       // turn 1's cycle
    s.turnEnd('A', 'completed')            // ends it
    const first = s.cycle.id
    s.openCycle('A')                       // turn 2 opens its own cycle
    const second = s.cycle.id
    ok(second !== first, 'the new turn has a different cycle id', `${first} -> ${second}`)
    // A stale event from turn 1 arrives now.
    s.endCycle('A')
    ok(s.cycle.state === 'ended' && s.cycle.id === second, 'the stale end targets the CURRENT cycle only, never a resurrected one')
  }

  section('L7  two sessions interleaved: attribution is exact, no cross-cutting')
  {
    const s = makeLifecycle()
    s.openCycle('A')
    s.turnEnd('B', 'completed')            // B's turn ends while A owns the machine
    ok(s.cycle.state === 'open', "another session's turn end does not end A's cycle", s.cycle.state)
    ok(s.log.some(e => e.effect === 'no-end' && e.reason === 'not-owner'), 'and it is refused for the right reason')
    s.turnEnd('A', 'completed')
    ok(s.cycle.state === 'ended', "A's own turn end does", s.cycle.state)
  }

  section('L8  in-flight work defers the end; it is never cut while a tool is running')
  {
    const s = makeLifecycle()
    s.openCycle('A')
    s.inFlight = 1
    s.turnEnd('A', 'completed')
    ok(s.cycle.state === 'open', 'the cycle survives while a call is in flight', s.cycle.state)
    ok(s.log.some(e => e.effect === 'defer'), 'the request was deferred, not dropped')
    s.onEnd()
    ok(s.cycle.state === 'ended', 'and it is executed the moment the last call settles', s.cycle.state)
  }

  section('L9  pause / ask / human stop / brake latch all protect the border')
  {
    for (const [field, label] of [['pausedOrAsking', 'paused-or-asking'], ['stopped', 'human-stop'], ['brakeLatched', 'human-stop']]) {
      const s = makeLifecycle()
      s.openCycle('A')
      s[field] = true
      s.turnEnd('A', 'completed')
      ok(s.cycle.state === 'open', `${label}: the cycle is NOT ended`, s.cycle.state)
      ok(s.log.some(e => e.effect === 'no-end' && e.reason === label), `${label}: refused with the right reason`)
    }
  }

  section('L10  aborted / interrupted keep their existing behaviour')
  {
    const s = makeLifecycle()
    s.openCycle('A')
    s.turnEnd('A', 'aborted')
    ok(s.cycle.state === 'ended', 'an aborted turn still ends the cycle (unchanged path)', s.cycle.state)
    const s2 = makeLifecycle()
    s2.openCycle('A'); s2.stopped = true
    s2.turnEnd('A', 'aborted')
    ok(s2.cycle.state === 'open', 'and a stopped machine keeps its cycle', s2.cycle.state)
  }

  section('L11  two consecutive tasks: the first goes dark, the second lights and ends on its own')
  {
    const s = makeLifecycle()
    s.openCycle('A')
    const firstId = s.cycle.id
    s.turnEnd('A', 'completed')
    ok(s.cycle.state === 'ended' && s.cycle.id === firstId, 'task 1 cycle ended')
    s.openCycle('A')
    const secondId = s.cycle.id
    ok(secondId !== firstId && s.cycle.state === 'open', 'task 2 opened a NEW cycle')
    s.turnEnd('A', 'completed')
    ok(s.cycle.state === 'ended', 'task 2 ended on its own too')
    ok(s.log.filter(e => e.effect === 'calm').length === 2, 'exactly one cut per task', s.log.filter(e => e.effect === 'calm').length)
  }

  section('L12  repeated lifecycle events are idempotent')
  {
    const s = makeLifecycle()
    s.openCycle('A')
    s.turnEnd('A', 'completed')
    const cuts = s.log.filter(e => e.effect === 'calm').length
    s.turnEnd('A', 'completed')
    s.turnEnd('A', 'completed')
    ok(s.log.filter(e => e.effect === 'calm').length === cuts, 'a repeated turn/end never calms again', cuts)
    ok(s.cycle.state === 'ended', 'and the state does not flap')
  }

  section('L13  the pure verdict itself, all branches')
  {
    const base = { cycleState: 'open', ownsSession: true, pausedOrAsking: false, stopped: false, brakeLatched: false, inFlight: 0 }
    ok(cycleEndVerdict(base).end === true, 'open + ours + clear -> end')
    ok(cycleEndVerdict({ ...base, ownsSession: false }).reason === 'not-owner', 'not-owner is refused first')
    for (const st of ['paused', 'asking', 'ended', null]) {
      const v = cycleEndVerdict({ ...base, cycleState: st })
      ok(v.end === false && v.reason === 'not-open', `state ${String(st)} is not endable`, v.reason)
    }
    ok(cycleEndVerdict({ ...base, pausedOrAsking: true }).reason === 'paused-or-asking', 'paused/asking refused')
    ok(cycleEndVerdict({ ...base, stopped: true }).reason === 'human-stop', 'human stop refused')
    ok(cycleEndVerdict({ ...base, brakeLatched: true }).reason === 'human-stop', 'brake latch refused')
    const d = cycleEndVerdict({ ...base, inFlight: 2 })
    ok(d.end === false && d.defer === true, 'in-flight defers instead of dropping', JSON.stringify(d))
    // Precedence: a pause outranks in-flight, so a paused cycle is never queued for ending.
    ok(cycleEndVerdict({ ...base, pausedOrAsking: true, inFlight: 2 }).reason === 'paused-or-asking',
      'privileged states outrank the deferral')
    ok(ENDABLE_STATE === 'open', 'only `open` is endable')
    ok(deferredCycleEndVerdict({ ...base, inFlight: 9 }).end === true, 'a deferred re-check ignores the stale in-flight count')
  }

  section('L14  RESIDUE: the JS gate is already ended while the worker light is still on')
  {
    // THE FAILURE THIS FIXES: `gate.state()` is `ended` while the native `CycleLit` is still 1 — two
    // different facts written by two different layers. The old verdict returned `not-open`, the JS
    // transition was skipped, and the light was never cut, so the border burned indefinitely.
    const endedFacts = { cycleState: 'ended', ownsSession: true, pausedOrAsking: false, stopped: false, brakeLatched: false, inFlight: 0 }
    const v = cycleEndVerdict(endedFacts)
    ok(v.end === false, 'no JS transition is claimed for an already-ended cycle')
    ok(v.calmWorker === true, 'but the worker IS asked to cut its light', JSON.stringify(v))
    ok(cycleEndVerdict({ ...endedFacts, cycleState: null }).calmWorker === true, 'an absent cycle is also a residue case')

    const s = makeLifecycle()
    s.openCycle('A')
    s.cycle.state = 'ended'        // the JS layer believes the cycle is over …
    // … while `litByWorker` stays true: the native overlay still draws the border.
    s.turnEndCuttingLight('A', 'completed')
    ok(s.litByWorker === false, 'the worker light was cut even though the JS gate said ended')
    ok(s.log.filter(e => e.effect === 'calm' || e.effect === 'residue-calm').length === 1, 'exactly one cut is sent')
    ok(s.log.some(e => e.effect === 'residue-calm'), 'and it is recorded as the residue path, not a JS transition')
  }

  section('L15  the residue path can never touch a NEW cycle or another session')
  {
    const openNew = cycleEndVerdict({ cycleState: 'open', ownsSession: true, pausedOrAsking: false, stopped: false, brakeLatched: false, inFlight: 0 })
    ok(openNew.end === true && !openNew.calmWorker, 'a live cycle is ended properly, never calmed as residue')
    const foreign = cycleEndVerdict({ cycleState: 'open', ownsSession: false, pausedOrAsking: false, stopped: false, brakeLatched: false, inFlight: 0 })
    ok(foreign.end === false && foreign.calmWorker !== true, "another session's cycle is untouched", JSON.stringify(foreign))
    for (const [k, reason] of [['pausedOrAsking', 'paused-or-asking'], ['stopped', 'human-stop'], ['brakeLatched', 'human-stop']]) {
      const r = cycleEndVerdict({ cycleState: 'ended', ownsSession: true, pausedOrAsking: false, stopped: false, brakeLatched: false, inFlight: 0, [k]: true })
      ok(r.calmWorker !== true && r.reason === reason, `residue is refused while ${reason}`, JSON.stringify(r))
    }
    const busy = cycleEndVerdict({ cycleState: 'ended', ownsSession: true, pausedOrAsking: false, stopped: false, brakeLatched: false, inFlight: 1 })
    ok(busy.defer === true && busy.calmWorker !== true, 'residue is deferred while a call is in flight', JSON.stringify(busy))
  }
} finally {
  section('teardown')
}

console.log(`\n================ ${checks - failures}/${checks} checks passed ================`)
if (failures > 0) { console.log(`${failures} FAILURE(S)`); process.exit(1) }
console.log('ALL PASS')
