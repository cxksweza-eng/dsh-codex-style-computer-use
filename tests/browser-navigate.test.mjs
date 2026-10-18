// Integration test for browser_navigate (2026-10-16).
//
// REAL BROWSER. A headless Edge is launched on a private port and driven through the actual tool
// surface (`registerBrowserTools` -> `execute`), not by calling `navigate()` directly, so the registry
// wrapper, the idempotency claim and the terminal-state mapping are all exercised.
//
// THE ASSERTION THAT MATTERS MOST: success is never inferred from `Page.navigate`. Every success case
// here also proves that something OBSERVED confirmed it, and the failure cases prove that an
// unconfirmable navigation is reported as such instead of being assumed to have worked.

import os from 'node:os'
import { join } from 'node:path'
import { BrowserSession } from 'file:///C:/Users/liu/Documents/deepseek-harness/default-workspace/cu-release/lib/browser-session.js'
import { registerBrowserTools } from 'file:///C:/Users/liu/Documents/deepseek-harness/default-workspace/cu-release/lib/browser-tools.js'
import { ActionRegistry } from 'file:///C:/Users/liu/Documents/deepseek-harness/default-workspace/cu-release/lib/action-registry.js'

const PORT = 9341
const PROFILE = join(os.tmpdir(), 'cu-browser-nav-profile')

