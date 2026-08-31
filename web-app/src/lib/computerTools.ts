// ─────────────────────────────────────────────────────────────────────────────
// OS-level computer control for NEXUS entities (Windows only).
//
// Browser control (browserTools.ts) drives a page through the accessibility
// tree — no vision model required, exact refs instead of coordinates. This is
// the other end of the spectrum: real mouse/keyboard input against the whole
// desktop, for anything that isn't a web page. It COSTS a vision-capable model
// (screenshots are images) and it CANNOT be exact the way a ref is — every
// action is a pixel coordinate the being read out of a picture. Both are kept;
// neither replaces the other.
//
// WHY POWERSHELL, NOT A NATIVE NODE MODULE.
// robotjs/nut.js are native addons tied to a specific Node ABI — exactly the
// fragility Nexus has avoided everywhere else (see audioServices.ts's
// IPolicyConfig COM shim, findSystemBrowser's plain env-var probing). Shelling
// out to powershell.exe with an embedded C# P/Invoke snippet needs nothing
// installed beyond Windows itself, and it's the same pattern already used for
// monitor enumeration, window arrangement, and default-audio-device switching.
//
// DPI AWARENESS IS THE WHOLE GAME.
// This machine runs mixed DPI: one monitor at 100%, one rotated at 100%, two at
// 150%. A process that hasn't declared itself per-monitor-DPI-aware gets
// Windows' compatibility shim quietly virtualizing every coordinate it reads or
// writes, which corrupts click positions in a way that "looks right" on a
// single-monitor 100% test machine and is wrong everywhere else. Every script
// below calls SetProcessDpiAwarenessContext (falling back to the older
// SetProcessDPIAware on pre-1703 Windows) as its literal first statement,
// before any Screen/Bitmap/cursor call. This is spawned as a FRESH process per
// call — DPI awareness cannot be set after any UI-related API has already run
// in that process — so it always executes first by construction.
//
// COORDINATES ARE ABSOLUTE VIRTUAL-DESKTOP PIXELS, ALWAYS.
// Not per-monitor-relative. A drag or a multi-step sequence can cross a
// monitor boundary, and per-monitor coordinates make that ambiguous (which
// monitor is (10, 10) on?). computer_screens reports each monitor's top-left
// in this same absolute system (which can be negative), and computer_screenshot
// states the captured monitor's offset so a being can add it to a pixel
// position it reads out of the image.
//
// VISIBLE FEEDBACK IS A REQUIREMENT, NOT A NICETY.
// The machine's owner explicitly asked to SEE every capture and every click as
// they happen, live, on the real screen — a thick red border flashes around
// the monitor being captured, a red circle flashes at every click. Both are
// drawn by a disposable, click-through, always-on-top WinForms window in a
// SEPARATE fire-and-forget process, so they can never delay or corrupt the
// actual action, and are best-effort by design: every flash call is wrapped so
// a failure to draw one is invisible to the being and never blocks real work.
// For the same reason the being's own screenshot is captured BEFORE the border
// flash fires — the pixels it sees are never marked up.
//
// TWO COPIES OF EVERY SCREENSHOT, FOR TWO DIFFERENT READERS.
// The being gets the clean capture, undecorated, because marks in the image
// would just be noise it has to reason around. A second, annotated copy — a
// red border plus a marker at every very-recent click that falls inside that
// monitor — is written to disk under `local_data/computer_control_logs/` for
// the human to audit later. Compositing that copy is plain `sharp` + an SVG
// overlay, not more PowerShell drawing code, because it's easier to get right
// and easier to change.
//
// LOGGING.
// Every call already surfaces in the Tool Usage Report (route.ts's normal
// `tool_call` SSE event, shared by every tool in Nexus) with its full
// arguments — that satisfies "show commands in the Nexus log" for free. A
// `console.log` line is added here too, for the case someone is watching the
// server console directly rather than the browser tab.
// ─────────────────────────────────────────────────────────────────────────────

import path from 'path';
import fsp from 'fs/promises';
import { spawn, execFile } from 'child_process';
import sharp from 'sharp';

const DATA_DIR = path.resolve(process.cwd(), '..', 'local_data');
const LOG_DIR = path.join(DATA_DIR, 'computer_control_logs');

export const COMPUTER_TOOL_NAMES = ['computer_screens', 'computer_screenshot', 'computer_input'] as const;

