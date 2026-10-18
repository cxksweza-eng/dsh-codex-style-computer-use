// ---------------------------------------------------------------------------------------------
// Browser observation (2026-10-16)
//
// WHAT THIS REPLACES: pixels. The Computer Use side has to infer "there is a button called Save at
// (412, 880)" from a screenshot, and a mis-measured coordinate is indistinguishable from a mis-click.
// A page does not require that inference — it will simply state the element's role, accessible name,
// bounds and disabled state if asked. So the FIRST observation mechanism here is structural, and a
// screenshot is a fallback for the cases structure cannot answer (canvas, WebGL, image-only controls).
//
// THE INVARIANT THAT MAKES TARGETS SAFE: every element this module reports carries a `selector` that
// was PROVED UNIQUE at observation time. An ambiguous selector is not returned as "probably fine" — it
// is either disambiguated or the element is reported without one, so a later revalidation can refuse
// instead of clicking the wrong node. This is the browser equivalent of the UIA rule that a selector
// must resolve to exactly one control.
//
// Everything runs inside the page via `Runtime.evaluate` with `returnByValue`, so the traversal cost is
// paid once in V8 rather than as hundreds of CDP round-trips.
// ---------------------------------------------------------------------------------------------

import { randomBytes } from 'node:crypto'

/**
 * One random salt per process, for the value digests the observation reports.
 *
 * WHY A SALT IS REQUIRED, not merely nice to have: an unsalted FNV-1a digest of a low-entropy secret is
 * recoverable. `6:1a2b3c4d` over a six-digit code has a million candidates and can be enumerated in
 * milliseconds, so the digest would be a weaker version of the plaintext rather than a substitute for it.
 * Mixing in a value that exists only in this process makes the digest un-invertible from any transcript,
 * while leaving it perfectly comparable between two observations taken by the SAME process - which is the
 * only property the verification path depends on.
 */
const DIGEST_SALT = randomBytes(16).toString('hex')

/**
 * The Node-side twin of the page's fnv1a.
 *
 * WHY IT MUST SHARE THE SALT: browser_type computes the digest of the text it is about to send, then
 * compares it with the valueDigest the observer reports from inside the page. If one side salted and the
 * other did not the comparison could never succeed - which is exactly what happened when the salt was added
 * here first: the length matched, the digest did not, and every successful type was reported as failed.
 * Both sides now run the same function over the same salted input.
 */
export function digestValue (value) {
  const raw = String(value == null ? '' : value)
  const s = DIGEST_SALT + '\u0000' + raw
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return `${raw.length}:${h.toString(16).padStart(8, '0')}`
}

