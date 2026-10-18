// Publisher tool. This file is never an npm lifecycle hook.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

export const PACKAGE = 'dsh-codex-style-computer-use'
export const MIN_AGE_MS = 24 * 60 * 60 * 1000
export const OFFICIAL_REGISTRY = 'https://registry.npmjs.org'

// A mirror is useful for a read-only local check. Promotion must recheck and
// write the authoritative registry, even when CU_REGISTRY remains in the shell.
export function releaseRegistry(operation, override = process.env.CU_REGISTRY) {
  if (operation === 'promote') return OFFICIAL_REGISTRY
  if (operation !== 'check') throw Error('Expected check or promote')
  let registry
  try { registry = new URL(override?.trim() || OFFICIAL_REGISTRY) }
  catch { throw Error('CU_REGISTRY must be an HTTPS registry URL') }
  if (registry.protocol !== 'https:' || registry.username || registry.password || registry.search || registry.hash) {
    throw Error('CU_REGISTRY must be an HTTPS registry URL without credentials, query or fragment')
  }
  return registry.href.replace(/\/+$/, '')
}

export function releaseReadiness(metadata, version, now = Date.now()) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Promotion requires an exact stable version, e.g. 1.2.1')
  const manifest = metadata.versions?.[version]
  if (manifest?.name !== PACKAGE || manifest.version !== version) throw Error('The requested published version is missing or has the wrong identity')
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  if (repository?.replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/$/, '') !== 'https://github.com/ltmroberthk915/dsh-computer-use') throw Error('Published repository identity does not match')
  const publishedText = metadata.time?.[version]
  const publishedAt = typeof publishedText === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(publishedText) ? Date.parse(publishedText) : NaN
  if (!Number.isFinite(publishedAt) || publishedAt > now) throw Error('Missing or invalid registry publication time; refusing promotion')
  const latest = metadata['dist-tags']?.latest
  if (latest && /^\d+\.\d+\.\d+$/.test(latest)) {
    const a = version.split('.').map(Number), b = latest.split('.').map(Number)
    for (let i = 0; i < 3; i++) {
      if (a[i] < b[i]) throw Error('Refusing to move latest backwards')
      if (a[i] > b[i]) break
    }
  }
  const eligibleAt = publishedAt + MIN_AGE_MS
  return { package: PACKAGE, version, ready: now >= eligibleAt, publishedAt: new Date(publishedAt).toISOString(), eligibleAt: new Date(eligibleAt).toISOString(), remainingSeconds: Math.max(0, Math.ceil((eligibleAt - now) / 1000)) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, version] = process.argv.slice(2)
  let registry
  try {
    if (!['check', 'promote'].includes(operation) || !/^\d+\.\d+\.\d+$/.test(version || '')) throw Error('Usage: node scripts/release-channel.mjs check|promote <stable-version>')
    registry = releaseRegistry(operation)
    const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    if (!fs.existsSync(npm)) throw Error('Run this publisher command with the Node.js installation that includes npm')
    const npmArgs = [`--registry=${registry}`, '--fetch-retries=0', '--fetch-timeout=20000']
    const view = args => {
      let stdout
      try {
        stdout = execFileSync(process.execPath, [npm, 'view', ...args, '--json', ...npmArgs], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        const code = String(error.stderr ?? '').match(/npm (?:error|ERR!) code ([A-Z0-9_]+)/i)?.[1] || error.code || error.status || 'unknown'
        throw Error(`Registry query failed (${code}). Check network/proxy access and mirror synchronization; a failed query does not prove the package is unpublished. For a read-only check, set CU_REGISTRY to an accessible mirror. Promotion requires access to registry.npmjs.org.`)
      }
      try { return JSON.parse(stdout) }
      catch { throw Error('Registry query did not return valid JSON; release readiness is unknown') }
    }
    const manifest = view([`${PACKAGE}@${version}`])
    const metadata = { ...manifest, versions: { [version]: manifest } }
    const verdict = { ...releaseReadiness(metadata, version), registry, authoritative: registry === OFFICIAL_REGISTRY }
    console.log(JSON.stringify(verdict, null, 2))
    if (!verdict.ready) { process.exitCode = 2 }
    else if (operation === 'promote') {
      execFileSync(process.execPath, [npm, 'dist-tag', 'add', `${PACKAGE}@${version}`, 'latest', ...npmArgs], { stdio: 'inherit', windowsHide: true })
      const tag = view([PACKAGE, 'dist-tags.latest'])
      if (tag !== version) throw Error('Registry latest did not match after promotion')
      console.log(`Verified latest: ${PACKAGE}@${version}`)
    }
  } catch (error) { console.error(JSON.stringify({ operation, registry, error: error.message }, null, 2)); process.exitCode = 1 }
}
