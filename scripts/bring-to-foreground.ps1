param([string]$Needle)

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WurstE2EWin32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@

$procs = Get-CimInstance Win32_Process -Filter "name = 'Code.exe'" | Where-Object { $_.CommandLine -like "*$Needle*" }
foreach ($p in $procs) {
    $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if ($gp -and $gp.MainWindowHandle -ne [IntPtr]::Zero) {
        [WurstE2EWin32]::ShowWindow($gp.MainWindowHandle, 9) | Out-Null
        $ok = [WurstE2EWin32]::SetForegroundWindow($gp.MainWindowHandle)
        Write-Output "pid=$($p.ProcessId) hwnd=$($gp.MainWindowHandle) setForeground=$ok"
    }
}
