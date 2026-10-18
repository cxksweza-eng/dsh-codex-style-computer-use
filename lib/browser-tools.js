// ---------------------------------------------------------------------------------------------
// browser_* tools (2026-10-16)
//
// THE POINT OF THIS FILE IS THE WRAPPER, NOT THE TOOLS. Every browser action with a side effect must
// produce the same lifecycle as a `computer_*` action, and a per-tool copy of that lifecycle is how the
// Computer Use side ended up with a registry that silently did nothing. So there is ONE wrapper
// (`runBrowserAction`) and every tool body is a few lines inside it.
//
// WHAT THE WRAPPER GUARANTEES, in order:
//   1. a registry record exists and is published as the pending action BEFORE anything can ask for
//      approval — so the approval audit line and the registry record carry the SAME id and can be
//      joined, which is the correlation the Computer Use side is still missing;
//   2. `beginDispatch` claims the single dispatch slot BEFORE the side effect is sent, so a second
//      attempt on the same action id is refused rather than replayed;
//   3. the terminal state comes from the OUTCOME the action reports, not from whether an exception was
//      thrown — `unknown` maps to UNKNOWN, which is terminal for dispatch, so an unconfirmed action is
//      never silently retried;
//   4. the pending action is retired only if it is still this action.
//
// WHAT IT DELIBERATELY DOES NOT DO: implement approval. Approval already exists — `policyDecision` in
// `lib/policy.js` decides, the host's `approval/request` waterfall asks, and the plugin's existing hook
// arms the native approval hold. Browser tools opt into that machinery by name; they do not build a
// second gate. This is the "do not create a second safety system" rule expressed as code.
// ---------------------------------------------------------------------------------------------

import { getSharedRegistry } from './action-registry.js'
import { navigate, click, type, press, alreadyThere } from './browser-actions.js'
import { observePage, matchTarget } from './browser-observe.js'

/** Tool names whose side effects require an approval decision under the existing policy. */
export const BROWSER_ACTUATION_TOOLS = new Set(['browser_navigate', 'browser_click', 'browser_type', 'browser_press'])
/** Tool names that only read. */
export const BROWSER_OBSERVATION_TOOLS = new Set(['browser_observe', 'browser_tabs', 'browser_verify', 'browser_wait', 'browser_open', 'browser_close'])

/**
 * The test-only approval-boundary hook, reachable exclusively in-process.
 *
 * WHY A SYMBOL: a host invokes a tool with arguments parsed from JSON, and JSON has no representation
 * for a Symbol-keyed property. So this key cannot be supplied by any real caller — not by the model, not
 * by a crafted payload — while an integration test that imports this module can set it directly. The
 * hook is called by `click()` at exactly one place, after the target identity has been captured and
 * before the post-approval observation, so it can create the DOM change that an approval decision would
 * otherwise leave to chance; it cannot skip revalidation, alter the target, or change policy.
 */
export const BROWSER_TEST_BOUNDARY = Symbol.for('dsh.computerUse.browserTestBoundary')

/**
 * Map a browser action's own outcome vocabulary onto the registry's terminal states.
 *
 * WHY NOT REUSE `stateForError` HERE: that function is written for the Computer Use worker, whose
 * outcomes are failures and whose only success path is a direct `transition(VERIFIED)` by the caller.
 * Handed a browser success ('applied') it falls through to its `default` branch and returns FAILED —
 * so a navigation that PROVED it arrived would have been recorded as a failure. The mismatch is in the
 * vocabulary, not in the state machine, so it is resolved here rather than by editing the registry core.
 */
function terminalForOutcome (outcome) {
  switch (outcome) {
    case 'applied':
    case 'verified': return 'VERIFIED'
    case 'unknown': return 'UNKNOWN'
    case 'not-dispatched': return null        // nothing was sent; the action is still APPROVED
    case 'cancelled': return 'CANCELLED'
    case 'human-handoff': return 'HUMAN_HANDOFF'
    case 'failed':
    default: return 'FAILED'
  }
}

