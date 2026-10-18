// ---------------------------------------------------------------------------------------------
// Minimal Chrome DevTools Protocol client (2026-10-16)
//
// WHY CDP AND NOT PLAYWRIGHT. The plugin declares ZERO npm dependencies on purpose ("the plugin must
// survive hostile npm environments"), ships no dependency tree, and cannot assume a package manager
// will be available at load time. Node 24 provides a built-in `WebSocket`, so CDP — which is only
// JSON over a WebSocket — can be implemented with no dependency at all. CDP also reaches a browser the
// USER already has open, which Playwright cannot do without adopting that browser's profile.
//
// WHAT THIS FILE IS: transport only. Endpoint discovery, target listing, one WebSocket per attached
// target, request/response correlation by id, and event fan-out. It knows nothing about pages, tools,
// approvals or the action registry — those live in the layers above.
//
// LIMITS, stated plainly: this is not a full protocol binding. It exposes `send` plus the handful of
// convenience calls the browser layer needs. A method the browser does not implement fails the same
// way any CDP error does — the promise rejects with the protocol's own message.
// ---------------------------------------------------------------------------------------------

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_PORT = 9222

/** Candidate browser binaries, most specific first. Edge ships with Windows; Chrome is optional. */
export function findBrowserExecutable () {
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = process.env.LOCALAPPDATA || ''
  const candidates = [
    join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean)
  for (const c of candidates) { try { if (existsSync(c)) return c } catch { /* keep looking */ } }
  return null
}

/** `http://127.0.0.1:<port>/json/version` — is a debuggable browser listening here? */
export async function probeEndpoint (port = DEFAULT_PORT, timeoutMs = 1500) {
  const url = `http://127.0.0.1:${port}/json/version`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const body = await res.json()
    return {
      port,
      browser: body.Browser || null,              // e.g. "Chrome/131.0.6778.86"
      protocolVersion: body['Protocol-Version'] || null,
      webSocketDebuggerUrl: body.webSocketDebuggerUrl || null,   // browser-level endpoint
    }
  } catch { return null }
}

/** All attachable page targets. Returns [] when the endpoint answers but has no pages. */
export async function listTargets (port = DEFAULT_PORT, timeoutMs = 2000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    const all = await res.json()
    return (Array.isArray(all) ? all : [])
      .filter(t => t && (t.type === 'page' || t.type === 'iframe' || t.type === 'webview'))
      .map(t => ({
        id: t.id,
        type: t.type,
        title: t.title || '',
        url: t.url || '',
        webSocketDebuggerUrl: t.webSocketDebuggerUrl || null,
        // A target that is not attached yet has no ws url; `null` is a fact worth surfacing rather
        // than quietly producing a target the caller cannot drive.
        attachable: Boolean(t.webSocketDebuggerUrl),
      }))
  } catch { return null }
}

/**
 * Launch a browser with the debugging port open, using a DEDICATED profile directory.
 *
 * A separate profile is deliberate and not incidental: Chrome/Edge refuse to enable the remote
 * debugging port on a profile that is already in use, so reusing the user's live profile would either
 * fail outright or hijack their session. The user's own browsing is never adopted silently.
 */
export function launchBrowser ({
  executable = findBrowserExecutable(),
  port = DEFAULT_PORT,
  profileDir,
  startUrl = 'about:blank',
  headless = false,
} = {}) {
  if (!executable) throw new Error('no Chromium-based browser found (Chrome or Edge)')
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter',
    ...(headless ? ['--headless=new'] : []),
    startUrl,
  ]
  const child = spawn(executable, args, { detached: false, stdio: 'ignore', windowsHide: false })
  return child
}

/** Poll until the endpoint answers or the deadline passes. Returns the version info or null. */
export async function waitForEndpoint (port = DEFAULT_PORT, timeoutMs = 15_000, pollMs = 300) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const info = await probeEndpoint(port, 1000)
    if (info) return info
    if (Date.now() >= deadline) return null
    await new Promise(r => setTimeout(r, pollMs))
  }
}

/**
 * One attached CDP target. Request/response are correlated by monotonic id; events are delivered to
 * subscribers. A socket that closes rejects everything still in flight — a browser that went away must
 * never leave a caller waiting on a promise that can no longer settle.
 */
export class CdpConnection {
  constructor (wsUrl, { log = () => {} } = {}) {
    this.wsUrl = wsUrl
    this.log = log
    this.ws = null
    this.nextId = 1
    this.pending = new Map()      // id -> { resolve, reject, timer, method }
    this.listeners = new Map()    // eventName -> Set<fn>
    this.closed = false
    this.closeReason = null
  }

  async connect (timeoutMs = 8_000) {
    if (this.ws) return this
    const ws = new WebSocket(this.wsUrl)
    this.ws = ws
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`CDP connect timeout to ${this.wsUrl}`)), timeoutMs)
      ws.addEventListener('open', () => { clearTimeout(t); resolve() }, { once: true })
      ws.addEventListener('error', (e) => { clearTimeout(t); reject(new Error(`CDP socket error: ${(e && e.message) || 'unknown'}`)) }, { once: true })
    })
    ws.addEventListener('message', (ev) => this.#onMessage(ev.data))
    ws.addEventListener('close', () => this.#onClose('socket closed'))
    ws.addEventListener('error', () => { /* a close event follows; handled there */ })
    return this
  }

  #onMessage (raw) {
    let msg
    try { msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)) } catch { return }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(Object.assign(new Error(`CDP ${p.method}: ${msg.error.message || 'error'}`), { cdpCode: msg.error.code }))
      else p.resolve(msg.result)
      return
    }
    if (msg.method) {
      const set = this.listeners.get(msg.method)
      if (set) for (const fn of [...set]) { try { fn(msg.params, msg.sessionId) } catch { /* a listener must not break the socket */ } }
      const any = this.listeners.get('*')
      if (any) for (const fn of [...any]) { try { fn(msg.method, msg.params) } catch { /* ditto */ } }
    }
  }

  #onClose (reason) {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      // `disconnected` is a distinct outcome from a protocol error: the caller must be able to tell
      // "the browser vanished mid-request" (result UNKNOWN) from "the browser refused this request".
      p.reject(Object.assign(new Error(`CDP connection lost during ${p.method}: ${reason}`), { disconnected: true }))
    }
    this.pending.clear()
    for (const fn of (this.listeners.get('__closed') || [])) { try { fn(reason) } catch { /* ignore */ } }
  }

  on (event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event).add(fn)
    return () => { const s = this.listeners.get(event); if (s) s.delete(fn) }
  }

  send (method, params = {}, timeoutMs = 15_000) {
    if (!this.ws || this.closed) return Promise.reject(Object.assign(new Error(`CDP not connected (${this.closeReason || 'never opened'})`), { disconnected: true }))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(Object.assign(new Error(`CDP ${method} timed out after ${timeoutMs}ms`), { timeout: true, method }))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      try { this.ws.send(JSON.stringify({ id, method, params })) } catch (e) {
        this.pending.delete(id); clearTimeout(timer)
        reject(Object.assign(new Error(`CDP send failed for ${method}: ${e.message}`), { disconnected: true }))
      }
    })
  }

  close () {
    try { if (this.ws) this.ws.close() } catch { /* already gone */ }
    this.#onClose('closed by caller')
  }
}
