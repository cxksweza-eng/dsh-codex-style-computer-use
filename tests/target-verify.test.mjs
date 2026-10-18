// Offline tests for the UIA selector re-validation module (2026-10-16).
//
// These drive `captureBinding` / `resolveAndVerify` against a scripted worker stub, so every refusal
// rule can be exercised deterministically 鈥?including the ones that are hard to stage on a real
// desktop (a window that is re-used by a different process, a control that becomes ambiguous).

import { captureBinding, resolveAndVerify, hasSelector }
  from '../lib/target-verify.js'

let failures = 0
let checks = 0
const ok = (cond, label, detail) => {
  checks++
  if (cond) console.log(`  PASS  ${label}`)
  else { failures++; console.log(`  FAIL  ${label}${detail ? ' 鈥?' + detail : ''}`) }
}
const section = (t) => console.log(`\n--- ${t} ---`)

/** Scripted worker, shaped like the REAL one: window op is windows (an inventory), and the accessibility op answers elements. */
function makeCu (script = {}) {
  const calls = []
  return {
    calls,
    async call (op, args = {}) {
      calls.push({ op, args })
      if (op === 'windows') {
        if (script.windowThrows) throw new Error('window inventory unavailable')
        const w = 'window' in script ? script.window : { hwnd: args.hwnd ?? 4242, pid: 100, title: 'Notepad', class: 'Notepad' }
        return { windows: w ? [w] : [] }
      }
      if (op === 'uia') {
        if (script.uiaThrows) throw new Error('uia provider is wedged')
        return 'uia' in script ? script.uia : { elements: [], truncated: false, count: 0 }
      }
      throw new Error(`unexpected op ${op}`)
    },
  }
}

const SAVE_ARGS = { hwnd: 4242, id: 'SaveButton', role: 'Button' }
const GOOD_WINDOW = { hwnd: 4242, pid: 100, title: 'Notepad', class: 'Notepad' }
const ONE_SAVE = { elements: [{ automationId: 'SaveButton', name: 'Save', role: 'Button', rect: { x: 10, y: 20, width: 30, height: 30 } }], truncated: false, count: 1 }

// ---------------------------------------------------------------------------------------------
section('V1  hasSelector recognises identity shapes only')
{
  ok(hasSelector({ id: 'x' }) === true, 'AutomationId counts as a selector')
  ok(hasSelector({ name: 'Save' }) === true, 'name counts as a selector')
  ok(hasSelector({ role: 'Button' }) === true, 'role counts as a selector')
  ok(hasSelector({ at: '10,10' }) === false, 'a bare coordinate is NOT a selector')
  ok(hasSelector({ mark: 'M3' }) === false, 'a mark is not a selector (it has its own verifier)')
  ok(hasSelector({}) === false, 'no arguments is not a selector')
}

// ---------------------------------------------------------------------------------------------
section('V2  captureBinding records identity, never coordinates')
{
  const cu = makeCu({ window: GOOD_WINDOW })
  const b = await captureBinding(cu, SAVE_ARGS, 'computer_uia_act')
  ok(b !== null, 'a binding was produced')
  ok(b.selector && b.selector.by === 'automationId' && b.selector.id === 'SaveButton', 'the AutomationId is recorded', JSON.stringify(b.selector))
  ok(b.witness && b.witness.hwnd === 4242 && b.witness.pid === 100 && b.witness.title === 'Notepad', 'the window witness is recorded', JSON.stringify(b.witness))
  ok(JSON.stringify(b).includes('"x"') === false, 'no screen coordinates leaked into the binding')
  const none = await captureBinding(cu, { at: '5,5' }, 'computer_click')
  ok(none === null, 'a coordinate-only target yields no binding')
}