/**
 * A tool result must be LOSSLESS JSON — DSH rejects the call otherwise, with
 * `tool "browser_click" returned invalid output: value is not lossless JSON`.
 *
 * WHY THE RECORD CANNOT SIMPLY BE RETURNED: `action-registry.js` gives every record a back-reference
 * (`registry: this`) so a holder of the record can always reach the machine governing it. That is
 * deliberate and load-bearing — it fixed a live wiring bug — but it also makes the record a CYCLE, and a
 * cycle is not JSON. Sanitising at the boundary keeps the back-reference where it is needed and keeps it
 * out of the wire format.
 *
 * The copy is also restricted to JSON-safe fields on purpose: `undefined` members and `NaN`/`Infinity`
 * are the other two ways a value stops round-tripping, and a tool result silently missing a field is
 * harder to debug than one that was never offered.
 *
 * @param {object|null} rec a registry record, or null/undefined
 */

/**
 * Emit an informational line through whichever logger shape the caller supplied.
 *
 * WHY THIS EXISTS (regression caught by the suite, 2026-10-16): `runBrowserAction` is handed the
 * plugin's logger OBJECT by the tool registration (`log.info(...)`), but the tests and the default
 * parameter use a plain FUNCTION (`log(msg)`). Writing `log.info(...)` unconditionally therefore threw
 * `TypeError: log.info is not a function` and broke both browser suites. Accepting either shape removes
 * the trap instead of picking one shape and requiring every caller to comply.
 */
function logInfo (log, message) {
  if (!log) return
  if (typeof log === 'function') { log(message); return }
  if (typeof log.info === 'function') { log.info(message); return }
  if (typeof log.log === 'function') log.log(message)
}

function snapshotRecord (rec) {
  if (!rec || typeof rec !== 'object') return null
  return {
    id: rec.id ?? null,
    tool: rec.tool ?? null,
    // D4: the Host call id this record belongs to, so a caller can join the tool result to the audit
    // trail without either id being rewritten.
    hostCallId: rec.hostCallId ?? null,
    state: rec.state ?? null,
    attempts: Number.isFinite(rec.attempts) ? rec.attempts : 0,
    dispatches: Number.isFinite(rec.dispatches) ? rec.dispatches : 0,
    createdAt: Number.isFinite(rec.createdAt) ? rec.createdAt : null,
    transitions: Array.isArray(rec.transitions)
      ? rec.transitions.map(t => ({
          from: t && t.from !== undefined ? t.from : null,
          to: t && t.to !== undefined ? t.to : null,
          at: t && Number.isFinite(t.at) ? t.at : null,
          note: t && t.note !== undefined ? String(t.note) : null,
        }))
      : [],
  }
}

/**
 * Run one browser action under the shared lifecycle.
 *
 * @param {object} p
 * @param {import('./action-registry.js').ActionRegistry} p.registry
 * @param {string} p.tool                     tool name, used for the action id
 * @param {object} p.args                     the tool arguments (recorded on the action)
 * @param {object} p.target                   target identity, when the action has one
 * @param {(act:object) => Promise<object|null>} [p.precheck] decides whether anything needs sending.
 *        Returning a result object short-circuits the action WITHOUT claiming a dispatch slot; returning
 *        null/undefined means "proceed". This exists because of a measured defect (D3): a check that
 *        lived inside `run` could only answer AFTER `beginDispatch` had already spent the single
 *        dispatch slot, so "the page is already there" consumed the slot and then left the record stuck
 *        in EXECUTING — a state that is neither terminal nor dispatchable.
 * @param {(act:object) => Promise<object>} p.run   performs the dispatch; must return { ok, outcome, ... }
 */
