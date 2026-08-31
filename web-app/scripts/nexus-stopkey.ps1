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

$ErrorActionPreference = 'SilentlyContinue'

# Self-healing pidfile: the server kills the PID found here before spawning a
# replacement, so a lingering watcher never holds the hotkey hostage.
if ($PidFile) {
  try { Set-Content -Path $PidFile -Value $PID -Force -ErrorAction SilentlyContinue } catch {}
}

Add-Type -AssemblyName System.Windows.Forms

$sig = @'
using System;
using System.Runtime.InteropServices;
public class NxHotkey : System.Windows.Forms.NativeWindow, System.IDisposable {
  [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
  [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  public event Action HotkeyPressed;
  private int id;
  public void Register(IntPtr handle, int hotkeyId, uint fsModifiers, uint vk) {
    id = hotkeyId;
    AssignHandle(handle);
    RegisterHotKey(Handle, id, fsModifiers, vk);
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
Add-Type -TypeDefinition $sig

$form = New-Object System.Windows.Forms.Form
$hot  = New-Object NxHotkey
$hot.Register($form.Handle, 1, [uint32]$HotkeyMods, [uint32]$HotkeyVk)

$uri = "http://127.0.0.1:$Port/api/computer/stop"

$hot.add_HotkeyPressed({
  try {
    Invoke-RestMethod -Uri $uri -Method Post -TimeoutSec 5 | Out-Null
  } catch {}
})

# Block forever on a message loop. The hidden form is never shown and never
# closed, so this runs until the watcher process is killed.
[System.Windows.Forms.Application]::Run($form)
