// Integration test for browser_click (2026-10-16).
//
// THE CHAIN UNDER TEST:
//   OBSERVE -> RESOLVE -> CAPTURE IDENTITY -> [APPROVAL BOUNDARY] -> RE-OBSERVE -> REVALIDATE -> EXECUTE -> VERIFY
//
// HOW THE BOUNDARY IS REACHED DETERMINISTICALLY. An earlier version simulated the approval window by
// racing a mutation against the tool's own async work. That produced a test that passed or failed
// depending on how the event loop happened to interleave — twice giving different totals for identical
// code — which is worthless as evidence. The boundary is now supplied through `BROWSER_TEST_BOUNDARY`,
// a Symbol key that a JSON tool call cannot express, so the mutation always lands after the identity is
// captured and before the post-approval observation. The sequence is fixed by construction:
//
//   CAPTURE -> [hook mutates the page] -> RE-OBSERVE -> REVALIDATE -> EXECUTE -> VERIFY
//
// A REAL HTTP SERVER IS USED, not `data:` URLs, so clicking can navigate and fixtures have a stable
// address. Every assertion is about observed browser behaviour.

import http from 'node:http'
import os from 'node:os'
import { join } from 'node:path'
import { BrowserSession } from '../lib/browser-session.js'
import { registerBrowserTools, BROWSER_TEST_BOUNDARY } from '../lib/browser-tools.js'
import { ActionRegistry } from '../lib/action-registry.js'

const PORT = Number(process.env.CU_BROWSER_PORT || 9344)
const HTTP_PORT = Number(process.env.CU_HTTP_PORT || 8791)
const PROFILE = join(os.tmpdir(), `cu-browser-click-profile-${PORT}`)

