// ---------------------------------------------------------------------------------------------
// Browser session management (2026-10-16)
//
// ONE session object owns the browser the plugin is allowed to drive: its endpoint, its attached page
// target, and the connection that target rides on. Everything above this file asks the session for a
// page; nothing above it opens a socket or picks a target.
//
// THE ASSUMPTION THIS FILE REFUSES TO MAKE: that a browser is still there. Every call re-checks the
// connection and re-resolves the target, and a caller that finds `session.connected === false` must
// re-observe rather than retry a cached handle. A browser that was closed, navigated, or swapped to a
// different tab produces exactly the stale handle that the Computer Use side had to be taught to
// refuse — the same refusal is applied here from the start.
//
// ATTACH POLICY: the session never adopts the user's own browsing profile implicitly. Either the user
// points it at an endpoint they opened (`attach`), or the plugin launches a browser with a DEDICATED
// profile directory (`open`). Chromium refuses to expose the debugging port on a profile already in
// use, so silently taking over a live profile is not even possible — this layer says so out loud
// instead of failing obscurely.
// ---------------------------------------------------------------------------------------------

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  CdpConnection, findBrowserExecutable, launchBrowser, listTargets,
  probeEndpoint, waitForEndpoint,
} from './browser-cdp.js'

const DEFAULT_PORT = 9222

export class BrowserSession {
  /**
   * @param {object} opts
   * @param {number} [opts.port]         debugging port
   * @param {string} [opts.profileDir]   dedicated profile dir for a launched browser
   * @param {string} [opts.executable]   browser binary override
   * @param {boolean} [opts.headless]    launch headless
   * @param {boolean} [opts.autoLaunch]  launch when nothing is listening (default true)
   */
  constructor (opts = {}) {
    this.port = Number.isFinite(opts.port) ? opts.port : DEFAULT_PORT
    this.profileDir = opts.profileDir || null
    this.executable = opts.executable || null
    this.headless = opts.headless === true
    this.autoLaunch = opts.autoLaunch !== false
    this.log = opts.log || (() => {})
    this.child = null            // the browser process WE launched, if any
    this.launchedByUs = false
    this.targetId = null         // the page we are attached to
    this.connection = null
    this.version = null
  }

  get connected () { return Boolean(this.connection && !this.connection.closed) }
  get ownsBrowser () { return this.launchedByUs }

  /** Endpoint facts without attaching. Returns null when nothing is listening. */
  async status () {
    const info = await probeEndpoint(this.port)
    if (!info) return { listening: false, port: this.port, connected: this.connected, ownsBrowser: this.launchedByUs, targetId: this.targetId }
    const targets = await listTargets(this.port)
    return {
      listening: true,
      port: this.port,
      browser: info.browser,
      protocolVersion: info.protocolVersion,
      connected: this.connected,
      ownsBrowser: this.launchedByUs,
      targetId: this.targetId,
      pages: targets ? targets.length : null,
    }
  }

  /**
   * Connect to a browser. If nothing is listening and `autoLaunch` is on, one is started with a
   * dedicated profile. Returns a status object rather than throwing for the "not there yet" case, so a
   * tool can report a precise cause instead of a generic failure.
   *
   * SCOPE (fixed after an integration failure): this method is about the BROWSER, not about a page.
   * An earlier version guarded on `this.connected && this.targetId`, which conflated "a browser is
   * available" with "a page is attached" — so a second `ensure()` before any `attach()` re-ran the
   * whole discovery path and reported `reused: false` for a browser it had just started. Page binding
   * is `attach()`'s job, and the two are now separable because they genuinely are separate.
   */
  async ensure (opts = {}) {
    // The result vocabulary is deliberately explicit. An earlier version reported a single `reused`
    // boolean, which an integration test caught being wrong: after the first `ensure()` the browser was
    // running but nothing was attached (attaching is `attach()`'s job), so the second call could report
    // neither "we launched it" nor "we reused a connection" without lying about one of them. The two
    // facts are now reported separately, and each is true on its own.
    if (this.connected) {
      return { ok: true, launched: false, attached: true, alreadyRunning: true, ...(await this.status()) }
    }

    let info = await probeEndpoint(this.port)
    let launched = false
    if (!info) {
      if (!this.autoLaunch) {
        return {
          ok: false, launched: false, attached: false,
          reason: `no debuggable browser on port ${this.port}`,
          hint: `start one with --remote-debugging-port=${this.port}, or allow the plugin to launch one`,
          port: this.port,
        }
      }
      const exe = this.executable || findBrowserExecutable()
      if (!exe) return { ok: false, launched: false, attached: false, reason: 'no Chromium-based browser found (Chrome or Edge)' }
      const profileDir = this.profileDir
      if (!profileDir) return { ok: false, launched: false, attached: false, reason: 'a dedicated profileDir is required to launch a browser' }
      try { mkdirSync(profileDir, { recursive: true }) } catch { /* a pre-existing dir is fine */ }
      this.log(`[browser] launching ${exe} on port ${this.port} (profile ${profileDir})`)
      this.child = launchBrowser({ executable: exe, port: this.port, profileDir, headless: this.headless, startUrl: opts.startUrl || 'about:blank' })
      this.launchedByUs = true
      this.child.on('exit', (code) => { this.log(`[browser] launched browser exited (code ${code})`); this.launchedByUs = false; this.child = null })
      info = await waitForEndpoint(this.port, opts.timeoutMs || 20_000)
      if (!info) {
        this.stopLaunched()
        return { ok: false, launched: true, attached: false, reason: `browser did not expose port ${this.port} within the timeout` }
      }
      launched = true
    }
    this.version = info
    return { ok: true, launched, attached: this.connected, alreadyRunning: !launched, ...(await this.status()) }
  }

