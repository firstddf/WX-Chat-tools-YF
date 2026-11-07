# M-A2 acceptance / pre-packaging gate (docs/04):
#   sidecar contract (14) + Tk baseline (91) + frontend vitest + typecheck + Playwright layout.
# Usage: Set-ExecutionPolicy -Scope Process Bypass -Force; & scripts/verify.ps1
# Convention (2026-11-06): run ALL functional checks first; package ONCE at the
# end (M-A4). Never package-and-test repeatedly. Must be green before packaging.
# Requires: python, node/pnpm on PATH. ASCII-only (PowerShell 5.1 encoding pitfalls).
$ErrorActionPreference = 'Continue'
$tauri = Split-Path -Parent $PSScriptRoot                       # wxchart-tauri
$tool = Join-Path (Split-Path -Parent $tauri) 'wxchart-tool'    # read-only reference

$failed = @()

function Run-Step($name, $cmd) {
    Write-Host ">>> $name"
    & $cmd
    if ($LASTEXITCODE -ne 0) { $script:failed += $name }
}

# --- Python sidecar contract + full Tk baseline (91) ---
$pyTargets = @(
    (Join-Path $tauri 'sidecar\tests\test_contract.py'),
    (Join-Path $tool 'tests\test_guidata.py'),
    (Join-Path $tool 'tests\test_exporter.py'),
    (Join-Path $tool 'tests\test_filter_page.py'),
    (Join-Path $tool 'tests\test_chatview.py'),
    (Join-Path $tool 'tests\test_gui_smoke.py'),
    (Join-Path $tool 'tests\test_datepicker.py')
)
foreach ($t in $pyTargets) { Run-Step $t { python $t } }

# --- Frontend: typecheck + vitest + Playwright layout (browser mock, docs/02 6) ---
Push-Location $tauri
Run-Step 'pnpm typecheck' { pnpm typecheck }
Run-Step 'pnpm test (vitest)' { pnpm test }
Run-Step 'pnpm test:e2e (playwright)' { pnpm test:e2e }
Pop-Location

if ($failed.Count -gt 0) {
    Write-Host "FAILED ($($failed.Count)):"
    $failed | ForEach-Object { Write-Host "  $_" }
    exit 1
}
Write-Host 'ALL GREEN (sidecar contract + Tk baseline 91 + typecheck + vitest + playwright)'
exit 0
