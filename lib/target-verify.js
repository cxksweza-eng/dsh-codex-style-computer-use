// ---------------------------------------------------------------------------------------------
// UIA selector re-validation (2026-10-16)
//
// THE PROBLEM THIS SOLVES. An approval card can stay open for seconds, and the human is expected to
// interact with the machine while it is up. Anything observed BEFORE the card appeared is therefore a
// hypothesis by the time the card settles: the window may have moved, the tab may have changed, the
// control may be gone or may now mean something different. Re-issuing the approved action against the
// stale observation is exactly the "old coordinates / old UIA reference" failure.
//
// WHAT A VERIFIER IS. A closure that re-proves, from CURRENT state, that the element the caller aimed
// at is still the same element. It returns { ok:true } only on positive evidence, and { ok:false,
// reason } otherwise. `lib/core/index.js` calls it before dispatching whenever a real handoff
// happened, and again before the single verified retry.
//
// THE RULES, in order of strictness:
//   1. NO BINDING  -> refuse. An unidentifiable target is never replayed.
//   2. WINDOW CHANGED (handle, owning process, or title) -> refuse, even if a same-named control
//      exists in the new window: the identity of what was approved is gone.
//   3. SELECTOR MUST RESOLVE TO EXACTLY ONE ELEMENT. Zero matches means the control disappeared;
//      more than one means uniqueness cannot be proven. Both refuse — a "probably the same one" pick
//      is a guess, and a guess is what this module exists to prevent.
//   4. TRUNCATED SEARCH -> refuse. A partial tree cannot prove uniqueness (mirrors the native
//      INCOMPLETE_UIA_SEARCH rule).
//   5. GEOMETRY IS ADVISORY, NEVER DECISIVE. Coordinates are reported for diagnostics but are not
//      compared: a control that legitimately moved is still the same control. Identity comes from
//      the selector + window witness, not from where it happens to sit.
// ---------------------------------------------------------------------------------------------

/** Build the "what did the caller aim at" record, BEFORE the approval card appears. */
export async function captureBinding (cu, args, toolName) {
  const a = args || {}
  const selector = a.id
    ? { by: 'automationId', id: String(a.id), role: a.role || null, nameContains: null }
    : a.name
      ? { by: 'nameSubstring', id: null, role: a.role || null, nameContains: String(a.name) }
      : a.role
        ? { by: 'role', id: null, role: a.role, nameContains: null }
        : null
  if (!selector) return null

  let witness = null
  if (Number.isFinite(a.hwnd)) {
    const info = await readWindow(cu, a.hwnd)
    witness = {
      hwnd: a.hwnd,
      pid: info ? (info.pid ?? null) : null,
      title: info && typeof info.title === 'string' ? info.title : null,
      className: info ? (info.class ?? info.className ?? null) : null,
      // Whether the window was readable AT CAPTURE TIME. Without this, a transient failure to read
      // the window would look identical to "read fine, no pid/title reported", and the comparison
      // rules would be skipped rather than applied.
      captured: info !== null,
    }
  }
  return { tool: toolName || null, selector, witness, capturedAt: Date.now() }
}

/**
 * Ask the worker about one window.
 *
 * INTEGRATION FIX (2026-10-16): the first version called `windowInfo`, an op that does not exist.
 * The real op is `windows`, which returns the whole inventory. The wrong name made every binding
 * carry `pid:null, title:null`, and because a null witness field skips its comparison, two of the
 * refusal rules below were silently DISABLED — a verifier that cannot see the window is worse than
 * no verifier, because it still answers `ok` for a window it never actually checked.
 */
async function readWindow (cu, hwnd) {
  try {
    const res = await cu.call('windows', {})
    const list = (res && Array.isArray(res.windows)) ? res.windows : []
    return list.find(w => Number(w.hwnd) === Number(hwnd)) || null
  } catch { return null }
}

/** Is this argument shape one a selector-binding can describe at all? */
export function hasSelector (args) {
  const a = args || {}
  return Boolean(a.id || a.name || a.role)
}

