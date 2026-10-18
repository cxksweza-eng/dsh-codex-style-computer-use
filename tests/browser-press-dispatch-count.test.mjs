// Dispatch-count instrumentation for browser_press (2026-10-19).
//
// THE QUESTION: the NO_FOCUS refusal reported `registry.dispatches: 1` while also reporting
// `outcome: "not-dispatched"` and `dispatched: false`. Those look contradictory, so this file measures
// what actually happens rather than reading the code and asserting an opinion.
//
// WHAT IT DOES: wraps `session.send` for the duration of the suite and counts every real
// `Input.dispatchKeyEvent` frame. The wrapper is LOCAL TO THIS TEST PROCESS — no production hook, no
// permanent probe, no log line added to the plugin. It is the only way to answer "did a key event
// actually leave the process?" without trusting the return value that is under investigation.

import http from 'node:http'
import os from 'node:os'
import { join } from 'node:path'
import { BrowserSession } from '../lib/browser-session.js'
import { registerBrowserTools } from '../lib/browser-tools.js'
import { ActionRegistry } from '../lib/action-registry.js'

const PORT = Number(process.env.CU_INSTR_PORT || 9411)
const HTTP_PORT = Number(process.env.CU_INSTR_HTTP || 8841)
const PROFILE = join(os.tmpdir(), `cu-instr-profile-${PORT}`)

let failures = 0
let checks = 0
const ok = (cond, label, detail) => {
  checks++
  if (cond) console.log(`  PASS  ${label}`)
  else { failures++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`) }
}
const section = (t) => console.log(`\n--- ${t} ---`)

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Instr Fixture</title></head><body>
<label for="f">Field</label><input id="f" type="text" value="abc">
<input id="dis" type="text" disabled value="">
<input id="hid" type="text" style="display:none" value="">
<button id="b">Button</button>
<script>window.mut = {
  dropFocus: function () { if (document.activeElement) document.activeElement.blur(); return 'blurred'; },
  moveFocus: function () { document.getElementById('b').focus(); return 'moved'; },
  removeField: function () { var e = document.getElementById('f'); if (e) e.remove(); return 'removed'; }
};</script></body></html>`

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE)
})
await new Promise(r => server.listen(HTTP_PORT, '127.0.0.1', r))
const URL_ = `http://127.0.0.1:${HTTP_PORT}/`

const session = new BrowserSession({ port: PORT, profileDir: PROFILE, headless: true, log: () => {} })
const registry = new ActionRegistry({ log: () => {} })
const tools = new Map()
const defineTool = (d) => d
registerBrowserTools({ session, registry, log: () => {}, defineTool, register: (d) => tools.set(d.name, d) })
const raw = (name, args) => tools.get(name).execute(args, { signal: undefined })

// ---- THE INSTRUMENTATION -------------------------------------------------------------------------
const calls = { keyEvents: 0, byType: {}, other: 0 }
const realSend = session.send.bind(session)
session.send = async (method, params, timeout) => {
  if (method === 'Input.dispatchKeyEvent') {
    calls.keyEvents++
    const t = (params && params.type) || 'unknown'
    calls.byType[t] = (calls.byType[t] || 0) + 1
  } else {
    calls.other++
  }
  return realSend(method, params, timeout)
}
const resetCalls = () => { calls.keyEvents = 0; calls.byType = {}; calls.other = 0 }

const pageFact = async (expr) => {
  const r = await realSend('Runtime.evaluate', { expression: expr, returnByValue: true })
  return r && r.result ? r.result.value : undefined
}
const focusField = (sel = '#f') => pageFact(`document.querySelector('${sel}').focus()`)
const reset = async () => {
  await raw('browser_navigate', { url: URL_, allowSameUrl: true })
  await pageFact('var e=document.getElementById("f"); if(e) e.value="abc"')
  await focusField()
}

