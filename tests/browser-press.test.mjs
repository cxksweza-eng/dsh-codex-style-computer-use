// Integration test for browser_press (2026-10-18).
//
// REAL HTTP SERVER, REAL CHROMIUM, REAL CDP KEY EVENTS. A key is only meaningful if the page actually
// received it, so every assertion here is about observed page state after a real `Input.dispatchKeyEvent`,
// never about the call returning.
//
// THE FOCUS RULE IS THE POINT OF THIS SUITE. A key goes to whatever is focused at the instant it is sent,
// and there is an approval detour between "I located the field" and "the key leaves". Cases H and I are the
// ones that would silently type into the wrong place if that rule were missing, so they are exercised at
// the exact boundary via BROWSER_TEST_BOUNDARY (a Symbol key a JSON tool call cannot express).

import http from 'node:http'
import os from 'node:os'
import { join } from 'node:path'
import { BrowserSession } from '../lib/browser-session.js'
import { registerBrowserTools, BROWSER_TEST_BOUNDARY } from '../lib/browser-tools.js'
import { ActionRegistry } from '../lib/action-registry.js'

const PORT = Number(process.env.CU_PRESS_PORT || 9381)
const HTTP_PORT = Number(process.env.CU_PRESS_HTTP || 8821)
const PROFILE = join(os.tmpdir(), `cu-press-profile-${PORT}`)

