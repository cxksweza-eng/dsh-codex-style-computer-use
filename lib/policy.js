// policy.js — pure approval decision for dsh-computer-use.
// Modeled on @anweat/dsh-browser's approval-policy.js: a pure function mapping
// (toolName, args, automationMode) -> {kind:'allow'|'deny'|'ask', reason}.
// Fail-closed by construction: unknown tool names are denied.
//
// ⚠️ KEEP IN SYNC WITH THE TOOL SURFACE. A fail-closed list is only safe if it is also COMPLETE.
// 2026-09-13: the tool set was rewritten from 28 names to 17 (merged + renamed) and this
// allow-list was NOT updated, so the plugin's own gate would have denied most of its own tools
// with "unknown computer-use tool" — before they ever ran. `build/test-policy.mjs` now fails if
// any registered tool falls through to that branch, so the next rename cannot silently do this.
//
// Two tools cannot be classified by name alone and are decided by their ARGUMENTS:
//   computer_clip   — no text = read the clipboard; text = write it
//   computer_ctrl   — selftest = health;  stop = the brake;  exit = end the session;
//                     calibrate / indicator = control
// (`resume` is NOT among them any more: it was removed from the tool surface on 2026-09-13 because
// it un-latched Ctrl+Alt+Q, i.e. a TOOL CALL could re-open a cycle the human had ended. Only the
// plugin's session/event turn/start opens a cycle, and only the human's Ctrl+Alt+R releases a pause.)
// computer_ask is argument-independent and BRAKE-LIKE — see its branch below.

export const OBSERVATION_TOOLS = new Set([
  'computer_shot', 'computer_state', 'computer_marks', 'computer_uia', 'computer_wait',
])

export const ACTUATION_TOOLS = new Set([
  'computer_click', 'computer_move', 'computer_drag', 'computer_scroll', 'computer_select',
  'computer_key', 'computer_type', 'computer_uia_act', 'computer_window', 'computer_batch',
])

// ---------------------------------------------------------------------------------------------
// BROWSER TOOLS. Kept as separate sets rather than folded into the two above so that the origin of a
// decision stays readable, but they are fed to the SAME `decideActuation`, so `automationMode` means the
// same thing for a click in a page as for a click on the desktop.
//
// `browser_open` / `browser_close` are listed as observations on purpose: opening a debugging
// connection and closing a browser the plugin itself launched are not page side effects, and asking for
// approval before the agent is allowed to look would make the tool unusable in `standard` mode. Closing
// a browser the USER opened is refused in the session layer regardless of policy.
// ---------------------------------------------------------------------------------------------
export const BROWSER_OBSERVATION_TOOLS = new Set([
  'browser_open', 'browser_tabs', 'browser_observe', 'browser_verify', 'browser_wait', 'browser_close',
])

export const BROWSER_ACTUATION_TOOLS = new Set([
  'browser_navigate', 'browser_click', 'browser_type', 'browser_press',
])

// combos that escalate: run dialog, window close, signout/lock/taskmgr, delete-key
const HIGH_RISK_KEY = /(^|\+)(win\+r|alt\+f4|ctrl\+shift\+esc|win\+l|win\+d)(\+|$)/i
const DESTRUCTIVE_KEY = /(^|\+)(del|delete|bksp|backspace)(\+|$)/i

export const HIGH_RISK_NOTE = 'high-risk action (destructive key / closing a window / password field) — always requires human approval'

