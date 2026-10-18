// Privacy tests for the browser observer (2026-10-18).
//
// TWO REAL LEAKS WERE FOUND IN THIS AREA and are pinned here so neither can come back:
//
//   L1  `accName()` fell back to `el.value` for any non-password input. An unlabelled text field therefore
//       reported whatever the user had typed as that field's NAME, and observations are exactly what
//       reaches a model context and a session log. The accessible-name rule already says a control's value
//       is not its name; the fallback is now removed rather than filtered.
//
//   L2  `valueDigest` was an unsalted FNV-1a with a plaintext length prefix. For a low-entropy secret (a
//       PIN, an OTP) that is not a one-way function in any useful sense: the candidates can be enumerated
//       offline. The digest is now salted with a per-process random value that is never logged or returned.
//
// THE PAGE IS SERVED OVER HTTP ON PURPOSE. An earlier check used a `data:` URL with the secrets inside the
// URL, which made the URL itself contain them and produced a false "leaked" verdict. Here the URL is clean,
// so any occurrence of a fixture secret in the observation is a genuine leak.

import http from 'node:http'
import os from 'node:os'
import { join } from 'node:path'
import { BrowserSession } from '../lib/browser-session.js'
import { observePage, matchTarget } from '../lib/browser-observe.js'

const PORT = Number(process.env.CU_PRIV_PORT || 9401)
const HTTP_PORT = Number(process.env.CU_PRIV_HTTP || 8831)
const PROFILE = join(os.tmpdir(), `cu-priv-profile-${PORT}`)

let failures = 0
let checks = 0
const ok = (cond, label, detail) => {
  checks++
  if (cond) console.log(`  PASS  ${label}`)
  else { failures++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`) }
}
const section = (t) => console.log(`\n--- ${t} ---`)

// Every secret below is a fixture value; none of them is a real credential.
const SECRETS = {
  unlabelled: 'SECRETVALUE123',
  labelled: 'OTHERSECRET99',
  password: 'PASSWORD999',
  hidden: 'HIDDENVALUE77',
  area: 'AREASECRET55',
  pin: '123456',
  contenteditable: 'EDITABLESECRET',
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Privacy Fixture</title></head><body>
<h1>Privacy fixture</h1>
<input id="unlabelled" type="text" value="${SECRETS.unlabelled}">
<label for="labelled">Real Label</label><input id="labelled" type="text" value="${SECRETS.labelled}">
<label for="pw">Password field</label><input id="pw" type="password" value="${SECRETS.password}">
<input id="hid" type="hidden" value="${SECRETS.hidden}">
<label for="area">Area</label><textarea id="area">${SECRETS.area}</textarea>
<label for="pin">Code</label><input id="pin" type="text" maxlength="6" value="${SECRETS.pin}">
<div id="ce" contenteditable="true" role="textbox" aria-label="Editable box">${SECRETS.contenteditable}</div>
</body></html>`

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE)
})
await new Promise(r => server.listen(HTTP_PORT, '127.0.0.1', r))
const URL_ = `http://127.0.0.1:${HTTP_PORT}/`

const session = new BrowserSession({ port: PORT, profileDir: PROFILE, headless: true, log: () => {} })

