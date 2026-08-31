# Nexus global stop-key watcher (Windows only).
#
# Registers a global hotkey (Ctrl+Shift+X by default) and, on activation,
# POSTs to this server's /api/computer/stop endpoint. That endpoint kills any
# in-flight computer_input batch and closes the active turn's SSE stream —
# the two things the Stop button cannot do (the button can't reach a runaway
# mouse/keyboard batch, and it needs browser focus anyway).
#
# Spawned fire-and-forget by computerTools.ts::ensureStopKeyWatcher(), which
# also writes/kills the pidfile so a stale watcher from a previous server
# process never blocks a new one from registering the hotkey.
#
# Hotkey constants: MOD_CONTROL=0x0002, MOD_SHIFT=0x0004 (sum 0x0006), VK_X=0x58.

param(
  [int]$Port = 3000,
  [string]$PidFile = '',
  [int]$HotkeyMods = 0x0006,
  [int]$HotkeyVk = 0x58
)

# NOTE (2026-08-31): this used to fail 100% silently. Add-Type -TypeDefinition
# compiles the inline C# below in its own compiler context, which does NOT
# automatically see assemblies loaded moments earlier via
# `Add-Type -AssemblyName System.Windows.Forms` — that call only loads the
# assembly into the PowerShell session for direct PS use (New-Object etc.), it
# does not add a compiler reference for a separate -TypeDefinition compile.
# Without -ReferencedAssemblies below, the compile fails ("type 'Forms' does
# not exist in namespace 'System.Windows'"), $ErrorActionPreference swallowed
# it, and the script fell through to `Application.Run($form)` on a form with
# no hotkey ever registered — alive in the process list forever, doing
# nothing. Confirmed by direct reproduction, not inferred.
$ErrorActionPreference = 'SilentlyContinue'
$errorLog = if ($PidFile) { Join-Path (Split-Path $PidFile -Parent) 'stopkey.error.log' } else { '' }
function Write-StopkeyError([string]$msg) {
  if ($errorLog) { try { "$(Get-Date -Format o) $msg" | Out-File -FilePath $errorLog -Encoding utf8 -Append } catch {} }
}

# Self-healing pidfile: the server kills the PID found here before spawning a
# replacement, so a lingering watcher never holds the hotkey hostage.
if ($PidFile) {
  try { Set-Content -Path $PidFile -Value $PID -Force -ErrorAction SilentlyContinue } catch {}
}

try {

Add-Type -AssemblyName System.Windows.Forms

$sig = @'
using System;
using System.Runtime.InteropServices;
public class NxHotkey : System.Windows.Forms.NativeWindow, System.IDisposable {
  [DllImport("user32.dll", SetLastError=true)] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  public event Action HotkeyPressed;
  private int id;
  public bool Register(IntPtr handle, int hotkeyId, uint fsModifiers, uint vk) {
    id = hotkeyId;
    AssignHandle(handle);
    return RegisterHotKey(Handle, id, fsModifiers, vk);
  }
  protected override void WndProc(ref System.Windows.Forms.Message m) {
    if (m.Msg == 0x0312 && (int)m.WParam == id) {
      if (HotkeyPressed != null) HotkeyPressed();
    }
    base.WndProc(ref m);
  }
  public void Dispose() {
    UnregisterHotKey(Handle, id);
    ReleaseHandle();
  }
}
'@
Add-Type -TypeDefinition $sig -ReferencedAssemblies 'System.Windows.Forms.dll'

$form = New-Object System.Windows.Forms.Form
$hot  = New-Object NxHotkey
$registered = $hot.Register($form.Handle, 1, [uint32]$HotkeyMods, [uint32]$HotkeyVk)
if (-not $registered) {
  $lastErr = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  Write-StopkeyError "RegisterHotKey failed, Win32 error $lastErr (1409 = hotkey already claimed by another app)"
}

} catch {
  Write-StopkeyError "setup exception: $($_.Exception.Message)"
}

$uri = "http://127.0.0.1:$Port/api/computer/stop"

# $hot can be $null if the try block above threw before `New-Object NxHotkey`
# succeeded (e.g. the type never compiled for some other reason on some
# machine). Without this guard that case was a second silent-death path:
# calling .add_HotkeyPressed() on $null under SilentlyContinue does nothing
# visible, and the script still reaches Application.Run() below - so the
# watcher looks alive in the process list while unable to ever fire.
if ($hot) {
  $hot.add_HotkeyPressed({
    try {
      Invoke-RestMethod -Uri $uri -Method Post -TimeoutSec 5 | Out-Null
    } catch {}
  })
} else {
  Write-StopkeyError "hotkey object never constructed; watcher running but hotkey inert"
}

# Block forever on a message loop. The hidden form is never shown and never
# closed, so this runs until the watcher process is killed.
[System.Windows.Forms.Application]::Run($form)
