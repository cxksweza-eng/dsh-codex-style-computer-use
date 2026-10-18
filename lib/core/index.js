// @dsh/computer-use-core — capability layer (stage-0)
//
// Owns the native worker lifecycle and exposes an ergonomic JS API over it.
// Both transports (MCP server, DSH Cordis plugin) are thin shells over this
// module. Zero npm dependencies by design: the plugin must survive hostile
// npm environments (offline install, hardened caches).
//
// Worker protocol: NDJSON over stdio — one {"op","args"} per line in,
// one {"id","ok","data"|"error"} per line out. First line out is the
// {"event":"ready"} announcement.

import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stateForError } from '../action-registry.js'
import { prepareNativeBinary, workerReferences } from './native-runtime.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const DEFAULT_TIMEOUT_MS = 15_000
const CAPTURE_TIMEOUT_MS = 30_000
const INPUT_OPS = new Set(['click', 'shiftClick', 'move', 'drag', 'scroll', 'selectRange',
  'type', 'key', 'uiaAct', 'windowOp', 'activate', 'clipWrite', 'calibrate', 'selftest'])
// THE CORE'S ASK DEADLINE, AND IT IS A BARE LITERAL ON PURPOSE (merge-design.md §3, §3.2).
//
// It bounds ONE thing: a wedged worker inside `beginAsk`'s raise sequence (a hung UIA provider), or
// inside `endAsk`'s two file operations. It does NOT bound the wait for a human — there is nothing
// left to bound, because the worker no longer waits at all and the client-UI card has no countdown.
//
// It must never be DERIVED from the tool's timeoutMs. The defect this replaces was exactly that
// coupling: the old call was `this.call('ask', …, (opts.timeoutMs ?? 5000) + 10_000)`, so for every
// tool timeout below 65 s the CORE killed the worker BEFORE the tool's own deadline could fire. The
// measured incident (verify4, 15.58 s and the review's 15 s): `worker timeout: ask (15000ms) —
// worker killed` while the answer was still pending, leaving the STOP file behind with nobody left
// to wait for it (ENGAGE-ASK → ENGAGE-ADOPTED, no RELEASE). Ordering that must hold:
//
//     tool deadline 3_600_000 ms  >  core ask deadline 15_000 ms  >  core endAsk deadline 5_000 ms
//
// Guard G3 asserts the ordering AND that neither number is computed from the other.
const ASK_DEADLINE_MS = 15_000
/** The release is two file operations; if it exceeds this the worker is wedged. */
const END_ASK_DEADLINE_MS = 5_000
export function workerCallError (message, code, op, requestId, outcome = 'unknown') {
  return Object.assign(new Error(`${message} [${code}; outcome=${outcome}]. ${outcome === 'unknown' ? 'Inspect current state before retrying a write.' : 'No input was dispatched by this operation.'}`),
    { code, op, requestId, outcome })
}

/** Interactive roles that receive Set-of-Marks labels. */
const SOM_ROLES = new Set([
  'Button', 'MenuItem', 'ListItem', 'TreeItem', 'DataItem', 'TabItem',
  'Hyperlink', 'CheckBox', 'RadioButton', 'ComboBox', 'Edit', 'Spinner',
  'Slider', 'Thumb', 'ScrollBar', 'Custom', 'Pane',
])
const SOM_PATTERNS = /(Invoke|SelectionItem|Toggle|ExpandCollapse|Value|RangeValue|ScrollItem|GridItem)/

