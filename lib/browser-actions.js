// ---------------------------------------------------------------------------------------------
// Browser ACTIONS — navigate and click (2026-10-16)
//
// THE RULE THIS FILE EXISTS TO ENFORCE: a successful CDP call is NOT a successful action.
// `Page.navigate` returning a frameId means the browser accepted a request. It does not mean the
// document loaded, that the URL stayed where it was sent, or that the page the caller wanted is the
// page that arrived. Redirects, an error document, a `data:` URL that never commits, and a navigation
// that was superseded by a second one all return a valid frameId.
//
// So each action has parts, and the LAST one decides the outcome:
//   1. DISPATCH   — ask the browser to act, and wait for the lifecycle to settle.
//   2. OBSERVE    — read the page back with the SAME structured observer the tools use.
//   3. VERIFY     — decide success from what was observed, never from the dispatch result.
//
// UNKNOWN IS A REAL OUTCOME. If the socket drops mid-action the effect may or may not have landed, and
// the browser is the only authority on which. That case returns `outcome:'unknown'` so the registry
// marks the action UNKNOWN and no automatic replay happens — replaying a navigation or a click is
// exactly how a side effect gets performed twice.
//
// A SECOND RULE, specific to click: an element located BEFORE an approval decision must never be
// clicked at its remembered location AFTERWARDS. A bounding box is a fact about a moment, not an
// identity. So a click captures a STRUCTURAL identity, and re-proves it against the live DOM after the
// boundary. See `revalidateIdentity`.
// ---------------------------------------------------------------------------------------------

import { observePage, matchTarget, digestValue } from './browser-observe.js'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------------------------------------
// NAVIGATE
// ---------------------------------------------------------------------------------------------

/**
 * Is the attached page ALREADY at `url`?
 *
 * LIFTED OUT OF `navigate` ON PURPOSE (defect D3, measured on the real instance). The check used to live
 * inside the dispatch path, so it could only answer AFTER `beginDispatch()` had already spent the action's
 * single dispatch slot. The record then had no side effect to show for the slot and was left in EXECUTING
 * — neither terminal nor dispatchable. Exposing it separately lets the caller ask the question BEFORE the
 * slot is claimed, so "nothing to do" costs nothing and settles cleanly.
 */
export async function alreadyThere (session, url, { allowSameUrl = false } = {}) {
  if (allowSameUrl) return null
  if (!session || !session.connected) return null
  const current = await session.currentPage()
  if (!current || !current.url) return null
  const norm = (s) => String(s || '').replace(/\/$/, '')
  if (norm(current.url) !== norm(String(url || '').trim())) return null
  return {
    ok: true, alreadyThere: true, dispatched: false,
    reason: 'the page is already at this URL; nothing was dispatched',
    observed: { url: current.url, title: current.title },
  }
}