// ── Global stop key (Ctrl+Shift+X) ──────────────────────────────────────────
// A runaway computer_input batch is the one thing the Stop button cannot
// interrupt — it runs inside a PowerShell process that keeps executing mouse/
// keyboard commands for up to 30s even after the client aborts its fetch. So
// the stop key does two things the button can't: (1) kill that in-flight
// input process immediately, and (2) close the active turn's SSE stream so the
// client finalizes (and, with the finalize-on-abort fix, saves the billing and
// tool-usage it had accumulated). Both are reachable from a small global-hotkey
// watcher process that POSTs to /api/computer/stop — no browser focus required.

/** The in-flight computer_input PowerShell process, if any. Killed on stop. */
let activeInputChild: ReturnType<typeof execFile> | null = null;
/** Closes the active turn's SSE stream. Registered by each provider path. */
let activeTurnStop: (() => void) | null = null;
/** The global-hotkey watcher child process, so we start it at most once. */
let stopKeyWatcherChild: ReturnType<typeof spawn> | null = null;
/** Synchronous guard against two concurrent POSTs double-spawning the watcher. */
let watcherStartInFlight = false;

export function registerActiveTurnStop(stop: (() => void) | null): void {
  activeTurnStop = stop;
}

export function stopComputerSession(): { killedInput: boolean; stoppedTurn: boolean } {
  let killedInput = false;
  if (activeInputChild) {
    try { activeInputChild.kill(); killedInput = true; } catch { /* already gone */ }
    activeInputChild = null;
  }
  let stoppedTurn = false;
  if (activeTurnStop) {
    try { activeTurnStop(); stoppedTurn = true; } catch { /* stream already ended */ }
    activeTurnStop = null;
  }
  return { killedInput, stoppedTurn };
}

/** Start the global-hotkey watcher once, targeting this server's own port. */
export async function ensureStopKeyWatcher(port: number): Promise<void> {
  if (stopKeyWatcherChild && !stopKeyWatcherChild.killed) return;
  if (watcherStartInFlight) return;
  watcherStartInFlight = true;
  try {
    const pidFile = path.join(LOG_DIR, 'stopkey.pid');
    // Self-heal: a watcher spawned by a previous server process (before a
    // restart) still holds the hotkey. Kill it so the new one can register.
    try {
      const oldPid = parseInt((await fsp.readFile(pidFile, 'utf8')).trim(), 10);
      if (Number.isFinite(oldPid) && oldPid > 0 && oldPid !== process.pid) {
        try { process.kill(oldPid); } catch { /* already dead */ }
      }
    } catch { /* no pidfile yet */ }
    const scriptPath = path.resolve(process.cwd(), 'scripts', 'nexus-stopkey.ps1');
    try {
      stopKeyWatcherChild = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Port', String(port), '-PidFile', pidFile],
        { detached: false, stdio: 'ignore', windowsHide: true },
      );
      const child = stopKeyWatcherChild;
      child.on('error', () => { if (stopKeyWatcherChild === child) stopKeyWatcherChild = null; });
      child.on('exit', () => { if (stopKeyWatcherChild === child) stopKeyWatcherChild = null; });
    } catch {
      stopKeyWatcherChild = null;
    }
  } finally {
    watcherStartInFlight = false;
  }
}

export interface ComputerToolCtx {
  /** The entity making the call — used for the audit-log folder/filename. */
  me: string;
  /** Resolved (per-Entity overridable) instruction strings. */
  instructions?: Record<string, string>;
}

export interface ComputerToolResult {
  text: string;
  image?: { base64: string; mimeType: string };
}

export interface ComputerScreen {
  index: number;
  primary: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Best-effort per-monitor DPI scale (100 = 96 DPI). Falls back to 100. */
  scalePercent: number;
}

function safeName(entity: string): string {
  // Entity names are Japanese as often as not; keep them, drop only what
  // Windows refuses in a path component.
  return String(entity || 'Default').replace(/[\\/:*?"<>|]/g, '_').slice(0, 64) || 'Default';
}

function psQuote(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

interface PsRunResult { ok: boolean; stdout: string; error?: string; }

function runPS(script: string, timeoutMs: number, maxBuffer = 4 * 1024 * 1024, trackInput = false): Promise<PsRunResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer },
      (err, stdout, stderr) => {
        if (trackInput) activeInputChild = null;
        if (err) {
          resolve({ ok: false, stdout: String(stdout || ''), error: String(stderr || err.message || err).split('\n')[0].slice(0, 300) });
        } else {
          resolve({ ok: true, stdout: String(stdout || '').trim() });
        }
      },
    );
    if (trackInput) activeInputChild = child;
  });
}

