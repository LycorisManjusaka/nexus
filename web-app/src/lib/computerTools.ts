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
// monitor — is written to disk under `local_data/beings/<name>/computer_control_logs/` for
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
import { beingComputerLogsDir } from './beingPaths';

const DATA_DIR = path.resolve(process.cwd(), '..', 'local_data');

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
    const pidFile = path.join(DATA_DIR, 'stopkey.pid');
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

// Draws a red outline DIRECTLY ONTO THE SCREEN DC — no window is ever created.
//
// This is deliberate, and it is the second iteration. The first version showed
// a borderless always-on-top Form. That was wrong for two measured reasons:
//   1. Creating a window between mouse_down and mouse_up steals activation from
//      the target application, which drops its mouse capture — so drags died
//      and only the mouse_up coordinate registered. (Kiko's report.)
//   2. A Form costs a WinForms load + message pump; drawing on the screen DC is
//      immediate, so a click marker actually lands at the moment of the click.
// Draw() snapshots the pixels it is about to cover and Clear() blits them back,
// because "just ask everyone to repaint" leaves fragments behind on surfaces
// that repaint lazily — Lizard-kun saw exactly that: leftover pieces of the
// border sitting there until the cursor passed over them.
const GDI_HELPER = `
$gdiSig = @'
using System;
using System.Runtime.InteropServices;
public class NxGdi {
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("user32.dll")] public static extern bool RedrawWindow(IntPtr h, IntPtr r, IntPtr rg, uint f);
  [DllImport("user32.dll")] public static extern bool InvalidateRect(IntPtr h, IntPtr r, bool erase);
  [DllImport("gdi32.dll")] public static extern IntPtr CreatePen(int s, int w, uint c);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr o);
  [DllImport("gdi32.dll")] public static extern IntPtr GetStockObject(int i);
  [DllImport("gdi32.dll")] public static extern bool Ellipse(IntPtr dc,int l,int t,int r,int b);
  [DllImport("gdi32.dll")] public static extern bool Rectangle(IntPtr dc,int l,int t,int r,int b);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr dc,int w,int h);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr d,int dx,int dy,int w,int h,IntPtr s,int sx,int sy,uint rop);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);

  class Saved { public IntPtr dc; public IntPtr bmp; public IntPtr old; public int x,y,w,h; }
  static System.Collections.Generic.List<Saved> saved = new System.Collections.Generic.List<Saved>();

  // Copy a strip of the live screen into an off-screen bitmap so Clear() can put
  // the exact original pixels back. Repainting alone is not enough: parts of the
  // mark land on surfaces that only repaint when something else forces them to
  // (desktop, taskbar, idle windows), so the paint survives until the cursor
  // happens to pass over it.
  static void Save(IntPtr dc, int x, int y, int w, int h){
    if (w <= 0 || h <= 0) return;
    Saved s = new Saved();
    s.dc = CreateCompatibleDC(dc);
    s.bmp = CreateCompatibleBitmap(dc, w, h);
    if (s.dc == IntPtr.Zero || s.bmp == IntPtr.Zero) return;
    s.old = SelectObject(s.dc, s.bmp);
    s.x = x; s.y = y; s.w = w; s.h = h;
    BitBlt(s.dc, 0, 0, w, h, dc, x, y, 0x00CC0020);
    saved.Add(s);
  }

  public static void Draw(int l,int t,int r,int b,bool circle,int width){
    IntPtr dc = GetDC(IntPtr.Zero);
    if (dc == IntPtr.Zero) return;
    int pad = width / 2 + 2;
    int thick = width + 4;
    if (circle) {
      Save(dc, l - pad, t - pad, (r - l) + pad * 2 + 1, (b - t) + pad * 2 + 1);
    } else {
      // Four edge strips, not the whole rectangle: restoring a monitor-sized
      // snapshot 650 ms later would smear stale pixels over everything inside.
      int fw = (r - l) + pad * 2 + 1;
      int fh = (b - t) + pad * 2 + 1;
      Save(dc, l - pad, t - pad, fw, thick);
      Save(dc, l - pad, b - pad, fw, thick);
      Save(dc, l - pad, t - pad, thick, fh);
      Save(dc, r - pad, t - pad, thick, fh);
    }
    IntPtr pen = CreatePen(0, width, 0x000000FF);
    IntPtr oldPen = SelectObject(dc, pen);
    IntPtr oldBr = SelectObject(dc, GetStockObject(5));
    if (circle) Ellipse(dc,l,t,r,b); else Rectangle(dc,l,t,r,b);
    SelectObject(dc, oldPen); SelectObject(dc, oldBr);
    DeleteObject(pen); ReleaseDC(IntPtr.Zero, dc);
  }

  public static bool HasMarks(){ return saved.Count > 0; }

  public static void Clear(){
    IntPtr dc = GetDC(IntPtr.Zero);
    if (dc != IntPtr.Zero) {
      for (int i = saved.Count - 1; i >= 0; i--) {
        Saved s = saved[i];
        BitBlt(dc, s.x, s.y, s.w, s.h, s.dc, 0, 0, 0x00CC0020);
        SelectObject(s.dc, s.old); DeleteObject(s.bmp); DeleteDC(s.dc);
      }
      ReleaseDC(IntPtr.Zero, dc);
    }
    saved.Clear();
    // Backstop for anything that repainted underneath us while the mark was up.
    InvalidateRect(IntPtr.Zero, IntPtr.Zero, true);
    RedrawWindow(IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0x0585);
  }
}
'@
Add-Type -TypeDefinition $gdiSig -ErrorAction SilentlyContinue
`;

