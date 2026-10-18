// D4 correlation test (2026-10-16).
//
// THE GAP THIS PINS: the native audit trail names a tool call by its HOST call id, and the action
// registry names the same call by its own action id. Neither id can be computed from the other, and a
// probe on the real instance proved WHY: when the approval hook runs, the registry is still empty
// (`registrySize: 0`), because the record is minted later, inside the tool body. So the two are LINKED.
//
// WHAT IS ASSERTED HERE:
//   * a record carries the Host call id it belongs to;
//   * the link is consumed once, so N calls of one tool do not all join to the first call;
//   * ids stay unique across calls;
//   * a call with no approval still produces a record (hostCallId null), which is honest rather than
//     fabricated;
//   * the correlation line the two wrappers emit really carries both ids.
//
// This is an OFFLINE unit/integration test of the registry contract. It is NOT evidence that the real
// DSH instance joins correctly — that requires a live run and is reported separately.

import { ActionRegistry, noteHostCallId, consumeHostCallId } from 'file:///C:/Users/liu/Documents/deepseek-harness/default-workspace/cu-release/lib/action-registry.js'
import { runBrowserAction } from 'file:///C:/Users/liu/Documents/deepseek-harness/default-workspace/cu-release/lib/browser-tools.js'

let failures = 0
let checks = 0
const ok = (cond, label, detail) => {
  checks++
  if (cond) console.log(`  PASS  ${label}`)
  else { failures++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`) }
}
const section = (t) => console.log(`\n--- ${t} ---`)

// ---------------------------------------------------------------------------------------------
section('D4-1  a record carries the Host call id it belongs to')
{
  const reg = new ActionRegistry({ log: () => {} })
  noteHostCallId('browser_click', 'call_00_AAA')
  const rec = reg.create('browser_click', {})
  ok(rec.hostCallId === 'call_00_AAA', 'the record carries the call id', rec.hostCallId)
  ok(typeof rec.id === 'string' && rec.id.startsWith('browser_click#a'), 'and keeps its own action id', rec.id)
  ok(rec.id !== rec.hostCallId, 'the two ids are DIFFERENT strings (linked, not unified)')
}

section('D4-2  the link is consumed exactly once (no wrong joins)')
{
  const reg = new ActionRegistry({ log: () => {} })
  noteHostCallId('browser_click', 'call_00_ONE')
  const a = reg.create('browser_click', {})
  const b = reg.create('browser_click', {})
  ok(a.hostCallId === 'call_00_ONE', 'the first record takes the call id', a.hostCallId)
  ok(b.hostCallId === null, 'the second record does NOT inherit it', String(b.hostCallId))
  ok(a.id !== b.id, 'and their action ids differ', `${a.id} / ${b.id}`)
}

section('D4-3  per-tool queues keep different tools apart')
{
  const reg = new ActionRegistry({ log: () => {} })
  noteHostCallId('browser_click', 'call_click')
  noteHostCallId('browser_navigate', 'call_nav')
  const nav = reg.create('browser_navigate', {})
  const clk = reg.create('browser_click', {})
  ok(nav.hostCallId === 'call_nav', 'navigate got the navigate call id', nav.hostCallId)
  ok(clk.hostCallId === 'call_click', 'click got the click call id', clk.hostCallId)
  ok(nav.hostCallId !== clk.hostCallId, 'the two calls do not collide')
}

section('D4-4  queueing order is preserved (FIFO), so two calls of one tool stay distinct')
{
  const reg = new ActionRegistry({ log: () => {} })
  noteHostCallId('browser_click', 'call_first')
  noteHostCallId('browser_click', 'call_second')
  const one = reg.create('browser_click', {})
  const two = reg.create('browser_click', {})
  ok(one.hostCallId === 'call_first', 'first record ↔ first call id', one.hostCallId)
  ok(two.hostCallId === 'call_second', 'second record ↔ second call id', two.hostCallId)
  ok(one.id !== two.id && one.hostCallId !== two.hostCallId, 'both pairs are unique')
}

section('D4-5  a call that never asked for approval is honest about it')
{
  const reg = new ActionRegistry({ log: () => {} })
  const rec = reg.create('browser_observe', {})
  ok(rec.hostCallId === null, 'hostCallId is null rather than fabricated', String(rec.hostCallId))
  ok(typeof rec.id === 'string' && rec.id.length > 0, 'but the action id still exists')
}

section('D4-6  consumeHostCallId is not reachable twice for one id')
{
  noteHostCallId('browser_press', 'call_once')
  ok(consumeHostCallId('browser_press') === 'call_once', 'first consume returns it')
  ok(consumeHostCallId('browser_press') === null, 'second consume returns null')
}

section('D4-7  the queue is bounded (an unanswered approval cannot poison later calls)')
{
  for (let i = 0; i < 20; i++) noteHostCallId('browser_type', `call_${i}`)
  const reg = new ActionRegistry({ log: () => {} })
  const rec = reg.create('browser_type', {})
  ok(rec.hostCallId === 'call_12', 'an overflowing queue keeps the NEWEST ids, not the oldest', rec.hostCallId)
}

section('D4-8  the correlation line carries BOTH ids, as the wrappers emit it')
{
  const reg = new ActionRegistry({ log: () => {} })
  const lines = []
  const logObj = { info: (m) => lines.push(String(m)), warn: () => {} }
  noteHostCallId('browser_navigate', 'call_00_LINE')
  const res = await runBrowserAction({
    registry: reg, tool: 'browser_navigate', args: { url: 'x' }, log: logObj,
    run: async () => ({ ok: true, outcome: 'applied', verified: true, dispatched: true }),
  })
  const line = lines.find(l => l.includes('browser-use: action')) || ''
  ok(line.includes(res.actionId), 'the line contains the registry action id', line)
  ok(line.includes('call_00_LINE'), 'and the Host call id', line)
  ok(res.registry.hostCallId === 'call_00_LINE', 'and the tool result exposes hostCallId for joining', String(res.registry && res.registry.hostCallId))
}

section('D4-9  the logger shape cannot break an action (regression guard)')
{
  // THE REGRESSION THIS PINS: the D4 line was first written as an unconditional `log.info(...)`, which
  // threw `TypeError: log.info is not a function` because this function's own default logger is a plain
  // FUNCTION. Both browser suites went red. A logger must never be able to take an action down.
  const reg = new ActionRegistry({ log: () => {} })
  let threw = null
  let res = null
  try {
    res = await runBrowserAction({
      registry: reg, tool: 'browser_navigate', args: {}, log: () => {},
      run: async () => ({ ok: true, outcome: 'applied', verified: true, dispatched: true }),
    })
  } catch (e) { threw = e }
  ok(threw === null, 'a FUNCTION logger does not break the action', threw && threw.message)
  ok(res && res.ok === true, 'and the action still completes', JSON.stringify(res && { ok: res.ok, outcome: res.outcome }))

  const reg2 = new ActionRegistry({ log: () => {} })
  let threw2 = null
  try {
    await runBrowserAction({
      registry: reg2, tool: 'browser_navigate', args: {}, log: { info: () => {}, warn: () => {} },
      run: async () => ({ ok: true, outcome: 'applied', verified: true, dispatched: true }),
    })
  } catch (e) { threw2 = e }
  ok(threw2 === null, 'an OBJECT logger also works', threw2 && threw2.message)
}

section('D4-10  correlation does not disturb the lifecycle guarantees')
{
  const reg = new ActionRegistry({ log: () => {} })
  noteHostCallId('browser_click', 'call_00_LIFECYCLE')
  const res = await runBrowserAction({
    registry: reg, tool: 'browser_click', args: {}, log: () => {},
    run: async () => ({ ok: true, outcome: 'applied', verified: true, dispatched: true }),
  })
  ok(res.registry.state === 'VERIFIED', 'the record still reaches VERIFIED', res.registry.state)
  ok(res.registry.dispatches === 1, 'with exactly one dispatch', res.registry.dispatches)
  ok(reg.beginDispatch(res.actionId).ok === false, 'and a second dispatch is still refused')
  ok(res.registry.hostCallId === 'call_00_LIFECYCLE', 'while the call id is still attached', String(res.registry.hostCallId))
}

section('D4-11  a refusal that never sent anything is CANCELLED, not FAILED (defect D5)')
{
  // THE BUG THIS PINS (measured on the real instance, 2026-10-16): the mapping read
  // `terminalForOutcome(outcome === 'not-dispatched' ? null : outcome) || 'CANCELLED'`. Passing `null`
  // hits that function's `default`, which returns the TRUTHY string 'FAILED', so `||` short-circuited and
  // the CANCELLED branch was dead code. A refusal that sent NOTHING was recorded as a FAILURE — which
  // reads, in any later audit, as "the action was attempted and went wrong".
  const reg = new ActionRegistry({ log: () => {} })
  const res = await runBrowserAction({
    registry: reg, tool: 'browser_click', args: {}, log: () => {},
    // Claimed the slot (so it is past `beginDispatch`) but reports that it sent nothing.
    run: async () => ({ ok: false, outcome: 'not-dispatched', dispatched: false, reason: 'the target is gone' }),
  })
  ok(res.registry.state === 'CANCELLED', 'the terminal state is CANCELLED', res.registry.state)
  ok(res.registry.state !== 'FAILED', 'and NOT FAILED')
  ok(res.registry.state !== 'EXECUTING', 'and not left dangling in EXECUTING')
  ok(res.dispatched === false, 'the result still reports that nothing was sent')
  ok(res.registry.dispatches === 1, 'while the slot it claimed stays consumed', res.registry.dispatches)
}

section('D4-12  the precheck path (no slot claimed) is unaffected by D5')
{
  const reg = new ActionRegistry({ log: () => {} })
  const res = await runBrowserAction({
    registry: reg, tool: 'browser_navigate', args: {}, log: () => {},
    precheck: async () => ({ ok: true, alreadyThere: true, dispatched: false, reason: 'nothing to do' }),
    run: async () => { throw new Error('run() must not be reached when precheck short-circuits') },
  })
  ok(res.alreadyThere === true, 'the precheck result is returned')
  ok(res.registry.dispatches === 0, 'and no dispatch slot was consumed', res.registry.dispatches)
  ok(res.registry.state === 'CREATED', 'the record is still CREATED (never entered EXECUTING)', res.registry.state)
}

console.log(`\n================ ${checks - failures}/${checks} checks passed ================`)
if (failures > 0) { console.log(`${failures} FAILURE(S)`); process.exit(1) }
console.log('ALL PASS')