// ── DPI awareness + on-screen flash overlay, shared by every script ─────────

const DPI_PREFIX = `
$dpiSig = @'
using System;
using System.Runtime.InteropServices;
public class NxDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
Add-Type -TypeDefinition $dpiSig -ErrorAction SilentlyContinue
$dpiOk = $false
try { $dpiOk = [NxDpi]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) } catch {}
if (-not $dpiOk) { try { [void][NxDpi]::SetProcessDPIAware() } catch {} }
`;

// A disposable, click-through, always-on-top borderless window that paints a
// red rectangle or circle outline and closes itself after Ms milliseconds.
// Entirely cosmetic — every call site wraps its use in try/catch so a failure
// here (a locked desktop, an RDP session with no visible GDI surface, ...)
// never touches real functionality.
const FLASH_HELPER = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ovSig = @'
using System;
using System.Runtime.InteropServices;
public class NxOv {
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
}
'@
Add-Type -TypeDefinition $ovSig -ErrorAction SilentlyContinue
function Show-Flash {
  param([int]$X, [int]$Y, [int]$W, [int]$H, [string]$Shape, [int]$Ms)
  try {
    $f = New-Object System.Windows.Forms.Form
    $f.FormBorderStyle = 'None'
    $f.ShowInTaskbar = $false
    $f.TopMost = $true
    $f.StartPosition = 'Manual'
    $f.Location = New-Object System.Drawing.Point($X, $Y)
    $f.Size = New-Object System.Drawing.Size([Math]::Max(1, $W), [Math]::Max(1, $H))
    $f.BackColor = [System.Drawing.Color]::Magenta
    $f.TransparencyKey = [System.Drawing.Color]::Magenta
    $shapeLocal = $Shape
    $formRef = $f
    $f.Add_Paint({
      param($s2, $e2)
      $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Red, 6)
      if ($shapeLocal -eq 'circle') {
        $e2.Graphics.DrawEllipse($pen, 3, 3, $formRef.Width - 6, $formRef.Height - 6)
      } else {
        $e2.Graphics.DrawRectangle($pen, 3, 3, $formRef.Width - 6, $formRef.Height - 6)
      }
      $pen.Dispose()
    })
    $f.Show()
    try {
      $ex = [NxOv]::GetWindowLong($f.Handle, -20)
      [void][NxOv]::SetWindowLong($f.Handle, -20, $ex -bor 0x80020 -bor 0x8)
    } catch {}
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $Ms) {
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 15
    }
    $f.Close()
    $f.Dispose()
  } catch {}
}
`;

/** Fire-and-forget: never awaited, never allowed to block or fail real work. */
function fireFlash(x: number, y: number, w: number, h: number, shape: 'rect' | 'circle', ms: number) {
  try {
    const script = DPI_PREFIX + FLASH_HELPER +
      `Show-Flash -X ${Math.trunc(x)} -Y ${Math.trunc(y)} -W ${Math.trunc(w)} -H ${Math.trunc(h)} -Shape '${shape}' -Ms ${Math.trunc(ms)}\n`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
  } catch { /* cosmetic only */ }
}

// ── monitor enumeration ──────────────────────────────────────────────────────

async function listComputerScreens(): Promise<ComputerScreen[]> {
  const script = DPI_PREFIX + `