/**
 * Fire-and-forget monitor border, drawn out-of-process so it adds no latency to
 * the being's own call.
 *
 * `detached: true` is deliberately ABSENT. On Windows it starts the child with
 * DETACHED_PROCESS, which gives powershell.exe no console — it then exits 0
 * without executing a single line of the script. That is why this overlay was
 * silently dead: the exit code said success, and nothing ever drew. Measured,
 * not guessed: with `detached` the screen was byte-identical before and after;
 * without it, 36,383 red pixels appeared.
 */
function fireFlash(x: number, y: number, w: number, h: number, ms: number) {
  try {
    const l = Math.trunc(x), t = Math.trunc(y);
    const r = Math.trunc(x + w) - 1, b = Math.trunc(y + h) - 1;
    const script = DPI_PREFIX + GDI_HELPER +
      `[NxGdi]::Draw(${l}, ${t}, ${r}, ${b}, $false, 8)\n` +
      `Start-Sleep -Milliseconds ${Math.trunc(ms)}\n` +
      `[NxGdi]::Clear()\n`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore', windowsHide: true,
    });
    child.on('error', () => { /* cosmetic only */ });
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
  const dir = beingComputerLogsDir(entity);
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

// Modifier virtual-key codes, in the canonical press order used for a combo
// (modifiers held first, released last in reverse). ctrl < alt < shift < win.
const MODIFIER_VKS = [0x11, 0x12, 0x10, 0x5b] as const;

/**
 * Resolve a key_press argument into an ordered list of virtual-key codes:
 * modifiers first (canonical order), then the main key last. A single key
 * returns a one-element array; a combo like "ctrl+shift+a" returns
 * [ctrl, shift, a]. Returns null for anything unrecognized or malformed.
 */
function resolveCombo(key: string): number[] | null {
  const raw = String(key || '').trim();
  if (!raw) return null;
  const parts = raw.split('+').map((p) => p.trim());
  if (!parts.length) return null;
  // Reject a leading, trailing, or doubled separator — "ctrl+" or "+a" or
  // "ctrl++a" is a malformed combo, and silently dropping the empty part would
  // turn it into a bare-key no-op, the exact silent-failure mode we must avoid.
  if (parts.some((p) => !p)) return null;
  if (parts.length === 1) {
    const vk = resolveVk(parts[0]);
    return vk == null ? null : [vk];
  }
  const mainVk = resolveVk(parts[parts.length - 1]);
  if (mainVk == null) return null;
  const mods = new Set<number>();
  for (const p of parts.slice(0, -1)) {
    const vk = resolveVk(p);
    if (vk == null) return null;
    mods.add(vk);
  }
  // Every position before the main key must be a modifier; anything else is a
  // malformed combo (e.g. "a+b"), not a modifier we can hold.
  const ordered: number[] = [];
  for (const m of MODIFIER_VKS) if (mods.has(m)) ordered.push(m);
  if (ordered.length !== mods.size) return null;
  return [...ordered, mainVk];
}

