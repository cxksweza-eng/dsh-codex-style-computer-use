import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { ComputerUse } from '../lib/core/index.js'
import { AttentionNative } from '../lib/attention-native.js'
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-release-smoke-'))
const before = { ...process.env }
let cu, attention
try {
  process.env.LOCALAPPDATA = path.join(scratch, 'local')
  process.env.DSH_HOME = path.join(scratch, 'home')
  process.env.DSH_COMPUTER_USE_STOP_FILE = path.join(scratch, 'STOP')
  process.env.DSH_COMPUTER_USE_EXIT_FILE = path.join(scratch, 'EXITED')
  process.env.DSH_COMPUTER_USE_AUDIT_LOG = path.join(scratch, 'audit.log')
  process.env.PATH = ''; process.env.Path = ''
  // Read-only capture test; avoid focusing or injecting input into a user's app.
  cu = new ComputerUse({ kickoffRequired: false })
  const ping = await cu.call('ping', {})
  assert.equal(ping.pong, true)
  assert.match(cu.workerExe, /prebuilt/)
  const cursor = await cu.call('cursor', {})
  assert.equal(typeof cursor.x, 'number')
  const shot = await cu.screenshot({ maxWidth: 320 })
  assert(shot.image.length > 100)
  attention = new AttentionNative({ exe: path.join(scratch, 'absent-host.exe'), hostPid: 0, dataDir: path.join(scratch, 'attention') })
  assert.match(await attention.compile(), /prebuilt/)
  await attention.start()
  const probe = await attention.request('probe')
  assert.equal(probe.status, 'no-window')
  assert.equal(probe.visible, false)
  assert.match(probe.requestId, /^[0-9a-f-]{36}$/i)
  console.log(JSON.stringify({ ok: true, pathEmpty: true, coldCache: true, prebuiltWorker: true, ping: true, screenshotBytes: shot.image.length, attentionReady: true, attentionProbe: true }))
} finally {
  await attention?.close()
  await cu?.kill()
  if (cu?.proc) await new Promise(resolve => { cu.proc.once('exit', resolve); setTimeout(resolve, 2000).unref() })
  for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key]
  Object.assign(process.env, before)
  if (!scratch.startsWith(path.join(os.tmpdir(), 'cu-release-smoke-'))) throw Error('invalid smoke cleanup')
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
