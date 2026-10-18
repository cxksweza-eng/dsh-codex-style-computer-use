import { installHumanAttention } from './attention.js'
// dsh-computer-use — DSH Cordis plugin
//
// Native DSH integration for computer use. Mirrors the @anweat/dsh-browser
// plugin pattern: settings registration, a pure-function policy gate hooked
// into tools/pre-execute, and defineTool() registrations from
// @deepseek-ai/dsh-tools. All heavy lifting lives in
// @dsh/computer-use-core (native worker + SoM + audit).
//
// Approval mapping (see lib/policy.js):
//   read-only      → observation only, actuation denied
//   standard       → observation allowed, every actuation asks (harness approval UI)
//   autonomous     → actuation allowed except high-risk ops (still asks)
//   unrestricted   → everything allowed (worker failsafe corner + rate limit remain)
//
// Two out-of-band behaviours live here rather than in the tool layer, because both are
// triggered by things that happen while the MODEL is not calling anything:
//
//   1. THE BRAKE IS ANNOUNCED INTO THE SESSION. The native worker's low-level keyboard hook
//      fires the instant the human hits ESC / Ctrl+Alt+Q and writes an unsolicited NDJSON
//      event; that event is steered into the running session, so the model learns it was
//      stopped mid-turn instead of on the human's NEXT message (2026-09-13 requirement).
//      It cannot go through `tools/pre-execute`: PreToolDecision is {kind:'allow'|'deny'|'ask'}
//      only — that hook has no message channel at all.
//   2. THE ACTIVITY BORDER IS CUT INSTANTLY WHEN THE TURN ENDS (`agent/status` → idle), so a
//      lingering blue border can never claim the machine is still being driven.

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { ComputerUse } from './core/index.js'
import { policyDecision, HIGH_RISK_NOTE } from './policy.js'
import { acknowledge, isAcked, ACK_HINT, isDrivingCall } from './skill-gate.js'
import { mkDataDir, snapshotPath, appendAudit } from './audit.js'
import { registerTools } from './tools.js'
import { installToolExposure, ACTIVATION_TOOL } from './exposure.js'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { createCycleGate, agentKeyOf } from './cycle.js'
import { cycleEndVerdict } from './cycle-lifecycle.js'
import { recoveryProblem } from './recovery.js'
import { getSharedRegistry, noteHostCallId } from './action-registry.js'
import { registerEnhancedTools } from './enhanced-tools.js'
import { BrowserSession } from './browser-session.js'
import { registerBrowserTools } from './browser-tools.js'
import fs from 'node:fs'


/**
 * Record the turn-end decision path where it can be INSPECTED AFTER THE FACT.
 *
 * The human asked twice "我还是没亲眼看到触发", and there is no way to read the host's own log from
 * here — so a feature whose whole job is to make itself visible had no way to be debugged. Both
 * outcomes are recorded, because "it did not fire" is the answer that actually needs a reason.
 * A diagnostic that can throw would be worse than none: it must never break a turn.
 */
function diagTurnEnd (what) {
  try {
    const p = path.join(os.homedir(), '.dsh', 'data', 'computer-use', 'turn-end-diag.log')
    fs.appendFileSync(p, `${new Date().toISOString()} ${what}\n`)
  } catch { /* never break the turn for a log line */ }
}

/**
 * Build a REAL user message for `agent.steer()` / `agent.inject()`.
 *
 * WHY THIS IS A MODULE-LEVEL FUNCTION AND NOT AN INLINE OBJECT (measured crash, 2026-09-15). The
 * turn-end card's 继续 / custom-text branches used to call `recipient.steer({ text: '继续' })` — a bare
 * object with no `source`. `steer` puts the message straight into the agent's inbox, and the harness's
 * own listeners read it as a UserMessage:
 *
 *   `@deepseek-ai/dsh-tool-jobs/lib/index.js:175`
 *     if (delivery === "wakeup") ctx.on("agent/inbox/claimed", ({ agent, message }) => {
 *       if (message.source.kind === "user") spentWakes.delete(agent);
 *     });
 *
 * With `source` undefined that line throws, the delivery dies, and the human sees the round fail —
 * measured, twice, immediately after selecting 继续:
 *   `[session-store] session/event listener threw: TypeError: Cannot read properties of undefined (reading 'kind')`
 *   `[agent-loop]   agent event "agent/inbox/claimed" listener threw: TypeError: ... reading 'kind'`
 * Both were swallowed by this plugin's own `try`, so the ONLY symptom was "选1之后崩溃".
 *
 * The shape is the one the harness itself uses (`createUserMessage({content, source})` → a message with
 * `{id, role:'user', content, source}`); the dynamic import is tried first so the real constructor owns
 * identity and freezing, and the hand-built fallback keeps the SAME four fields — the field that must
 * never be missing is `source.kind`. This function was previously nested inside `apply()` and used only
 * by `notice()`; it moved here so the card's branches cannot drift back to a bare object.
 */
async function buildUserMessage (text, form, detail) {
  // THE PRODUCER-OWNED V4 KIND (2026-09-30). Session format v4 REFUSES the retired plugin wrapper —
  // native admission throws `SessionFormatError: format v4 message requires a producer-owned source kind`
  // for `kind === 'plugin'`, which killed every round that steered a notice ("本轮运行失败"). The v3→v4
  // migrator lifts exactly this record with `rewritePluginSource()`: `producerKind()` maps a plugin to
  // `plugin:<name>` and the `plugin` field is DROPPED. Keep this literal in step with that function.
  const source = { kind: 'plugin:dsh-computer-use', form, ...(detail ? { summary: detail } : {}) }
  const content = [{ type: 'text', text }]
  try {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    if (typeof createUserMessage === 'function') return createUserMessage({ content, source })
  } catch { /* the host may not resolve the package for plugins; the fallback below is equivalent */ }
  return { id: `cua-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, role: 'user', content, source }
}
import os from 'node:os'
import path, { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// isDrivingCall lives in skill-gate.js (not here) so the guard can IMPORT it and test the
// classification behaviourally — including the rule that a batch is driving only if something inside
// it drives, which a text match could never check.

// ---- THE ONE QUESTION PATH (merge-design.md §1, §5.3 items 16-17) -------------------------------
//
// Before this, `computer_ask` and `ask_user_question` were two different questions: the first
// blocked the NATIVE worker in a clock-driven wait loop (and a caller-side timeout could kill that
// worker while the brake was still up — the measured leak), the second put a card in the chat. Now
// the worker only ENGAGES the brake (`beginAsk`) and RELEASES it (`endAsk`) — no clock, no loop, no
// wait — and the waiting happens on the client-UI card, with the release guaranteed by the `finally`
// in `ComputerUse.ask`. `ask_user_question` is untouched: both surfaces render the same card.
//
// THE ANSWER CHANNEL, AND WHERE IT LIVES. `askHuman` is the ONE orchestration both tool surfaces
// share (`computer_ask` and `computer_batch`). It reads the lazily-injected service at CALL time —
// never capturing it early — so a `ctx.inject(['userQuestions'], …)` callback that lands after this
// module was applied is still picked up.
let asker = null
let agents = null
// The verified Desktop-raiser, handed out by `enableHumanAttention` (see the return there). Used by
// the turn-end decision card: a card the human never sees is the same as no card.
let raiseHuman = null

/**
 * Put ONE question on the shared client-UI card and wait for the human, with no countdown.
 *
 * @returns {Promise<{answered:boolean, keepPause:boolean, selected?:string[], custom?:string, reason?:string}>}
 *   `keepPause` is the HUMAN's decision and the only thing that decides whether the brake stands:
 *   true when they chose `① 让你停`, false for every other ending (②, a typed custom answer, a
 *   dismissed card, an aborted turn, the tool deadline, a failed question channel).
 */
async function askOne (question, exec) {
  if (!asker || typeof asker.ask !== 'function') {
    throw new Error('the question UI is unavailable (userQuestions not injected)')
  }
  // CAPTURE BOTH SYNCHRONOUSLY, BEFORE ANY await — the host requires the exact live agent object,
  // and reading it after an await can hand the service an agent that has already moved on.
  const agent = exec && exec.agent
  const signal = exec && exec.signal
  // D3: the card carries the two choices as ORDINARY OPTIONS. Which one is listed first and which one
  // the client badges "(Recommended)" is the human's decision, recorded with the labels below. (This
  // comment used to assert "① first and badged" — it was left behind by the reordering and contradicted
  // the code underneath it, which is exactly the kind of stale prose a reader trusts instead of reading on.)
  //
  // THE HUMAN SELECTS AN OPTION AND THEN CONFIRMS — this is NOT a one-click answer. Measured in
  // `dsh-client-ui-user-questions/lib/client.js` (v of this deploy): an option is a `role="radio"`
  // in a `role="radiogroup"` (`:648`,`:655`) whose click only calls `choose(label)` (`:659-661`) —
  // a DRAFT edit; the answer is sent by the footer primary button (`:776-781` → `continueFlow`
  // `:559-570` → `submitDrafts` `:530-557`), or by Enter in the custom box once the draft is
  // complete (`:580-584`,`:662-666`). The one-click path in that file belongs to the `plan-review`
  // presentation (`:264-325`), which we do not use. Consequence for the labels below: they have to
  // read as a CHOICE THE HUMAN CONFIRMS, not as a button that acts on its own.
  // D3, AS DECIDED BY THE HUMAN (2026-09-15): **② 放你走 is listed FIRST and carries the
  // `(Recommended)` badge.** The client numbers options by POSITION (`client.js:671-673`) and badges
  // whichever label ends `(Recommended)` (`:651,683`), so "② first" and "the recommended one is badged"
  // can only both hold on the SAME option — that is this option, not ①. The human was offered both
  // readings and chose: keep driving is the promoted choice; keeping the brake (①) is the deliberate act.
  // Consequence: the number the card shows beside this option is 1 while its label still says ②. The
  // LABEL is what the answer carries back and what `keepPause` is keyed on below, so the mismatch is
  // cosmetic — do not "fix" it by renumbering or by reordering the array.
  const STOP_LABEL = '① 让你停（机器停住，等你 Ctrl+Alt+R 才继续）'
  const GO_LABEL = '② 放你走（放开刹车，我继续干）(Recommended)'
  const release = (extra) => ({ answered: false, keepPause: false, ...extra })

  // THE ANSWER MUST BE ABLE TO END WHEN THE HOST ABORTS THE CALL — and THIS RACE IS LOAD-BEARING,
  // NOT BELT-AND-BRACES. Do not "simplify" it away.
  //
  // MEASURED (merge-abort-evidence.md §0.2, V1/V2 both YES): `ctx.userQuestions.ask()` does NOT race
  // the signal itself. `dsh-user-questions/lib/index.js:53` pre-checks `signal.aborted` ONCE at entry
  // and `:73-78` only RE-LABELS a rejection afterwards — the service never aborts a pending
  // waterfall. "A cancelled turn ⇒ ASK_ABORTED" is therefore a property of the forwarded client
  // answerer and its transport, not of the seam: the host-side abort becomes a `{type:"cancel",
  // eventId}` frame (dsh-api-gateway/lib/index.js:649-673) that makes the client abort a locally
  // created controller the card listens to (dsh-api-gateway/lib/client.js:622-633). V1 confirms the
  // other half: the fused `exec.signal` really is aborted by a turn cancel
  // (dsh-api-session-controller:872-877 → dsh-agent-loop:798-804 → :1118 → :517-523 →
  // dsh-tools:3180-3192). So WITHOUT this race a cancelled turn would leave the brake up until the
  // human pressed Ctrl+Alt+R — the exact leak this merge removes. Whichever settles first wins.
  let onAbort = null
  const aborted = new Promise((resolve) => {
    if (!signal) return
    if (signal.aborted) { resolve(release({ reason: 'aborted' })); return }
    onAbort = () => resolve(release({ reason: 'aborted' }))
    try { signal.addEventListener('abort', onAbort, { once: true }) } catch { onAbort = null }
  })
  try {
    const reply = await Promise.race([
      asker.ask({
        questions: [{
          id: 'computer_ask',
          question,
          header: 'computer-use 正在提问',
          // ORDER IS SIGNIFICANT: ② first, per the human's D3 choice. The client renders in array
          // order and numbers by position, so this is what puts ② (with its badge) at the top.
          options: [{ label: GO_LABEL, description: 'The brake is released and the agent keeps driving.' },
            { label: STOP_LABEL, description: 'The machine stays stopped until you press Ctrl+Alt+R.' }],
        }],
        ...(agent !== undefined ? { agent } : {}),
        ...(signal !== undefined ? { signal } : {}),
      }),
      aborted,
    ])
    // An abort can win the race with a `undefined`-shaped reply; treat anything without `answers`
    // as "no answer came back" rather than reading a field off nothing.
    const answer = reply && Array.isArray(reply.answers) ? reply.answers[0] : null
    if (!answer) return release({ reason: 'aborted' })
    const selected = Array.isArray(answer.selected) ? answer.selected : []
    const custom = typeof answer.custom === 'string' && answer.custom.trim() !== '' ? answer.custom : undefined
    // THE PAUSE DECISION IS "IS THE ① LABEL IN `selected`" — never "did anything come back".
    // Three ways an answer arrives that are NOT a choice between ① and ②, and all three RELEASE:
    //   * a TYPED custom answer — client.js:546 makes a custom answer supersede `selected` in
    //     single-select, so `selected` is `[]` and the text is all there is. The human is talking to
    //     the agent; an unanswered brake would freeze the machine while they watch it.
    //   * a SKIP ("跳过此问题", client.js:585-595) — one click, and it auto-submits with
    //     `{selected: []}` and no custom text. An empty selection is not ①.
    //   * anything else with an empty selection, for the same reason: absent is not chosen.
    return { answered: true, keepPause: selected.includes(STOP_LABEL), selected, ...(custom === undefined ? {} : { custom }) }
  } catch (e) {
    // Every rejection here is a NO-ANSWER ending, and every one of them RELEASES the brake (a
    // dismissal is not an answer; the two explicit options are how the human chooses "stop"):
    //   * ASK_CANCELLED — the card's ✕ / 放弃整组问题 (client.js:136-142).
    //   * ASK_ABORTED   — the request was aborted (client.js:102-107), or aborted before it started.
    //   * NO_PROVIDER   — no answerer accepted the request in this profile.
    //   * DELEGATED_CALLER — THE CALLER IS AN OWNED CHILD AGENT. dsh-user-questions:56-60 refuses a
    //     question outright when the agent supplied is not a live runtime ROOT, and its own text says
    //     what to do instead: "human interaction is unavailable while the calling agent is owned by
    //     another live agent; include the unresolved question or decision in the child agent's final
    //     result". A subagent turn therefore CANNOT ask: we release the brake and hand back a reason
    //     that says so PLAINLY — never a silent `answered:false` the model could read as "the human
    //     ignored me". (`CALLER_NOT_LIVE` is mapped to the same sentence: it means the agent we were
    //     handed is not the live caller, so no human interaction is possible either.)
    const code = (e && e.code) || 'ask-error'
    return release({ reason: code === 'ASK_CANCELLED' ? 'cancelled'
      : code === 'ASK_ABORTED' ? 'aborted'
        : (code === 'DELEGATED_CALLER' || code === 'CALLER_NOT_LIVE')
            ? 'delegated: human interaction is unavailable while the calling agent is owned by another live agent — a subagent CANNOT ask the human; put the unresolved question or decision in the child agent\'s own final result and let the parent ask'
            : code })
  } finally {
    if (onAbort && signal) { try { signal.removeEventListener('abort', onAbort) } catch { /* already gone */ } }
  }
}

// Ctrl+Alt+Q's latch deliberately OUTLIVES the process (every fresh worker adopts the marker on
// disk). That is what makes an exit hold across restarts — and it is exactly why the TURN BOUNDARY
// has to be the thing that clears it, and why nothing else may (a stray op used to do it).
function exitRecordPath () {
  try {
    // Same override the worker honours (DSH_COMPUTER_USE_EXIT_FILE), so a test can point the whole
    // latch at an isolated directory and never touch the live record in %LOCALAPPDATA%.
    const env = process.env.DSH_COMPUTER_USE_EXIT_FILE
    if (env) return env
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'dsh-computer-use', 'EXITED')
  } catch { return null }
}

function exitedLatch () {
  try {
    const p = exitRecordPath()
    return !!p && fs.existsSync(p)
  } catch { return false }
}

// The RECORD ITSELF, not just its existence: the opener hands this text to the worker, which refuses
// to clear anything that no longer matches it. A Q that lands between this read and the worker's
// compare is therefore never silently undone (#6).
function exitRecordText () {
  try {
    const p = exitRecordPath()
    return p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
  } catch { return '' }
}

// The OTHER latch, the one nothing may ever clear except the human: the brake the worker persists
// while `_engaged`/`_stopped` are up (ESC, the human-presence monitor, an interrupted turn, an ask).
// Read with the same precedence as the worker's own `ResolveStopPath()`, so the plugin cannot be
// looking at a different file than the process it is about to talk to. This is a READ ONLY — the
// plugin has no business writing or deleting a brake (see ensureCycle: it must refuse to run while
// one is up, and `resume` is the only op it may send).
function brakeLatch () {
  try {
    const env = process.env.DSH_COMPUTER_USE_STOP_FILE
    if (env) return fs.existsSync(env)
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return fs.existsSync(path.join(base, 'dsh-computer-use', 'STOP'))
  } catch { return false }
}

// EVERY pause that needs a human must put Desktop IN FRONT, not just the approval ones.
//
// WHY THIS WAS BROADENED (human report, 2026-09-14): "我的界面只能看到你卡了一样，但根本就不知道
// 原来是需要我输入东西". An `ask_user_question` card (and an approval card) is rendered in the DSH
// chat, but if the human is working in another app the window never comes forward — so from their
// side the agent simply FREEZES with no visible reason, and the turn stalls until they happen to
// look. A pending input is useless if it is behind another window.
//
// COVERAGE — every surface where an agent turn blocks on a human:
//   * `user-questions/request` — the waterfall `ctx.userQuestions.ask()` runs; this is what
//     `ask_user_question` blocks on, and it is the ONLY path a question card can take (read from
//     @deepseek-ai/dsh-user-questions). Fires for every question surface, whatever the UI.
//   * `approval/asked` — a Host tool approval, the pre-existing case. Kept unchanged.
//   Both listeners are installed on the ROOT ctx AND inside the desktopRuntime-injected child,
//   because a scoped waterfall (`scopeTarget(agent, agent)`) is delivered to the matching scope:
//   whichever of the two sees it raises the window, and a dedupe window makes the pair idempotent.
//
// HOW: the launcher's own `desktopRuntime.show()` path (restore + show + focus). It is called ONLY
// when Desktop is not already the foreground window, so a human already looking at the chat is
// never yanked around — the point is to make a queue visible, not to steal focus on every card.
// This function NEVER answers, resumes, approves, or rejects anything: it only raises a window.
function enableHumanAttention (ctx, log) {
  return installHumanAttention(ctx, log)
}

// THE BUNDLED SKILL IS REGISTERED WITH THE HOST, NOT MERELY SHIPPED (2026-10-01).
//
// WHY THIS EXISTS: `skill-gate.js` refuses every DRIVING call until the session produces the receipt
// phrase that exists only inside `skills/computer-use/SKILL.md`. Shipping that file inside the
// package does NOT make it readable: the host's only discovery path is
// `@deepseek-ai/dsh-skill-filesystem`, which scans `<project>/.dsh/skills`,
// `<project>/.agents/skills`, configured custom dirs, `<dshHome>/skills` and `<agentsHome>/skills` —
// never `node_modules`. So a user who installs this plugin without ALSO copying the skill into
// `<dshHome>/skills` gets driving tools locked by a receipt from a manual that nothing serves, and
// the gate's own hint points at a path no provider can read. That is a release-breaking trap, and the
// host has a documented seam for exactly this case: `ctx.skills.register()` contributes an in-memory
// ("embedded") skill whose body is served from this package.
//
// WHY NOT IN `inject`: a service listed in `inject` that never resolves leaves the whole fiber
// INACTIVE and `apply` never runs at all (see the long note under `export const inject` below). The
// skill is an enhancement, never a precondition for the tools, so it goes through the same lazy
// `ctx.inject` seam the question service uses and degrades to one log line when the service is absent.
//
// A FILESYSTEM COPY STILL WINS WHERE ONE EXISTS: the registry resolves one name per layer by rank, so
// an existing `<dshHome>/skills/computer-use` keeps serving whatever the user has there and this
// registration only fills the gap where nothing else serves it. The body is re-read from disk on every
// activation, so the registered manual and the shipped file cannot drift apart.
const SKILL_DIR_URL = new URL('../skills/computer-use/', import.meta.url)

/** Split a SKILL.md's YAML frontmatter from its body, reading the flat scalar keys this needs. */
function splitSkillFile (raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(raw)
  if (!match) return { data: {}, body: raw }
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line)
    // An empty value is a nested block (mapping or sequence), not a scalar this reader needs.
    if (kv && kv[2] !== '') data[kv[1]] = kv[2].trim().replace(/^(['"])([\s\S]*)\1$/, '$2')
  }
  return { data, body: raw.slice(match[0].length) }
}

/**
 * Contribute the bundled `computer-use` skill to the host's skill registry when one is mounted.
 * Never throws into activation: a missing registry, an unreadable file or absent frontmatter leaves
 * the tools exactly as they were and says so in the log.
 */
function registerBundledSkill (ctx, log) {
  ctx.inject(['skills'], (sctx) => {
    const skills = sctx.skills
    if (!skills || typeof skills.register !== 'function') {
      log.warn('skills service is mounted but exposes no register() — the bundled computer-use skill stays unregistered; copy skills/computer-use into $DSH_HOME/skills to serve it from disk')
      return
    }
    const skillFile = fileURLToPath(new URL('SKILL.md', SKILL_DIR_URL))
    let raw
    try {
      raw = fs.readFileSync(skillFile, 'utf8')
    } catch (e) {
      log.warn(`bundled skill unreadable at ${skillFile} (${e.message}) — copy skills/computer-use into $DSH_HOME/skills to serve it from disk`)
      return
    }
    const { data, body } = splitSkillFile(raw)
    if (!data.name || !data.description) {
      log.warn(`bundled skill ${skillFile} lacks name/description frontmatter — not registered`)
      return
    }
    try {
      skills.register({
        name: data.name,
        description: data.description,
        ...(data.whenToUse ? { whenToUse: data.whenToUse } : {}),
        source: 'bundled',
        content: body,
        resourceBase: { kind: 'directory', path: fileURLToPath(SKILL_DIR_URL) },
      })
      log.info(`registered bundled skill '${data.name}' from ${fileURLToPath(SKILL_DIR_URL)}`)
    } catch (e) {
      log.warn(`skill registration refused for '${data.name}': ${e.message}`)
    }
  })
}

export const name = 'dsh-computer-use'
// `userQuestions` is the client-UI capability seam the question CARD comes from — the same one
// `ask_user_question` blocks on (merge-design.md §5.3 item 16). It is declared as an unconditional
// service by `@deepseek-ai/dsh-base` (`dsh-base/cordis.patch.yml`), which every profile this plugin
// is deployed to lists in `dsh.profile.bundles`, so injecting it cannot fail to resolve. Registering
// the tool through it is what makes `computer_ask`'s question appear on the SAME card, answered by
// the same UI, with the same no-countdown wait.
export const inject = ['tools', 'userQuestions']
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('enable the computer-use toolset'),
  progressiveTools: Schema.boolean().default(true).description('expose desktop execution tools only to Agents that load/activate computer-use; brakes remain available'),
  actionFeedback: Schema.boolean().default(true).description('post-input feedback for tested GLM 5.3 Flash / DeepSeek Flash routes; GLM 5.3 uses UIA state until its vision is verified'),
  automationMode: Schema.union([
    Schema.const('read-only').description('observation only'),
    Schema.const('standard').description('actuations require approval'),
    Schema.const('autonomous').description('actuations allowed, high-risk still asks'),
    Schema.const('unrestricted').description('everything allowed'),
  ]).default('standard').description('automation mode (mirrors dsh-browser)'),
  dryRun: Schema.boolean().default(false).description('simulate actuations, log only'),
  maxActionsPerMinute: Schema.number().default(60).description('core-level actuation rate limit'),
  workerExe: Schema.string().default('').description('explicit worker.exe path; empty = autodiscover/compile'),
  snapshotDir: Schema.string().default('').description('screenshot dir; empty = $DSH_HOME/data/computer-use/shots'),
  annotateMarks: Schema.boolean().default(true).description('draw SoM boxes on screenshots'),
  // Compatibility with saved settings only. Elapsed time never ends a computer-use cycle.
  calmAfterMs: Schema.number().default(0).description('legacy setting; ignored — computer-use cycles have no idle timeout'),
  // ---- WHAT THE 60 s TIMER DOES WHEN NOBODY ANSWERS (2026-09-15, the human's own design words) -------
  // "如果60s没回复，超时之后自动进行分支判断，是否必须终结还是按照你自己的理解继续" — the timer is meant
  // to BRANCH, not just stop. The shipped code implemented only the stop half and said so in a comment;
  // the human asked why. It is a setting because the judgement is theirs to set up ONCE, rather than the
  // agent improvising it at every timeout.
  //   'stop'      — the timer makes NO decision: the machine stays with the human, the cycle stays open.
  //   'recommended' — the timer executes the choice the CARD DECLARED as its recommendation. Note this is
  //                   a judgement about the AGENT's next turn, never about the machine: it does not close
  //                   the cycle and it does not release a human's brake.
  // WHETHER THERE IS A RECOMMENDATION IS NOT CONFIGURED — IT IS READ FROM THE TASK (2026-09-15).
  // A `turnEndAutoContinueMax` counter existed here for one revision; the human rejected it ("由且仅由问题
  // 任务的情形决定，而不是几次 … 不应该这样硬编码设计"). The branch is now decided per turn by whether a real
  // actuation reached the worker in that turn (see `turnSituation`), so there is no budget to configure.
  turnEndTimeoutAction: Schema.union([
    Schema.const('stop').description('no decision — wait for the human (default)'),
    Schema.const('recommended').description('execute the recommendation the card declared'),
  ]).default('stop').description('what the 60 s turn-end timer does when nobody answers'),
})