/** Wait until the page reports a settled load state, or the budget runs out. */
export async function waitForLoad (session, { timeoutMs = 15_000, pollMs = 120 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  for (;;) {
    try {
      const res = await session.send('Runtime.evaluate', {
        expression: 'JSON.stringify({rs: document.readyState, url: location.href})',
        returnByValue: true,
      }, Math.min(4000, Math.max(1000, deadline - Date.now())))
      last = res && res.result && res.result.value ? JSON.parse(res.result.value) : null
      if (last && last.rs === 'complete') return { settled: true, ...last }
    } catch (error) {
      // A Runtime.evaluate can legitimately fail while the frame is being replaced. That is a retry,
      // not a failure — unless the socket itself is gone.
      if (error.disconnected) return { settled: false, disconnected: true, reason: error.message }
    }
    if (Date.now() >= deadline) return { settled: false, timedOut: true, ...(last || {}) }
    await sleep(pollMs)
  }
}

/**
 * Navigate the attached page and PROVE it arrived.
 *
 * @param {object} opts
 * @param {string} opts.url             destination
 * @param {number} [opts.timeoutMs]     load budget
 * @param {object} [opts.expect]        { urlIncludes, urlEquals, titleIncludes, titleEquals, element }
 * @param {boolean} [opts.allowSameUrl] permit navigating to the URL already loaded
 */
export async function navigate (session, opts = {}) {
  const url = String(opts.url || '').trim()
  // EVERY early return states `dispatched` explicitly. A caller that has to infer "was anything sent?"
  // from a missing field will infer wrong: the wrapper defaulted a missing flag to `true` and reported a
  // never-sent navigation as dispatched, which is the one fact a retry decision depends on.
  if (!url) return { ok: false, outcome: 'not-dispatched', dispatched: false, reason: 'a url is required' }

  // A URL is not required to be absolute — the browser resolves relative and scheme-less forms — but a
  // clearly unusable value is refused BEFORE anything is dispatched, so a typo cannot become a
  // navigation to an error document that then has to be diagnosed.
  let parsedOk = false
  try { new URL(url, 'http://x.invalid/'); parsedOk = true } catch { parsedOk = false }
  if (!parsedOk) return { ok: false, outcome: 'not-dispatched', dispatched: false, reason: `the url is not a usable URL: ${JSON.stringify(url)}` }

  if (!session || !session.connected) {
    return { ok: false, outcome: 'not-dispatched', dispatched: false, reason: 'browser session is not attached to a page' }
  }

  // THE "ALREADY THERE" CHECK USED TO SIT HERE. It now runs as the caller's `precheck`, BEFORE the
  // dispatch slot is claimed, so a no-op navigation no longer burns the slot and no longer leaves the
  // record stranded in EXECUTING. See `alreadyThere` above.

  // --- 1. DISPATCH -------------------------------------------------------------------------
  let frameId = null
  let dispatchError = null
  try {
    const res = await session.send('Page.navigate', { url }, opts.timeoutMs || 20_000)
    frameId = res && res.frameId ? res.frameId : null
    // An errorText means the BROWSER refused the navigation. That is a definite failure, not unknown.
    if (res && res.errorText) return { ok: false, outcome: 'failed', dispatched: true, reason: `the browser refused the navigation: ${res.errorText}` }
  } catch (error) {
    dispatchError = error
    if (error.disconnected) {
      return {
        ok: false, outcome: 'unknown', dispatched: true, disconnected: true,
        reason: `the browser connection was lost while navigating: ${error.message}`,
        note: 'the navigation may or may not have taken effect — observe the page before deciding',
      }
    }
    if (error.timeout) {
      // The request was sent but no reply arrived. The page may still be loading.
      return {
        ok: false, outcome: 'unknown', dispatched: true, timeout: true,
        reason: `Page.navigate did not answer within the budget: ${error.message}`,
        note: 'the navigation was sent but unconfirmed — observe the page before deciding',
      }
    }
    return { ok: false, outcome: 'not-dispatched', dispatched: false, reason: `could not send the navigation: ${error.message}` }
  }

  // --- 2. WAIT FOR THE LIFECYCLE -----------------------------------------------------------
  const load = await waitForLoad(session, { timeoutMs: opts.timeoutMs || 15_000 })
  if (load.disconnected) {
    return {
      ok: false, outcome: 'unknown', dispatched: true, disconnected: true, frameId,
      reason: `the browser connection was lost while loading: ${load.reason}`,
      note: 'the navigation may have completed — observe before retrying',
    }
  }

  // --- 3. OBSERVE --------------------------------------------------------------------------
  const observed = await observePage(session, { limit: opts.limit || 400 })
  if (!observed.ok && observed.disconnected) {
    return { ok: false, outcome: 'unknown', dispatched: true, disconnected: true, frameId, reason: observed.reason }
  }

  // --- 4. VERIFY ---------------------------------------------------------------------------
  const verdict = verifyNavigation({ requestedUrl: url, load, observed, expect: opts.expect || {} })
  return {
    ok: verdict.ok,
    outcome: verdict.ok ? 'applied' : (verdict.unknown ? 'unknown' : 'failed'),
    dispatched: true,
    frameId,
    load: { settled: load.settled === true, readyState: load.rs || null, timedOut: load.timedOut === true },
    ...verdict,
    observed: observed.ok
      ? { url: observed.url, title: observed.title, readyState: observed.readyState, counts: observed.counts, stable: observed.stable }
      : { error: observed.reason },
    dispatchError: dispatchError ? dispatchError.message : null,
  }
}

/**
 * Decide whether a navigation actually did what was asked. Pure function: everything it needs is
 * passed in, so the rules can be read and tested without a browser.
 */
export function verifyNavigation ({ requestedUrl, load, observed, expect = {} }) {
  const facts = []
  const problems = []
  const actualUrl = (observed && observed.url) || (load && load.url) || null
  const title = observed && observed.title

  if (!load || load.settled !== true) {
    problems.push(load && load.timedOut ? 'the page did not reach readyState=complete within the budget' : 'the load state could not be confirmed')
  } else {
    facts.push('readyState=complete')
  }

  if (!actualUrl) {
    problems.push('the current URL could not be read')
  } else {
    facts.push(`url=${actualUrl.slice(0, 120)}`)
    const norm = (s) => String(s || '').replace(/\/$/, '')
    const requested = norm(requestedUrl)
    const actual = norm(actualUrl)
    if (actual !== requested) {
      // Redirects are legitimate, so this is only a failure when the caller said it must match.
      if (expect.urlEquals) problems.push(`the URL is ${actual} but ${requested} was required`)
      else facts.push('url differs from the request (a redirect is not itself a failure)')
    }
  }

  if (expect.urlIncludes && !(actualUrl || '').includes(expect.urlIncludes)) {
    problems.push(`the URL does not contain ${JSON.stringify(expect.urlIncludes)}`)
  }
  if (expect.titleIncludes && !String(title || '').includes(expect.titleIncludes)) {
    problems.push(`the title does not contain ${JSON.stringify(expect.titleIncludes)}`)
  }
  if (expect.titleEquals && String(title || '') !== expect.titleEquals) {
    problems.push(`the title is ${JSON.stringify(title)} but ${JSON.stringify(expect.titleEquals)} was required`)
  }
  if (expect.element) {
    if (!observed || !observed.ok) {
      problems.push('the page could not be observed, so the expected element cannot be confirmed')
    } else {
      const m = matchTarget(observed, expect.element)
      if (!m.ok) problems.push(`the expected element was not found: ${m.reason}`)
      else if (m.ambiguous) problems.push(`the expected element is ambiguous (${m.matches} matches)`)
      else facts.push(`expected element present (${m.why.join(',')})`)
    }
  }

  // AN ERROR DOCUMENT IS NOT A SUCCESSFUL NAVIGATION. A browser happily reports readyState=complete for
  // its own error page, and to Chromium that is a perfectly good document — so it is checked explicitly
  // rather than being left to whatever the caller happened to assert.
  if (observed && observed.ok && typeof observed.title === 'string') {
    const looksLikeError = /^(4\d\d|5\d\d)\b/.test(observed.title.trim()) ||
      /(not found|ERR_|error)/i.test(observed.title)
    if (looksLikeError && !expect.allowErrorPage) {
      problems.push(`the loaded document looks like a browser error page (title ${JSON.stringify(observed.title)})`)
    }
  }

  const unknown = !observed || !observed.ok
  return {
    ok: problems.length === 0,
    unknown,
    verified: problems.length === 0,
    how: facts,
    problems,
    url: actualUrl,
    title: title === undefined ? null : title,
  }
}

// ---------------------------------------------------------------------------------------------
// CLICK — identity, the approval boundary, and revalidation
// ---------------------------------------------------------------------------------------------

/** A structural identity for a target. Never contains a coordinate. */
export function captureIdentity (element) {
  if (!element) return null
  return {
    selector: element.selector || null,
    selectorUnique: element.selectorUnique === true,
    role: element.role || null,
    name: element.name || null,
    text: element.text || null,
    tag: element.tag || null,
    href: element.href || null,
    inputType: element.inputType || null,
    // Diagnostics only. Never an input to dispatch.
    boxAtCapture: element.rect ? { ...element.rect } : null,
  }
}

/**
 * Re-prove that the element observed before approval is still the SAME element now.
 *
 * Returns { ok, code, reason, element, why, checks }. Every refusal names the specific check that
 * failed, so a caller can act on it instead of guessing.
 */
export function revalidateIdentity (observation, identity, { requireName = true } = {}) {
  const checks = []
  if (!observation || !observation.ok) {
    return { ok: false, code: 'REFRESH_REQUIRED', reason: 'the page could not be observed', checks }
  }
  if (!identity) {
    // Without a captured identity there is nothing to re-prove, and "click whatever is at that spot" is
    // exactly the behaviour this whole layer exists to prevent.
    return { ok: false, code: 'REFRESH_REQUIRED', reason: 'no target identity was captured before approval', checks }
  }

  // 1. The selector must still name this element, and must still be unique.
  if (identity.selector) {
    const live = observation.interactive.filter(e => e.selector === identity.selector)
    checks.push({ check: 'selector-present', ok: live.length >= 1, observed: live.length })
    if (live.length === 0) {
      return { ok: false, code: 'TARGET_NOT_FOUND', reason: `the target selector ${identity.selector} no longer matches any interactive element`, checks }
    }
    if (live.length > 1) {
      // CSS uniqueness is a property of the DOCUMENT, not of the string: `#id` can match twice after a
      // clone, and a selector that matched one node before and two now is ambiguous.
      return { ok: false, code: 'AMBIGUOUS', reason: `the target selector ${identity.selector} now matches ${live.length} elements`, checks }
    }
    const el = live[0]
    checks.push({ check: 'selector-unique-now', ok: el.selectorUnique === true, observed: el.selectorUnique === true })
    if (el.selectorUnique !== true) {
      return { ok: false, code: 'AMBIGUOUS', reason: `the target selector ${identity.selector} is no longer provably unique in the document`, checks }
    }
    // The identity attributes must still agree. A node that kept its selector but changed its role or
    // name is a DIFFERENT control that happens to reuse the path.
    if (identity.role && el.role !== identity.role) {
      return { ok: false, code: 'TARGET_CHANGED', reason: `the target role changed from ${identity.role} to ${el.role}`, checks }
    }
    if (requireName && identity.name && el.name !== identity.name) {
      return { ok: false, code: 'TARGET_CHANGED', reason: `the target accessible name changed from ${JSON.stringify(identity.name)} to ${JSON.stringify(el.name)}`, checks }
    }
    checks.push({ check: 'identity-attrs', ok: true })
    return { ok: true, element: el, checks, why: ['selector-reproved', 'role-stable', ...(identity.name ? ['name-stable'] : [])] }
  }

  // 2. No selector was captured: fall back to role + name, the other structural identity. This is not a
  //    weaker path by accident — it is the path used when a selector could not be proved unique at
  //    capture time, and it still requires an unambiguous structural match.
  const match = matchTarget(observation, { role: identity.role || undefined, name: identity.name || undefined, text: identity.text || undefined })
  checks.push({ check: 'structural-match', ok: match.ok === true, observed: match.ok ? match.matches : 0 })
  if (!match.ok) return { ok: false, code: 'TARGET_NOT_FOUND', reason: match.reason, checks }
  if (match.ambiguous) return { ok: false, code: 'AMBIGUOUS', reason: `the target now matches ${match.matches} elements`, checks, alternatives: match.alternatives }
  if (identity.role && match.match.role !== identity.role) {
    return { ok: false, code: 'TARGET_CHANGED', reason: `the target role changed from ${identity.role} to ${match.match.role}`, checks }
  }
  return { ok: true, element: match.match, checks, why: ['structural-reproved', ...match.why] }
}

/** Click a node addressed by a selector, in the page, without relying on a remembered coordinate. */
async function dispatchClick (session, selector, { timeoutMs = 10_000 } = {}) {
  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: 'the element is gone' };
    const all = document.querySelectorAll(${JSON.stringify(selector)});
    if (all.length !== 1) return { ok: false, reason: 'the selector matches ' + all.length + ' elements' };
    if (el.disabled) return { ok: false, reason: 'the element is disabled' };
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { ok: false, reason: 'the element has no box' };
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none') {
      return { ok: false, reason: 'the element is not hittable (visibility/display/pointer-events)' };
    }
    if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' });
    const r2 = el.getBoundingClientRect();
    const cx = r2.left + r2.width / 2, cy = r2.top + r2.height / 2;
    // The hit test is the only reason a coordinate appears here at all: it is derived from the
    // element's OWN live box an instant before the event, and it exists to prove that this element is
    // the one on top at that point. It is never carried across an approval boundary.
    const top = document.elementFromPoint(cx, cy);
    if (!top) return { ok: false, reason: 'nothing is on top at the element centre' };
    if (top !== el && !el.contains(top) && !top.contains(el)) {
      return { ok: false, reason: 'another element covers the target centre', covering: top.tagName + (top.id ? '#' + top.id : '') };
    }
    el.focus && el.focus();
    return { ok: true, cx: Math.round(cx), cy: Math.round(cy), tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 80) };
  })()`
  const res = await session.send('Runtime.evaluate', { expression: expr, returnByValue: true }, timeoutMs)
  const ex = res && res.exceptionDetails
  if (ex) return { ok: false, reason: `the page threw while resolving the click: ${(ex.exception && ex.exception.description) || ex.text}` }
  const value = res && res.result && res.result.value
  if (!value || value.ok !== true) return { ok: false, reason: (value && value.reason) || 'the click could not be resolved', detail: value }

  // Dispatch real input events at the element's own centre. `element.click()` would bypass the event
  // pipeline and silently succeed on elements a user could never press.
  const press = await session.send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, reason: 'the element went away before the click' };
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const opts = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, view: window };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
      return { ok: true, dispatched: true, cx: Math.round(cx), cy: Math.round(cy) };
    })()`,
    returnByValue: true,
  }, timeoutMs)
  const pv = press && press.result && press.result.value
  if (!pv || pv.ok !== true) return { ok: false, reason: (pv && pv.reason) || 'the click events could not be dispatched' }
  return { ok: true, dispatched: true, cx: value.cx, cy: value.cy, tag: value.tag, text: value.text }
}

