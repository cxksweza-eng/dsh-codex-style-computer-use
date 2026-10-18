import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { prepareNativeBinary } from './core/native-runtime.js'

export class AttentionNative {
  constructor ({ exe = process.execPath, hostPid = process.pid, ownerPid = 0, dataDir, timeoutMs = 1800 } = {}) {
    this.target = { exe, hostPid, ownerPid }
    this.timeoutMs = timeoutMs
    this.dataDir = dataDir || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'data', 'computer-use')
    this.pending = new Map()
    this.starting = null
    this.child = null
    this.closed = false
    this.journal = path.join(this.dataDir, 'attention-native.jsonl')
    fs.mkdirSync(this.dataDir, { recursive: true })
  }
  log (record) {
    try { fs.appendFileSync(path.join(this.dataDir, 'attention.jsonl'), JSON.stringify({ utc: new Date().toISOString(), version: 'attention-v1', ...record }) + '\n') } catch (error) { console.error('[dsh-attention] log write failed:', error.message) }
  }
  async compile () {
    const source = fileURLToPath(new URL('./attention-worker.cs', import.meta.url))
    return prepareNativeBinary({ source, name: 'attention-worker.exe', cache: 'attention',
      references: ['System.Web.Extensions.dll'] }, { log: message => this.log({ stage: 'helper-prepare', message }) })
  }
  async start () {
    if (this.closed) throw new Error('attention helper disposed')
    if (this.child) return
    if (this.starting) return this.starting
    this.starting = (async () => {
      const binary = await this.compile()
      if (this.closed) throw new Error('attention helper disposed')
      await new Promise((resolve, reject) => {
        const child = spawn(binary, [this.journal], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        this.child = child
        let buffer = '', ready = false
        const timer = setTimeout(() => { reject(new Error('attention helper startup timeout')); child.stdin.end() }, 5000)
        const fail = (error) => {
          clearTimeout(timer)
          if (this.child === child) this.child = null
          for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error) }
          this.pending.clear()
          if (!ready) reject(error)
          this.log({ stage: 'helper-exit', error: error.message })
        }
        child.once('error', fail)
        child.once('exit', (code, signal) => fail(new Error(`attention helper exited: ${code}/${signal}`)))
        child.stderr.on('data', b => this.log({ stage: 'helper-stderr', text: String(b).slice(0, 4000) }))
        child.stdin.on('error', e => this.log({ stage: 'helper-stdin-error', error: e.message }))
        child.stdout.on('data', chunk => {
          buffer += chunk.toString('utf8')
          for (let eol; (eol = buffer.indexOf('\n')) >= 0;) {
            const line = buffer.slice(0, eol).trim(); buffer = buffer.slice(eol + 1)
            if (!line) continue
            let event
            try { event = JSON.parse(line) } catch { this.log({ stage: 'helper-protocol-error', line: line.slice(0, 500) }); continue }
            if (event.stage === 'ready') { ready = true; clearTimeout(timer); this.log({ stage: 'helper-ready', ...event.data, binary }); resolve() }
            if ('result' in event || event.error) {
              const pending = this.pending.get(event.id)
              if (!pending) continue
              clearTimeout(pending.timer); this.pending.delete(event.id)
              if (event.error) pending.reject(new Error(event.error)); else pending.resolve(event.result)
            }
          }
        })
      })
    })()
    try { await this.starting } finally { this.starting = null }
  }
  async request (op, options = {}) {
    const started = performance.now()
    await this.start()
    const id = randomUUID()
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`attention ${op} timed out (${this.timeoutMs} ms)`)) }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(JSON.stringify({ ...this.target, ...options, op, id }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
      })
    })
    return { ...result, roundTripMs: Math.round(performance.now() - started), requestId: id }
  }
  async close () {
    this.closed = true
    if (this.starting) await this.starting.catch(() => {})
    const child = this.child
    if (!child) return
    // EOF executes the native finally; do not terminate it while it owns a topmost lease.
    await new Promise(resolve => { child.once('exit', resolve); child.stdin.end(); setTimeout(resolve, 2000).unref() })
  }
}
