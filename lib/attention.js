import { AttentionNative } from './attention-native.js'

// Pure event wiring + a separately testable native boundary. Never handles answers or approvals.
export function installHumanAttention (ctx, log, options = {}) {
  let raise = null
  const native = options.native || new AttentionNative()
  // Official 0.2.x launches dsh-desktop-host as Electron's Node child and does NOT
  // register the legacy desktopRuntime Cordis service. Waiting for it disables ALL listeners.
  const nativeHost = options.nativeHost ?? (process.platform === 'win32' &&
    process.argv.some(arg => String(arg).replaceAll('\\', '/').includes('/dsh-desktop-host/')))
  native.log({ stage: 'installer-enter', nativeHost, pid: process.pid, argvEntry: process.argv[1],
    electronNodeMode: process.env.ELECTRON_RUN_AS_NODE === '1' })
  const install = desktopCtx => {
    if (raise) return
    let runtime
    // Cordis' property proxy may throw for an unregistered service; optional chaining
    // on that property is insufficient. get() is the optional service lookup API.
    try { runtime = typeof desktopCtx.get === 'function' ? desktopCtx.get('desktopRuntime') : desktopCtx.desktopRuntime } catch {}
    if (typeof runtime?.show !== 'function' && !nativeHost) { log.warn('human attention: desktopRuntime.show unavailable'); return }
    const now = options.now || Date.now
    const pending = new Map(), inFlight = new Map(), recent = new Map(), questionKeys = new WeakMap()
    let anonymous = 0, disposed = false
    const record = data => native.log(data)
    const trim = map => { while (map.size > 256) map.delete(map.keys().next().value) }
    const bounded = (promise, ms) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`show timed out (${ms}ms)`)), ms)
      Promise.resolve(promise).then(v => { clearTimeout(timer); resolve(v) }, e => { clearTimeout(timer); reject(e) })
    })
    native.start().catch(error => record({ stage: 'prewarm-failed', error: error.stack || String(error) }))
    raise = (key, what, stillPending = () => true) => {
      if (disposed) return Promise.resolve(false)
      key ||= `anon:${++anonymous}`
      if (inFlight.has(key)) return inFlight.get(key)
      if (recent.has(key) && now() - recent.get(key) < 1500) return Promise.resolve(true)
      const started = performance.now()
      const work = (async () => {
        record({ stage: 'raise-start', key, what })
        let before, probeError
        try { before = await native.request('probe') } catch (e) { probeError = e.message }
        if (disposed || !stillPending()) {
          record({ stage: 'raise-cancelled', key, what })
          return false
        }
        if (before?.focused && before?.sampledVisible) {
          record({ stage: 'raise-result', key, what, status: 'already-visible', visible: true, focused: true, elapsedMs: Math.round(performance.now() - started) })
          log.info(`Desktop already in front for ${what}`)
          return true
        }
        // The host request and the independent visibility fallback run together. A rejected/hung
        // host RPC must not suppress the fallback or delay the card waterfall.
        let show
        try { show = typeof runtime?.show === 'function'
          ? bounded(runtime.show(), 150).then(() => 'requested', e => `error: ${e.message}`)
          : Promise.resolve('unavailable-native-fallback') }
        catch (e) { show = Promise.resolve(`error: ${e.message}`) }
        let result
        try { result = await native.request('raise') }
        catch (error) {
          record({ stage: 'raise-result', key, what, status: 'error', visible: false, probeError, show: await show, error: error.stack || String(error), elapsedMs: Math.round(performance.now() - started) })
          log.warn(`could not reveal Desktop for ${what}: ${error.message}`)
          return false
        }
        const elapsedMs = Math.round(performance.now() - started)
        record({ stage: 'raise-result', key, what, ...result, show: await show, probeError, elapsedMs, within1s: result.visible === true && elapsedMs <= 1000 })
        if (result.visible === true) log.info(`Desktop ${result.focused ? 'foreground' : 'visible without focus'} CONFIRMED for ${what} (${elapsedMs}ms)`)
        else log.warn(`could not reveal Desktop for ${what}: ${result.status}; flash=${result.flash || 'unknown'}`)
        return result.visible === true
      })().catch(error => { record({ stage: 'raise-error', key, error: error.stack || String(error) }); return false })
      inFlight.set(key, work)
      work.then(ok => { inFlight.delete(key); if (ok) { recent.set(key, now()); trim(recent) } })
      return work
    }
    const schedule = (key, what) => {
      const previous = pending.get(key)
      if (previous && (!previous.exhausted || inFlight.has(key))) return
      const item = { timer: null, attempts: 0 }
      pending.set(key, item)
      const attempt = async () => {
        if (disposed || pending.get(key) !== item) return
        item.attempts++
        const ok = await raise(key, what, () => pending.get(key) === item)
        if (!ok && item.attempts < 2 && pending.get(key) === item && !disposed) {
          item.timer = setTimeout(attempt, options.retryMs ?? 700)
          item.timer.unref?.()
          record({ stage: 'retry-scheduled', key })
        }
        if (!ok && item.attempts >= 2) item.exhausted = true
      }
      void attempt()
    }
    const finish = key => {
      const item = pending.get(key)
      if (item) clearTimeout(item.timer)
      pending.delete(key)
    }
    const question = (...args) => {
      const next = args[args.length - 1]
      const request = args.find(a => a && typeof a === 'object' && Array.isArray(a.questions)) || {}
      let key = questionKeys.get(request)
      if (!key) {
        const ids = (request.questions || []).map(q => q?.id).filter(Boolean).join(',')
        key = `q:${ids}#${++anonymous}`
        questionKeys.set(request, key)
      }
      schedule(key, `pending question (${(request.questions || []).length} question(s))`)
      // Preserve the original waterfall result, including rejecting promises.
      let answer
      try { answer = typeof next === 'function' ? next() : undefined }
      catch (e) { finish(key); throw e }
      if (answer?.then) answer.then(() => finish(key), () => finish(key))
      else finish(key)
      return answer
    }
    const approval = (session, event) => {
      const id = event?.data?.id
      if (typeof id !== 'string' || !id) return
      const key = `a:${typeof session === 'string' ? session : session?.id || ''}:${id}`
      if (event.type === 'approval/decided') { finish(key); return }
      if (event.type === 'approval/asked') schedule(key, `pending approval ${id} (${event.data.toolName || 'tool'})`)
    }
    for (const target of new Set([ctx, desktopCtx])) {
      target.on('user-questions/request', question, { prepend: true })
      target.on('session/event', approval, { prepend: true })
    }
    desktopCtx.on('dispose', () => {
      disposed = true
      for (const key of pending.keys()) finish(key)
      void native.close()
    })
    record({ stage: 'installed', hostMode: nativeHost ? 'official-desktop-native' : 'legacy-desktop-runtime', pid: process.pid, execPath: process.execPath })
    log.info('human attention enabled: foreground, measured visibility, flash request, persistent diagnostics')
  }
  if (nativeHost) install(ctx)
  else ctx.inject(['desktopRuntime'], install)
  return (key, what) => {
    if (raise) return raise(key, what)
    log.warn(`human attention: desktopRuntime not ready for ${what}`)
    return Promise.resolve(false)
  }
}
