#!/usr/bin/env node
// @dsh/computer-use-mcp — MCP stdio server (stage-0)
//
// Zero-dependency MCP server (JSON-RPC 2.0 over stdio, one message per line)
// exposing the computer-use core. Implements the subset of the 2026-07-28
// spec a tools-only server needs: initialize / notifications/initialized /
// ping / tools/list / tools/call. Screenshots come back as MCP image content
// blocks; errors use isError:true so the model can self-correct.
//
// Safety gates (DESIGN §8), in order:
//   DSH_CU_KILL=1            refuse to start (hard kill switch)
//   DSH_CU_ALLOW_INPUT=1     register mutation tools without approval window
//                            (use ONLY when the host already gates calls,
//                            e.g. the DSH plugin wires its own approval)
//   otherwise                mutation tools exist but every call requires a
//                            fresh cu_approve window (≤10 min), mirroring
//                            sandraschi's approve_automation pattern
//   DSH_CU_DRY_RUN=1         actuations are simulated and logged only

// resolve the core: the plugin ships it inlined at lib/core, one level up from this server.
async function loadCore () {
  const candidates = [
    '../../lib/core/index.js',
  ]
  let lastErr
  for (const c of candidates) {
    try { return await import(c) } catch (e) { lastErr = e }
  }
  throw new Error(`cannot locate the computer-use core (tried ${candidates.join(', ')}): ${lastErr && lastErr.message}`)
}
const { ComputerUse } = await loadCore()

const PROTOCOL_VERSION = '2025-06-18'
const SERVER_INFO = { name: 'dsh-computer-use', version: '0.1.0' }

if (process.env.DSH_CU_KILL === '1') {
  process.stderr.write('[dsh-computer-use] DSH_CU_KILL=1 — refusing to start\n')
  process.exit(1)
}

const allowInputDirect = process.env.DSH_CU_ALLOW_INPUT === '1'
const dryRun = process.env.DSH_CU_DRY_RUN === '1'
const cu = new ComputerUse({ dryRun })
let approvalUntil = 0

// ---------------- tool definitions ----------------
// Naming follows the Anthropic computer_toolset_20260801 members where one
// exists (screenshot/key/type/scroll/click...) plus Windows-specific and
// SoM extras. Screenshots are pre-scaled to ≤1280px by the core.
const MUTATION_NOTE = ' MUTATING: requires an active approval window (cu_approve) or DSH_CU_ALLOW_INPUT=1.'