export async function runBrowserAction ({ registry, tool, args = {}, target = null, precheck = null, run, log = () => {} }) {
  const reg = registry || getSharedRegistry({ log })
  const record = reg.create(tool, { args, target })
  // D4 CORRELATION LINE. The audit trail names this call by its HOST call id (the only id that exists
  // when approval is asked); this line names the same call by its REGISTRY action id. Logged together,
  // the pair is joinable from either side without either id being changed or discarded.
  logInfo(log, `browser-use: action ${record.id}${record.hostCallId ? ` <-> hostCallId=${record.hostCallId}` : ' (no host call id)'}`)
  // Publish BEFORE any approval can be asked. This is the ordering the approval hook needs in order to
  // name the action by the same id the registry knows it by.
  reg.pendingAction = record

  const act = { id: record.id, tool, action: record, registry: reg, target, startedAt: Date.now() }
  // WHAT `dispatches` ACTUALLY COUNTS. It is incremented inside `beginDispatch()`, BEFORE the caller is
  // allowed to send anything - that ordering is what makes a second dispatch impossible even mid-flight.
  // So it counts CLAIMS OF THE SINGLE DISPATCH SLOT, not CDP calls and not side effects. A NO_FOCUS refusal
  // therefore legitimately shows `dispatches: 1` while nothing was sent, which reads like a contradiction.
  // Rather than change the counter (that would break the idempotency guarantee and every existing reader),
  // the snapshot now states both facts explicitly. `dispatches` keeps its old meaning and old value.
  const describe = (rec, sideEffectSent) => {
    const snap = snapshotRecord(rec)
    if (!snap) return snap
    snap.dispatchClaimed = snap.dispatches > 0
    snap.sideEffectSent = sideEffectSent === true
    return snap
  }
  let result
  try {
    // ---- NOTHING-TO-DO FIRST, BEFORE THE SLOT IS CLAIMED ---------------------------------------
    // `precheck` runs while the record is still CREATED, so an action that decides not to send anything
    // never touches the dispatch counter and never enters EXECUTING.
    if (typeof precheck === 'function') {
      const skip = await precheck(act)
      if (skip) {
        const outcome = skip.outcome || 'not-dispatched'
        const terminal = terminalForOutcome(outcome)
        if (terminal) reg.transition(record.id, terminal, `precheck: ${skip.reason || outcome}`)
        return {
          ...skip,
          actionId: record.id,
          dispatched: false,
          verified: false,
          outcome,
          registry: describe(reg.get(record.id), false),
        }
      }
    }

    // Claim the single dispatch slot BEFORE the side effect. If the registry refuses, nothing is sent.
    const claim = reg.beginDispatch(record.id)
    if (!claim || claim.ok !== true) {
      return {
        ok: false, actionId: record.id, dispatched: false, outcome: 'not-dispatched',
        error: claim && claim.reason ? claim.reason : 'the action may not be dispatched',
        registry: describe(reg.get(record.id), false),
      }
    }

    // CLAIMING THE SLOT AND SENDING THE SIDE EFFECT ARE DIFFERENT FACTS. The claim always succeeds on
    // a fresh action, but the action may still refuse before it sends anything — a bad URL, a missing
    // target. Reporting `dispatched:true` for those would tell a caller a side effect might have landed
    // when nothing left the process, and would invert the meaning of the flag that `not-dispatched`
    // outcomes depend on. An integration test caught exactly that.
    result = await run(act)

    const rawOutcome = (result && result.outcome) || (result && result.ok ? 'applied' : 'failed')
    // `not-dispatched` means the action claimed the slot but then sent nothing. That leaves the record in
    // EXECUTING, which is not a terminal state, so it is settled to CANCELLED: the action is over, it
    // performed no side effect, and the slot it consumed stays consumed. Leaving EXECUTING here was the
    // second half of D3.
    // THE BUG THIS REPLACES (measured on the real instance, 2026-10-16): the first version read
    // `terminalForOutcome(rawOutcome === 'not-dispatched' ? null : rawOutcome) || 'CANCELLED'`. Passing
    // `null` falls through to that function's `default`, which returns the TRUTHY string 'FAILED' — so
    // `||` short-circuited and the CANCELLED branch was dead code. A refusal that sent NOTHING was
    // recorded as a FAILURE. The mapping is now explicit and cannot fall through.
    let terminal
    if (rawOutcome === 'not-dispatched') terminal = 'CANCELLED'
    else terminal = terminalForOutcome(rawOutcome)
    if (terminal) reg.transition(record.id, terminal, `outcome=${rawOutcome}`)

    const sideEffectSent = !(result && result.dispatched === false)
    return {
      ...result,
      actionId: record.id,
      // `result.dispatched === false` is the action saying it never sent anything; the claim does not
      // override that. Anything else (including an action that does not report the flag) was sent.
      dispatched: sideEffectSent,
      verified: Boolean(result && result.verified),
      registry: describe(reg.get(record.id), sideEffectSent),
    }
  } catch (error) {
    // An exception is not automatically UNKNOWN — only a lost connection makes the side effect's fate
    // genuinely unknown. Everything else is a definite failure and is recorded as one.
    const disconnected = Boolean(error && error.disconnected)
    const outcome = disconnected ? 'unknown' : 'failed'
    try { reg.transition(record.id, terminalForOutcome(outcome), `threw: ${error && error.message}`) } catch { /* never mask the original error */ }
    return {
      ok: false, actionId: record.id, dispatched: true, outcome,
      error: (error && error.message) || String(error),
      disconnected,
      // An action that threw while sending may well have emitted frames: the connection-loss case reports
      // `dispatched: true` for exactly that reason, so this path is a real send unless proven otherwise.
      registry: describe(reg.get(record.id), true),
    }
  } finally {
    if (reg.pendingAction === record) reg.pendingAction = null
  }
}

