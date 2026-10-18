// Integration test for browser_type (2026-10-16).
//
// THE CHAIN UNDER TEST:
//   OBSERVE -> RESOLVE -> CAPTURE IDENTITY -> [APPROVAL BOUNDARY] -> RE-OBSERVE -> REVALIDATE -> TYPE -> VERIFY
//
// A REAL HTTP SERVER AND A REAL CHROMIUM. The boundary is reached through `BROWSER_TEST_BOUNDARY`, a
// Symbol key that a JSON tool call cannot express, so the mutation always lands after the identity is
// captured and before the post-approval observation. Nothing here widens `approvalSettleMs` or any other
// safety parameter; the boundary is a hook, not a longer window.
//
// THE SENSITIVE-DATA RULE IS ITSELF TESTED. The value typed in every case is a fixed, non-sensitive
// fixture string, and the suite asserts that this string appears in NO result, NO registry record and NO
// observation - only its length and digest may. A test that leaked it would fail the suite.

import http from 'node:http'
import os from 'node:os'
import { join } from 'node:path'
import { BrowserSession } from '../lib/browser-session.js'
import { registerBrowserTools, BROWSER_TEST_BOUNDARY } from '../lib/browser-tools.js'
import { ActionRegistry } from '../lib/action-registry.js'

const PORT = Number(process.env.CU_TYPE_PORT || 9361)
const HTTP_PORT = Number(process.env.CU_TYPE_HTTP || 8811)
const PROFILE = join(os.tmpdir(), `cu-type-profile-${PORT}`)
const PROBE = 'BrowserTypeTest123'

let failures = 0
let checks = 0
const ok = (cond, label, detail) => {
  checks++
  if (cond) console.log(`  PASS  ${label}`)
  else { failures++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`) }
}
const section = (t) => console.log(`\n--- ${t} ---`)

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Type Fixture</title></head><body>
<h1>Type fixture</h1>
<label for="type-input">Type here</label>
<input id="type-input" name="type-input" type="text" placeholder="empty">
<label for="type-area">Area</label>
<textarea id="type-area" name="type-area"></textarea>
<div id="type-editable" contenteditable="true" role="textbox" aria-label="Editable region"></div>
<input id="type-disabled" type="text" disabled value="">
<input id="type-password" type="password" value="">
<button id="a-button">A button, not a field</button>
<div id="host"></div>
<script>
  window.mut = {
    tRemove: function () { document.getElementById('type-input').remove(); return 'type-removed'; },
    tReplace: function () { var o = document.getElementById('type-input'); var n = document.createElement('input'); n.id = 'type-input'; n.type = 'text'; o.replaceWith(n); return 'type-replaced'; },
    tDisable: function () { document.getElementById('type-input').disabled = true; return 'type-disabled'; },
    tHide: function () { document.getElementById('type-input').style.display = 'none'; return 'type-hidden'; },
    tDropId: function () { document.getElementById('type-input').removeAttribute('id'); return 'type-id-dropped'; },
    tRename: function () { var e = document.getElementById('type-input'); e.setAttribute('aria-label', 'Renamed field'); return 'type-renamed'; },
    tReport: function () { var e = document.getElementById('type-input'); return { exists: !!e, value: e ? e.value : null, matches: document.querySelectorAll('#type-input').length }; }
  };
</script></body></html>`

const server = http.createServer((req, res) => {
  const pathname = String(req.url || '/').split('?')[0]
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); return
  }
  res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>404 Not Found</title>nope')
})
await new Promise(r => server.listen(HTTP_PORT, '127.0.0.1', r))
const URL_ = `http://127.0.0.1:${HTTP_PORT}/`

const session = new BrowserSession({ port: PORT, profileDir: PROFILE, headless: true, log: () => {} })
const registry = new ActionRegistry({ log: () => {} })
const tools = new Map()
registerBrowserTools({ session, registry, log: () => {}, defineTool: (d) => d, register: (d) => tools.set(d.name, d) })
const raw = (name, args) => tools.get(name).execute(args, { signal: undefined })

const pageFact = async (expr) => {
  const r = await session.send('Runtime.evaluate', { expression: expr, returnByValue: true })
  return r && r.result ? r.result.value : undefined
}
const withBoundary = (name, args, mutation) => raw(name, { ...args, [BROWSER_TEST_BOUNDARY]: mutation })
/** A fresh, unmutated page for each boundary case. */
const reset = async () => { await raw('browser_navigate', { url: URL_, allowSameUrl: true }) }