/**
 * Click a target on the attached page, with the approval boundary in the middle handled explicitly.
 *
 * @param {object} opts
 * @param {object} opts.target            { role, name, text, selector, hrefIncludes } to resolve
 * @param {Function} [opts.beforeApprove] async (captured) => void — runs ONCE the identity is captured
 *        and BEFORE the post-approval observation. This is where the host asks for approval.
 * @param {object} [opts.expect]          what must be true afterwards for the click to count
 * @param {object} [opts.identity]        a previously captured identity to revalidate instead of resolving
 */
export async function click (session, opts = {}) {
  if (!session || !session.connected) {
    return { ok: false, outcome: 'not-dispatched', dispatched: false, reason: 'browser session is not attached to a page' }
  }

  // ---- PHASE 1: observe and capture a structural identity --------------------------------------
  const before = opts.observation || await observePage(session, { limit: opts.limit || 400 })
  if (!before.ok) {
    // A lost connection before anything was sent is NOT unknown — nothing left the process. A page that
    // merely could not be read is also not-dispatched. Both are safe to re-plan against.
    return {
      ok: false, outcome: 'not-dispatched', dispatched: false,
      code: before.disconnected ? 'DISCONNECTED' : 'REFRESH_REQUIRED',
      reason: `the page could not be observed: ${before.reason}`,
    }
  }
  const resolved = opts.identity ? { ok: true, match: null } : matchTarget(before, opts.target || {})
  if (!opts.identity) {
    if (!resolved.ok) {
      return { ok: false, outcome: 'not-dispatched', dispatched: false, code: 'TARGET_NOT_FOUND', reason: resolved.reason, url: before.url }
    }
    if (resolved.ambiguous) {
      return {
        ok: false, outcome: 'not-dispatched', dispatched: false, code: 'AMBIGUOUS',
        reason: `the target matches ${resolved.matches} elements; refusing to choose one`,
        alternatives: resolved.alternatives, url: before.url,
      }
    }
  }
  const identity = opts.identity || captureIdentity(resolved.match)
  const captured = { identity, urlAtCapture: before.url, titleAtCapture: before.title }
  const element = resolved.match

  // Structured refusal BEFORE any dispatch: a target that cannot be clicked as it stands is reported
  // with the reason, and nothing is sent.
  if (element) {
    if (element.disabled) return { ok: false, outcome: 'not-dispatched', dispatched: false, code: 'TARGET_DISABLED', reason: 'the target is disabled', identity, url: before.url }
    if (!element.visible) return { ok: false, outcome: 'not-dispatched', dispatched: false, code: 'TARGET_INVISIBLE', reason: 'the target is not visible', identity, url: before.url }
    if (!element.selector) {
      return { ok: false, outcome: 'not-dispatched', dispatched: false, code: 'NO_STABLE_SELECTOR', reason: 'no selector could be proved unique for the target, so it cannot be clicked without relying on a coordinate', identity, url: before.url }
    }
  }

  // ---- the approval boundary ------------------------------------------------------------------
  if (typeof opts.beforeApprove === 'function') await opts.beforeApprove(captured)

  // ---- PHASE 2: re-observe and RE-PROVE the identity against the live DOM ----------------------
  const after = await observePage(session, { limit: opts.limit || 400 })
  if (!after.ok) {
    return {
      ok: false, outcome: after.disconnected ? 'unknown' : 'failed', dispatched: false,
      code: after.disconnected ? 'DISCONNECTED' : 'REFRESH_REQUIRED',
      reason: `the page could not be re-observed after approval: ${after.reason}`,
      identity, captured,
    }
  }
  const revalidated = revalidateIdentity(after, identity)
  if (!revalidated.ok) {
    // NOTHING IS CLICKED. This is the whole point of the phase split.
    return {
      ok: false, outcome: 'not-dispatched', dispatched: false,
      code: revalidated.code, reason: revalidated.reason, checks: revalidated.checks,
      identity, captured,
      url: after.url, title: after.title,
      note: 'the target could not be re-proved after approval, so no click was sent',
    }
  }
  const live = revalidated.element
  const selector = identity.selector || live.selector
  if (!selector) {
    return { ok: false, outcome: 'not-dispatched', dispatched: false, code: 'NO_STABLE_SELECTOR', reason: 'the revalidated target has no unique selector', identity, captured }
  }
  // A live re-check of the clickability facts, because they too are about NOW.
  if (live.disabled) return { ok: false, outcome: 'not-dispatched', dispatched: false, code: 'TARGET_DISABLED', reason: 'the target became disabled after approval', identity, captured }
  if (!live.visible) return { ok: false, outcome: 'not-dispatched', dispatched: false, code: 'TARGET_INVISIBLE', reason: 'the target became invisible after approval', identity, captured }

  // ---- EXECUTE --------------------------------------------------------------------------------
  const snapshot = { url: after.url, title: after.title, bodyText: (after.bodyText || '').slice(0, 4000), counts: after.counts }
  let sent
  try {
    sent = await dispatchClick(session, selector, { timeoutMs: opts.timeoutMs })
  } catch (error) {
    if (error.disconnected) {
      // The click may or may not have been delivered. That is exactly UNKNOWN, and it must not be
      // retried — a click that submits a form is not idempotent.
      return { ok: false, outcome: 'unknown', dispatched: true, disconnected: true, code: 'DISCONNECTED', reason: `the browser connection was lost while clicking: ${error.message}`, identity, captured, selector }
    }
    return { ok: false, outcome: 'failed', dispatched: true, reason: `the click could not be sent: ${error.message}`, identity, captured, selector }
  }
  if (!sent.ok) {
    return { ok: false, outcome: 'failed', dispatched: true, reason: sent.reason, detail: sent.detail, identity, captured, selector }
  }

  // ---- VERIFY ---------------------------------------------------------------------------------
  // Whatever the page does in response is given a moment to happen, then the page is READ AGAIN.
  await sleep(opts.settleMs === undefined ? 250 : opts.settleMs)
  const verdict = await verifyClickEffect(session, { before: snapshot, identity, expect: opts.expect || {}, selector })
  return {
    ok: verdict.ok,
    outcome: verdict.ok ? 'applied' : verdict.unknown ? 'unknown' : 'failed',
    dispatched: true,
    clickedAt: { x: sent.cx, y: sent.cy },
    ...verdict,
    identity, captured, selector,
    // Stated explicitly so a caller never has to wonder whether a coordinate crossed the boundary.
    usedPreApprovalBox: false,
  }
}