// ---------------------------------------------------------------------------------------------
section('V3  the happy path: same window, exactly one match')
{
  const cu = makeCu({ window: GOOD_WINDOW, uia: ONE_SAVE })
  const b = await captureBinding(cu, SAVE_ARGS, 'computer_uia_act')
  const v = await resolveAndVerify(cu, b)
  ok(v.ok === true, 're-validation succeeds', v.reason)
  ok(typeof v.how === 'string' && v.how.startsWith('selector:'), 'the verdict names the selector form', v.how)
  const uiaCall = cu.calls.find(c => c.op === 'uia')
  ok(uiaCall && uiaCall.args.hwnd === 4242, 'the query was scoped to the witnessed window')
  ok(uiaCall && uiaCall.args.depth === 24, 'the query used the deepest supported scan')
}

// ---------------------------------------------------------------------------------------------
section('V4  a control that MOVED is still the same control (geometry is advisory)')
{
  const moved = { elements: [{ id: 'SaveButton', name: 'Save', role: 'Button', rect: { x: 900, y: 700, width: 30, height: 30 } }], truncated: false }
  const cu = makeCu({ window: GOOD_WINDOW, uia: moved })
  const b = await captureBinding(cu, SAVE_ARGS, 'computer_uia_act')
  const v = await resolveAndVerify(cu, b)
  ok(v.ok === true, 'a relocated control still validates (identity, not position)', v.reason)
}

// ---------------------------------------------------------------------------------------------
section('V5  no binding / no witness -> refuse (never replay an unidentifiable target)')
{
  const cu = makeCu({ window: GOOD_WINDOW, uia: ONE_SAVE })
  ok((await resolveAndVerify(cu, null)).ok === false, 'a null binding refuses')
  ok((await resolveAndVerify(cu, { selector: null })).ok === false, 'a binding without a selector refuses')
  const noWitness = { selector: { by: 'automationId', id: 'SaveButton', role: null, nameContains: null }, witness: null }
  const v = await resolveAndVerify(cu, noWitness)
  ok(v.ok === false, 'a selector with no window witness refuses')
  ok(/witness/i.test(v.reason || ''), 'the reason names the missing witness', v.reason)
}

// ---------------------------------------------------------------------------------------------
section('V6  window-level changes all refuse')
{
  const b = await captureBinding(makeCu({ window: GOOD_WINDOW }), SAVE_ARGS, 'computer_uia_act')

  const gone = makeCu({ window: null, uia: ONE_SAVE })
  ok((await resolveAndVerify(gone, b)).ok === false, 'a window that no longer exists refuses')

  const minimized = makeCu({ window: { ...GOOD_WINDOW, minimized: true }, uia: ONE_SAVE })
  const vm = await resolveAndVerify(minimized, b)
  ok(vm.ok === false && /minimi/i.test(vm.reason), 'a minimized window refuses', vm.reason)

  const reuse = makeCu({ window: { ...GOOD_WINDOW, pid: 999 }, uia: ONE_SAVE })
  const vr = await resolveAndVerify(reuse, b)
  ok(vr.ok === false && /process/i.test(vr.reason), 'a handle reused by another process refuses', vr.reason)

  const retitled = makeCu({ window: { ...GOOD_WINDOW, title: 'Untitled - Notepad' }, uia: ONE_SAVE })
  const vt = await resolveAndVerify(retitled, b)
  ok(vt.ok === false && /title/i.test(vt.reason), 'a changed window title refuses', vt.reason)

  const thrown = makeCu({ windowThrows: true, uia: ONE_SAVE })
  ok((await resolveAndVerify(thrown, b)).ok === false, 'window lookup failure refuses (fail closed)')
}

