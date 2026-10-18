import { appendFileSync, readFileSync, lstatSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const manifest = dir => join(dir.root, 'owned-shots.jsonl')

export function saveOwnedShot (dir, path, bytes) {
  if (resolve(dirname(path)) !== resolve(dir.shots)) throw new Error('shot path outside its owned directory')
  writeFileSync(path, bytes, { flag: 'wx' })
  // A failed manifest write merely makes this image ineligible for cleanup.
  try { appendFileSync(manifest(dir), JSON.stringify({ file: basename(path), sha256: digest(bytes), size: bytes.length, createdAt: Date.now() }) + '\n') } catch {}
  return path
}

export function cleanupOwnedShots (dir, { before, dryRun = true } = {}) {
  if (!Number.isFinite(before)) throw new Error('an explicit created-before timestamp is required')
  let lines
  try { lines = readFileSync(manifest(dir), 'utf8').split('\n') } catch { return { dryRun, files: [], bytes: 0 } }
  const result = { dryRun, files: [], bytes: 0 }
  const seen = new Set()
  for (const line of lines) {
    try {
      const record = JSON.parse(line)
      if (!record.file || record.file !== basename(record.file) || seen.has(record.file) ||
          !/^shot-[\w-]+\.(jpg|png)$/.test(record.file) || !(record.createdAt < before)) continue
      seen.add(record.file)
      const path = join(dir.shots, record.file), stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.size || digest(readFileSync(path)) !== record.sha256) continue
      if (!dryRun) unlinkSync(path)
      result.files.push(path); result.bytes += stat.size
    } catch { /* missing, locked, modified or malformed entries are retained */ }
  }
  return result
}