/**
 * Decide whether a click had an effect. Pure-ish: it takes the post-click observation as a parameter
 * when one is supplied, so the rules can be tested without a browser.
 *
 * RETURN CONTRACT (a defect lived here): this function must return `ok` as well as `verified`. An
 * earlier version returned only `verified`, and `click()` read `verdict.ok` — so `undefined` propagated
 * and EVERY successful click was reported as `outcome: 'failed'` with an empty `problems` list. That
 * self-contradictory pair (failed, no reason given) is what a caller cannot diagnose; the two fields now
 * always agree, maintained by `settleVerdict` rather than by each branch remembering to.
 */
export async function verifyClickEffect (session, { before, identity, expect = {}, selector, after }) {
  const obs = after || await observePage(session, { limit: 400 })
  const settleVerdict = (v) => ({ ...v, ok: v.verified === true && v.unknown !== true })
  if (!obs.ok) {
    return settleVerdict({
      verified: false, unknown: obs.disconnected === true,
      how: [], problems: [`the page could not be observed after the click: ${obs.reason}`],
    })
  }
  const how = []
  const problems = []

  const urlChanged = obs.url !== before.url
  const titleChanged = obs.title !== before.title
  const textChanged = (obs.bodyText || '') !== before.bodyText
  const countsChanged = JSON.stringify(obs.counts) !== JSON.stringify(before.counts)
  if (urlChanged) how.push(`url=${String(obs.url).slice(0, 120)}`)
  if (titleChanged) how.push(`title=${JSON.stringify(obs.title)}`)
  if (textChanged) how.push('body-text-changed')
  if (countsChanged) how.push(`counts=${JSON.stringify(obs.counts)}`)

  // 1. Explicit expectations win, because they are what the caller actually meant.
  if (expect.urlIncludes && !String(obs.url).includes(expect.urlIncludes)) problems.push(`the URL does not contain ${JSON.stringify(expect.urlIncludes)}`)
  if (expect.appears) {
    const m = matchTarget(obs, expect.appears)
    if (!m.ok) problems.push(`the expected element did not appear: ${m.reason}`)
    else if (m.ambiguous) problems.push(`the expected element is ambiguous (${m.matches})`)
    else how.push('expected-element-appeared')
  }
  if (expect.disappears) {
    const m = matchTarget(obs, expect.disappears)
    if (m.ok && !m.ambiguous) problems.push('the element that was expected to disappear is still present')
    else how.push('expected-element-gone')
  }

  // 2. With no explicit expectation, ANY observed change is accepted as evidence that the click did
  //    something — but the absence of every change is NOT success. A click that provably did nothing is
  //    reported, never assumed to have worked because the events were dispatched.
  const observedChange = urlChanged || titleChanged || textChanged || countsChanged ||
    !obs.interactive.some(e => e.selector === selector)

  if (problems.length > 0) return settleVerdict({ verified: false, unknown: false, how, problems, url: obs.url, title: obs.title })
  const hadExplicitExpectation = Boolean(expect.appears || expect.disappears || expect.urlIncludes)
  if (hadExplicitExpectation) return settleVerdict({ verified: true, unknown: false, how, problems: [], url: obs.url, title: obs.title })
  if (!observedChange) {
    return settleVerdict({
      verified: false, unknown: true, how,
      problems: ['the click was dispatched but nothing observable changed - whether it took effect cannot be determined'],
      url: obs.url, title: obs.title,
      note: 'do not replay this click; re-observe and decide',
    })
  }
  return settleVerdict({ verified: true, unknown: false, how, problems: [], url: obs.url, title: obs.title })
}

// ---------------------------------------------------------------------------------------------
// TYPE
//
// SAME SHAPE AS CLICK, DIFFERENT SIDE EFFECT. The approval boundary, the revalidation rules and the
// "prove it from the live page" verification are all inherited unchanged — this function differs only in
// what it does at EXECUTE and what it accepts as evidence at VERIFY.
//
// THE SENSITIVE-DATA RULE IS STRUCTURAL HERE, NOT A LOGGING CONVENTION. A typed value is the one piece of
// this action a human may not want recorded (a token, an address, a search they would rather not publish),
// so the text NEVER enters the returned result, the registry detail, or any diagnostic. What is recorded
// is a length and a short non-reversible digest, and the digest exists only so a later VERIFY can prove
// the field holds what was sent without the value being recoverable from a log.
//
// READS ARE ALSO CONSTRAINED: the observation deliberately never reads a password field's value (see
// browser-observe.js), so VERIFY for a `type: 'password'` target cannot compare contents. That case is
// reported as verified-by-attribute rather than pretending a content comparison happened.
// ---------------------------------------------------------------------------------------------

/**
 * A short digest of the typed text, used to CONFIRM the value landed without recording it.
 *
 * DELEGATED TO THE OBSERVER, and it must stay delegated: the observer's `valueDigest` is salted with a
 * per-process random value, so a locally computed unsalted digest could never match it. When the salt was
 * first added on the observer side only, the comparison always failed — length matched, digest did not —
 * and every successful `browser_type` was reported as failed. One function now owns the algorithm.
 */
export function textDigest (text) {
  return digestValue(text)
}

/** Is this observed element something text can legitimately be typed into? */
export function isEditableTarget (el) {
  if (!el) return false
  const tag = String(el.tag || '').toLowerCase()
  if (tag === 'textarea') return true
  if (tag === 'input') {
    const t = String(el.inputType || 'text').toLowerCase()
    // Types that hold text. Everything else (checkbox, radio, submit, file, date…) is not a text target.
    return ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(t)
  }
  return false
}

/** Type into a node addressed by a selector, using the element's own live state, never a stale box. */
async function dispatchType (session, selector, value, { timeoutMs = 10_000, clear = true, submit = false } = {}) {
  // The value travels as a JSON literal inside the injected expression. Nothing about it is logged or
  // returned; only the RESULT of the attempt comes back.
  const expr = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: 'the element is gone' };
    const all = document.querySelectorAll(${JSON.stringify(selector)});
    if (all.length !== 1) return { ok: false, reason: 'the selector matches ' + all.length + ' elements' };
    if (el.disabled) return { ok: false, reason: 'the element is disabled' };
    if (el.readOnly) return { ok: false, reason: 'the element is read-only' };
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return { ok: false, reason: 'the element has no box' };
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return { ok: false, reason: 'the element is not visible' };
    if (el.focus) el.focus();
    if (document.activeElement !== el) return { ok: false, reason: 'the element could not take focus' };
    const before = typeof el.value === 'string' ? el.value : (el.textContent || '');
    return { ok: true, beforeLength: before.length, tag: el.tagName.toLowerCase(), inputType: el.type || null };
  })()`
  const pre = await session.send('Runtime.evaluate', { expression: expr, returnByValue: true }, timeoutMs)
  const pv = pre && pre.result && pre.result.value
  if (!pv || pv.ok !== true) return { ok: false, reason: (pv && pv.reason) || 'the target could not be focused for typing', targetType: pv && pv.tag }

  // The keystrokes are dispatched as real input events so page-level handlers (validation, live search,
  // masked inputs) see them. `Input.insertText` is avoided deliberately: it bypasses key events entirely
  // and would "succeed" on an input whose handlers reject the value.
  const typeExpr = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: 'the element went away before typing' };
    const value = ${JSON.stringify(String(value))};
    const clear = ${clear ? 'true' : 'false'};
    try {
      if (el.focus) el.focus();
      if (clear) {
        if (typeof el.value === 'string') {
          el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (el.isContentEditable) {
          // Select-all then delete keeps the edit inside the input pipeline, unlike assigning innerHTML.
          const sel = window.getSelection(); const rng = document.createRange();
          rng.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(rng);
          document.execCommand('delete');
        }
      }
      if (typeof el.value === 'string') {
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = value;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      } else {
        return { ok: false, reason: 'the element accepts no text' };
      }
      const after = typeof el.value === 'string' ? el.value : (el.textContent || '');
      return { ok: true, afterLength: after.length, tag: el.tagName.toLowerCase(), inputType: el.type || null,
               readOnly: !!el.readOnly, password: (el.type === 'password') };
    } catch (e) { return { ok: false, reason: 'typing failed: ' + e.message }; }
  })()`
  const post = await session.send('Runtime.evaluate', { expression: typeExpr, returnByValue: true }, timeoutMs)
  const tv = post && post.result && post.result.value
  if (!tv || tv.ok !== true) return { ok: false, reason: (tv && tv.reason) || 'the text could not be entered' }

  let submitted = false
  if (submit) {
    // Only ever reached when the caller explicitly asked; the form is submitted through the DOM so the
    // page's own submit handlers still run.
    const sub = await session.send('Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return { ok: false }; const f = el.form; if (f && f.requestSubmit) { f.requestSubmit(); return { ok: true, via: 'requestSubmit' }; } if (f) { f.submit(); return { ok: true, via: 'submit' }; } return { ok: false, reason: 'no owning form' }; })()`,
      returnByValue: true,
    }, timeoutMs)
    submitted = Boolean(sub && sub.result && sub.result.value && sub.result.value.ok)
  }
  return { ok: true, dispatched: true, targetType: tv.tag, inputType: tv.inputType, password: tv.password, beforeLength: pv.beforeLength, afterLength: tv.afterLength, submitted }
}