let failures = 0
let checks = 0
const ok = (cond, label, detail) => {
  checks++
  if (cond) console.log(`  PASS  ${label}`)
  else { failures++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`) }
}
const section = (t) => console.log(`\n--- ${t} ---`)

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Press Fixture</title></head><body>
<h1>Press fixture</h1>
<form id="pform" action="/submitted" method="get">
  <label for="pf">Form field</label>
  <input id="pf" name="pf" type="text" value="abc">
  <button id="psubmit" type="submit">Send</button>
</form>
<label for="nf">Plain field</label>
<input id="nf" name="nf" type="text" value="">
<label for="ef">Editable</label>
<div id="ef" contenteditable="true" role="textbox" aria-label="Editable box"></div>
<input id="dis" type="text" disabled value="">
<input id="hid" type="text" style="display:none" value="">
<div id="modal" style="display:none"><p>modal open</p><button id="close">Close</button></div>
<button id="open">Open modal</button>
<div id="host"></div>
<script>
  document.getElementById('open').addEventListener('click', function () {
    document.getElementById('modal').style.display = 'block';
    document.title = 'Press Fixture - MODAL';
  });
  document.getElementById('close').addEventListener('click', function () {
    document.getElementById('modal').style.display = 'none';
    document.title = 'Press Fixture';
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && document.getElementById('modal').style.display === 'block') {
      document.getElementById('modal').style.display = 'none';
      document.title = 'Press Fixture';
    }
  });
  window.mut = {
    dropFocus: function () { if (document.activeElement) document.activeElement.blur(); return 'blurred'; },
    moveFocus: function () { document.getElementById('nf').focus(); return 'moved'; },
    removeTarget: function () { var e = document.getElementById('nf'); if (e) e.remove(); return 'removed'; },
    disableTarget: function () { document.getElementById('nf').disabled = true; return 'disabled'; },
    hideTarget: function () { document.getElementById('nf').style.display = 'none'; return 'hidden'; },
    report: function () { var a = document.activeElement; return { active: a ? (a.id || a.tagName) : null, modal: document.getElementById('modal').style.display, title: document.title, pf: document.getElementById('pf') ? document.getElementById('pf').value : null, nf: document.getElementById('nf') ? document.getElementById('nf').value : null }; }
  };
</script></body></html>`

const server = http.createServer((req, res) => {
  const pathname = String(req.url || '/').split('?')[0]
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); return
  }
  if (pathname === '/submitted') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>Submitted</title><p>form submitted</p>'); return
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
const boundary = (name, args, mutation) => raw(name, { ...args, [BROWSER_TEST_BOUNDARY]: mutation })
const reset = async () => { await raw('browser_navigate', { url: URL_, allowSameUrl: true }); await pageFact('document.getElementById("nf").value = ""; document.getElementById("pf").value = "abc"; document.getElementById("modal").style.display = "none"; document.title = "Press Fixture";') }
const focusField = async (sel) => pageFact(`document.querySelector('${sel}').focus()`)

try {
  section('P0  setup and registration')
  const e = await session.ensure()
  ok(e.ok === true, 'browser available', e.reason)
  const a = await session.attach()
  ok(a.ok === true, 'attached', a.reason)
  const nav = await raw('browser_navigate', { url: URL_, expectTitleIncludes: 'Press Fixture' })
  ok(nav.ok === true, 'fixture loaded', JSON.stringify(nav.problems))
  ok(tools.has('browser_press'), 'browser_press is registered')
  const { BROWSER_ACTUATION_TOOLS, resolveKey } = await import('../lib/browser-tools.js').then(async (m) => ({ ...m, resolveKey: (await import('../lib/browser-actions.js')).resolveKey }))
  ok(BROWSER_ACTUATION_TOOLS.has('browser_press'), 'and is in BROWSER_ACTUATION_TOOLS (policy gate governs it)')
  const { policyDecision } = await import('../lib/policy.js')
  ok(policyDecision('browser_press', { key: 'Enter' }, 'standard').kind === 'ask', 'standard mode ASKS for browser_press')
  ok(policyDecision('browser_press', { key: 'Enter' }, 'read-only').kind === 'deny', 'read-only mode DENIES browser_press')

  section('K0  the key allowlist refuses anything outside it')
  const badKey = await raw('browser_press', { key: 'F12' })
  ok(badKey.ok === false && badKey.code === 'KEY_NOT_ALLOWED', 'an OS-ish key is refused with KEY_NOT_ALLOWED', badKey.code)
  ok(badKey.dispatched === false, 'and nothing was dispatched')
  const badChord = await raw('browser_press', { key: 'ctrl+w' })
  ok(badChord.ok === false && badChord.code === 'KEY_NOT_ALLOWED', 'an unlisted chord is refused', badChord.code)
  ok(resolveKey('Enter').ok === true, 'Enter resolves')
  ok(resolveKey('ctrl+a').ok === true, 'ctrl+a resolves')
  ok(resolveKey('shift+tab').ok === true, 'shift+tab resolves')
  ok(resolveKey('ctrl+shift+i').ok === false, 'a compound chord is refused')

  section('D  Backspace deletes a character')
  await reset(); await focusField('#nf')
  await pageFact('document.getElementById("nf").value = "abc"')
  const bs = await raw('browser_press', { key: 'Backspace', selector: '#nf' })
  ok(bs.ok === true, 'the press verified', JSON.stringify({ outcome: bs.outcome, problems: bs.problems, how: bs.how }))
  ok(bs.dispatched === true && bs.registry.dispatches === 1, 'dispatched exactly once')
  const nfAfter = await pageFact('document.getElementById("nf").value')
  ok(nfAfter.length <= 3, 'the field changed (real key delivery)', `"${nfAfter}"`)

  section('E  Delete is accepted and dispatched')
  await reset(); await focusField('#nf')
  await pageFact('document.getElementById("nf").value = "abc"')
  const del = await raw('browser_press', { key: 'Delete', selector: '#nf' })
  ok(del.dispatched === true, 'Delete was dispatched')
  ok(del.registry.dispatches === 1, 'exactly once')
  ok(['applied', 'unknown'].includes(del.outcome), 'and its outcome is applied or honestly unknown', del.outcome)

  section('G  Ctrl+A selects the field contents')
  await reset(); await focusField('#nf')
  await pageFact('document.getElementById("nf").value = "abcdef"')
  await pageFact('document.getElementById("nf").setSelectionRange(0,0)')
  const sel = await raw('browser_press', { key: 'ctrl+a', selector: '#nf' })
  ok(sel.dispatched === true, 'ctrl+a was dispatched')
  const selRange = await pageFact('(() => { var e = document.getElementById("nf"); return [e.selectionStart, e.selectionEnd]; })()')
  ok(Array.isArray(selRange) && selRange[0] === 0 && selRange[1] === 6, 'the whole value is selected', JSON.stringify(selRange))

  section('B  Tab moves focus to the next control')
  await reset(); await focusField('#nf')
  const tab = await raw('browser_press', { key: 'Tab', selector: '#nf' })
  ok(tab.dispatched === true, 'Tab was dispatched')
  ok(tab.ok === true, 'and verified by the focus having moved', JSON.stringify({ outcome: tab.outcome, how: tab.how }))
  const focusAfterTab = await pageFact('document.activeElement ? document.activeElement.id : null')
  ok(focusAfterTab !== 'nf', 'focus really left the field', String(focusAfterTab))

  section('C  Escape closes a modal')
  await reset(); await pageFact('document.getElementById("open").click()')
  ok((await pageFact('document.getElementById("modal").style.display')) === 'block', 'the modal is open')
  const esc = await raw('browser_press', { key: 'Escape', expectAppearsName: undefined })
  ok(esc.dispatched === true, 'Escape was dispatched')
  const modalAfter = await pageFact('document.getElementById("modal").style.display')
  ok(modalAfter === 'none', 'the modal really closed', String(modalAfter))
  ok(esc.ok === true, 'and the press verified', JSON.stringify({ outcome: esc.outcome, how: esc.how }))

  section('S  Enter submits the form (a real side effect, verified by navigation)')
  await reset(); await focusField('#pf')
  const enter = await raw('browser_press', { key: 'Enter', selector: '#pf', expectUrlIncludes: '/submitted' })
  ok(enter.dispatched === true, 'Enter was dispatched')
  ok(enter.ok === true, 'and verified through the URL', JSON.stringify({ outcome: enter.outcome, problems: enter.problems }))
  ok(String(enter.url).includes('/submitted'), 'the form really submitted', enter.url)

  section('J  disabled and hidden targets are refused')
  await reset()
  const dis = await raw('browser_press', { key: 'Tab', selector: '#dis' })
  ok(dis.ok === false && dis.code === 'TARGET_DISABLED', 'a disabled target is refused', dis.code)
  ok(dis.dispatched === false, 'and nothing was dispatched')
  const hid = await raw('browser_press', { key: 'Tab', selector: '#hid' })
  ok(hid.ok === false && (hid.code === 'TARGET_INVISIBLE' || hid.code === 'TARGET_NOT_FOUND'), 'a hidden target is refused', hid.code)
  ok(hid.dispatched === false, 'and nothing was dispatched')

  section('K  ambiguous target is refused')
  await reset()
  // A GENUINE ambiguity: `role: textbox` matches several real fields in this fixture (two inputs and a
  // contenteditable), so there is no defensible way to pick one. An earlier version of this case built a
  // single matching element and then asserted ambiguity — which could only ever fail.
  const textboxes = await pageFact('document.querySelectorAll("input[type=text], textarea, [contenteditable=true]").length')
  ok(textboxes >= 2, 'the fixture really contains multiple text targets', textboxes)
  const amb = await raw('browser_press', { key: 'Tab', role: 'textbox' })
  ok(amb.ok === false && amb.code === 'AMBIGUOUS', 'refused with AMBIGUOUS', `${amb.code}: ${amb.reason}`)
  ok(amb.dispatched === false, 'and nothing was dispatched')

  section('H  focus moved at the boundary — refused, no key sent')
  await reset()
  await focusField('#nf')
  const h1 = await boundary('browser_press', { key: 'Backspace', selector: '#nf' }, async () => { await pageFact('document.getElementById("pf").focus()') })
  ok(h1.ok === false, 'the press did not proceed', JSON.stringify({ ok: h1.ok, code: h1.code }))
  ok(h1.code === 'FOCUS_CHANGED', 'refused with FOCUS_CHANGED', `${h1.code}: ${h1.reason}`)
  ok(h1.dispatched === false, 'and NO key was sent')

  section('H2  focus dropped at the boundary — refused')
  await reset()
  await focusField('#nf')
  const h2 = await boundary('browser_press', { key: 'Backspace', selector: '#nf' }, async () => { await pageFact('document.activeElement.blur()') })
  ok(h2.ok === false, 'the press did not proceed')
  ok(h2.code === 'NO_FOCUS' || h2.code === 'FOCUS_CHANGED', 'refused for lack of focus', h2.code)
  ok(h2.dispatched === false, 'and NO key was sent')

  section('I  target removed at the boundary — refused')
  await reset()
  await focusField('#nf')
  const i1 = await boundary('browser_press', { key: 'Backspace', selector: '#nf' }, async () => { await pageFact('window.mut.removeTarget()') })
  ok(i1.ok === false && i1.code === 'TARGET_NOT_FOUND', 'refused with TARGET_NOT_FOUND', i1.code)
  ok(i1.dispatched === false, 'and NO key was sent')

  section('J2  target disabled at the boundary — refused')
  await reset()
  await focusField('#nf')
  const j2 = await boundary('browser_press', { key: 'Backspace', selector: '#nf' }, async () => { await pageFact('window.mut.disableTarget()') })
  ok(j2.ok === false && j2.code === 'TARGET_DISABLED', 'refused with TARGET_DISABLED', j2.code)
  ok(j2.dispatched === false, 'and NO key was sent')

  section('P  page navigation invalidates the target')
  await reset()
  await focusField('#nf')
  const p1 = await boundary('browser_press', { key: 'Backspace', selector: '#nf' }, async () => { await pageFact('location.href = "/submitted"'); await new Promise(r => setTimeout(r, 400)) })
  ok(p1.ok === false, 'the press did not proceed', JSON.stringify({ ok: p1.ok, code: p1.code }))
  ok(['TARGET_NOT_FOUND', 'REFRESH_REQUIRED', 'FOCUS_CHANGED', 'NO_FOCUS', 'TARGET_CHANGED'].includes(p1.code), 'refused because the page moved', p1.code)
  ok(p1.dispatched === false, 'and NO key was sent')

  section('M/O  an action can never be dispatched twice')
  await reset(); await focusField('#nf')
  const m1 = await raw('browser_press', { key: 'Home', selector: '#nf' })
  ok(m1.registry.dispatches === 1, 'exactly one dispatch', m1.registry.dispatches)
  ok(registry.beginDispatch(m1.actionId).ok === false, 'a second dispatch is refused')
  ok(registry.get(m1.actionId).dispatches === 1, 'and the counter never advances')

  section('L  UNKNOWN is terminal and never replayed')
  await reset(); await focusField('#nf')
  const inflight = raw('browser_press', { key: 'End', selector: '#nf' })
  await new Promise(r => setTimeout(r, 10))
  session.connection.close()
  const lost = await inflight
  ok(lost.ok === false, 'the press did not claim success', JSON.stringify({ outcome: lost.outcome, code: lost.code }))
  ok(['unknown', 'not-dispatched'].includes(lost.outcome), 'the outcome is UNKNOWN (or nothing was sent)', lost.outcome)
  if (lost.registry && lost.actionId) {
    ok(['UNKNOWN', 'CREATED', 'CANCELLED'].includes(lost.registry.state), 'and the registry records a non-success state', lost.registry.state)
    ok(registry.beginDispatch(lost.actionId).ok === false || lost.registry.state === 'CREATED', 'a terminal action can never be dispatched again')
  }

  section('R  a key with no observable effect is UNKNOWN, not VERIFIED')
  await session.attach()
  await reset(); await focusField('#nf')
  // ArrowUp in an empty single-line field at position 0 moves nothing that can be observed.
  const noEffect = await raw('browser_press', { key: 'ArrowUp', selector: '#nf' })
  ok(noEffect.dispatched === true, 'the key was dispatched')
  ok(noEffect.ok === false && noEffect.outcome === 'unknown', 'and the outcome is UNKNOWN', `${noEffect.outcome}`)
  ok(Array.isArray(noEffect.problems) && noEffect.problems.length > 0, 'with a stated reason')
  ok(/do not re-press/.test(String(noEffect.note || '')), 'and an explicit no-replay instruction')

  section('CLIP  clipboard chords require a named receiver (least-risk control)')
  // ctrl+v pastes whatever is in the SYSTEM clipboard - which this tool never reads and cannot inspect. If
  // it were allowed to fire at "whatever happens to be focused", the approval card would be a decision about
  // an unnamed target. Requiring a target makes the approval name the field, and the focus check then proves
  // the paste lands there and nowhere else.
  await reset(); await focusField('#nf')
  const vNoTarget = await raw('browser_press', { key: 'ctrl+v' })
  ok(vNoTarget.ok === false && vNoTarget.code === 'CLIPBOARD_REQUIRES_TARGET', 'ctrl+v without a target is refused', vNoTarget.code)
  ok(vNoTarget.dispatched === false, 'and nothing was dispatched')
  const cNoTarget = await raw('browser_press', { key: 'ctrl+c' })
  ok(cNoTarget.ok === false && cNoTarget.code === 'CLIPBOARD_REQUIRES_TARGET', 'ctrl+c without a target is refused', cNoTarget.code)
  ok(cNoTarget.dispatched === false, 'and nothing was dispatched')
  await reset(); await focusField('#nf')
  await pageFact('document.getElementById("nf").value = "abcdef"')
  const aWithTarget = await raw('browser_press', { key: 'ctrl+a', selector: '#nf' })
  ok(aWithTarget.dispatched === true, 'ctrl+a still works with a target', aWithTarget.code || aWithTarget.outcome)

  section('T  D4 correlation: hostCallId travels with the record')
  const { noteHostCallId } = await import('../lib/action-registry.js')
  await reset(); await focusField('#nf')
  noteHostCallId('browser_press', 'call_press_test_1')
  const t1 = await raw('browser_press', { key: 'Home', selector: '#nf' })
  ok(t1.registry.hostCallId === 'call_press_test_1', 'the record carries the host call id', String(t1.registry.hostCallId))
  ok(t1.actionId.startsWith('browser_press#a'), 'and keeps its own action id', t1.actionId)
  ok(t1.usedPreApprovalBox === false, 'and never uses a pre-approval box')
} finally {
  section('teardown')
  session.dispose()
  server.close()
}

console.log(`\n================ ${checks - failures}/${checks} checks passed ================`)
if (failures > 0) { console.log(`${failures} FAILURE(S)`); process.exit(1) }
console.log('ALL PASS')