export function apply (ctx, config) {
  const log = ctx.logger('dsh-computer-use')
  if (process.env.DSH_COMPUTER_USE_KILL === '1') {
    log.warn('DSH_COMPUTER_USE_KILL=1 — plugin disabled by kill switch')
    return
  }
  if (!config.enabled) return
  registerBundledSkill(ctx, log)
  raiseHuman = enableHumanAttention(ctx, log)
  // THE QUESTION SERVICE, INJECTED LAZILY (merge-design.md §5.3 item 16 — defence in depth).
  // `inject` above already guarantees the service before `apply` runs; going through `ctx.inject` as
  // well means the tool does not depend on which of the two orderings the host happened to pick, and
  // that a service arriving later still lands. `enableHumanAttention` uses the same pattern for
  // `desktopRuntime` just above.
  // `agents` IS READ NON-FATALLY, AND DELIBERATELY NOT IN THE INJECT LIST (review finding 4, 2026-09-15).
  // Cordis semantics, verified in the library (`cordis/lib/index.js:1316-1328` `_refresh` → `_setEpoch`)
  // and `Inject.resolve` (:1490-1498): a service listed in `inject` that is NOT available leaves the
  // fiber's epoch INACTIVE and the callback NEVER RUNS — no call, no `undefined`, no error. Listing
  // `agents` there would therefore couple the PRE-EXISTING `computer_ask` (which needs only
  // `userQuestions`) to an unrelated service: one row-level override that disables the agents
  // registry would silently leave `asker` null and make a working tool throw. Both services ship in
  // the same base bundle today, so that is a hazard rather than a live break — and it is free to
  // remove. `ctx.get` reads a service without declaring it (`cordis/lib/index.js:754-764`), which is
  // exactly the "use it if it is there" this needs; the resolver degrades honestly without it.
  ctx.inject(['userQuestions'], (qctx) => {
    asker = qctx.userQuestions
    agents = qctx.get('agents')
    if (!asker || typeof asker.ask !== 'function') log.warn('userQuestions injected but exposes no ask() — computer_ask cannot put a question on the card')
    if (!agents || typeof agents.roots !== 'function') log.warn('agents registry unavailable — a turn-end card cannot verify its caller; it will log the refusal instead of raising a card in the wrong chat')
  })
  // ---- AND A SECOND, INDEPENDENT INJECTION FOR THE REGISTRY (review re-audit E1, 2026-09-15) --------
  // `ctx.get('agents')` above is evaluated ONCE, when the userQuestions callback runs. If the registry
  // was not active at that instant — dsh-base mounts `user-questions` before `agent`
  // (`dsh-base/cordis.patch.yml:64` vs `:67`), so the ordering is a race this plugin does not control —
  // or if it is re-registered later (plugin reload, a row re-enabled from the plugins UI), `agents`
  // would stay null for the process lifetime and EVERY turn-end card would be refused silently.
  // This assignment-only injection self-heals that: when the registry appears, cordis runs this
  // callback and `agents` is set. It CANNOT hurt `asker`, because a listed service that never appears
  // simply leaves this fiber's callback unrun — the coupling finding 4 was about is not reintroduced.
  ctx.inject(['agents'], (actx) => {
    agents = actx.agents
    log.info('agents registry became available — turn-end cards can verify their caller')
  })

  // settings card (restart-applies) — same shape dsh-pocket/dsh-browser use
  ctx.inject(['settings'], (ctx2) => {
    ctx2.settings.register('computer-use', Config, { applies: 'restart' })
  })

  const dataDir = mkDataDir(config.snapshotDir)
  // ONE registry for the whole PROCESS, not merely for this apply() call. Two runtime probes proved
  // the two paths were served by different instances: the tool wrapper created and published a record
  // (`sizeAfter: 1`), while the approval hook — moments later, same log — reported `registrySize: 0`.
  // A registry the approval hook cannot see cannot move an action to WAITING_APPROVAL, which is the
  // whole reason it exists. `getSharedRegistry` hands out one instance per process, and the pending
  // action travels ON it for the same reason: a per-instance field is invisible across instances.
  const actionRegistry = getSharedRegistry({ log: (m) => log.info(m) })
  const cu = new ComputerUse({
    workerExe: config.workerExe || undefined,
    dryRun: config.dryRun,
    kickoffRequired: config.automationMode !== 'read-only',
    rateLimit: { max: config.maxActionsPerMinute, windowMs: 60_000 },
    log: (m) => log.info(m),
  })
  cu.on('action', (rec) => appendAudit(dataDir, rec))

  // ---- the live agent of the session that drives this machine ------------------------------
  // Captured from the tool execution itself (`exec.agent` is the live Agent object); a session
  // only ever gets here by having called a computer_* tool.
  const bus = { agent: null, driverSession: null }

  // Telling sessions apart without assuming the host's shape: an id may be the session object
  // itself, a string, or a field on it. We only ever see it through these helpers.
  const sessionKey = (s) => {
    if (!s) return null
    if (typeof s === 'string') return s
    return s.id || s.sessionId || s.key || null
  }
  const sameSession = (a, b) => {
    if (a === b) return true
    const ka = sessionKey(a), kb = sessionKey(b)
    return ka !== null && kb !== null && ka === kb
  }
  const describeSession = (s) => {
    if (!s) return 'unknown'
    const k = sessionKey(s)
    if (k) return String(k)
    return '<' + ((s.constructor && s.constructor.name) || typeof s) + '>'
  }
  // ---- THE AGENT EVERY QUESTION MUST NAME (2026-09-15) -----------------------------------------
  // MEASURED FAILURE, not a theory. The turn-end card was dispatched and the host answered
  //   22:57:16.836  turn-end card: NO ANSWER (NO_PROVIDER) — nothing steered, no choice was made
  // and no card was ever rendered — while the raiser itself worked fine (two seconds later it logged
  // "Desktop already in front for pending question (1 question(s): computer_use_turn_end)").
  //
  // CAUSE (`@deepseek-ai/dsh-api-remotes/lib/index.js:115-124`): the remote forwarder that carries a
  // question to the browser's card is a WATERFALL listener that begins
  //     const carrierAgent = carrierKeyOf(this); if (carrierAgent === void 0) return next();
  // so an agent-LESS request is never forwarded to the client's answerer
  // (`dsh-client-ui-user-questions/lib/client.js:880`). Nobody accepts, and the service rejects with
  // NO_PROVIDER. `dsh-user-questions/README.zh.md:41` says the same thing in words: "Web 回答者只接收带
  // Agent scope 的请求；不含 agent 的程序化请求仍会交给本地未限定 scope 的 waterfall listener，若无人
  // 接受则以 NO_PROVIDER 失败." The host's own `ask_user_question` always passes `agent: exec.agent`.
  //
  // WHY NOT SIMPLY PASS `bus.agent`: `ask()` validates it (`lib/index.js:56-60`) — it must be the
  // registry's EXACT live instance (`agents.get(a.id) === a`, else CALLER_NOT_LIVE) AND a live ROOT
  // (`agents.roots().includes(a)`, else DELEGATED_CALLER). `bus.agent` is the last tool caller, which
  // is right in practice but unverified, and a wrong agent fails in exactly the same silent way this
  // whole bug did. So the caller is verified FIRST and only replaced when the registry disapproves —
  // and every replacement is logged, so a fallback can never masquerade as the normal path.
  //
  // "LIVE ROOT" IS NOT ENOUGH — IT MUST BE THE ROOT OF THIS SESSION (found by RUNNING this function,
  // 2026-09-15, not by reading it). Liveness and rootness say nothing about WHICH chat the card is
  // for: another session's live root passed both checks and was returned as `verified`, so a turn that
  // ended in THIS chat could raise its card in another one. `session` is therefore part of the test,
  // and a candidate that is a live root of some OTHER session is treated as rejected — never adopted
  // merely because the registry does not object.
  const rootAgentFor = (session, candidate) => {
    try {
      if (!agents || typeof agents.roots !== 'function') return { agent: candidate, ask: false, reason: 'no-registry' }
      const roots = agents.roots()
      const live = (a) => !!a && !!agents.get && agents.get(a.id) === a
      const ofSession = (a) => !!a && session !== null && session !== undefined &&
        sameSession(a.session || a.sessionId, session)
      const isRoot = (a) => !!a && roots.includes(a)
      // ---- EXACTLY ONE ROOT OWNS THIS SESSION; THAT ROOT IS THE CORRECT CALLER ------------------
      // `roots()` is store-derived, so a fresh lookup cannot be stale; re-running `live` keeps the
      // "exact live instance" guarantee explicit rather than inferred from the filter.
      const same = roots.filter(ofSession)
      if (live(candidate) && isRoot(candidate) && ofSession(candidate)) {
        return { agent: candidate, ask: true, reason: 'verified' }
      }
      if (same.length === 1 && live(same[0])) {
        return { agent: same[0], ask: true, reason: live(candidate) && isRoot(candidate) ? 'other-session-root' : 'registry-root-by-session' }
      }
      // ---- NOTHING VERIFIED: SAY SO, AND DO NOT LET THE CALLER ASK WITH THIS AGENT ---------------
      // `ask:false` IS THE FIX, NOT A LABEL (review finding 2, 2026-09-15). The previous version
      // returned the raw candidate here with `verified` withheld — but `ask()` accepts a live root of
      // ANY session, so the card was raised in the WRONG CHAT. And a same-name note could not carry
      // the distinction: 'other-session-root' is also the CORRECT substitution just above. So the
      // decision travels as its own boolean, and `ask` remains a value only for the message.
      let reason
      if (live(candidate) && isRoot(candidate)) reason = 'other-session-root'
      else if (!candidate) reason = 'no-candidate'
      else if (!live(candidate)) reason = 'not-live-instance'
      else if (!isRoot(candidate)) reason = 'not-a-root'
      else reason = 'session-mismatch'
      return { agent: candidate, ask: false, reason: `${reason}/roots=${roots.length}/match=${same.length}` }
    } catch (e) {
      return { agent: candidate, ask: false, reason: 'resolve-threw:' + ((e && e.message) || 'unknown') }
    }
  }

  // ---- THE "CARD LOOP" HAD A DIFFERENT CAUSE, AND A SUPPRESSION FLAG WAS THE WRONG FIX -----------
  // Measured at 23:22: selecting 继续 produced the card again 2 s later, and again 5 s after that, until
  // the human cancelled it (`NO ANSWER (ASK_CANCELLED)`). A `suppressCardForTurn` flag was added for
  // that — and the re-audit showed it was BACKWARDS, from the turn-end diagnostic file:
  //
  //   15:22:12.724Z CARD … ask=yes via=verified        ← the card the human answered
  //   15:22:23.039  TypeError … reading 'kind'          ← the steer's bare object crashed the round
  //   15:22:23.048Z FIRED kind=error / CARD …           ← 10 ms later — an ERRORED turn, not a new one
  //   15:22:30.588Z FIRED kind=error / CARD …
  //
  // There was never an echo: 继续 → crash → the turn ended as `kind=error` → a card for the errored turn.
  // The flag could not have suppressed that anyway — `steer` wakes the driver, the loop appends
  // `turn/start` immediately, and the `turn/start` handler cleared the flag before the card ever read it.
  // So it suppressed the case it was not meant to touch (a normal card-steered turn, where the human DOES
  // want to be asked) and could never fire for the case that actually looped. It is REMOVED rather than
  // repaired: the driver of that loop was the message-shape crash, and that is fixed at its source.
  //
  // WHAT DOES REMAIN TRUE: an errored turn raises the same decision card. That is deliberate — the human
  // should still decide what happens to the machine — but the card now SAYS the turn errored, so it is
  // not mistaken for an ordinary completion.
  // THERE IS NO machine-wide suppression flag here. If a future measurement shows a genuine echo, it must
  // be bound to (sessionKey, turn) and justified by evidence of that shape — not by this one.

  let inFlight = 0
  // Ctrl+Alt+Q cancels the turn ON PURPOSE. The abort that follows must never be mistaken for
  // the human hitting the stop button — that rule below re-armed the brake and left the red
  // border burning on screen after an exit (reported 2026-09-12).
  let selfAbortUntil = 0
  // Did THIS TURN already receive the "read the procedure" nudge? Reset at turn/start — the manual
  // is per-turn knowledge, not per-session state.
  let nudgedTurn = false
  // Did THIS TURN already open a computer-use cycle? Reset at turn/start, next to nudgedTurn —
  // same reason, same axis: a cycle belongs to a turn, not to a session.
  // NOTE (2026-09-13): the module-wide `cycleOpenedThisTurn` boolean is GONE. It was reset by ANY
  // session's turn/start (a host-wide event) and never set on the normal path, so it both leaked
  // across sessions and failed to stop a same-turn resurrection. lib/cycle.js now keeps the
  // qualification per (session, agent, turn) and consumes it on the first call of that turn.

  // ---- OPENING THE CYCLE WHERE THE CALL ACTUALLY HAPPENS ----------------------------------------
  //
  // THE BUG THIS EXISTS FOR (measured 2026-09-13, host log dsh-2026-09-13.log): a machine-wide
  // `%LOCALAPPDATA%\dsh-computer-use\EXITED` record outlives every process, and exactly ONE thing
  // clears it — the worker op `resume`. The plugin used to send that op only from the `turn/start`
  // branch below, gated on the turn belonging to `bus.driverSession`, which is only ever set by a
  // PREVIOUS session's tool call. So a BRAND-NEW session's first turn always failed `mine`:
  //   01:17:44.287  EXITED written (Ctrl+Alt+Q)
  //   01:19:51.641  a new session started its first turn — bus.driverSession still named the OLD
  //                 session → mine === false → resume() never sent
  //   01:19:55.033  its first computer_* call finally set bus.driverSession (too late: the boundary
  //                 had already passed)
  //   01:21:34.627  its first DRIVING call was refused: CYCLE-ENDED — and the agent then told the
  //                 human "you pressed Ctrl+Alt+Q".
  // A new session could therefore NEVER re-open computer use, and the turn boundary — a host-wide
  // event that says nothing about who is about to touch this machine — was the wrong place to decide.
  //
  // The right place is the call that is about to reach the worker. `ensureCycle` is awaited from the
  // ONE dispatch point every computer_* invocation passes through exactly once (lib/tools.js, the
  // `reg()` wrapper around every tool's execute), BEFORE the op is written to the worker's stdin, so
  // the ordering is enforced by an `await` in the same async chain rather than by a race between a
  // host event and a tool call. The latch makes it once per turn.
  //
  // A BRAKE IS NOT AN EXITED LATCH (hard rule — a human's brake must never be cleared by this):
  //   * only `resume` may be sent, and the worker's `resume` is `Panic.AgentCalling()`, which
  //     touches the EXITED latch ONLY — it does not clear `_engaged`/`_stopped` and does not delete
  //     the STOP file, so Ctrl+Alt+R stays the human's alone;
  //   * and this refuses to run at all while a brake is up (`cu.stopped` from the worker's `panic`
  //     event, or the persisted STOP latch), because the core's `resume()` also mirrors the state
  //     locally (`this.stopped = false`) — calling it under a brake would drift the plugin's view
  //     from the worker's while the worker still refused every actuation.
  // THE CYCLE GATE (2026-09-13, A+B from the Codex review). lib/cycle.js holds identity, ownership
  // and the per-turn qualification; this file only feeds it events and asks it, at the ONE dispatch
  // point every computer_* call passes through, whether this call may drive.
  const gate = createCycleGate({ sessionKey, agentKey: agentKeyOf, now: () => Date.now() })
  const pendingApprovals = new Set()
  let unknownApproval = false, recoveryEpoch = 0, temporaryPause = null
  // WHY THE BRAKE IS UP, kept so a refused call can say it (see `hooks.askBlocked` below). The worker
  // already sends the reason with the `panic` event; this holds it from that moment until the brake is
  // released, because by the time a call is refused the event itself is long gone.
  let brakeWhy = ''
  const recoveryBlocked = (exec) => recoveryProblem(temporaryPause, claimOf(exec), gate.snapshot(),
    pendingApprovals.size > 0 || unknownApproval, cu.exited || exitedLatch())

  // Is the machine PAUSED or ASKING right now? Three independent witnesses, because any one of them
  // can be missing: the core's mirror of the worker's brake (`cu.stopped`), the persisted STOP latch
  // every process obeys, and the gate's own state derived from the panic/ask events. A pause is the
  // human holding the machine: the cycle, its owner and the red border stay until they resume or end
  // it, so nothing that "cleans up idleness" may touch it (F1 — both the idle signal and its
  // watchdog used to).
  const pausedOrAsking = () => {
    try {
      const st = gate.state()
      return st === 'paused' || st === 'asking' || cu.stopped === true || brakeLatch()
    } catch { return false }
  }

  // The claim a call brings — its OWN session and agent. NOT `bus.driverSession`: that is written
  // only by a previous call, and gating on it is exactly why a brand-new session could never open a
  // cycle (measured 01:19:51: `mine === false`, resume never sent, its first driving call refused).
  const claimOf = (exec) => {
    const s = (exec && (exec.session || exec.sessionId)) ||
      (exec && exec.agent && (exec.agent.session || exec.agent.sessionId)) || null
    return gate.claim({ session: s, agent: exec && exec.agent })
  }

  const ensureCycle = async (exec) => {
    const cl = claimOf(exec)
    // `gate.open` RESERVES ownership synchronously and THROWS for a foreign claim, so reaching the
    // line below means this call is the owner — and only then is the machine's mailbox rebound.
    const pending = gate.open(cl, async () => {
      if (!cu.exited && !exitedLatch()) return { opened: false, reason: 'nothing to open' }
      if (cu.stopped || brakeLatch()) {
        // A BRAKE IS NOT AN EXITED LATCH: the plugin must never clear a human's brake, and the
        // core's resume() would drift `cu.stopped` while the worker still refused every actuation.
        log.warn('not opening a cycle: a brake is engaged (only the human\'s Ctrl+Alt+R releases it)')
        return { opened: false, reason: 'brake' }
      }
      // The record we are about to clear, quoted exactly, so the worker can refuse if a NEWER one
      // appeared while this op was on its way (an exit during a worker spawn or a stdin write).
      const expect = exitRecordText()
      // Rejections ride the SHARED qualification promise: every later call in this turn awaits the
      // same outcome instead of retrying it into a resurrection.
      await cu.resume(expect)
      if (!cu.exited && !exitedLatch()) {
        log.info('opened a new computer-use cycle for this turn (cleared the Ctrl+Alt+Q record left by an earlier cycle)')
        return { opened: true }
      }
      // Still a record after a resume that reported success: someone wrote a new one in between.
      log.warn('a computer-use exit record is still present after resume — a newer exit stands; the call that follows will be refused')
      return { opened: false, reason: 'a newer exit record stands' }
    })
    // THE MACHINE'S MAILBOX BELONGS TO THE OWNER (integration bug, 2026-09-13). Binding it in
    // `tools/pre-execute` meant EVERY caller rebound it — including one the gate was about to refuse
    // as foreign — so a Ctrl+Alt+Q could cancel the wrong session while the real owner kept working
    // (they also got the pause/ask/R messages). It is rebound here, where ownership is actually
    // taken, and nowhere else; caller-scoped prompts name their own agent explicitly.
    if (gate.owns(cl)) {
      if (exec && exec.agent) bus.agent = exec.agent
      if (cl.sessionKey) bus.driverSession = cl.sessionKey
    }
    return pending
  }

  // Keep only in-flight accounting for owner lifecycle events. No idle timer: approval waits,
  // thinking, and pauses keep the cycle until an explicit lifecycle event ends it.
  // ---- WHAT THE CARD RECOMMENDS, AND WHAT THE TIMER THEREFORE DOES (2026-09-15) ---------------------
  // ONE place decides both, so the card's text and the timer's behaviour cannot disagree — which is the
  // defect the human caught: the card promised "I will not start an unattended turn" while the design
  // words they remembered promised a branch.
  //
  // ---- AND THE BRANCH IS DECIDED BY THE TASK SITUATION, NOT BY A COUNTER ---------------------------
  // The first implementation capped consecutive automatic continuations with a config number (default 2).
  // The human rejected that design in one sentence: "由且仅由问题任务的情形决定，而不是几次。你现在刚我说
  // 是两次，不应该这样硬编码设计." They are right, and the counter also solved the wrong problem: it rationed
  // the TIMER, when what decides the branch is whether the work is still going.
  //
  // SO THE SITUATION IS READ FROM THE TASK, ONCE PER TURN:
  //   * `turnSituation.action = true` — an actuation really reached the worker during this turn, so the task
  //     was mid-motion when the turn ended. There IS somewhere to continue to.
  //   * nothing was dispatched — the turn was observation, an error, or a wrap-up. There is nothing to
  //     continue TO, so the timer makes no decision. That is the human's own rule, not a cap.
  // It is written by the `onDispatch` hook (see `hooks`), which fires at the last statement before the tool
  // body in `tools.js` — after every refusal has thrown — so "dispatched" is a fact, not an intention.
  //
  // ---- AND IT BELONGS TO ONE SESSION, NOT TO THE MACHINE (2026-09-16) ------------------------------
  // `turn/start` is a HOST-WIDE event, so a turn starting in another chat would clear this value — and the
  // mirror case is worse: chat A drives the machine, chat B starts a turn, chat A's turn ends, and A's card
  // carries a recommendation read from a machine-wide flag. `owner` names the session the situation
  // describes, and the timer only trusts it for that session.
  //
  // DECLARED BEFORE `hooks` ON PURPOSE: `hooks.onDispatch` closes over this object, and a body that reads a
  // `const` from its temporal dead zone is a run-time error waiting for the first driving call.
  const RECOMMEND_CONTINUE = '继续（按你自己的理解接着干）'
  const RECOMMEND_STOP = null   // "no recommendation" is the honest value when the task says nothing
  const turnSituation = { action: false, reason: '(no actuation reached the worker this turn)', owner: null, seq: [] }
  /** Does the recorded situation describe THIS session's turn? */
  const situationIsMine = (session) => !!turnSituation.owner && turnSituation.owner === sessionKey(session)

  // ---- THE STAGNATION SIGNATURE: A COMPARISON, NOT A COUNT (2026-09-16) -----------------------------
  // The human rejected a counter ("由且仅由问题任务的情形决定，而不是几次"). The remaining risk is a task that
  // drives on EVERY turn — a poll or retry loop — which no situation gate can stop, because each turn does
  // something. So the guard is a COMPARISON between two situations:
  //   * `lastDrive` is the tool sequence that justified the last automatic continuation;
  //   * if the next turn's sequence is IDENTICAL and the human has not answered in between, continuing is
  //     not progress — the same thing was done again — so the timer stops and says so.
  // It accumulates nothing, hardcodes no number, and any real progress changes the sequence. Its honest
  // weakness: a task that legitimately repeats one identical step would stop one iteration early — which
  // is the conservative direction, because the card is still raised and the human decides.
  
  let lastDrive = null          // { seq: string[] } — the sequence behind the last timer-driven continuation
  let humanAnsweredSince = false
  // ---- AND THE OBSERVATION-ONLY CASE (point 2, 2026-09-16) -----------------------------------------
  // A turn that only looked (a screenshot, a UIA read) has no dispatch, so the situation gate above said
  // "no recommendation" even when the work was plainly mid-task. `lastTurnDrove` carries the previous turn's
  // state forward for exactly one turn: an observation turn that FOLLOWS a driving turn is still mid-task,
  // so it may recommend once — and if the agent then keeps observing without driving, the same similarity
  // check stops it (the sequence would repeat).
  let lastTurnDrove = false
  const stalledNow = (session) => !!lastDrive && !humanAnsweredSince && situationIsMine(session) &&
    lastDrive.seq.length > 0 && lastDrive.seq.join('>') === turnSituation.seq.join('>')
  /** Record the situation that justified a continuation, so the NEXT identical one can be recognised. */
  const noteDrive = () => { lastDrive = { seq: [...turnSituation.seq] } }

  const recommendContinueNow = (kind, session) => {
    if (config.turnEndTimeoutAction !== 'recommended') return RECOMMEND_STOP
    if ((kind || 'completed') !== 'completed') return RECOMMEND_STOP   // an errored turn is never continued
    if (cu.stopped || brakeLatch()) return RECOMMEND_STOP             // a brake outranks a timer
    // A SITUATION THAT DOES NOT BELONG TO THIS TURN IS NO SITUATION: without this, an actuation in another
    // chat could recommend continuing in this one.
    if (!situationIsMine(session)) return RECOMMEND_STOP
    if (turnSituation.action) return continueOrStop(session)
    // Observation-only turn: still mid-task if the PREVIOUS turn drove, and only when that situation is not
    // itself a repetition of what the last automatic continuation already acted on.
    if (lastTurnDrove && turnSituation.seq.length > 0) return continueOrStop(session)
    return RECOMMEND_STOP
  }
  /**
   * The ONE mapping from "there is work to continue" to the recommendation. The polarity lives here and
   * nowhere else: an inverted ternary at a call site would continue exactly when the task did nothing, and
   * the reviewer showed that regression can keep every other assertion green.
   */
  const continueOrStop = (session) => (stalledNow(session) ? RECOMMEND_STOP : RECOMMEND_CONTINUE)
  /** Why the recommendation came out the way it did — for the log, which must not have to guess. */
  const recommendationReason = (session) => {
    if (stalledNow(session)) return '(the same sequence of tools was already continued for — repeating it is not progress)'
    if (turnSituation.action) return turnSituation.reason
    if (lastTurnDrove && turnSituation.seq.length > 0) return `(the previous turn drove the machine and this one only observed: ${turnSituation.seq.join('>')})`
    return turnSituation.reason
  }

  const hooks = {
    // ---- THE TASK SITUATION IS WRITTEN AT THE DISPATCH DOOR, NOT AT THE POLICY DOOR (2026-09-16) -----
    // `tools/pre-execute` runs BEFORE every refusal — the ownership verdict, the voided opening, the
    // cancellation, and the policy/brake gates inside `reg`. Marking the situation there meant a call that
    // was denied or refused could claim the task was in motion (and, worse in the other direction, a
    // HIGH-RISK actuation the human had just APPROVED looks like `kind: 'ask'` at the policy door, so the
    // timer would silently never recommend exactly when a dangerous action had just been authorised).
    // `tools.js` calls this immediately before `inner(args, exec)` — the last statement before the tool
    // body, after every refusal has already thrown. So this is the one place where "it was dispatched" is
    // a fact rather than an intention, which is what the recommendation is supposed to rest on.
    onDispatch: (exec) => {
      try {
        if (!exec || typeof exec.name !== 'string' || !exec.name.startsWith('computer_')) return
        // ---- EVERY computer_* DISPATCH IS RECORDED, AND THIS LINE WAS MISSING (defect, 2026-09-16) -----
        // The comment that used to sit here claimed "observation calls are recorded too". The code did the
        // opposite: it returned early for a non-driving call, so `seq` held DRIVING calls only. Two
        // consequences, both silent:
        //   * the observation-only rule in `recommendContinueNow` (`lastTurnDrove && seq.length > 0`) could
        //     never fire — `seq` was empty by construction on exactly the turn it was written for, so the
        //     feature was dead code that read as working;
        //   * `seq` could not serve as "this turn touched the machine at all", which is the fact the
        //     turn-end gate now needs (a billed, immediately-failing turn must not raise a card).
        // `seq` is the turn's SIGNATURE (which tools ran, in order); `action` stays the narrower claim
        // (something was ACTUATED) because the recommendation's honesty rests on that distinction.
        turnSituation.seq.push(`${exec.name}`)
        if (!isDrivingCall(exec.name, exec.arguments || {})) return
        turnSituation.action = true
        turnSituation.reason = `(${exec.name} actuated the machine during this turn)`
      } catch { /* a recommendation must never break a dispatch */ }
    },
    onStart: () => { inFlight++ },
    onEnd: () => {
      inFlight = Math.max(0, inFlight - 1)
      // A cycle end that arrived while this tool was still running is executed HERE, the moment the
      // last in-flight call settles. Without this, a turn/end landing during a tool call would be lost
      // forever and the border would stay lit. The request is re-validated at execution time against the
      // CURRENT cycle, so a stale request can never end a cycle that belongs to a later turn or another
      // session (rule C).
      if (inFlight === 0 && pendingCycleEnd) {
        const p = pendingCycleEnd
        pendingCycleEnd = null
        endCycleForSessionKey(p.sk, `${p.why} (after the last in-flight call settled)`)
      }
    },
    // ---- THE WRAP-UP DIRECTIVE (2026-09-15) --------------------------------------------------------
    // WHAT WENT WRONG. A human brake (ESC, a mouse shake, the wheel, typing outside the host) engaged
    // the brake and steered a "WRAP UP NOW" notice into the turn — but `agent.steer` only delivers at a
    // STEP BOUNDARY, so a turn already inside a long or in-flight call never read it, and OBSERVATION
    // calls kept succeeding while paused (`worker.cs:2401`: "the brake stops CONTROL, not
    // OBSERVATION"). The result the human actually saw, twice, in their own words: "卡停就是让你停住,
    // 关键是你没停啊? 你还在思考中啊" — the brake stopped the MACHINE while the agent kept walking,
    // because there was always one more legal step to take.
    //
    // THE FIX IS NOT TO CANCEL THE TURN (that was offered and rejected): the human's design is
    // "让我在知道我触发红框暂停之后快速收尾" — wrap up QUICKLY, not die silently. So every computer_*
    // call made while the brake is up is refused AT THE ONLY DOOR THEY ALL USE (registerTools' `reg`),
    // and the refusal itself carries the wrap-up directive. The instruction therefore arrives as the
    // RESULT of the call the model is already making — no step boundary to wait for, nothing to miss.
    //
    // Observations are refused too, deliberately. Leaving them open is what made "wrap up" optional:
    // the model could always take one more look, and did. The cost is real and accepted — the agent
    // cannot inspect the frozen screen to describe it — so the refusal names the brake's reason, which
    // is the one fact it would have gone looking for.
    //
    // `asking` is NOT refused: a question is the safety direction and the card is the answer surface.
    // `ended` is left to the cycle gate, which already owns that verdict.
    // SAFETY-DIRECTION EXEMPTIONS, and they are NOT optional: `computer_ctrl`, `computer_ask` and
    // `computer_batch` all go through the SAME `reg` wrapper, so a blanket refusal while paused would
    // have blocked the very tools the human needs in a stop — `computer_ctrl`'s `exit` (Ctrl+Alt+Q's
    // twin), its `stop`, and the `acknowledge` read-receipt — plus the question card itself. The skill
    // states the rule plainly: observation may be gated, the safety direction never is.
    askBlocked: (toolName) => {
      // SAFETY-DIRECTION TOOLS ARE NEVER GATED: `computer_ctrl` carries exit/stop/acknowledge/recover
      // and `computer_ask` is the question card. All three of these (plus `computer_batch`, which
      // reaches the same HANDLERS map) go through the one `reg` door, so a blanket refusal would have
      // blocked exactly what must keep working while stopped — the skill states the rule plainly.
      if (toolName === 'computer_ctrl' || toolName === 'computer_ask') return null
      // ONLY DRIVING IS REFUSED — the allowlist is the OBSERVATION tools, and everything else falls
      // through to be refused. (First shipped as "refuse everything", which was a REGRESSION the
      // independent audit caught: the AGENT'S OWN temporary pause also lands here, and `recover`
      // requires a successful observation first — `worker.cs` `RecoveryPermit.Observed` is set only by
      // windows/uia/capture/uiaFromPoint, and the worker answers `read the current target state after
      // this pause first` without it. Refusing observation turned `computer_ctrl{temporary:true}` into
      // a one-way door whose only exit was the human's Ctrl+Alt+R, while the text blamed the human.)
      // `computer_wait` and a clipboard READ are not observation ops in the worker's sense, but they
      // actuate nothing either, so they are deliberately left legal: refusing them would add no safety
      // and would hide the reason the agent is stopped.
      const OBSERVATION = toolName === 'computer_shot' || toolName === 'computer_state' ||
        toolName === 'computer_marks' || toolName === 'computer_uia'
      const st = gate.state()
      if (st !== 'paused') return null
      const agentOwnPause = !!temporaryPause
      if (agentOwnPause) {
        // An agent-owned diagnostic pause: observation must stay legal (it is how `recover` becomes
        // reachable), and actuation stays refused. The exit route is named because it is a credential,
        // and losing it really does leave only the human's Ctrl+Alt+R.
        if (OBSERVATION) return null
        return 'this is YOUR OWN temporary pause (computer_ctrl{temporary:true}) — actuation is refused ' +
          'until you release it. Observe the target, confirm the blocker is gone, then call ' +
          "computer_ctrl{action:'recover', pauseId:'<the credential your stop returned>'}. " +
          'Only a human Ctrl+Alt+R can release it if that credential is lost.'
      }
      if (OBSERVATION) {
        return 'the human has STOPPED this machine — ' + (brakeWhy || 'a brake is engaged') + '. ' +
          'Nothing will be dispatched, not even a look at the screen, so do not try. ' +
          'WRAP UP NOW in one or two sentences: what was interrupted and the exact state you left it in. ' +
          'Then stop and wait. Do NOT retry, do NOT start anything new, do NOT end the session, and do ' +
          'not ask the human to resume — Ctrl+Alt+R is theirs and it will wake you with "继续".'
      }
      return 'the human has STOPPED this machine — ' + (brakeWhy || 'a brake is engaged') + '. ' +
        'Nothing that drives it will be dispatched, so do not try. ' +
        'WRAP UP NOW in one or two sentences: what was interrupted and the exact state you left it in. ' +
        'Then stop and wait. Do NOT retry, do NOT start anything new, do NOT end the session, and do ' +
        'not ask the human to resume — Ctrl+Alt+R is theirs and it will wake you with "继续".'
    },
    // THE ANSWER CHANNEL (merge-design.md §5.4 item 23). It must exist BEFORE the first
    // `<ctx.tools.register>` call, because `computer_ask`'s handler reaches it — so it is assigned
    // here, where `hooks` is built, exactly like `temporaryStop`/`recover` below. It reads the
    // lazily-injected `asker` at CALL time (inside askOne), never at build time, so a
    // `ctx.inject(['userQuestions'])` callback that lands later is still picked up.
    askHuman: (question, info, exec) => askOne(question, exec),
    temporaryStop: async (exec, why) => {
      const claim = claimOf(exec), cycle = gate.snapshot(), epoch = recoveryEpoch
      if (!claim.sessionKey || !claim.agentKey || !gate.owns(claim) || cycle.state !== 'open' ||
          pendingApprovals.size || unknownApproval || exec?.signal?.aborted) {
        throw new Error('temporary pause requires the active owner and no pending approval; use ordinary stop for a handover')
      }
      const result = await cu.panic(why, true)
      if (result.pauseId && epoch === recoveryEpoch && gate.owns(claim) && gate.snapshot().id === cycle.id) {
        temporaryPause = { pauseId: result.pauseId, cycleId: cycle.id, ownerIdent: claim.ident }
      }
      return result
    },
    recover: async (exec, pauseId) => {
      const problem = recoveryBlocked(exec)
      if (problem || pauseId !== temporaryPause?.pauseId || exec?.signal?.aborted) {
        return { recovered: false, reason: problem || 'stale credential or cancelled call' }
      }
      const epoch = recoveryEpoch
      const result = await cu.recover(pauseId)
      if (result.recovered) {
        if (epoch !== recoveryEpoch || recoveryBlocked(exec) || exec?.signal?.aborted) {
          // An approval or Host interruption arrived while the native reply was in flight.
          if (!cu.exited && !exitedLatch()) await cu.panic('recovery superseded by a newer Host state')
          return { recovered: false, reason: 'a newer Host state kept the machine paused' }
        }
        gate.mark('open', { why: 'verified recovery of the owner agent temporary pause' })
        temporaryPause = null
      }
      return result
    },
  }

  // The brake must look and behave like a brake even if nothing is being driven right now.
  // The message SHAPE lives in `buildUserMessage` at module scope, because getting it wrong is a
  // measured crash (see that function): `agent.steer` publishes into the agent inbox, and the harness's
  // own listeners read `message.source.kind`.
  const buildMessage = (text, summary) => buildUserMessage(text, 'notice', summary)

  // Coalesce notices: the same kind at most once every 4 s. A burst of cards in the conversation
  // is itself a failure mode (reported 2026-09-12: seven injected cards in a row, "非常混乱") —
  // ESC, Ctrl+Alt+Q and the turn-cancel each emit an event, and the human often presses several.
  let lastNoticeKey = ''
  let lastNoticeAt = 0
  const notice = async (text, summary, opts) => {
    const nowMs = Date.now()
    if (summary === lastNoticeKey && nowMs - lastNoticeAt < 4000) {
      log.info(`notice coalesced (${summary})`)
      return
    }
    lastNoticeKey = summary
    lastNoticeAt = nowMs
    // WHO RECEIVES IT (integration bug, 2026-09-13). `bus.agent` is the MACHINE's event recipient and
    // is bound to the cycle's OWNER; a caller-scoped message (the procedure nudge, the acknowledge
    // receipt) passes its own agent explicitly, because those are addressed to the caller — but they
    // must never move the machine's mailbox. `opts.agent` is that explicit address, and it is read
    // here, synchronously, so a later await cannot re-route a message already being delivered.
    const agent = (opts && opts.agent) || bus.agent
    if (!agent) { log.info(`brake notice (no live agent captured yet): ${summary}`); return }
    const msg = await buildMessage(text, summary)
    const wake = !!(opts && opts.wake)
    // THE LAST ASYNC BOUNDARY BEFORE DELIVERY (boundary bug, 2026-09-13). `buildMessage` awaits a
    // dynamic import, so a caller's `valid` predicate is re-checked HERE — after every await and
    // immediately before the steer/inject. A Ctrl+Alt+Q that lands while a "继续" is being built must
    // invalidate it: otherwise the human ends the session and the agent is woken anyway by the wake
    // that was already in flight (measured: steer called once with the gate correctly `ended`).
    if (opts && typeof opts.valid === 'function') {
      let ok = false
      try { ok = !!opts.valid() } catch { ok = false }
      if (!ok) { log.info(`notice dropped at delivery: the state changed while it was being built (${summary})`); return }
    }
    try {
      // Shape copied from the in-tree `dsh-tool-jobs` notifier: a RUNNING agent is steered (it
      // is heading for a step boundary anyway, so the notice is read at the next step of the
      // SAME turn, without a human message); an IDLE agent gets a silent inject, because
      // steering an idle agent wakes the driver and would start — and bill — a whole new turn.
      //
      // `wake` INVERTS that default on purpose, and only Ctrl+Alt+R uses it. After a brake the
      // turn is over — the agent wrapped up and stopped — so a silent inject left the human
      // stuck: the red border went away, nothing was running, and the only way to get the agent
      // moving again was to type a message by hand. The human's spec (2026-09-12): "我
      // CTRL+ALT+R 之后，相当于是在和你的对话框里直接输'继续'两个字". Steering an idle agent is
      // EXACTLY that — it starts a turn — so R now wakes the agent instead of merely informing it.
      if (wake || agent.status === 'running') { agent.steer(msg); log.info(`steered${wake ? ' (wake)' : ''}: ${summary}`) }
      else { agent.inject(msg); log.info(`injected (idle): ${summary}`) }
    } catch (e) { log.warn(`could not deliver the brake notice: ${e.message}`) }
  }

  // The brake. WHO caused it is carried by `why` — do not name a key here: the same brake also
  // is reserved for a durable manual/explicit pause. Ordinary physical activity
  // travels through the core handoff state and never injects a wrap-up notice.
  cu.on('panic', (e) => {
    // NO calm() HERE (F1, 2026-09-13). calm in the worker is `CycleLit=false; Disarm(); Glow.Kill()`:
    // on a PAUSE it ended the cycle the pause is supposed to keep alive, dropped the monitors, and
    // made `probe` report a dead cycle — while the red border survived anyway, because Engage had
    // already set `_stoppedMode` and the render loop derives want=4 from it. A pause keeps the
    // cycle, its ownership and the human's Ctrl+Alt+R; it is not a cycle end.
    gate.mark('paused', { why: (e && e.why) || 'panic' })
    // REMEMBER THE REASON for `hooks.askBlocked`: the panic event is consumed here and cannot be
    // replayed when a later call is refused, and the brake's reason is the one thing a wrapping-up
    // agent would otherwise have made a (now-refused) observation to find out.
    brakeWhy = (e && e.why) || 'the human stopped the machine'
    if (e && e.pauseId) {
      // This was requested by the active agent; its tool result carries the credential.
      // Do not inject WRAP UP / wait-for-human instructions into its diagnostic work.
      return
    }
    recoveryEpoch++; temporaryPause = null
    notice(
      `COMPUTER USE STOPPED — ${(e && e.why) || 'unknown reason'}. ` +
      'Every actuation is refused and the screen border is red until a human resumes with Ctrl+Alt+R. ' +
      'WRAP UP NOW in one or two sentences: what was interrupted and the exact state you left it in. ' +
      'Then stop working and wait. Do not retry, do not start anything new, and do not call resume yourself. ' +
      'Write that state line so it can be resumed FROM — Ctrl+Alt+R will wake you with "继续". ' +
      '(The human can also press Ctrl+Alt+Q to end the session outright.)',
      // The summary is a COALESCING KEY and a card title, not a diagnosis: name the EVENT, never
      // a key. It read "computer-use aborted (ESC)" until 2026-09-13, when the human's own log
      // showed a wall of abort cards labelled ESC whose real reason was `vk 0xA4` (left Alt, i.e.
      // their Ctrl+Alt+R re-arm) — the label had been lying about the mouse monitor and the
      // keyboard monitor for a whole session, exactly what the comment above warns against.
      'computer-use aborted')
  })
  // Ctrl+Alt+R is the human's 继续 key: it must WAKE the agent, not merely clear the border.
  // Before 2026-09-12 it only cleared the border, so after a mouse-shake brake the human was left
  // holding a dead turn and had to type a message by hand to get the agent moving again — their
  // own report: "再按 CTRL+ALT+R 只是消除红框，没有办法继续注入 prompt 激活你了".
  // A wake that costs one turn is the POINT here; everything else still gets the silent inject.
  // THE AGENT ASKED A QUESTION (2026-09-12). The worker has stopped the machine and raised the
  // fast-breathing red border; the QUESTION itself is no longer injected here as a notice — the
  // client-UI CARD is the answer surface now (merge-design.md §5.3 item 19). It carries the two
  // choices and waits with no countdown, and the notice that used to live here promised a clock and
  // duplicated the question ("if you touch nothing, the agent decides alone"), which stopped being
  // true the moment the worker lost its clock. A card and a chat notice showing the same question is
  // exactly the "非常混乱" burst the notice coalescer exists to avoid. What stays is the STATE this
  // event carries, which the cycle gate needs to hold the owner while the question is open.
  cu.on('ask', () => {
    recoveryEpoch++; temporaryPause = null
    // ASKING IS NOT EXITING (C). The worker has paused the machine INSIDE a live cycle (red,
    // fast-breathing, no countdown); the cycle keeps its owner so the answer resumes it.
    // (`e.why` still carries the question text and is deliberately unused here — the card shows it.)
    gate.mark('asking', { why: 'ask' })
  })

  // THE ASK WINDOW CLOSED — FINISH THE `asking` STATE (lifecycle bug, 2026-09-13). Only a human
  // Ctrl+Alt+R used to move the gate off `asking`, and an unanswered ask never emits `resume` on
  // purpose, so the machine stayed "asking" for good: the owner's idle and its normal turn/end were
  // both refused as if the human were still holding it, the light never closed, and EVERY other
  // session was refused forever. This is not a resume and must never be reported as one: no resume
  // event, no brake cleared. It only settles the state the gate was holding open, from the truth the
  // core mirrored AFTER the window closed — so a late exit (state `ended`, which the gate refuses to
  // leave) or a newer stop (mirrored as stopped) keeps whatever is really there.
  cu.on('ask-ended', (r) => {
    try {
      if (gate.state() !== 'asking') return      // a newer state already moved on: not ours to finish
      if (r && r.exited) { gate.mark('ended', { why: 'the ask window ended in an exit' }); return }
      if (!r || r.stopped) { gate.mark('paused', { why: 'the ask window ended with a stop standing' }); return }
      gate.mark('open', { why: 'the ask window closed with no brake (no human input)' })
    } catch { /* never break the host */ }
  })

  // Fires ONLY for the human's own Ctrl+Alt+R: the worker notifies 'resume' from Clear() alone,
  // and the plugin's turn-boundary `resume` op is silent by design (it must not wake the model).
  cu.on('resume', (e) => {
    // The HUMAN re-armed (the worker notifies `resume` from Clear() alone): the pause is over, the
    // cycle continues with the same id and the same owner — R is a resume, never a new cycle.
    //
    // ONLY A VALID CURRENT CYCLE MAY WAKE ANYONE (boundary bug, 2026-09-13). The return value of
    // `mark` used to be ignored, so a resume arriving after an exit still steered "继续" into an idle
    // agent while the gate correctly stayed `ended` — the flag said "over" and the agent was woken
    // anyway. A LEGITIMATE R after a pause is untouched: that is the one case `mark('open')` accepts.
    if (!gate.mark('open', { why: 'human re-armed (Ctrl+Alt+R)' })) {
      log.info('resume ignored: the cycle is ended (Ctrl+Alt+Q stands) — nobody is woken')
      return
    }
    brakeWhy = ''      // the brake is off, so there is no reason left to hand to a refused call
    const version = gate.exitVersion()
    notice(
      '继续 — the human re-armed computer use with Ctrl+Alt+R: the brake is cleared and the red border ' +
      'is gone. Actuation works again. Resume from the break point in your own last wrap-up: do not ' +
      'restart the task from scratch, and do not re-do what was already verified.',
      'computer-use resumed', {
        wake: true,
        // Re-checked at the last boundary: a Q during message construction makes this wake stale, and
        // a stale wake must never start a new turn on a session the human just ended.
        valid: () => gate.state() === 'open' && gate.exitVersion() === version && !cu.exited,
      })
  })
  // Ctrl+Alt+Q = **EXIT** (彻底退出). The cycle is over: deliver the worker's own record AND cut the
  // turn off immediately — a notice alone is not enough, because the model would simply keep working
  // (observed 2026-09-13: it read the stop notice and went on to run a diagnostic command).
  cu.on('exit', async (e) => {
    // TERMINAL FOR THIS CYCLE ID (design: "Q终结当期周期"). Nothing — not R, not a mouse event, not a
    // late callback, not a queued call in this same turn — may move this id back to a live state; a
    // new cycle needs a new turn's first real call and gets a new id (lib/cycle.js).
    gate.mark('ended', { why: (e && e.why) || 'exit event' })
    cu.calm().catch(() => {})
    selfAbortUntil = Date.now() + 8000
    // CAPTURE THE RECIPIENT BEFORE THE FIRST `await` (integration bug, 2026-09-13). The notice below
    // awaits message construction and delivery, and anything that rebinds `bus.agent` during that
    // window would move the turn cancel to a DIFFERENT session than the one whose cycle just ended —
    // the owner would keep working while a bystander got cancelled. The owner is read once, here.
    const recipient = bus.agent
    // `e.why` is a MEASUREMENT the worker recorded when its detector fired, not a verdict about the
    // human — e.g. "Ctrl+Alt+Q chord detected at 2026-09-13 01:17:44 (source=hook) [vk=0x51 extra=0x0
    // trackedCtrl=1 trackedAlt=1 asyncCtrl=1 asyncAlt=1 fgPid=… fg=MarkPilot]". It is quoted
    // VERBATIM, because it is the only evidence anyone has.
    //
    // The text this replaced hard-coded an accusation — it named the human as the author of the key
    // press — and an agent duly repeated it back to them ("you pressed Ctrl+Alt+Q") for a chord the
    // record showed had been detected minutes earlier, in a session that had already ended, possibly
    // by nobody's hand at all. The worker's own refusal message carries the same correction.
    const record = (e && e.why) || 'the worker sent no record with this event'
    await notice(
      `computer-use exited — the worker's record, quoted verbatim: ${record}\n` +
      'computer use is over for this session: do not continue the task, do not start anything new.\n' +
      'THAT IS A RECORD, NOT AN ACCUSATION. It is a line the worker\'s own detector wrote at the ' +
      'moment it fired: it may carry the timestamp it measured, the witness that saw it (source=…) and ' +
      'the raw fields it read — a record written by an older build may carry only the sentence, which ' +
      'is less evidence still. Either way it does NOT prove the human pressed anything: the detector ' +
      'cannot see whose keys those were, and its timestamp may be long before this turn began. Do NOT ' +
      'tell the human that they pressed Ctrl+Alt+Q. Report it as measured: quote the line, with its ' +
      'time and its witness if it has them, and say plainly that it is history rather than something ' +
      'that just happened.',
      'computer-use exited', { agent: recipient })
    const agent = recipient
    if (agent && typeof agent.cancel === 'function') {
      // keepInbox: the notice above must survive the abort so it is still there next time.
      setTimeout(() => {
        try {
          agent.cancel({ kind: 'hook', reason: 'computer-use exit (Ctrl+Alt+Q)' }, { keepInbox: true })
          // NOT "the human exited": that is the same unmeasured claim the notice above was just
          // corrected for. The worker recorded a chord; who pressed it is not in evidence.
          log.warn('computer-use exit record received — turn cancelled')
        } catch (err) { log.warn(`cancel failed: ${err.message}`) }
      }, 120)
    }
    // NOTHING is resumed here — on purpose. An earlier version called cu.resume() 900 ms after the
    // exit "so the red border is gone", and that single call WAS the bug: resume is the only thing
    // that un-latches EXITED, so the plugin itself resurrected the cycle it had just killed, and
    // the next stray op lit the border again. The exit already leaves no brake behind (worker
    // Panic.Exit clears _engaged/_stopped and every visual flag, and kills the overlay); if that
    // ever stops being true the honest fix is inside Panic.Exit, not a resurrection here.
    // Human's model, 2026-09-13: "Computer use 周期结束之后，所有跟 computer use 相关的监听，全部
    // 都要终结" — and the next cycle is opened by the PLUGIN when a computer_* call actually reaches
    // the worker (ensureCycle above, once per turn), never by this handler and never by a stray op.
  })

  // Precise "the agent stopped driving" signal: a turn ended, so cut the border NOW (no fade).
  //
  // IDENTITY (2026-09-13, B from the review): this event is host-wide and carries `agent`; a
  // background subagent — or any other session — going idle used to call calm() on the MACHINE's
  // cycle, which is `CycleLit=false; Disarm(); Glow.Kill()` in the worker: the border went dark and
  // the ESC/Q/R keyboard hooks stayed but the monitors dropped, for a turn that had nothing to do
  // with this machine. Only the OWNER's idle may cut the owner's light.
  //
  // PAUSE/ASK (F1): an idle while the machine is PAUSED or ASKING is not "the task finished" — the
  // cycle is alive and its red border must stay until the human answers or re-arms. calm() would end
  // it (CycleLit=false), which is exactly the state lie we are fixing.
  ctx.on('agent/status', (payload) => {
    try {
      const st = payload && (payload.status || payload.state)
      if (st !== 'idle' || inFlight !== 0) return
      const whoKey = agentKeyOf(payload && payload.agent)
      // Another agent's idle is not our business. When we cannot identify the agent, stay silent
      // rather than guess: an unlit border on someone else's turn is the bug we are fixing.
      if (!whoKey || !gate.ownsAgent(whoKey)) {
        log.info(`agent/status idle ignored (${whoKey ? 'another agent' : 'no agent identity on the event'})`)
        return
      }
      const paused = pausedOrAsking()
      if (paused) {
        log.info(`agent/status idle while ${gate.state()} — the cycle stays alive (Ctrl+Alt+R resumes it)`)
        return
      }
      gate.mark('ended', { why: 'owner agent idle', session: gate.ownerSessionKey(), agent: payload && payload.agent })
      cu.calm().catch(() => {})
    } catch { /* the indicator must never break the host */ }
  })

  // Ownership is released by FACTS, never by elapsed time. A disposed owner agent is such a fact:
  // without it a session that died mid-turn would own the machine until the host restarted, and no
  // timer may take a PAUSED cycle away (the human's rule: "暂停只能由人的恢复/终结解除，时间不是授权").
  ctx.on('agent/disposed', (payload) => {
    try {
      const whoKey = agentKeyOf(payload && payload.agent)
      if (whoKey && gate.ownsAgent(whoKey)) {
        log.info(`owner agent disposed (${whoKey}) — releasing the machine for the next real call`)
        gate.release('owner agent disposed')
      }
    } catch { /* never break the host */ }
  })

  // Host cancellation stops the owning turn's input immediately. It is separate from
  // Ctrl+Esc, which is the physical keyboard path to a persistent manual pause.
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type === 'approval/asked') {
        recoveryEpoch++
        if (event.data?.id) pendingApprovals.add(event.data.id)
        else unknownApproval = true
      } else if (event?.type === 'approval/decided' && event.data?.id) pendingApprovals.delete(event.data.id)
      if (!event || !bus.agent) return
      const reason = event.data && event.data.reason
      const kind = reason && reason.kind
      // WHOSE turn? This event is host-wide, and a background subagent starting a turn is not this
      // session deciding to drive this machine.
      // THE ONE PLACE A DEAD CYCLE MAY COME BACK. Human's model (2026-09-13): "Computer use 周期
      // 结束之后，必须得在下一个 session 开启之后才可能会再拉起新周期." So the PLUGIN opens it,
      // once per turn — never an op, because an op carries no idea which turn it belongs to, which
      // is precisely how a stray call from a finished turn used to resurrect the border.
      if (event.type === 'turn/start') {
        // RENEWAL IS PER SESSION (B). This event is host-wide; bumping a machine-wide latch here is
        // what let another session's turn re-open a cycle that had already been ended. Bumping THIS
        // session's generation is all a turn boundary is allowed to do — and it is what gives a
        // brand-new session its qualification, since it never has to match a remembered driver.
        if (session) gate.noteTurnStart(session)
        // A NEW TURN CLEARS THE TASK SITUATION. Per turn, never accumulated: the recommendation the timer
        // may execute is about THIS turn's work, so the flag, the sequence and the owner all start empty.
        // `lastTurnDrove` CARRIES THE PREVIOUS TURN FORWARD ON PURPOSE (the observation-only case), and the
        // stagnation signature (`lastDrive`) is history, not per-turn state — resetting either here would
        // silently disable both guards.
        lastTurnDrove = turnSituation.action
        turnSituation.action = false
        turnSituation.reason = '(no actuation reached the worker this turn)'
        turnSituation.owner = sessionKey(session)
        turnSituation.seq = []
        declaredRecommendation = undefined
        const owner = gate.ownerSessionKey()
        if (!owner || !session || sameSession(session, owner)) nudgedTurn = false
        // NOTHING IS OPENED HERE (A/B). The opener is the first real call of the turn — the only
        // place the qualification is consumed, and the only place that may touch the exit record.
        // A `resume` sent from a turn boundary is a resurrection path with no call to justify it,
        // which is exactly how the border came back on a session that had ended.
        return
      }
      if (event.type !== 'turn/end') return
      // WHOSE turn? This event is host-wide. An aborted turn in another session — a background
      // subagent the human stopped, another chat — is not "the human grabbing this machine", and
      // braking for it produced a red border out of nowhere. The cycle's own owner is the strongest
      // identity we have; `bus.driverSession` is only the fallback for when nothing owns the machine.
      const ownerSk = gate.ownerSessionKey()
      const foreign = ownerSk
        ? (session && !sameSession(session, ownerSk))
        : (bus.driverSession && session && !sameSession(session, bus.driverSession))
      if (foreign) {
        log.info(`ignoring ${kind} turn/end from another session (${describeSession(session)})`)
        return
      }
      if (kind === 'aborted' || kind === 'interrupted') {
        if (selfAbortUntil && Date.now() < selfAbortUntil) {
          selfAbortUntil = 0
          log.warn(`turn ended ${kind} — caused by our own Ctrl+Alt+Q exit; NOT re-engaging the brake`)
          cu.calm().catch(() => {})
          return
        }
        // Host cancellation is per request/turn; only the physical Ctrl+Esc path
        // raises an input-triggered persistent brake.
        log.warn(`turn ended ${kind} in a computer-use session — cancelling only its input`)
        recoveryEpoch++; temporaryPause = null
        cu.cancelInputs?.()
        // An explicit Ctrl+Esc pause remains latched. Ordinary Host cancellation ends
        // this turn and its queued input without inventing a persistent human brake.
        if (!cu.stopped) {
          gate.mark('ended', { why: `owner turn ${kind}` })
          cu.calm().catch(() => {})
        }
        return
      }
      // ---- RULE B (2026-10-19): THE OWNER'S TURN ENDS ITS OWN CYCLE, CARD OR NO CARD ---------------
      // This runs BEFORE the card gate on purpose: the cycle must not depend on whether a card is raised,
      // whether the card is ever answered, or whether the attribution heuristic behind `touched` happens to
      // be right. It is bounded to the cycle THIS session owns, and it refuses while paused/asking, while a
      // human stop or brake latch is up, and while a tool call is still in flight (that case is deferred to
      // `onEnd` and re-validated there).
      requestOwnerCycleEnd(session, `owner turn ${kind || 'completed'} ended`)
      // ---- THE TURN ENDS; THE DECISION ABOUT THE CYCLE BELONGS TO THE CARD (2026-09-15) -----------
      // This branch used to CLOSE the cycle first (`gate.mark('ended')`) and only then raise the card.
      // `'ended'` is irreversible, so the FIRST turn end that reached here ended the cycle — and from
      // the second turn onward `gate.ownsSession(...)` was false, the whole block was skipped, and the
      // card could never fire again. Measured: one card at 22:30, then nothing for five turns while
      // the log filled with `agent/status idle ignored (another agent)`. The human's report was exactly
      // that: "我还是没亲眼看到触发".
      //
      // The human chose 甲: a completed turn NO LONGER closes the cycle on its own. The card decides,
      // and "关闭周期" is one of its branches — which is also what they asked for in words ("你决定之后
      // 再说，关闭整个周期，还是继续"). The old worry that motivated auto-closing ("不能让正常完成一律保留成
      // 永远活着") is now handled by the card: an explicit branch, or the timeout default, ends it.
      // A pause/ask still keeps the cycle alive for Ctrl+Alt+R, unchanged.
      // ---- A TURN THAT NEVER TOUCHED THE MACHINE IS NOT A COMPUTER-USE SUSPENSION (defect, 2026-09-16) --
      // THE DEATH LOOP THIS CLOSES, in the human's own words: "你卡进死循环了 不断弹卡片". Measured in
      // `turn-end-diag.log`: eleven cards in two and a half minutes (02:38:03 → 02:40:40), every one of them
      // `kind=error`, and the session transcript says why —
      //   turn 146…156  reason={"kind":"error","error":{"message":"Insufficient Balance","code":"QUOTA"}}
      // The account was out of credit, so EVERY turn died at step 1. Each death ended a turn, the turn-end
      // gate asked for a decision about a MACHINE THAT HAD NOT BEEN TOUCHED, the human answered, and their
      // answer started another turn that died the same way. The card was not wrong about the machine; it was
      // answering a question nobody had asked, about a machine that was idle, forever.
      // The honest predicate is already on hand: `turnSituation.seq` is the turn's own dispatch signature
      // (every `computer_*` call the turn actually dispatched — see `hooks.onDispatch`). Empty means this
      // turn never reached the machine, so there is no cycle decision to make and the card must not fire. A
      // billing error, a provider outage or a chat-only turn is reported by the host's own "本轮运行失败";
      // dressing it as a machine decision is what produced the loop.
      // It also keeps the human's standing rule intact: "一旦挂起，任何挂起，都必须进入卡片" — a suspension
      // OF THE MACHINE still always gets its card, and now a turn that suspended nothing no longer fakes one.
      //
      // THE RESIDUAL RISK, STATED RATHER THAN HIDDEN: `turnSituation` is ONE slot and `turn/start` is a
      // host-wide event, so if another session (a background subagent, another chat) starts a turn between
      // this turn's last dispatch and its end, that start resets `seq` and this gate then suppresses a card
      // the owner had earned. The failure direction is the safe one — no card, the cycle stays open, and the
      // machine was never touched by anyone in the meantime — and `recommendContinueNow` has depended on the
      // same single slot since it was written. Making it exact means keying the situation BY SESSION, which
      // is a change to the recommendation's own input and is not something to smuggle in behind a bug fix.
      // ---- ATTRIBUTION (2026-10-19): WHY `seq=9` USED TO READ AS `touched=false` ----------------
      //
      // `turnSituation` is ONE slot. `turn/start` is a HOST-WIDE event, so another session (a
      // background subagent, a second chat) starting a turn rewrites `turnSituation.owner` to ITSELF
      // and clears `seq`. But `hooks.onDispatch` appends to `turnSituation.seq` with NO owner check,
      // because a dispatch carries no session to compare against. The two facts therefore drift:
      //
      //   1. session A's turn starts       -> owner=A, seq=[]
      //   2. another session's turn starts -> owner=B, seq=[]   (single slot clobbered)
      //   3. session A dispatches 9 calls  -> seq=9              (appended; owner stays B)
      //   4. session A's turn ends         -> situationIsMine(A) is FALSE
      //
      // Measured exactly that in `turn-end-diag.log`:
      //   SKIPPED kind=completed state=open owns=true touched=false seq=9
      // The cycle was open and genuinely driven by the session whose turn had ended, yet the card was
      // suppressed; a suppressed card returns without touching the indicator, so the activity border
      // stayed lit with nothing left to switch it off. That is the reported bug.
      //
      // The fix corrects the OWNERSHIP SOURCE rather than loosening the rule: the cycle gate's
      // `ownsSession` is keyed by session and cannot be clobbered by a foreign turn start. The
      // recommendation path still uses `situationIsMine` unchanged, because it answers a different
      // question ("is this recorded situation the one I should judge?"), not "did this session drive".
      const touched = turnSituation.seq.length > 0 &&
        (situationIsMine(session) || gate.ownsSession(sessionKey(session)))
      if (gate.ownsSession(sessionKey(session)) &&
          gate.state() !== 'paused' && gate.state() !== 'asking' &&
          !cu.stopped && !brakeLatch() && touched) {
        diagTurnEnd(`FIRED kind=${kind || 'completed'} asker=${!!asker} raiseHuman=${!!raiseHuman} ` +
          `seq=${turnSituation.seq.length} session=${String(sessionKey(session)).slice(0, 12)}`)
        // ---- A COMPUTER-USE TURN MUST NOT END SILENTLY (2026-09-15, the human's standing rule) ----
        // "一旦挂起，任何挂起，都必须进入卡片… 如果60s没回复，超时之后自动进行分支判断". Until now a
        // turn end produced a taskbar toast and nothing else: the design's RAISE + CARD + 60 s branch
        // was never implemented on this path. The 60 s clock that DID exist lived in the worker's
        // `computer_ask` (`worker.cs:5430`) and was removed, correctly, by the ask merge — and the
        // plugin-side branch was never added back.
        //
        // WHY A DETOUR RATHER THAN A CANCELLABLE CARD: the harness has no way to withdraw a pending
        // card (checked during the merge — it ends by being answered, dismissed, or by the turn being
        // torndown). So the card is NOT cancelled. A local timer simply stops waiting on it, which is
        // the same thing the human asked for and needs no host API. The card may linger in the chat;
        // answering it later changes nothing, because the race below has already settled.
        //
        // AUTO-DECISION: on timeout the agent DOES NOT continue driving on its own. A turn that ended
        // by itself leaves the machine free and the human absent — starting a new turn unattended is
        // the one outcome that cannot be undone. The human's own words allow either branch ("是否必须
        // 终结还是按照你自己的理解继续"); stopping is the reversible one.
        void askAtTurnEnd(session, kind)
      } else {
        // THE ANSWER THAT ACTUALLY NEEDS A REASON. Without this line "the card did not fire" has no
        // explanation at all, which is exactly where this feature was stuck.
        diagTurnEnd(`SKIPPED kind=${kind || 'completed'} state=${gate.state()} ` +
          `owns=${gate.ownsSession(sessionKey(session))} stopped=${!!cu.stopped} latch=${!!brakeLatch()} ` +
          `touched=${touched} seq=${turnSituation.seq.length} ` +
          `session=${String(sessionKey(session)).slice(0, 12)}`)
        // ---- A CYCLE WITH NO DECISION SURFACE MUST NOT OUTLIVE ITS TURN (2026-10-19) -------------
        // Reaching here means NO card will be raised, so no human decision is pending for this cycle.
        // Before this, the border was left to the owner-idle edge, and when that edge had already
        // passed the cycle stayed `open` forever — the measured 2.5-day lit border.
        endOrphanedCycle(session, 'the owner turn ended with no decision card')
      }
    } catch { /* never break the host */ }
  })

  /**
   * End a cycle that has NO decision card, so its activity border does not outlive its turn.
   *
   * WHY THIS EXISTS (2026-10-19): the border is cut by `cu.calm()`, and the only automatic closer was
   * the owner-idle edge. Whenever that edge had already passed — or the turn-end card was suppressed —
   * nothing ended the cycle, and the border stayed lit. Measured: `cycleLit=1` from 2026-10-16 13:58
   * until the report, through 2.5 days and several host restarts.
   *
   * IT IS DELIBERATELY NARROW. Every guard below is a reason NOT to cut:
   *   * the cycle must belong to THIS session — `ownsSession` is session-keyed, so a foreign turn can
   *     never close the owner's cycle, and a finished task can never clear the NEXT task's border;
   *   * the cycle must still be `open` — `ended`/`none` means something already decided;
   *   * no pause and no ask — those keep the red border on purpose until the human re-arms;
   *   * no human stop and no brake latch — the human's brake is never released by a timer or a plugin.
   * `gate.mark('ended')` returns false when the transition is not legal, so calling this repeatedly is
   * harmless; `cu.calm()` is only reached on the transition that actually happened.
   *
   * The user's standing design choice is preserved untouched: when a card IS raised, the human decides
   * and this function is never called on that path.
   */
  // ---- RULE B (2026-10-19): A COMPLETED TURN ALWAYS ENDS ITS CYCLE ------------------------------
  //
  // THE DESIGN CHANGE, IN THE HUMAN'S OWN TERMS: "正常任务结束后，Computer Use 边框必须自动熄灭，不再
  // 要求用户处理 turn-end 决策卡片才能结束周期". That replaces the 2026-09-15 decision (甲), under which
  // a completed turn never closed its own cycle and the card decided. The measured cost of 甲 was a border
  // that stayed lit while no card was ever raised — `cycleLit=1` from 2026-10-16 13:58 onward.
  //
  // WHAT THE CARD IS NOW: advisory. It no longer decides whether the cycle lives, because the cycle is
  // already ended by the time it can be answered. "关闭周期" becomes a no-op (`gate.mark('ended')` returns
  // false once ended), and "继续" starts a NEW turn whose first computer_* call opens a NEW cycle — which
  // is the only way to resume, and never a resurrection of the ended one.
  //
  // THE END IS ALWAYS SCOPED TO ONE CYCLE: `gate.ownsSession(sk)` is session-keyed and `gate.mark('ended')`
  // transitions a specific cycle id, so an ending can never touch another session's cycle or a later turn's
  // cycle. `mark` returns false when the transition is not legal, which is what makes repeated lifecycle
  // events (and repeated `cu.calm()`) idempotent.
  //
  // WHAT IS STILL PROTECTED (rule D): a paused/asking cycle keeps its red border for Ctrl+Alt+R; a human
  // stop or a brake latch is never released by the plugin; a cycle whose tool call is still in flight is
  // NOT ended here — the request is remembered and re-validated when `inFlight` returns to zero.

  /** A cycle end that has to wait for the last in-flight tool call to settle. */
  let pendingCycleEnd = null

  /** The facts the pure decision needs, read from the live objects at THIS moment. */
  function cycleEndFacts (sk, inFlightOverride) {
    return {
      cycleState: gate.state(),
      ownsSession: Boolean(sk) && gate.ownsSession(sk),
      pausedOrAsking: pausedOrAsking(),
      stopped: Boolean(cu.stopped),
      brakeLatched: Boolean(brakeLatch()),
      inFlight: inFlightOverride === undefined ? inFlight : inFlightOverride,
    }
  }

  /**
   * End the cycle owned by `sk`, and make sure the WORKER's light is actually cut.
   *
   * THE INVARIANT THIS ENCODES (2026-10-19): the JS gate's state and the worker's `CycleLit` are
   * DIFFERENT facts, and neither may gate the other.
   *
   *   verdict.end        -> the JS cycle is live and ours: transition it, then cut the light
   *   verdict.calmWorker -> the JS cycle is already `ended`/absent, but the light may still be on:
   *                         send `calm` anyway, because only the worker can turn off its own overlay
   *
   * The previous version returned early whenever the JS transition was unnecessary, which is precisely
   * how a `cycleLit=1` survived a `gate.state() === 'ended'` and kept the border burning.
   *
   * `calm` is safe to send in the residue case: it is idempotent in the worker, explicitly excluded from
   * the op that lights a cycle, and this path is only reachable when the plugin holds no live cycle —
   * `cycleState === 'open'` returns through the `end` branch above, so a new cycle is never calmed here.
   */
  function endCycleForSessionKey (sk, why) {
    try {
      const verdict = cycleEndVerdict(cycleEndFacts(sk, 0))
      // DIAGNOSTIC (2026-10-19, approved): the verdict's INPUTS are the only way to tell why a border
      // survived. `pausedOrAsking` in particular appears in no other log anywhere, and the three failed
      // fixes all stalled on not being able to distinguish it from `inFlight`. Written to the existing
      // turn-end diagnostic file — no new log system, and nothing here changes behaviour.
      diagTurnEnd(`CYCLE-END why=${why} state=${gate.state()} owns=${gate.ownsSession(sk)} ` +
        `inFlight=${inFlight} pausedOrAsking=${pausedOrAsking()} stopped=${!!cu.stopped} ` +
        `latch=${!!brakeLatch()} verdict=${verdict.reason} end=${verdict.end} calmWorker=${verdict.calmWorker}`)
      if (verdict.end === true) {
        // Idempotent: `mark` is false when the transition is not legal, and that must NOT stop the light
        // from being cut — the two facts are independent.
        gate.mark('ended', { why })
        log.info(`computer-use: cycle ended (${why}) — the activity border is cut`)
        cu.calm().catch(() => {})
        diagTurnEnd(`CYCLE-CALM path=end why=${why}`)
        return true
      }
      if (verdict.calmWorker === true) {
        // RESIDUE: JS says finished, the worker may still be lit. Cut the light; the JS state is left as
        // it is (there is no transition to make, and forcing one would lie about a cycle that is gone).
        log.info(`computer-use: worker light cleared after the cycle was already ${gate.state()} (${why}) — ` +
          'the JS state and the native light had drifted apart')
        cu.calm().catch(() => {})
        diagTurnEnd(`CYCLE-CALM path=residue why=${why}`)
        return true
      }
      log.info(`computer-use: cycle NOT ended at turn end (${verdict.reason})`)
      return false
    } catch { return false }
  }

  /**
   * Ask for the owner's cycle to end at this turn boundary.
   *
   * If a tool is still in flight the request is DEFERRED rather than dropped, and re-validated when the
   * last call settles. Dropping it was the old failure mode: the turn ended during a call, nothing ever
   * revisited it, and the border stayed lit.
   */
  function requestOwnerCycleEnd (session, why) {
    try {
      const sk = sessionKey(session)
      if (!sk) return false
      const verdict = cycleEndVerdict(cycleEndFacts(sk, inFlight))
      if (verdict.defer === true) {
        pendingCycleEnd = { sk, why }
        log.info(`computer-use: cycle end deferred until ${inFlight} in-flight call(s) settle (${why})`)
        return false
      }
      if (verdict.end !== true) {
        log.info(`computer-use: cycle NOT ended at turn end (${verdict.reason})`)
        return false
      }
      pendingCycleEnd = null
      return endCycleForSessionKey(sk, why)
    } catch { return false }
  }

  /** Kept for the two no-card branches: same rule, session resolved from the object. */
  function endOrphanedCycle (session, why) {
    try {
      return endCycleForSessionKey(sessionKey(session), why)
    } catch { return false }
  }

  /**
   * Raise the Desktop, show the decision card, and stop waiting after the timeout.
   *
   * Returns a promise that settles with `{answered, selected, custom, timedOut}` — never rejects.
   * The card is deliberately left in place on timeout; see the call site for why that is the design
   * and not an oversight.
   */

  async function askAtTurnEnd (session, kind) {
    try {
      if (!asker || typeof asker.ask !== 'function') return { answered: false, reason: 'no-asker' }
      // ---- RESOLVE, RECORD, GUARD, AND ONLY THEN RAISE (review re-audit B, 2026-09-15) -------------
      // The raise used to happen first, so a REFUSED card still restored and focused Desktop for a
      // question that would never exist — the exact opposite of this file's own rule ("only raise when
      // a human input is actually pending; never yank the human", see `enableHumanAttention`). Nothing
      // is lost by reordering: `rootAgentFor` is fully synchronous, so the card loses zero latency, and
      // the 60 s clock still starts only after the voucher exists (the old version armed a timer whose
      // promise nobody would ever await).
      const rp = rootAgentFor(session, bus.agent)
      // The recommendation is fixed HERE, once, before the card is built — the timer later executes what
      // the card said, never a fresh judgement made while nobody is watching.
      const recommend = recommendContinueNow(kind, session)
      // THE REASON IS CAPTURED HERE, WITH THE DECISION (review E4). `turnSituation` is MUTABLE and a
      // `turn/start` can land during the 60 s wait, so logging `turnSituation.reason` at fire time could
      // print "recommended because (no actuation reached the worker this turn)" — a sentence that
      // contradicts itself. The reason that justified THIS card is the one recorded with it.
      const recommendReason = recommendationReason(session)
      // AND THE STALL VERDICT IS ALSO FIXED HERE, WITH THE DECISION. It was computed inside
      // `recommendContinueNow`, and re-reading it 60 s later would compare against a `turnSituation` that a
      // `turn/start` may have already replaced — the same mutability trap as the reason above.
      const stalledAtDecision = stalledNow(session)
      diagTurnEnd(`CARD kind=${kind || 'completed'} rec=${recommend ? 'yes' : (config.turnEndTimeoutAction === 'recommended' ? 'no(situation/brake)' : 'setting=stop')} ` +
        `ask=${rp.ask ? 'yes' : 'NO'} via=${rp.reason} ` +
        `agentId=${rp.agent && rp.agent.id ? String(rp.agent.id).slice(0, 8) : '-'}`)
      // ---- NEVER ASK WITH AN AGENT THE REGISTRY DID NOT VOUCH FOR --------------------------------
      // `ask:false` means the resolver could NOT prove this agent is the live root of the session whose
      // turn just ended. Two ways that ends badly, both worse than no card:
      //   * a live root of ANOTHER session is accepted by `ask()` — the card would appear in a
      //     different chat, asking the human about a turn they are not looking at (review finding 2);
      //   * an agent-less request is dropped by the forwarder (`api-remotes/lib/index.js:117`), so the
      //     ask can only ever come back NO_PROVIDER — a guaranteed-useless round trip that already
      //     cost one debugging round (review finding 3).
      // The refusal is recorded in the turn-end diagnostic file BEFORE this return, so "the card did
      // not fire" still has a written reason. `computer_ask` is unaffected: it asks through the
      // worker's own path.
      //
      // THE INDICATOR IS NOT TOUCHED HERE, DELIBERATELY (review re-audit E2). A refusal marks nothing,
      // so the cycle survives to the owner-idle edge, which is what cuts the border. If that edge has
      // already passed, the indicator can linger until the next call or exit — the same outcome the
      // pre-fix NO_PROVIDER produced, so this is not a regression, and guessing a closer here would
      // mean a card-less turn silently ending a cycle the human may still want.
      if (!rp.ask || !rp.agent) {
        log.warn(`turn-end card: NOT raised — the registry did not vouch for a caller of this session (${rp.reason}); ` +
          'no card is better than a card in the wrong chat (the cycle is left to the owner-idle edge)')
        // SECOND NO-CARD PATH (2026-10-19). The comment above used to end at "no card is better than a
        // card in the wrong chat", which is right about the CARD and silent about the BORDER: with no
        // card, no human decision exists for this cycle, so nothing would ever cut it if the owner-idle
        // edge had already passed. Same narrow, idempotent closer as the SKIPPED branch.
        endOrphanedCycle(session, 'the turn-end card could not be raised')
        return { answered: false, reason: rp.reason || 'unverified-agent', timedOut: false }
      }
      if (rp.reason !== 'verified') log.warn(`turn-end card: the captured caller was not usable (${rp.reason}); naming ${String(rp.agent.id).slice(0, 8)} instead`)
      // RAISE, THEN ASK — and do not await the raise: `raiseFor` only has to start the reveal, while
      // the card must appear whatever the window operation does. The OUTCOME is recorded, though: "the
      // human never saw the card" was the one fact nothing wrote down, and it took a human report
      // ("没有把DSH激活放到我面前") to find it (defect, 2026-09-16).
      Promise.resolve(raiseHuman?.(`turn-end:${Date.now()}`, `computer-use turn ended (${kind || 'completed'})`))
        .then((shown) => diagTurnEnd(`RAISE shown=${shown !== false} kind=${kind || 'completed'}`))
        .catch(() => {})
      // ---- WHO RECEIVES THE HUMAN'S ANSWER (review finding 5, 2026-09-15) ------------------------
      // The card is scoped to `rp.agent`, so the answer must go back to the SAME agent. Steering
      // `bus.agent` — a different object whenever the resolver substituted one — would deliver the
      // human's decision to a replaced or already-dead agent, inside a `try` that swallows the throw,
      // i.e. the answer would vanish with no trace. Resolved once, used by every branch below.
      const recipient = rp.agent || bus.agent
      const ANSWER_TIMEOUT_MS = 60_000
      let timer = null
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ answered: false, timedOut: true, reason: 'timeout' }), ANSWER_TIMEOUT_MS)
      })
      const asked = asker.ask({
        // THE AGENT IS NOT OPTIONAL. See `rootAgentFor` for the measured NO_PROVIDER this fixes.
        agent: rp.agent,
        questions: [{
          id: 'computer_use_turn_end',
          header: 'computer-use 回合结束',
          // THE CARD SAYS IT STAYS. The human's rule: "只要我没有任何反应，卡片就应该一直挂着，除非有
          // 这个60秒超时之后你取消它，你决定之后再说" — and they must be TOLD they can still change
          // their mind later, or the late-correction path is invisible to the only person who can use it.
          // THE TURN'S OUTCOME IS ON THE CARD (review finding E3, 2026-09-15). An errored turn raises the
          // same card as a completed one, which is right — the human must still decide what happens to the
          // machine — but at 23:22 the crash produced "本轮运行失败" immediately followed by "这一回合结束了",
          // with nothing saying the two were the same event. `kind` is already known here; saying it costs
          // one line and removes the confusion at its source.
          // ---- THE CARD SAYS WHAT THE TIMER WILL DO, AND THE TWO CANNOT DISAGREE (2026-09-15) --------
          // The human's rule, in their words: "这个问题超时的情况下，如果你有推荐选项就走推荐，如果没有
          // 推荐选项就停。而不是所有情况都一定有推荐选项，因为有些问题你确实是没有办法替我执行选择."
          // So there are two honest texts and NO third one. The previous text claimed the timer always
          // "按停处理", which was both wrong about the timer (it made no decision) and absent from the
          // design; and it promised "不会自己开新回合" even in the mode where it will.
          question: (kind === 'error'
            ? '**这一回合是以错误结束的**（不是正常做完），要我怎么走？\n\n'
            : '这一回合结束了。要我怎么走？\n\n') +
            '· **卡片会一直挂着**，你多久后回来点都算数，而且**以你为准**（我会比对偏差并改成你的选择）。\n' +
            (recommend
              ? `· **60 秒内你不回复**，我走标着「推荐」的那一项：**${recommend}**。`
              : '· **60 秒内你不回复**，我**不做决定、也不动机器**——这一题我没有替你选的立场，等你给策略。'),
          options: [
            { label: '继续（按你自己的理解接着干）', description: '等同于你按 Ctrl+Alt+R：我会开一个新回合继续。' },
            { label: '停（等我给策略）', description: '我不动，周期留着，等你在聊天里写下下一步。' },
            { label: '关闭周期（这一轮到此为止）', description: '收掉周期和指示器；下次要用 computer-use 需要新回合重新开。' },
          ].map((o) => (o.label === recommend ? { ...o, description: `【推荐】${o.description}` } : o)),
        }],
      }).then((reply) => {
        const a = reply && Array.isArray(reply.answers) ? reply.answers[0] : null
        const selected = a && Array.isArray(a.selected) ? a.selected : []
        const custom = a && typeof a.custom === 'string' && a.custom.trim() !== '' ? a.custom.trim() : undefined
        // ---- WHAT THIS LINE DOES AND DOES NOT PROVE (corrected by review finding 11, 2026-09-15) ---
        // It proves the ANSWERER ACCEPTED AND SETTLED the request — i.e. a browser answerer took it and
        // the round trip completed — which is exactly what a NO_PROVIDER never reaches, so its
        // presence/absence still separates "reached a card" from "reached nobody".
        // It does NOT prove a card was RENDERED BEFORE the human touched anything: the client resolves
        // this waterfall only on the answer (`dsh-client-ui-user-questions/lib/client.js:113-119`,
        // `await pending.result`). An earlier version of this comment claimed otherwise; the claim was
        // wrong, and a wrong witness is worse than none.
        log.info(`turn-end decision card answered: selected=${JSON.stringify(selected)}` +
          `${custom ? ` custom=${JSON.stringify(custom.slice(0, 40))}` : ''}`)
        return { answered: true, selected, custom, timedOut: false }
      }).catch((e) => ({ answered: false, reason: (e && e.code) || 'error', timedOut: false }))
      const out = await Promise.race([asked, timedOut])
      if (timer) clearTimeout(timer)
      // ---- THE LATE HANDLER MUST BE ABOUT A LATE ANSWER (measured defect, 2026-09-15 23:40) ---------
      // `asked.then(...)` used to be attached INSIDE this branch but unconditionally, so `asked` settling
      // by the ordinary path ALSO ran it. Host log, the human's own click:
      //   23:40:12.584  answered: selected=["继续…"]          ← the real answer, on time
      //   23:40:12.585  turn-end card answered LATE …          ← same millisecond, the duplicate
      //   23:40:14.846  the human SELECTED 继续 …              ← and the ordinary branch, 2 s later
      // One click was handled TWICE. With the old bare-object steer both copies crashed; with the fixed
      // message shape the duplicate would silently steer the human's text a second time. The flag makes
      // the handler mean what its name and its log line say.
      const settledLate = !!out.timedOut
      if (out.timedOut) {
        // ---- THE TIMER BRANCHES (2026-09-15, restored from the human's own design words) -------------
        // "如果60s没回复，超时之后自动进行分支判断，是否必须终结还是按照你自己的理解继续", refined by them
        // later the same night: "如果你有推荐选项就走推荐，如果没有推荐选项就停。而不是所有情况都一定有推荐
        // 选项，因为有些问题你确实是没有办法替我执行选择."
        // So: a declared recommendation is EXECUTED; without one the timer makes NO decision and touches
        // nothing. Only the agent's next turn is ever at stake — never the cycle, never the brake.
        if (recommend) {
          // ---- THE GATE IS RE-CHECKED AT FIRE TIME, NOT ONLY WHEN THE CARD WAS BUILT (review A(ii)) --
          // `recommendContinueNow` ran 60 s ago. In between, a human ESC / presence panic sets `cu.stopped`
          // AND the STOP latch, and Ctrl+Alt+Q writes the EXITED record. Without this re-check the timer
          // would still steer 继续 and wake a turn whose every `computer_*` call the plugin's own gates
          // refuse — a billed turn that can only produce refusals, while the card had promised "我走标着
          // 「推荐」的那一项". The machine was never at risk (the timer touches no cycle and no brake), but
          // the promise would be false, and this file's rule is that a human act outranks a timer.
          if (cu.stopped || brakeLatch()) {
            log.warn('turn-end decision card timed out after 60 s, but the human braked during the wait — ' +
              'the recommendation is WITHDRAWN (a timer never outranks a brake); nothing steered')
          } else if (stalledAtDecision) {
            log.warn('turn-end decision card timed out after 60 s — the situation has not changed since the last ' +
              'automatic continuation (the same sequence of tools), so continuing is not progress; the timer ' +
              'makes no decision and the human decides')
          } else {
            // THE SIGNATURE IS RECORDED WHEN THE CONTINUATION ACTUALLY HAPPENS, not when the card is built:
            // a card that is never answered from must not spend the stall check on a turn that never ran.
            noteDrive()
            log.info(`turn-end decision card timed out after 60 s — executing the RECOMMENDED option ` +
              `(${JSON.stringify(recommend)}); recommended because ${recommendReason}`)
            if (recipient) {
              void buildUserMessage(RECOMMEND_CONTINUE, 'turn-end-timeout', 'the 60 s timer executed the card\'s recommended option')
                .then((m) => recipient.steer(m))
                .catch((e) => log.warn(`the recommended option could not be delivered: ${(e && e.message) || 'unknown'}`))
            }
          }
        } else {
          log.info(`turn-end decision card timed out after 60 s — NO recommendation ${recommendReason}, ` +
            'so the timer makes no decision and touches nothing: the machine stays with the human')
        }
        // ---- THE HUMAN MAY STILL ANSWER, AND THEIR ANSWER OUTRANKS THE TIMER (2026-09-15) ---------
        // Their standing rule: "卡片挂着也行，我要是后面回来有点击或回复，你直接立即以我的输入为最高
        // 优先，比对我不在期间的选择和最新输入是否有偏差". So the settled-by-timeout branch is NOT
        // final: the SAME promise is kept and awaited a second time, out of band. When it resolves we
        // compare what the timer chose against what they actually said, and report the deviation.
        //
        // WHY THIS CANNOT BE DONE AT THE CARD: the harness offers no way to withdraw a pending card,
        // so "the timer decided" and "the card is still answerable" are both true at once. Rather than
        // fight that, the late answer is treated as a CORRECTION — the truthful model of what it is.
        void asked.then((late) => {
          // Belt and braces: only a card that was still pending when the timer fired is "late".
          if (!settledLate) return
          if (!late || !late.answered) return
          const lateText = late.custom || (Array.isArray(late.selected) && late.selected[0]) || ''
          if (!lateText) return
          // THE TIMER'S OUTCOME IS "NO DECISION", NOT "CHOSE 停". Saying the timer "chose 停" would be
          // the same lie this branch was written to stop making: the timer decides only that the agent
          // will NOT continue unattended. The human's late word therefore never CONTRADICTS the timer —
          // it is the first decision anyone made, and it wins.
          const deviation = true
          log.warn(`turn-end card answered LATE (after the 60 s timer). The timer made NO decision ` +
            `(the agent simply did not continue unattended); the human now says: ${JSON.stringify(lateText)}. ` +
            (deviation
              ? 'ACTING ON THE HUMAN\'S INPUT — it takes precedence, and it is the only decision on record.'
              : 'No deviation.'))
          if (deviation && recipient) {
            // A REAL MESSAGE, NEVER A BARE OBJECT — see `buildUserMessage`. A raw `{text}` here crashes
            // the harness's own inbox listener (`message.source.kind`) and the human sees the round fail.
            void buildUserMessage(lateText, 'turn-end-late', 'the human answered the turn-end card late')
              .then((m) => recipient.steer(m))
              .catch((e) => log.warn(`late answer could not be delivered: ${(e && e.message) || 'unknown'}`))
          }
        }).catch(() => {})
        return out
      }
      // A STRATEGY IN THE HUMAN'S OWN WORDS OUTRANKS THE MENU, exactly as the design intends ("其中一个
      // 给出一个我的自由输入指令"): if they typed anything, that text is the instruction.
      //
      // DO NOT LOG A CHOICE NOBODY MADE (2026-09-15, caught by the human: "我啥都没按 笑死了 没有任何人工
      // 输入"). This branch used to fall through to `the human chose 停` for EVERY input-less ending —
      // a dismissed card, an aborted ask, an empty reply — so the log asserted a human decision that had
      // never happened, and the human read it back as evidence. That is the SAME defect this session
      // spent hours removing from the brake monitors ("a signal that cannot separate those two cases
      // must not drive a brake"), committed here in prose form. Each ending now names itself, and only
      // a REAL selection may be reported as a choice.
      if (!out.answered) {
        log.info(`turn-end card: NO ANSWER (${out.reason || 'unknown'}) — nothing steered, no choice was made`)
        return out
      }
      // A REAL ANSWER CLEARS THE STALL HISTORY: the similarity rule exists to stop the TIMER talking to
      // itself, never to overrule a human who is present and choosing.
      humanAnsweredSince = true
      const text = out.custom || (Array.isArray(out.selected) && out.selected[0]) || ''
      if (!text) {
        log.info('turn-end card: answered with an EMPTY selection (skipped or dismissed) — nothing steered, this is NOT a choice of 停')
      } else if (out.custom) {
        if (recipient) {
          void buildUserMessage(out.custom, 'turn-end-strategy', 'the human typed a strategy at the turn-end card')
            .then((m) => recipient.steer(m))
            .catch((e) => log.warn(`the human's strategy could not be delivered: ${(e && e.message) || 'unknown'}`))
        }
        log.info(`turn-end card: the human TYPED a strategy (${JSON.stringify(out.custom.slice(0, 60))}) — steered into a new turn`)
      } else if (/关闭周期/.test(text)) {
        // THE THIRD BRANCH the human asked for ("关闭整个周期，还是继续"). This is the ending that used
        // to happen automatically on every completed turn; now it is an explicit choice.
        if (gate.mark('ended', { why: 'the human chose to close the cycle at the turn-end card' })) {
          cu.calm().catch(() => {})
          log.info(`turn-end card: the human SELECTED 关闭周期 (${JSON.stringify(text.slice(0, 40))}) — cycle closed, indicator cut`)
        } else {
          log.info('turn-end card: 关闭周期 was selected but the cycle was already ended — nothing to do')
        }
      } else if (/继续/.test(text)) {
        // A REAL MESSAGE, NEVER A BARE OBJECT — this is the exact call the human's 继续 crashed on
        // (measured 23:22:23, `Cannot read properties of undefined (reading 'kind')`).
        if (recipient) {
          void buildUserMessage('继续', 'turn-end-card', 'the human chose 继续 at the turn-end card')
            .then((m) => recipient.steer(m))
            .catch((e) => log.warn(`继续 could not be delivered: ${(e && e.message) || 'unknown'}`))
        }
        log.info(`turn-end card: the human SELECTED 继续 (${JSON.stringify(text.slice(0, 40))}) — steered, a new turn will start`)
      } else if (/停/.test(text)) {
        log.info(`turn-end card: the human SELECTED 停 (${JSON.stringify(text.slice(0, 40))}) — nothing steered, the cycle is left open for you`)
      } else {
        log.info(`turn-end card: an unrecognised selection ${JSON.stringify(text.slice(0, 40))} — nothing steered`)
      }
      return out
    } catch { return { answered: false, reason: 'error' } }
  }

  // approval gate — every computer_* tool call passes through the policy
  // pure function; its {kind: allow|deny|ask} rides the tools/pre-execute
  // waterfall into the harness approval UI (fail-closed, one-shot grants).
  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      // BOTH SURFACES MUST REACH THE POLICY GATE (real-DSH defect, 2026-10-16). `policy.js` was taught
      // about `browser_*` and the approval hook was taught about `browser_*`, but THIS guard still
      // returned early for anything not starting with `computer_`. The effect was measured on the real
      // instance: `browser_click` executed WITHOUT an approval card, and because no approval was asked,
      // `approvalHold` was never armed either. A gate that only recognises half the surface it governs
      // is the same as no gate for the other half.
      if (!exec || typeof exec.name !== 'string' ||
          (!exec.name.startsWith('computer_') && !exec.name.startsWith('browser_'))) return next()
      if (exec.name === ACTIVATION_TOOL) return next() // capability discovery does not open a control cycle
      // NOT `bus.agent = exec.agent` (integration bug, 2026-09-13): this hook runs for EVERY
      // computer_* call, including one the cycle gate will refuse as foreign, so rebinding the
      // machine's notice/cancel recipient here handed a foreign caller the exit notice and the
      // Ctrl+Alt+Q cancel. The owner's mailbox is bound in ensureCycle, at the moment ownership is
      // taken. Before any cycle exists, a call still needs somewhere for machine events to go, so
      // this binds only when the machine is unowned.
      if (exec.agent && !gate.isLive()) bus.agent = exec.agent
      // ---- READ THE PROCEDURE FIRST -----------------------------------------------------------
      // The human's question, 2026-09-13: "为什么不先读 computer use skill, 直接上来就用". No tool
      // layer can force a model to read a document — but the plugin CAN say it at the one moment
      // that still changes the outcome: the first computer_* call of a turn. Once per turn (reset on
      // turn/start), steered into the live turn, and it names the three traps that actually cost
      // real time here instead of just pointing at a file.
      if (!nudgedTurn) {
        nudgedTurn = true
        notice(
          'READ THE PROCEDURE BEFORE DRIVING — the `computer-use` skill (skills/computer-use/SKILL.md) ' +
          'is the manual for these tools, and it is written against exactly the mistakes that cost real ' +
          'time here: read `computer_state {windows:true}` BEFORE concluding a window is "blocked" ' +
          '(a MINIMIZED window needs `restore`, not `activate`); measure coordinates with ' +
          '`computer_uia {role, name}` instead of estimating them from a scaled screenshot; and never ' +
          'tell the human a blocker you have not measured. Its opening moves are mandatory and come ' +
          'before any pixel.',
          'computer-use: read the skill first', { agent: exec.agent }).catch(() => {})
      }
      // ... and WHICH session is driving, because `session/event` is host-wide: without this the
      // "an interrupted turn is a brake" rule fired for ANY session's aborted turn. It did exactly
      // that — stopping a background SUBAGENT braked the computer-use session (STOP file 21:56:44.660).
      //
      // ONLY THE OWNER (or an unowned machine) may be recorded here (integration bug, 2026-09-13): a
      // call the gate is about to refuse as foreign must not become the session the host-wide turn
      // events are judged against, or a foreign caller would silence the owner's own brake handling.
      const drv = exec.session || exec.sessionId ||
        (exec.agent && (exec.agent.session || exec.agent.sessionId)) || null
      const ownerSk = gate.ownerSessionKey()
      const mayBind = !ownerSk || !drv || sameSession(drv, ownerSk)
      if (mayBind && drv && !sameSession(drv, bus.driverSession)) {
        bus.driverSession = drv
        log.info(`computer-use driver session: ${describeSession(drv)}`)
      }
      // ---- THE READ-THE-PROCEDURE GATE --------------------------------------------------------
      // Human's rule, 2026-09-13: "未先读 skill 时拒绝驱动类 op". A DRIVING call is refused until
      // THIS session has produced the receipt phrase that exists only inside the computer-use skill
      // (skill-gate.js explains why a phrase is the honest maximum). Two things are deliberately
      // NEVER gated, because a gate that can block them is worse than no gate at all: the safety
      // direction (computer_ask, computer_ctrl stop/exit), and OBSERVATION — an agent that cannot
      // look cannot even report why it is blocked.
      const gArgs = exec.arguments || {}
      const gAct = exec.name === 'computer_ctrl' ? String(gArgs.action || 'selftest') : ''
      if (exec.name === 'computer_ctrl' && gAct === 'acknowledge') {
        if (!acknowledge(gArgs.text, sessionKey(drv))) {
          return { kind: 'deny', reason: `acknowledge failed — pass the EXACT phrase, quoted from the skill. ${ACK_HINT}` }
        }
        log.info('computer-use: procedure acknowledged — driving open for this session')
        notice('✅ 已确认读过 computer-use skill 规程：本 session 的驱动类调用已解锁。', 'computer-use: acknowledged', { agent: exec.agent }).catch(() => {})
        return { kind: 'allow' }
      }
      if (!isAcked(sessionKey(drv)) && isDrivingCall(exec.name, gArgs)) {
        return { kind: 'deny', reason: `READ THE PROCEDURE FIRST. ${ACK_HINT}` }
      }
      const decision = policyDecision(exec.name, exec.arguments || {}, config.automationMode)
      if (decision.kind !== 'allow' && decision.reason) {
        log.info(`policy ${decision.kind}: ${exec.name} — ${decision.reason}`)
      }
      // RETURN the decision — do not hand it to next(). On this DSH build `next` is
      // `() => Promise<PreToolDecision>`: it takes NO arguments, so `next(decision)` silently
      // discarded the decision and the waterfall fell back to its {kind:'allow'} default. Every
      // policy decision — including the fail-closed deny for an unknown tool — was inert on the real
      // machine, while the hook itself ran (its side effects were visible, its verdict was not).
      // Found 2026-09-13 by A/B: a call that policy.js denies reached its HANDLER instead.
      return decision
    } catch (e) {
      // fail closed
      return { kind: 'deny', reason: `computer-use policy error: ${e.message}` }
    }
  })

  ctx.effect(() => {
    const disposer = () => { cu.kill().catch(() => {}) }
    return disposer
  })

  // -----------------------------------------------------------------------------------------
  // BROWSER AUTOMATION.
  //
  // A SINGLE session per process, created here and shared by every browser_* tool. It launches its own
  // browser with a DEDICATED profile when nothing is listening, and never adopts the user's live
  // browsing profile — Chromium refuses to expose the debugging port on a profile already in use, so
  // silently taking one over is not possible and this layer says so instead of failing obscurely.
  //
  // The tools are additive: they join the same `definitions` list, pass the same policy gate, and use
  // the same shared action registry, so a browser action and a desktop action are governed alike.
  // -----------------------------------------------------------------------------------------
  const browserPort = Number(config.browserPort) || 9222
  const browserSession = new BrowserSession({
    port: browserPort,
    // `mkDataDir` returns `{ root, shots }`, NOT a string — every other consumer in this file reads
    // `.root` or `.shots` (see `snapshotPath` / `appendAudit`). Passing the object itself made `join`
    // throw ERR_INVALID_ARG_TYPE, which cordis swallowed, taking the whole plugin down with it.
    profileDir: config.browserProfileDir || join(dataDir.root, 'browser-profile'),
    executable: config.browserExecutable || null,
    headless: config.browserHeadless === true,
    autoLaunch: config.browserAutoLaunch !== false,
    log: (m) => log.info(m),
  })
  ctx.effect(() => {
    return () => { try { browserSession.dispose() } catch { /* already gone */ } }
  })

  // -----------------------------------------------------------------------------------------
  // APPROVAL ⇄ HUMAN-HANDOFF COORDINATION.
  //
  // THE DEADLOCK THIS FIXES, reproduced on the real machine: `automationMode=standard` requires an
  // approval card for every actuation; clicking "approve once" is physical input; the worker classified
  // that input as a takeover and refused the very operation it was approving. On a single-mouse
  // desktop `standard` mode could never complete a mouse action.
  //
  // The fix is a STATE, not a suppression: while the host is asking, the worker defers takeover
  // classification (`worker.cs Panic.BeginApprovalHold`) because the card belongs to Harness chrome
  // and not to the application being driven. The moment the request settles the hold is released, the
  // handoff is re-baselined, and only then does the action proceed — and it may proceed only after the
  // target has been re-proved from CURRENT state (`cu.actuate` step ①).
  //
  // What is NOT disabled: physical input is still detected, the low-level hooks still run,
  // Ctrl+Esc / Ctrl+Alt+Q / Ctrl+Alt+R still work, and a genuine takeover during EXECUTING still
  // interrupts (the grace is `!dispatched` only). Nothing here can release a brake.
  //
  // IDENTITY CORRELATION: the id recorded in the native APPROVAL-HOLD line comes from the SHARED
  // registry, so an approval record and its action record carry the SAME id and can be joined. An
  // earlier revision used the host's `callId`, which the registry knows nothing about.
  // -----------------------------------------------------------------------------------------
  let approvalHoldArming = null
  // BOTH SURFACES ARE COVERED, and they must be. `browser_*` asks for approval through the same host
  // waterfall, so a browser approval card that left the machine un-held would reintroduce the exact
  // deadlock this hook exists to fix: clicking "approve once" on a browser action would be classified
  // as a desktop takeover and abort the very action it was approving.
  const approvalIsOurs = (req) => typeof req?.toolName === 'string' &&
    (req.toolName.startsWith('computer_') || req.toolName.startsWith('browser_'))
  // WHAT THIS ID IS, NOW THAT THE LINK EXISTS (D4, resolved 2026-10-16).
  //
  // The label handed to the native APPROVAL-HOLD line is the HOST CALL ID, and it stays that way on
  // purpose. A probe proved why it cannot be a registry id: when this function runs, the registry is
  // still EMPTY (`registrySize: 0`, `pendingPresent: false`) — the record is minted later, inside the
  // tool body. So this is the only moment at which the call id is knowable, and it is registered here
  // (`noteHostCallId`) so the record can carry it once it exists. The audit line and the record are
  // therefore joinable through `callId ↔ hostCallId`, and the record's own id is reported in the D4
  // correlation line below. Nothing about approval timing or registry lifetime changes.
  const approvalActionId = (req) => {
    const tracked = actionRegistry.pendingAction
    if (tracked && tracked.id) return String(tracked.id)
    const call = req && req.callId ? String(req.callId) : ''
    const tool = (req && req.toolName) || 'computer_*'
    if (call) noteHostCallId(tool, call)
    return call ? `${tool}#${call}` : `${tool}#no-call-id`
  }
  const armApprovalHold = (label, actionId) => {
    approvalHoldArming = cu.beginApprovalHold(label, actionId)
    // Never let the arming reject escape into the approval waterfall: the card must appear even if the
    // native side could not be told about it.
    approvalHoldArming.catch(() => {})
    return approvalHoldArming
  }
  ctx.on('approval/request', async (req, next) => {
    // `started` marks the outermost pending request so a nested/interleaved ask keeps the machine held
    // until the LAST one settles; `cu.approvalsPending` is the authoritative depth.
    let started = false
    let actionId = null
    if (approvalIsOurs(req)) {
      started = cu.approvalsPending === 0
      actionId = approvalActionId(req)
      armApprovalHold(req.toolName, actionId)
      log.info(`computer-use: approval pending for ${actionId} — takeover classification deferred`)
    }
    let outcome
    try {
      outcome = await next()
      return outcome
    } finally {
      if (approvalIsOurs(req)) {
        // Wait for the arm before releasing, so a fast decision cannot overtake it.
        try { await approvalHoldArming } catch { /* reported by beginApprovalHold */ }
        const settled = await cu.endApprovalHold(actionId)
        log.info(`computer-use: approval ${outcome || 'settled'} for ${actionId}${started ? '' : ' (nested)'} — ` +
          `input ${settled && settled.settled ? 'quiet' : `NOT quiet (${(settled && settled.reason) || 'unknown'})`}`)
      }
    }
  })

  const definitions = []
  registerTools({ ctx, cu, config, dataDir, log, snapshotPath, defineTool, hooks, ensureCycle, actionRegistry, register: d => definitions.push(d) })
  // The cu_* surface is additive and never shadows a computer_* name; its driving member (cu_execute)
  // still passes through the same policy gate and the same approval waterfall because it delegates to
  // `cu.actuate` rather than implementing input itself.
  registerEnhancedTools({ cu, defineTool, register: d => definitions.push(d), actionRegistry, log })
  registerBrowserTools({ session: browserSession, defineTool, register: d => definitions.push(d), registry: actionRegistry, log })
  installToolExposure({ ctx, definitions, defineTool, scopeOf, log, enabled: config.progressiveTools !== false,
    skillPath: fileURLToPath(new URL('SKILL.md', SKILL_DIR_URL)),
    readSkill: () => fs.readFileSync(fileURLToPath(new URL('SKILL.md', SKILL_DIR_URL)), 'utf8') })
  log.info(`ready (mode=${config.automationMode}${config.dryRun ? ' dry-run' : ''}; cycle idle timeout disabled)`)
}