/** @returns {{kind:'allow'|'deny'|'ask', reason?: string}} */
export function policyDecision (name, args, mode) {
  const a = args || {}

  // ---- the two argument-dependent tools -------------------------------------------------
  if (name === 'computer_ctrl') {
    const act = String(a.action || 'selftest')
    // The brake is available in EVERY mode, including read-only, and it drives nothing.
    if (act === 'stop') return { kind: 'allow' }
    if (act === 'recover') return mode === 'read-only'
      ? { kind: 'deny', reason: 'read-only mode cannot recover control' } : { kind: 'allow' }
    if (act === 'selftest') return { kind: 'allow' }      // input-path health, never moves the pointer
    // ends the session: it drives nothing, and the human's own Ctrl+Alt+Q is unconditional. It is
    // the second answer of the ask protocol ("I cannot proceed") and the ask notice promises the
    // human the agent can give it — denying it made that answer dead in all four modes.
    if (act === 'exit') return { kind: 'allow' }
    if (act === 'calibrate' || act === 'indicator') return decideActuation(name, a, mode)
    return { kind: 'deny', reason: `unknown computer_ctrl action: ${act}` }
  }

  // ---- BRAKE-LIKE, and therefore NEVER gated -------------------------------------------------
  // computer_ask actuates NOTHING: it stops the machine, raises the host window and asks the human
  // a question. That is the SAFETY DIRECTION — it is the one call that must never sit behind an
  // approval prompt, because what it is asking for IS human attention. Gating it is exactly
  // backwards. Until 2026-09-13 it fell through to the fail-closed "unknown computer-use tool"
  // branch and was DENIED in all four modes, which silently killed the human's own "ask + 5 秒"
  // rule (their spec: "一旦出现 computer ask, 这时候返回到 DSH desktop 窗口. 若5秒规则内有回应,
  // 则进入暂停态").
  if (name === 'computer_ask') return { kind: 'allow' }
  if (name === 'computer_clip') {
    if (a.text === undefined) return { kind: 'allow' }     // read
    return decideActuation(name, a, mode)                  // write
  }

  if (OBSERVATION_TOOLS.has(name)) return { kind: 'allow' }
  if (ACTUATION_TOOLS.has(name)) return decideActuation(name, a, mode)

  // ---- CLIPBOARD CHORDS ARE NEVER COVERED BY SESSION-WIDE AUTHORIZATION -----------------------
  //
  // `ctrl+v` moves whatever is in the SYSTEM clipboard into a web page; `ctrl+c` moves the current page
  // selection out to the system clipboard, where every other application can read it. Neither direction is
  // visible to this tool - it never reads the clipboard - so the human is the only party who can judge
  // whether the transfer is acceptable, and they can only judge it for the transfer in front of them. A
  // session-wide "allow browser_press" decision was made about typing keys, not about the clipboard.
  //
  // This branch sits BEFORE `decideActuation` so it overrides the mode rule rather than adding to it: in
  // autonomous and unrestricted modes, where a press would otherwise be auto-allowed, a clipboard chord
  // still asks. read-only still denies, because read-only denies every actuation.
  //
  // The reason string is deliberately explicit about direction and target: the approval card has to name
  // the transfer in terms the human can act on, and "browser_press" alone does not.
  //
  // TWO DEFECTS FIXED HERE (2026-10-19, found by a read-only audit of a real approval card):
  //
  //   D1  A clipboard chord with NO target still returned `ask`, so the human was asked to approve an
  //       operation that the tool body was guaranteed to refuse afterwards (CLIPBOARD_REQUIRES_TARGET).
  //       The card even said "target=(no target named ...)" while still requesting approval, which is
  //       self-contradictory. The refusal now happens HERE, before any card exists.
  //
  //   D2  The reason echoed the raw `role` argument as if it named a target, so a card could read
  //       "target=textbox" - a description that identifies nothing, since many elements have that role.
  //       A role alone is no longer accepted for a clipboard transfer, and when a usable locator IS
  //       supplied the reason now says it is the caller's REQUESTED locator, never that it has been
  //       proved unique. Uniqueness cannot be known here: this function is pure and has no page access.
  if (name === 'browser_press') {
    const keyName = String(a.key || '').trim().toLowerCase().replace(/\s+/g, '')
    if (keyName === 'ctrl+c' || keyName === 'ctrl+v') {
      if (mode === 'read-only') {
        return { kind: 'deny', reason: `automationMode=read-only: ${keyName} drives the machine` }
      }
      const selector = String(a.selector == null ? '' : a.selector).trim()
      const accessibleName = String(a.name == null ? '' : a.name).trim()
      const role = String(a.role == null ? '' : a.role).trim()

      // D1: nothing to identify the element at all.
      if (!selector && !accessibleName && !role) {
        return {
          kind: 'deny',
          highRisk: true,
          reason: `clipboard ${keyName} requires a named target: supply a selector or an accessible name identifying ` +
            'the element the clipboard transfer applies to. Refused before the approval step, because an unnamed ' +
            'transfer could not be executed and must not ask a human to approve it.',
        }
      }

      // D2: a role is a category, not an element.
      if (!selector && !accessibleName) {
        return {
          kind: 'deny',
          highRisk: true,
          reason: `clipboard ${keyName} requires a specific target: role=${role} alone does not identify one element ` +
            '(many elements share a role), so supply a selector or an accessible name instead.',
        }
      }

      const direction = keyName === 'ctrl+v'
        ? 'SYSTEM CLIPBOARD -> PAGE (clipboard contents will be pasted into the page)'
        : 'PAGE SELECTION -> SYSTEM CLIPBOARD (page content will be placed on the shared clipboard)'
      const locatorParts = []
      if (selector) locatorParts.push(`selector=${selector}`)
      if (accessibleName) locatorParts.push(`name=${JSON.stringify(accessibleName)}`)
      if (role) locatorParts.push(`role=${role} (additional condition)`)
      return {
        kind: 'ask',
        reason: `clipboard ${keyName}: ${direction}; requested locator: ${locatorParts.join(', ')}. ` +
          'This is the caller-supplied LOCATOR, not a proved element identity - it is resolved against the live ' +
          'page, checked for uniqueness, visibility and disabled state, re-validated after approval, and focus is ' +
          'verified immediately before the key is sent; any of those failing refuses instead of sending. ' +
          'A one-time approval is required for this transfer and a session-wide authorization does not cover it.',
        highRisk: true,
      }
    }
  }

  // BROWSER TOOLS REUSE THIS SAME POLICY. They are not given their own gate: the rule that a driving
  // action asks while merely reading does not is the same rule, and a second decision path would be a
  // second place for it to be wrong. Browser names are matched here so the existing `automationMode`
  // semantics (read-only denies, standard asks, autonomous allows) apply to them unchanged.
  if (BROWSER_OBSERVATION_TOOLS.has(name)) return { kind: 'allow' }
  if (BROWSER_ACTUATION_TOOLS.has(name)) {
    // A navigation is named by its URL, which is the most useful thing a human can be shown, and a
    // click is named by its target. Both go through the same `decideActuation` so the mode rules and
    // the high-risk escalation stay in one place.
    return decideActuation(name, a, mode)
  }

  return { kind: 'deny', reason: `unknown computer-use tool: ${name}` }
}