function buttonCode(b?: string): number {
  const s = String(b || 'left').toLowerCase();
  if (s === 'right') return 1;
  if (s === 'middle') return 2;
  return 0;
}

// ── computer_input command resolution + execution ───────────────────────────

type ResolvedType = 'move' | 'down' | 'up' | 'click' | 'wheel' | 'keydown' | 'keyup' | 'keypress' | 'text' | 'idle';
interface ResolvedCommand { t: ResolvedType; x?: number; y?: number; btn?: number; vk?: number; vks?: number[]; s?: string; ms?: number; delta?: number; }

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
      case 'key_up': {
        const vk = resolveVk(c.key);
        if (vk == null) { errors.push(`#${i} unrecognized key "${c.key}"`); return; }
        resolved.push({ t: type === 'key_down' ? 'keydown' : 'keyup', vk });
        return;
      }
      case 'key_press': {
        const vks = resolveCombo(c.key);
        if (!vks) { errors.push(`#${i} unrecognized key or combo "${c.key}"`); return; }
        resolved.push({ t: 'keypress', vks });
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
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  // Cursor position readback — used to report where the pointer actually ended
  // up after a SetCursorPos, so a being can detect DPI virtualization or a
  // coordinate that silently did not move.
  public static POINT Cursor() { POINT p; GetCursorPos(out p); return p; }
  // Which window owns the keyboard focus right now. SendInput is fire-and-
  // forget: it reports whether the OS accepted the event, NOT whether the
  // intended app processed it. Reporting the foreground window lets a being
  // check "did my input go where I aimed" without another screenshot.
  public static string ForegroundTitle() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return "";
    int n = GetWindowTextLength(h);
    if (n <= 0) return "";
    var sb = new System.Text.StringBuilder(n + 1);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }
  public static uint SendMouseButton(int btn, bool down) {
    uint flag;
    if (btn == 1) { flag = down ? 0x0008u : 0x0010u; }
    else if (btn == 2) { flag = down ? 0x0020u : 0x0040u; }
    else { flag = down ? 0x0002u : 0x0004u; }
    var inp = new INPUT();
    inp.type = 0;
    inp.u.mi = new MOUSEINPUT();
    inp.u.mi.dwFlags = flag;
    return SendInput(1, new INPUT[] { inp }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static uint SendMouseWheel(int delta) {
    var inp = new INPUT();
    inp.type = 0;
    inp.u.mi = new MOUSEINPUT();
    inp.u.mi.mouseData = (uint)delta;
    inp.u.mi.dwFlags = 0x0800; // MOUSEEVENTF_WHEEL
    return SendInput(1, new INPUT[] { inp }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static uint SendKey(ushort vk, bool down) {
    var inp = new INPUT();
    inp.type = 1;
    inp.u.ki = new KEYBDINPUT();
    inp.u.ki.wVk = vk;
    inp.u.ki.dwFlags = down ? 0u : KEYEVENTF_KEYUP;
    return SendInput(1, new INPUT[] { inp }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static uint SendUnicodeChar(ushort ch, bool down) {
    var inp = new INPUT();
    inp.type = 1;
    inp.u.ki = new KEYBDINPUT();
    inp.u.ki.wVk = 0;
    inp.u.ki.wScan = ch;
    inp.u.ki.dwFlags = KEYEVENTF_UNICODE | (down ? 0u : KEYEVENTF_KEYUP);
    return SendInput(1, new INPUT[] { inp }, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
Add-Type -TypeDefinition $inSig -ErrorAction SilentlyContinue
`;

function buildInputScript(cmds: ResolvedCommand[]): string {
  const json = JSON.stringify(cmds);
  return DPI_PREFIX + INPUT_HELPER + GDI_HELPER + `
$cmds = ${psQuote(json)} | ConvertFrom-Json
$results = New-Object System.Collections.ArrayList
function Mark-Cursor {
  $mp = New-Object NxInput+POINT
  [void][NxInput]::GetCursorPos([ref]$mp)
  [NxGdi]::Draw($mp.X - 25, $mp.Y - 25, $mp.X + 25, $mp.Y + 25, $true, 6)
}
foreach ($c in $cmds) {
  $d = @{ t = $c.t }
  try {
    switch ($c.t) {
      'move' {
        $d.x = [int]$c.x
        $d.y = [int]$c.y
        $d.moved = [NxInput]::SetCursorPos([int]$c.x, [int]$c.y)
        $cur = [NxInput]::Cursor()
        $d.at = @($cur.X, $cur.Y)
      }
      'down' {
        if ($null -ne $c.x) { [void][NxInput]::SetCursorPos([int]$c.x, [int]$c.y) }
        $d.sent = [NxInput]::SendMouseButton([int]$c.btn, $true)
        Mark-Cursor
      }
      'up' {
        if ($null -ne $c.x) { [void][NxInput]::SetCursorPos([int]$c.x, [int]$c.y) }
        $d.sent = [NxInput]::SendMouseButton([int]$c.btn, $false)
        Mark-Cursor
      }
      'click' {
        if ($null -ne $c.x) { [void][NxInput]::SetCursorPos([int]$c.x, [int]$c.y) }
        $s1 = [NxInput]::SendMouseButton([int]$c.btn, $true)
        Start-Sleep -Milliseconds 40
        $s2 = [NxInput]::SendMouseButton([int]$c.btn, $false)
        $d.sent = [int]$s1 + [int]$s2
        Mark-Cursor
      }
      'wheel' {
        if ($null -ne $c.x) { [void][NxInput]::SetCursorPos([int]$c.x, [int]$c.y) }
        $d.sent = [NxInput]::SendMouseWheel([int]$c.delta)
      }
      'keydown' { $d.sent = [NxInput]::SendKey([uint16]$c.vk, $true) }
      'keyup' { $d.sent = [NxInput]::SendKey([uint16]$c.vk, $false) }
      'keypress' {
        $count = $c.vks.Count
        $n = 0
        for ($i = 0; $i -lt ($count - 1); $i++) { $n += [NxInput]::SendKey([uint16]$c.vks[$i], $true) }
        $main = $c.vks[($count - 1)]
        $n += [NxInput]::SendKey([uint16]$main, $true)
        Start-Sleep -Milliseconds 20
        $n += [NxInput]::SendKey([uint16]$main, $false)
        for ($i = ($count - 2); $i -ge 0; $i--) { $n += [NxInput]::SendKey([uint16]$c.vks[$i], $false) }
        $d.sent = $n
      }
      'text' {
        $n = 0
        foreach ($ch in $c.s.ToCharArray()) {
          $n += [NxInput]::SendUnicodeChar([uint16][int]$ch, $true)
          $n += [NxInput]::SendUnicodeChar([uint16][int]$ch, $false)
          Start-Sleep -Milliseconds 8
        }
        $d.sent = $n
      }
      'idle' { Start-Sleep -Milliseconds ([int]$c.ms) }
    }
    $d.ok = $true
  } catch {
    $d.ok = $false
    $d.error = $_.Exception.Message
  }
  [void]$results.Add($d)
}
$fg = [NxInput]::ForegroundTitle()
[void]$results.Add(@{ t = 'foreground'; title = $fg })
if ([NxGdi]::HasMarks()) {
  Start-Sleep -Milliseconds 350
  [NxGdi]::Clear()
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
      properties: {
        screen_index: { type: 'integer', description: I.computerScreenshotIndexParam },
        show_cursor: { type: 'boolean', description: I.computerScreenshotShowCursorParam },
      },
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
        const showCursor = args?.show_cursor === true;
        const cursorBlock = showCursor ? `
$curSig = @'
using System;
using System.Runtime.InteropServices;
public class NxCur {
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out P p);
}
'@
Add-Type -TypeDefinition $curSig -ErrorAction SilentlyContinue
$cp = New-Object NxCur+P
[NxCur]::GetCursorPos([ref]$cp) | Out-Null
$cx = [int]$cp.X - ${mon.x}
$cy = [int]$cp.Y - ${mon.y}
if ($cx -ge 0 -and $cy -ge 0 -and $cx -lt ${mon.width} -and $cy -lt ${mon.height}) {
  $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Red, 3)
  $gr.DrawLine($pen, ($cx - 14), $cy, ($cx + 14), $cy)
  $gr.DrawLine($pen, $cx, ($cy - 14), $cx, ($cy + 14))
  $gr.DrawEllipse($pen, ($cx - 9), ($cy - 9), 18, 18)
  $pen.Dispose()
}
` : '';
        const capScript = DPI_PREFIX + `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${mon.width}, ${mon.height})
$gr = [System.Drawing.Graphics]::FromImage($bmp)
$gr.CopyFromScreen(${mon.x}, ${mon.y}, 0, 0, (New-Object System.Drawing.Size(${mon.width}, ${mon.height})))
${cursorBlock}
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
        fireFlash(mon.x, mon.y, mon.width, mon.height, 650);

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
        // SendInput returns the number of events the OS accepted (0 = blocked —
        // usually UIPI/privilege isolation, or a target that refused). A
        // SetCursorPos that returns false means the cursor did not move at all.
        // Distinguishing these from "the target app ignored it" is the whole
        // point: this text must tell the being what the OS actually said, so
        // it verifies with a screenshot instead of narrating a cause.
        const blocked = report.filter(
          (r) => r && r.ok !== false && r.sent === 0 &&
            ['down', 'up', 'click', 'wheel', 'keydown', 'keyup', 'keypress', 'text'].includes(r.t),
        );
        const unmoved = report.filter((r) => r && r.t === 'move' && r.moved === false);
        const drifted = report.filter(
          (r) => r && r.t === 'move' && r.moved !== false && Array.isArray(r.at) &&
            (Math.abs((r.at[0] as number) - (r.x as number)) > 2 || Math.abs((r.at[1] as number) - (r.y as number)) > 2),
        );
        const fg = report.find((r) => r && r.t === 'foreground');
        const parts: string[] = [`Executed ${resolved.length} command(s).`];
        if (blocked.length) {
          parts.push(
            `${blocked.length} command(s) were NOT delivered — the OS returned 0 from SendInput ` +
            `(input was blocked: often UIPI/privilege isolation, or the target ignored it): ` +
            `${blocked.map((r) => r.t).join(', ')}.`,
          );
        }
        if (unmoved.length) parts.push(`${unmoved.length} mouse_move(s) did not move the cursor (SetCursorPos returned false).`);
        if (drifted.length) {
          parts.push(
            `${drifted.length} mouse_move(s) landed off-target (DPI virtualization?): ` +
            `${drifted.map((r) => `asked (${r.x},${r.y}) got (${r.at[0]},${r.at[1]})`).join('; ')}.`,
          );
        }
        if (failed.length) {
          parts.push(`${failed.length} command(s) reported an error: ${failed.map((r) => `${r.t}: ${r.error}`).join('; ')}.`);
        }
        if (fg && fg.title) parts.push(`Foreground window after input: "${fg.title}".`);
        parts.push('This reports what the OS accepted, not what the target app did with it — always verify with a fresh computer_screenshot.');
        if (errors.length) parts.push(`Skipped: ${errors.join('; ')}.`);
        return { text: parts.join(' ') };
      }

      default:
        return { text: `Error: unknown computer tool "${name}".` };
    }
  } catch (e: any) {
    return { text: `Error: ${String(e?.message || e).split('\n')[0]}` };
  }
}