/** The in-page collector. Kept as a single expression so it executes atomically and returns JSON. */
const COLLECT_SCRIPT = `(() => {
  const MAX = %LIMIT%;
  // A short digest, so a typed value can be CHECKED without being RECORDED: the type and press actions
  // compare digests instead of text, so a field's contents never reach a log line.
  //
  // SALTED ON PURPOSE. An unsalted FNV-1a of a low-entropy value (a four-digit PIN, a six-digit code) is
  // not a one-way function in any useful sense: given a 6-char digest an attacker can enumerate the
  // million candidates offline and recover the value. The salt is generated once per process in Node and
  // passed in here; it is never logged, never returned, and never written to disk, so a digest that
  // appears in a transcript cannot be inverted without the process that produced it. Digests stay
  // COMPARABLE across observations in the same process, which is the only property verification needs.
  const SALT = %SALT%;
  const fnv1a = (s) => {
    const str = SALT + '\\u0000' + String(s == null ? '' : s);
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return String(s == null ? '' : s).length + ':' + h.toString(16).padStart(8, '0');
  };
  const INTERACTIVE = new Set(['a','button','input','select','textarea','summary','option','label']);
  const ROLE_HINT = {
    a:'link', button:'button', input:'textbox', select:'combobox', textarea:'textbox',
    summary:'button', option:'option', label:'label', h1:'heading', h2:'heading', h3:'heading',
    img:'img', nav:'navigation', main:'main', header:'banner', footer:'contentinfo', form:'form',
  };

  const isVisible = (el) => {    // getClientRects() is empty for display:none AND for detached nodes, which is exactly the set a
    // caller must not try to click. offsetParent misses position:fixed, so both are consulted.
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return false;
    if (el.hasAttribute && el.hasAttribute('hidden')) return false;
    return true;
  };

  /**
   * A CONTROL'S CURRENT VALUE IS NOT ITS NAME. This is the accessible-name rule, not a privacy tweak:
   * for a text input the value is the CONTENT, and the name comes from a label, an aria-labelledby, a
   * placeholder or a title. The earlier version fell back to 'el.value', so an unlabelled field reported
   * whatever the user had typed as that field's 'name' - a search box, an OTP field or a token input
   * echoed its contents into every observation, and observations are exactly what reaches a model
   * context and a session log. The fallback is now removed outright rather than filtered for
   * "sensitive-looking" fields, because the tool cannot know which ordinary text field holds something
   * the human would rather not publish.
   *
   * Password and hidden fields were already excluded from every value read; that stays true.
   */
  const NEVER_READ_VALUE = (el) => {
    const t = el.tagName.toLowerCase()
    if (t !== 'input' && t !== 'textarea') return false
    const type = (el.getAttribute && el.getAttribute('type') || 'text').toLowerCase()
    return type === 'password' || type === 'hidden'
  };

  const accName = (el) => {
    // Precedence follows the accessible-name computation: explicit labelling wins, then visible text.
    // The value of a form control is deliberately NOT part of this chain.
    const al = el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'));
    if (al && al.trim()) return al.trim();
    const lb = el.getAttribute && el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\\s+/).map(id => { const n = document.getElementById(id); return n ? (n.textContent || '').trim() : ''; }).filter(Boolean).join(' ');
      if (t) return t;
    }
    if (el.labels && el.labels.length) {
      const t = Array.from(el.labels).map(l => (l.textContent || '').trim()).filter(Boolean).join(' ');
      if (t) return t;
    }
    const ph = el.getAttribute && el.getAttribute('placeholder');
    // A form control carries no label text of its own, so its textContent is not a name either.
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      if (ph && ph.trim()) return ph.trim();
      if (el.getAttribute && el.getAttribute('alt')) return el.getAttribute('alt');
      return '';
    }
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text) return text.slice(0, 200);
    if (ph && ph.trim()) return ph.trim();
    if (el.getAttribute && el.getAttribute('alt')) return el.getAttribute('alt');
    return '';
  };

  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (el.id && /^[A-Za-z][\\w\\-:.]*$/.test(el.id) && document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
      return '#' + el.id;
    }
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 8) {
      let part = cur.tagName.toLowerCase();
      const dt = cur.getAttribute && cur.getAttribute('data-testid');
      if (dt) { parts.unshift('[data-testid="' + dt + '"]'); break; }
      const name = cur.getAttribute && cur.getAttribute('name');
      if (name) { part += '[name="' + name + '"]'; }
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      const candidate = parts.join(' > ');
      try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch (e) { return null; }
      cur = parent;
    }
    const joined = parts.join(' > ');
    try { return document.querySelectorAll(joined).length === 1 ? joined : null; } catch (e) { return null; }
  };

  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute && el.getAttribute('role')) || ROLE_HINT[tag] || tag;
    const disabled = Boolean(el.disabled) || (el.getAttribute && el.getAttribute('aria-disabled') === 'true');
    const sel = cssPath(el);
    const out = {
      tag, role,
      name: accName(el),
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200) || null,
      selector: sel,
      selectorUnique: sel ? document.querySelectorAll(sel).length === 1 : false,
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      visible: isVisible(el),
      disabled,
    };
    if (tag === 'input') {
      out.inputType = el.type || 'text';
      // A password field's VALUE is never read; only the fact that it is one is reported, so a caller
      // can route it to the high-risk approval path without the secret ever entering a log.
      if (el.type === 'password') out.sensitive = true;
    }
    // VALUE EVIDENCE WITHOUT VALUE EXPOSURE. The type action must be able to prove that what it sent is
    // what the field now holds, and it must do that without the value becoming readable in a log. So the
    // observation reports a LENGTH and a short DIGEST instead of the text. Password and hidden fields are
    // excluded outright: for those even a length is a fact about a secret, so both are null.
    if (tag === 'input' || tag === 'textarea') {
      const type = String(el.type || 'text').toLowerCase();
      if (type === 'password' || type === 'hidden') {
        out.valueLength = null;
        out.valueDigest = null;
      } else {
        const v = typeof el.value === 'string' ? el.value : '';
        out.valueLength = v.length;
        out.valueDigest = fnv1a(v);
      }
    } else if (el.isContentEditable) {
      const v = el.textContent || '';
      out.contentEditable = true;
      out.valueLength = v.length;
      out.valueDigest = fnv1a(v);
    }
    if (tag === 'a' && el.href) out.href = String(el.href).slice(0, 500);
    return out;
  };

  const all = Array.from(document.querySelectorAll('*'));
  const interactive = [];
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute && el.getAttribute('role')) || '';
    const clickable = el.hasAttribute && (el.hasAttribute('onclick') || el.hasAttribute('tabindex'));
    if (INTERACTIVE.has(tag) || clickable || ['button','link','textbox','checkbox','tab','menuitem','combobox','radio','switch'].includes(role)) {
      const d = describe(el);
      if (d.visible || !d.visible) interactive.push(d);
      if (interactive.length >= MAX) break;
    }
  }

  const headings = [];
  for (const el of document.querySelectorAll('h1,h2,h3,[role="heading"]')) {
    const t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (t) headings.push({ level: Number(el.tagName.slice(1)) || null, text: t.slice(0, 160) });
    if (headings.length >= 40) break;
  }

  const forms = [];
  for (const f of document.querySelectorAll('form')) {
    forms.push({
      selector: cssPath(f),
      action: f.getAttribute('action') || null,
      method: (f.getAttribute('method') || 'get').toLowerCase(),
      fields: Array.from(f.querySelectorAll('input,select,textarea')).slice(0, 40).map(describe),
    });
    if (forms.length >= 20) break;
  }

  let frames = [];
  try { frames = Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.getAttribute('src') || null, selector: cssPath(f) })); } catch (e) {}

  // FOCUS AND SELECTION. Added for the keyboard path, which must never send a key while unsure where it
  // will land. A key goes to whatever is focused NOW, and "the element I located earlier" can be a
  // different element than "the element that has focus" - a distinction that only shows up as text
  // appearing in the wrong field. Reporting the focused element's identity, and whether the document has
  // focus at all, is what lets the press path refuse instead of guessing.
  const focusInfo = (() => {
    const el = document.activeElement;
    const body = document.body;
    const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : null;
    if (!el || el === body || el === document.documentElement) {
      return { present: false, identity: null, tag: el ? el.tagName.toLowerCase() : null, isBody: el === body, hasFocus };
    }
    const sel = cssPath(el);
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    let selection = null;
    try {
      const type = String(el.type || '').toLowerCase();
      if (typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number') {
        // A password field never exposes selection offsets: those are a fact about a secret too.
        if (type !== 'password') selection = { start: el.selectionStart, end: el.selectionEnd };
      } else if (el.isContentEditable) {
        const s = window.getSelection();
        if (s && s.rangeCount > 0) selection = { start: s.anchorOffset, end: s.focusOffset };
      }
    } catch (e) { selection = null; }
    return {
      present: true,
      identity: {
        selector: sel,
        selectorUnique: sel ? document.querySelectorAll(sel).length === 1 : false,
        tag,
        role: (el.getAttribute && el.getAttribute('role')) || ROLE_HINT[tag] || null,
        name: accName(el),
        inputType: el.type || null,
        contentEditable: Boolean(el.isContentEditable),
      },
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      selection,
      hasFocus,
    };
  })();

  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    viewport: { width: innerWidth, height: innerHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) },
    documentSize: {
      width: Math.max(document.documentElement ? document.documentElement.scrollWidth : 0, innerWidth),
      height: Math.max(document.documentElement ? document.documentElement.scrollHeight : 0, innerHeight),
    },
    counts: { elements: all.length, interactive: interactive.length, forms: forms.length, frames: frames.length },
    headings,
    interactive,
    forms,
    frames,
    focus: focusInfo,
    bodyText: (document.body ? (document.body.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 4000) : ''),
  };
})()`

