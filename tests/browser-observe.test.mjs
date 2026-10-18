// Integration test for browser observation (2026-10-16).
//
// REAL BROWSER, REAL DOM. The fixture page below is served through a `data:` URL so the test needs no
// network and cannot be affected by a site changing under it. Every check is about what the
// observation actually returned, not about the collector script existing.
//
// The two properties under test are the ones a later click depends on:
//   1. an element's reported selector is UNIQUE, so revalidation cannot silently pick a sibling;
//   2. an ambiguous target is REPORTED as ambiguous rather than resolved by guessing.

import os from 'node:os'
import { join } from 'node:path'
import { BrowserSession } from '../lib/browser-session.js'
import { observePage, matchTarget } from '../lib/browser-observe.js'

const PORT = 9337
const PROFILE = join(os.tmpdir(), 'cu-browser-observe-profile')

const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><title>CU Observe Fixture</title></head><body>
<h1>Fixture page</h1>
<nav><a id="nav-home" href="https://example.invalid/home">Home</a></nav>
<main>
  <button id="btn-save" name="save">Save</button>
  <button id="btn-cancel">Cancel</button>
  <button id="btn-disabled" disabled>Disabled action</button>
  <div id="ghost" style="display:none"><button id="btn-hidden">Hidden button</button></div>
  <button aria-label="Close dialog">X</button>
  <form id="f1" action="/submit" method="post">
    <label for="email">Email address</label>
    <input id="email" name="email" type="email" placeholder="you@example.com">
    <label for="pw">Password</label>
    <input id="pw" name="pw" type="password" value="SUPERSECRET">
    <select id="pick" name="pick"><option>one</option><option>two</option></select>
    <textarea id="note" name="note"></textarea>
    <input type="submit" value="Send form">
  </form>
  <p id="body-text">Some body text for reading.</p>
</main></body></html>`

const DATA_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(FIXTURE)

let failures = 0
let checks = 0
const ok = (cond, label, detail) => {
  checks++
  if (cond) console.log(`  PASS  ${label}`)
  else { failures++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`) }
}
const section = (t) => console.log(`\n--- ${t} ---`)

const session = new BrowserSession({ port: PORT, profileDir: PROFILE, headless: true, log: () => {} })