export class ComputerUse extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.workerExe] explicit worker path; discovered otherwise
   * @param {(msg: string) => void} [opts.log]
   */
  constructor (opts = {}) {
    super()
    this.workerExe = opts.workerExe || null
    this.log = opts.log || (() => {})
    this.proc = null
    this.seq = 0
    this.pending = new Map() // id -> {resolve, reject, timer}
    this.ready = false
    this.lastMarks = []      // [{id, x, y, w, h, name, role, center:[cx,cy]}]
    this.lastRegion = null   // capture region the marks refer to
    this.lastScale = 1       // screenshot px per screen px (<1 when downscaled)
    // safety knobs (sandraschi SAFETY.md four-piece: HITL + kill switch +
    // rate limit + audit; see DESIGN §8)
    this.dryRun = opts.dryRun ?? false          // simulate actuations, log only
    this.kickoffRequired = opts.kickoffRequired !== false // pure observation must not require focusing
    this.rateLimit = opts.rateLimit ?? { max: 60, windowMs: 60_000 }
    this.rateWindow = []
    this.humanApproved = opts.autoApprove ?? false // gate for mutating ops
    this.stopped = false         // true while the human's brake is engaged (see 'panic' event)
    this.exited = false          // true once the human ended the session (see 'exit' event)
    this.cooperation = { phase: 'idle', active: false, revision: 0 }
    // ---------------------------------------------------------------------------------------
    // APPROVAL HOLD (2026-10-16). See worker.cs `Panic.BeginApprovalHold` for the native half and
    // `tools.js` for the caller. `approvalsPending` counts the approval requests the HOST is currently
    // asking about; while it is non-zero the worker classifies physical input as approval-chrome
    // interaction rather than a takeover.
    //
    // This layer owns the count because it is the only place that sees both the request (raised by
    // `ctx.on('approval/request')`) and its settlement, and it must survive an interleaved second
    // request. `approvalHoldLive` mirrors the native flag for the non-awaiting paths.
    // ---------------------------------------------------------------------------------------
    this.approvalsPending = 0
    this.approvalHoldLive = false
    // Identity of the action currently waiting on a decision; carried into the worker's
    // APPROVAL-HOLD audit line so an enter/release pair can be attributed to a concrete tool call.
    this.approvalActionId = null
    this.approvalSettleMs = Number.isFinite(opts.approvalSettleMs) ? opts.approvalSettleMs : 600
    this.approvalQuietTimeoutMs = Number.isFinite(opts.approvalQuietTimeoutMs) ? opts.approvalQuietTimeoutMs : 15_000
    this.inputContext = new AsyncLocalStorage()
    // Monotonic counter of UNSOLICITED state transitions (panic/ask/resume/exit). Anything that
    // learns the machine's state asynchronously — above all the `ask` op, which can take seconds and
    // reports how it ended — captures this before the call and re-checks it after: a reply that
    // describes a state older than the newest event must never overwrite it (F2).
    this.stateSeq = 0
    this.lastMarks = []          // [{id, x, y, w, h, name, role, center:[cx,cy]}]
    this.maps = new Map()        // hwnd -> {marks, sig, ts, title} landmark cache
    this.markSequence = 0
    this.lastMarkFrame = null
    this.onWorkerExit = this.onWorkerExit.bind(this)
  }

  // ---------------- worker plumbing ----------------
  // single-flight: screenState fires 3 parallel calls (windows/cursor/uia) and
  // naive guards used to spawn 3 workers, overwriting this.proc and leaking
  // the rest — every caller must await the SAME in-flight spawn
  ensureWorker () {
    if (this.proc && this.ready) return Promise.resolve()
    if (this._ensuring) return this._ensuring
    const p = this.spawnWorker().finally(() => { if (this._ensuring === p) this._ensuring = null })
    this._ensuring = p
    return p
  }

  spawnWorker () {
    if (!this.workerExe || !existsSync(this.workerExe)) {
      // Prefer the verified prebuilt helper; source checkouts use Windows csc.
      this.workerExe = compileWorkerSync(this.log)
    }
    // Host guard: this core runs INSIDE the DSH host process, so process.pid IS the host pid -
    // but the window a human interacts with belongs to a DIFFERENT process of the same Electron
    // app (main vs renderer/GPU), so the worker is also given the executable path, which
    // recognises every process of the app at once. The worker refuses to drive any window of
    // either; one-shot CLI runs (no env) keep the guard disabled.
    const env = { ...process.env, DSH_CU_HOST_PID: String(process.pid), DSH_CU_HOST_EXE: process.execPath || '' }
    this.log(`[core] host guard armed for pid ${process.pid} (${process.execPath})`)
    this.proc = spawn(this.workerExe, [], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    // A CHILD THAT FAILS TO START MUST NAME ITSELF (2026-09-13). Every computer_* tool died with a
    // bare `Error: spawn UNKNOWN` — no path, no syscall, no Windows code — because NOTHING listened
    // for this child's 'error' event: an unhandled 'error' on an EventEmitter is thrown, so the rich
    // error object (which names the file Windows refused) was discarded on the way out.
    this.proc.on('error', (e) => {
      let file = '?'
      try { file = `${existsSync(this.workerExe)} exists, ${statSync(this.workerExe).size} bytes` } catch { file = 'stat failed' }
      this.log(`[core] WORKER SPAWN FAILED: code=${e.code} errno=${e.errno} syscall=${e.syscall} ` +
        `exe=${this.workerExe} (${file})`)
      this.spawnError = e
    })
    this.proc.stdin.on('error', (e) => this.log(`[worker:stdin] ${e.message}`))
    this.proc.stdout.setEncoding('utf8')
    let buf = ''
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        this.onLine(line)
      }
    })
    this.proc.stderr.on('data', (d) => this.log(`[worker:stderr] ${d}`))
    this.proc.on('exit', this.onWorkerExit)
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('worker ready timeout')), 10_000)
      // surface the real reason instead of letting the raw emitter error escape
      this.proc.once('error', (e) => {
        clearTimeout(t)
        reject(new Error(`worker could not be started: code=${e.code} syscall=${e.syscall} path=${e.path || this.workerExe}`))
      })
      this.once('ready', () => { clearTimeout(t); resolve() })
      this.once('dead', (code) => { clearTimeout(t); reject(new Error(`worker died at startup (code ${code})`)) })
    })
  }

  onWorkerExit (code) {
    this.ready = false
    this.proc = null
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.cleanup?.(); p.reject(workerCallError('worker exited', 'worker-exited', p.op, id)) }
    this.pending.clear()
    this.emit('dead', code)
  }

  onLine (line) {
    let msg
    try { msg = JSON.parse(line) } catch { this.log(`[worker:badline] ${line.slice(0, 200)}`); return }
    if (msg.event === 'ready') {
      this.ready = true
      // COLD-START STATE SYNC (cold-start bug, 2026-09-13): the worker has already adopted any STOP
      // or EXITED record that predates this process, and it reports that state with `ready`. Without
      // this the core started from "not stopped" while the machine was stopped — measured: core
      // stopped=false/exited=false while native said engaged/stopped=true and the light was wrong.
      // This is NOT a fake key press: no event is emitted, nothing is announced and nothing is
      // released — the mirror simply starts out agreeing with the machine.
      if (typeof msg.stopped === 'boolean') this.stopped = msg.stopped
      if (typeof msg.exited === 'boolean') this.exited = msg.exited
      this.cooperation = msg.cooperation || { phase: 'idle', active: false, revision: 0 }
      this.emit('ready', msg)
      return
    }
    if (msg.event === 'handoff') {
      this.syncCooperation(msg.cooperation)
      return
    }
    // Durable brake events are separate from automatic physical-input handoff.
    //   panic  — ESC: the human ABORTED. The machine is stopped; wrap up briefly, then wait.
    //   resume — Ctrl+Alt+R: work may continue (a PAUSE ends; it never ends the cycle).
    //   ask    — the agent asked a question: the machine is PAUSED inside a LIVE cycle for as long
    //            as the answer takes. It is NOT an exit, and the worker holds `_engaged`/STOP while
    //            the question is open — so the mirror is stopped=true, exited UNCHANGED. (A single
    //            shared branch used to make this `exited=true, stopped=false`: two lies at once, and
    //            both of those flags are read by the plugin's cycle gate.)
    //   exit   — Ctrl+Alt+Q: the human ENDED the session. Stop the turn outright, stop streaming.
    if (msg.event === 'panic' || msg.event === 'resume' || msg.event === 'exit' || msg.event === 'ask') {
      if (msg.event === 'panic') this.stopped = true
      else if (msg.event === 'resume') this.stopped = false
      else if (msg.event === 'ask') this.stopped = true
      else { this.stopped = false; this.exited = true }
      // MY OWN ask is not an "external" state change (2026-09-13, Codex review): the worker notifies
      // `ask` from EngageAsk, i.e. while this caller is inside its OWN `ask()` — between `beginAsk`
      // and the answer — so counting it as a change would make the core discard its own reply and
      // leave the mirror disagreeing with the machine. Only changes OTHER than the one this request
      // caused may invalidate its reply. (The merge did not change this: `beginAsk` still raises the
      // brake and still notifies once; what went away is the worker-side WAIT, not the event.)
      if (msg.event === 'ask' && this._askOpen) this._askOpen.own++
      this.stateSeq++
      this.emit(msg.event, msg)
      return
    }
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    p.cleanup?.()
    if (msg.data?.cooperation) this.syncCooperation(msg.data.cooperation)
    if (msg.ok) p.resolve(msg.data)
    else p.reject(workerCallError(msg.error || 'worker error', msg.code || 'worker-refusal-or-error', p.op, msg.id,
      msg.outcome === 'not-dispatched' ? 'not-dispatched' : 'unknown'))
  }

  /**
   * @param {string} op worker op
   * @param {object} [args]
   * @param {number} [timeoutMs] hard cap on this call
   * @param {boolean} [killOnTimeout] kill a wedged worker when that cap expires (default true)
   * @returns {Promise<any>} worker `data` payload
   */
  async call (op, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS, killOnTimeout = true) {
    const signal = INPUT_OPS.has(op) ? this.inputContext.getStore()?.signal : undefined
    if (signal?.aborted) throw workerCallError('owning tool cancelled', 'INPUT_CANCELLED', op, null, 'not-dispatched')
    try { await this.ensureWorker() }
    catch (error) { throw workerCallError(error.message || String(error), 'worker-unavailable', op, null, 'not-dispatched') }
    if (signal?.aborted) throw workerCallError('owning tool cancelled', 'INPUT_CANCELLED', op, null, 'not-dispatched')
    const id = ++this.seq
    // `__cycle` is this layer's SIGNATURE on a call made on the agent's behalf, and the worker
    // opens (or keeps lit) a computer-use CYCLE only for signed calls. A one-shot
    // `worker.exe --op click` from a shell script, or a deploy-time health probe, carries no
    // signature — and so can never resurrect a session the human ended with Ctrl+Alt+Q. Stamped
    // LAST so an op's own args can never forge it.
    const signed = { ...args, __cycle: true }
    signed.__kickoff = this.kickoffRequired
    return new Promise((resolve, reject) => {
      let written = false
      const cleanup = () => signal?.removeEventListener('abort', abort)
      const abort = () => {
        if (!this.pending.delete(id)) return
        clearTimeout(timer); cleanup()
        if (written) void this.call('cancelInput', { requestId: id }, 2000, false).catch(() => {})
        reject(workerCallError('owning tool cancelled; accepted input must be inspected before any retry',
          'INPUT_CANCELLED', op, id, written ? 'unknown' : 'not-dispatched'))
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        cleanup()
        // A CALL THAT RELEASES THE BRAKE MUST NOT BE KILLED FOR BEING SLOW. `proc.kill()` deletes no
        // STOP file (there is no ProcessExit handler in worker.cs; `abort` is Environment.Exit(0) at
        // worker.cs:3045), so killing here would end a question with the brake still up — the exact
        // defect this design removes. Without the kill the worker is still alive, so the caller's
        // retry, or the next op's SyncFromFile, can still finish the release.
        //
        // Everything else keeps today's behaviour: a timed-out op means the worker is wedged (a hung
        // UIA/COM provider call blocks its single-threaded loop forever), so kill it and let the NEXT
        // call respawn fresh instead of queueing behind a corpse; pending calls are rejected via
        // onWorkerExit.
        if (killOnTimeout) { try { this.proc && this.proc.kill() } catch { /* already gone */ } }
        reject(workerCallError(`worker timeout: ${op} (${timeoutMs}ms)` +
          (killOnTimeout
            ? ' — worker killed, next call respawns'
            : ' — worker left alive so the brake can still be released'),
        'worker-timeout', op, id))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, op, cleanup, abort })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      written = true
      this.proc.stdin.write(JSON.stringify({ id, op, args: signed }) + '\r\n')
    })
  }

  async kill () {
    this.emit('input-cancel')
    if (!this.proc) return
    try { await this.call('abort', {}, 1000) } catch { /* best effort */ }
    try { this.proc.kill() } catch { /* already gone */ }
  }

  // ---------------- screen observation ----------------
  syncCooperation (state) {
    if (!state || Number(state.revision) < Number(this.cooperation.revision)) return
    this.cooperation = state
    if (state.active) { this.maps.clear(); this.lastMarks = []; this.lastMarkFrame = null }
    this.emit('handoff', state)
  }

  withInputContext (context, fn) { return this.inputContext.run({ signal: context?.signal, act: context?.act }, fn) }

  waitForHuman () {
    const signal = this.inputContext.getStore()?.signal
    return new Promise((resolve, reject) => {
      const events = ['handoff', 'panic', 'ask', 'exit', 'dead', 'input-cancel']
      const cleanup = () => { for (const event of events) this.off(event, listeners[event]); signal?.removeEventListener('abort', cancelled) }
      const finish = (error) => { cleanup(); if (error) reject(error); else resolve() }
      const cancelled = () => finish(workerCallError('waiting for the human was cancelled', 'INPUT_CANCELLED', null, null, 'not-dispatched'))
      const check = () => {
        if (signal?.aborted) return cancelled()
        if (this.stopped || this.exited) return finish(workerCallError('manual pause/exit remains authoritative', 'ABORTED', null, null, 'not-dispatched'))
        if (!this.cooperation.active) finish()
      }
      const listeners = Object.fromEntries(events.map(event => [event, event === 'dead' ?
        () => finish(workerCallError('worker exited while waiting', 'worker-exited', null, null, 'not-dispatched')) :
        event === 'input-cancel' ? cancelled : check]))
      for (const event of events) this.on(event, listeners[event])
      signal?.addEventListener('abort', cancelled, { once: true })
      check()
    })
  }

  async waitInputReady () {
    if (!this.cooperation.active) return
    await this.waitForHuman()
    throw workerCallError('Human input ended and the three-second quiet interval completed. Observe the current target, then continue this task automatically. Previous coordinates/focus may have changed.',
      'HUMAN_REOBSERVE', null, null, 'not-dispatched')
  }

  // ---------------- approval hold ----------------
  // THE APPROVAL DEADLOCK (2026-10-16, reproduced on the real machine). To let a `standard`-mode
  // actuation through the human must click "approve once" on the DSH card — and that click is physical
  // input. The worker classified it as a takeover, so the operation it was approving came back
  // HUMAN_REOBSERVE / outcome=not-dispatched. `standard` mode was self-defeating on any single-mouse
  // desktop. The fix is NOT to stop watching physical input: it is to stop calling Harness chrome a
  // takeover, and to re-verify the target once the card is gone.

  /**
   * Suspend takeover classification while `n` approvals are being asked. Idempotent per count.
   * `actionId` is carried through to the worker's APPROVAL-HOLD audit line so a reader can attribute
   * every enter/release pair to the action that was waiting for a decision.
   */
  async beginApprovalHold (label, actionId) {
    this.approvalsPending++
    this.approvalActionId = actionId || label || 'approval'
    // The action waiting on this decision is the one the tools layer last published. Moving it to
    // WAITING_APPROVAL here (rather than in the hook) keeps the registry's view consistent with the
    // native hold: both are armed from the same moment.
    if (this.pendingAction && this.pendingAction.registry) {
      try { this.pendingAction.registry.transition(this.pendingAction.id, 'WAITING_APPROVAL', this.approvalActionId) } catch { /* registry refusals are never fatal */ }
    }
    if (this.approvalHoldLive) return { hold: true, reused: true }
    this.approvalHoldLive = true
    try {
      // The worker only observes physical input once it is alive, so the hold must ensure it exists.
      // This spawns nothing when a cycle is already running; it only guarantees the hooks are up.
      await this.ensureWorker()
      const res = await this.call('approvalHold', { on: true, actionId: this.approvalActionId })
      this.syncCooperation(res && res.cooperation)
      this.log(`[core] approval hold ON (${this.approvalActionId})`)
      return { hold: true, reused: false }
    } catch (error) {
      // A hold that cannot be armed must never wedge the approval: report it and let the decision
      // proceed. The pre-existing HUMAN_REOBSERVE path still protects the human in that case.
      this.approvalHoldLive = false
      this.log(`[core] approval hold could not be armed: ${error && error.message}`)
      return { hold: false, error: String((error && error.message) || error) }
    }
  }

  /**
   * Settle the hold and WAIT FOR INPUT STABILITY before anything is dispatched.
   *
   * Order matters and is the whole point of the fix:
   *   1. release the native hold (takeover classification is live again),
   *   2. wait `approvalSettleMs` so the mouse-up that dismissed the card is not read as a fresh burst,
   *   3. poll `ping` until the worker reports `idle` (bounded by `quietTimeoutMs`).
   *
   * Nothing is dispatched here, so a failure to reach quiet is reported rather than acted on — the
   * caller re-observes and re-validates before using any coordinate.
   */
  async endApprovalHold (actionId) {
    if (this.approvalsPending > 0) this.approvalsPending--
    if (this.approvalsPending > 0) return { settled: false, reason: 'another approval is still pending' }
    if (!this.approvalHoldLive) return { settled: true, reused: true }
    this.approvalHoldLive = false
    const releaseId = actionId || this.approvalActionId || 'approval'
    this.approvalActionId = null
    let released = false
    try {
      const res = await this.call('approvalHold', { on: false, actionId: releaseId })
      released = true
      this.syncCooperation(res && res.cooperation)
    } catch (error) {
      this.log(`[core] approval hold release failed: ${error && error.message}`)
    }
    // Step 2: a short, deliberate settle so the dismissal gesture is not the next burst.
    if (this.approvalSettleMs > 0) await new Promise(resolve => setTimeout(resolve, this.approvalSettleMs))
    // Step 3: bounded quiet poll. `ping` is a read; it dispatches no input and spends no model request.
    const quiet = await this.waitQuietPoll(this.approvalQuietTimeoutMs)
    if (!released) return { settled: false, reason: 'the native hold could not be released', quiet }
    return quiet
  }

  /** Poll the worker until it reports no active handoff. Bounded; never throws for a timeout. */
  async waitQuietPoll (timeoutMs) {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
    for (;;) {
      if (this.stopped || this.exited) return { settled: false, reason: 'a manual pause or exit is authoritative' }
      if (!this.cooperation.active) return { settled: true, waited: 0 }
      // `waitForHuman` is event-driven and resolves the moment the worker publishes idle, so this
      // costs one IPC read per burst rather than a busy loop.
      const remaining = deadline - Date.now()
      if (remaining <= 0) return { settled: false, reason: 'input did not become quiet in time' }
      await this.waitForHumanTimeout(remaining)
      if (this.stopped || this.exited) return { settled: false, reason: 'a manual pause or exit is authoritative' }
      if (!this.cooperation.active) return { settled: true }
      if (Date.now() >= deadline) return { settled: false, reason: 'input did not become quiet in time' }
      try { const p = await this.call('ping', {}, 5_000); this.syncCooperation(p && p.cooperation) } catch { /* handled by the next loop test */ }
    }
  }

  /** `waitForHuman` with a deadline. Resolves either way; the caller inspects `cooperation`. */
  waitForHumanTimeout (timeoutMs) {
    return new Promise((resolve) => {
      let done = false
      const finish = () => { if (done) return; done = true; clearTimeout(t); this.off('handoff', finish); this.off('panic', finish); this.off('exit', finish); this.off('dead', finish); resolve() }
      const t = setTimeout(finish, Math.max(0, timeoutMs))
      for (const event of ['handoff', 'panic', 'exit', 'dead']) this.on(event, finish)
      if (!this.cooperation.active) finish()
    })
  }

  cancelInputs () {
    this.emit('input-cancel')
    for (const pending of [...this.pending.values()]) if (INPUT_OPS.has(pending.op)) pending.abort?.()
  }

  /** Raw capture; returns { image: Buffer, mime, region, cursor, settled, settleMs, ts, scaledTo }. */
  async screenshot (opts = {}) {
    const data = await this.call('capture', {
      x: opts.x, y: opts.y, width: opts.width, height: opts.height,
      preset: opts.preset,
      format: opts.format || 'jpeg',
      quality: opts.quality ?? 75,
      // ~1280 wide ≈ Anthropic WXGA guidance: ⌈w/28⌉×⌈h/28⌉ tokens ≈ 1600; bigger
      // wastes vision tokens, smaller loses text legibility (DESIGN §6)
      maxWidth: opts.maxWidth ?? 1280,
      cursor: opts.cursor ?? false,
      // timing: wait for pixel stability before grabbing, hard-capped so it can't stall
      wait: opts.wait || 'auto',
      waitCapMs: opts.waitCapMs,
      stableMs: opts.stableMs,
    }, CAPTURE_TIMEOUT_MS)
    this.lastRegion = data.region
    this.lastScale = data.scaledTo && data.region.width ? data.scaledTo / data.region.width : 1
    return { ...data, image: Buffer.from(data.image, 'base64') }
  }

  /**
   * Text-first screen state — the grounding channel that works even for
   * models without native vision. Merges: window list + active window +
   * shallow UIA tree of the active window + cursor. This is the default
   * observation tool; screenshots are the *verification* channel.
   */
  async screenState (opts = {}) {
    const [windows, cursor, uia] = await Promise.all([
      this.call('windows', {}),
      this.call('cursor', {}),
      this.call('uia', { depth: opts.uiaDepth ?? 5, maxNodes: opts.uiaMaxNodes ?? 260 }).catch(() => null),
    ])
    const active = (windows.windows || []).find(w => w.active) || null
    return {
      active, windows: windows.windows, cursor,
      uiaRoot: uia && uia.root, uiaFlat: (uia && uia.flat) || [],
      uiaCount: uia && uia.count, uiaTruncated: !uia || uia.truncated !== false, ts: Date.now(),
    }
  }

  /**
   * Set-of-Marks: label interactive elements M1..Mn on the current screen.
   * Returns the annotated screenshot plus a text mark table. Clicking by
   * mark ids refer to the same observed map as the text table.
   */
  async marks (opts = {}) {
    const map = opts.landmarkMap || await this.landmarks({ hwnd: opts.hwnd, depth: opts.uiaDepth ?? 14, maxNodes: opts.uiaMaxNodes ?? 1500 })
    await this.validateMarkFrame()
    const state = { active: { hwnd: map.hwnd }, cursor: await this.call('cursor', {}) }
    // capture FIRST so the visible region drives the ghost-mark filter:
    // minimized windows live at (-32000, -32000) in UIA and must never receive
    // mark ids (clicking them would throw the cursor off-screen)
    const shot = await this.screenshot({ ...opts, quality: opts.quality ?? 80 })
    await this.validateMarkFrame()
    const region = shot.region
    const onScreen = (r) => r.x + r.width >= region.x && r.x <= region.x + region.width
      && r.y + r.height >= region.y && r.y <= region.y + region.height
    const markList = map.marks.filter(m => onScreen({ x: m.x, y: m.y, width: m.w, height: m.h }))
    let annotated = null
    if (opts.annotated !== false && markList.length > 0) {
      // marks are in screen px; map into screenshot px space (screenshot px = screen px × scale)
      const scaled = markList.map(m => ({
        id: m.id,
        x: Math.round((m.x - shot.region.x) * this.lastScale),
        y: Math.round((m.y - shot.region.y) * this.lastScale),
        w: Math.round(m.w * this.lastScale), h: Math.round(m.h * this.lastScale),
      }))
      const res = await this.call('annotate', {
        image: shot.image.toString('base64'), marks: scaled, quality: 80,
      }, CAPTURE_TIMEOUT_MS)
      annotated = Buffer.from(res.image, 'base64')
    }
    return { marks: markList, annotated, raw: opts.raw ? shot.image : undefined, state: { active: state.active, cursor: state.cursor }, ts: Date.now() }
  }

  // ---------------- actions (all audited) ----------------
  // The optional trailing `act` is the action context (signal + target verifier + registry record).
  // The computer_* tools publish it through the input context instead, so their call sites are
  // unchanged; the cu_* tools pass it explicitly because they build their own pipeline. Both routes
  // end in the same `actuate`, which is the only place that settles, re-validates and dispatches.
  async move (x, y, act) { return this.actuate('move', { x, y }, act) }

  async click (target, opts = {}, act) {
    const pt = await this.resolveTarget(target) // {x,y} | {mark:'M3'} | [x,y]
    return this.actuate('click', {
      x: pt.x, y: pt.y, button: opts.button || 'left', clicks: opts.clicks || 1,
      settleMs: opts.settleMs ?? 40,
      ...((pt.expectHwnd || opts.expectHwnd) ? { expectHwnd: pt.expectHwnd || opts.expectHwnd } : {}),
    }, act)
  }

  async drag (from, to, opts = {}) {
    const a = await this.resolveTarget(from)
    const b = await this.resolveTarget(to)
    return this.actuate('drag', { fromX: a.x, fromY: a.y, toX: b.x, toY: b.y, ...opts })
  }

  async scroll (direction, lines, opts = {}) {
    // BUG FIX (2026-09-12): the old signature took `opts` but the tool layer passed the
    // point itself, so opts.at was always undefined (x/y silently dropped — the wheel
    // always fired wherever the cursor happened to be) and a null argument crashed with
    // "Cannot read properties of null (reading 'at')". Accept both shapes now.
    const o = opts || {}
    const at = o.at || (o.x !== undefined && o.y !== undefined ? o : null)
    const pt = at ? await this.resolveTarget(at) : null
    return this.actuate('scroll', { direction, lines, ...(pt ? { x: pt.x, y: pt.y } : {}) })
  }

  // Anchor-based selection: click the START, scroll freely, then shift+click the END.
  // Replaces drag-select, whose end point depends on drag duration and auto-scroll speed.
  async shiftClick (x, y, opts = {}) {
    return this.actuate('shiftClick', { x, y, clicks: opts.clicks || 1, settleMs: opts.settleMs ?? 90,
      ...(opts.expectHwnd ? { expectHwnd: opts.expectHwnd } : {}) })
  }

  async selectRange (a = {}) { return this.actuate('selectRange', a) }

  // Low-level control action through the accessibility tree: press a button, SELECT A TAB,
  // expand a combo, set a field's value — one COM call, no pointer travel, no screenshot.
  async uiaAct (a = {}) { return this.actuate('uiaAct', a) }

  // Screenshot timing: wait for the frame signature to stop changing / to change at all.
  async waitStable (opts = {}) { return this.call('waitStable', opts) }
  async waitChange (opts = {}) { return this.call('waitChange', opts) }

  // Agent-activity indicator (blue border) — observations do not light it, actuations do.
  async indicator (opts = {}) { return this.call('indicator', opts) }

  /**
   * The agent has STOPPED driving: cut the border instantly (no ease-out), exactly like the
   * emergency brake. Called when the agent's turn ends, so a lingering blue border can never
   * claim the machine is still under control after control actually stopped.
   */
  async calm () { return this.call('calm', {}) }

  /// **Ask the human one question, machine paused — the ONE question path.**
  ///
  /// Only for the rare case where the agent is genuinely blocked on a decision it must not make
  /// alone. This is a TRANSACTION in two worker ops and one client-UI wait:
  ///
  ///   1. `beginAsk` — the worker writes the STOP file, paints the fast-breathing red, raises the
  ///      host and puts the caret in the composer, then RETURNS AT ONCE. The worker's single-threaded
  ///      op loop is never occupied by the wait, so `abort`/`panic`/any other op is answered while a
  ///      question is open (the old one-shot `ask` op held the loop for the whole window).
  ///   2. `opts.onAsk(info)` — the ANSWER CHANNEL, required. The plugin hands the question to the
  ///      client-UI card `ask_user_question` uses; it resolves with `{answered, keepPause, …}` and
  ///      has no countdown of its own. That is the "hang until the human answers" the human asked for.
  ///   3. `endAsk` — issued from the `finally`, so EVERY ending releases: answered, dismissed,
  ///      aborted turn, tool deadline, `onAsk` throwing. `keepPause` travels from the human's own
  ///      choice on the card (①让你停 / ②放你走, D3) — never derived from how the call ended.
  ///
  /// @param {object} opts
  /// @param {string} opts.question
  /// @param {(info: {askId:number, hostRaised:boolean, caretPlaced:boolean}) => Promise<object>} opts.onAsk
  ///   resolves `{answered:boolean, keepPause?:boolean, selected?:string[], custom?:string, reason?:string}`
  /// @returns {Promise<object>} `{...answer, question, askId, stopped, exited, release}`
  async ask (opts = {}) {
    if (typeof opts.onAsk !== 'function') {
      throw new Error('ask() requires onAsk: the worker no longer waits for a human; the answer comes from the client UI')
    }
    // The ask reports state (it engages and releases a brake), so its replies are state reports, not
    // just data, and the guard counts EXTERNAL state changes only (F2): the worker's own `ask`
    // notification belongs to this very request (see onLine), so it must not invalidate anything.
    // Anything else that arrived meanwhile — above all Ctrl+Alt+Q — makes a reply history, and
    // history may not overwrite the present. The window is far longer now (a human reading a card,
    // not a 60 s clock), so that discipline matters MORE, not less: it is applied to the release.
    const before = this.stateSeq
    const tracker = { own: 0 }
    this._askOpen = tracker
    let b
    try {
      // A throw HERE means nothing was engaged (the worker verified `Panic.Engaged`, or refused for
      // NO-CYCLE) — so there is nothing to release and no `endAsk` is sent.
      b = await this.call('beginAsk', { question: opts.question }, ASK_DEADLINE_MS)
    } finally {
      this._askOpen = null
    }
    const askId = b && b.askId
    let answer = null
    let rel = null
    let via = 'ok'
    try {
      answer = await opts.onAsk({ askId, hostRaised: !!(b && b.hostRaised), caretPlaced: !!(b && b.caretPlaced) })
      // `via` is an AUDIT LABEL ONLY — it decides nothing. The pause decision is `keepPause`, and it
      // comes from the human: ①让你停 keeps the brake, and every other ending (②放你走, a typed custom
      // answer, a dismissed card, an aborted turn, the tool deadline, a missing answer) releases it.
      via = !answer ? 'ok'
        : answer.answered ? 'answered'
          : (answer.reason === 'cancelled' ? 'cancelled'
            : (answer.reason === 'aborted' || answer.reason === 'tool-timeout') ? 'aborted' : (answer.reason || 'ok'))
    } finally {
      // SOMEONE must read the answer's decision — `|| false` would turn "the channel never said" into
      // a release, which is the safe direction but would hide a broken channel. Require a boolean and
      // shout when it is missing; a channel that cannot state the pause decision must not silently
      // keep a brake up.
      const keepPause = answer && typeof answer.keepPause === 'boolean' ? answer.keepPause : false
      if (answer && typeof answer.keepPause !== 'boolean') {
        this.log('[ask] the answer channel returned no keepPause boolean — releasing the brake (the safe direction): ' +
          JSON.stringify({ answered: (answer && answer.answered) === true, reason: answer && answer.reason }))
      }
      // CAPTURE THE STATE THE RELEASE IS ALLOWED TO OVERWRITE (Codex-review discipline, kept from the
      // old ask). `endAsk`'s own audit record is not a state change, so `before` does not move for a
      // normal release; if a Ctrl+Alt+Q (or a new panic) lands while the release is in flight, the
      // reply describes a machine that no longer exists and must not be applied on top of it.
      const beforeRelease = this.stateSeq
      try {
        rel = await this.call('endAsk', { askId, via, keepPause }, END_ASK_DEADLINE_MS, /* killOnTimeout */ false)
      } catch (e) {
        // ONE retry: the first attempt may have timed out against a briefly busy worker. A second
        // failure is not swallowed — the audit pair (ENGAGE-ASK with no ASK-RELEASE) is the signal,
        // and the orphan sweep is the backstop. NEVER a kill here (killOnTimeout:false above): the
        // dead worker's STOP file would outlive every waiter, which is the defect being removed.
        try {
          rel = await this.call('endAsk', { askId, via: via + '+retry', keepPause }, END_ASK_DEADLINE_MS, false)
        } catch (e2) {
          this.log(`[ask] endAsk failed twice: ${e2.message} — the brake may need the orphan sweep (the next worker call sweeps it, or the human's Ctrl+Alt+R)`)
        }
      }
      if (rel) {
        if (this.stateSeq === beforeRelease) {
          this.stopped = !!rel.stopped
          if (rel.exited) this.exited = true
        } else {
          this.log('[ask] a state change arrived while the ask brake was being released — the newer state stands')
        }
      }
      const external = (this.stateSeq - before) - tracker.own
      if (external > 0) this.log(`[ask] ${external} state change(s) arrived while the question was pending`)
      // EMITTED FROM THE FINALLY, so a throwing/throttled `endAsk` still settles the plugin's
      // `asking` gate: an ask that leaves the gate stuck on `asking` locks out the owner's idle and
      // its turn/end and every other session (lifecycle bug, 2026-09-13). It is not a resume, it
      // clears no brake and it reports only how the question actually ended.
      this.emit('ask-ended', {
        answered: !!(answer && answer.answered),
        stopped: this.stopped,
        exited: this.exited,
        release: rel,
      })
    }
    return { ...(answer || {}), question: opts.question, askId, stopped: this.stopped, exited: this.exited, release: rel }
  }

  /// **End the session from the agent side** — the programmatic twin of Ctrl+Alt+Q.
  /// Only when the work genuinely cannot go on: it cancels the turn, and nothing re-opens the
  /// session (not even Ctrl+Alt+R) until an agent drives this machine again.
  async exit (why) {
    return this.call('exit', { why: why || 'could not proceed' })
  }

  /**
   * Where will synthetic keystrokes land? Returns the foreground window, whether it matched
   * the intended target, whether it had to be re-asserted, and an integrity-level warning when
   * Windows (UIPI) would silently discard our input. Text-only — no screenshot needed.
   */
  async focus (opts = {}) { return this.call('focus', opts) }

  /** Sampled fingerprint plus window identity/geometry; a change invalidates cached marks. */
  async frameSig (opts = {}) { return this.call('frameSig', opts) }

  /**
   * Landmark map of a window — the "look once, then reuse" mechanism.
   *
   * The first call on a window returns named interactive elements with snapshot ids and
   * its centre (M1..Mn); a later call while the window still looks the same costs ONE cheap
   * frame hash (no image transfer, annotation or model vision) and returns the same table with
   * `reused:true`. So entering a window and reading it once is enough to keep working in it by
   * NAME, without paying for another screenshot each step.
   */
  async landmarks (opts = {}) {
    const step = opts.step ?? 16
    const insetPct = opts.insetPct ?? 10
    const fs = await this.frameSig({ hwnd: opts.hwnd, step, insetPct })
    const hwnd = fs.hwnd
    if (!hwnd || !fs.sig) throw staleMark('window snapshot unavailable')
    const cached = this.maps.get(String(hwnd))
    const key = JSON.stringify([opts.depth ?? 14, opts.maxNodes ?? 1500, opts.maxMarks ?? 80, opts.minSize ?? 8, opts.role, opts.nameContains])
    if (cached && sameMarkFrame(cached.frame, fs) && cached.key === key && !opts.refresh) {
      this.lastMarks = cached.marks
      this.lastMarkFrame = { ...fs, step, insetPct }
      return { hwnd, marks: cached.marks, count: cached.marks.length, reused: true, ageMs: Date.now() - cached.ts, sig: fs.sig }
    }
    const uia = await this.call('uia', {
      hwnd: hwnd || undefined,
      depth: opts.depth ?? 14,
      maxNodes: opts.maxNodes ?? 1500,
      role: opts.role,
      nameContains: opts.nameContains,
    })
    const marks = buildMarks(uia.flat || [], opts.maxMarks ?? 80, opts.minSize ?? 8)
    const after = await this.frameSig({ hwnd, step, insetPct })
    if (!sameMarkFrame(fs, after)) {
      const changed = ['hwnd', 'pid'].filter(k => fs[k] !== after[k])
      for (const k of ['x', 'y', 'width', 'height']) if (fs.region?.[k] !== after.region?.[k]) changed.push(`region.${k}`)
      if (fs.sig !== after.sig) changed.push('sampled-frame-signature')
      throw staleMark('window changed while reading the element map (' + changed.join(', ') +
        '); this comparison does not identify the animation, occluder or other cause')
    }
    for (const mark of marks) mark.id = `M${++this.markSequence}`
    this.lastMarks = marks
    this.lastMarkFrame = { ...after, step, insetPct }
    this.maps.set(String(hwnd), { marks, frame: after, sig: after.sig, key, ts: Date.now() })
    if (this.maps.size > 16) this.maps.delete(this.maps.keys().next().value)
    return { hwnd, marks, count: marks.length, reused: false, sig: fs ? fs.sig : null, elements: (uia.flat || []).length }
  }

  // The human's emergency brake, reachable from the model side too (ESC / Ctrl+Alt+Q are
  // handled inside the worker by a low-level keyboard hook).
  async panic (why, temporary = false) { return this.call('panic', { why: why || 'manual', temporary }) }

  async recover (pauseId) {
    const before = this.stateSeq
    const result = await this.call('recover', { pauseId })
    if (result.recovered && this.stateSeq === before && !this.exited) this.stopped = false
    else if (result.recovered) return { recovered: false, reason: 'a newer machine state superseded recovery' }
    return result
  }
  // Opening a NEW CYCLE is the plugin's job, from the ONE place a real call reaches the worker (the
  // plugin's ensureCycle) — never the human's: Ctrl+Alt+R releases a brake and does nothing else
  // (the worker's Clear()), while this op is the one and only thing that un-latches Ctrl+Alt+Q.
  //
  // `expectExit` is the exit record the CALLER saw when it decided to open ("" = it saw none). The
  // worker compares it against the record on disk inside the same lock it writes records in, and
  // REFUSES to clear a newer one: an exit that lands while this op is being spawned or written is
  // newer than the caller's decision, and clearing it is how a Ctrl+Alt+Q would be undone (#6).
  async resume (expectExit) {
    // The reply's MIRROR is guarded too (Codex review #2/#3): the worker's answer and a later
    // unsolicited event can arrive in the SAME stdout chunk, and the Node layer processes the chunk's
    // lines before this continuation runs — so `this.exited = false; this.stopped = false` used to
    // overwrite a panic (or a new exit) that had already been observed. A state event that landed
    // while this op was in flight is NEWER than the op's own result: the newer state stands.
    const before = this.stateSeq
    const r = await this.call('resume', typeof expectExit === 'string' ? { expectExit } : {})
    if (this.stateSeq === before) {
      this.exited = false
      this.stopped = false
    } else {
      this.log('[resume] a state event arrived while the cycle opener was in flight — the newer state stands')
    }
    return r
  }
  async selfTest () { return this.actuate('selftest', {}) }
  async calibrate (opts = {}) { return this.actuate('calibrate', opts) }

  async key (combo, opts = {}, act) {
    return this.actuate('key', { combo, holdMs: opts.holdMs ?? 60, ...(opts.expectHwnd ? { expectHwnd: opts.expectHwnd } : {}) }, act)
  }

  async type (text, opts = {}, act) {
    // refuse typing into password fields unless explicitly allowed — the model
    // should ask the human, never handle credentials blind (DESIGN §8.3)
    if (!opts.allowPassword) {
      const f = await this.call('uiaFocused', {}).catch(() => null)
      if (f && f.element && f.element.isPassword) {
        throw new Error('target is a password field; set allowPassword:true after explicit human consent')
      }
    }
    // paste is IME-proof and faster for CJK/long text; unicode works when the
    // clipboard must not be touched. Auto rule: non-ASCII or >80 chars → paste.
    const automatic = !opts.mode || opts.mode === 'auto'
    const mode = automatic ? (/[\u0100-\uffff]/.test(text) || text.length > 80 ? 'paste' : 'unicode') : opts.mode
    const args = {
      text, mode, restoreClipboard: opts.restoreClipboard ?? true,
      ...(opts.expectHwnd ? { expectHwnd: opts.expectHwnd } : {}),
    }
    try {
      return await this.actuate('type', args, act)
    } catch (error) {
      // Only the pre-mutation format refusal proves that no text was sent. Never replay an
      // interrupted/unknown paste, a concurrent human copy, or an explicitly requested paste.
      if (!automatic || mode !== 'paste' || error.code !== 'CLIPBOARD_PRESERVATION_UNAVAILABLE' || error.outcome !== 'not-dispatched') throw error
      const result = await this.type(text, { ...opts, mode: 'unicode' }, act)
      return { ...result, modeFallback: 'clipboard-preservation-unavailable' }
    }
  }

  async clipRead () { return this.call('clipRead', {}) }
  async clipWrite (text) { return this.actuate('clipWrite', { text }) }

  async activateWindow (sel) { return this.actuate('activate', sel) }
  async windowOp (sel, op, opts = {}) { return this.actuate('windowOp', { ...sel, op, ...opts }) }
  /** Deterministic placement (no mouse): move/resize a window to an arbitrary rect. */
  async windowMove (sel, rect) { return this.windowOp(sel, 'move', rect) }
  async waitForIdle (opts = {}) {
    return this.call('waitForIdle', { timeoutMs: opts.timeoutMs ?? 5000, stableMs: opts.stableMs ?? 350, pollMs: opts.pollMs ?? 120 })
  }

  /** Resolve {mark} | {x,y} | [x,y] | 'M12' into absolute screen px. */
  async resolveTarget (target) {
    if (typeof target === 'string') target = { mark: target }
    if (Array.isArray(target)) return { x: target[0], y: target[1] }
    if (target && typeof target.mark === 'string') {
      const m = this.lastMarks.find(k => k.id.toLowerCase() === String(target.mark).toLowerCase())
      if (!m) throw staleMark(`unknown or retired mark ${target.mark}`)
      await this.validateMarkFrame()
      return { x: m.cx, y: m.cy, mark: m, expectHwnd: this.lastMarkFrame.hwnd }
    }
    if (target && Number.isFinite(target.x) && Number.isFinite(target.y)) return target
    throw new Error('target must be {mark}, {x,y}, or [x,y]')
  }

  async validateMarkFrame () {
    const frame = this.lastMarkFrame
    if (!frame) throw staleMark('no verified landmark snapshot')
    let current
    try { current = await this.frameSig({ hwnd: frame.hwnd, step: frame.step, insetPct: frame.insetPct }) }
    catch { throw staleMark('window snapshot could not be checked') }
    if (!sameMarkFrame(frame, current)) throw staleMark('window contents, position or identity changed')
  }

  /** Every state-changing op funnels through here for the audit trail. */
  async actuate (op, args, act) {
    // The tool wrapper publishes the action record (signal + target verifier) through the input
    // context so every existing call site — all 20 of them — gets the settle/verify/retry policy
    // without changing its signature.
    if (!act) act = this.inputContext.getStore()?.act
    // ---- ① SETTLE ------------------------------------------------------------------------------
    // Approval interaction is exempted natively (`HeldForApproval`), so by the time we are here an
    // active handoff means the human is genuinely on the machine. Older versions threw
    // HUMAN_REOBSERVE immediately, which made the approval gesture itself fail the operation it was
    // approving. We now wait for the quiet interval — bounded — and then RE-VALIDATE the target
    // before dispatching anything. A re-validation that cannot be performed is a refusal, never a
    // blind retry with stale coordinates.
    await this.waitInputQuietBefore(act)
    // The dry run short-circuits AFTER the settle on purpose: a dry run still refuses to pretend the
    // machine is free while the human owns it, so it reports the same settle refusal as a real call.
    if (this.dryRun) {
      const rec = { op, args: redact(args), ts: Date.now(), dryRun: true }
      this.emit('action', rec)
      return { dryRun: true, op }
    }
    const now = Date.now()
    this.rateWindow = this.rateWindow.filter(t => now - t < this.rateLimit.windowMs)
    if (this.rateWindow.length >= this.rateLimit.max) {
      throw new Error(`rate limit: ${this.rateLimit.max} actuations/${this.rateLimit.windowMs}ms exceeded`)
    }
    const rec = { op, args: redact(args), ts: Date.now() }
    this.emit('action', rec)
    // ---- ACTION REGISTRY -----------------------------------------------------------------------
    // `beginDispatch` claims the ONE permitted dispatch BEFORE anything is sent, so a re-entry — a
    // retry, a resumed turn, a bug in a later refactor — sees the counter already spent and is refused
    // instead of duplicating a write that may already have landed. The registry is a guard rail, not a
    // second implementation of the retry policy: the policy below is unchanged.
    //
    // ROOT CAUSE OF THE FIRST WIRING BUG (found by a live probe, 2026-10-16): the registry INSTANCE is
    // carried on `act.registry`, while the ACTION RECORD is carried on `act.action`. Reading
    // `act.action.registry` therefore always yielded undefined and the entire block was skipped
    // silently — the action executed and still reported `actionMayDispatch: true`, i.e. the one
    // invariant this registry exists for was not being enforced at all. A guard placed on a nested
    // property cannot tell "not wired" from "nothing to do", so the two are now read separately.
    const registry = (act && act.registry) || (act && act.action && act.action.registry) || null
    const tracked = (act && act.action) || null
    if (registry && tracked && !tracked.retried) {
      const claim = registry.beginDispatch(tracked.id)
      if (!claim.ok) {
        const refusal = workerCallError(`not dispatched: ${claim.reason}`, 'ALREADY_DISPATCHED', op, null, 'not-dispatched')
        rec.error = String(refusal.message)
        throw refusal
      }
    }
    try {
      const data = await this.call(op, args)
      rec.result = data
      if (registry && tracked) {
        // EXECUTING -> VERIFIED is the legal edge for "the worker accepted and dispatched". Anything
        // that merely LOOKED fine but is not provable is caught above as an error, so reaching here
        // means the outcome is known. The registry only needs the terminal fact: this action is done
        // and must never be dispatched again.
        registry.transition(tracked.id, 'VERIFIED', 'dispatch returned ok')
      }
      return data
    } catch (err) {
      // Record the terminal state the refusal implies. `outcome === 'unknown'` becomes UNKNOWN, which
      // is terminal FOR DISPATCH — that single fact is what makes "never replay a maybe-landed write"
      // a property of the registry rather than a property of the caller remembering to check.
      if (registry && tracked) {
        const next = stateForError(err.code, err.outcome)
        const moved = registry.transition(tracked.id, next, err.code || 'error')
        if (!moved.ok) registry.markUnknown(tracked.id, `${err.code || 'error'} (state ${next} was not reachable)`)
      }
      // ---- ② ONE VERIFIED RETRY ---------------------------------------------------------------
      // The window between the quiet read and SendInput can still be entered by a new burst. When the
      // worker reports HUMAN_YIELD the operation MAY have dispatched partially, so the retry is
      // allowed only for the two forms whose target we can re-prove from current state:
      //   * a real window/control selector (`verify` is supplied by the caller), or
      //   * an already re-checked mark frame.
      // A bare screen coordinate has no verifier: it is never retried, because replaying it after the
      // desktop moved is exactly the "old coordinates" failure we are fixing.
      const yielded = err.code === 'HUMAN_YIELD'
      const canRetry = yielded && err.outcome === 'not-dispatched' && act && typeof act.verify === 'function' && !act.retried
      if (canRetry) {
        act.retried = true
        this.log(`[core] ${op}: yielded before dispatch — re-validating the target, then one retry`)
        const quiet = await this.waitQuietPoll(this.approvalQuietTimeoutMs)
        if (quiet.settled && !this.stopped && !this.exited) {
          const verdict = await act.verify()
          if (verdict && verdict.ok) {
            try {
              const data = await this.call(op, args)
              rec.result = data
              rec.retriedOnce = true
              if (registry && tracked) registry.transition(tracked.id, 'VERIFIED', 'verified retry returned ok')
              return data
            } catch (again) {
              rec.error = String(again.message || again)
              if (again.code === 'HUMAN_YIELD') {
                again.code = 'HUMAN_REOBSERVE'
                again.message += ' Re-observe the target before continuing; a coordinate target is never replayed.'
              }
              throw again
            }
          }
          err.code = 'REFRESH_REQUIRED'
          err.message = `the target could not be re-validated after the handoff (${(verdict && verdict.reason) || 'no evidence'}); ` +
            'no input was sent. Re-observe with computer_state/computer_uia or refresh computer_marks, then retry.'
          rec.error = String(err.message)
          throw err
        }
        err.code = quiet.settled ? 'ABORTED' : 'SETTLE_TIMEOUT'
        err.message = `${quiet.reason || 'the desktop did not become quiet'}; no input was sent.`
        rec.error = String(err.message)
        throw err
      }
      if (yielded) {
        await this.call('ping', {}).catch(() => {})
        const quiet = await this.waitQuietPoll(this.approvalQuietTimeoutMs)
        if (!quiet.settled) {
          err.code = 'SETTLE_TIMEOUT'
          err.message = `${quiet.reason || 'input did not become quiet'}. No input was sent by this operation.`
        } else {
          err.code = 'HUMAN_REOBSERVE'
          err.message += ' Human input is now idle for at least three seconds. Inspect the current target and continue automatically;' +
            ' do not repeat any partial write without a readback.'
        }
      }
      rec.error = String(err.message || err)
      throw err
    } finally {
      // One rate-limit slot per ACTUAL attempt, recorded at attempt time. (An earlier revision pushed
      // inside the success path, which let a failing call escape the limiter entirely.)
      this.rateWindow.push(rec.ts)
      this.emit('action:settled', rec)
    }
  }

  /**
   * Bounded pre-dispatch settle. Returns normally when quiet; throws the appropriate refusal code
   * otherwise. Distinct from `waitInputReady`, which exists for callers that only want the check.
   */
  async waitInputQuietBefore (act) {
    if (this.stopped || this.exited) {
      throw workerCallError('a manual pause or exit is authoritative', 'ABORTED', null, null, 'not-dispatched')
    }
    const signal = act && act.signal
    if (signal && signal.aborted) {
      throw workerCallError('the owning tool was cancelled', 'INPUT_CANCELLED', null, null, 'not-dispatched')
    }
    if (!this.cooperation.active) return { settled: true, held: false }
    // The settle budget is the smaller of the configured ceiling and a share of THIS tool's deadline,
    // so a short-deadline tool (`computer_clip` allows 10 s) can never spend its whole budget waiting
    // and then be killed by the host instead of reporting a clean refusal.
    let budget = this.approvalQuietTimeoutMs
    if (act && Number.isFinite(act.budget) && act.budget > 0) budget = Math.min(budget, act.budget)
    const quiet = await this.waitQuietPoll(budget)
    if (this.stopped || this.exited) {
      throw workerCallError('a manual pause or exit is authoritative', 'ABORTED', null, null, 'not-dispatched')
    }
    if (!quiet.settled) {
      throw workerCallError(`${quiet.reason || 'the desktop did not become quiet'}; no input was sent. ` +
        'The human still owns the desktop — ask them to release it, or read the target again first.',
        'SETTLE_TIMEOUT', null, null, 'not-dispatched')
    }
    // A real handoff happened and has now ended. The target may have moved under us, so re-prove it
    // BEFORE dispatching: this is the gate that stops a takeover during the approval window from being
    // executed through. When no verifier is available the refusal is explicit — never a blind retry
    // with the coordinates that were captured before the human touched the machine.
    if (act && typeof act.verify === 'function') {
      const verdict = await act.verify()
      if (verdict && verdict.ok) return { settled: true, held: true, verified: true }
      throw workerCallError(`the target could not be re-validated after the handoff (${(verdict && verdict.reason) || 'no evidence'}); ` +
        'no input was sent. Re-observe with computer_state/computer_uia or refresh computer_marks, then retry.',
        'REFRESH_REQUIRED', null, null, 'not-dispatched')
    }
    throw workerCallError('the human used the machine and this target cannot be re-validated without a fresh observation ' +
      '(a bare screen coordinate carries no identity); no input was sent. Re-observe, then retry.',
      'REFRESH_REQUIRED', null, null, 'not-dispatched')
  }
}