Add-Type -AssemblyName System.Windows.Forms
$monSig = @'
using System;
using System.Runtime.InteropServices;
public class NxMon {
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
'@
Add-Type -TypeDefinition $monSig -ErrorAction SilentlyContinue
$i = 0
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  $cx = $_.Bounds.X + [int]($_.Bounds.Width / 2)
  $cy = $_.Bounds.Y + [int]($_.Bounds.Height / 2)
  $scale = 100
  try {
    $pt = New-Object NxMon+POINT
    $pt.X = $cx; $pt.Y = $cy
    $hmon = [NxMon]::MonitorFromPoint($pt, 2)
    $dx = [uint32]0; $dy = [uint32]0
    [void][NxMon]::GetDpiForMonitor($hmon, 0, [ref]$dx, [ref]$dy)
    if ($dx -gt 0) { $scale = [int][Math]::Round(($dx / 96.0) * 100) }
  } catch {}
  [PSCustomObject]@{
    index = $i; primary = [bool]$_.Primary
    x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height
    scalePercent = $scale
  }
  $i++
} | ConvertTo-Json -Compress
`.trim();
  const out = await runPS(script, 15000);
  if (!out.ok || !out.stdout) return [];
  try {
    const parsed = JSON.parse(out.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

// ── recent-click ring buffer (for the human audit copy only) ────────────────
// Held on globalThis for the same reason browserTools.ts holds its session map
// there — Next.js hot-reload re-evaluates this module, and a plain module-level
// array would silently reset on every edit during development.

interface ClickRecord { x: number; y: number; t: number; }
const g = globalThis as any;
const clickLog: ClickRecord[] = (g.__nexusComputerClicks ||= []);

function recordClick(x: number, y: number) {
  clickLog.push({ x, y, t: Date.now() });
  while (clickLog.length > 40) clickLog.shift();
}

function recentClicksIn(mx: number, my: number, mw: number, mh: number, withinMs: number): ClickRecord[] {
  const now = Date.now();
  return clickLog.filter((c) => now - c.t <= withinMs && c.x >= mx && c.x < mx + mw && c.y >= my && c.y < my + mh);
}

async function saveAuditScreenshot(entity: string, idx: number, mon: ComputerScreen, png: Buffer): Promise<void> {
  const dir = path.join(LOG_DIR, safeName(entity));
  await fsp.mkdir(dir, { recursive: true });
  const clicks = recentClicksIn(mon.x, mon.y, mon.width, mon.height, 120000);
  const parts: string[] = [
    `<rect x="3" y="3" width="${Math.max(1, mon.width - 6)}" height="${Math.max(1, mon.height - 6)}" fill="none" stroke="red" stroke-width="6"/>`,
  ];
  for (const c of clicks) {
    const lx = c.x - mon.x;
    const ly = c.y - mon.y;
    parts.push(`<circle cx="${lx}" cy="${ly}" r="16" fill="none" stroke="red" stroke-width="4"/>`);
    const tx = Math.min(lx + 20, Math.max(0, mon.width - 90));
    parts.push(`<text x="${tx}" y="${ly + 5}" fill="red" font-size="13" font-family="monospace">${c.x},${c.y}</text>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${mon.width}" height="${mon.height}">${parts.join('')}</svg>`;
  let out = png;
  try {
    out = await sharp(png).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
  } catch {
    // Compositing failed (bad SVG, exotic pixel format, ...) — save the plain
    // capture rather than lose the audit record entirely.
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `${safeName(entity)}_${stamp}_monitor${idx}.png`;
  await fsp.writeFile(path.join(dir, file), out);
}

// ── key-name → virtual-key-code table ────────────────────────────────────────
// Resolved on the TS side rather than inside PowerShell so an unrecognized key
// name is reported back to the being as a normal tool error instead of a
// silently-ignored no-op deep inside a spawned process.

const KEY_ALIASES: Record<string, number> = {
  backspace: 0x08, tab: 0x09, enter: 0x0d, return: 0x0d,
  shift: 0x10, ctrl: 0x11, control: 0x11, alt: 0x12, menu: 0x12,
  pause: 0x13, capslock: 0x14, capital: 0x14,
  escape: 0x1b, esc: 0x1b,
  space: 0x20, pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22, pgdown: 0x22,
  end: 0x23, home: 0x24,
  left: 0x25, arrowleft: 0x25, up: 0x26, arrowup: 0x26,
  right: 0x27, arrowright: 0x27, down: 0x28, arrowdown: 0x28,
  printscreen: 0x2c, insert: 0x2d, ins: 0x2d, delete: 0x2e, del: 0x2e,
  win: 0x5b, meta: 0x5b, cmd: 0x5b, super: 0x5b, lwin: 0x5b, rwin: 0x5c,
  numlock: 0x90, scrolllock: 0x91,
  ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf, '`': 0xc0,
  '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde,
};
for (let i = 1; i <= 24; i++) KEY_ALIASES[`f${i}`] = 0x6f + i; // F1 = 0x70 ... F24 = 0x87
for (let i = 0; i <= 9; i++) KEY_ALIASES[`numpad${i}`] = 0x60 + i;