const TOOLS = [
  {
    name: 'cu_screenshot',
    description: 'Capture the screen (or a region). Returns a JPEG/PNG image plus cursor position and capture region metadata. Coordinates everywhere are absolute screen pixels unless a mark id is used.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        x: { type: 'integer' }, y: { type: 'integer' },
        width: { type: 'integer' }, height: { type: 'integer' },
        format: { type: 'string', enum: ['jpeg', 'png'], description: 'png for text-precise scenes' },
        quality: { type: 'integer', minimum: 40, maximum: 95 },
        maxWidth: { type: 'integer', description: 'downscale width; default 1280' },
        cursor: { type: 'boolean', description: 'draw the mouse cursor into the shot' },
      },
    },
  },
  {
    name: 'cu_screen_state',
    description: 'Text-first screen state: active window, visible top-level windows, cursor, and a shallow UIA (accessibility) tree of the active window. Works without vision. Use this as your primary observation; screenshots verify.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        uiaDepth: { type: 'integer', minimum: 1, maximum: 24 },
        uiaMaxNodes: { type: 'integer', minimum: 10, maximum: 1200 },
      },
    },
  },
  {
    name: 'cu_marks',
    description: 'Set-of-Marks: labels clickable UI elements M1..Mn (from UIA) and returns an annotated screenshot + a mark table. Prefer clicking by mark id — it is immune to coordinate drift.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        maxMarks: { type: 'integer', minimum: 5, maximum: 120 },
        uiaDepth: { type: 'integer', minimum: 1, maximum: 12 },
      },
    },
  },
  {
    name: 'cu_windows',
    description: 'List visible top-level windows (title, class, process, rect, active, minimized).',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'cu_uia_query',
    description: 'Query the UIA accessibility tree of a window (or the whole desktop) for elements by role/name. Returns flat elements with screen rectangles — precise, vision-free grounding.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        hwnd: { type: 'integer' }, titleContains: { type: 'string' },
        depth: { type: 'integer', minimum: 1, maximum: 24 },
        maxNodes: { type: 'integer', minimum: 10, maximum: 1200 },
        role: { type: 'string', description: 'e.g. Button, Edit, Hyperlink, TabItem' },
        nameContains: { type: 'string' },
      },
    },
  },
  {
    name: 'cu_uia_at_point',
    description: 'What UI element is at screen point (x,y)? Returns the element plus ancestors — use to verify a click target before clicking.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['x', 'y'],
      properties: { x: { type: 'integer' }, y: { type: 'integer' } },
    },
  },
  {
    name: 'cu_cursor',
    description: 'Current mouse cursor position.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'cu_clipboard_read',
    description: 'Read the text clipboard.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'cu_wait',
    description: 'Wait until the UI goes idle (foreground window + focused element stable) or timeout.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        timeoutMs: { type: 'integer', maximum: 30000 },
        stableMs: { type: 'integer', maximum: 5000 },
      },
    },
  },
  // ---- mutation tools ----
  tool('cu_approve', 'Open a mutation approval window (human-in-the-loop gate). minutes ≤ 10.', {
    type: 'object', additionalProperties: false, required: ['minutes'],
    properties: { minutes: { type: 'integer', minimum: 1, maximum: 10 } },
  }, false),
  tool('cu_move', 'Move the mouse cursor.', {
    type: 'object', additionalProperties: false, required: ['x', 'y'],
    properties: { x: { type: 'integer' }, y: { type: 'integer' } },
  }),
  tool('cu_click', 'Click the mouse (left/right/middle; single/double/triple) at a mark or point.', {
    type: 'object', additionalProperties: false,
    properties: {
      mark: { type: 'string', description: 'mark id from cu_marks, e.g. "M7"' },
      x: { type: 'integer' }, y: { type: 'integer' },
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      clicks: { type: 'integer', minimum: 1, maximum: 3, description: '2=double 3=triple' },
    },
  }),
  tool('cu_drag', 'Drag from one mark/point to another with a humanized ease curve.', {
    type: 'object', additionalProperties: false,
    properties: {
      fromMark: { type: 'string' }, toMark: { type: 'string' },
      fromX: { type: 'integer' }, fromY: { type: 'integer' },
      toX: { type: 'integer' }, toY: { type: 'integer' },
      durationMs: { type: 'integer', maximum: 3000 },
    },
  }),
  tool('cu_scroll', 'Scroll (up/down/left/right) lines of wheel at a position.', {
    type: 'object', additionalProperties: false, required: ['direction'],
    properties: {
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      lines: { type: 'integer', minimum: 1, maximum: 30 },
      mark: { type: 'string' }, x: { type: 'integer' }, y: { type: 'integer' },
    },
  }),
  tool('cu_key', 'Press a key combo, e.g. "ctrl+shift+t", "enter", "alt+f4", "win".', {
    type: 'object', additionalProperties: false, required: ['combo'],
    properties: { combo: { type: 'string' }, holdMs: { type: 'integer', maximum: 5000 } },
  }),
  tool('cu_type', 'Type text. CJK/long text is auto-pasted via clipboard (IME-proof); ASCII short text uses SendInput unicode events. Refuses password fields unless allowPassword is set (ask the human first).', {
    type: 'object', additionalProperties: false, required: ['text'],
    properties: {
      text: { type: 'string' },
      mode: { type: 'string', enum: ['unicode', 'paste'] },
      allowPassword: { type: 'boolean' },
    },
  }),
  tool('cu_clipboard_write', 'Write text to the clipboard.', {
    type: 'object', additionalProperties: false, required: ['text'],
    properties: { text: { type: 'string' } },
  }),
  tool('cu_activate_window', 'Bring a window to the foreground (hwnd or title substring).', {
    type: 'object', additionalProperties: false,
    properties: { hwnd: { type: 'integer' }, titleContains: { type: 'string' } },
  }),
  tool('cu_window_op', 'minimize | maximize | restore | close a window.', {
    type: 'object', additionalProperties: false, required: ['op'],
    properties: {
      op: { type: 'string', enum: ['minimize', 'maximize', 'restore', 'close'] },
      hwnd: { type: 'integer' }, titleContains: { type: 'string' },
    },
  }),
  tool('cu_batch', 'Execute several computer actions in one call, serially, first failure stops (Anthropic batch semantics). Every action that did not run returns "Not executed: an earlier computer action in this turn failed." End a batch with a screenshot when you need to verify.',
    {
      type: 'object', additionalProperties: false, required: ['actions'],
      properties: {
        actions: {
          type: 'array', minItems: 1, maxItems: 20,
          items: {
            type: 'object', additionalProperties: false, required: ['tool'],
            properties: { tool: { type: 'string' }, args: { type: 'object' } },
          },
        },
      },
    }),
]

function tool (name, description, inputSchema, mutating = true) {
  return { name, description: description + (mutating && !allowInputDirect ? MUTATION_NOTE : ''), inputSchema, mutating }
}