function staleMark (reason) {
  return Object.assign(new Error(`STALE_MARK: ${reason}; no input sent. Refresh computer_marks and choose the target again, or use a current UIA selector.`),
    { code: 'STALE_MARK', outcome: 'not-dispatched' })
}

function sameMarkFrame (a, b) {
  return !!a?.sig && a.sig === b?.sig && a.hwnd === b.hwnd && a.pid === b.pid &&
    ['x', 'y', 'width', 'height'].every(k => Number.isFinite(a.region?.[k]) && a.region[k] === b.region?.[k])
}

/** Keep secrets out of the audit log. */
function redact (args) {
  if (args && typeof args.text === 'string' && args.text.length > 0) {
    return { ...args, text: `<${args.text.length} chars>` }
  }
  return args
}

/**
 * Turn a flat UIA dump into clickable marks — id, centre, role, name, in reading order
 * (top-to-bottom then left-to-right). Shared by `marks()` (annotated screenshot) and
 * `landmarks()` (cached, image-free map), so both produce identical ids for the same UI.
 */
function buildMarks (flat, maxMarks = 60, minSize = 8) {
  const seen = new Set()
  const interactive = []
  for (const e of flat) {
    if (interactive.length >= maxMarks) break
    const r = e.rect || {}
    const name = (e.name || '').replace(/\s*\r\n\s*/g, ' | ').trim()
    const key = `${e.role}|${name}|${r.x},${r.y}`
    const clickable = SOM_ROLES.has(e.role) || SOM_PATTERNS.test((e.patterns || []).join(','))
    if (name && !seen.has(key) && clickable && r.width >= minSize && r.height >= minSize) {
      seen.add(key)
      interactive.push({ ...e, name })
    }
  }
  interactive.sort((a, b) => (a.rect.y - b.rect.y) || (a.rect.x - b.rect.x))
  return interactive.map((m, i) => ({
    id: `M${i + 1}`,
    x: m.rect.x, y: m.rect.y, w: m.rect.width, h: m.rect.height,
    cx: m.rect.x + Math.floor(m.rect.width / 2), cy: m.rect.y + Math.floor(m.rect.height / 2),
    name: (m.name || '').slice(0, 90), role: m.role,
  }))
}

function discoverWorker () {
  const local = join(process.env.LOCALAPPDATA || '', 'dsh-computer-use', 'worker')
  // A newer test binary is not a newer compatible implementation. Only the
  // build keyed by this package's worker source can serve its wire protocol.
  try {
    const sha = createHash('sha256').update(readFileSync(join(__dirname, 'worker.cs'))).digest('hex').slice(0, 16).toUpperCase()
    const exe = join(local, sha, 'dsh-computer-use-worker.exe')
    if (!existsSync(exe)) return null
    const out = execFileSync(exe, ['--op', 'ping'], { encoding: 'utf8', timeout: 4000, windowsHide: true })
    return /"pong"\s*:\s*true/.test(out) ? exe : null
  } catch { return null }
}

/** Use the prebuilt release worker, or Windows' own compiler in a source checkout. */
function compileWorkerSync (log) {
  return prepareNativeBinary({ source: join(__dirname, 'worker.cs'), name: 'dsh-computer-use-worker.exe',
    cache: 'worker', references: workerReferences() }, { log })
}

export { discoverWorker }
