// Explicit one-time user-patch migration. No install hook and no plugin startup write.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

export const OLD_NAME = 'dsh-computer-use'
export const NEW_NAME = 'dsh-codex-style-computer-use'

export function planMigration(source, yaml) {
  const doc = yaml.parseDocument(source, { keepSourceTokens: true, uniqueKeys: true })
  if (doc.errors.length) throw Error(`Invalid patch YAML: ${doc.errors[0].message}`)
  if (!yaml.isSeq(doc.contents)) throw Error('The patch file must be a YAML list')
  const replacements = [], unsupported = []
  for (const item of doc.contents.items) {
    if (!yaml.isMap(item) || item.get('id') !== 'computer-use') continue
    const name = item.get('name', true)
    if (!yaml.isScalar(name) || name.value !== OLD_NAME) continue
    if (item.has('insert') || !name.range) { unsupported.push('A computer-use insert patch needs manual review'); continue }
    replacements.push({ start: name.range[0], end: name.range[1], value: JSON.stringify(NEW_NAME) })
  }
  if (unsupported.length) throw Error(unsupported.join('; '))
  let updated = source
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) updated = updated.slice(0, replacement.start) + replacement.value + updated.slice(replacement.end)
  // Only exact name scalars are replaced; config values, disabled state, comments,
  // other plugins, line endings and !!js expressions keep their original bytes.
  return { source, updated, changes: replacements.length }
}

export async function applyMigration(filename, plan, atomic) {
  if (!plan.changes) return { changed: false, changes: 0 }
  return atomic.withFileLock(filename, async () => {
    const stat = fs.lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Refusing to replace a non-regular patch file')
    if (fs.readFileSync(filename, 'utf8') !== plan.source) throw Error('The patch changed after inspection; read it again before applying')
    const backup = `${filename}.before-computer-use-rename-${randomUUID()}.bak`
    fs.writeFileSync(backup, plan.source, { flag: 'wx', mode: stat.mode & 0o777 })
    await atomic.writeFileAtomic(filename, plan.updated, { mode: stat.mode & 0o777 })
    return { changed: true, changes: plan.changes, backup }
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    const value = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1] }
    const filename = value('--patch')
    if (!filename || !path.isAbsolute(filename)) throw Error('Usage: migrate-profile.mjs --patch <absolute cordis.patch.yml> [--host-root <absolute DSH runtime>] [--apply]')
    const host = value('--host-root') || path.join(path.dirname(process.execPath), 'resources/app.asar/dsh')
    const require = createRequire(path.join(host, 'package.json'))
    const yaml = require('yaml')
    const atomic = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-atomic-write')).href)
    const plan = planMigration(fs.readFileSync(filename, 'utf8'), yaml)
    if (args.includes('--apply') && plan.changes) {
      const profile = JSON.parse(fs.readFileSync(path.join(path.dirname(filename), 'package.json'), 'utf8'))
      const bundles = profile.dsh?.profile?.bundles || []
      if (!bundles.includes(NEW_NAME) || bundles.includes(OLD_NAME)) throw Error('Install the new bundle and remove the old bundle first; this tool only migrates one profile, never the shared home patch')
      const installed = JSON.parse(fs.readFileSync(path.join(path.dirname(filename), 'node_modules', NEW_NAME, 'package.json'), 'utf8'))
      if (installed.name !== NEW_NAME) throw Error('The new package identity does not match')
    }
    const result = args.includes('--apply') ? await applyMigration(filename, plan, atomic) : { changed: false, changes: plan.changes, preview: true }
    console.log(JSON.stringify({ patch: filename, oldName: OLD_NAME, newName: NEW_NAME, ...result }, null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
