#Requires -Version 5.1
param([switch]$Apply, [string]$DshInstall = '', [string]$ProfileDirectory = '')
$ErrorActionPreference = 'Stop'
$cuPreviousNodeMode = $env:ELECTRON_RUN_AS_NODE
try {
    if (-not $DshInstall) {
        $cuCandidates = @(Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness')
        foreach ($cuRegistry in @('HKCU:/Software/Microsoft/Windows/CurrentVersion/Uninstall/*', 'HKLM:/Software/Microsoft/Windows/CurrentVersion/Uninstall/*')) {
            $cuEntries = Get-ItemProperty $cuRegistry -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'DeepSeek Harness*' }
            foreach ($cuEntry in $cuEntries) { if ($cuEntry.InstallLocation) { $cuCandidates += [string]$cuEntry.InstallLocation } }
        }
        $DshInstall = $cuCandidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'DeepSeek Harness.exe') } | Select-Object -First 1
    }
    if (-not $DshInstall) { throw 'DSH Desktop was not found. Pass -DshInstall with its installation directory.' }
    if (-not $ProfileDirectory) {
        $cuDshDirectory = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
        $ProfileDirectory = Join-Path $cuDshDirectory 'profiles/desktop'
    }
    $cuPatch = [IO.Path]::GetFullPath((Join-Path $ProfileDirectory 'cordis.patch.yml'))
    if (-not (Test-Path -LiteralPath $cuPatch)) { throw "Profile patch not found: $cuPatch" }
    $cuExecutable = Join-Path $DshInstall 'DeepSeek Harness.exe'
    $cuScript = Join-Path $PSScriptRoot 'migrate-profile.mjs'
    $cuArguments = @('--expose-internals', $cuScript, '--patch', $cuPatch)
    if ($Apply) { $cuArguments += '--apply' }
    $env:ELECTRON_RUN_AS_NODE = '1'
    # Piping makes Windows PowerShell wait for Electron's GUI-subsystem exe.
    & $cuExecutable @cuArguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Migration failed (exit $LASTEXITCODE). No success is claimed; inspect the message above." }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally {
    if ($null -eq $cuPreviousNodeMode) { Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
    else { $env:ELECTRON_RUN_AS_NODE = $cuPreviousNodeMode }
}