function decideActuation (name, a, mode) {
  const hr = highRisk(name, a)
  switch (mode) {
    case 'read-only':
      return { kind: 'deny', reason: `automationMode=read-only: ${name} drives the machine` }
    case 'standard':
      return hr ? { kind: 'ask', reason: HIGH_RISK_NOTE }
        : { kind: 'ask', reason: `automationMode=standard: actuation ${name}` }
    case 'autonomous':
      return hr ? { kind: 'ask', reason: HIGH_RISK_NOTE } : { kind: 'allow' }
    case 'unrestricted':
      return { kind: 'allow' }
    default:
      return { kind: 'deny', reason: `unknown automationMode: ${mode}` }
  }
}

export function highRisk (name, args) {
  const a = args || {}
  // A browser clipboard chord is high risk BY DEFINITION: it moves data across the page/system boundary,
  // in a direction this tool cannot observe. Listed here as well as in policyDecision so every caller that
  // asks "is this high risk?" gets the same answer, instead of the escalation existing in only one path.
  if (name === 'browser_press') {
    const keyName = String(a.key || '').trim().toLowerCase().replace(/\s+/g, '')
    if (keyName === 'ctrl+c' || keyName === 'ctrl+v') return true
  }
  if (name === 'computer_key') {
    const combo = String(a.combo || '')
    if (HIGH_RISK_KEY.test(combo) || DESTRUCTIVE_KEY.test(combo)) return true
  }
  if (name === 'computer_window' && String(a.op || 'activate') === 'close') return true
  if (name === 'computer_type' && a.allowPassword) return true
  if (name === 'computer_batch') {
    const actions = Array.isArray(a.actions) ? a.actions : []
    for (const step of actions) {
      if (!step) continue
      const t = String(step.tool || '')
      if ((ACTUATION_TOOLS.has(t) || t === 'computer_clip' || t === 'computer_ctrl') && highRisk(t, step.args || {})) return true
    }
  }
  return false
}