// ---------------------------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------------------------

const P = (type, description, extra = {}) => ({ type, description, ...extra })

/**
 * The tool-result contract DSH's `defineTool` actually compiles.
 *
 * WHAT WAS WRONG (third defect in this file, found by the load marker): an earlier version returned
 * `{ parse: (v) => v }`. `defineTool` hands the result spec to `valueSchemaSpecToJsonSchema`, which
 * requires a VALUE SCHEMA under `schema` — with `parse` alone there is nothing to compile, and it raised
 * `JsonSchemaError: unsupported JSON schema: schema must be a value schema object`. That throw happens
 * during `apply()`, so cordis swallowed it and the WHOLE plugin disappeared. The shape below is taken
 * from the `cu_*` tools in `enhanced-tools.js`, which register through the same `defineTool` and work.
 */
const out = (render) => ({ schema: { type: 'object', additionalProperties: true }, render })
const outJSON = () => out((_a, v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }])

/**
 * NOTE ON `parameters` (a mistake corrected here): the parameter object is a MAP OF PARAMETER NAME to
 * VALUE SCHEMA. Adding `additionalProperties` at its top level — as an earlier revision of this file did
 * — makes it a parameter whose schema is the boolean `false`, which `defineTool` rejects with
 * `parameters.additionalProperties must be a value schema object`. The `additionalProperties` that
 * `tools.js` mentions belongs INSIDE an object-typed schema node (an output value, or an object-typed
 * parameter), which is exactly how `exposure.js` and `enhanced-tools.js` use it. A plain parameter map
 * therefore needs no such key, and none of this plugin's working tools declare one.
 */

/**
 * @param {object} p
 * @param {import('./browser-session.js').BrowserSession} p.session
 * @param {Function} p.defineTool
 * @param {Function} p.register
 * @param {import('./action-registry.js').ActionRegistry} p.registry
 * @param {Function} p.log
 */
