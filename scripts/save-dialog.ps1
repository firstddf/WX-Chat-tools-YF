# 原生「另存为」对话框自动化（docs/07 #5）：等待 #32770 → 递归找文件名 Edit →
# WM_SETTEXT 写入完整路径 → BM_CLICK「保存」按钮 → 等对话框关闭。
# 实测结构（Win11 另存为，2026-11-10 探测）：
#   #32770 > DUIViewWndClassName > DirectUIHWND > FloatNotifySink > ComboBox > Edit（文件名）
#   #32770 > Button「保存(&S)」
# 用法：pwsh -File scripts/save-dialog.ps1 -Path "D:\...\export.json" [-TimeoutSec 25]
#       pwsh -File scripts/save-dialog.ps1 -Kill   （关闭残留的 #32770，跑前清场用）
# 退出码：0=对话框已关闭；1=未找到/未关闭（调用方据此断言）。
param(
  [string]$Path = '',
  [switch]$Kill,
  [int]$TimeoutSec = 25
)
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class SaveDlg {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr FindWindowEx(IntPtr hWndParent, IntPtr hWndAfter, string lpszClass, string lpszWindow);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, string lParam);
    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    // 前台锁定绕过：把本线程输入挂到对话框线程 → SetForegroundWindow 必成 → 摘钩。
    // （后台进程直接 SetForegroundWindow 会被 Windows 静默拒绝 → SendKeys 打空，
    //   2026-11-10 实测踩坑）
    public static bool ForceForeground(IntPtr h) {
        uint dlgT = GetWindowThreadProcessId(h, IntPtr.Zero);
        uint self = GetCurrentThreadId();
        if (dlgT == self) return SetForegroundWindow(h);
        AttachThreadInput(self, dlgT, true);
        bool ok = SetForegroundWindow(h);
        AttachThreadInput(self, dlgT, false);
        return ok;
    }

    static string Cls(IntPtr h) { var b = new StringBuilder(128); GetClassName(h, b, 128); return b.ToString(); }
    static string Title(IntPtr h) { var b = new StringBuilder(256); GetWindowText(h, b, 256); return b.ToString(); }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);

    // DFS 找指定类名的后代窗口（depth 限深）
    public static IntPtr FindDescendant(IntPtr root, string cls, int maxDepth) {
        IntPtr child = IntPtr.Zero;
        while (true) {
            child = FindWindowEx(root, child, null, null);
            if (child == IntPtr.Zero) return IntPtr.Zero;
            if (string.Equals(Cls(child), cls, StringComparison.OrdinalIgnoreCase)) return child;
            if (maxDepth > 0) {
                var r = FindDescendant(child, cls, maxDepth - 1);
                if (r != IntPtr.Zero) return r;
            }
        }
    }

    // 遍历桌面子窗口找可见 #32770（勿用 FindWindow：PowerShell 会把 $null 转成空串，
    // lpWindowName="" 只匹配空标题 → 实测永远找不到「另存为」，2026-11-10 踩坑）
    public static IntPtr FindVisibleDialog() {
        IntPtr child = IntPtr.Zero;
        while (true) {
            child = FindWindowEx(GetDesktopWindow(), child, null, null);
            if (child == IntPtr.Zero) return IntPtr.Zero;
            if (string.Equals(Cls(child), "#32770", StringComparison.Ordinal) && IsWindowVisible(child))
                return child;
        }
    }

    // DFS 找标题含指定子串的 Button
    public static IntPtr FindButton(IntPtr root, string needle, int maxDepth) {
        IntPtr child = IntPtr.Zero;
        while (true) {
            child = FindWindowEx(root, child, null, null);
            if (child == IntPtr.Zero) return IntPtr.Zero;
            if (string.Equals(Cls(child), "Button", StringComparison.OrdinalIgnoreCase) &&
                Title(child).IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) return child;
            if (maxDepth > 0) {
                var r = FindButton(child, needle, maxDepth - 1);
                if (r != IntPtr.Zero) return r;
            }
        }
    }
}
"@

# 1) 等对话框出现且可见（FindWindowEx 遍历，见 FindVisibleDialog 注释）
#    -Kill 清场模式只等 3s（没残留就该立刻退），正常保存等 -TimeoutSec
$waitSec = if ($Kill) { [Math]::Min(3, $TimeoutSec) } else { $TimeoutSec }
$deadline = (Get-Date).AddSeconds($waitSec)
$dlg = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
    $dlg = [SaveDlg]::FindVisibleDialog()
    if ($dlg -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 200
}
if ($dlg -eq [IntPtr]::Zero) {
    if ($Kill) { Write-Host 'NO DIALOG'; exit 0 }   # 清场：没有残留也算成功
    Write-Host 'save dialog not found'; exit 1
}

if ($Kill) {
    # 清场：逐个 WM_CLOSE 关掉**所有**残留 #32770（堆叠会互相吞注入，必须全清）
    for ($i = 0; $i -lt 10; $i++) {
        $one = [SaveDlg]::FindVisibleDialog()
        if ($one -eq [IntPtr]::Zero) { break }
        [void][SaveDlg]::SendMessage($one, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)   # WM_CLOSE
        Start-Sleep -Milliseconds 300
    }
    $left = [SaveDlg]::FindVisibleDialog()
    Write-Host ($(if ($left -eq [IntPtr]::Zero) { 'KILLED' } else { 'KILL FAILED' }))
    exit ($(if ($left -eq [IntPtr]::Zero) { 0 } else { 1 }))
}
if ($Path -eq '') { Write-Host 'missing -Path'; exit 1 }

# 2) 注入路径：WM_SETTEXT 到文件名 Edit + BM_CLICK 保存按钮。
#    窗口消息不需要前台焦点（2026-11-10 受控实验：setfg=False 仍 settext=1 → 对话框关、
#    文件落盘）；SendKeys 方案因 Windows 前台锁定打空，已弃用。
$edit = [SaveDlg]::FindDescendant($dlg, 'Edit', 5)
if ($edit -eq [IntPtr]::Zero) { Write-Host 'filename Edit not found'; exit 1 }
$r = [SaveDlg]::SendMessage($edit, 0x000C, [IntPtr]::Zero, $Path)   # WM_SETTEXT
Start-Sleep -Milliseconds 300
$btn = [SaveDlg]::FindButton($dlg, '保存', 5)
if ($btn -eq [IntPtr]::Zero) { $btn = [SaveDlg]::FindButton($dlg, 'Save', 5) }
if ($btn -eq [IntPtr]::Zero) { Write-Host 'save button not found'; exit 1 }
[void][SaveDlg]::SendMessage($btn, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)   # BM_CLICK
Write-Host ("settext={0} btn={1}" -f $r, $btn)

# 4) 等对话框关闭（写盘 1.4MB 稍等；超时判失败）
$closeDeadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $closeDeadline) {
    if ([SaveDlg]::FindVisibleDialog() -eq [IntPtr]::Zero) {
        Write-Host 'DIALOG CLOSED'
        exit 0
    }
    Start-Sleep -Milliseconds 300
}
Write-Host 'dialog still open after save click'
exit 1