// ---------------------------------------------------------------------------------------------
section('V7  control-level changes refuse, and never guess')
{
  const b = await captureBinding(makeCu({ window: GOOD_WINDOW }), SAVE_ARGS, 'computer_uia_act')

  const empty = makeCu({ window: GOOD_WINDOW, uia: { elements: [], truncated: false } })
  const v0 = await resolveAndVerify(empty, b)
  ok(v0.ok === false && /no longer present/i.test(v0.reason), 'a vanished control refuses', v0.reason)

  const two = makeCu({ window: GOOD_WINDOW, uia: { elements: [ONE_SAVE.elements[0], { ...ONE_SAVE.elements[0], rect: { x: 0, y: 0, width: 1, height: 1 } }], truncated: false } })
  const v2 = await resolveAndVerify(two, b)
  ok(v2.ok === false && /uniqueness/.test(v2.reason), 'an ambiguous match refuses rather than picking one', v2.reason)

  const trunc = makeCu({ window: GOOD_WINDOW, uia: { elements: [ONE_SAVE.elements[0]], truncated: true } })
  const vt = await resolveAndVerify(trunc, b)
  ok(vt.ok === false && /truncated/.test(vt.reason), 'a truncated search refuses (uniqueness unprovable)', vt.reason)

  const wrongId = makeCu({ window: GOOD_WINDOW, uia: { elements: [{ automationId: 'CancelButton', name: 'Save', role: 'Button' }], truncated: false } })
  ok((await resolveAndVerify(wrongId, b)).ok === false, 'a different AutomationId does not satisfy the binding')

  const wrongRole = makeCu({ window: GOOD_WINDOW, uia: { elements: [{ automationId: 'SaveButton', name: 'Save', role: 'MenuItem' }], truncated: false } })
  ok((await resolveAndVerify(wrongRole, b)).ok === false, 'a different control type does not satisfy the binding')

  const wedged = makeCu({ window: GOOD_WINDOW, uiaThrows: true })
  ok((await resolveAndVerify(wedged, b)).ok === false, 'a failing accessibility provider refuses (fail closed)')
}

// ---------------------------------------------------------------------------------------------
section('V8  name-substring bindings behave like the native query')
{
  const args = { hwnd: 4242, name: 'Sav', role: 'Button' }
  const cu = makeCu({ window: GOOD_WINDOW, uia: ONE_SAVE })
  const b = await captureBinding(cu, args, 'computer_uia_act')
  ok(b.selector.by === 'nameSubstring' && b.selector.nameContains === 'Sav', 'the substring form is recorded', JSON.stringify(b.selector))
  ok((await resolveAndVerify(cu, b)).ok === true, 'a substring match validates')
  const other = makeCu({ window: GOOD_WINDOW, uia: { elements: [{ automationId: 'x', name: 'Cancel', role: 'Button' }], truncated: false } })
  ok((await resolveAndVerify(other, b)).ok === false, 'a non-matching name refuses')
}

// ---------------------------------------------------------------------------------------------
section('V9  role-only bindings require role agreement')
{
  const args = { hwnd: 4242, role: 'Button' }
  const b = await captureBinding(makeCu({ window: GOOD_WINDOW }), args, 'computer_uia_act')
  ok(b.selector.by === 'role', 'the role form is recorded', JSON.stringify(b.selector))
  const hit = makeCu({ window: GOOD_WINDOW, uia: { elements: [{ automationId: 'a', name: 'OK', role: 'Button' }], truncated: false } })
  ok((await resolveAndVerify(hit, b)).ok === true, 'a single role match validates')
  const miss = makeCu({ window: GOOD_WINDOW, uia: { elements: [{ automationId: 'a', name: 'OK', role: 'Edit' }], truncated: false } })
  ok((await resolveAndVerify(miss, b)).ok === false, 'a role mismatch refuses')
}

// ---------------------------------------------------------------------------------------------
section('V10 the verifier never issues input')
{
  const cu = makeCu({ window: GOOD_WINDOW, uia: ONE_SAVE })
  const b = await captureBinding(cu, SAVE_ARGS, 'computer_uia_act')
  cu.calls.length = 0
  await resolveAndVerify(cu, b)
  const ops = cu.calls.map(c => c.op)
  ok(ops.every(op => op === 'windows' || op === 'uia'), 'only read-only ops were issued', ops.join(','))
  ok(ops.includes('windows') && ops.includes('uia'), 'both the window and the control were re-read')
}

// ---------------------------------------------------------------------------------------------
console.log(`\n================ ${checks - failures}/${checks} checks passed ================`)
if (failures > 0) { console.log(`${failures} FAILURE(S)`); process.exit(1) }
console.log('ALL PASS')
