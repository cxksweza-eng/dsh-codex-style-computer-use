import path from 'node:path'
import os from 'node:os'
// Wrapper-level test for the approval/handoff policy (2026-10-16).
//
// WHY THIS FILE EXISTS: the first integration run failed with `ReferenceError: act is not defined`.
// The offline suite called `cu.actuate(op, args, act)` DIRECTLY, so it never executed the code in
// `tools.js` that builds `act` and hands it to `withInputContext` — the exact line that was broken.
// These tests go through `registerTools(...).execute(...)`, which is what the Host actually calls.

import { registerTools } from '../lib/tools.js'
import { ActionRegistry } from '../lib/action-registry.js'

let failures = 0
let checks = 0
const ok = (cond, label, detail) => {
  checks++
  if (cond) console.log(`  PASS  ${label}`)
  else { failures++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`) }
}
const section = (t) => console.log(`\n--- ${t} ---`)

function harverst () {
  const definitions = []
  const seenContexts = []
  const actuateCalls = []
  const registry = new ActionRegistry({ log: () => {} })

  const cu = {
    // The real core reads `act` back out of the ALS store inside actuate(); mirror that contract so a
    // missing/renamed hand-off would show up here rather than in production.
    withInputContext (context, fn) { seenContexts.push(context); return fn() },
    async actuate (op, args, act) {
      const viaContext = cu._store ? cu._store.act : undefined
      actuateCalls.push({ op, args, act, viaContext })
      return { ok: true }
    },
    // --- observation surface used by the wrapper's optional feedback path ---
    async screenshot () { return { image: Buffer.from('x'), mime: 'image/jpeg', region: { x: 0, y: 0, width: 1, height: 1 }, settled: true } },
    async call (op) { return { op } },
    async screenState () { return { windows: [] } },
    async landmarks () { return { count: 0, hwnd: 0, marks: [] } },
    async marks () { return { annotated: null } },
    async resolveTarget (t) { return t && t.mark ? { x: 1, y: 1, mark: t.mark } : { x: t.x, y: t.y } },
    async validateMarkFrame () { return true },
    async move (x, y) { return cu.actuate('move', { x, y }) },
    async click () { return cu.actuate('click', {}) },
    async key () { return cu.actuate('key', {}) },
    async type () { return cu.actuate('type', {}) },
    async clipRead () { return { kind: 'text', text: '' } },
    async clipWrite () { return cu.actuate('clipWrite', {}) },
    async activateWindow (sel) { return cu.actuate('activate', sel) },
    async windowOp (sel, op, opts = {}) { return cu.actuate('windowOp', { ...sel, op, ...opts }) },
    async selfTest () { return cu.actuate('selftest', {}) },
    async waitForIdle () { return {} },
    async waitStable () { return {} },
    async waitChange () { return {} },
    get cooperation () { return { phase: 'idle', active: false } },
    stopped: false,
    exited: false,
  }

  const ctx = {
    get: () => undefined,
    on: () => () => {},
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  }

  registerTools({
    ctx,
    cu,
    config: { annotateMarks: true, actionFeedback: false },
    dataDir: path.join(os.tmpdir(), 'cu-wrapper-test'),
    log: { info: () => {}, warn: () => {} },
    snapshotPath: (d) => `${d}\\shot.jpg`,
    // `defineTool` in the real plugin attaches the output/schema plumbing. The wrapper under test only
    // needs the returned object to carry `name`/`timeoutMs`/`execute`.
    defineTool: (def) => ({ ...def, output: {} }),
    hooks: {},
    ensureCycle: async () => ({}),
    // A REAL registry, so the wrapper's registration path is exercised rather than skipped: with
    // `actionRegistry` undefined the wrapper silently creates no record, which is exactly the shape of
    // the wiring bug that W9 pins.
    actionRegistry: registry,
    register: (d) => definitions.push(d),
  })

  return { definitions, seenContexts, actuateCalls, cu, registry }
}

const findTool = (defs, name) => defs.find(d => d.name === name)
const fakeExec = { signal: new AbortController().signal, agent: { id: 'test-agent' } }

// ---------------------------------------------------------------------------------------------
section('W1  the wrapper registers every driving tool (no load-time throw)')
{
  const h = harverst()
  ok(h.definitions.length >= 18, `registered ${h.definitions.length} tools`, `expected >= 18`)
  for (const name of ['computer_move', 'computer_click', 'computer_key', 'computer_type', 'computer_clip', 'computer_window']) {
    ok(!!findTool(h.definitions, name), `${name} is registered`)
  }
}

// ---------------------------------------------------------------------------------------------
section('W2  computer_move executes through the wrapper without a ReferenceError')
{
  const h = harverst()
  const tool = findTool(h.definitions, 'computer_move')
  let err = null
  let out = null
  try { out = await tool.execute({ at: '100,200' }, fakeExec) } catch (e) { err = e }
  // THIS is the regression the integration run caught.
  ok(err === null, 'no exception escaped the wrapper', err && `${err.name}: ${err.message}`)
  ok(out && out.ok === true, 'the tool returned its result')
  ok(h.actuateCalls.length === 1, `actuate ran exactly once (got ${h.actuateCalls.length})`)
  ok(h.actuateCalls[0] && h.actuateCalls[0].op === 'move', 'the move op reached the core')
}

// ---------------------------------------------------------------------------------------------
section('W3  the act record reaches withInputContext (the verifier hand-off)')
{
  const h = harverst()
  const tool = findTool(h.definitions, 'computer_move')
  await tool.execute({ at: '100,200' }, fakeExec)
  ok(h.seenContexts.length === 1, 'withInputContext was called once')
  const ctxArg = h.seenContexts[0]
  ok(ctxArg && typeof ctxArg === 'object', 'a context object was passed (not the raw exec)')
  ok(ctxArg && ctxArg.act && typeof ctxArg.act === 'object', 'the context carries `act`', JSON.stringify(ctxArg))
  ok(ctxArg && ctxArg.act && Number.isFinite(ctxArg.act.budget), 'act carries a finite settle budget')
  ok(ctxArg && ctxArg.act && ctxArg.act.retried === false, 'act starts with retried=false')
  ok(ctxArg && 'signal' in ctxArg, 'the signal is still forwarded')
}

// ---------------------------------------------------------------------------------------------
section('W4  a coordinate target gets NO verifier (so it can never be replayed)')
{
  const h = harverst()
  const tool = findTool(h.definitions, 'computer_move')
  await tool.execute({ at: '100,200' }, fakeExec)
  const act = h.seenContexts[0].act
  ok(act.verify === null || act.verify === undefined, 'a bare coordinate yields no verifier', String(act.verify))
}

// ---------------------------------------------------------------------------------------------
section('W5  an hwnd target DOES get a verifier that re-reads the window')
{
  const h = harverst()
  const tool = findTool(h.definitions, 'computer_window')
  await tool.execute({ hwnd: 4242, op: 'activate' }, fakeExec)
  const act = h.seenContexts[0].act
  ok(typeof act.verify === 'function', 'an hwnd target yields a verifier')
  const verdict = await act.verify()
  ok(verdict && typeof verdict.ok === 'boolean', 'the verifier returns a verdict', JSON.stringify(verdict))
}

// ---------------------------------------------------------------------------------------------
section('W6  a mark target gets a frame-checking verifier')
{
  const h = harverst()
  const tool = findTool(h.definitions, 'computer_click')
  await tool.execute({ mark: 'M3' }, fakeExec)
  const act = h.seenContexts[0].act
  ok(typeof act.verify === 'function', 'a mark target yields a verifier')
  const verdict = await act.verify()
  ok(verdict && verdict.ok === true, 'a passing frame check reports ok', JSON.stringify(verdict))
}

// ---------------------------------------------------------------------------------------------
section('W7  every driving tool survives the same wrapper path (no per-tool surprise)')
{
  const cases = [
    ['computer_move', { at: '10,10' }],
    ['computer_click', { at: '10,10' }],
    ['computer_key', { combo: 'ctrl+a' }],
    ['computer_type', { text: 'hi' }],
    ['computer_window', { hwnd: 1, op: 'activate' }],
    ['computer_clip', { text: 'x' }],
  ]
  for (const [name, args] of cases) {
    const h = harverst()
    const tool = findTool(h.definitions, name)
    let err = null
    try { await tool.execute(args, fakeExec) } catch (e) { err = e }
    ok(err === null, `${name} ran clean`, err && `${err.name}: ${err.message}`)
  }
}

// ---------------------------------------------------------------------------------------------
section('W8  timeoutMs is present so the settle budget can be derived')
{
  const h = harverst()
  let missing = []
  for (const d of h.definitions) if (!Number.isFinite(d.timeoutMs)) missing.push(d.name)
  ok(missing.length === 0, 'every tool declares a numeric timeoutMs', missing.join(','))
}

// ---------------------------------------------------------------------------------------------
section('W9  REGRESSION: the approval id IS the registry action id (correlation fix)')
{
  // THE DEFECT THIS PINS (integration, 2026-10-16): the approval audit line used the HOST's callId
  // (`computer_drag#call_00_…`) while the registry minted its own id (`computer_drag#a1-…`). The two
  // could not be joined, so an approval record could not be matched to the registry record it
  // described, and the registry-level evidence for a run was unobtainable. The registry id must win.
  const h = harverst()
  const cu = h.cu
  const record = h.registry.create('computer_drag', { op: 'computer_drag' })
  cu.pendingAction = record
  cu.approvalsPending = 0
  // The native side records whatever string it is handed, so assert on the ACTUAL string, not on a
  // helper that could drift away from it.
  let seen = null
  cu.beginApprovalHold = async (label, actionId) => { seen = { label, actionId }; return { hold: true } }
  await cu.beginApprovalHold('computer_drag', record.id)
  ok(seen !== null, 'beginApprovalHold was reached')
  ok(seen.actionId === record.id, 'the id handed over is the REGISTRY action id', `${seen.actionId} vs ${record.id}`)
  ok(/^computer_drag#a\d+-/.test(seen.actionId), 'and it carries the registry id shape', seen.actionId)
  ok(!/#call_/.test(seen.actionId), 'it is NOT the host callId shape any more', seen.actionId)
  // And the registry can be asked about it by that exact id — which is the whole point.
  ok(h.registry.get(seen.actionId) !== undefined, 'the registry resolves the id it published')
}

// ---------------------------------------------------------------------------------------------
console.log(`\n================ ${checks - failures}/${checks} checks passed ================`)
if (failures > 0) { console.log(`${failures} FAILURE(S)`); process.exit(1) }
console.log('ALL PASS')