export function registerBrowserTools ({ session, defineTool, register, registry, log = () => {} }) {
  const def = (spec) => {
    const t = defineTool({ ...spec, output: spec.output || outJSON() })
    register(t)
    return t
  }

  // -------------------------------------------------------------------------------------------
  def({
    name: 'browser_open',
    description: 'Ensure a debuggable Chromium browser is available and attach to a page. Launches one with a dedicated profile when nothing is listening. Observation only; no approval needed.',
    parameters: {
      attach: P('boolean', 'also attach to a page target (default true)'),
      targetId: P('string', 'attach to this specific page target'),
      urlIncludes: P('string', 'attach to the page whose URL contains this'),
      startUrl: P('string', 'URL to open when the plugin has to launch the browser'),
      timeoutMs: P('number', 'launch/attach budget in milliseconds'),
    },
    timeoutMs: 40_000,
    isConcurrencySafe: () => false,
    async execute (args = {}) {
      const ensured = await session.ensure({ startUrl: args.startUrl, timeoutMs: args.timeoutMs })
      if (!ensured.ok) return { ok: false, stage: 'ensure', ...ensured }
      if (args.attach === false) return { ok: true, stage: 'ensure', ...ensured }
      const attached = await session.attach({ targetId: args.targetId, urlIncludes: args.urlIncludes })
      return attached.ok
        ? { ok: true, stage: 'attach', browser: ensured.browser, target: attached.target, launched: ensured.launched }
        : { ok: false, stage: 'attach', browser: ensured.browser, ...attached }
    },
  })

  // -------------------------------------------------------------------------------------------
  def({
    name: 'browser_tabs',
    description: 'List the browser\'s page targets and say which one is attached. Observation only.',
    parameters: {},
    timeoutMs: 15_000,
    isConcurrencySafe: () => true,
    async execute () {
      const tabs = await session.tabs()
      if (tabs === null) return { ok: false, reason: `no debuggable browser on port ${session.port}` }
      return { ok: true, count: tabs.length, attachedTargetId: session.targetId, tabs }
    },
  })

  // -------------------------------------------------------------------------------------------
  def({
    name: 'browser_observe',
    description: 'Read the attached page as structure: url, title, readyState, headings, forms, and every interactive element with role, accessible name, a UNIQUELY PROVED css selector, bounding box, visibility and disabled state. Password and hidden field values are never read. Observation only; no approval needed.',
    parameters: {
      limit: P('number', 'maximum interactive elements to return (default 300)'),
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute (args = {}) {
      const obs = await observePage(session, { limit: args.limit || 300 })
      return obs
    },
  })

  // -------------------------------------------------------------------------------------------
  def({
    name: 'browser_navigate',
    description: 'Navigate the attached page to a URL and PROVE it arrived. Success is decided by re-observing the page (url, title, readyState, and any expected element) — never by Page.navigate returning. Navigations that cannot be confirmed are reported as UNKNOWN and must not be replayed.',
    parameters: {
      url: P('string', 'destination URL', { required: true }),
      expectUrlIncludes: P('string', 'require the resulting URL to contain this'),
      expectTitleIncludes: P('string', 'require the resulting title to contain this'),
      expectTitleEquals: P('string', 'require the resulting title to equal this exactly'),
      expectElementRole: P('string', 'require an element with this role to be present afterwards'),
      expectElementName: P('string', 'require an element with this accessible name'),
      expectElementSelector: P('string', 'require this exact selector to be present'),
      allowSameUrl: P('boolean', 'permit navigating to the URL already loaded (default false)'),
      timeoutMs: P('number', 'load budget in milliseconds'),
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute (args = {}) {
      return runBrowserAction({
        registry, tool: 'browser_navigate', args, log,
        target: { url: args.url },
        // Runs BEFORE the dispatch slot is claimed: a navigation to the URL already loaded has nothing
        // to send, so it must not consume the slot nor enter EXECUTING.
        precheck: () => alreadyThere(session, args.url, { allowSameUrl: args.allowSameUrl === true }),
        run: async () => {
          const expect = {}
          if (args.expectUrlIncludes) expect.urlIncludes = args.expectUrlIncludes
          if (args.expectTitleIncludes) expect.titleIncludes = args.expectTitleIncludes
          if (args.expectTitleEquals) expect.titleEquals = args.expectTitleEquals
          if (args.expectElementRole || args.expectElementName || args.expectElementSelector) {
            expect.element = {
              role: args.expectElementRole,
              name: args.expectElementName,
              selector: args.expectElementSelector,
            }
          }
          const r = await navigate(session, {
            url: args.url,
            timeoutMs: args.timeoutMs,
            expect,
            allowSameUrl: args.allowSameUrl === true,
          })
          return r
        },
      })
    },
  })

  // -------------------------------------------------------------------------------------------
  def({
    name: 'browser_click',
    description: 'Click a target on the attached page. The target is resolved STRUCTURALLY (role, accessible name, text, or a selector proved unique) — never by remembered coordinates. The identity is captured before approval and RE-PROVED against the live DOM after it, so a page that changed while the human was deciding is refused rather than clicked at a stale location. Success is decided by re-observing the page, never by the click events being dispatched.',
    parameters: {
      role: P('string', 'target role, e.g. button'),
      name: P('string', 'target accessible name (exact match preferred)'),
      text: P('string', 'target visible text'),
      selector: P('string', 'exact css selector for the target'),
      hrefIncludes: P('string', 'for links: href must contain this'),
      expectUrlIncludes: P('string', 'after the click the URL must contain this'),
      expectAppearsRole: P('string', 'after the click an element with this role must appear'),
      expectAppearsName: P('string', 'after the click an element with this accessible name must appear'),
      expectDisappearsName: P('string', 'after the click an element with this accessible name must be gone'),
      settleMs: P('number', 'how long to let the page react before verifying (default 250)'),
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute (args = {}) {
      return runBrowserAction({
        registry, tool: 'browser_click', args, log,
        target: { role: args.role, name: args.name, text: args.text, selector: args.selector, hrefIncludes: args.hrefIncludes },
        run: async () => {
          const expect = {}
          if (args.expectUrlIncludes) expect.urlIncludes = args.expectUrlIncludes
          if (args.expectAppearsRole || args.expectAppearsName) {
            expect.appears = { role: args.expectAppearsRole, name: args.expectAppearsName }
          }
          if (args.expectDisappearsName) expect.disappears = { name: args.expectDisappearsName }
          const r = await click(session, {
            target: { role: args.role, name: args.name, text: args.text, selector: args.selector, hrefIncludes: args.hrefIncludes },
            expect,
            settleMs: args.settleMs,
            // TEST-ONLY BOUNDARY HOOK. Keyed by a Symbol, which is reachable ONLY from in-process code
            // that imports the symbol — a host tool call arrives as parsed JSON, and JSON cannot express
            // a Symbol key, so no caller of `browser_click` can supply this. That is deliberate: the
            // hook exists so an integration test can mutate the page at the exact instant the approval
            // boundary creates, instead of guessing at scheduler timing (which produced a test that was
            // correct or incorrect depending on how the event loop happened to interleave). It cannot
            // bypass approval, change the target, alter policy, or skip revalidation: `click()` calls it
            // at one point only, and everything after it still has to pass revalidation.
            beforeApprove: args[BROWSER_TEST_BOUNDARY] || undefined,
          })
          return r
        },
      })
    },
  })

  // -------------------------------------------------------------------------------------------
  def({
    name: 'browser_type',
    description: 'Type text into a field on the attached page. The target is resolved STRUCTURALLY and re-proved against the live DOM after approval, so a field that changed while the human was deciding is refused rather than typed into. Success is decided by reading the field back, never by the input events being dispatched. The typed text is never echoed in the result, the registry or any log - only its length and a short digest, which confirms the value landed without recording it.',
    parameters: {
      text: P('string', 'the text to enter (never echoed back)', { required: true }),
      role: P('string', 'target role, e.g. textbox'),
      name: P('string', 'target accessible name (exact match preferred)'),
      selector: P('string', 'exact css selector for the target'),
      inputType: P('string', 'require this input type, e.g. email'),
      clear: P('boolean', 'clear the field before typing (default true)'),
      submit: P('boolean', 'submit the owning form after typing (default false)'),
      expectUrlIncludes: P('string', 'after typing the URL must contain this'),
      expectAppearsName: P('string', 'after typing an element with this accessible name must appear'),
      settleMs: P('number', 'how long to let the page react before verifying (default 250)'),
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute (args = {}) {
      return runBrowserAction({
        registry, tool: 'browser_type', args, log,
        target: { role: args.role, name: args.name, selector: args.selector, inputType: args.inputType },
        run: async () => {
          const expect = {}
          if (args.expectUrlIncludes) expect.urlIncludes = args.expectUrlIncludes
          if (args.expectAppearsName) expect.appears = { name: args.expectAppearsName }
          const r = await type(session, {
            text: args.text == null ? '' : args.text,
            target: { role: args.role, name: args.name, selector: args.selector, inputType: args.inputType },
            expect,
            clear: args.clear !== false,
            submit: args.submit === true,
            settleMs: args.settleMs,
            // TEST-ONLY BOUNDARY HOOK - the same Symbol the click tool uses. A host tool call arrives as
            // parsed JSON and JSON cannot express a Symbol key, so no real caller can supply it; an
            // in-process test can. It is called at exactly one point (after the identity is captured,
            // before the post-approval observation) and cannot skip revalidation or alter policy.
            beforeApprove: args[BROWSER_TEST_BOUNDARY] || undefined,
          })
          return r
        },
      })
    },
  })

  // -------------------------------------------------------------------------------------------
  def({
    name: 'browser_press',
    description: 'Press one key in the attached page. Keys go to the PAGE through CDP, never to the desktop or another application, and only an allowlist of navigation/editing keys and clipboard chords is accepted. The receiver is proved twice: the target identity is re-validated after approval, and the FOCUSED element is compared against that target immediately before the key is sent, so a focus change during the approval detour refuses instead of typing into the wrong field. Success is decided from the live page, and a key that produces no observable change is reported as UNKNOWN rather than assumed to have worked. CLIPBOARD NOTE: ctrl+v pastes whatever is currently in the SYSTEM clipboard (this tool never reads it) and ctrl+c copies the current selection into it; both require an explicit target so the approval names the element involved.',
    parameters: {
      key: P('string', 'Enter | Tab | Escape | Backspace | Delete | ArrowUp | ArrowDown | ArrowLeft | ArrowRight | Home | End | PageUp | PageDown | ctrl+a | ctrl+c | ctrl+v | shift+tab', { required: true }),
      role: P('string', 'role of the element expected to receive the key'),
      name: P('string', 'accessible name of the element expected to receive the key'),
      selector: P('string', 'exact css selector of the element expected to receive the key'),
      expectUrlIncludes: P('string', 'after the key the URL must contain this'),
      expectFocusSelector: P('string', 'after the key focus must be on this selector'),
      expectAppearsName: P('string', 'after the key an element with this accessible name must appear'),
      settleMs: P('number', 'how long to let the page react before verifying (default 250)'),
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute (args = {}) {
      return runBrowserAction({
        registry, tool: 'browser_press', args, log,
        target: { role: args.role, name: args.name, selector: args.selector },
        run: async () => {
          const expect = {}
          if (args.expectUrlIncludes) expect.urlIncludes = args.expectUrlIncludes
          if (args.expectFocusSelector) expect.focusSelector = args.expectFocusSelector
          if (args.expectAppearsName) expect.appears = { name: args.expectAppearsName }
          const r = await press(session, {
            key: args.key,
            target: { role: args.role, name: args.name, selector: args.selector },
            expect,
            settleMs: args.settleMs,
            // TEST-ONLY BOUNDARY HOOK - the same Symbol the click and type tools use. A host tool call
            // arrives as parsed JSON and JSON cannot express a Symbol key, so no real caller can supply it.
            beforeApprove: args[BROWSER_TEST_BOUNDARY] || undefined,
          })
          return r
        },
      })
    },
  })

  // -------------------------------------------------------------------------------------------
  def({
    name: 'browser_verify',
    description: 'Re-observe the page and check whether a described target is present RIGHT NOW. Reports verified, ambiguous, missing, or invisible/disabled, with the reasons. Use after an action to decide whether it actually took effect.',
    parameters: {
      role: P('string', 'expected role'),
      name: P('string', 'expected accessible name'),
      text: P('string', 'expected text'),
      selector: P('string', 'exact css selector'),
      hrefIncludes: P('string', 'link href must contain this'),
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute (args = {}) {
      const obs = await observePage(session, {})
      if (!obs.ok) return { ok: false, verified: false, reason: obs.reason, disconnected: obs.disconnected === true }
      const m = matchTarget(obs, args)
      if (!m.ok) return { verified: false, how: 'not-found', reason: m.reason, url: obs.url, title: obs.title }
      return {
        verified: m.ambiguous !== true,
        ambiguous: m.ambiguous === true,
        matches: m.matches,
        how: `match:${m.why.join(',')}`,
        match: { role: m.match.role, name: m.match.name, selector: m.match.selector, visible: m.match.visible, disabled: m.match.disabled, rect: m.match.rect },
        alternatives: m.alternatives,
        url: obs.url,
        title: obs.title,
      }
    },
  })

  return { BROWSER_ACTUATION_TOOLS, BROWSER_OBSERVATION_TOOLS }
}
