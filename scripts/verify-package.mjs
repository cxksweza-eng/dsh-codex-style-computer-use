import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
const root = path.resolve(process.argv[2] || path.join(import.meta.dirname, '..'))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
assert.equal(pkg.name, 'dsh-codex-style-computer-use')
assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
assert.equal(pkg.packageManager, undefined, 'git installs must not invoke a nested package manager')
for (const hook of ['prepare', 'prepack', 'prepublish', 'prepublishOnly', 'preinstall', 'install', 'postinstall']) assert.equal(pkg.scripts?.[hook], undefined, hook)
const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
assert.match(patch, /name: dsh-codex-style-computer-use\s/)
assert.match(patch, /automationMode: standard\s/)
const digest = file => createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')
for (const [source, binary] of [
  ['lib/core/worker.cs', 'lib/core/bin/dsh-computer-use-worker.exe'],
  ['lib/attention-worker.cs', 'lib/bin/attention-worker.exe'],
]) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, binary + '.json'), 'utf8'))
  assert.equal(manifest.sourceSha256, digest(source), source)
  assert.equal(manifest.binarySha256, digest(binary), binary)
  assert.equal(manifest.platform, 'win32')
  assert.equal(manifest.architecture, 'x64')
}
for (const file of ['lib/index.js', 'lib/core/native-runtime.js', 'lib/attention-native.js', 'skills/computer-use/SKILL.md', 'mcp/src/index.js']) assert(fs.existsSync(path.join(root, file)), file)
const attention = fs.readFileSync(path.join(root, 'lib/attention-native.js'), 'utf8')
assert(attention.includes("'./core/native-runtime.js'"), 'attention helper must use the bundled core')
console.log(`ok package: ${pkg.name}@${pkg.version}; prebuilt helpers verified; no install hooks`)
