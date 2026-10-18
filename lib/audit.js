// audit.js — snapshot paths + JSONL audit trail for dsh-computer-use.
// Every actuation the core emits lands here: {ts, op, args(redacted), result?|error?}.
// Screenshots taken before risky ops (v1) will join the same stream.

import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export function mkDataDir (configured) {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const dir = configured && configured.length > 0
    ? configured
    : join(dshHome, 'data', 'computer-use')
  const shots = join(dir, 'shots')
  if (!existsSync(shots)) mkdirSync(shots, { recursive: true })
  return { root: dir, shots }
}

export function snapshotPath (dataDir) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const ms = Date.now() % 1000
  return join(dataDir.shots, `shot-${ts}-${ms}-${randomUUID()}.jpg`)
}

export function appendAudit (dataDir, rec) {
  try {
    appendFileSync(join(dataDir.root, 'audit.jsonl'), JSON.stringify(rec) + '\n')
  } catch { /* audit must never break the action */ }
}