/**
 * Observe the attached page.
 *
 * Returns a structured description, never a screenshot. A caller that needs an image asks for one
 * explicitly, so the expensive and ambiguous channel is never entered by accident.
 */
export async function observePage (session, { limit = 300, timeoutMs = 20_000 } = {}) {
  if (!session) {
    return { ok: false, disconnected: true, reason: 'there is no browser session' }
  }
  if (!session.connected) {
    // `disconnected` IS SET HERE ON PURPOSE. A caller has to be able to tell "the page answered and had
    // nothing to say" from "there was no page to ask". Without this flag the second case looks like an
    // ordinary empty observation, and an action that might already have landed gets classified as a
    // definite failure — which is how a retry gets authorised for something that may already have
    // happened. An integration test caught exactly that: a connection lost after the target was captured
    // was reported as FAILED/REFRESH_REQUIRED instead of UNKNOWN.
    return {
      ok: false, disconnected: true,
      reason: session.targetId
        ? 'the browser connection was lost'
        : 'the browser session is not attached to a page',
    }
  }
  const script = COLLECT_SCRIPT
    .replace('%LIMIT%', String(Math.max(1, Math.min(2000, limit))))
    .replace('%SALT%', JSON.stringify(DIGEST_SALT))
  let res
  try {
    res = await session.send('Runtime.evaluate', {
      expression: script, returnByValue: true, awaitPromise: false,
    }, timeoutMs)
  } catch (error) {
    // A disconnected socket is reported as such so the caller can distinguish "the page is gone" from
    // "the page answered but had nothing to say".
    if (error.disconnected) return { ok: false, reason: 'the browser connection was lost while observing', disconnected: true }
    return { ok: false, reason: `observation failed: ${error.message}` }
  }
  const ex = res && res.exceptionDetails
  if (ex) return { ok: false, reason: `page threw while observing: ${(ex.exception && ex.exception.description) || ex.text || 'unknown'}` }
  const value = res && res.result && res.result.value
  if (!value || typeof value !== 'object') return { ok: false, reason: 'the page returned no observation payload' }

  // A page can navigate between the evaluate and the identity read. The identity that matters for a
  // later revalidation is the one the browser reports NOW, so it is read separately and the mismatch is
  // surfaced rather than hidden.
  const page = await session.currentPage()
  return {
    ok: true,
    page: page ? { id: page.id, title: page.title, url: page.url } : null,
    ...value,
    // If the two URLs disagree the document changed mid-observation; the caller must re-observe.
    stable: page ? (page.url === value.url) : false,
  }
}