const runName = 'browser_type'

try {
  section('T0  setup')
  const e = await session.ensure()
  ok(e.ok === true, 'browser available', e.reason)
  const a = await session.attach()
  ok(a.ok === true, 'attached', a.reason)
  const nav = await raw('browser_navigate', { url: URL_, expectTitleIncludes: 'Type Fixture' })
  ok(nav.ok === true, 'fixture loaded', JSON.stringify(nav.problems))

  section('T1  the tool is registered and declared as an actuation tool')
  ok(tools.has('browser_type'), 'browser_type is registered')
  const { BROWSER_ACTUATION_TOOLS } = await import('../lib/browser-tools.js')
  ok(BROWSER_ACTUATION_TOOLS.has('browser_type'), 'and is in BROWSER_ACTUATION_TOOLS (so the policy gate governs it)')
  const { policyDecision } = await import('../lib/policy.js')
  ok(policyDecision('browser_type', { text: 'x' }, 'standard').kind === 'ask', 'standard mode ASKS for browser_type',
    JSON.stringify(policyDecision('browser_type', { text: 'x' }, 'standard')))
  ok(policyDecision('browser_type', { text: 'x' }, 'read-only').kind === 'deny', 'read-only mode DENIES browser_type')

  section('A/I  a normal type is VERIFIED by reading the field back')
  const okType = await raw('browser_type', { selector: '#type-input', text: PROBE })
  ok(okType.ok === true, 'the type verified', JSON.stringify({ outcome: okType.outcome, problems: okType.problems, how: okType.how }))
  ok(okType.dispatched === true, 'and reports that it dispatched')
  ok(okType.registry.state === 'VERIFIED', 'registry recorded VERIFIED', okType.registry.state)
  ok(okType.registry.dispatches === 1, 'exactly one dispatch', okType.registry.dispatches)
  ok(okType.usedPreApprovalBox === false, 'and it did not use a pre-approval box')
  const live = await pageFact('document.getElementById("type-input").value')
  ok(live === PROBE, 'the page really holds the text')

  section('S  the typed text is NEVER echoed (result, registry, observation)')
  const flatResult = JSON.stringify(okType)
  ok(!flatResult.includes(PROBE), 'the result does not contain the typed text')
  ok(flatResult.includes('textLength'), 'but it does report textLength')
  ok(flatResult.includes('textDigest'), 'and textDigest')
  const obsNow = await raw('browser_observe', {})
  ok(!JSON.stringify(obsNow).includes(PROBE), 'the observation does not contain the typed text')
  const field = obsNow.interactive.find(x => x.selector === '#type-input')
  ok(Boolean(field), 'the field is observable')
  ok(typeof field.valueDigest === 'string' && field.valueDigest.startsWith(`${PROBE.length}:`), 'and exposes only a length-prefixed digest', field.valueDigest)
  ok(field.valueLength === PROBE.length, 'plus its length', String(field.valueLength))

  section('S2  a password target is never read')
  const pwObs = await raw('browser_observe', {})
  const pw = pwObs.interactive.find(x => x.selector === '#type-password')
  ok(Boolean(pw) && pw.sensitive === true, 'the password field is flagged sensitive')
  ok(pw.valueDigest === null && pw.valueLength === null, 'and exposes neither digest nor length', `${pw.valueDigest}/${pw.valueLength}`)

  section('B  a target that does not exist is refused before dispatch')
  const b = await raw('browser_type', { selector: '#no-such-field', text: PROBE })
  ok(b.ok === false && b.code === 'TARGET_NOT_FOUND', 'refused with TARGET_NOT_FOUND', b.code)
  ok(b.dispatched === false, 'nothing was dispatched')

  section('I2  a non-editable target is refused with TARGET_NOT_EDITABLE')
  const notEditable = await raw('browser_type', { selector: '#a-button', text: PROBE })
  ok(notEditable.ok === false, 'the type did not succeed')
  ok(notEditable.code === 'TARGET_NOT_EDITABLE', 'refused with TARGET_NOT_EDITABLE', notEditable.code)
  ok(notEditable.dispatched === false, 'and NOTHING was dispatched')

  section('H  ambiguity is refused, never resolved by picking one')
  // The duplicate is built by cloning the REAL field and dropping its id, so the two nodes differ only by
  // the id — exactly the shape a `role`+`name` match cannot tell apart. Counting is done on the live DOM
  // in the same expression, and the count is asserted, so a fixture that silently did nothing fails here
  // instead of quietly passing the product assertion below it.
  const dup = await pageFact(`(() => {
    var src = document.getElementById('type-input');
    var c = src.cloneNode(true);
    c.removeAttribute('id');
    // A label element associates by its for attribute, which does not survive a clone, so the copy would
    // otherwise have an EMPTY accessible name and would not collide with the original at all. The
    // aria-label is what makes this a genuine ambiguity rather than a second, unrelated field.
    c.setAttribute('aria-label', 'Type here');
    document.getElementById('host').appendChild(c);
    return document.querySelectorAll('#type-input, #host > input').length;
  })()`)
  ok(dup === 2, 'the fixture produced a second field that differs only by its id', dup)
  const amb = await raw('browser_type', { role: 'textbox', name: 'Type here', text: PROBE })
  ok(amb.ok === false && amb.code === 'AMBIGUOUS', 'refused with AMBIGUOUS', `${amb.code}: ${amb.reason}`)
  ok(amb.dispatched === false, 'and NOTHING was dispatched')
  await reset()

  section('E  a disabled target is refused')
  await pageFact('document.getElementById("type-input").disabled = true')
  const dis = await raw('browser_type', { selector: '#type-input', text: PROBE })
  ok(dis.ok === false && dis.code === 'TARGET_DISABLED', 'refused with TARGET_DISABLED', dis.code)
  ok(dis.dispatched === false, 'and NOTHING was dispatched')
  await reset()

  section('F  a hidden target is refused')
  await pageFact('document.getElementById("type-input").style.display = "none"')
  const hid = await raw('browser_type', { selector: '#type-input', text: PROBE })
  ok(hid.ok === false && (hid.code === 'TARGET_INVISIBLE' || hid.code === 'TARGET_NOT_FOUND'), 'refused', hid.code)
  ok(hid.dispatched === false, 'and NOTHING was dispatched')
  await reset()

  section('C  the field is REMOVED at the boundary — refused, nothing typed')
  await reset()
  const c1 = await withBoundary(runName, { selector: '#type-input', text: PROBE }, async () => { await pageFact('window.mut.tRemove()') })
  ok(c1.ok === false, 'the type did not succeed', JSON.stringify({ ok: c1.ok, code: c1.code }))
  ok(c1.code === 'TARGET_NOT_FOUND', 'refused with TARGET_NOT_FOUND', c1.code)
  ok(c1.dispatched === false, 'and NOTHING was dispatched')

  section('D  the field is replaced by an INDISTINGUISHABLE node — revalidation cannot tell, and says so')
  // THE HONEST BOUNDARY OF THE IDENTITY MODEL, tested rather than assumed. `tReplace` installs a brand new
  // <input id="type-input" type="text"> — a DIFFERENT DOM node with the SAME selector, role and accessible
  // name. The identity model proves continuity from those three facts, so it accepts the node and types
  // into it; the value check afterwards is what confirms the text actually landed. This is the same
  // behaviour `browser_click` was verified to have, so it is NOT a type-specific regression — but it IS
  // the limit of what "the same element" can mean without an identity the DOM does not provide.
  await reset()
  const d0 = await withBoundary(runName, { selector: '#type-input', text: PROBE }, async () => { await pageFact('window.mut.tReplace()') })
  ok(d0.registry.state === 'VERIFIED', 'an indistinguishable replacement is accepted and reaches VERIFIED', d0.registry.state)
  ok(d0.dispatched === true, 'and the text was genuinely dispatched')
  ok(d0.registry.dispatches === 1, 'exactly once', d0.registry.dispatches)

  section('D2  the field is replaced by a DETECTABLY DIFFERENT node — refused')
  // The other half of the same rule: when the replacement changes something the identity model CAN see,
  // revalidation refuses. Proven through the accessible name, which the model captures.
  await reset()
  const d1 = await withBoundary(runName, { role: 'textbox', name: 'Type here', text: PROBE }, async () => { await pageFact('window.mut.tRename()') })
  ok(d1.ok === false, 'the type did not succeed', JSON.stringify({ ok: d1.ok, code: d1.code }))
  ok(d1.code === 'TARGET_CHANGED', 'refused with TARGET_CHANGED', `${d1.code}: ${d1.reason}`)
  ok(d1.dispatched === false, 'and NOTHING was dispatched')

  section('D3  the field is REMOVED at the boundary — refused')
  await reset()
  const d2 = await withBoundary(runName, { selector: '#type-input', text: PROBE }, async () => { await pageFact('window.mut.tRemove()') })
  ok(d2.ok === false && d2.code === 'TARGET_NOT_FOUND', 'refused with TARGET_NOT_FOUND', d2.code)
  ok(d2.dispatched === false, 'and NOTHING was dispatched')

  section('E2  the field is DISABLED at the boundary — refused')
  await reset()
  const e2 = await withBoundary(runName, { selector: '#type-input', text: PROBE }, async () => { await pageFact('window.mut.tDisable()') })
  ok(e2.ok === false && e2.code === 'TARGET_DISABLED', 'refused with TARGET_DISABLED', e2.code)
  ok(e2.dispatched === false, 'and NOTHING was dispatched')

  section('F2  the field is HIDDEN at the boundary — refused')
  await reset()
  const f2 = await withBoundary(runName, { selector: '#type-input', text: PROBE }, async () => { await pageFact('window.mut.tHide()') })
  ok(f2.ok === false && (f2.code === 'TARGET_INVISIBLE' || f2.code === 'TARGET_NOT_FOUND'), 'refused', f2.code)
  ok(f2.dispatched === false, 'and NOTHING was dispatched')

  section('G  selector uniqueness changes at the boundary — refused')
  await reset()
  const g1 = await withBoundary(runName, { selector: '#type-input', text: PROBE }, async () => { await pageFact('window.mut.tDropId()') })
  ok(g1.ok === false, 'the type did not succeed')
  ok(g1.code === 'TARGET_NOT_FOUND' || g1.code === 'AMBIGUOUS', 'the selector no longer proves', g1.code)
  ok(g1.dispatched === false, 'and NOTHING was dispatched')

  section('G2  the field is RENAMED at the boundary — refused as a different identity')
  await reset()
  const g2 = await withBoundary(runName, { role: 'textbox', name: 'Type here', text: PROBE }, async () => { await pageFact('window.mut.tRename()') })
  ok(g2.ok === false, 'the type did not succeed', JSON.stringify({ ok: g2.ok, code: g2.code }))
  ok(g2.code === 'TARGET_CHANGED', 'refused with TARGET_CHANGED', `${g2.code}: ${g2.reason}`)
  ok(g2.dispatched === false, 'and NOTHING was dispatched')

  section('K/O  an action can never be dispatched twice')
  await reset()
  const k1 = await raw('browser_type', { selector: '#type-input', text: PROBE })
  ok(k1.registry.dispatches === 1, 'exactly one dispatch', k1.registry.dispatches)
  ok(registry.beginDispatch(k1.actionId).ok === false, 'a second dispatch on the same action is refused')
  ok(registry.get(k1.actionId).dispatches === 1, 'and the counter never advances', registry.get(k1.actionId).dispatches)

  section('J  UNKNOWN is terminal and never replayed')
  await reset()
  const inflight = raw('browser_type', { selector: '#type-input', text: PROBE })
  await new Promise(r => setTimeout(r, 20))
  session.connection.close()
  const lost = await inflight
  ok(lost.ok === false, 'the type did not claim success', JSON.stringify({ outcome: lost.outcome, code: lost.code }))
  ok(lost.outcome === 'unknown' || lost.outcome === 'not-dispatched', 'the outcome is UNKNOWN (or nothing was sent)', lost.outcome)
  if (lost.registry) {
    ok(lost.registry.state === 'UNKNOWN' || lost.registry.state === 'CREATED', 'and the registry agrees', lost.registry.state)
    ok(registry.beginDispatch(lost.actionId).ok === false || lost.registry.state === 'CREATED', 'a terminal action can never be dispatched again')
  }

  section('N  D4 correlation: hostCallId travels with the record')
  const { noteHostCallId } = await import('../lib/action-registry.js')
  await session.attach()
  await reset()
  noteHostCallId('browser_type', 'call_type_test_1')
  const n1 = await raw('browser_type', { selector: '#type-input', text: PROBE })
  ok(n1.registry.hostCallId === 'call_type_test_1', 'the record carries the host call id', String(n1.registry.hostCallId))
  ok(n1.actionId.startsWith('browser_type#a'), 'and keeps its own registry action id', n1.actionId)
  ok(!JSON.stringify(n1).includes(PROBE), 'and the result still does not contain the typed text')
} finally {
  section('teardown')
  session.dispose()
  server.close()
}

console.log(`\n================ ${checks - failures}/${checks} checks passed ================`)
if (failures > 0) { console.log(`${failures} FAILURE(S)`); process.exit(1) }
console.log('ALL PASS')