function resolveVk(key: string): number | null {
  const raw = String(key || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower in KEY_ALIASES) return KEY_ALIASES[lower];
  if (raw.length === 1) {
    const c = raw.toUpperCase().charCodeAt(0);
    if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a)) return c; // digits/letters == ASCII == VK
  }
  return null;
}

function buttonCode(b?: string): number {
  const s = String(b || 'left').toLowerCase();
  if (s === 'right') return 1;
  if (s === 'middle') return 2;
  return 0;
}

// ── computer_input command resolution + execution ───────────────────────────

type ResolvedType = 'move' | 'down' | 'up' | 'click' | 'wheel' | 'keydown' | 'keyup' | 'keypress' | 'text' | 'idle';
interface ResolvedCommand { t: ResolvedType; x?: number; y?: number; btn?: number; vk?: number; s?: string; ms?: number; delta?: number; }

const MAX_COMMANDS = 200;
const MAX_IDLE_MS = 15000;
const MAX_TEXT_LEN = 4000;

function resolveCommands(raw: any[]): { resolved: ResolvedCommand[]; errors: string[] } {
  const capped = raw.slice(0, MAX_COMMANDS);
  const errors: string[] = [];
  if (raw.length > MAX_COMMANDS) errors.push(`only the first ${MAX_COMMANDS} of ${raw.length} commands were run`);
  const resolved: ResolvedCommand[] = [];
  capped.forEach((c0, i) => {
    const c = c0 && typeof c0 === 'object' ? c0 : {};
    const type = String(c.type || '').toLowerCase();
    const x = Number.isFinite(c.x) ? Math.trunc(c.x) : undefined;
    const y = Number.isFinite(c.y) ? Math.trunc(c.y) : undefined;
    switch (type) {
      case 'mouse_move':
        if (x === undefined || y === undefined) { errors.push(`#${i} mouse_move needs numeric x and y`); return; }
        resolved.push({ t: 'move', x, y });
        return;
      case 'mouse_down':
        resolved.push({ t: 'down', btn: buttonCode(c.button), x, y });
        return;
      case 'mouse_up':
        resolved.push({ t: 'up', btn: buttonCode(c.button), x, y });
        return;
      case 'mouse_click':
        resolved.push({ t: 'click', btn: buttonCode(c.button), x, y });
        return;
      case 'mouse_wheel':
        if (!Number.isFinite(c.delta)) { errors.push(`#${i} mouse_wheel needs a numeric "delta" (positive = up/away, negative = down; one notch ≈ 120)`); return; }
        resolved.push({ t: 'wheel', delta: Math.trunc(c.delta), x, y });
        return;
      case 'key_down':
      case 'key_up':
      case 'key_press': {
        const vk = resolveVk(c.key);
        if (vk == null) { errors.push(`#${i} unrecognized key "${c.key}"`); return; }
        resolved.push({ t: type === 'key_down' ? 'keydown' : type === 'key_up' ? 'keyup' : 'keypress', vk });
        return;
      }
      case 'type_text':
        if (typeof c.text !== 'string' || !c.text.length) { errors.push(`#${i} type_text needs a non-empty "text"`); return; }
        resolved.push({ t: 'text', s: c.text.slice(0, MAX_TEXT_LEN) });
        return;
      case 'idle': {
        const ms = Math.max(0, Math.min(MAX_IDLE_MS, Number.isFinite(c.ms) ? Math.trunc(c.ms) : 0));
        resolved.push({ t: 'idle', ms });
        return;
      }
      default:
        errors.push(`#${i} unknown command type "${c.type}"`);
    }
  });
  return { resolved, errors };
}

