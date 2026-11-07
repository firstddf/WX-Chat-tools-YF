# M-A4 sidecar packaging (docs/03 section 4):
#   pyinstaller(wxchart_data.spec, onedir) -> dist/wxchart-data/{wxchart-data.exe,_internal/}
#   -> rename exe to wxchart-data-x86_64-pc-windows-msvc.exe (Tauri externalBin platform suffix)
#   -> drop into src-tauri/binaries/ (tauri-build validates it at build time; _internal goes
#      through bundle.resources and installs to $INSTDIR\_internal\ because NSIS copies only
#      the single externalBin file).
# Idempotent: fully rebuilds its two targets (exe + _internal) each run.
# Usage:  Set-ExecutionPolicy -Scope Process Bypass -Force; & scripts/build-sidecar.ps1
# Requires: python + PyInstaller 6.20 (this machine: Python 3.10.11).
# Build takes ~1-3 minutes. ASCII-only on purpose (PowerShell 5.1 encoding pitfalls).
$ErrorActionPreference = 'Stop'
$tauri = Split-Path -Parent $PSScriptRoot                       # wxchart-tauri
$sidecar = Join-Path $tauri 'sidecar'
$spec = Join-Path $sidecar 'wxchart_data.spec'
$binDir = Join-Path $tauri 'src-tauri\binaries'
$triple = 'x86_64-pc-windows-msvc'                              # must match `tauri build` target
$exeName = "wxchart-data-$triple.exe"

if (-not (Test-Path $spec)) { throw "spec not found: $spec" }

Write-Host ">>> pyinstaller $spec"
Push-Location $sidecar
try {
    python -m PyInstaller --noconfirm $spec
    if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed (exit=$LASTEXITCODE)" }
}
finally { Pop-Location }

# --- output check (onedir: exe + sibling _internal/, bootloader needs _internal) ---
$dist = Join-Path $sidecar 'dist\wxchart-data'
$distExe = Join-Path $dist 'wxchart-data.exe'
$distInternal = Join-Path $dist '_internal'
if (-not (Test-Path $distExe)) {
    $found = (Get-ChildItem (Join-Path $sidecar 'dist') -ErrorAction SilentlyContinue | ForEach-Object Name) -join ', '
    throw "no dist/wxchart-data/wxchart-data.exe (dist contains: $found)"
}
if (-not (Test-Path $distInternal)) { throw "no dist/wxchart-data/_internal/ (unexpected PyInstaller layout)" }

# --- idempotent install: only touch our two targets, keep anything else in binaries/ ---
$dstExe = Join-Path $binDir $exeName
$dstInternal = Join-Path $binDir '_internal'
if (Test-Path $dstExe) { Remove-Item $dstExe -Force }
if (Test-Path $dstInternal) { Remove-Item $dstInternal -Recurse -Force }
New-Item -ItemType Directory -Path $binDir -Force | Out-Null
Copy-Item $distExe $dstExe
Copy-Item $distInternal $dstInternal -Recurse

# The workspace root carries the DSH sandbox "Low Mandatory Level" label (docs/05), so the
# freshly copied exe inherits Low IL. A Low-IL sidecar cannot enumerate Weixin.exe processes:
# keys extraction fails with KEY_NOT_FOUND ("Weixin.exe not running") even though WeChat runs
# (2026-11-07 A/B: same exe works from %TEMP%, fails from this tree). Same fix as
# fix-dev-integrity.ps1; installed builds are unaffected (install dir is Medium).
& icacls $binDir /setintegritylevel '(OI)(CI)Medium' /T | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Warning "icacls Medium IL failed - standalone smoke from this tree will hit KEY_NOT_FOUND"
}

function Get-DirMb([string]$p) {
    $sum = (Get-ChildItem $p -Recurse -File | Measure-Object Length -Sum).Sum
    return ('{0:N1} MB' -f ($sum / 1MB))
}
Write-Host "OK exe     : $dstExe  ($(Get-DirMb $dstExe))"
Write-Host "OK internal: $dstInternal  ($(Get-DirMb $dstInternal))"
$label = (& icacls $dstExe | Select-String 'Mandatory Label') -join ''
Write-Host "OK il      : $($label.Trim())"
Write-Host "next: standalone product smoke (ping/scan_accounts), then pnpm tauri build"
exit 0