let failures = 0
let checks = 0
const ok = (cond, label, detail) => {
  checks++
  if (cond) console.log(`  PASS  ${label}`)
  else { failures++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`) }
}
const section = (t) => console.log(`\n--- ${t} ---`)

const page = (title, body) => 'data:text/html;charset=utf-8,' + encodeURIComponent(
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`)

const HOME = page('CU Nav Home', '<h1>Home</h1><button id="go">Go</button><p id="t">home text</p>')
const OTHER = page('CU Nav Other', '<h1>Other</h1><button id="back">Back</button><p id="t">other text</p>')

const session = new BrowserSession({ port: PORT, profileDir: PROFILE, headless: true, log: () => {} })
const registry = new ActionRegistry({ log: () => {} })
const tools = new Map()
registerBrowserTools({
  session, registry, log: () => {},
  defineTool: (def) => def,
  register: (def) => tools.set(def.name, def),
})
const call = (name, args) => tools.get(name).execute(args, { signal: undefined })

try {
  section('N0  setup: attach a page')
  const e = await session.ensure()
  ok(e.ok === true, 'browser available', e.reason)
  const a = await session.attach()
  ok(a.ok === true, 'attached', a.reason)
  const first = await call('browser_navigate', { url: HOME })
  ok(first.ok === true, 'the fixture loaded', JSON.stringify(first.problems))
  ok(first.actionId && /^browser_navigate#/.test(first.actionId), 'the action carries a registry id', first.actionId)

  // -----------------------------------------------------------------------------------------
  section('A  normal navigation is VERIFIED, not assumed')
  const nav = await call('browser_navigate', { url: OTHER, expectTitleIncludes: 'CU Nav Other' })
  ok(nav.ok === true, 'navigation succeeded', JSON.stringify(nav.problems))
  ok(nav.verified === true, 'verified flag is true')
  ok(nav.outcome === 'applied', 'outcome is applied', nav.outcome)
  ok(Array.isArray(nav.how) && nav.how.some(h => h.includes('readyState=complete')), 'readyState=complete was observed', JSON.stringify(nav.how))
  ok(nav.title === 'CU Nav Other', 'the title was re-observed from the page', nav.title)
  ok(String(nav.url).startsWith('data:text/html'), 'the url was re-observed from the page')
  ok(nav.registry && nav.registry.state === 'VERIFIED', 'the registry recorded VERIFIED', nav.registry && nav.registry.state)
  ok(nav.registry.dispatches === 1, 'exactly one dispatch was recorded', nav.registry && nav.registry.dispatches)

  section('G  navigation VERIFY checks an expected element actually appeared')
  const navEl = await call('browser_navigate', {
    url: HOME, expectElementSelector: '#go', expectTitleEquals: 'CU Nav Home',
  })
  ok(navEl.ok === true, 'navigation with an element expectation succeeded', JSON.stringify(navEl.problems))
  ok(navEl.how.some(h => h.includes('expected element present')), 'the element presence is part of the evidence', JSON.stringify(navEl.how))

  const navMissing = await call('browser_navigate', { url: OTHER, expectElementSelector: '#not-here' })
  ok(navMissing.ok === false, 'an absent expected element FAILS the navigation')
  ok(navMissing.outcome === 'failed', 'and the outcome is failed, not applied', navMissing.outcome)
  ok(navMissing.problems.some(p => p.includes('expected element was not found')), 'with a precise reason', JSON.stringify(navMissing.problems))
  ok(navMissing.registry.state === 'FAILED', 'the registry recorded FAILED', navMissing.registry.state)

  section('B  an unusable URL is refused BEFORE anything is dispatched')
  const before = registry.size
  const bad = await call('browser_navigate', { url: 'http://[not a url' })
  ok(bad.ok === false, 'the bad URL was refused')
  ok(bad.outcome === 'not-dispatched', 'and it was NOT dispatched', bad.outcome)
  ok(bad.dispatched === false, 'dispatched flag is false')
  ok(registry.get(bad.actionId) !== undefined, 'the refused action is still recorded for audit')
  ok(registry.size === before + 1, 'exactly one record was added', `${before} -> ${registry.size}`)

  const empty = await call('browser_navigate', { url: '   ' })
  ok(empty.ok === false && empty.outcome === 'not-dispatched', 'an empty url is refused')

  section('C  a navigation the browser cannot complete is not reported as success')
  // `chrome://settings` is NOT a reliable refusal: Chromium accepts `Page.navigate` to many privileged
  // URLs and a headless instance may or may not render one. An earlier version of this test asserted a
  // refusal and failed against a browser that simply complied. The property under test is narrower and
  // honest: WHATEVER the browser did, the outcome must be consistent with what was observed, and any
  // success must be backed by evidence rather than by the dispatch returning.
  const privileged = await call('browser_navigate', { url: 'chrome://settings' })
  if (privileged.ok) {
    ok(privileged.verified === true && privileged.how.some(h => h.includes('readyState=complete')),
      'a privileged URL that DID load is only accepted with observed evidence', JSON.stringify(privileged.how))
    ok(privileged.registry.state === 'VERIFIED', 'and is recorded VERIFIED', privileged.registry.state)
  } else {
    ok(privileged.outcome === 'failed' || privileged.outcome === 'unknown',
      'a privileged URL that did not load is a definite failure or unknown', privileged.outcome)
    ok(privileged.registry.state === 'FAILED' || privileged.registry.state === 'UNKNOWN',
      'and the registry agrees', privileged.registry.state)
  }

  section('C2  a browser error document is never counted as a successful navigation')
  // The browser reports readyState=complete for its own error page. Treating that as success is the
  // classic "CDP returned fine, so the action worked" mistake, so it is checked explicitly. Port 1 is
  // not on Chromium's unsafe list, so the navigation is genuinely attempted and genuinely fails.
  const notFound = await call('browser_navigate', { url: 'http://127.0.0.1:1/definitely-not-listening' })
  ok(notFound.ok === false, 'a navigation to a dead endpoint did not verify as success',
    JSON.stringify({ outcome: notFound.outcome, title: notFound.title, problems: notFound.problems }))
  ok(notFound.registry.state === 'FAILED' || notFound.registry.state === 'UNKNOWN',
    'and it is not recorded as VERIFIED', notFound.registry.state)

  section('D  re-navigating to the current URL consumes NO dispatch slot (defect D3)')
  await call('browser_navigate', { url: HOME })
  const again = await call('browser_navigate', { url: HOME })
  ok(again.ok === true && again.alreadyThere === true, 'the repeat is reported as already there', JSON.stringify({ ok: again.ok, alreadyThere: again.alreadyThere }))
  ok(again.outcome === 'not-dispatched', 'nothing was dispatched', again.outcome)
  // WHAT CHANGED AND WHY. This used to assert `dispatches === 1`, because the "already there" check ran
  // AFTER `beginDispatch` had claimed the slot: a navigation that sent nothing still spent the action's
  // one dispatch. On the real instance that left the record stuck in EXECUTING — neither terminal nor
  // dispatchable. The check now runs as a `precheck`, before the claim, so the honest expectation is
  // that this no-op consumed NOTHING. Asserting the old value would be asserting the defect.
  ok(again.registry.dispatches === 0, 'and it consumed no dispatch slot at all', again.registry.dispatches)
  ok(again.registry.state !== 'EXECUTING', 'and it is not left dangling in EXECUTING', again.registry.state)

  section('F  a dispatched action can never be dispatched a second time')
  // IDEMPOTENCY IS ABOUT AN ACTION THAT ACTUALLY RAN. A no-op that never claimed the slot is still
  // dispatchable by design (that is the point of the D3 fix), so the replay guard is proven against an
  // action that really dispatched, not against one that had nothing to do.
  const freshNav = await call('browser_navigate', { url: OTHER, expectTitleIncludes: 'CU Nav Other' })
  ok(freshNav.registry.state === 'VERIFIED', 'a completed action reaches VERIFIED', freshNav.registry.state)
  ok(freshNav.registry.dispatches === 1, 'with exactly one dispatch', freshNav.registry.dispatches)
  const claimAgain = registry.beginDispatch(freshNav.actionId)
  ok(claimAgain.ok === false, 'a second dispatch on the same action is refused', JSON.stringify(claimAgain))
  ok(registry.get(freshNav.actionId).dispatches === 1, 'and the dispatch counter never advances past one',
    registry.get(freshNav.actionId).dispatches)
  ok(registry.beginDispatch(freshNav.actionId).ok === false, 'and it stays refused on every later attempt')

  section('E  UNKNOWN outcome is produced when the connection dies mid-action')
  // A REAL disconnect under an in-flight action, not a simulated one. Two details matter and both were
  // wrong in the first version of this test:
  //   * the endpoint must leave the navigation PENDING. `127.0.0.1:9` is refused by Chromium outright
  //     as `net::ERR_UNSAFE_PORT` (port 9 is on its blocked list), so the action finished with a
  //     definite failure before the socket was ever closed — a correct outcome for the wrong reason.
  //     A non-routable address hangs instead, which is the state whose outcome is genuinely unknown.
  //   * the close must land while the action is waiting for the load lifecycle.
  const HANGING = 'http://10.255.255.1/never-answers-here'
  await call('browser_navigate', { url: HOME })
  const inflight = call('browser_navigate', { url: HANGING, timeoutMs: 40_000 })
  await new Promise(r => setTimeout(r, 1200))
  session.connection.close()
  const lost = await inflight
  ok(lost.ok === false, 'the action did not claim success', JSON.stringify({ outcome: lost.outcome, reason: lost.reason, error: lost.error }))
  ok(lost.outcome === 'unknown', 'the outcome is UNKNOWN', lost.outcome)
  ok(lost.registry.state === 'UNKNOWN', 'the registry recorded UNKNOWN', lost.registry.state)
  ok(lost.registry.dispatches === 1, 'exactly one dispatch was recorded before the loss', lost.registry.dispatches)
  const replay = registry.beginDispatch(lost.actionId)
  ok(replay.ok === false, 'an UNKNOWN action cannot be dispatched again', JSON.stringify(replay))

  section('N9  after the loss, the session reports it rather than pretending')
  ok(session.connected === false, 'the session knows it is disconnected')
  const afterLoss = await call('browser_navigate', { url: HOME })
  ok(afterLoss.ok === false, 'further navigation is refused')
  ok(afterLoss.outcome === 'not-dispatched', 'and refused BEFORE dispatch, not as unknown', afterLoss.outcome)

  section('N10 recovery: re-attach and navigate again')
  const reattach = await session.attach()
  ok(reattach.ok === true, 're-attach succeeded', reattach.reason)
  const recovered = await call('browser_navigate', { url: HOME, expectTitleIncludes: 'CU Nav Home' })
  ok(recovered.ok === true, 'navigation works again after recovery', JSON.stringify(recovered.problems))
  ok(recovered.registry.state === 'VERIFIED', 'and is recorded as VERIFIED', recovered.registry.state)
} finally {
  section('N11 teardown')
  session.dispose()
}

console.log(`\n================ ${checks - failures}/${checks} checks passed ================`)
if (failures > 0) { console.log(`${failures} FAILURE(S)`); process.exit(1) }
console.log('ALL PASS')