/**
 * Rank the observed elements against a target description. Pure function — no browser access — so the
 * matching rules can be tested and reasoned about on their own.
 *
 * PRECEDENCE is deliberately identity-first (role + accessible name), then label/text, then an explicit
 * selector, and only then geometry. A caller may pass `index` to choose among otherwise-equal matches,
 * but ambiguity is REPORTED rather than silently resolved.
 */
export function matchTarget (observation, target = {}) {
  const list = (observation && Array.isArray(observation.interactive)) ? observation.interactive : []
  const want = {
    role: target.role ? String(target.role).toLowerCase() : null,
    name: target.name ? String(target.name) : null,
    text: target.text ? String(target.text) : null,
    selector: target.selector ? String(target.selector) : null,
    hrefIncludes: target.hrefIncludes ? String(target.hrefIncludes) : null,
    inputType: target.inputType ? String(target.inputType).toLowerCase() : null,
  }
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase()
  const scored = []
  for (const el of list) {
    let score = 0
    const reasons = []
    if (want.selector) {
      if (el.selector && el.selector === want.selector) { score += 100; reasons.push('selector') }
      else continue   // an explicit selector that does not match is not a candidate at all
    }
    if (want.role) {
      if (norm(el.role) === want.role || norm(el.tag) === want.role) { score += 40; reasons.push('role') }
      else continue
    }
    if (want.name) {
      const a = norm(el.name)
      if (a === norm(want.name)) { score += 50; reasons.push('name-exact') }
      else if (a.includes(norm(want.name))) { score += 30; reasons.push('name-substring') }
      else continue
    }
    if (want.text) {
      const t = norm(el.text)
      if (t === norm(want.text)) { score += 25; reasons.push('text-exact') }
      else if (t.includes(norm(want.text))) { score += 15; reasons.push('text-substring') }
      else continue
    }
    if (want.hrefIncludes) {
      if (el.href && String(el.href).toLowerCase().includes(norm(want.hrefIncludes))) { score += 20; reasons.push('href') }
      else continue
    }
    if (want.inputType) {
      if (norm(el.inputType) === want.inputType) { score += 20; reasons.push('inputType') }
      else continue
    }
    if (score === 0) continue   // geometry alone is not an identity
    if (el.disabled) reasons.push('disabled')
    if (!el.visible) reasons.push('invisible')
    scored.push({ score, reasons, element: el })
  }
  scored.sort((a, b) => b.score - a.score)
  if (scored.length === 0) return { ok: false, reason: 'no observed element matches the target', candidates: 0 }
  const top = scored[0].score
  const best = scored.filter(s => s.score === top)
  return {
    ok: true,
    ambiguous: best.length > 1,
    matches: best.length,
    match: best[0].element,
    why: best[0].reasons,
    alternatives: scored.slice(1, 6).map(s => ({ score: s.score, why: s.reasons,
      element: { role: s.element.role, name: s.element.name, selector: s.element.selector, rect: s.element.rect } })),
  }
}