try {
  section('O1  attach and navigate to the fixture')
  const e = await session.ensure()
  ok(e.ok === true, 'browser available', e.reason)
  const a = await session.attach()
  ok(a.ok === true, 'attached', a.reason)
  await session.send('Page.navigate', { url: DATA_URL })
  await new Promise(r => setTimeout(r, 800))

  section('O2  observePage returns structure, not pixels')
  const obs = await observePage(session, { limit: 500 })
  ok(obs.ok === true, 'observation succeeded', obs.reason)
  ok(obs.title === 'CU Observe Fixture', 'title read', obs.title)
  ok(obs.url.startsWith('data:text/html'), 'url read')
  ok(obs.stable === true, 'observation is self-consistent (url matched at the end)')
  ok(typeof obs.bodyText === 'string' && obs.bodyText.includes('Some body text'), 'body text captured')
  ok(obs.counts.elements > 5, `element count reported (${obs.counts.elements})`)
  ok(Array.isArray(obs.headings) && obs.headings.some(h => h.text === 'Fixture page'), 'headings captured')
  ok(Array.isArray(obs.forms) && obs.forms.length === 1, `one form captured (${obs.forms && obs.forms.length})`)

  section('O3  interactive elements carry role, name, selectors and boxes')
  const save = obs.interactive.find(x => x.selector === '#btn-save')
  ok(Boolean(save), 'the Save button was observed', JSON.stringify(obs.interactive.map(x => x.selector)))
  ok(save.role === 'button', 'its role is button', save && save.role)
  ok(save.name === 'Save', 'its accessible name is Save', save && save.name)
  ok(save.selectorUnique === true, 'its selector was PROVED unique')
  ok(save.rect.width > 0 && save.rect.height > 0, 'it carries a real bounding box', JSON.stringify(save.rect))
  ok(save.disabled === false, 'it is reported enabled')

  const closeBtn = obs.interactive.find(x => x.name === 'Close dialog')
  ok(Boolean(closeBtn), 'aria-label became the accessible name', JSON.stringify(obs.interactive.map(x => x.name)))

  section('O4  visibility and disabled state are reported, not assumed')
  const hidden = obs.interactive.find(x => x.selector === '#btn-hidden')
  ok(Boolean(hidden), 'the display:none button is still reported')
  ok(hidden.visible === false, 'and it is marked NOT visible')
  const dis = obs.interactive.find(x => x.selector === '#btn-disabled')
  ok(Boolean(dis) && dis.disabled === true, 'the disabled button is marked disabled')

  section('O5  a password field is flagged, and its VALUE is never read')
  const pw = obs.interactive.find(x => x.selector === '#pw')
  ok(Boolean(pw), 'the password input was observed')
  ok(pw.sensitive === true, 'it is flagged sensitive')
  ok(pw.inputType === 'password', 'its input type is reported')
  // SCOPE THE ASSERTION TO WHAT THE COLLECTOR DERIVED FROM ELEMENTS. Two earlier versions of this
  // check were wrong in instructive ways: the first searched the whole envelope and failed while the
  // collector was correct, because the secret sat in the fixture's own `data:` URL; the second still
  // caught `page.url`. A URL is supplied by the TEST, not read out of a field, so it is excluded here
  // on purpose — and the properties that actually matter are asserted separately and directly.
  const derivedFromElements = { headings: obs.headings, interactive: obs.interactive, forms: obs.forms, bodyText: obs.bodyText }
  const flat = JSON.stringify(derivedFromElements)
  ok(!flat.includes('SUPERSECRET'), 'no element-derived field carries the secret value')
  ok(pw.name !== 'SUPERSECRET', 'the password value was not promoted to an accessible name', pw.name)
  ok(!String(pw.name || '').includes('SUPERSECRET'), 'no field of the observed element carries the secret')

  section('O6  labels are used as accessible names')
  const email = obs.interactive.find(x => x.selector === '#email')
  ok(Boolean(email), 'the email input was observed')
  ok(email.name === 'Email address', 'its label became the accessible name', email && email.name)

  section('O7  matchTarget resolves by role + name')
  const m1 = matchTarget(obs, { role: 'button', name: 'Save' })
  ok(m1.ok === true, 'Save resolves', m1.reason)
  ok(m1.match.selector === '#btn-save', 'to the right element', m1.match && m1.match.selector)
  ok(m1.ambiguous === false, 'unambiguously')

  const m2 = matchTarget(obs, { role: 'link', name: 'Home' })
  ok(m2.ok === true && m2.match.href && m2.match.href.includes('/home'), 'a link resolves with its href', JSON.stringify(m2.match && m2.match.href))

  const m3 = matchTarget(obs, { name: 'Cancel' })
  ok(m3.ok === true && m3.match.selector === '#btn-cancel', 'name alone is enough')

  const m4 = matchTarget(obs, { selector: '#email' })
  ok(m4.ok === true && m4.match.inputType === 'email', 'an explicit selector resolves')

  section('O8  ambiguity is REPORTED, never silently resolved')
  // Both buttons contain the letter "e"; a substring name match on a shared fragment must not pretend
  // to be a unique hit.
  const m5 = matchTarget(obs, { role: 'button', name: 'e' })
  ok(m5.ok === true, 'a broad name still produces candidates')
  ok(m5.ambiguous === true, 'and it is flagged ambiguous', `matches=${m5.matches}`)
  ok(Array.isArray(m5.alternatives) && m5.alternatives.length > 0, 'alternatives are listed for the caller')

  const m6 = matchTarget(obs, { role: 'button', name: 'NoSuchButtonAnywhere' })
  ok(m6.ok === false, 'a target that does not exist resolves to nothing', m6.reason)

  const m7 = matchTarget(obs, { selector: '#not-present' })
  ok(m7.ok === false, 'an explicit selector that matched nothing returns no match')

  section('O9  a match on a hidden element is marked, not filtered away silently')
  const m8 = matchTarget(obs, { role: 'button', name: 'Hidden button' })
  ok(m8.ok === true, 'the hidden button can still be located')
  ok(m8.why.includes('invisible'), 'and the match says it is invisible', JSON.stringify(m8.why))

  const m9 = matchTarget(obs, { role: 'button', name: 'Disabled action' })
  ok(m9.ok === true && m9.why.includes('disabled'), 'a disabled match says so', JSON.stringify(m9.why))

  section('O10  observation reflects DOM changes (no cache)')
  await session.send('Runtime.evaluate', { expression: 'document.getElementById("btn-save").textContent = "Saved!"' })
  const obs2 = await observePage(session, { limit: 500 })
  const save2 = obs2.interactive.find(x => x.selector === '#btn-save')
  ok(save2 && save2.name === 'Saved!', 'the second observation sees the new text', save2 && save2.name)

  section('O11  observing a detached session is refused')
  session.detach()
  const obs3 = await observePage(session, {})
  ok(obs3.ok === false && /not attached/i.test(obs3.reason), 'observation refuses without a page', obs3.reason)
} finally {
  section('O12 teardown')
  session.dispose()
  ok(true, 'session disposed')
}

console.log(`\n================ ${checks - failures}/${checks} checks passed ================`)
if (failures > 0) { console.log(`${failures} FAILURE(S)`); process.exit(1) }
console.log('ALL PASS')