let failures = 0
let checks = 0
const ok = (cond, label, detail) => {
  checks++
  if (cond) console.log(`  PASS  ${label}`)
  else { failures++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`) }
}
const section = (t) => console.log(`\n--- ${t} ---`)

// ---------------------------------------------------------------------------------------------
// Fixture server. `window.__mutate(name)` lets the boundary hook change the DOM at the exact moment an
// approval decision would occupy.
// ---------------------------------------------------------------------------------------------
const MAIN = `<!doctype html><html><head><meta charset="utf-8"><title>Click Fixture</title></head><body>
<h1>Click fixture</h1>
<button id="test-click" data-state="off">Click</button>
<p id="result">not clicked</p>
<div id="host"></div>
<script>
  document.getElementById('test-click').addEventListener('click', function () {
    this.setAttribute('data-state', 'on');
    document.getElementById('result').textContent = 'clicked';
    document.title = 'Click Fixture - CLICKED';
  });
  window.__mutate = function (name) {
    var btn = document.getElementById('test-click');
    if (name === 'move') { btn.style.marginLeft = '420px'; btn.style.marginTop = '260px'; }
    else if (name === 'recreate') { var c = btn.cloneNode(true); btn.replaceWith(c); }
    else if (name === 'remove') { btn.remove(); }
    else if (name === 'duplicate-with-id') { var d = btn.cloneNode(true); document.getElementById('host').appendChild(d); }
    else if (name === 'duplicate-by-name') {
      var e = document.createElement('button'); e.textContent = 'Click'; e.setAttribute('data-state', 'off');
      document.getElementById('host').appendChild(e);
    }
    else if (name === 'rename') { btn.textContent = 'Renamed action'; btn.setAttribute('aria-label', 'Renamed action'); }
    else if (name === 'disable') { btn.disabled = true; }
    else if (name === 'hide') { btn.style.display = 'none'; }
    else if (name === 'replace-same') { var f = btn.cloneNode(true); btn.replaceWith(f); }
    else if (name === 'replace-different') {
      var g = document.createElement('button'); g.id = 'test-click'; g.textContent = 'A different action';
      btn.replaceWith(g);
    }
    return document.querySelectorAll('button').length;
  };
</script></body></html>`

const PAGES = {
  '/': MAIN,
  '/invalid': '<!doctype html><title>Invalid</title><p>nothing clickable here</p>',
  '/two': '<!doctype html><html><head><title>Two buttons</title></head><body><button id="a">Same</button><button id="b">Same</button></body></html>',
  // Two identical buttons with NO ids and no distinguishing selector: the only identity available is
  // role + accessible name, which is exactly the path that must report ambiguity.
  '/two-nameless': '<!doctype html><html><head><title>Two nameless</title></head><body><button>Click</button><button>Click</button></body></html>',
  '/three-nameless': '<!doctype html><html><head><title>Three nameless</title></head><body><button>Click</button><button>Click</button><button>Click</button></body></html>',
  '/self-destruct': '<!doctype html><html><head><title>Self destruct</title></head><body><button id="boom">Boom</button><script>document.getElementById("boom").addEventListener("click",function(){this.remove()})</script></body></html>',
}

const server = http.createServer((req, res) => {
  const path = req.url.split('?')[0]
  const body = PAGES[path]
  if (!body) { res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>404 Not Found</title><p>no such page'); return }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body)
})
await new Promise(r => server.listen(HTTP_PORT, '127.0.0.1', r))
const URL_ = (p) => `http://127.0.0.1:${HTTP_PORT}${p}`

const session = new BrowserSession({ port: PORT, profileDir: PROFILE, headless: true, log: () => {} })
const registry = new ActionRegistry({ log: () => {} })
const tools = new Map()
registerBrowserTools({ session, registry, log: () => {}, defineTool: (d) => d, register: (d) => tools.set(d.name, d) })
const raw = (name, args) => tools.get(name).execute(args, { signal: undefined })

const pageFact = async (expr) => {
  const r = await session.send('Runtime.evaluate', { expression: expr, returnByValue: true })
  return r && r.result ? r.result.value : undefined
}

/** Click with a mutation scheduled at the approval boundary. */
const clickAtBoundary = async (mutationName, args, observedButtonsAfter) => {
  const boundary = async () => {
    await pageFact(`window.__mutate(${JSON.stringify(mutationName)})`)
    if (observedButtonsAfter) {
      const n = await pageFact('document.querySelectorAll("button").length')
      observedButtonsAfter.buttons = n
    }
  }
  return raw('browser_click', { ...args, [BROWSER_TEST_BOUNDARY]: boundary })
}
const clickPlain = (args) => raw('browser_click', args)

try {
  section('C0  setup')
  const e = await session.ensure()
  ok(e.ok === true, 'browser available', e.reason)
  const a = await session.attach()
  ok(a.ok === true, 'attached', a.reason)
  const nav = await raw('browser_navigate', { url: URL_('/'), expectTitleIncludes: 'Click Fixture' })
  ok(nav.ok === true, 'fixture loaded', JSON.stringify(nav.problems))

  // =============================================================================================
  section('A/L  a normal click is VERIFIED by re-observing the page')
  const obs = await raw('browser_observe', {})
  const btn = obs.interactive.find(x => x.selector === '#test-click')
  ok(Boolean(btn), 'the unique button was observed')
  ok(btn.selectorUnique === true, 'its selector was proved unique')
  const c1 = await clickPlain({ selector: '#test-click' })
  ok(c1.ok === true, 'the click verified', JSON.stringify({ outcome: c1.outcome, problems: c1.problems }))
  ok(c1.usedPreApprovalBox === false, 'the action states it did NOT use a pre-approval box')
  ok((await pageFact('document.getElementById("test-click").getAttribute("data-state")')) === 'on', 'the page really changed')
  ok(c1.registry.state === 'VERIFIED', 'registry recorded VERIFIED', c1.registry.state)
  ok(c1.registry.dispatches === 1, 'exactly one dispatch')

  section('B  a target that does not exist is refused before dispatch')
  const c2 = await clickPlain({ selector: '#no-such-button' })
  ok(c2.ok === false && c2.code === 'TARGET_NOT_FOUND', 'refused with TARGET_NOT_FOUND', c2.code)
  ok(c2.dispatched === false, 'nothing was dispatched')

  section('D  a disabled target is refused')
  await raw('browser_navigate', { url: URL_('/'), allowSameUrl: true })
  await pageFact('document.getElementById("test-click").disabled = true')
  const c4 = await clickPlain({ selector: '#test-click' })
  ok(c4.ok === false && c4.code === 'TARGET_DISABLED', 'refused with TARGET_DISABLED', c4.code)
  ok(c4.dispatched === false, 'nothing was dispatched')
  await pageFact('document.getElementById("test-click").disabled = false')

  section('E  a hidden target is refused')
  await pageFact('document.getElementById("test-click").style.display = "none"')
  const c5 = await clickPlain({ selector: '#test-click' })
  ok(c5.ok === false && (c5.code === 'TARGET_INVISIBLE' || c5.code === 'TARGET_NOT_FOUND'), 'refused', c5.code)
  ok(c5.dispatched === false, 'nothing was dispatched')
  await pageFact('document.getElementById("test-click").style.display = ""')

  // =============================================================================================
  section('C  selector ambiguity with two identical buttons')
  await raw('browser_navigate', { url: URL_('/two') })
  const c3 = await clickPlain({ role: 'button', name: 'Same' })
  ok(c3.ok === false && c3.code === 'AMBIGUOUS', 'refused with AMBIGUOUS', c3.code)
  ok(c3.outcome === 'not-dispatched', 'nothing was dispatched', c3.outcome)
  ok(Array.isArray(c3.alternatives) && c3.alternatives.length > 0, 'the alternatives are listed')

  section('C7  role+name ambiguity when NO unique selector exists')
  await raw('browser_navigate', { url: URL_('/two-nameless') })
  const c7a = await clickPlain({ role: 'button', name: 'Click' })
  ok(c7a.ok === false, 'two identical nameless buttons are refused', JSON.stringify({ ok: c7a.ok, code: c7a.code }))
  ok(c7a.code === 'AMBIGUOUS', 'reported as AMBIGUOUS', c7a.code)
  ok(c7a.dispatched === false, 'and NOTHING was dispatched')

  await raw('browser_navigate', { url: URL_('/three-nameless') })
  const c7b = await clickPlain({ role: 'button', name: 'Click' })
  ok(c7b.ok === false && c7b.code === 'AMBIGUOUS', 'three identical buttons are refused', c7b.code)
  ok(c7b.dispatched === false, 'and NOTHING was dispatched')

  section('C7b  revalidation of a STRUCTURAL identity reports ambiguity (pure rule, no timing)')
  // WHY THIS IS ASSERTED AGAINST `revalidateIdentity` DIRECTLY. The boundary case needs an identity that
  // carries NO selector, and a selector-less identity cannot be produced by the click tool at all: phase
  // 1 REFUSES any target without a uniquely proved selector (`NO_STABLE_SELECTOR`). So the boundary
  // variant of this scenario is unreachable by construction — which is itself the strongest form of the
  // guarantee — and the rule that still needs proving is that revalidation, given a structural identity
  // and a live page with two matches, refuses rather than choosing one.
  const { revalidateIdentity } = await import('../lib/browser-actions.js')
  const structuralObs = {
    ok: true, url: 'http://x/', title: 't',
    interactive: [
      { selector: 'body > button:nth-of-type(1)', selectorUnique: true, role: 'button', name: 'Click', text: 'Click', visible: true, disabled: false },
      { selector: 'body > button:nth-of-type(2)', selectorUnique: true, role: 'button', name: 'Click', text: 'Click', visible: true, disabled: false },
    ],
  }
  const rv1 = revalidateIdentity(structuralObs, { selector: null, role: 'button', name: 'Click' })
  ok(rv1.ok === false, 'a structural identity with two live matches is refused')
  ok(rv1.code === 'AMBIGUOUS', 'reported as AMBIGUOUS', rv1.code)

  const singleObs = { ok: true, url: 'http://x/', title: 't', interactive: [structuralObs.interactive[0]] }
  const rv2 = revalidateIdentity(singleObs, { selector: null, role: 'button', name: 'Click' })
  ok(rv2.ok === true, 'with exactly one match it is accepted', JSON.stringify(rv2.checks))

  const noMatchObs = { ok: true, url: 'http://x/', title: 't', interactive: [] }
  const rv3 = revalidateIdentity(noMatchObs, { selector: null, role: 'button', name: 'Click' })
  ok(rv3.ok === false && rv3.code === 'TARGET_NOT_FOUND', 'with no match it is TARGET_NOT_FOUND', rv3.code)

  const rv4 = revalidateIdentity(structuralObs, { selector: '#gone' })
  ok(rv4.ok === false && rv4.code === 'TARGET_NOT_FOUND', 'a selector that matches nothing after approval is refused', rv4.code)

  section('C7c  a duplicate appearing AT THE BOUNDARY is seen when the identity is selector-based')
  await raw('browser_navigate', { url: URL_('/') })
  const seenAfter = {}
  const c7c = await clickAtBoundary('duplicate-by-name', { role: 'button', name: 'Click' }, seenAfter)
  ok(seenAfter.buttons === 2, 'the fixture really produced a second button at the boundary', seenAfter.buttons)
  // The identity here IS selector-based (#test-click), so the duplicate does not make THAT selector
  // ambiguous — revalidation accepts it, which is correct. What must not happen is a silent claim of
  // success: the click goes to the re-proved original.
  ok(c7c.dispatched === true, 'the click was dispatched against the re-proved original', JSON.stringify({ ok: c7c.ok, code: c7c.code }))
  ok(c7c.selector === '#test-click', 'and the selector used is the one that was re-proved', c7c.selector)

  // =============================================================================================
  section('G1  the button MOVED at the boundary — re-located, never clicked by the old box')
  await raw('browser_navigate', { url: URL_('/'), allowSameUrl: true })
  const boxBefore = await pageFact('JSON.stringify(document.getElementById("test-click").getBoundingClientRect())')
  const c6 = await clickAtBoundary('move', { selector: '#test-click' })
  const boxAfter = await pageFact('JSON.stringify(document.getElementById("test-click").getBoundingClientRect())')
  ok(boxBefore !== boxAfter, 'the button really moved at the boundary')
  ok(c6.ok === true, 'the click succeeded (same target, re-located)', JSON.stringify(c6.problems))
  ok(c6.usedPreApprovalBox === false, 'and it did not use the pre-approval box')
  ok((await pageFact('document.getElementById("test-click").getAttribute("data-state")')) === 'on', 'the click landed on the moved button')

  section('G2  the button node was RE-CREATED with the same identity — accepted, and faithfully reported')
  await raw('browser_navigate', { url: URL_('/'), allowSameUrl: true })
  const c8 = await clickAtBoundary('recreate', { selector: '#test-click' })
  // THE EXPECTATION HERE IS DELIBERATELY NOT "ok". `cloneNode` does NOT copy event listeners, so the
  // replacement button has no click handler at all. The revalidation correctly accepts it — the
  // selector, role and name all still identify the same control — and the click is dispatched. What must
  // then happen is that VERIFY notices the page did not change and reports `unknown` rather than
  // claiming success. That is the property under test, and an earlier version of this test asserted
  // `ok: true`, which would have been asserting that a dead button counts as a working one.
  ok(c8.dispatched === true, 'the re-created node was accepted and the click dispatched', JSON.stringify({ ok: c8.ok, code: c8.code }))
  ok(c8.ok === false && c8.outcome === 'unknown', 'but VERIFY reports unknown because nothing changed', `${c8.outcome}`)
  ok(c8.registry.state === 'UNKNOWN', 'and the registry records UNKNOWN', c8.registry.state)

  section('G3  the button was REMOVED at the boundary — REFUSED')
  await raw('browser_navigate', { url: URL_('/'), allowSameUrl: true })
  const c9 = await clickAtBoundary('remove', { selector: '#test-click' })
  ok(c9.ok === false && c9.code === 'TARGET_NOT_FOUND', 'refused with TARGET_NOT_FOUND', c9.code)
  ok(c9.dispatched === false, 'and NOTHING was dispatched')

  section('G5  the button was RENAMED at the boundary — REFUSED as a different identity')
  await raw('browser_navigate', { url: URL_('/'), allowSameUrl: true })
  const c10 = await clickAtBoundary('rename', { selector: '#test-click' })
  ok(c10.ok === false && c10.code === 'TARGET_CHANGED', 'refused with TARGET_CHANGED', `${c10.code}: ${c10.reason}`)
  ok(c10.dispatched === false, 'and NOTHING was dispatched')

  section('Q  selector uniqueness changed at the boundary (id removed)')
  await raw('browser_navigate', { url: URL_('/'), allowSameUrl: true })
  const boundaryDropId = async () => { await pageFact('document.getElementById("test-click").removeAttribute("id")') }
  const c11 = await raw('browser_click', { selector: '#test-click', [BROWSER_TEST_BOUNDARY]: boundaryDropId })
  ok(c11.ok === false, 'the click did not succeed')
  ok(c11.code === 'TARGET_NOT_FOUND' || c11.code === 'AMBIGUOUS', 'the selector no longer proves', c11.code)
  ok(c11.dispatched === false, 'and NOTHING was dispatched')

  // ---------------------------------------------------------------------------------------------
  section('C6  DISABLED at the boundary must be REFUSED even though selector/role/name still match')
  await raw('browser_navigate', { url: URL_('/'), allowSameUrl: true })
  const c12 = await clickAtBoundary('disable', { selector: '#test-click' })
  ok(c12.ok === false, 'the click did not succeed', JSON.stringify({ ok: c12.ok, code: c12.code, outcome: c12.outcome }))
  ok(c12.code === 'TARGET_DISABLED', 'refused with TARGET_DISABLED', c12.code)
  ok(c12.dispatched === false, 'and NOTHING was dispatched')
  ok(c12.registry.state !== 'VERIFIED', 'the registry did not record success', c12.registry.state)

  section('C6b  HIDDEN at the boundary must be REFUSED even though selector/role/name still match')
  await raw('browser_navigate', { url: URL_('/'), allowSameUrl: true })
  const c13 = await clickAtBoundary('hide', { selector: '#test-click' })
  ok(c13.ok === false, 'the click did not succeed', JSON.stringify({ ok: c13.ok, code: c13.code, outcome: c13.outcome }))
  ok(c13.code === 'TARGET_INVISIBLE' || c13.code === 'TARGET_NOT_FOUND', 'refused as invisible', c13.code)
  ok(c13.dispatched === false, 'and NOTHING was dispatched')

  section('P-case2  replaced by a DIFFERENT control that reuses the same selector')
  await raw('browser_navigate', { url: URL_('/'), allowSameUrl: true })
  const c14 = await clickAtBoundary('replace-different', { selector: '#test-click' })
  ok(c14.ok === false, 'the click did not succeed', JSON.stringify({ ok: c14.ok, code: c14.code }))
  ok(c14.code === 'TARGET_CHANGED', 'refused as TARGET_CHANGED', `${c14.code}: ${c14.reason}`)
  ok(c14.dispatched === false, 'and NOTHING was dispatched')

  // =============================================================================================
  section('M  a click that navigates is verified by the URL, not by the dispatch')
  await raw('browser_navigate', { url: URL_('/') })
  await pageFact('document.getElementById("test-click").addEventListener("click", function () { location.href = "/invalid"; })')
  const c15 = await raw('browser_click', { selector: '#test-click', expectUrlIncludes: '/invalid' })
  ok(c15.ok === true, 'the navigating click verified via the URL', JSON.stringify(c15.problems))
  ok(String(c15.url).includes('/invalid'), 'the observed URL moved')

  section('K/O  an action can never be dispatched twice')
  await raw('browser_navigate', { url: URL_('/') })
  const c16 = await clickPlain({ selector: '#test-click' })
  const before = c16.registry.dispatches
  ok(registry.beginDispatch(c16.actionId).ok === false, 'a second dispatch on the same action is refused')
  ok(registry.get(c16.actionId).dispatches === before, 'the counter did not advance')
  ok(before <= 1, 'dispatches never exceeds 1')

  section('N  cancellation is terminal for dispatch')
  const cancelled = registry.create('browser_click', { args: {} })
  registry.beginDispatch(cancelled.id)
  registry.transition(cancelled.id, 'CANCELLED', 'test')
  ok(registry.beginDispatch(cancelled.id).ok === false, 'a CANCELLED action cannot be dispatched')
  ok(registry.get(cancelled.id).state === 'CANCELLED', 'and stays cancelled (no auto-recovery)')

  section('O2  a VERIFIED action cannot be executed again')
  const done = registry.create('browser_click', { args: {} })
  registry.beginDispatch(done.id)
  registry.transition(done.id, 'VERIFIED', 'test')
  ok(registry.beginDispatch(done.id).ok === false, 'a VERIFIED action is refused')

  section('N2  a self-removing button is a verifiable, single click')
  await raw('browser_navigate', { url: URL_('/self-destruct') })
  const boom = await clickPlain({ selector: '#boom' })
  ok(boom.ok === true, 'the click verified', JSON.stringify({ outcome: boom.outcome, problems: boom.problems }))
  ok((await pageFact('document.querySelector("#boom") === null')) === true, 'and the button really removed itself')

  // =============================================================================================
  section('J  UNKNOWN: the connection dies while the click is in flight')
  await raw('browser_navigate', { url: URL_('/') })
  const inflight = clickPlain({ selector: '#test-click' })
  await new Promise(r => setTimeout(r, 25))
  session.connection.close()
  const lost = await inflight
  ok(lost.ok === false, 'the click did not claim success', JSON.stringify({ outcome: lost.outcome, code: lost.code }))
  ok(lost.outcome === 'unknown', 'the outcome is UNKNOWN', `${lost.outcome} / ${lost.code}`)
  ok(lost.registry.state === 'UNKNOWN', 'the registry recorded UNKNOWN', lost.registry.state)
  ok(registry.beginDispatch(lost.actionId).ok === false, 'an UNKNOWN click can never be replayed')

  // =============================================================================================
  section('C5  a connection lost during the POST-APPROVAL observation is UNKNOWN, not FAILED')
  await session.attach()
  await raw('browser_navigate', { url: URL_('/') })
  const boundaryKill = async () => { session.connection.close() }
  const c17 = await raw('browser_click', { selector: '#test-click', [BROWSER_TEST_BOUNDARY]: boundaryKill })
  ok(c17.ok === false, 'the click did not claim success')
  ok(c17.outcome === 'unknown', 'a lost connection after the target was captured is UNKNOWN', `${c17.outcome} / ${c17.code}`)
  ok(c17.dispatched === false, 'and nothing was dispatched', c17.dispatched)
  ok(c17.registry.state === 'UNKNOWN', 'the registry recorded UNKNOWN', c17.registry.state)
  ok(registry.beginDispatch(c17.actionId).ok === false, 'and it can never be replayed')
} finally {
  section('teardown')
  session.dispose()
  server.close()
}

console.log(`\n================ ${checks - failures}/${checks} checks passed ================`)
if (failures > 0) { console.log(`${failures} FAILURE(S)`); process.exit(1) }
console.log('ALL PASS')
