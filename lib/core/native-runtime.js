// Native helpers ship prebuilt. Source checkouts can compile with Windows' own
// .NET Framework compiler; neither path needs PowerShell, an SDK, or a network.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fileHash = file => hash(fs.readFileSync(file))
const framework = env => path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319')

export function workerReferences (env = process.env) {
  const gac = path.join(env.SystemRoot || env.windir || 'C:\\Windows', 'Microsoft.NET', 'assembly', 'GAC_MSIL')
  return ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Web.Extensions.dll', 'System.Windows.Forms.dll',
    ...['UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'].map(name => path.join(gac, name, 'v4.0_4.0.0.0__31bf3856ad364e35', `${name}.dll`))]
}

export function compileNativeBinary (source, output, references, { env = process.env } = {}) {
  const compiler = path.join(framework(env), 'csc.exe')
  if (!fs.existsSync(compiler)) {
    throw new Error('Computer Use 缺少可用的预编译组件，且 Windows .NET Framework 4.x 编译器不存在。请在插件市场重新安装最新版；如果仍失败，请启用 Windows 的 .NET Framework 4.x。无需安装 PowerShell 7。 / No usable prebuilt helper or Windows .NET Framework 4.x compiler. Reinstall the plugin from the market, or enable .NET Framework 4.x. PowerShell 7 is not required.')
  }
  try {
    execFileSync(compiler, ['/nologo', '/target:exe', '/platform:x64', '/optimize+', '/warn:1', `/out:${output}`,
      ...references.map(ref => `/r:${ref}`), source], { encoding: 'utf8', windowsHide: true, timeout: 120_000, env })
  } catch (error) {
    throw new Error(`Computer Use 原生组件编译失败，请从市场重新安装完整发布包。 / Native helper compilation failed; reinstall the complete market package. ${error.message}\n${error.stdout || ''}\n${error.stderr || ''}`, { cause: error })
  }
}

// Publish-time only. Deliberately not an install/prepare lifecycle hook.
export function buildNativeBundle ({ source, name, references }, options = {}) {
  const bin = path.join(path.dirname(source), 'bin')
  fs.mkdirSync(bin, { recursive: true })
  const binary = path.join(bin, name)
  compileNativeBinary(source, binary, references, options)
  const manifest = { format: 1, platform: 'win32', architecture: 'x64', sourceSha256: fileHash(source), binarySha256: fileHash(binary) }
  fs.writeFileSync(`${binary}.json`, JSON.stringify(manifest, null, 2) + '\n')
  return { binary, ...manifest }
}

function verifiedBinary (binary, sourceSha256, expectedBinarySha256) {
  try {
    const manifest = JSON.parse(fs.readFileSync(`${binary}.json`, 'utf8'))
    return manifest.format === 1 && manifest.platform === 'win32' && manifest.architecture === 'x64' &&
      manifest.sourceSha256 === sourceSha256 && /^[a-f0-9]{64}$/.test(manifest.binarySha256) &&
      (!expectedBinarySha256 || manifest.binarySha256 === expectedBinarySha256) &&
      fileHash(binary) === manifest.binarySha256 ? manifest : null
  } catch { return null }
}

export function prepareNativeBinary ({ source, name, cache, references }, { env = process.env, log = () => {} } = {}) {
  if (process.platform !== 'win32') throw new Error('Computer Use requires Windows. / Computer Use 仅支持 Windows。')
  const sourceSha256 = fileHash(source)
  const bundled = path.join(path.dirname(source), 'bin', name)
  const manifest = verifiedBinary(bundled, sourceSha256)
  // Include the binary/build identity so an update never replaces a running exe.
  const identity = manifest?.binarySha256 || hash(JSON.stringify({ compiler: framework(env), references, recipe: 1 }))
  const cacheRoot = path.join(env.LOCALAPPDATA || os.tmpdir(), 'dsh-computer-use', cache)
  const dir = path.join(cacheRoot, `${sourceSha256.slice(0, 16).toUpperCase()}-${manifest ? 'prebuilt' : 'csc'}-${identity.slice(0, 16)}`)
  const binary = path.join(dir, name)
  if (verifiedBinary(binary, sourceSha256, manifest?.binarySha256)) return binary
  fs.mkdirSync(cacheRoot, { recursive: true })
  const temporary = fs.mkdtempSync(path.join(cacheRoot, '.building-'))
  try {
    const output = path.join(temporary, name)
    if (manifest) {
      fs.copyFileSync(bundled, output)
    } else {
      log('[computer-use] no matching prebuilt helper; compiling with Windows .NET Framework (no PowerShell required)')
      compileNativeBinary(source, output, references, { env })
    }
    const built = { format: 1, platform: 'win32', architecture: 'x64', sourceSha256, binarySha256: fileHash(output) }
    if (manifest && built.binarySha256 !== manifest.binarySha256) throw new Error('Computer Use native helper changed during installation; reinstall the package.')
    fs.writeFileSync(`${output}.json`, JSON.stringify(built) + '\n')
    // Publish the binary and its identity together. Concurrent first use accepts
    // only another complete build of the same source; it never executes a partial copy.
    try { fs.renameSync(temporary, dir) }
    catch (error) {
      if (!verifiedBinary(binary, sourceSha256, manifest?.binarySha256)) {
        // Preserve a damaged/locked cache for diagnosis and use a fresh verified
        // directory. No running helper or installed package is overwritten.
        if (!fs.existsSync(dir)) throw error
        const repaired = `${dir}-repaired-${path.basename(temporary)}`
        fs.renameSync(temporary, repaired)
        return path.join(repaired, name)
      }
    }
    log(`[computer-use] ${manifest ? 'prebuilt' : 'compiled'} helper ready: ${binary}`)
    return binary
  } finally {
    // Only this call's freshly allocated scratch directory can be removed.
    if (path.dirname(temporary) !== cacheRoot) throw new Error('invalid native build scratch path')
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}
