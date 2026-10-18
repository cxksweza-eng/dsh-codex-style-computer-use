// ---------------------------------------------------------------------------------------------
// cu_* 鈥?the enhanced tool surface (2026-10-16)
//
// These are the tools the user asked for (`cu_observe` / `cu_verify` / `cu_execute`). They are NOT a
// second computer-use implementation: every one of them delegates to the existing ComputerUse core,
// so UIA, Win32, input injection, DPI handling, the approval gate, the human-handoff machinery and
// the action registry all keep working through the same paths the `computer_*` tools use.
//
// The `computer_*` tools are untouched and remain the primary surface. The value these add is a
// single call that carries the whole observe 鈫?act 鈫?verify contract, plus the ability to ask the
// registry what happened to an action.
//
// NAMING: registered under `cu_`, so nothing here can shadow a `computer_*` tool. The two families
// coexist by design.
// ---------------------------------------------------------------------------------------------

import { captureBinding, resolveAndVerify, hasSelector } from './target-verify.js'

/**
 * Register the cu_* tools. Returns the registered definitions so the caller can log them.
 * `defineTool` and `register` follow the same contract the computer_* tools use.
 */
export function registerEnhancedTools ({ cu, defineTool, register, actionRegistry, log }) {
  const out = []
  const txt = (v) => [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }]
  const outJSON = () => ({ schema: { type: 'object', additionalProperties: true }, render: (_a, v) => txt(v) })
  const P = (type, description, extra = {}) => ({ type, description, ...extra })

  const reg = (def) => {
    const definition = defineTool(def)
    if (register) register(definition)
    out.push(definition.name)
    return definition
  }

  // -------------------------------------------------------------------------------------------
  // cu_observe 鈥?one cheap, structured read of the world.
  //
  // Deliberately ONE call rather than three: window inventory, foreground identity and a scoped UIA
  // scan of the window the caller names (or the active one). It is read-only, so it is never gated by
  // the driving receipt and never requires approval 鈥?an agent that cannot look cannot decide.
  // -------------------------------------------------------------------------------------------
  reg({
    name: 'cu_observe',
    description: 'Structured observation in one call: window inventory, foreground window, cursor, and a UIA scan of the chosen window. Read-only and never approval-gated. ' +
      'Pass hwnd to scope the scan; omit it to follow the active window. Use depth to deepen a scan that came back truncated.',
    parameters: {
      hwnd: P('number', 'window to scan; omit for the active window'),
      depth: P('number', 'UIA tree depth, 1-24 (default 8)'),
      windows: P('boolean', 'include the full window inventory (default true)'),
      noUia: P('boolean', 'skip the accessibility scan entirely (cheapest)'),
    },
    output: outJSON(),
    isConcurrencySafe: () => false,
    timeoutMs: 30_000,
    async execute (args = {}) {
      const wantWindows = args.windows !== false
      const windows = wantWindows ? await cu.call('windows', {}) : null
      let cursor = null
      try { cursor = await cu.call('cursor', {}) } catch { cursor = null }
      const target = Number.isFinite(args.hwnd)
        ? args.hwnd
        : (windows && Array.isArray(windows.windows) ? (windows.windows.find(w => w.active) || {}).hwnd : undefined)
      let uia = null
      let uiaError = null
      if (!args.noUia && Number.isFinite(target)) {
        try {
          uia = await cu.call('uia', { hwnd: target, depth: clampDepth(args.depth), maxNodes: 1200 })
        } catch (error) { uiaError = String((error && error.message) || error) }
      }
      const active = windows && Array.isArray(windows.windows) ? (windows.windows.find(w => w.active) || null) : null
      return {
        observed: true,
        at: Date.now(),
        foreground: active ? { hwnd: active.hwnd, pid: active.pid, title: active.title, process: active.process } : null,
        cursor,
        scannedHwnd: Number.isFinite(target) ? target : null,
        // `truncated` is reported rather than hidden: a partial tree must never be read as "the
        // control is absent" (the same rule the native INCOMPLETE_UIA_SEARCH refusal encodes).
        uia: uia ? { count: uia.count ?? (Array.isArray(uia.flat) ? uia.flat.length : null), truncated: uia.truncated === true, flat: uia.flat ?? [] } : null,
        uiaError,
        windows: windows ? windows.windows : null,
        hint: uia && uia.truncated === true ? 'the scan was truncated 鈥?raise depth or scope the query before concluding a control is absent' : null,
      }
    },
  })

  // -------------------------------------------------------------------------------------------
  // cu_verify 鈥?re-prove a target, or ask what happened to an action.
  //
  // Two jobs, one tool, because they answer the same question from two directions:
  //   * with a target (id/name/role + hwnd): re-resolve it from CURRENT state and report whether it is
  //     still uniquely identifiable. This is the same verifier the approval path uses, exposed so a
  //     caller can check BEFORE acting instead of discovering staleness after a refusal.
  //   * with an actionId (or none, for the most recent): report the registry's state and dispatch
  //     count 鈥?the authoritative answer to "has this action already been sent?".
  // Read-only.
  // -------------------------------------------------------------------------------------------
  reg({
    name: 'cu_verify',
    description: 'Verify before acting. With hwnd + id/name/role it re-resolves the target from CURRENT state and reports whether it is still uniquely identifiable. ' +
      'With actionId (or no target) it reports the action registry state and dispatch count, which is the authoritative answer to "has this already been sent?". Read-only.',
    parameters: {
      hwnd: P('number', 'window that should still own the target'),
      id: P('string', 'exact AutomationId to re-resolve'),
      name: P('string', 'control name substring to re-resolve'),
      role: P('string', 'control type the target must still have'),
      actionId: P('string', 'registry id to report; omit to report the most recent action'),
    },
    output: outJSON(),
    isConcurrencySafe: () => false,
    timeoutMs: 20_000,
    async execute (args = {}) {
      const report = { verified: null, reason: null, how: null, match: null, action: null }
      if (hasSelector(args)) {
        const binding = await captureBinding(cu, args, 'cu_verify')
        const verdict = await resolveAndVerify(cu, binding)
        report.verified = verdict.ok === true
        report.reason = verdict.reason || null
        report.how = verdict.how || null
        report.match = verdict.match || null
        report.binding = binding && binding.witness ? { hwnd: binding.witness.hwnd, pid: binding.witness.pid, title: binding.witness.title, selector: binding.selector } : null
      } else if (!args.actionId) {
        report.reason = 'no target selector and no actionId were supplied; nothing to verify'
      }
      if (actionRegistry) {
        const id = args.actionId || (actionRegistry && actionRegistry.pendingAction && actionRegistry.pendingAction.id)
        const snap = id ? actionRegistry.snapshot(id) : null
        report.action = snap
        if (snap) {
          report.actionMayDispatch = actionRegistry.canDispatch(snap.id).ok
          report.actionDispatchRefusalReason = actionRegistry.canDispatch(snap.id).reason || null
        } else if (args.actionId) {
          report.reason = `unknown actionId ${args.actionId}`
        }
      }
      return report
    },
  })

  // -------------------------------------------------------------------------------------------
  // cu_execute 鈥?carry one action through observe 鈫?approve 鈫?settle 鈫?validate 鈫?dispatch.
  //
  // This is the `computer_*` actuation path with the target binding captured and re-proved
  // explicitly, so the contract is visible in ONE call: the identity is recorded before the approval
  // card can appear, the registry claims the single dispatch, and a handoff forces re-validation
  // rather than a replay. It delegates to the same `cu.actuate`/tool bodies 鈥?it is not a parallel
  // implementation of input.
  // -------------------------------------------------------------------------------------------
  reg({
    name: 'cu_execute',
    description: 'Drive one action through the full pipeline: capture the target identity, take the approval gate, settle after human input, RE-VALIDATE the target, dispatch exactly once, then report the registry state. ' +
      'Actions: move | click | key | type. For a selector target pass hwnd + id/name/role; a coordinate target is never re-validated and is refused after a handoff.',
    parameters: {
      action: P('string', 'move | click | key | type', { required: true }),
      at: P('string', '"x,y" for move/click'),
      hwnd: P('number', 'window owning the target (required for selector targets)'),
      id: P('string', 'exact AutomationId of the target'),
      name: P('string', 'control name substring of the target'),
      role: P('string', 'control type of the target'),
      combo: P('string', 'key combo for action:"key"'),
      text: P('string', 'text for action:"type"'),
      clicks: P('number', 'click count, 1-3'),
      button: P('string', 'left | right | middle'),
      allowPassword: P('boolean', 'human consented to typing into a password field'),
      // IDEMPOTENCY PROBE. Supplying an existing `actionId` re-uses that action's registry record
      // instead of minting a new one. The registry has then already spent its single dispatch, so the
      // call is refused with ALREADY_DISPATCHED and NOTHING is sent 鈥?which is precisely the
      // guarantee being tested. Without this the "one action, one dispatch" rule could only be
      // verified by reading a report, never by attempting the replay.
      actionId: P('string', 're-use an existing action id (the registry will refuse a second dispatch)'),
    },
    output: outJSON(),
    isConcurrencySafe: () => false,
    timeoutMs: 120_000,
    async execute (args = {}, exec) {
      const action = String(args.action || '').toLowerCase()
      const registry = actionRegistry || null
      let record = registry ? registry.create(`cu_execute:${action}`, { action }) : null
      let reusing = false
      if (registry && args.actionId) {
        const existing = registry.get(String(args.actionId))
        if (!existing) throw new Error(`unknown actionId ${args.actionId}`)
        record = existing
        reusing = true
      }
      const act = {
        signal: exec && exec.signal,
        budget: Math.max(1_000, Math.min(5_000, Math.floor(30_000 * 0.4))),
        retried: false,
        action: record,
        registry,
        binding: null,
        verifyReady: null,
        verify: null,
      }
      const result = { action, actionId: record ? record.id : null, reusingExistingAction: reusing, dispatched: false }
      try {
        if (hasSelector(args)) {
          act.verifyReady = captureBinding(cu, args, `cu_execute:${action}`).then(b => { act.binding = b })
          act.verify = async () => { await act.verifyReady; return resolveAndVerify(cu, act.binding) }
        }
        const run = async () => {
          switch (action) {
            case 'move': {
              const p = point(args.at)
              if (!p) throw new Error('move requires at:"x,y"')
              return cu.move(p.x, p.y, act)
            }
            case 'click': {
              const p = point(args.at)
              if (!p) throw new Error('click requires at:"x,y"')
              return cu.click({ x: p.x, y: p.y }, { button: args.button, clicks: args.clicks }, act)
            }
            case 'key': {
              if (!args.combo) throw new Error('key requires combo')
              return cu.key(String(args.combo), {}, act)
            }
            case 'type': {
              if (typeof args.text !== 'string') throw new Error('type requires text')
              return cu.type(args.text, { allowPassword: args.allowPassword === true }, act)
            }
            default:
              throw new Error(`unknown action "${args.action}" (expected move | click | key | type)`)
          }
        }
        const data = cu.withInputContext
          ? await cu.withInputContext({ signal: exec && exec.signal, act }, async () => {
            // Nothing above this line has touched the OS; the registry claim inside `actuate` is what
            // makes the single-dispatch guarantee hold.
            return run()
          })
          : await run()
        result.dispatched = true
        result.result = data
      } catch (error) {
        result.error = String((error && error.message) || error)
        result.code = error && error.code ? String(error.code) : null
        result.outcome = error && error.outcome ? String(error.outcome) : null
        throw Object.assign(new Error(result.error), { code: result.code, outcome: result.outcome })
      } finally {
        if (registry && record) result.registry = registry.snapshot(record.id)
      }
      return result
    },
  })

  if (log && typeof log.info === 'function') log.info(`enhanced tools registered: ${out.join(', ')}`)
  return out
}

function clampDepth (depth) {
  const n = Number(depth)
  if (!Number.isFinite(n)) return 8
  return Math.max(1, Math.min(24, Math.trunc(n)))
}

function point (at) {
  if (at === undefined || at === null) return null
  const c = String(at).split(/[,\s]+/).map(Number)
  return c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]) ? { x: c[0], y: c[1] } : null
}