// ---------------- dispatch ----------------
const HANDLERS = {
  cu_screenshot: (a) => cu.screenshot(a),
  cu_screen_state: (a) => cu.screenState(a),
  cu_marks: (a) => cu.marks(a),
  cu_windows: () => cu.call('windows', {}),
  cu_uia_query: async (a) => {
    const res = await cu.call('uia', a)
    if (a.role || a.nameContains) {
      const pred = (e) => (!a.role || e.role === a.role) && (!a.nameContains || (e.name || '').toLowerCase().includes(a.nameContains.toLowerCase()))
      res.flat = (res.flat || []).filter(pred).slice(0, 60)
    } else res.flat = (res.flat || []).slice(0, 60)
    return res
  },
  cu_uia_at_point: (a) => cu.call('uiaFromPoint', a),
  cu_cursor: () => cu.call('cursor', {}),
  cu_clipboard_read: () => cu.clipRead(),
  cu_wait: (a) => cu.waitForIdle(a),
  cu_approve: async (a) => {
    const mins = Math.min(10, Math.max(1, a.minutes || 1))
    approvalUntil = Date.now() + mins * 60_000
    return { approved: true, until: new Date(approvalUntil).toISOString() }
  },
  cu_move: (a) => cu.move(a.x, a.y),
  cu_click: (a) => cu.click(targetOf(a), a),
  cu_drag: async (a) => cu.drag(targetOf({ mark: a.fromMark, x: a.fromX, y: a.fromY }), targetOf({ mark: a.toMark, x: a.toX, y: a.toY }), { durationMs: a.durationMs }),
  cu_scroll: (a) => cu.scroll(a.direction, a.lines || 3, a.mark || (a.x !== undefined ? { x: a.x, y: a.y } : null)),
  cu_key: (a) => cu.key(a.combo, { holdMs: a.holdMs }),
  cu_type: (a) => cu.type(a.text, { mode: a.mode, allowPassword: a.allowPassword }),
  cu_clipboard_write: (a) => cu.clipWrite(a.text),
  cu_activate_window: (a) => cu.activateWindow(a),
  cu_window_op: (a) => cu.windowOp({ hwnd: a.hwnd, titleContains: a.titleContains }, a.op),
  cu_batch: async (a) => {
    const out = []
    let failed = false
    for (const step of a.actions) {
      if (failed) { out.push({ tool: step.tool, ok: false, error: 'Not executed: an earlier computer action in this turn failed.' }); continue }
      try { out.push({ tool: step.tool, ok: true, result: await runTool(step.tool, step.args || {}) }) }
      catch (e) { failed = true; out.push({ tool: step.tool, ok: false, error: String(e.message || e) }) }
    }
    return { actions: out }
  },
}

function targetOf (a) {
  if (a.mark) return { mark: a.mark }
  if (a.x !== undefined && a.y !== undefined) return { x: a.x, y: a.y }
  throw new Error('provide mark or x,y')
}

async function runTool (name, args) {
  const def = TOOLS.find(t => t.name === name)
  if (!def) throw new Error(`unknown tool: ${name}`)
  if (def.mutating && !allowInputDirect && name !== 'cu_approve' && Date.now() > approvalUntil) {
    throw new Error('no active approval window: call cu_approve {minutes} first (human consent gate)')
  }
  const res = await HANDLERS[name](args || {})
  // image-bearing results get an MCP image content block
  if (res && (res.image instanceof Buffer || res.annotated instanceof Buffer)) {
    return { value: res, image: res.annotated instanceof Buffer ? res.annotated : res.image }
  }
  return { value: res }
}

// ---------------- MCP plumbing ----------------
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (line) handleLine(line)
  }
})
process.stdin.on('end', () => process.exit(0))

function send (obj) { process.stdout.write(JSON.stringify(obj) + '\n') }

async function handleLine (line) {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined) return // notification (initialized, cancelled) — no reply
  try {
    switch (msg.method) {
      case 'initialize':
        send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO } })
        break
      case 'ping':
        send({ jsonrpc: '2.0', id: msg.id, result: {} })
        break
      case 'tools/list':
        send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } })
        break
      case 'tools/call': {
        const name = msg.params && msg.params.name
        const args = (msg.params && msg.params.arguments) || {}
        try {
          const { value, image } = await runTool(name, args)
          const content = [{ type: 'text', text: JSON.stringify(value, null, 1).slice(0, 60_000) }]
          if (image) content.push({ type: 'image', data: image.toString('base64'), mimeType: 'image/jpeg' })
          send({ jsonrpc: '2.0', id: msg.id, result: { content, isError: false } })
        } catch (e) {
          send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: String(e.message || e) }], isError: true } })
        }
        break
      }
      default:
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } })
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e.message || e) } })
  }
}

process.stderr.write(`[dsh-computer-use] mcp server up (allowInput=${allowInputDirect} dryRun=${dryRun})\n`)
