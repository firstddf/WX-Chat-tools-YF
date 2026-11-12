# 开发期修复：把 Tauri 构建产物的完整性级别（IL）恢复为 Medium。
#
# 背景（2026-11-07 定位，docs/05）：本工作区被 DSH 文件沙箱打上
# "Low Mandatory Level" 强制完整性标签（工作区根目录 `(OI)(CI)(NW)`），
# 于是 cargo 在 target/ 下新生成的 wxchart-tauri.exe 继承 Low IL。
# Low IL 的宿主进程调用 WebView2 会在 CreateCoreWebView2Environment 阶段失败：
#   - 全新 profile：`WebView2 error: WindowsError(0x8000FFFF 灾难性故障)`；
#   - 已有 profile：`0x800700AA 请求的资源在使用中`；或窗口起来但 setup 永不执行。
# 同一个 exe 复制到工作区外（两个测试目录，路径已隐去）即可正常运行 → 排除运行时/GPU/权限因素。
# 修复只需把 target 树的 IL 显式设为 Medium（Windows 默认级别），不需要改 DACL。
#
# 何时需要跑：`pnpm tauri dev` / 直接运行 target\debug\wxchart-tauri.exe 出现
#   "failed to create webview: WebView2 error" 时。
# 用法：Set-ExecutionPolicy -Scope Process Bypass -Force; & scripts\fix-dev-integrity.ps1
# 依赖：当前会话对本工作区有写权限（DSH danger-full-access 或普通终端）。
#       DSH 沙箱会话/重装工作区后若标签再次变 Low，重跑本脚本即可。
$ErrorActionPreference = 'Stop'

$tauri = Split-Path -Parent $PSScriptRoot            # wxchart-tauri
$targets = @(
    (Join-Path $tauri 'src-tauri\target'),
    (Join-Path $tauri 'src-tauri\target\debug'),
    (Join-Path $tauri 'src-tauri\target\release')
)

$fixed = 0
foreach ($t in $targets) {
    if (-not (Test-Path $t)) { continue }
    # 2026-11-09：已是 Medium（显式或继承）就跳过重写——本工作区由转移包解压而来，
    # 目录 ACL 只有 Modify 没有 WRITE_OWNER，/setintegritylevel 会逐目录 Access denied
    # （全树上千对象，逐个授权不可行）；而脚本的目标状态就是「Medium IL」，
    # 状态已满足时重写是冗余动作。仍有 Low 标签时照旧 /T 重写（原语义不变）。
    $label = (& icacls $t | Select-String 'Mandatory Label') -join ''
    if ($label -match 'Medium Mandatory Level') {
        Write-Host ">>> 已是 Medium IL（跳过重写）: $t"
        $fixed++
        continue
    }
    Write-Host ">>> 设置 Medium IL: $t"
    # (OI)(CI) 让后续 cargo 新建的文件/子目录继承 Medium，而不是工作区根的 Low
    & icacls $t /setintegritylevel '(OI)(CI)Medium' /T | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "icacls 失败: $t" }
    $fixed++
}
if ($fixed -eq 0) { Write-Host '没有找到 target 目录（先 cargo build / pnpm tauri dev 一次）'; exit 1 }

# 校验：构建产物（如有）的强制标签应为 Medium
$exe = Join-Path $tauri 'src-tauri\target\debug\wxchart-tauri.exe'
if (Test-Path $exe) {
    $label = (& icacls $exe | Select-String 'Mandatory Label') -join ''
    Write-Host ">>> $exe"
    Write-Host "    $($label.Trim())"
    if ($label -match 'Low Mandatory Level') {
        Write-Host '!! 仍是 Low IL：请以有写权限的终端重跑本脚本（或确认没有沙箱重新打标）'
        exit 1
    }
}
Write-Host "OK：$fixed 个 target 目录已设为 Medium IL；现在可以 pnpm tauri dev / 直接运行 exe。"
exit 0