/**
 * Type text into a target on the attached page, with the same approval boundary click uses.
 *
 * @param {object} opts
 * @param {string} opts.text               the text to enter (NEVER echoed back in the result)
 * @param {object} opts.target             { role, name, text, selector, inputType } to resolve
 * @param {Function} [opts.beforeApprove]  test-only boundary hook (see browser-tools.js)
 * @param {object} [opts.expect]           what must be true afterwards
 * @param {object} [opts.identity]         a previously captured identity to revalidate instead of resolving
 */
export async function type (session, opts = {}) {
  const value = String(opts.text == null ? '' : opts.text)
  const digest = textDigest(value)
  // NOTE: `value` stays in this scope. It is not returned, not attached to `captured`, and not logged.
  if (!session || !session.connected) {
    return { ok: false, outcome: 'not-dispatched', dispatched: false, reason: 'browser session is not attached to a page', textLength: value.length, textDigest: digest }
  }

  // ---- PHASE 1: observe and capture a structural identity --------------------------------------
  const before = opts.observation || await observePage(session, { limit: opts.limit || 400 })
  if (!before.ok) {
    return {
      ok: false, outcome: 'not-dispatched', dispatched: false,
      code: before.disconnected ? 'DISCONNECTED' : 'REFRESH_REQUIRED',
      reason: `the page could not be observed: ${before.reason}`, textLength: value.length, textDigest: digest,
    }
  }
  const resolved = opts.identity ? { ok: true, match: null } : matchTarget(before, opts.target || {})
  if (!opts.identity) {
    if (!resolved.ok) {
      return { ok: false, outcome: 'not-dispatched', dispatched: false, code: 'TARGET_NOT_FOUND', reason: resolved.reason, url: before.url, textLength: value.length, textDigest: digest }
    }
    if (resolved.ambiguous) {
      return {
        ok: false, outcome: 'not-dispatched', dispatched: false, code: 'AMBIGUOUS',
        reason: `the target matches ${resolved.matches} elements; refusing to choose one`,
        alternatives: resolved.alternatives, url: before.url, textLength: value.length, textDigest: digest,
      }
    }
  }
  const identity = opts.identity || captureIdentity(resolved.match)
  const captured = { identity, urlAtCapture: before.url, titleAtCapture: before.title }
  const element = resolved.match

  if (element) {
    if (element.disabled) return { ok: false, outcome: 'not-dispatched', dispatched: false, code: 'TARGET_DISABLED', reason: 'the target is disabled', identity, url: before.url, textLength: value.length, textDigest: digest }
    if (!element.visible) return { ok: false, outcome: 'not-dispatched', dispatched: false, code: 'TARGET_INVISIBLE', reason: 'the target is not visible', identity, url: before.url, textLength: value.length, textDigest: digest }
    if (!element.selector) {
      return { ok: false, outcome: 'not-dispatched', dispatched: false, code: 'NO_STABLE_SELECTOR', reason: 'no selector could be proved unique for the target', identity, url: before.url, textLength: value.length, textDigest: digest }
    }
    // TYPE-SPECIFIC PRE-CHECK: refuse a target that cannot hold text, BEFORE approval is ever asked.
    if (!isEditableTarget(element)) {
      return {
        ok: false, outcome: 'not-dispatched', dispatched: false, code: 'TARGET_NOT_EDITABLE',
        reason: `the target is a <${element.tag}> that does not accept text`, identity, url: before.url,
        textLength: value.length, textDigest: digest,
      }
    }
  }

  // ---- the approval boundary ------------------------------------------------------------------
  if (typeof opts.beforeApprove === 'function') await opts.beforeApprove(captured)

  // ---- PHASE 2: re-observe and RE-PROVE the identity against the live DOM ----------------------
  const after = await observePage(session, { limit: opts.limit || 400 })
  if (!after.ok) {
    return {
      ok: false, outcome: after.disconnected ? 'unknown' : 'failed', dispatched: false,
      code: after.disconnected ? 'DISCONNECTED' : 'REFRESH_REQUIRED',
      reason: `the page could not be re-observed after approval: ${after.reason}`,
      identity, captured, textLength: value.length, textDigest: digest,
    }
  }
  const revalidated = revalidateIdentity(after, identity)
  if (!revalidated.ok) {
    return {
      ok: false, outcome: 'not-dispatched', dispatched: false,
      code: revalidated.code, reason: revalidated.reason, checks: revalidated.checks,
      identity, captured, url: after.url, title: after.title,
      note: 'the target could not be re-proved after approval, so no text was sent',
      textLength: value.length, textDigest: digest,
    }
  }
  const live = revalidated.element
  const selector = identity.selector || live.selector
  if (!selector) {
    return { ok: false, outcome: 'not-dispatched', dispatched: false, code: 'NO_STABLE_SELECTOR', reason: 'the revalidated target has no unique selector', identity, captured, textLength: value.length, textDigest: digest }
  }
  if (live.disabled) return { ok: false, outcome: 'not-dispatched', dispatched: false, code: 'TARGET_DISABLED', reason: 'the target became disabled after approval', identity, captured, textLength: value.length, textDigest: digest }
  if (!live.visible) return { ok: false, outcome: 'not-dispatched', dispatched: false, code: 'TARGET_INVISIBLE', reason: 'the target became invisible after approval', identity, captured, textLength: value.length, textDigest: digest }
  if (!isEditableTarget(live)) {
    return { ok: false, outcome: 'not-dispatched', dispatched: false, code: 'TARGET_NOT_EDITABLE', reason: `the target became a <${live.tag}> that does not accept text after approval`, identity, captured, textLength: value.length, textDigest: digest }
  }

  // ---- EXECUTE --------------------------------------------------------------------------------
  const snapshot = { url: after.url, title: after.title, bodyText: (after.bodyText || '').slice(0, 4000), counts: after.counts }
  let sent
  try {
    sent = await dispatchType(session, selector, value, { timeoutMs: opts.timeoutMs, clear: opts.clear !== false, submit: opts.submit === true })
  } catch (error) {
    if (error.disconnected) {
      // Text may or may not have landed. UNKNOWN, and never replayed: typing twice duplicates a value.
      return { ok: false, outcome: 'unknown', dispatched: true, disconnected: true, code: 'DISCONNECTED', reason: `the browser connection was lost while typing: ${error.message}`, identity, captured, selector, textLength: value.length, textDigest: digest }
    }
    return { ok: false, outcome: 'failed', dispatched: true, reason: `the text could not be sent: ${error.message}`, identity, captured, selector, textLength: value.length, textDigest: digest }
  }
  if (!sent.ok) {
    return { ok: false, outcome: 'failed', dispatched: true, reason: sent.reason, identity, captured, selector, textLength: value.length, textDigest: digest }
  }

  // ---- VERIFY ---------------------------------------------------------------------------------
  await sleep(opts.settleMs === undefined ? 250 : opts.settleMs)
  const verdict = await verifyTypeEffect(session, { before: snapshot, identity, expect: opts.expect || {}, selector, after: undefined, sentDigest: digest, sentLength: value.length, password: sent.password === true })
  return {
    ok: verdict.ok,
    outcome: verdict.ok ? 'applied' : verdict.unknown ? 'unknown' : 'failed',
    dispatched: true,
    targetType: sent.targetType,
    inputType: sent.inputType,
    submitted: sent.submitted,
    ...verdict,
    identity, captured, selector,
    // The text itself is deliberately absent; only its length and digest describe it.
    textLength: value.length, textDigest: digest,
    usedPreApprovalBox: false,
  }
}

