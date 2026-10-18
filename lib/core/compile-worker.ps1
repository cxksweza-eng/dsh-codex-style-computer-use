param(
    # RESOLVED FROM THIS SCRIPT'S OWN LOCATION, NOT FROM A MACHINE-SPECIFIC PATH (2026-09-16).
    # It used to default to `D:\BuyKey\dsh-computer-use\packages\computer-use-core\src\worker.cs`, which is
    # correct on exactly one computer — and `compileWorkerSync()` in index.js calls this script WITHOUT
    # `-Path`, so on any other machine the plugin's compile-on-demand path pointed at a file that is not
    # there. That is a silent portability failure: the plugin only reaches it when no cached worker exists,
    # i.e. on a fresh install, i.e. on the machine that has never worked. `$PSScriptRoot` is the directory
    # this file lives in, and `worker.cs` ships beside it.
    [string]$Path = '',
    [switch]$Force,
    # OPTIONAL NAMESPACE FOR THE CACHE DIRECTORY. The cache key is the source's sha16, which is right
    # for the deployed worker but wrong for a TEST SANDBOX: two runs of the same test compile identical
    # sources, so they land on the SAME exe path, and a worker left running by an earlier run holds
    # that file open — `csc` then fails with CS0016 ("cannot write output file") and a test that cannot
    # rebuild its fault-injected worker silently has nothing to measure. Measured exactly that:
    # build/test-ask-release.mjs alternated pass/fail depending on whether a stale sandbox worker from
    # its own previous run was still alive. A caller that needs isolation passes a unique token (e.g.
    # its own pid); the default is '' so the deployed worker's cache path is unchanged.
    [string]$CacheToken = ''
)
if (-not $Path) { $Path = Join-Path $PSScriptRoot 'worker.cs' }
# compile-worker.ps1 — turn worker.cs into a cached native worker.exe.
# Uses ONLY the C# 5 compiler shipping with Windows (Framework64 csc.exe):
# no SDK, no node-gyp, no network. C# source stays C#-5-compatible on purpose.
# Cache: %LOCALAPPDATA%\dsh-computer-use\worker\<sha16>[<CacheToken>]\worker.exe
$ErrorActionPreference = 'Stop'

$cacheRoot = Join-Path $env:LOCALAPPDATA 'dsh-computer-use\worker'
$sha = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
$outDir = Join-Path $cacheRoot ($sha.Substring(0, 16) + $CacheToken)
$outExe = Join-Path $outDir 'dsh-computer-use-worker.exe'
Write-Host "worker cache dir: $outDir"

if ((Test-Path -LiteralPath $outExe) -and -not $Force) {
    Write-Host 'cached worker is current; use -Force to recompile'
    Write-Output $outExe
    return
}

$csc = "$env:windir\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path -LiteralPath $csc)) { throw 'csc.exe not found (.NET Framework 4.x missing?)' }

# csc does not resolve GAC simple names — pass full assembly paths
$gac = "$env:windir\Microsoft.NET\assembly\GAC_MSIL"
$refs = @(
    '/r:System.dll', '/r:System.Core.dll', '/r:System.Drawing.dll',
    '/r:System.Web.Extensions.dll', '/r:System.Windows.Forms.dll',
    "/r:$gac\UIAutomationClient\v4.0_4.0.0.0__31bf3856ad364e35\UIAutomationClient.dll",
    "/r:$gac\UIAutomationTypes\v4.0_4.0.0.0__31bf3856ad364e35\UIAutomationTypes.dll",
    "/r:$gac\WindowsBase\v4.0_4.0.0.0__31bf3856ad364e35\WindowsBase.dll"
)

New-Item -ItemType Directory -Path $outDir -Force | Out-Null
& $csc /nologo /target:exe /platform:x64 /optimize+ /warn:1 /out:$outExe $refs $Path
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }
if (-not (Test-Path -LiteralPath $outExe)) { throw 'compile produced no exe' }
Write-Host "compiled OK -> $outExe"
Write-Output $outExe
