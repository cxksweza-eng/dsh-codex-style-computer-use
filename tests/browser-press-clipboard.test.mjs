// Clipboard high-risk approval tests for browser_press (2026-10-19).
//
// WHAT THIS FILE PROVES, AND WHAT IT DELIBERATELY DOES NOT DO:
//
//   It proves that a clipboard chord can never be dispatched without its OWN single approval: the policy
//   returns `ask` in every mode that can actuate (including `autonomous` and `unrestricted`, where an
//   ordinary press is auto-allowed), the reason string names the key, the direction and the target, and the
//   tool refuses outright when no target is named.
//
//   It does NOT dispatch `ctrl+c` / `ctrl+v`. Those keys move real data across the page/system boundary, and
//   a test that fires them would touch the machine's clipboard. The gate is verified at the decision layer
//   plus the zero-frame refusal path; the actual transfer is left for a human-supervised run.
//
// The direction matters and is asserted: `ctrl+v` is SYSTEM CLIPBOARD -> PAGE, `ctrl+c` is PAGE SELECTION ->
// SYSTEM CLIPBOARD. An approval card that says "browser_press" without a direction is not something a human
// can make a decision about.

import http from 'node:http'
import os from 'node:os'
import { join } from 'node:path'
import { BrowserSession } from '../lib/browser-session.js'
import { registerBrowserTools } from '../lib/browser-tools.js'
import { ActionRegistry } from '../lib/action-registry.js'
import { policyDecision, highRisk } from '../lib/policy.js'

const PORT = Number(process.env.CU_CLIP_PORT || 9421)
const HTTP_PORT = Number(process.env.CU_CLIP_HTTP || 8851)
const PROFILE = join(os.tmpdir(), `cu-clipboard-profile-${PORT}`)

let failures = 0
let checks = 0
const ok = (cond, label, detail) => {
  checks++
  if (cond) console.log(`  PASS  ${label}`)
  else { failures++; console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`) }
}
const section = (t) => console.log(`\n--- ${t} ---`)

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Clipboard Fixture</title></head><body>
<label for="f">Field</label><input id="f" type="text" value="abcdef">
<label for="f2">Second field</label><input id="f2" type="text" value="ghijkl">
<button id="b">Button</button>
</body></html>`

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(PAGE)
})
await new Promise(r => server.listen(HTTP_PORT, '127.0.0.1', r))
const URL_ = `http://127.0.0.1:${HTTP_PORT}/`

const session = new BrowserSession({ port: PORT, profileDir: PROFILE, headless: true, log: () => {} })
const registry = new ActionRegistry({ log: () => {} })
const tools = new Map()
registerBrowserTools({ session, registry, log: () => {}, defineTool: (d) => d, register: (d) => tools.set(d.name, d) })
const raw = (name, args) => tools.get(name).execute(args, { signal: undefined })

// Count real key frames without firing any clipboard key. Same local instrumentation pattern as the
// dispatch-count suite: a wrapper in this process only, no production hook.
const calls = { keyEvents: 0 }
const realSend = session.send.bind(session)
session.send = async (method, params, timeout) => {
  if (method === 'Input.dispatchKeyEvent') calls.keyEvents++
  return realSend(method, params, timeout)
}
const resetCalls = () => { calls.keyEvents = 0 }
const pageFact = async (expr) => {
  const r = await realSend('Runtime.evaluate', { expression: expr, returnByValue: true })
  return r && r.result ? r.result.value : undefined
}
const reset = async () => {
  await raw('browser_navigate', { url: URL_, allowSameUrl: true })
  await pageFact('document.getElementById("f").focus()')
}