/**
 * Decide whether typing had an effect, from the live page rather than from the dispatch returning.
 *
 * WHAT COUNTS AS SUCCESS: the target's own observable content is read back and compared with what was
 * sent (by digest, so the value is not needed to check it). A form whose value cannot be read at all —
 * a password field, which the observer refuses to read by design — is NOT reported as verified by content;
 * it is reported as verified by attribute with that limitation stated.
 */
export async function verifyTypeEffect (session, { before, identity, expect = {}, selector, after, sentDigest, sentLength, password = false }) {
  const obs = after || await observePage(session, { limit: 400 })
  const settleVerdict = (v) => ({ ...v, ok: v.verified === true && v.unknown !== true })
  if (!obs.ok) {
    return settleVerdict({
      verified: false, unknown: obs.disconnected === true,
      how: [], problems: [`the page could not be observed after typing: ${obs.reason}`],
    })
  }
  const how = []
  const problems = []

  const urlChanged = obs.url !== before.url
  const titleChanged = obs.title !== before.title
  const countsChanged = JSON.stringify(obs.counts) !== JSON.stringify(before.counts)
  if (urlChanged) how.push(`url=${String(obs.url).slice(0, 120)}`)
  if (titleChanged) how.push(`title=${JSON.stringify(obs.title)}`)
  if (countsChanged) how.push(`counts=${JSON.stringify(obs.counts)}`)

  // 1. Explicit expectations win — they are what the caller actually meant.
  if (expect.urlIncludes && !String(obs.url).includes(expect.urlIncludes)) problems.push(`the URL does not contain ${JSON.stringify(expect.urlIncludes)}`)
  if (expect.appears) {
    const m = matchTarget(obs, expect.appears)
    if (!m.ok) problems.push(`the expected element did not appear: ${m.reason}`)
    else if (m.ambiguous) problems.push(`the expected element is ambiguous (${m.matches})`)
    else how.push('expected-element-appeared')
  }
  if (expect.valueDigest) {
    const el = obs.interactive.find(e => e.selector === selector)
    if (!el) problems.push('the target is no longer observable, so its value cannot be checked')
    else if (el.valueDigest === expect.valueDigest) how.push(`value-digest=${el.valueDigest}`)
    else problems.push(`the target holds a different value (digest ${el.valueDigest || 'unknown'})`)
  }

  // 2. Read the target back. A password target is skipped EXPLICITLY and said so, rather than being
  //    silently treated as matching.
  const el = obs.interactive.find(e => e.selector === selector)
  if (password) {
    how.push('password-target: content not readable by design')
    if (el) how.push(`target-present-and-${el.disabled ? 'disabled' : 'enabled'}`)
  } else if (!el) {
    // The target vanishing is itself an observable change (a submit navigated, a live filter re-rendered).
    how.push('target-no-longer-present')
  } else if (el.valueDigest) {
    if (el.valueDigest === sentDigest) how.push(`value-digest-matches=${el.valueDigest}`)
    else problems.push(`the field holds ${el.valueLength} chars (digest ${el.valueDigest}) but ${sentLength} chars were sent`)
  } else {
    how.push('target-present (value not exposed by the page)')
  }

  if (problems.length > 0) return settleVerdict({ verified: false, unknown: false, how, problems, url: obs.url, title: obs.title })

  const hadExplicit = Boolean(expect.appears || expect.urlIncludes || expect.valueDigest)
  if (hadExplicit) return settleVerdict({ verified: true, unknown: false, how, problems: [], url: obs.url, title: obs.title })

  // 3. Without an explicit expectation, the page-level changes plus a matching value digest are the
  //    evidence. If nothing at all can be seen, the outcome is UNKNOWN, not success and not failure.
  const observedChange = urlChanged || titleChanged || countsChanged || !el
  const valueConfirmed = Boolean(el && el.valueDigest && el.valueDigest === sentDigest)
  if (valueConfirmed || observedChange) {
    return settleVerdict({ verified: true, unknown: false, how, problems: [], url: obs.url, title: obs.title })
  }
  return settleVerdict({
    verified: false, unknown: true, how,
    problems: ['the text was dispatched but the field value could not be confirmed and nothing else changed - whether it took effect cannot be determined'],
    url: obs.url, title: obs.title,
    note: 'do not retype; re-observe and decide',
  })
}

// ---------------------------------------------------------------------------------------------
// PRESS - keyboard input, scoped to ONE page
//
// WHAT THIS IS NOT: a Windows keyboard tool. Keys go to the attached page through CDP's input domain, so
// they cannot reach the desktop, another application, or Harness itself. That boundary is deliberate - a
// "press" that could reach the OS would let a page-scoped action type into the wrong program.
//
// THE HARD PART IS FOCUS, NOT KEY CODES. A key is delivered to whatever has focus at the instant it is
// sent, and between "I located the field" and "the key goes out" there is an approval decision, a human,
// and a fresh observation. So the focused element's identity is compared against the approved target
// immediately before dispatch, and a mismatch is refused rather than sent to the wrong place.
//
// KEYS ARE ALLOWLISTED. Only navigation/editing keys and the clipboard chords are accepted. Anything with a
// plausible OS-level meaning, or any chord not on the list, is refused with a reason instead of being
// forwarded on the theory that it is probably fine.
// ---------------------------------------------------------------------------------------------

/** The keys this tool will send. `code`/`keyCode` are what CDP needs for a real key event. */
const KEY_TABLE = Object.freeze({
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r', submits: true },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: null, movesFocus: true },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27, text: null },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8, text: null, edits: true },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46, text: null, edits: true },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, text: null },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, text: null },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, text: null },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, text: null },
  Home: { key: 'Home', code: 'Home', keyCode: 36, text: null },
  End: { key: 'End', code: 'End', keyCode: 35, text: null },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33, text: null },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34, text: null },
  'ctrl+a': { key: 'a', code: 'KeyA', keyCode: 65, modifiers: 2, text: null, selects: true },
  'ctrl+c': { key: 'c', code: 'KeyC', keyCode: 67, modifiers: 2, text: null, clipboard: true },
  'ctrl+v': { key: 'v', code: 'KeyV', keyCode: 86, modifiers: 2, text: null, clipboard: true },
  'shift+tab': { key: 'Tab', code: 'Tab', keyCode: 9, modifiers: 8, text: null, movesFocus: true },
})

/**
 * Keys that are still legitimate when NOTHING in the page has focus.
 *
 * WHY THIS SET EXISTS (defect found by the press suite, 2026-10-18): requiring a focused element for every
 * key refused the exact case Escape and Tab exist for. With a modal open, focus sits on the body element, and
 * an Escape delivered to the document is precisely what closes it - but the first implementation refused it
 * with NO_FOCUS because no ELEMENT was focused.
 *
 * The exception is deliberately narrow. It covers keys that cannot modify a field and cannot send anything:
 * dismissal, focus traversal and scrolling. Enter, Backspace, Delete and the clipboard chords are ABSENT on
 * purpose - with no field to own them their effect is unpredictable, and Enter without a known receiver is
 * the shape of an accidental submit.
 */