/**
 * Re-resolve `binding` against CURRENT state.
 * @returns {Promise<{ok:boolean, reason?:string, how?:string, match?:object}>}
 */
export async function resolveAndVerify (cu, binding) {
  if (!binding || !binding.selector) {
    return { ok: false, reason: 'no selector binding was captured for this target' }
  }
  const { selector, witness } = binding
  // A selector without a window handle cannot be scoped, so uniqueness across the whole desktop
  // cannot be established. Refuse rather than search everything.
  if (!witness || !Number.isFinite(witness.hwnd)) {
    return { ok: false, reason: 'the target selector has no window witness; scope it with hwnd or re-observe' }
  }

  // ---- rule 2: the window itself must still be the window that was approved ----
  const info = await readWindow(cu, witness.hwnd)
  if (!info) return { ok: false, reason: 'the target window no longer exists' }
  if (info.minimized) return { ok: false, reason: 'the target window is minimized' }
  if (witness.pid != null && info.pid != null && info.pid !== witness.pid) {
    return { ok: false, reason: `the window handle now belongs to a different process (pid ${info.pid} != ${witness.pid})` }
  }
  const nowTitle = typeof info.title === 'string' ? info.title : null
  if (witness.title != null && nowTitle != null && nowTitle !== witness.title) {
    return { ok: false, reason: `the window title changed ("${witness.title}" -> "${nowTitle}")` }
  }

  // ---- rules 3 & 4: re-query and prove uniqueness ----
  let res = null
  try {
    res = await cu.call('uia', {
      hwnd: witness.hwnd,
      role: selector.role || undefined,
      name: selector.nameContains || undefined,
      id: selector.id || undefined,
      depth: 24,
      maxNodes: 3500,
    })
  } catch (error) {
    return { ok: false, reason: `the accessibility tree could not be re-read (${error && error.message})` }
  }
  if (!res) return { ok: false, reason: 'the accessibility query returned nothing' }
  if (res.truncated === true) {
    return { ok: false, reason: 'the accessibility search was truncated, so uniqueness cannot be proven' }
  }
  // The worker answers with `elements`; older/other shapes use `flat`. Accept both rather than
  // reading the wrong key and concluding "the control is gone" — the exact silent-wrong-answer
  // failure this module exists to prevent.
  const list = Array.isArray(res.elements) ? res.elements
    : Array.isArray(res.flat) ? res.flat
      : []
  const matches = list.filter(el => matchElement(el, selector))
  if (matches.length === 0) {
    // An empty LIST is only meaningful if the scan actually covered the window.
    if (list.length === 0 && Number(res.count) === 0 && !Number.isFinite(res.count)) {
      return { ok: false, reason: 'the accessibility scan returned no elements at all; the target cannot be confirmed' }
    }
    return { ok: false, reason: 'the target control is no longer present in the window' }
  }
  if (matches.length > 1) {
    return { ok: false, reason: `${matches.length} controls match the selector; uniqueness cannot be proven` }
  }
  return { ok: true, how: `selector:${selector.by}`, match: describeMatch(matches[0]) }
}

/** The worker uses `automationId`; other shapes use `id`. Read whichever is present. */
function elementId (el) {
  if (!el) return ''
  const v = el.automationId !== undefined ? el.automationId : el.id
  return v === undefined || v === null ? '' : String(v)
}

function matchElement (el, selector) {
  if (!el) return false
  if (selector.id != null) {
    if (elementId(el) !== selector.id) return false
  }
  if (selector.nameContains != null) {
    const name = String(el.name ?? '')
    if (!name.includes(selector.nameContains)) return false
  }
  if (selector.role != null) {
    const role = String(el.role ?? '')
    if (role.toLowerCase() !== String(selector.role).toLowerCase()) return false
  }
  return true
}

function describeMatch (el) {
  return {
    id: elementId(el) || null,
    name: typeof el.name === 'string' ? el.name.slice(0, 90) : null,
    role: el.role ?? null,
    rect: el.rect ?? null,
  }
}