try {
  section('C0  setup')
  const e = await session.ensure()
  ok(e.ok === true, 'browser available', e.reason)
  const a = await session.attach()
  ok(a.ok === true, 'attached', a.reason)
  await raw('browser_navigate', { url: URL_ })
  ok((await pageFact('document.title')) === 'Clipboard Fixture', 'fixture loaded')
  ok(tools.has('browser_press'), 'browser_press is registered')

  section('C1  a clipboard chord ALWAYS asks, in every actuating mode')
  const modes = ['read-only', 'standard', 'autonomous', 'unrestricted']
  for (const key of ['ctrl+c', 'ctrl+v']) {
    const args = { key, selector: '#f' }
    const byMode = Object.fromEntries(modes.map(m => [m, policyDecision('browser_press', args, m).kind]))
    ok(byMode['read-only'] === 'deny', `${key} is DENIED in read-only`, byMode['read-only'])
    for (const m of ['standard', 'autonomous', 'unrestricted']) {
      ok(byMode[m] === 'ask', `${key} ASKS in ${m} (a session-wide allow cannot cover it)`, byMode[m])
    }
  }
  // The exact regression this guards: an ordinary press IS auto-allowed in autonomous/unrestricted, so the
  // clipboard branch must be the thing that overrides it - not a general "browser_press always asks" rule.
  ok(policyDecision('browser_press', { key: 'Enter', selector: '#f' }, 'autonomous').kind === 'allow',
    'a NON-clipboard key is still auto-allowed in autonomous (the override is narrowly scoped)')
  ok(policyDecision('browser_press', { key: 'ctrl+a', selector: '#f' }, 'unrestricted').kind === 'allow',
    'ctrl+a is not treated as a clipboard transfer')

  section('C2  the approval reason names the key, the DIRECTION and the target')
  const v = policyDecision('browser_press', { key: 'ctrl+v', selector: '#f' }, 'unrestricted')
  ok(/ctrl\+v/.test(v.reason), 'ctrl+v result names the key', v.reason)
  ok(/SYSTEM CLIPBOARD -> PAGE/.test(v.reason), 'and states SYSTEM CLIPBOARD -> PAGE', v.reason)
  ok(/#f/.test(v.reason), 'and names the target', v.reason)
  ok(/one-time/i.test(v.reason), 'and says it is a one-time approval', v.reason)
  const c = policyDecision('browser_press', { key: 'ctrl+c', selector: '#f' }, 'unrestricted')
  ok(/PAGE SELECTION -> SYSTEM CLIPBOARD/.test(c.reason), 'ctrl+c states the opposite direction', c.reason)
  ok(v.highRisk === true && c.highRisk === true, 'both are flagged highRisk')

  section('D1  a clipboard chord with NO target is DENIED before any approval card')
  // THE DEFECT THIS PINS (2026-10-19): a real approval card was shown for `ctrl+v` with no target, and its
  // own text said "target=(no target named - the press path requires one)" - so a human was asked to approve
  // an operation that was guaranteed to be refused afterwards. The gate now denies up front, which means no
  // card exists to approve.
  for (const key of ['ctrl+c', 'ctrl+v']) {
    for (const m of ['standard', 'autonomous', 'unrestricted']) {
      const d = policyDecision('browser_press', { key }, m)
      ok(d.kind === 'deny', `${key} with no target is DENIED in ${m}`, `${d.kind}: ${d.reason}`)
      ok(d.kind !== 'ask', `${key} with no target does NOT ask in ${m} (no card to approve)`)
      ok(/none|missing|named target|requires a named target/i.test(String(d.reason)),
        `${key} refusal explains that a target is required`, String(d.reason).slice(0, 90))
    }
    ok(policyDecision('browser_press', { key }, 'read-only').kind === 'deny', `${key} no-target is still denied in read-only`)
  }

  section('D2  a ROLE alone is not a target: denied, in every mode')
  for (const key of ['ctrl+c', 'ctrl+v']) {
    for (const m of ['standard', 'autonomous', 'unrestricted']) {
      const d = policyDecision('browser_press', { key, role: 'textbox' }, m)
      ok(d.kind === 'deny', `${key} with only a role is DENIED in ${m}`, `${d.kind}: ${d.reason}`)
      ok(/role=textbox/.test(String(d.reason)), `${key} refusal names the role that was insufficient`, String(d.reason).slice(0, 90))
      ok(/specific|one element|share a role/i.test(String(d.reason)), `${key} refusal says the target is not specific enough`)
    }
  }

  section('D2b a concrete selector or name still gets the one-time high-risk approval')
  for (const args of [{ key: 'ctrl+v', selector: '#f' }, { key: 'ctrl+v', name: 'Field' }, { key: 'ctrl+c', selector: '#f' }]) {
    const d = policyDecision('browser_press', args, 'unrestricted')
    const label = args.selector ? `selector=${args.selector}` : `name=${args.name}`
    ok(d.kind === 'ask', `${args.key} with ${label} still ASKS`, `${d.kind}: ${d.reason}`)
    ok(d.highRisk === true, `and is flagged highRisk`)
  }

  section('D2c the approval reason shows the REQUESTED locator and never claims it is proved')
  const reason = policyDecision('browser_press', { key: 'ctrl+v', selector: '#f', role: 'textbox' }, 'standard').reason
  ok(/requested locator/i.test(reason), 'the reason calls it a requested locator')
  ok(/selector=#f/.test(reason), 'and shows the selector that was supplied')
  ok(/role=textbox/.test(reason), 'and mentions the additional role condition')
  ok(/not a proved element identity/i.test(reason), 'and states it is NOT a proved element identity')
  // It must not assert that uniqueness HAS been established.
  ok(!/(is|has been|was)\s+(proved|verified|confirmed)\s+unique/i.test(reason), 'it never claims the target is proved unique')
  ok(!/唯一/.test(reason), 'and does not claim uniqueness in Chinese either')
  ok(/re-validated after approval/i.test(reason), 'it describes the post-approval revalidation')
  ok(/focus is verified/i.test(reason), 'and the focus verification before dispatch')
  const nameReason = policyDecision('browser_press', { key: 'ctrl+c', name: 'Field' }, 'standard').reason
  ok(/name="Field"/.test(nameReason), 'a name locator is shown as name="..."', nameReason.slice(0, 80))

  section('D1b the execution layer still guards no-target chords (defence in depth)')
  await reset(); resetCalls()
  const vGuard = await raw('browser_press', { key: 'ctrl+v' })
  ok(vGuard.ok === false && vGuard.code === 'CLIPBOARD_REQUIRES_TARGET', 'tool body still refuses ctrl+v with no target', vGuard.code)
  ok(calls.keyEvents === 0, 'and sends zero key frames', calls.keyEvents)
  await reset(); resetCalls()
  const cGuard = await raw('browser_press', { key: 'ctrl+c' })
  ok(cGuard.ok === false && cGuard.code === 'CLIPBOARD_REQUIRES_TARGET', 'tool body still refuses ctrl+c with no target', cGuard.code)
  ok(calls.keyEvents === 0, 'and sends zero key frames', calls.keyEvents)

  section('D2d a role-only chord that reaches the tool body is refused as ambiguous, sending nothing')
  // The policy gate already denies role-only, so this cannot happen through the Host. The tool body is
  // called directly here to prove the SECOND layer also refuses rather than dispatching: the fixture has two
  // textboxes, so `role: textbox` cannot resolve to one element and the ambiguity check stops it.
  await reset(); resetCalls()
  const roleOnly = await raw('browser_press', { key: 'ctrl+v', role: 'textbox' })
  ok(roleOnly.ok === false, 'the role-only attempt did not succeed', JSON.stringify({ code: roleOnly.code }))
  ok(roleOnly.code === 'AMBIGUOUS' || roleOnly.code === 'CLIPBOARD_REQUIRES_TARGET',
    'it was refused as ambiguous (or for lacking a target)', `${roleOnly.code}: ${roleOnly.reason}`)
  ok(roleOnly.dispatched === false, 'and nothing was dispatched')
  ok(calls.keyEvents === 0, 'zero key frames were sent', calls.keyEvents)

  section('D2e ordinary keys are untouched by D1/D2')
  ok(policyDecision('browser_press', { key: 'Enter' }, 'unrestricted').kind === 'allow', 'Enter with no target is still allowed in unrestricted')
  ok(policyDecision('browser_press', { key: 'Tab' }, 'standard').kind === 'ask', 'Tab with no target still asks in standard')
  ok(policyDecision('browser_press', { key: 'ctrl+a' }, 'autonomous').kind === 'allow', 'ctrl+a is still not a clipboard transfer')
  ok(policyDecision('browser_click', { selector: '#b' }, 'autonomous').kind === 'allow', 'other browser tools unaffected')

  section('C3  highRisk() agrees with the policy decision')
  ok(highRisk('browser_press', { key: 'ctrl+v' }) === true, 'highRisk(ctrl+v) is true')
  ok(highRisk('browser_press', { key: 'ctrl+c' }) === true, 'highRisk(ctrl+c) is true')
  ok(highRisk('browser_press', { key: 'ctrl+a' }) === false, 'highRisk(ctrl+a) is false')
  ok(highRisk('browser_press', { key: 'Enter' }) === false, 'highRisk(Enter) is false')
  ok(highRisk('browser_click', { selector: '#b' }) === false, 'other tools are unaffected')

  section('C4  without a named target the chord is refused and NOTHING is sent')
  await reset(); resetCalls()
  const vNoTarget = await raw('browser_press', { key: 'ctrl+v' })
  ok(vNoTarget.ok === false && vNoTarget.code === 'CLIPBOARD_REQUIRES_TARGET', 'ctrl+v refused without a target', vNoTarget.code)
  ok(calls.keyEvents === 0, 'zero key frames were sent', calls.keyEvents)
  ok(vNoTarget.dispatched === false, 'and it reports dispatched:false')
  await reset(); resetCalls()
  const cNoTarget = await raw('browser_press', { key: 'ctrl+c' })
  ok(cNoTarget.ok === false && cNoTarget.code === 'CLIPBOARD_REQUIRES_TARGET', 'ctrl+c refused without a target', cNoTarget.code)
  ok(calls.keyEvents === 0, 'zero key frames were sent', calls.keyEvents)

  section('C5  a refused clipboard attempt is CANCELLED and can never be dispatched')
  ok(vNoTarget.registry.state === 'CANCELLED', 'the record is CANCELLED', vNoTarget.registry.state)
  ok(vNoTarget.registry.sideEffectSent === false, 'with sideEffectSent:false (nothing left the process)', String(vNoTarget.registry.sideEffectSent))
  const redo = registry.beginDispatch(vNoTarget.actionId)
  ok(redo.ok === false, 're-dispatch of that action is refused', redo.reason)
  // NO SECOND CLIPBOARD DISPATCH IS ATTEMPTED HERE. An earlier version of this case fired a well-formed
  // ctrl+v to show the "new attempt" path, which meant the suite actually sent a clipboard key — exactly the
  // thing this file says it will not do, and something that needs a human watching the clipboard. The
  // CANCELLED guarantee is fully covered by the two assertions above; a second live attempt adds risk and no
  // evidence.
  ok(registry.get(vNoTarget.actionId).dispatches === 1, 'the cancelled action never gets a second slot',
    registry.get(vNoTarget.actionId).dispatches)

  section('C6  the clipboard content is never read, returned or recorded')
  const flat = JSON.stringify(vNoTarget) + JSON.stringify(cNoTarget)
  ok(!/Promise\{"text"/.test(flat), 'no clipboard payload in the result')
  ok(!('clipboardText' in vNoTarget) && !('text' in vNoTarget), 'the result has no clipboard text field')
  // The tool must not gain a clipboard-reading call: any such read would show up as a different CDP method.
  ok(!flat.includes('SystemClipboard') && !flat.includes('clipboardRead'), 'no clipboard read API appears in the result')

  section('C7  ordinary keys are unaffected by the clipboard rule')
  await reset(); resetCalls()
  const tab = await raw('browser_press', { key: 'Tab', selector: '#f' })
  ok(tab.dispatched === true, 'Tab still dispatches', tab.code || tab.outcome)
  ok(calls.keyEvents === 2, 'and sends exactly one keyDown/keyUp pair', calls.keyEvents)

  section('C8  the tool description tells the human a clipboard is involved')
  const def = tools.get('browser_press')
  ok(/CLIPBOARD NOTE/.test(def.description), 'the description carries a CLIPBOARD NOTE')
  ok(/ctrl\+v pastes/i.test(def.description), 'and explains what ctrl+v does')
  ok(/ctrl\+c copies/i.test(def.description), 'and what ctrl+c does')
  ok(/never reads it/.test(def.description), 'and states that the tool never reads the clipboard')
} finally {
  section('teardown')
  session.dispose()
  server.close()
}

console.log(`\n================ ${checks - failures}/${checks} checks passed ================`)
if (failures > 0) { console.log(`${failures} FAILURE(S)`); process.exit(1) }
console.log('ALL PASS')