const INPUT_HELPER = `
$inSig = @'
using System;
using System.Runtime.InteropServices;
public class NxInput {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  const uint KEYEVENTF_KEYUP = 0x0002;
  const uint KEYEVENTF_UNICODE = 0x0004;
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] p, int cb);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  public static void SendMouseButton(int btn, bool down) {
    uint flag;
    if (btn == 1) { flag = down ? 0x0008u : 0x0010u; }
    else if (btn == 2) { flag = down ? 0x0020u : 0x0040u; }
    else { flag = down ? 0x0002u : 0x0004u; }
    var inp = new INPUT();
    inp.type = 0;
    inp.u.mi = new MOUSEINPUT();
    inp.u.mi.dwFlags = flag;
    SendInput(1, new INPUT[] { inp }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void SendMouseWheel(int delta) {
    var inp = new INPUT();
    inp.type = 0;
    inp.u.mi = new MOUSEINPUT();
    inp.u.mi.mouseData = (uint)delta;
    inp.u.mi.dwFlags = 0x0800; // MOUSEEVENTF_WHEEL
    SendInput(1, new INPUT[] { inp }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void SendKey(ushort vk, bool down) {
    var inp = new INPUT();
    inp.type = 1;
    inp.u.ki = new KEYBDINPUT();
    inp.u.ki.wVk = vk;
    inp.u.ki.dwFlags = down ? 0u : KEYEVENTF_KEYUP;
    SendInput(1, new INPUT[] { inp }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void SendUnicodeChar(ushort ch, bool down) {
    var inp = new INPUT();
    inp.type = 1;
    inp.u.ki = new KEYBDINPUT();
    inp.u.ki.wVk = 0;
    inp.u.ki.wScan = ch;
    inp.u.ki.dwFlags = KEYEVENTF_UNICODE | (down ? 0u : KEYEVENTF_KEYUP);
    SendInput(1, new INPUT[] { inp }, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
Add-Type -TypeDefinition $inSig -ErrorAction SilentlyContinue
`;

function buildInputScript(cmds: ResolvedCommand[]): string {
  const json = JSON.stringify(cmds);
  return DPI_PREFIX + INPUT_HELPER + FLASH_HELPER + `
$cmds = ${psQuote(json)} | ConvertFrom-Json
$results = New-Object System.Collections.ArrayList
foreach ($c in $cmds) {
  try {
    switch ($c.t) {
      'move' { [void][NxInput]::SetCursorPos([int]$c.x, [int]$c.y) }
      'down' {
        if ($null -ne $c.x) { [void][NxInput]::SetCursorPos([int]$c.x, [int]$c.y) }
        [NxInput]::SendMouseButton([int]$c.btn, $true)
        if ($null -ne $c.x) { Show-Flash -X ([int]$c.x - 25) -Y ([int]$c.y - 25) -W 50 -H 50 -Shape 'circle' -Ms 250 }
      }
      'up' {
        if ($null -ne $c.x) { [void][NxInput]::SetCursorPos([int]$c.x, [int]$c.y) }
        [NxInput]::SendMouseButton([int]$c.btn, $false)
      }
      'click' {
        if ($null -ne $c.x) { [void][NxInput]::SetCursorPos([int]$c.x, [int]$c.y) }
        $p = New-Object NxInput+POINT
        [void][NxInput]::GetCursorPos([ref]$p)
        Show-Flash -X ($p.X - 25) -Y ($p.Y - 25) -W 50 -H 50 -Shape 'circle' -Ms 250
        [NxInput]::SendMouseButton([int]$c.btn, $true)
        Start-Sleep -Milliseconds 40
        [NxInput]::SendMouseButton([int]$c.btn, $false)
      }
      'wheel' {
        if ($null -ne $c.x) { [void][NxInput]::SetCursorPos([int]$c.x, [int]$c.y) }
        [NxInput]::SendMouseWheel([int]$c.delta)
      }
      'keydown' { [NxInput]::SendKey([uint16]$c.vk, $true) }
      'keyup' { [NxInput]::SendKey([uint16]$c.vk, $false) }
      'keypress' { [NxInput]::SendKey([uint16]$c.vk, $true); Start-Sleep -Milliseconds 20; [NxInput]::SendKey([uint16]$c.vk, $false) }
      'text' {
        foreach ($ch in $c.s.ToCharArray()) {
          [NxInput]::SendUnicodeChar([uint16][int]$ch, $true)
          [NxInput]::SendUnicodeChar([uint16][int]$ch, $false)
          Start-Sleep -Milliseconds 8
        }
      }
      'idle' { Start-Sleep -Milliseconds ([int]$c.ms) }
    }
    [void]$results.Add(@{ t = $c.t; ok = $true })
  } catch {
    [void]$results.Add(@{ t = $c.t; ok = $false; error = $_.Exception.Message })
  }
}
$results | ConvertTo-Json -Compress
`.trim();
}

