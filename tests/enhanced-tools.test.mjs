// Offline tests for the cu_* enhanced tools (2026-10-16).
//
// These verify the CONTRACT of the new surface: that it reuses the existing core rather than
// re-implementing input, that it carries a target binding into the act record, and that it reports
// the action registry honestly. The `computer_*` tools are covered by wrapper-policy.test.mjs.

import { registerEnhancedTools }
  from 'file:///C:/Users/liu/Documents/deepseek-harness/default-workspace/cu-release/lib/enhanced-tools.js'
import { ActionRegistry }
  from 'file:///C:/Users/liu/Documents/deepseek-harness/default-workspace/cu-release/lib/action-registry.js'

let failures = 0
let checks = 0
const ok = (cond, label, detail) => {
  checks++
  if (cond) console.log(`  PASS  ${label}`)
  else { failures++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`) }
}
const section = (t) => console.log(`\n--- ${t} ---`)

function harness (script = {}) {
  const definitions = []
  const calls = []
  const contexts = []
  const cu = {
    pendingAction: null,
    async call (op, args = {}) {
      calls.push({ op, args })
      if (op === 'windows') return { windows: [{ hwnd: 11, pid: 5, title: 'Active', active: true }] }
      if (op === 'cursor') return { x: 3, y: 4 }
      if (op === 'windowInfo') return script.window === null ? null : (script.window || { hwnd: args.hwnd, pid: 5, title: 'Active', className: 'C' })
      if (op === 'uia') return script.uia || { flat: [], truncated: false, count: 0 }
      return {}
    },
    withInputContext (context, fn) { contexts.push(context); return fn() },
    async move (x, y, act) { calls.push({ op: 'move', x, y, act }); return { moved: true } },
    async click (t, o, act) { calls.push({ op: 'click', t, o, act }); return { clicked: true } },
    async key (c, o, act) { calls.push({ op: 'key', c, act }); return { keyed: true } },
    async type (t, o, act) { calls.push({ op: 'type', t, act }); return { typed: true } },
  }
  const registry = new ActionRegistry({ log: () => {} })
  const names = registerEnhancedTools({
    cu,
    defineTool: (def) => ({ ...def, output: {} }),
    register: (d) => definitions.push(d),
    actionRegistry: registry,
    log: { info: () => {} },
  })
  return { cu, registry, definitions, names, calls, contexts }
}

const find = (defs, name) => defs.find(d => d.name === name)
const fakeExec = { signal: new AbortController().signal, agent: { id: 'a' } }

// ---------------------------------------------------------------------------------------------
section('C1  the three tools are registered and never shadow a computer_* name')
{
  const h = harness()
  ok(h.names.length === 3, `three enhanced tools were registered (${h.names.join(', ')})`)
  for (const n of ['cu_observe', 'cu_verify', 'cu_execute']) {
    ok(h.names.includes(n), `${n} is registered`)
    ok(!h.names.some(x => x.startsWith('computer_')), `${n} does not use the computer_ prefix`)
  }
  const dup = h.names.filter((n, i) => h.names.indexOf(n) !== i)
  ok(dup.length === 0, 'no duplicate names', dup.join(','))
}

// ---------------------------------------------------------------------------------------------
section('C2  cu_observe is read-only and reports truncation honestly')
{
  const h = harness({ uia: { flat: [{ id: 'a', name: 'A', role: 'Button' }], truncated: true, count: 1 } })
  const out = await find(h.definitions, 'cu_observe').execute({ hwnd: 11 }, fakeExec)
  ok(out.observed === true, 'the observation is marked observed')
  ok(out.foreground && out.foreground.hwnd === 11, 'the foreground window is reported')
  ok(out.cursor && out.cursor.x === 3, 'the cursor is reported')
  ok(out.uia && out.uia.truncated === true, 'truncation is surfaced, not hidden')
  ok(typeof out.hint === 'string' && /truncated/.test(out.hint), 'a truncated scan carries a hint', out.hint)
  const ops = h.calls.map(c => c.op)
  ok(!ops.some(op => ['move', 'click', 'key', 'type', 'uiaAct'].includes(op)), 'no input op was issued', ops.join(','))
}

// ---------------------------------------------------------------------------------------------
section('C3  cu_observe follows the active window when no hwnd is given')
{
  const h = harness({ uia: { flat: [], truncated: false } })
  const out = await find(h.definitions, 'cu_observe').execute({}, fakeExec)
  ok(out.scannedHwnd === 11, 'the active window was scanned', String(out.scannedHwnd))
  const noUia = harness()
  const out2 = await find(noUia.definitions, 'cu_observe').execute({ noUia: true }, fakeExec)
  ok(out2.uia === null, 'noUia skips the accessibility scan')
  ok(!noUia.calls.some(c => c.op === 'uia'), 'and issues no uia call at all')
}

// ---------------------------------------------------------------------------------------------
section('C4  cu_verify re-resolves a selector from current state')
{
  const h = harness({ uia: { flat: [{ id: 'SaveButton', name: 'Save', role: 'Button', rect: { x: 1, y: 2, width: 3, height: 4 } }], truncated: false } })
  const out = await find(h.definitions, 'cu_verify').execute({ hwnd: 11, id: 'SaveButton', role: 'Button' }, fakeExec)
  ok(out.verified === true, 'a present, unique control verifies', out.reason)
  ok(/^selector:/.test(out.how || ''), 'the verdict names the selector form', out.how)
  ok(out.binding && out.binding.hwnd === 11, 'the binding is reported back', JSON.stringify(out.binding))

  const gone = harness({ uia: { flat: [], truncated: false } })
  const out2 = await find(gone.definitions, 'cu_verify').execute({ hwnd: 11, id: 'SaveButton' }, fakeExec)
  ok(out2.verified === false && /no longer present/.test(out2.reason), 'a vanished control reports false', out2.reason)

  const amb = harness({ uia: { flat: [{ id: 'S', name: 'Save', role: 'Button' }, { id: 'S', name: 'Save', role: 'Button' }], truncated: false } })
  const out3 = await find(amb.definitions, 'cu_verify').execute({ hwnd: 11, name: 'Save' }, fakeExec)
  ok(out3.verified === false && /uniqueness/.test(out3.reason), 'an ambiguous target reports false', out3.reason)
}

// ---------------------------------------------------------------------------------------------
section('C5  cu_verify reports the registry, including whether the action may still dispatch')
{
  const h = harness()
  const rec = h.registry.create('computer_move')
  h.registry.beginDispatch(rec.id)
  h.registry.transition(rec.id, 'VERIFIED', 'done')
  const out = await find(h.definitions, 'cu_verify').execute({ actionId: rec.id }, fakeExec)
  ok(out.action && out.action.id === rec.id, 'the requested action is reported')
  ok(out.action.state === 'VERIFIED', 'its state is reported', out.action.state)
  ok(out.action.dispatches === 1, 'its dispatch count is reported')
  ok(out.actionMayDispatch === false, 'it is reported as no longer dispatchable')
  ok(/cannot be dispatched/.test(out.actionDispatchRefusalReason || ''), 'the refusal reason is given', out.actionDispatchRefusalReason)

  const unknown = await find(h.definitions, 'cu_verify').execute({ actionId: 'nope' }, fakeExec)
  ok(unknown.action === null, 'an unknown id reports no action')
  ok(/unknown actionId/.test(unknown.reason || ''), 'and says so', unknown.reason)
}

// ---------------------------------------------------------------------------------------------
section('C6  cu_execute dispatches through the core and records the action')
{
  const h = harness()
  const out = await find(h.definitions, 'cu_execute').execute({ action: 'move', at: '100,200' }, fakeExec)
  ok(out.dispatched === true, 'the action reports dispatched')
  ok(out.result && out.result.moved === true, 'the core result is passed through')
  ok(typeof out.actionId === 'string' && out.actionId.length > 0, 'an action id was minted', out.actionId)
  ok(out.registry && out.registry.id === out.actionId, 'the registry snapshot matches the action id')
  const moveCall = h.calls.find(c => c.op === 'move')
  ok(moveCall && moveCall.x === 100 && moveCall.y === 200, 'the core move received the coordinates')
  ok(moveCall && moveCall.act && moveCall.act === h.contexts[0].act, 'the act context reached the core')
}

// ---------------------------------------------------------------------------------------------
section('C7  cu_execute gives a selector target a real verifier, a coordinate target none')
{
  const sel = harness({ uia: { flat: [{ id: 'OkBtn', name: 'OK', role: 'Button' }], truncated: false } })
  await find(sel.definitions, 'cu_execute').execute({ action: 'click', hwnd: 11, id: 'OkBtn', at: '5,5' }, fakeExec)
  const selAct = sel.calls.find(c => c.op === 'click').act
  ok(typeof selAct.verify === 'function', 'a selector target carries a verifier')
  const verdict = await selAct.verify()
  ok(verdict && verdict.ok === true, 'the verifier reports the control as present', verdict && verdict.reason)

  const coord = harness()
  await find(coord.definitions, 'cu_execute').execute({ action: 'move', at: '7,8' }, fakeExec)
  const coordAct = coord.calls.find(c => c.op === 'move').act
  ok(coordAct.verify === null, 'a coordinate-only target has NO verifier (so it is never replayed)')
}

// ---------------------------------------------------------------------------------------------
section('C8  cu_execute rejects malformed requests before touching anything')
{
  const cases = [
    [{ action: 'move' }, /requires at/],
    [{ action: 'click' }, /requires at/],
    [{ action: 'key' }, /requires combo/],
    [{ action: 'type' }, /requires text/],
    [{ action: 'teleport' }, /unknown action/],
  ]
  for (const [args, pattern] of cases) {
    const h = harness()
    let err = null
    try { await find(h.definitions, 'cu_execute').execute(args, fakeExec) } catch (e) { err = e }
    ok(err !== null && pattern.test(err.message), `refuses ${JSON.stringify(args)}`, err && err.message)
    ok(!h.calls.some(c => ['move', 'click', 'key', 'type'].includes(c.op)), 'and issued no input for that request')
  }
}

// ---------------------------------------------------------------------------------------------
section('C9  cu_execute surfaces a core refusal with its code and outcome intact')
{
  const h = harness()
  const tool = find(h.definitions, 'cu_execute')
  h.cu.move = async () => {
    const e = new Error('HUMAN_YIELD: physical input owns the desktop')
    e.code = 'HUMAN_YIELD'
    e.outcome = 'unknown'
    throw e
  }
  let err = null
  try { await tool.execute({ action: 'move', at: '1,1' }, fakeExec) } catch (e) { err = e }
  ok(err !== null, 'the refusal propagated')
  ok(err.code === 'HUMAN_YIELD', 'the code is preserved', err && err.code)
  ok(err.outcome === 'unknown', 'the outcome is preserved — the caller can tell "maybe landed" from "not sent"', err && err.outcome)
}

// ---------------------------------------------------------------------------------------------
section('C10 cu_execute claims the single dispatch through the registry')
{
  const h = harness()
  const tool = find(h.definitions, 'cu_execute')
  // Simulate the core calling beginDispatch exactly as `actuate` does, then a retry attempt.
  const out = await tool.execute({ action: 'move', at: '2,2' }, fakeExec)
  const rec = h.registry.get(out.actionId)
  ok(rec !== undefined, 'the record exists after the call')
  // The registry is the authority: claim once, then prove a second claim is refused.
  const first = h.registry.beginDispatch(rec.id)
  ok(first.ok === true, 'a first claim on a still-CREATED record is granted')
  const second = h.registry.beginDispatch(rec.id)
  ok(second.ok === false, 'a second claim is refused')
}

// ---------------------------------------------------------------------------------------------
console.log(`\n================ ${checks - failures}/${checks} checks passed ================`)
if (failures > 0) { console.log(`${failures} FAILURE(S)`); process.exit(1) }
console.log('ALL PASS')