const SAFE_WITHOUT_FOCUS = new Set([
  'Escape', 'Tab', 'shift+tab',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
])

/** Normalise and validate a key request. Returns { ok, name, spec, reason }. */
export function resolveKey (requested) {
  const raw = String(requested == null ? '' : requested).trim()
  if (!raw) return { ok: false, reason: 'a key is required' }
  const lower = raw.toLowerCase().replace(/\s+/g, '')
  for (const [name, spec] of Object.entries(KEY_TABLE)) {
    if (name.toLowerCase() === lower) return { ok: true, name, spec }
  }
  return {
    ok: false,
    code: 'KEY_NOT_ALLOWED',
    reason: `the key ${JSON.stringify(raw)} is not on the allowlist; permitted keys are ${Object.keys(KEY_TABLE).join(', ')}`,
  }
}

/** Send one resolved key to the attached page. Nothing here decides WHETHER to send. */
async function dispatchKey (session, spec, { timeoutMs = 8_000 } = {}) {
  const mods = Number.isFinite(spec.modifiers) ? spec.modifiers : 0
  const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode, modifiers: mods }
  const frames = []
  // A chord needs its modifier held around the key, otherwise the page sees a bare letter rather than a
  // chord. Modifier-only frames are emitted only when a modifier is actually requested.
  if (mods & 2) frames.push({ type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 2 })
  if (mods & 8) frames.push({ type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, modifiers: 8 })
  frames.push({ ...base, type: 'keyDown', ...(spec.text == null ? {} : { text: spec.text }) })
  frames.push({ ...base, type: 'keyUp' })
  if (mods & 8) frames.push({ type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, nativeVirtualKeyCode: 16, modifiers: 0 })
  if (mods & 2) frames.push({ type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 0 })
  for (const frame of frames) await session.send('Input.dispatchKeyEvent', frame, timeoutMs)
  return { ok: true, dispatched: true }
}

/** Does the focus report describe the element this action was approved for? */
export function focusMatches (focus, identity) {
  if (!focus || focus.present !== true || !focus.identity) {
    return { ok: false, code: 'NO_FOCUS', reason: 'no element in the page has focus, so a key would go nowhere predictable' }
  }
  if (!identity) return { ok: true, how: ['focus-present'] }
  const want = identity.selector
  const got = focus.identity.selector
  if (!got) {
    return { ok: false, code: 'FOCUS_UNPROVABLE', reason: 'the focused element has no unique selector, so it cannot be proved to be the approved target' }
  }
  if (want && got !== want) {
    return { ok: false, code: 'FOCUS_CHANGED', reason: `focus is on ${got}, not on the approved target ${want}` }
  }
  if (identity.role && focus.identity.role !== identity.role) {
    return { ok: false, code: 'FOCUS_CHANGED', reason: `the focused element has role ${focus.identity.role}, not ${identity.role}` }
  }
  if (identity.name && focus.identity.name !== identity.name) {
    return { ok: false, code: 'FOCUS_CHANGED', reason: `the focused element is named ${JSON.stringify(focus.identity.name)}, not ${JSON.stringify(identity.name)}` }
  }
  return { ok: true, how: ['focus-selector-matches', ...(identity.name ? ['focus-name-matches'] : [])] }
}

/**
 * Press a key in the attached page, under the same approval boundary the other browser actions use.
 *
 * @param {object} opts
 * @param {string} opts.key              a key name from the allowlist
 * @param {object} [opts.target]         { role, name, selector } for the element expected to receive the key
 * @param {Function} [opts.beforeApprove] test-only boundary hook
 * @param {object} [opts.expect]         what must be true afterwards
 */
export async function press (session, opts = {}) {
  const resolvedKey = resolveKey(opts.key)
  if (!resolvedKey.ok) {
    return { ok: false, outcome: 'not-dispatched', dispatched: false, code: resolvedKey.code || 'INVALID_KEY', reason: resolvedKey.reason }
  }
  const { name: keyName, spec } = resolvedKey
  if (!session || !session.connected) {
    return { ok: false, outcome: 'not-dispatched', dispatched: false, code: 'DISCONNECTED', reason: 'browser session is not attached to a page', key: keyName }
  }

  // CLIPBOARD CHORDS NEED A NAMED RECEIVER (least-risk control, 2026-10-18).
  //
  // `ctrl+v` does not send data this tool chose - it pastes whatever is in the SYSTEM clipboard, which may
  // be a password the human copied a minute ago in another application. Letting that fire at "whatever
  // happens to be focused" makes the approval card a decision about an unnamed target, which is not a
  // decision anyone can make well. Requiring an explicit target means the approval names the field the
  // clipboard content will land in, and the focus check then proves the text goes there and nowhere else.
  //
  // `ctrl+c` is the mirror image: it copies the current SELECTION into the system clipboard, where other
  // applications can read it. The same rule applies - name the source, so the approval is about a specific
  // element rather than about the page in general. Neither chord reads or writes the clipboard on this side;
  // the tool never sees the content in either direction.
  const wantsNamedTarget = Boolean(opts.target && (opts.target.selector || opts.target.role || opts.target.name))
  if (spec.clipboard === true && !wantsNamedTarget) {
    return {
      ok: false, outcome: 'not-dispatched', dispatched: false, code: 'CLIPBOARD_REQUIRES_TARGET',
      reason: `${keyName} acts on the system clipboard, so it requires an explicit target (selector, role or name) naming the element it applies to`,
      key: keyName,
    }
  }

  // ---- PHASE 1: observe, and locate the intended receiver if one was named ---------------------
  const before = opts.observation || await observePage(session, { limit: opts.limit || 400 })
  if (!before.ok) {
    return {
      ok: false, outcome: 'not-dispatched', dispatched: false,
      code: before.disconnected ? 'DISCONNECTED' : 'REFRESH_REQUIRED',
      reason: `the page could not be observed: ${before.reason}`, key: keyName,
    }
  }
  let identity = null
  const wantsTarget = Boolean(opts.target && (opts.target.selector || opts.target.role || opts.target.name))
  if (wantsTarget) {
    const m = matchTarget(before, opts.target)
    if (!m.ok) {
      return { ok: false, outcome: 'not-dispatched', dispatched: false, code: 'TARGET_NOT_FOUND', reason: m.reason, url: before.url, key: keyName }
    }
    if (m.ambiguous) {
      return {
        ok: false, outcome: 'not-dispatched', dispatched: false, code: 'AMBIGUOUS',
        reason: `the target matches ${m.matches} elements; refusing to choose one`, alternatives: m.alternatives, url: before.url, key: keyName,
      }
    }
    if (m.match.disabled) return { ok: false, outcome: 'not-dispatched', dispatched: false, code: 'TARGET_DISABLED', reason: 'the target is disabled', url: before.url, key: keyName }
    if (!m.match.visible) return { ok: false, outcome: 'not-dispatched', dispatched: false, code: 'TARGET_INVISIBLE', reason: 'the target is not visible', url: before.url, key: keyName }
    identity = captureIdentity(m.match)
  }
  const captured = { identity, urlAtCapture: before.url, titleAtCapture: before.title, focusAtCapture: before.focus || null, key: keyName }

  // ---- the approval boundary ------------------------------------------------------------------
  if (typeof opts.beforeApprove === 'function') await opts.beforeApprove(captured)

  // ---- PHASE 2: re-observe, re-prove the target, and PROVE WHERE THE KEY WILL LAND -------------
  const after = await observePage(session, { limit: opts.limit || 400 })
  if (!after.ok) {
    return {
      ok: false, outcome: after.disconnected ? 'unknown' : 'failed', dispatched: false,
      code: after.disconnected ? 'DISCONNECTED' : 'REFRESH_REQUIRED',
      reason: `the page could not be re-observed after approval: ${after.reason}`, identity, captured, key: keyName,
    }
  }
  if (identity) {
    const rv = revalidateIdentity(after, identity)
    if (!rv.ok) {
      return {
        ok: false, outcome: 'not-dispatched', dispatched: false,
        code: rv.code, reason: rv.reason, checks: rv.checks, identity, captured,
        url: after.url, title: after.title, key: keyName,
        note: 'the target could not be re-proved after approval, so no key was sent',
      }
    }
    if (rv.element.disabled) return { ok: false, outcome: 'not-dispatched', dispatched: false, code: 'TARGET_DISABLED', reason: 'the target became disabled after approval', identity, captured, key: keyName }
    if (!rv.element.visible) return { ok: false, outcome: 'not-dispatched', dispatched: false, code: 'TARGET_INVISIBLE', reason: 'the target became invisible after approval', identity, captured, key: keyName }
  }

  // FOCUS IS THE LAST CHECK BEFORE THE KEY LEAVES. It is read from the SAME observation that just proved the
  // target, so it describes the page at dispatch time rather than at approval time.
  const focus = after.focus || null
  const unfocusedButSafe = !identity && SAFE_WITHOUT_FOCUS.has(keyName)
  const focusVerdict = unfocusedButSafe
    ? { ok: true, how: ['no-target-page-level-key'] }
    : focusMatches(focus, identity)
  if (!focusVerdict.ok) {
    return {
      ok: false, outcome: 'not-dispatched', dispatched: false,
      code: focusVerdict.code, reason: focusVerdict.reason,
      identity, captured, key: keyName, focus,
      note: 'focus could not be tied to the approved target, so no key was sent',
    }
  }

  // ---- EXECUTE --------------------------------------------------------------------------------
  const focusedEl = identity && identity.selector ? after.interactive.find(e => e.selector === identity.selector) : null
  const snapshot = {
    url: after.url, title: after.title, counts: after.counts,
    bodyText: (after.bodyText || '').slice(0, 4000),
    focusSelector: focus && focus.identity ? focus.identity.selector : null,
    selection: focus ? focus.selection : null,
    focusedValueLength: focusedEl && typeof focusedEl.valueLength === 'number' ? focusedEl.valueLength : null,
    focusedValueDigest: focusedEl && typeof focusedEl.valueDigest === 'string' ? focusedEl.valueDigest : null,
  }
  let sent
  try {
    sent = await dispatchKey(session, spec, { timeoutMs: opts.timeoutMs })
  } catch (error) {
    if (error.disconnected) {
      // The frames may have been partially delivered. UNKNOWN, and never replayed: a second Enter on a form
      // is a second submit, and a second Delete is a second deletion.
      return {
        ok: false, outcome: 'unknown', dispatched: true, disconnected: true, code: 'DISCONNECTED',
        reason: `the browser connection was lost while pressing ${keyName}: ${error.message}`,
        identity, captured, key: keyName,
      }
    }
    return { ok: false, outcome: 'failed', dispatched: true, reason: `the key could not be sent: ${error.message}`, identity, captured, key: keyName }
  }
  if (!sent.ok) {
    return { ok: false, outcome: 'failed', dispatched: true, reason: sent.reason, identity, captured, key: keyName }
  }

  // ---- VERIFY ---------------------------------------------------------------------------------
  await sleep(opts.settleMs === undefined ? 250 : opts.settleMs)
  const verdict = await verifyPressEffect(session, { before: snapshot, key: keyName, spec, expect: opts.expect || {}, identity })
  return {
    ok: verdict.ok,
    outcome: verdict.ok ? 'applied' : verdict.unknown ? 'unknown' : 'failed',
    dispatched: true,
    key: keyName,
    ...verdict,
    identity, captured,
    usedPreApprovalBox: false,
  }
}