// ── tool schemas ─────────────────────────────────────────────────────────────
// Declared once, provider-neutral, reshaped at each of the three JSON-schema
// call sites — same split as browserTools.ts. The OAuth path builds its own
// with zod at the route.ts call site because the SDK requires it.

interface ComputerToolProp { type: 'string' | 'boolean' | 'integer' | 'array' | 'object'; description: string; }
interface ComputerToolSpec { name: string; description: string; properties: Record<string, ComputerToolProp>; required: string[]; }

export function computerToolSpecs(I: Record<string, string>): ComputerToolSpec[] {
  return [
    {
      name: 'computer_screens',
      description: I.toolComputerScreensDesc,
      properties: {},
      required: [],
    },
    {
      name: 'computer_screenshot',
      description: I.toolComputerScreenshotDesc,
      properties: { screen_index: { type: 'integer', description: I.computerScreenshotIndexParam } },
      required: ['screen_index'],
    },
    {
      name: 'computer_input',
      description: I.toolComputerInputDesc,
      properties: { commands: { type: 'array', description: I.computerInputCommandsParam } },
      required: ['commands'],
    },
  ];
}

/** Claude API shape. */
export function computerToolsClaude(I: Record<string, string>) {
  return computerToolSpecs(I).map((s) => ({
    name: s.name,
    description: s.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(s.properties).map(([k, v]) => [
          k,
          v.type === 'array' ? { type: 'array', description: v.description, items: { type: 'object' } } : { type: v.type, description: v.description },
        ]),
      ),
      ...(s.required.length ? { required: s.required } : {}),
    },
  }));
}

/** OpenAI-compatible shape (GLM, Kimi, DeepSeek, Qwen, ChatGPT, MiMo, …). */
export function computerToolsOpenAI(I: Record<string, string>) {
  return computerToolSpecs(I).map((s) => ({
    type: 'function' as const,
    function: {
      name: s.name,
      description: s.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(s.properties).map(([k, v]) => [
            k,
            v.type === 'array' ? { type: 'array', description: v.description, items: { type: 'object' } } : { type: v.type, description: v.description },
          ]),
        ),
        ...(s.required.length ? { required: s.required } : {}),
      },
    },
  }));
}

/**
 * Gemini shape. Types are UPPERCASE, and a tool with no parameters (or an
 * array-of-objects parameter) still needs a fully-specified `properties` node
 * — Gemini rejects a bare `{}` inside an ARRAY's `items`, and worse, rejects
 * the whole tools array with it, taking every other tool down too.
 */
export function computerToolsGemini(I: Record<string, string>) {
  return computerToolSpecs(I).map((s) => ({
    name: s.name,
    description: s.description,
    parameters: {
      type: 'OBJECT',
      properties: Object.fromEntries(
        Object.entries(s.properties).map(([k, v]) => [
          k,
          v.type === 'array'
            ? { type: 'ARRAY', description: v.description, items: { type: 'OBJECT', properties: {} } }
            : { type: v.type.toUpperCase(), description: v.description },
        ]),
      ),
      ...(s.required.length ? { required: s.required } : {}),
    },
  }));
}

// ── executor ──────────────────────────────────────────────────────────────
// One executor, thin call sites, same discipline as runBrowserTool: a fix can
// never land on three provider paths out of four.

