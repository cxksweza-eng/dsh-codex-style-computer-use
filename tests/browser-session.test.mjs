// Integration test for the browser session layer (2026-10-16).
//
// THIS IS A REAL BROWSER TEST, not a stub test. It launches a headless Chromium (Edge) with a
// dedicated profile on a non-default port, drives it over CDP, and tears it down. Every assertion is
// about observed browser behaviour, because a browser layer that passes against a fake socket proves
// nothing about the real protocol.
//
// Run: node browser-session.test.mjs

import os from 'node:os'
import { join } from 'node:path'
import { BrowserSession } from 'file:///C:/Users/liu/Documents/deepseek-harness/default-workspace/cu-release/lib/browser-session.js'

const PORT = 9334   // deliberately not 9222: never fight with a browser the user has open
const PROFILE = join(os.tmpdir(), 'cu-browser-test-profile')

let failures = 0
let checks = 0
const ok = (cond, label, detail) => {
  checks++
  if (cond) console.log(`  PASS  ${label}`)
  else { failures++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`) }
}
const section = (t) => console.log(`\n--- ${t} ---`)

const session = new BrowserSession({ port: PORT, profileDir: PROFILE, headless: true, autoLaunch: true, log: () => {} })

try {
  // -------------------------------------------------------------------------------------------
  section('S1  ensure() launches and connects')
  const s1 = await session.ensure()
  ok(s1.ok === true, 'ensure succeeded', s1.reason)
  ok(s1.listening === true, 'an endpoint is listening')
  ok(typeof s1.browser === 'string' && s1.browser.length > 0, 'the browser identifies itself', s1.browser)
  ok(s1.ownsBrowser === true, 'the session knows it launched this browser')

  const s1b = await session.ensure()
  ok(s1b.ok === true && s1b.launched === false && s1b.alreadyRunning === true,
    'a second ensure() reuses the RUNNING browser (does not launch another)',
    `launched=${s1b.launched} alreadyRunning=${s1b.alreadyRunning} connected=${session.connected} targetId=${session.targetId}`)
  ok(s1b.attached === false && session.connected === false,
    'ensure() alone does NOT attach a page (that is attach()\u2019s job)')

  // -------------------------------------------------------------------------------------------
  section('S2  tabs() reports page targets')
  const tabs = await session.tabs()
  ok(Array.isArray(tabs), 'tabs() returns an array')
  ok(tabs.length >= 1, `at least one page target (${tabs && tabs.length})`)
  ok(tabs[0].attachable === true, 'the default page is attachable')

  // -------------------------------------------------------------------------------------------
  section('S3  attach() binds a page and enables the domains')
  const a = await session.attach()
  ok(a.ok === true, 'attach succeeded', a.reason)
  ok(a.target && a.target.id === session.targetId, 'the session records the attached target id')
  ok(Array.isArray(a.enableErrors) === false, 'every required domain enabled without error', JSON.stringify(a.enableErrors))

  const a2 = await session.attach()
  ok(a2.ok === true && a2.reused === true, 're-attaching the same target reuses the socket')

  // -------------------------------------------------------------------------------------------
  section('S4  navigation and page identity come from the browser')
  const NAV_URL = 'data:text/html,<title>CU Browser Test</title><h1 id="h">hello</h1>'
  const nav = await session.send('Page.navigate', { url: NAV_URL })
  ok(nav && typeof nav.frameId === 'string', 'Page.navigate returned a frameId')
  await new Promise(r => setTimeout(r, 700))

  const page = await session.currentPage()
  ok(page !== null, 'currentPage() answers after navigation')
  ok(page.title === 'CU Browser Test', 'the title is read from the browser', page && page.title)
  ok(page.url.startsWith('data:text/html'), 'the url is read from the browser', page && page.url)

  // -------------------------------------------------------------------------------------------
  section('S5  the DOM is reachable through the session')
  const dom = await session.send('Runtime.evaluate', {
    expression: 'document.getElementById("h").textContent', returnByValue: true,
  })
  ok(dom && dom.result && dom.result.value === 'hello', 'the element text was read', JSON.stringify(dom && dom.result))

  const acc = await session.send('Accessibility.getFullAXTree', {})
  ok(acc && Array.isArray(acc.nodes) && acc.nodes.length > 0, `the accessibility tree is available (${acc && acc.nodes && acc.nodes.length} nodes)`)

  // -------------------------------------------------------------------------------------------
  section('S6  status() reports the live facts')
  const st = await session.status()
  ok(st.listening === true && st.connected === true, 'status reports listening and connected')
  ok(st.ownsBrowser === true, 'status reports plugin ownership')
  ok(st.targetId === session.targetId, 'status reports the attached target')

  // -------------------------------------------------------------------------------------------
  section('S7  a detached connection is a FACT, not a silent retry')
  session.detach()
  ok(session.connected === false, 'detach() clears the connection')
  let err = null
  try { await session.send('Browser.getVersion') } catch (e) { err = e }
  ok(err !== null && err.disconnected === true, 'sending after detach refuses as disconnected', err && err.message)

  // -------------------------------------------------------------------------------------------
  section('S8  re-attach after detach works (no stale handle survives)')
  const a3 = await session.attach()
  ok(a3.ok === true, 'attach() succeeds again after detach', a3.reason)
  const v2 = await session.send('Browser.getVersion')
  ok(v2 && typeof v2.product === 'string', 'the connection is usable again', v2 && v2.product)

  // -------------------------------------------------------------------------------------------
  section('S9  a target that vanished is reported, not faked')
  const bad = await session.attach({ targetId: 'no-such-target-id' })
  ok(bad.ok === false, 'attaching to an unknown target fails')
  ok(Array.isArray(bad.available), 'the failure lists the targets that DO exist')
} finally {
  section('S10 teardown')
  const closed = session.stopLaunched()
  ok(closed.closed === true, 'the session closed the browser it launched')
  ok(session.connected === false, 'the session is disconnected after teardown')
  session.dispose()
}

console.log(`\n================ ${checks - failures}/${checks} checks passed ================`)
if (failures > 0) { console.log(`${failures} FAILURE(S)`); process.exit(1) }
console.log('ALL PASS')