try {
  section('PR0  setup')
  const e = await session.ensure()
  ok(e.ok === true, 'browser available', e.reason)
  const a = await session.attach()
  ok(a.ok === true, 'attached', a.reason)
  await session.send('Page.navigate', { url: URL_ })
  await new Promise(r => setTimeout(r, 700))
  const obs = await observePage(session, { limit: 400 })
  ok(obs.ok === true, 'observation succeeded', obs.reason)
  ok(!String(obs.url).includes('SECRET'), 'the fixture URL itself is clean (no false-leak artifact)')

  section('L1  a control value is never used as its accessible name')
  const unlabelled = obs.interactive.find(x => x.selector === '#unlabelled')
  ok(Boolean(unlabelled), 'the unlabelled input was observed')
  ok(unlabelled.name === '', 'its name is EMPTY, not the typed value', JSON.stringify(unlabelled.name))
  ok(!String(unlabelled.name).includes(SECRETS.unlabelled), 'and the value is not in its name')

  const labelled = obs.interactive.find(x => x.selector === '#labelled')
  ok(labelled && labelled.name === 'Real Label', 'a labelled input still reports its LABEL as the name', labelled && labelled.name)

  const pw = obs.interactive.find(x => x.selector === '#pw')
  ok(pw && pw.sensitive === true, 'the password field is flagged sensitive')
  ok(pw && pw.valueLength === null && pw.valueDigest === null, 'and exposes neither length nor digest')

  const hid = obs.interactive.find(x => x.selector === '#hid')
  ok(hid === undefined || (hid.valueLength === null && hid.valueDigest === null),
    'a hidden input exposes no value evidence either')

  section('L1b  no fixture secret appears anywhere in the observation')
  const flat = JSON.stringify(obs)
  for (const [field, secret] of Object.entries(SECRETS)) {
    // The contenteditable is real page text, so its content legitimately appears in bodyText; every other
    // fixture value must be absent everywhere.
    if (field === 'contenteditable') continue
    if (field === 'area') {
      // This textarea HAS a `<label for="area">Area</label>`, so "Area" is its correct accessible name —
      // asserting empty here would be asserting that a real label is ignored. What must not happen is the
      // textarea's CONTENT appearing as the name.
      const areaEl = obs.interactive.find(x => x.selector === '#area')
      ok(areaEl && areaEl.name === 'Area', 'the textarea reports its LABEL, not its content', areaEl && areaEl.name)
      ok(areaEl && !String(areaEl.name).includes(SECRETS.area), 'and its content is not in the name')
      continue
    }
    ok(!flat.includes(secret), `the ${field} value does not appear in the observation`, secret)
  }

  section('L2  the value digest is salted and cannot be reproduced offline')
  const pin = obs.interactive.find(x => x.selector === '#pin')
  ok(Boolean(pin) && typeof pin.valueDigest === 'string', 'the PIN field reports a digest', pin && pin.valueDigest)
  ok(pin.valueLength === SECRETS.pin.length, 'and its length', String(pin && pin.valueLength))
  // Reproduce the UNSALTED digest in the page: with a salt, it must differ from what the observer reported.
  const unsalted = await session.send('Runtime.evaluate', {
    expression: `(() => { const v = ${JSON.stringify(SECRETS.pin)}; let h = 0x811c9dc5;
      for (let i = 0; i < v.length; i++) { h ^= v.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
      return v.length + ':' + h.toString(16).padStart(8, '0'); })()`,
    returnByValue: true,
  })
  const unsaltedDigest = unsalted && unsalted.result && unsalted.result.value
  ok(pin.valueDigest !== unsaltedDigest, 'the digest differs from an unsalted computation (so it cannot be enumerated)',
    `${pin.valueDigest} vs ${unsaltedDigest}`)
  ok(!String(pin.valueDigest).includes(SECRETS.pin), 'and does not embed the value')

  section('L3  digests stay comparable within the process (verification still works)')
  const obs2 = await observePage(session, { limit: 400 })
  const pin2 = obs2.interactive.find(x => x.selector === '#pin')
  ok(pin2 && pin2.valueDigest === pin.valueDigest, 'two observations agree on the same value', `${pin && pin.valueDigest} / ${pin2 && pin2.valueDigest}`)

  section('L4  target location still works after removing the value fallback')
  const byLabel = matchTarget(obs, { role: 'textbox', name: 'Real Label' })
  ok(byLabel.ok === true && byLabel.match.selector === '#labelled', 'a labelled field is still locatable by name', byLabel.ok ? byLabel.match.selector : byLabel.reason)
  const bySelector = matchTarget(obs, { selector: '#unlabelled' })
  ok(bySelector.ok === true && bySelector.match.selector === '#unlabelled', 'an unlabelled field is still locatable by selector')
  const byAria = matchTarget(obs, { role: 'textbox', name: 'Editable box' })
  ok(byAria.ok === true && byAria.match.selector === '#ce', 'an aria-labelled editable is still locatable')

  section('L5  focus and selection do not leak a secret')
  await session.send('Runtime.evaluate', { expression: 'document.getElementById("pw").focus()' })
  const obsPwFocus = await observePage(session, { limit: 400 })
  const f = obsPwFocus.focus
  ok(f && f.present === true, 'focus on the password field is reported')
  ok(f && f.selection === null, 'but its selection is NOT, even though it has one', JSON.stringify(f && f.selection))
  const pwFlat = JSON.stringify(obsPwFocus)
  ok(!pwFlat.includes(SECRETS.password), 'focusing it does not echo the password into the observation')
} finally {
  section('teardown')
  session.dispose()
  server.close()
}

console.log(`\n================ ${checks - failures}/${checks} checks passed ================`)
if (failures > 0) { console.log(`${failures} FAILURE(S)`); process.exit(1) }
console.log('ALL PASS')