export async function runComputerTool(name: string, args: any, ctx: ComputerToolCtx): Promise<ComputerToolResult> {
  try {
    switch (name) {
      case 'computer_screens': {
        const screens = await listComputerScreens();
        if (!screens.length) return { text: 'Error: could not enumerate monitors (this feature is Windows-only).' };
        const lines = screens.map(
          (s) => `  [${s.index}]${s.primary ? ' (primary)' : ''} ${s.width}x${s.height} at (${s.x}, ${s.y}) — ${s.scalePercent}% scale`,
        );
        return {
          text:
            `${screens.length} monitor(s). Coordinates are ABSOLUTE virtual-desktop pixels — not per-monitor-relative, ` +
            `and can be negative for a monitor placed left of or above the primary one:\n${lines.join('\n')}`,
        };
      }

      case 'computer_screenshot': {
        const idx = Number.isFinite(args?.screen_index) ? Math.trunc(args.screen_index) : 0;
        const screens = await listComputerScreens();
        if (!screens.length) return { text: 'Error: could not enumerate monitors (this feature is Windows-only).' };
        const mon = screens.find((s) => s.index === idx);
        if (!mon) {
          return { text: `Error: no monitor with index ${idx}. Call computer_screens first — there are ${screens.length} monitor(s), indices 0..${screens.length - 1}.` };
        }
        const capScript = DPI_PREFIX + `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${mon.width}, ${mon.height})
$gr = [System.Drawing.Graphics]::FromImage($bmp)
$gr.CopyFromScreen(${mon.x}, ${mon.y}, 0, 0, (New-Object System.Drawing.Size(${mon.width}, ${mon.height})))
$gr.Dispose()
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
[Convert]::ToBase64String($ms.ToArray())
`.trim();
        const cap = await runPS(capScript, 20000, 80 * 1024 * 1024);
        if (!cap.ok || !cap.stdout) {
          return { text: `Error: screenshot capture failed${cap.error ? ' — ' + cap.error : ''}.` };
        }
        let png: Buffer;
        try {
          png = Buffer.from(cap.stdout, 'base64');
        } catch {
          return { text: 'Error: screenshot capture returned unreadable data.' };
        }
        if (!png.length) return { text: 'Error: screenshot capture returned no data.' };

        // Live on-screen confirmation, fired AFTER the clean capture so the
        // border can never end up in the pixels the being actually sees.
        fireFlash(mon.x, mon.y, mon.width, mon.height, 'rect', 650);

        // Human audit copy: same pixels, border + any very recent clicks
        // burned in, saved to disk. The being never sees this file.
        try {
          await saveAuditScreenshot(ctx.me, idx, mon, png);
        } catch {
          // Best-effort logging must never block the reply to the being.
        }

        console.log(`[computer] ${ctx.me}: screenshot of monitor ${idx} (${mon.width}x${mon.height} at ${mon.x},${mon.y})`);

        return {
          text:
            `Screenshot of monitor ${idx} — ${mon.width}x${mon.height} pixels, top-left at absolute virtual-desktop ` +
            `coordinate (${mon.x}, ${mon.y}). To act on something you see in this image, add (${mon.x}, ${mon.y}) to the ` +
            `pixel position you identify and pass that as the absolute x/y to computer_input.`,
          image: { base64: cap.stdout, mimeType: 'image/png' },
        };
      }

      case 'computer_input': {
        const rawList = Array.isArray(args?.commands) ? args.commands : null;
        if (!rawList || !rawList.length) return { text: 'Error: "commands" must be a non-empty array.' };
        const { resolved, errors } = resolveCommands(rawList);
        if (!resolved.length) {
          return { text: `Error: no valid commands.${errors.length ? ' ' + errors.join('; ') : ''}` };
        }
        // Record every click BEFORE execution, so the audit trail exists even
        // if a later command in the same batch throws.
        for (const r of resolved) {
          if ((r.t === 'down' || r.t === 'click') && r.x !== undefined && r.y !== undefined) recordClick(r.x, r.y);
        }
        console.log(`[computer] ${ctx.me}: ${resolved.length} input command(s) — ${resolved.map((r) => r.t).join(', ')}`);
        const script = buildInputScript(resolved);
        const run = await runPS(script, 30000, 4 * 1024 * 1024, true);
        if (!run.ok) {
          return { text: `Error: input execution failed${run.error ? ' — ' + run.error : ''}.${errors.length ? ' Also skipped: ' + errors.join('; ') : ''}` };
        }
        let report: any[] = [];
        try {
          const parsed = JSON.parse(run.stdout || '[]');
          report = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          // Best-effort summary only — execution already happened either way.
        }
        const failed = report.filter((r) => r && r.ok === false);
        return {
          text:
            `Executed ${resolved.length} command(s)${failed.length ? `, ${failed.length} reported an error` : ''}.` +
            (errors.length ? ` Skipped: ${errors.join('; ')}` : ''),
        };
      }

      default:
        return { text: `Error: unknown computer tool "${name}".` };
    }
  } catch (e: any) {
    return { text: `Error: ${String(e?.message || e).split('\n')[0]}` };
  }
}