  /** All page targets, newest protocol order preserved. */
  async tabs () {
    const targets = await listTargets(this.port)
    if (targets === null) return null
    return targets.map(t => ({ ...t, current: t.id === this.targetId }))
  }

  /**
   * Attach to a page target. With no selector, prefers the current target if it still exists, then the
   * first attachable page. Never invents a target: if none is attachable, that is reported.
   */
  async attach (selector = {}) {
    const targets = await listTargets(this.port)
    if (targets === null) return { ok: false, reason: `no debuggable browser on port ${this.port}` }
    if (targets.length === 0) return { ok: false, reason: 'the browser has no page targets' }

    let pick = null
    if (selector.targetId) pick = targets.find(t => t.id === selector.targetId) || null
    else if (selector.urlIncludes) pick = targets.find(t => t.url.includes(selector.urlIncludes)) || null
    else if (selector.titleIncludes) pick = targets.find(t => t.title.includes(selector.titleIncludes)) || null
    else if (this.targetId) pick = targets.find(t => t.id === this.targetId) || null

    const attachable = targets.filter(t => t.attachable)
    if (!pick) {
      if (selector.targetId || selector.urlIncludes || selector.titleIncludes) {
        return { ok: false, reason: 'no page target matched the selector', available: targets.map(t => ({ id: t.id, title: t.title, url: t.url })) }
      }
      pick = attachable[0] || null
    }
    if (!pick) return { ok: false, reason: 'no attachable page target', available: targets.map(t => ({ id: t.id, title: t.title })) }
    if (!pick.attachable) return { ok: false, reason: `target ${pick.id} exposes no debugger url (already attached elsewhere?)` }

    if (this.connection && this.targetId === pick.id && !this.connection.closed) {
      return { ok: true, reused: true, target: this.#describe(pick) }
    }
    this.detach()
    const conn = new CdpConnection(pick.webSocketDebuggerUrl, { log: this.log })
    try { await conn.connect() } catch (error) {
      return { ok: false, reason: `could not attach to target ${pick.id}: ${error.message}` }
    }
    this.connection = conn
    this.targetId = pick.id
    // Enable the domains the observation layer needs. A failure here is not fatal for every caller,
    // but it IS reported: a page whose DOM cannot be enabled must not look like an empty page.
    const enableErrors = []
    for (const method of ['Page.enable', 'DOM.enable', 'Runtime.enable', 'Accessibility.enable']) {
      try { await conn.send(method, {}) } catch (e) { enableErrors.push(`${method}: ${e.message}`) }
    }
    return { ok: true, reused: false, target: this.#describe(pick), ...(enableErrors.length ? { enableErrors } : {}) }
  }

  #describe (t) {
    return { id: t.id, title: t.title, url: t.url, type: t.type }
  }

  /** Send a command on the attached target. Throws a `disconnected` error when the socket is gone. */
  async send (method, params = {}, timeoutMs = 15_000) {
    if (!this.connected) throw Object.assign(new Error('browser session is not connected'), { disconnected: true })
    return this.connection.send(method, params, timeoutMs)
  }

  /** A fresh one-line description of the attached page, straight from the browser. */
  async currentPage () {
    if (!this.connected) return null
    const targets = await listTargets(this.port)
    if (targets === null) return null
    const t = targets.find(x => x.id === this.targetId)
    if (!t) return null
    return { id: t.id, title: t.title, url: t.url }
  }

  detach () {
    if (this.connection) { try { this.connection.close() } catch { /* already closed */ } }
    this.connection = null
    this.targetId = null
  }

  /** Close only the browser THIS session launched. A browser the user opened is left alone. */
  stopLaunched () {
    this.detach()
    if (this.child && this.launchedByUs) {
      try { this.child.kill() } catch { /* already gone */ }
      this.child = null
      this.launchedByUs = false
      return { closed: true }
    }
    return { closed: false, reason: 'this session did not launch a browser' }
  }

  dispose () {
    this.detach()
    if (this.child) { try { this.child.kill() } catch { /* already gone */ } this.child = null; this.launchedByUs = false }
  }
}

/** Resolve the dedicated profile directory for a launched browser. */
export function defaultProfileDir (dataDir) {
  return join(dataDir, 'browser-profile')
}