try {
  section('I0  setup')
  const e = await session.ensure()
  ok(e.ok === true, 'browser available', e.reason)
  const a = await session.attach()
  ok(a.ok === true, 'attached', a.reason)
  await raw('browser_navigate', { url: URL_ })
  ok((await pageFact('document.title')) === 'Instr Fixture', 'fixture loaded')

  section('I1  NO_FOCUS sends ZERO key events (the reported contradiction)')
  await reset()
  await pageFact('document.activeElement.blur()')
  resetCalls()
  const noFocus = await raw('browser_press', { key: 'Enter', selector: '#f' })
  ok(noFocus.code === 'NO_FOCUS', 'the refusal is NO_FOCUS', noFocus.code)
  ok(noFocus.dispatched === false, 'the tool reports dispatched:false')
  ok(calls.keyEvents === 0, 'and ZERO Input.dispatchKeyEvent frames were sent', calls.keyEvents)
  ok(noFocus.registry.dispatches === 1, 'while registry.dispatches is 1 (the slot was CLAIMED)', noFocus.registry.dispatches)
  ok(noFocus.registry.state === 'CANCELLED', 'and the record settles to CANCELLED', noFocus.registry.state)
  // The two numbers describe different things; say so precisely.
  ok(noFocus.registry.dispatches > 0 && noFocus.dispatched === false,
    'so `dispatches` counts CLAIMS of the single slot, not CDP calls')

  section('I2  refused targets send ZERO key events')
  resetCalls()
  const notFound = await raw('browser_press', { key: 'Enter', selector: '#nope' })
  ok(notFound.code === 'TARGET_NOT_FOUND', 'missing target refused', notFound.code)
  ok(calls.keyEvents === 0, 'zero key events', calls.keyEvents)

  resetCalls()
  const disabled = await raw('browser_press', { key: 'Enter', selector: '#dis' })
  ok(disabled.code === 'TARGET_DISABLED', 'disabled target refused', disabled.code)
  ok(calls.keyEvents === 0, 'zero key events', calls.keyEvents)

  resetCalls()
  const hidden = await raw('browser_press', { key: 'Enter', selector: '#hid' })
  ok(hidden.code === 'TARGET_INVISIBLE' || hidden.code === 'TARGET_NOT_FOUND', 'hidden target refused', hidden.code)
  ok(calls.keyEvents === 0, 'zero key events', calls.keyEvents)

  resetCalls()
  const clipboard = await raw('browser_press', { key: 'ctrl+v' })
  ok(clipboard.code === 'CLIPBOARD_REQUIRES_TARGET', 'clipboard without target refused', clipboard.code)
  ok(calls.keyEvents === 0, 'zero key events', calls.keyEvents)

  resetCalls()
  const badKey = await raw('browser_press', { key: 'F12' })
  ok(badKey.code === 'KEY_NOT_ALLOWED', 'disallowed key refused', badKey.code)
  ok(calls.keyEvents === 0, 'zero key events', calls.keyEvents)

  section('I3  a focus change at the boundary sends ZERO key events')
  await reset()
  resetCalls()
  const moved = await tools.get('browser_press').execute({
    key: 'Backspace', selector: '#f',
    get [Symbol.for('dsh.computerUse.browserTestBoundary')] () { return async () => { await pageFact('document.getElementById("b").focus()') } },
  }, { signal: undefined })
  ok(moved.code === 'FOCUS_CHANGED', 'refused for focus change', moved.code)
  ok(calls.keyEvents === 0, 'zero key events', calls.keyEvents)

  section('I4  a successful single key sends exactly one keyDown/keyUp pair')
  await reset()
  // The caret must be at the END for Backspace to have anything to delete. A freshly focused field can sit
  // at offset 0, where Backspace legitimately does nothing — and the tool correctly calls that UNKNOWN.
  // An earlier version of this case forgot the caret and was measuring the fixture, not the tool.
  await pageFact('(() => { var e = document.getElementById("f"); e.value = "abc"; e.setSelectionRange(3, 3); })()')
  resetCalls()
  const one = await raw('browser_press', { key: 'Backspace', selector: '#f' })
  ok(one.ok === true, 'the press succeeded', JSON.stringify(one.problems))
  ok(one.dispatched === true, 'reports dispatched:true')
  ok(one.registry.dispatches === 1, 'registry.dispatches is 1')
  // A single key = keyDown + keyUp. The assertion is on the PAIR, so a duplicated send would show as 4.
  ok(calls.keyEvents === 2, 'exactly 2 frames: one keyDown, one keyUp', `${calls.keyEvents} ${JSON.stringify(calls.byType)}`)
  ok(calls.byType.keyDown === 1 && calls.byType.keyUp === 1, 'one of each type', JSON.stringify(calls.byType))

  section('I5  a chord sends its modifier frames but still only ONCE')
  await reset()
  resetCalls()
  const chord = await raw('browser_press', { key: 'ctrl+a', selector: '#f' })
  ok(chord.dispatched === true, 'the chord was dispatched')
  // ctrl+a = Control down, key down, key up, Control up = 4 frames, and crucially the letter appears once.
  ok(calls.keyEvents === 4, 'exactly 4 frames for the chord', `${calls.keyEvents} ${JSON.stringify(calls.byType)}`)
  ok(calls.byType.keyDown === 1, 'the actual key is pressed exactly once', JSON.stringify(calls.byType))

  section('I6  a CANCELLED action cannot be dispatched again')
  const cancelledId = noFocus.actionId
  const again = registry.beginDispatch(cancelledId)
  ok(again.ok === false, 're-dispatch of the CANCELLED action is refused', again.reason)
  ok(registry.get(cancelledId).dispatches === 1, 'and its counter never advances', registry.get(cancelledId).dispatches)

  section('I7  UNKNOWN is terminal and never replays')
  await reset()
  resetCalls()
  const inflight = raw('browser_press', { key: 'End', selector: '#f' })
  await new Promise(r => setTimeout(r, 10))
  session.connection.close()
  const lost = await inflight
  ok(lost.ok === false, 'the press did not claim success')
  ok(['unknown', 'not-dispatched'].includes(lost.outcome), 'outcome is UNKNOWN (or nothing sent)', lost.outcome)
  const framesAtLoss = calls.keyEvents
  await new Promise(r => setTimeout(r, 200))
  ok(calls.keyEvents === framesAtLoss, 'no further key events were sent after the loss (no replay)', calls.keyEvents)

  section('I8  the returned registry snapshot says what the counter means')
  // After the fix, the snapshot alongside `registry.dispatches` carries `dispatchClaimed` and
  // `sideEffectSent`, so a reader is not left to guess whether "1" means "sent" or "claimed".
  await session.attach()
  await reset()
  const summed = await raw('browser_press', { key: 'Home', selector: '#f' })
  ok(summed.registry.dispatchClaimed === true, 'a claimed slot is reported as dispatchClaimed:true', String(summed.registry.dispatchClaimed))
  ok(summed.registry.sideEffectSent === true, 'and a real send is reported as sideEffectSent:true', String(summed.registry.sideEffectSent))
  await reset()
  await pageFact('document.activeElement.blur()')
  const refused = await raw('browser_press', { key: 'Enter', selector: '#f' })
  ok(refused.registry.dispatchClaimed === true, 'a refusal still shows the slot was claimed', String(refused.registry.dispatchClaimed))
  ok(refused.registry.sideEffectSent === false, 'but sideEffectSent is false, which is the fact that matters', String(refused.registry.sideEffectSent))
  ok(refused.registry.dispatches === 1, 'while dispatches remains 1 for backward compatibility', refused.registry.dispatches)
} finally {
  section('teardown')
  session.dispose()
  server.close()
}

console.log(`\n================ ${checks - failures}/${checks} checks passed ================`)
if (failures > 0) { console.log(`${failures} FAILURE(S)`); process.exit(1) }
console.log('ALL PASS')