/**
 * Decide whether a key had an effect, from the live page.
 *
 * A KEY CAN LEGITIMATELY DO NOTHING. Arrows on a page with no focus movement, Escape with no popup, End in
 * a field already at its end - none of those change anything observable, and none are failures. So "no
 * observable change" is reported as UNKNOWN: the tool cannot tell "the key did nothing" from "the key did
 * something it cannot see", and claiming either would be a guess. What it CAN prove - a URL change, a focus
 * move, a selection change, a value change, an explicit expectation - is reported as verified.
 */
export async function verifyPressEffect (session, { before, key, spec = {}, expect = {}, identity, after }) {
  const obs = after || await observePage(session, { limit: 400 })
  const settleVerdict = (v) => ({ ...v, ok: v.verified === true && v.unknown !== true })
  if (!obs.ok) {
    return settleVerdict({
      verified: false, unknown: obs.disconnected === true,
      how: [], problems: [`the page could not be observed after the key: ${obs.reason}`],
    })
  }
  const how = []
  const problems = []
  const focusAfter = obs.focus || null
  const focusSelectorAfter = focusAfter && focusAfter.identity ? focusAfter.identity.selector : null

  const urlChanged = obs.url !== before.url
  const titleChanged = obs.title !== before.title
  const countsChanged = JSON.stringify(obs.counts) !== JSON.stringify(before.counts)
  const bodyChanged = (obs.bodyText || '') !== before.bodyText
  const focusMoved = focusSelectorAfter !== before.focusSelector
  const selectionChanged = JSON.stringify(focusAfter ? focusAfter.selection : null) !== JSON.stringify(before.selection)
  const valueChanged = (() => {
    if (!identity || !identity.selector) return false
    const el = obs.interactive.find(e => e.selector === identity.selector)
    if (!el) return true
    if (typeof el.valueDigest === 'string' && typeof before.focusedValueDigest === 'string') return el.valueDigest !== before.focusedValueDigest
    if (typeof el.valueLength === 'number' && typeof before.focusedValueLength === 'number') return el.valueLength !== before.focusedValueLength
    return false
  })()

  if (urlChanged) how.push(`url=${String(obs.url).slice(0, 120)}`)
  if (titleChanged) how.push(`title=${JSON.stringify(obs.title)}`)
  if (countsChanged) how.push(`counts=${JSON.stringify(obs.counts)}`)
  if (bodyChanged) how.push('body-text-changed')
  if (focusMoved) how.push(`focus=${focusSelectorAfter || '(none)'} was=${before.focusSelector || '(none)'}`)
  if (selectionChanged && !focusMoved) how.push(`selection=${JSON.stringify(focusAfter && focusAfter.selection)}`)
  if (valueChanged) how.push('target-value-changed')

  if (expect.urlIncludes && !String(obs.url).includes(expect.urlIncludes)) problems.push(`the URL does not contain ${JSON.stringify(expect.urlIncludes)}`)
  if (expect.focusSelector) {
    if (focusSelectorAfter !== expect.focusSelector) problems.push(`focus is on ${focusSelectorAfter || '(none)'}, expected ${expect.focusSelector}`)
    else how.push(`expected-focus=${focusSelectorAfter}`)
  }
  if (expect.appears) {
    const m = matchTarget(obs, expect.appears)
    if (!m.ok) problems.push(`the expected element did not appear: ${m.reason}`)
    else if (m.ambiguous) problems.push(`the expected element is ambiguous (${m.matches})`)
    else how.push('expected-element-appeared')
  }

  if (problems.length > 0) return settleVerdict({ verified: false, unknown: false, how, problems, url: obs.url, title: obs.title })

  const hadExplicit = Boolean(expect.urlIncludes || expect.focusSelector || expect.appears)
  if (hadExplicit) return settleVerdict({ verified: true, unknown: false, how, problems: [], url: obs.url, title: obs.title })

  if (spec.movesFocus) {
    if (focusMoved) return settleVerdict({ verified: true, unknown: false, how, problems: [], url: obs.url, title: obs.title })
    return settleVerdict({
      verified: false, unknown: true, how,
      problems: ['the focus-moving key was sent but focus did not move - whether it took effect cannot be determined'],
      url: obs.url, title: obs.title, note: 'do not re-press; re-observe and decide',
    })
  }

  const changed = urlChanged || titleChanged || countsChanged || bodyChanged || focusMoved || selectionChanged || valueChanged
  if (changed) return settleVerdict({ verified: true, unknown: false, how, problems: [], url: obs.url, title: obs.title })
  return settleVerdict({
    verified: false, unknown: true, how,
    problems: [`the ${key} key was sent but nothing observable changed - whether it took effect cannot be determined`],
    url: obs.url, title: obs.title,
    note: 'do not re-press; re-observe and decide',
  })
}
