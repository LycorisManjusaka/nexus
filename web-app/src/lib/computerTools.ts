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
// TWO READERS, TWO DIFFERENT PICTURES.
// The being gets the clean capture, undecorated, because marks in the image
// would just be noise it has to reason around. The human gets annotated frames
// under `local_data/beings/<name>/computer_control_logs/`: one per screenshot
// (what the being looked at) and one per computer_input batch, captured just
// before those commands run and marked with what they did. See "human audit
// frames" below for why the action frame is captured there and nowhere else.
// Compositing is plain `sharp` + an SVG overlay, not more PowerShell drawing
// code, because it's easier to get right and easier to change.
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

// ── Screenshot downscale + coordinate scaling (the whole 150%-monitor game) ──
// A monitor whose long edge exceeds the active provider's image cap is captured
// at native resolution but shown to the being downscaled to that cap. We do this
// HERE, once, so the scale NEXUS computes is EXACTLY the scale the model sees —
// which lets the being pass the pixel it READ off the image (via computer_input
// screen_index) and have NEXUS convert it back to a real-screen coordinate,
// instead of asking the being to multiply by its own DPI scale on every click.
//
// The cap is PER-PROVIDER, and we only shrink when native EXCEEDS it — so a
// monitor that already fits (e.g. a 1920px 100% monitor) passes through at 1:1
// with no quality loss (Lizard-kun, 2026-10-06: a blanket 1568 cap needlessly
// blurred his perfect 100% monitor). The cap must sit at or below each provider's
// OWN invisible shrink, or the coordinate mapping breaks downstream:
//   • OAuth (Claude Code SDK): 2000 — MEASURED. The SDK silently downscales
//     anything over ~2000px before the API sees it (Kiko, 2026-10-06, zero
//     clicks: aim (1600,900) -> cursor (833,469), ratio 0.521 = 2000/3840, NOT
//     1/1.5, so DPI was never the cause). This is the DEFAULT.
//   • Claude API-key: 1568 — the Anthropic API resizes >1568px long edge server
//     side, so NEXUS must pre-shrink to 1568 there (passed as ctx.maxEdge).
//   • Gemini: 2000 long edge, PLUS a height pin — see NORMALIZED_COORD_SAFE_HEIGHT
//     below, which is what actually governs the delivered size there. The 2000
//     cap itself is coordinate-safe for Gemini (MEASURED: on clean runs it
//     reports accurate pixels of the DELIVERED frame at 1280x720, 1778x1000,
//     1920x1080, 1920x1200, 1920x1400 and 2000x1125 — its internal tiling is
//     invisible to the coordinate contract, promptTokenCount ~1180 at every one
//     of those sizes).
//   • OpenAI-compatible / Kimi / MiMo: left at the 2000 default — their real
//     caps are UNMEASURED for computer-use, so raise with evidence, never by
//     guess.
export const DEFAULT_SCREENSHOT_MAX_EDGE = 2000;

// ── Normalized-coordinate safety (Gemini) ───────────────────────────────────
// MEASURED 2026-10-08. Gemini answers "where is this?" in one of TWO coordinate
// spaces, and which one it picks varies PER RESPONSE: of 55 completed runs, 55%
// came back in a 0–1000 normalized space instead of image pixels (classified
// mechanically — see workspace/gemini-normalized-coordinate-mode.md). The error
// is MULTIPLICATIVE, dy = -y·(1 - 1000/H), which is exactly why it reads as a
// "wandering 25–50px vertical offset" when only a handful of points are sampled
// (that earlier reading was mine, and it was wrong).
//
// Two fixes that do NOT work, and why:
//   • A per-model flag. Every Gemini tested (3.1…3.8, pro and flash) does it
//     intermittently — the mode is per-RESPONSE, not per-model.
//   • ctx.normalizedCoords (the Seed 2.x path). That branch assumes the model
//     ALWAYS normalizes; switching it on for Gemini would break the 40% of
//     responses that are already correct.
//
// So remove the AMBIGUITY instead of the behaviour: deliver the image at height
// EXACTLY 1000, where y·1000/H == y, and the two spaces produce the SAME number.
// The fault cannot be expressed, whichever space the model happens to pick.
// Legibility is unaffected — transcription was identical native vs height-1000
// on a synthetic ladder down to 9px (99.5% both) and on real Explorer captures
// (8/8 on 1920x1080→1778x1000, and 12/12 on a portrait 1080x1920→563x1000).
// NOT applied to monitors already shorter than 1000: upscaling adds no detail,
// and that case is UNMEASURED — do not guess it into the shipped path.
export const NORMALIZED_COORD_SAFE_HEIGHT = 1000;

/** Image-to-native scale for a monitor's screenshot (1 if it isn't downscaled).
 *  `heightTarget` (optional) shrinks further so the delivered image lands on
 *  exactly that height — see NORMALIZED_COORD_SAFE_HEIGHT. It can only ever
 *  make the scale SMALLER, never enlarge past the transport cap. */
export function screenScale(
  widthPx: number,
  heightPx: number,
  maxEdge: number = DEFAULT_SCREENSHOT_MAX_EDGE,
  heightTarget?: number,
): number {
  const longest = Math.max(widthPx || 0, heightPx || 0);
  let scale = !longest || longest <= maxEdge ? 1 : maxEdge / longest;
  if (heightTarget && heightPx > heightTarget) {
    const toHeight = heightTarget / heightPx;
    if (toHeight < scale) scale = toHeight;
  }
  return scale;
}

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

/**
 * Kill only the in-flight input process, without touching the turn stream.
 * For the BROWSER Stop button: it aborts its fetch, which the chat route turns
 * into a turn-level abort — but a PowerShell input child that was already
 * spawned keeps typing/clicking regardless of who is listening. The hotkey
 * path got this for free via stopComputerSession(); the button did not.
 */
export function killActiveInput(): boolean {
  if (!activeInputChild) return false;
  try { activeInputChild.kill(); } catch { /* already gone */ }
  activeInputChild = null;
  return true;
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
  /** UI language ('en' | 'ja'). Used ONLY for the human audit frames: those
   *  pictures are read by the machine's owner and whoever he shows them to, so
   *  they follow the house language, not the source language. Nothing the model
   *  sees depends on this. */
  language?: string;
  /** Provider image long-edge cap (px). Screenshot is downscaled to this
   *  only when native exceeds it, so the scale NEXUS reports matches what the
   *  model receives. Omit -> DEFAULT_SCREENSHOT_MAX_EDGE (2000). */
  maxEdge?: number;
  /** This model reports click coordinates in a fixed 0–1000 normalized space
   *  (not real image pixels) — e.g. the ByteDance Seed 2.x family. When set,
   *  computer_input recovers the image pixel as (reported / 1000 × monitor
   *  dimension) before applying the screen_index offset. Requires screen_index
   *  (NEXUS needs the monitor size to un-normalize). See reportsNormalizedCoords. */
  normalizedCoords?: boolean;
  /** Deliver the screenshot at exactly this image HEIGHT (further shrinking
   *  beyond maxEdge) so a 0–1000 normalized answer and a pixel answer are the
   *  same number. Set to NORMALIZED_COORD_SAFE_HEIGHT on the Gemini path, where
   *  the space varies per RESPONSE and so cannot be corrected after the fact.
   *  Must be passed to BOTH computer_screenshot and computer_input — they
   *  recompute the same screenScale(), and a mismatch sends every click off. */
  heightTarget?: number;
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

export function runPS(script: string, timeoutMs: number, maxBuffer = 4 * 1024 * 1024, trackInput = false): Promise<PsRunResult> {
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

export const DPI_PREFIX = `
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
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
export function fireFlash(x: number, y: number, w: number, h: number, ms: number) {
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

/**
 * One monitor → PNG bytes. Single source, because computer_input now captures
 * too (for its action frame) and two copies of this script would drift the day
 * one of them learned something the other did not.
 *
 * Returns the base64 alongside the Buffer so the screenshot path can hand the
 * model the string PowerShell already produced instead of re-encoding 2.5 MB.
 * MEASURED cost: 300 ms (1920x1080) to 460 ms (3840x2160).
 */
async function captureMonitorPng(mon: ComputerScreen, cursorBlock = ''): Promise<{ png: Buffer | null; base64: string; error: string | null }> {
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
  if (!cap.ok || !cap.stdout) return { png: null, base64: '', error: cap.error || 'capture produced no output' };
  let png: Buffer;
  try {
    png = Buffer.from(cap.stdout, 'base64');
  } catch {
    return { png: null, base64: '', error: 'capture returned unreadable data' };
  }
  if (!png.length) return { png: null, base64: '', error: 'capture returned no data' };
  return { png, base64: cap.stdout, error: null };
}

// ── human audit frames ──────────────────────────────────────────────────────
// A MARK BELONGS ON THE FRAME THE ACTION LANDED ON.
// The first version of this kept a ring buffer of clicks and drew every one
// from the last 120 seconds onto whatever screenshot came next. Because the
// loop is act → screenshot → act → screenshot, that painted each action onto a
// LATER screen state: a click that opened a dropdown was drawn, two page states
// later, on top of a "Cancel" button nobody had pressed. No window length fixes
// that — the window WAS the bug, so the ring buffer is gone. computer_input now
// captures its own frame immediately BEFORE it executes and annotates exactly
// the batch it is about to run; computer_screenshot's copy carries the border
// only, because by then the actions already have frames of their own.
//
// TWO KINDS OF FRAME, NAMED IN THE FILENAME:
//   <stamp>_monitor<N>.png        what the being looked at (observation)
//   <stamp>_monitor<N>_input.png  what the being then did   (action)
// Both sort together by timestamp, so a plain name sort is already the video.
//
// THE OVERLAY IS A LEGEND, NOT A DECORATION.
// Positions carry a numbered shape (circle/square/diamond/arrow = which button,
// or a drag); everything with no position — wheel, keys, typed text — and every
// positioned command too is listed in a numbered stack down the right edge. The
// number is the only thing tying the two together, which is why it is drawn in
// its own boxed label rather than as bare text over arbitrary pixels.

/** 192/255, the value Lizard-kun proposed. MEASURED against the real
 *  backgrounds in his own capture (overlay_probe/font_and_alpha.mjs): this
 *  moves a pixel by an RGB distance of 161 (darkest background present) to 268
 *  (white page). 128 was his worry — it survives too, at 107..178 — so the
 *  choice here is strength, not legibility. */
const AUDIT_MARK_OPACITY = 192 / 255;
/** The stack panels need a higher floor than the marks: their job is to make
 *  TEXT readable over whatever happens to be behind them. */
const AUDIT_PANEL_FILL_OPACITY = 0.5;
/** A long batch must not paper over the screenshot it is describing. Anything
 *  past this is summarised in one final entry — never silently dropped. */
const AUDIT_STACK_MAX = 14;
/** librsvg resolves a GENERIC family ("sans-serif") from whatever the MACHINE
 *  has installed, so the same code and the same SVG produce a different
 *  typeface on every PC. On the work machine that generic lands on a
 *  handwriting face and the panels stop being readable; here it lands on a
 *  gothic one. Nothing in the repo chose either. So the family is PINNED.
 *
 *  Measured, not assumed (overlay_probe/font_list.mjs): librsvg does honour a
 *  comma list, and the first INSTALLED member wins — not the last, not a merge.
 *  The trailing generic only runs on a machine that has none of them, which is
 *  exactly today's behaviour: this can only improve, never regress.
 *
 *  The ORDER is measured too, not taste. These panels are small red text over
 *  whatever happened to be on screen, so stroke weight is what carries them;
 *  ink per horizontal pixel at the shipping size of 19px, over a mixed label:
 *  Meiryo UI 3.83, MS UI Gothic 3.86, MS Gothic 3.72, Noto Sans JP 3.55,
 *  Yu Gothic UI 3.35, Yu Gothic 2.36. Yu Gothic is demoted to last-but-one for
 *  that 2.36 — it is the Windows default in places, and it is the thinnest face
 *  on the list by a wide margin. MS UI Gothic scores highest but is a dated
 *  bitmap-era design, so Meiryo leads: same weight, modern shapes, and it was
 *  drawn for on-screen Japanese legibility in the first place.
 *
 *  EM_BANDS below is an envelope over exactly THIS list — every member was
 *  rendered and checked to fit inside the box the list produces, worst label of
 *  a realistic batch and of a pathological one (overlay_probe/font_fix_verify.
 *  mjs). Adding a family therefore means re-running glyph_width_classes.mjs to
 *  re-derive the bands AND font_fix_verify.mjs to confirm nothing overflows;
 *  a name added without that is a box that is too narrow on someone's PC and
 *  nobody's here. BIZ UDPGothic was left out on those grounds: a fine UD face,
 *  but its latin runs 0.667 em against the others' 0.48–0.58 and it was never
 *  put through the bands.
 *
 *  textLength/lengthAdjust would make the box fit any face and remove the need
 *  for all of this — librsvg 2.61.2 ignores both (same probe). */
const AUDIT_FONT = `'Meiryo UI', 'Meiryo', 'Yu Gothic UI', 'MS UI Gothic', 'MS PGothic', 'MS Gothic', 'Noto Sans JP', 'Yu Gothic', sans-serif`;

/** Which monitor the being last looked at, so a keyboard-only computer_input
 *  (no coordinates anywhere, no screen_index) still gets a frame of the screen
 *  it is almost certainly typing into. Held on globalThis for the same reason
 *  browserTools.ts holds its session map there: Next.js hot-reload re-evaluates
 *  this module and a plain module-level value would reset on every edit. */
const lastShotMonitor: { idx: number | null } = ((globalThis as any).__nexusLastShotMonitor ||= { idx: null });

export interface AuditMark {
  /** Display number, shared with this mark's stack row. Counts MARKS, not
   *  commands: the number exists only to tie a shape on the picture to a row
   *  in the stack, so numbering a command that draws nothing hands the viewer
   *  a label with nothing behind it — and makes the numbers that DO point
   *  somewhere look like they are skipping (Lizard-kun, 2026-10-12: the frame
   *  read 1 → 3 → 5). MEASURED over the 420 computer_input calls saved in the
   *  house's conversation logs: 58.2% of commands draw no mark, and 60.2% of
   *  calls skipped at least one number. */
  n: string;
  kind: 'click' | 'down' | 'up' | 'move' | 'drag';
  /** 0 left, 1 right, 2 middle. */
  btn?: number;
  /** Monitor-LOCAL pixels (absolute minus the monitor origin). */
  x: number;
  y: number;
  /** Drag end, monitor-local. */
  x2?: number;
  y2?: number;
}

/** One row of the right-hand stack. `n` is EMPTY for a command that drew no
 *  mark on this frame (a wait, a keystroke, a wheel, a click on another
 *  monitor). The row keeps its place in time — order is carried by position,
 *  which needs no number — but it claims no number the viewer could go
 *  looking for and not find. */
export interface AuditStackEntry { n: string; label: string; }

function xmlEsc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] as string));
}

/** Advance of one non-full-width character, as an UPPER BOUND over every face
 *  AUDIT_FONT can land on. This used to be a flat 0.58 em, which is a MEAN and
 *  not a bound: measured in 20-glyph runs across all nine pinned faces
 *  (overlay_probe/glyph_width_classes.mjs, font-size 30), 70 of the 94
 *  printable ASCII exceed 0.58 and '%' reaches 1.03. Labels as ordinary as
 *  入力「WWW」 therefore ran past their own panel edge — that is pre-existing,
 *  but pinning the face makes it reachable, so it is fixed here instead of
 *  left. A panel a few px roomy is invisible; a panel a few px short is the
 *  only one of the two a reader can see.
 *
 *  …↑↓ are in the widest band on purpose: auditLabel() emits them itself (the
 *  clip marker and the wheel arrows), they are full-width in these faces, and
 *  the old code charged them as ASCII — a silent 40% undercount on every
 *  clipped or scrolled row. */
const EM_BANDS: ReadonlyArray<readonly [string, number]> = [
  ['%@Wm…↑↓', 1.03],
  ['M', 0.91],
  ['w&#~+<=^>OQ', 0.83],
  ['DNHUGKV', 0.75],
  ['ARCBXPTYZS_', 0.68],
];
/** Every remaining printable ASCII measured at or below 0.617 em. */
const EM_REST = 0.62;
function asciiEm(ch: string): number {
  const band = EM_BANDS.find(([set]) => set.includes(ch));
  return band ? band[1] : EM_REST;
}

/** SVG cannot size a <rect> to the <text> inside it, so the box has to be
 *  measured here. Full-width characters are 1.00 em by construction and the
 *  widest ink measured was 0.99; everything else goes through asciiEm(). */
function textWidthPx(s: string, fontSize: number): number {
  let em = 0;
  for (const ch of s) {
    em += /[\u1100-\u11ff\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/.test(ch) ? 1.0 : asciiEm(ch);
  }
  return Math.ceil(em * fontSize);
}

/** A boxed label: red outline, translucent white fill, solid text. Used for
 *  both the number beside a mark and every row of the stack, so the viewer
 *  only has to learn one shape. */
function boxedLabel(x: number, y: number, text: string, fontSize: number, pad: number, stroke: number): { svg: string; w: number; h: number } {
  const w = textWidthPx(text, fontSize) + pad * 2;
  const h = Math.round(fontSize * 1.42) + pad;
  const r = Math.round(fontSize * 0.25);
  return {
    w,
    h,
    svg:
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="white" fill-opacity="${AUDIT_PANEL_FILL_OPACITY}" ` +
      `stroke="red" stroke-width="${stroke}" stroke-opacity="${AUDIT_MARK_OPACITY}"/>` +
      `<text x="${x + pad}" y="${y + h - Math.round(pad * 0.75) - Math.round(fontSize * 0.18)}" font-size="${fontSize}" ` +
      `font-family="${AUDIT_FONT}" fill="#c00000">${xmlEsc(text)}</text>`,
  };
}

/**
 * The whole overlay, as one SVG string. Pure — no capture, no clock, no disk —
 * so it can be rendered and inspected on its own (overlay_probe/render.mjs).
 * Coordinates are monitor-local; callers subtract the monitor origin.
 */
export function buildAuditOverlaySvg(w: number, h: number, marks: AuditMark[], stack: AuditStackEntry[]): string {
  // One scale knob, so the overlay looks the same size on a 1080p monitor and
  // on a 4K one instead of turning into ants on the big screen.
  const ui = Math.max(1, Math.round(Math.min(w, h) / 1080));
  const sw = 4 * ui;
  const R = 20 * ui;
  const numFs = 17 * ui;
  const numPad = 4 * ui;
  const stackFs = 19 * ui;
  const stackPad = 8 * ui;
  const margin = 14 * ui;
  const O = AUDIT_MARK_OPACITY;
  const parts: string[] = [
    `<rect x="${Math.round(sw * 0.75)}" y="${Math.round(sw * 0.75)}" width="${Math.max(1, w - Math.round(sw * 1.5))}" ` +
    `height="${Math.max(1, h - Math.round(sw * 1.5))}" fill="none" stroke="red" stroke-width="${6 * ui}" stroke-opacity="${O}"/>`,
  ];

  for (const m of marks) {
    const { x, y } = m;
    // Shape carries the button; the stack row spells it out in words. A shape
    // alone would need a legend, and there is no room for one.
    if (m.kind === 'drag' && m.x2 !== undefined && m.y2 !== undefined) {
      const ang = Math.atan2(m.y2 - y, m.x2 - x);
      const ah = 18 * ui;
      const p = (a: number) => `${Math.round(m.x2! - ah * Math.cos(ang + a))},${Math.round(m.y2! - ah * Math.sin(ang + a))}`;
      parts.push(
        `<circle cx="${x}" cy="${y}" r="${9 * ui}" fill="white" fill-opacity="${AUDIT_PANEL_FILL_OPACITY}" stroke="red" stroke-width="${sw}" stroke-opacity="${O}"/>`,
        `<line x1="${x}" y1="${y}" x2="${m.x2}" y2="${m.y2}" stroke="red" stroke-width="${sw}" stroke-opacity="${O}" stroke-linecap="round"/>`,
        `<polygon points="${m.x2},${m.y2} ${p(-0.42)} ${p(0.42)}" fill="red" fill-opacity="${O}"/>`,
      );
    } else if (m.btn === 1) {
      parts.push(`<rect x="${x - R}" y="${y - R}" width="${R * 2}" height="${R * 2}" fill="none" stroke="red" stroke-width="${sw}" stroke-opacity="${O}"/>`);
    } else if (m.btn === 2) {
      parts.push(`<polygon points="${x},${y - R} ${x + R},${y} ${x},${y + R} ${x - R},${y}" fill="none" stroke="red" stroke-width="${sw}" stroke-opacity="${O}"/>`);
    } else if (m.kind === 'move') {
      parts.push(
        `<line x1="${x - R}" y1="${y}" x2="${x + R}" y2="${y}" stroke="red" stroke-width="${sw}" stroke-opacity="${O}"/>`,
        `<line x1="${x}" y1="${y - R}" x2="${x}" y2="${y + R}" stroke="red" stroke-width="${sw}" stroke-opacity="${O}"/>`,
      );
    } else {
      parts.push(`<circle cx="${x}" cy="${y}" r="${R}" fill="none" stroke="red" stroke-width="${sw}" stroke-opacity="${O}"/>`);
    }
    // Number to the LEFT of the shape (Lizard-kun's preference), flipped to the
    // right only when there is no room, so it never falls off the frame.
    const probe = boxedLabel(0, 0, m.n, numFs, numPad, Math.max(2, Math.round(sw * 0.6)));
    let nx = x - R - Math.round(6 * ui) - probe.w;
    if (nx < 2 * ui) nx = x + R + Math.round(6 * ui);
    const ny = Math.min(Math.max(2 * ui, y - Math.round(probe.h / 2)), h - probe.h - 2 * ui);
    parts.push(boxedLabel(nx, ny, m.n, numFs, numPad, Math.max(2, Math.round(sw * 0.6))).svg);
  }

  // The stack: one row per command, down the right edge, so the eye always
  // knows where to look for "what happened in this frame". Every row gets the
  // SAME width — per-row widths right-aligned leave a ragged left edge, and
  // these frames are shown to people outside the house.
  // Two <text> columns, not one string: a row whose command drew no mark has
  // no number, and leading spaces cannot hold its place — SVG's default
  // xml:space collapses runs of whitespace and strips them at the start. A
  // reserved number column keeps every label on the same left edge, and the
  // blank is itself the information: that command is not on the picture.
  const rows = stack.slice(0, AUDIT_STACK_MAX);
  const numW = rows.reduce((mx, e) => Math.max(mx, e.n ? textWidthPx(e.n, stackFs) : 0), 0);
  const numGap = numW ? Math.round(stackFs * 0.7) : 0;
  const labW = rows.reduce((mx, e) => Math.max(mx, textWidthPx(e.label, stackFs)), 0);
  const rowH = Math.round(stackFs * 1.42) + stackPad;
  const colW = Math.min(stackPad * 2 + numW + numGap + labW, Math.round(w * 0.46));
  const bx = Math.max(margin, w - margin - colW);
  const dy = rowH - Math.round(stackPad * 0.75) - Math.round(stackFs * 0.18);
  let sy = margin + 6 * ui;
  for (const r of rows) {
    parts.push(
      `<rect x="${bx}" y="${sy}" width="${colW}" height="${rowH}" rx="${Math.round(stackFs * 0.25)}" fill="white" ` +
      `fill-opacity="${AUDIT_PANEL_FILL_OPACITY}" stroke="red" stroke-width="${2 * ui}" stroke-opacity="${O}"/>` +
      (r.n
        ? `<text x="${bx + stackPad}" y="${sy + dy}" font-size="${stackFs}" font-family="${AUDIT_FONT}" fill="#c00000">${xmlEsc(r.n)}</text>`
        : '') +
      `<text x="${bx + stackPad + numW + numGap}" y="${sy + dy}" font-size="${stackFs}" ` +
      `font-family="${AUDIT_FONT}" fill="#c00000">${xmlEsc(r.label)}</text>`,
    );
    sy += rowH + Math.round(6 * ui);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${parts.join('')}</svg>`;
}

/** What the stack says a command was, in words. Japanese when the UI is — these
 *  frames are read by the machine's owner and the people he shows them to, not
 *  by a model, so the house language wins over the source language here. */
function auditLabel(c: ResolvedCommand, ja: boolean): string {
  const btn = (b?: number) => (ja ? (b === 1 ? '右' : b === 2 ? '中' : '左') : b === 1 ? 'right' : b === 2 ? 'middle' : 'left');
  const keyName = (k?: string) =>
    String(k || '?')
      .split('+')
      .map((s) => (s.length > 1 ? s[0].toUpperCase() + s.slice(1) : s.toUpperCase()))
      .join('+');
  const clip = (s: string, n: number) => {
    const a = Array.from(s);
    return a.length > n ? a.slice(0, n).join('') + '…' : s;
  };
  switch (c.t) {
    case 'click': return ja ? `${btn(c.btn)}クリック` : `${btn(c.btn)} click`;
    case 'down': return ja ? `${btn(c.btn)}ボタンを押す` : `${btn(c.btn)} button down`;
    case 'up': return ja ? `${btn(c.btn)}ボタンを離す` : `${btn(c.btn)} button up`;
    case 'move': return ja ? 'マウス移動' : 'mouse move';
    case 'wheel': {
      const d = c.delta || 0;
      const notches = Math.round(Math.abs(d) / 120);
      const amt = `${d > 0 ? '↑' : '↓'}${notches >= 1 ? notches : Math.abs(d)}`;
      return ja ? `ホイール ${amt}` : `wheel ${amt}`;
    }
    case 'keypress': return ja ? `キー ${keyName(c.k)}` : `key ${keyName(c.k)}`;
    case 'keydown': return ja ? `キーを押す ${keyName(c.k)}` : `key down ${keyName(c.k)}`;
    case 'keyup': return ja ? `キーを離す ${keyName(c.k)}` : `key up ${keyName(c.k)}`;
    case 'text': return ja ? `入力「${clip(c.s || '', 24)}」` : `type "${clip(c.s || '', 24)}"`;
    case 'idle': return ja ? `待機 ${c.ms || 0}ms` : `wait ${c.ms || 0}ms`;
    default: return String(c.t);
  }
}

/**
 * One resolved batch → the marks and the stack rows for its frame.
 *
 * Positions are resolved in a SEPARATE first pass. A bare mouse_down carries no
 * x/y (it is legal, and acts wherever the cursor already is), so the position
 * has to be carried forward from an earlier command — and doing that inside the
 * drag look-ahead would advance the running cursor for a drag that then turns
 * out not to be one, silently misplacing everything after it.
 *
 * down → move* → up collapses into ONE arrow. Three marks stacked on the same
 * pixel is exactly the picture this whole change exists to stop producing.
 */
export function planAuditOverlay(cmds: ResolvedCommand[], mon: ComputerScreen, ja: boolean): { marks: AuditMark[]; stack: AuditStackEntry[] } {
  type Pt = { x: number; y: number } | null;
  const pos: Pt[] = [];
  let run: Pt = null;
  for (const c of cmds) {
    if (c.x !== undefined && c.y !== undefined) run = { x: c.x, y: c.y };
    const positional = c.t === 'click' || c.t === 'down' || c.t === 'up' || c.t === 'move' || c.t === 'wheel';
    pos.push(positional ? run : null);
  }

  const marks: AuditMark[] = [];
  const stack: AuditStackEntry[] = [];
  /** Numbers count marks drawn, NOT commands consumed — so the picture reads
   *  1, 2, 3 with nothing missing, and a command that draws nothing takes a
   *  row without taking a number. */
  let markNo = 0;
  const inside = (p: Pt) => !!p && p.x >= mon.x && p.x < mon.x + mon.width && p.y >= mon.y && p.y < mon.y + mon.height;
  const local = (p: { x: number; y: number }) => ({ x: p.x - mon.x, y: p.y - mon.y });

  let i = 0;
  while (i < cmds.length) {
    const c = cmds[i];
    if (c.t === 'down') {
      let j = i + 1;
      let moved = false;
      while (j < cmds.length && (cmds[j].t === 'move' || cmds[j].t === 'idle')) {
        if (cmds[j].t === 'move') moved = true;
        j++;
      }
      const start = pos[i];
      const end = j < cmds.length ? pos[j] : null;
      // "Drag" has to be EARNED. Either a mouse_move ran while the button was
      // held, or the press and the release are at different known points. With
      // no coordinates anywhere, nothing moved the cursor between the two, so
      // it is a press and a release in place — calling it a drag would be a
      // claim the commands do not support.
      const movedWhileHeld = moved || (!!start && !!end && (start.x !== end.x || start.y !== end.y));
      if (j < cmds.length && cmds[j].t === 'up' && cmds[j].btn === c.btn && movedWhileHeld) {
        // One arrow is one mark, so it takes one number. It used to be stamped
        // with the span of commands it ate ("2-4"); under mark numbering that
        // span indexes nothing the viewer can count.
        let n = '';
        if (inside(start) && end) {
          const a = local(start!);
          const b = local(end);
          n = String(++markNo);
          marks.push({ n, kind: 'drag', btn: c.btn, x: a.x, y: a.y, x2: b.x, y2: b.y });
        }
        const b = c.btn === 1 ? (ja ? '右' : 'right') : c.btn === 2 ? (ja ? '中' : 'middle') : ja ? '左' : 'left';
        stack.push({ n, label: ja ? `ドラッグ（${b}）` : `drag (${b})` });
        i = j + 1;
        continue;
      }
    }
    const p = pos[i];
    // A mouse_move whose only job is to put the cursor where the NEXT command
    // acts ("move then press", the ordinary idiom) draws a crosshair under the
    // next mark. It still gets its stack row — it just stops stamping the same
    // pixel twice.
    const positioningOnly =
      c.t === 'move' && i + 1 < cmds.length && !!p && !!pos[i + 1] &&
      pos[i + 1]!.x === p.x && pos[i + 1]!.y === p.y;
    // mouse_wheel is deliberately stack-only: it has a position, but marking it
    // competes with the clicks for attention and the amount is the information.
    let n = '';
    if (c.t !== 'wheel' && !positioningOnly && inside(p)) {
      const l = local(p!);
      n = String(++markNo);
      marks.push({ n, kind: c.t as AuditMark['kind'], btn: c.btn, x: l.x, y: l.y });
    }
    stack.push({ n, label: auditLabel(c, ja) });
    i++;
  }

  if (stack.length > AUDIT_STACK_MAX) {
    const hidden = stack.length - (AUDIT_STACK_MAX - 1);
    stack.splice(AUDIT_STACK_MAX - 1);
    // No number: the summary is not a command, and under mark numbering a "…"
    // in the number column reads as a mark the viewer should be hunting for.
    stack.push({ n: '', label: ja ? `ほか ${hidden} 件` : `+${hidden} more` });
  }
  return { marks, stack };
}

/** Writes one annotated frame. Overlay failures degrade to the plain capture:
 *  losing the annotation is a worse outcome than losing the record, but losing
 *  the record is the worst one. */
async function saveAuditFrame(entity: string, idx: number, mon: ComputerScreen, png: Buffer, svg: string, suffix: string): Promise<void> {
  const dir = beingComputerLogsDir(entity);
  await fsp.mkdir(dir, { recursive: true });
  let out = png;
  try {
    out = await sharp(png).composite([{ input: Buffer.from(svg) }]).png().toBuffer();
  } catch {
    // Compositing failed (bad SVG, exotic pixel format, ...) — save the plain
    // capture rather than lose the audit record entirely.
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `${safeName(entity)}_${stamp}_monitor${idx}${suffix}.png`;
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
interface ResolvedCommand {
  t: ResolvedType; x?: number; y?: number; btn?: number; vk?: number; vks?: number[]; s?: string; ms?: number; delta?: number;
  /** The key spec as the being wrote it ("ctrl+c"), kept for the audit frame's
   *  stack row — resolveVk/resolveCombo flatten it to numbers, which is not a
   *  thing a human can read off a picture. The PowerShell side reads fields by
   *  name and ignores this one. */
  k?: string;
}

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
        resolved.push({ t: type === 'key_down' ? 'keydown' : 'keyup', vk, k: String(c.key) });
        return;
      }
      case 'key_press': {
        const vks = resolveCombo(c.key);
        if (!vks) { errors.push(`#${i} unrecognized key or combo "${c.key}"`); return; }
        resolved.push({ t: 'keypress', vks, k: String(c.key) });
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
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr h, uint access, out IntPtr token);
  [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token, int cls, IntPtr info, uint len, out uint retLen);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint i);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  // Cursor position readback — used to report where the pointer actually ended
  // up after a SetCursorPos, so a being can detect DPI virtualization or a
  // coordinate that silently did not move.
  public static POINT Cursor() { POINT p; GetCursorPos(out p); return p; }
  // Whether synthesized input can cross from THIS process to the foreground
  // window's process. SendInput's return value only confirms the event was
  // accepted into the system input stream — UIPI (User Interface Privilege
  // Isolation) then silently drops it before delivery if the target window
  // belongs to a HIGHER-integrity process. That failure is invisible to every
  // other check here: SendInput still reports success, and SetCursorPos is the
  // only API that visibly refuses (returns false). Measured directly against an
  // elevated RPG Maker game: keyboard input was accepted by SendInput and
  // silently never arrived.
  //
  // The deciding quantity is the integrity level, and it is a COMPARISON, not a
  // property of the target alone. This used to read only the target's
  // TokenElevation, which made the warning fire on every single call on a
  // machine with UAC disabled (EnableLUA=0): there Windows builds no split
  // token, so every process in an admin logon runs High — target elevated,
  // sender elevated, no boundary to cross, warning anyway. Reported by Hibiki
  // (2026-09-16) with 20/20 calls warning and 20/20 delivering. A warning that
  // always fires carries no information and trains its reader to skip it.
  //
  // Returns "selfRid,selfElev,targetRid,targetElev"; -1 for any part that could
  // not be read. Integrity RIDs: 0x0 untrusted, 0x1000 low, 0x2000 medium,
  // 0x3000 high, 0x4000 system. PROCESS_QUERY_LIMITED_INFORMATION is used
  // because (unlike full QUERY_INFORMATION) Windows grants it across the
  // integrity boundary — measured for TokenElevation. The integrity read uses
  // the same token handle but was NOT separately measured against a
  // higher-integrity target, which is why an unreadable integrity level falls
  // back to the elevation pair instead of to silence.
  public static string PrivilegeInfo() {
    long sRid; int sElev; long tRid = -1; int tElev = -1;
    ReadToken(GetCurrentProcess(), false, out sRid, out sElev);
    IntPtr h = GetForegroundWindow();
    if (h != IntPtr.Zero) {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid != 0) {
        IntPtr ph = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
        if (ph != IntPtr.Zero) ReadToken(ph, true, out tRid, out tElev);
      }
    }
    return sRid + "," + sElev + "," + tRid + "," + tElev;
  }
  static void ReadToken(IntPtr ph, bool closeHandle, out long rid, out int elev) {
    rid = -1; elev = -1;
    IntPtr token;
    if (!OpenProcessToken(ph, 0x0008 /* TOKEN_QUERY */, out token)) { if (closeHandle) CloseHandle(ph); return; }
    IntPtr buf = Marshal.AllocHGlobal(4);
    uint retLen;
    if (GetTokenInformation(token, 20 /* TokenElevation */, buf, 4, out retLen)) { elev = Marshal.ReadInt32(buf); }
    Marshal.FreeHGlobal(buf);
    uint need = 0;
    GetTokenInformation(token, 25 /* TokenIntegrityLevel */, IntPtr.Zero, 0, out need);
    if (need > 0) {
      IntPtr lbl = Marshal.AllocHGlobal((int)need);
      if (GetTokenInformation(token, 25, lbl, need, out need)) {
        IntPtr sid = Marshal.ReadIntPtr(lbl); // TOKEN_MANDATORY_LABEL.Label.Sid
        byte cnt = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
        if (cnt > 0) { rid = (uint)Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(cnt - 1))); }
      }
      Marshal.FreeHGlobal(lbl);
    }
    CloseHandle(token);
    if (closeHandle) CloseHandle(ph);
  }
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
$fgPriv = [NxInput]::PrivilegeInfo()
[void]$results.Add(@{ t = 'foreground'; title = $fg; priv = $fgPriv })
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
      properties: {
        commands: { type: 'array', description: I.computerInputCommandsParam },
        screen_index: { type: 'integer', description: I.computerInputScreenParam },
      },
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
        const cap = await captureMonitorPng(mon, cursorBlock);
        if (!cap.png) return { text: `Error: screenshot capture failed${cap.error ? ' — ' + cap.error : ''}.` };
        const png = cap.png;
        lastShotMonitor.idx = idx;

        // Live on-screen confirmation, fired AFTER the clean capture so the
        // border can never end up in the pixels the being actually sees.
        fireFlash(mon.x, mon.y, mon.width, mon.height, 650);

        // Human audit copy: same pixels, border only. This frame is the
        // OBSERVATION — what the being looked at. Actions get their own frames
        // from computer_input, which is why no click is drawn here any more:
        // drawing them here is what painted an action onto a later page state.
        // Kept at NATIVE resolution — the border is in native-local pixels.
        try {
          await saveAuditFrame(ctx.me, idx, mon, png, buildAuditOverlaySvg(mon.width, mon.height, [], []), '');
        } catch {
          // Best-effort logging must never block the reply to the being.
        }

        // Downscale the copy the BEING sees to a known size (the provider long-
        // edge cap, and on the Gemini path also ctx.heightTarget — see
        // NORMALIZED_COORD_SAFE_HEIGHT). Doing it here means the scale is known exactly and
        // nothing downstream re-shrinks it. On resize failure we fall back to the
        // native bytes AND report native dimensions, so the caption never claims a
        // scaling that was not applied (the computer_input transform recomputes the
        // same screenScale(), so the two only ever disagree in this fallback — in
        // which the caption steers the being to omit screen_index, which is correct
        // for a native image).
        const maxEdge = ctx.maxEdge ?? DEFAULT_SCREENSHOT_MAX_EDGE;
        let scale = screenScale(mon.width, mon.height, maxEdge, ctx.heightTarget);
        let shownBase64 = cap.base64;
        if (scale < 1) {
          try {
            // Resize to the EXACT pixel dimensions the caption will claim, rather
            // than to a `fit: 'inside'` box: a box can only express a long-edge
            // cap, and ctx.heightTarget needs the short edge pinned too. Passing
            // both numbers also removes sharp's own rounding as a second opinion
            // — the bytes and the caption now come from the same arithmetic.
            const shown = await sharp(png)
              .resize({ width: Math.round(mon.width * scale), height: Math.round(mon.height * scale), fit: 'fill' })
              .png()
              .toBuffer();
            shownBase64 = shown.toString('base64');
          } catch {
            scale = 1; // resize failed → being sees native bytes; report as native
          }
        }
        const scaled = scale < 1;
        const shownW = Math.round(mon.width * scale);
        const shownH = Math.round(mon.height * scale);

        console.log(`[computer] ${ctx.me}: screenshot of monitor ${idx} (native ${mon.width}x${mon.height} at ${mon.x},${mon.y}; shown ${scaled ? `${shownW}x${shownH}` : 'native'})`);

        return {
          text: scaled
            // No reason is given for the downscale: it is sometimes transport
            // (maxEdge) and sometimes coordinate safety (heightTarget), and a
            // caption that names the wrong one is a caption that lies.
            ? `Screenshot of monitor ${idx}, shown to you at ${shownW}x${shownH}px (scaled down from this monitor's native ` +
              `${mon.width}x${mon.height}). To act on something you see here, call computer_input with ` +
              `"screen_index": ${idx} and the x,y pixel EXACTLY as you read it off THIS image — NEXUS converts it to the real ` +
              `screen position for you. Do not add any offset or multiply by anything yourself. (Coordinates passed WITHOUT ` +
              `screen_index are treated as raw absolute virtual-desktop pixels, which will NOT match this scaled image — use ` +
              `screen_index here.)`
            : `Screenshot of monitor ${idx} — ${mon.width}x${mon.height} pixels (native, not scaled), top-left at absolute ` +
              `virtual-desktop coordinate (${mon.x}, ${mon.y}). To act on something you see here, call computer_input with ` +
              `"screen_index": ${idx} and the x,y pixel as you read it off this image — NEXUS adds the monitor offset for you. ` +
              `(Or omit screen_index and pass absolute virtual-desktop coordinates: add (${mon.x}, ${mon.y}) yourself.)`,
          image: { base64: shownBase64, mimeType: 'image/png' },
        };
      }

      case 'computer_input': {
        const rawList = Array.isArray(args?.commands) ? args.commands : null;
        if (!rawList || !rawList.length) return { text: 'Error: "commands" must be a non-empty array.' };
        const { resolved, errors } = resolveCommands(rawList);
        if (!resolved.length) {
          return { text: `Error: no valid commands.${errors.length ? ' ' + errors.join('; ') : ''}` };
        }
        // Coordinate space. With screen_index, x/y are pixels AS SEEN in that
        // monitor's screenshot image; convert them to real-screen (absolute
        // virtual-desktop) pixels here, using the SAME screenScale() the
        // screenshot used — so the being never multiplies by its own DPI scale,
        // the single arithmetic a being gets wrong even knowing the factor.
        // Omitted → x/y are already absolute (backward-compatible; correct on a
        // monitor that was not downscaled). The transform runs BEFORE the action
        // frame is captured and before execution, so the audit markers and the
        // live red circle land at the real click position too — which is the
        // "red circle is off on non-100% monitors" bug, same root cause.
        let scaleNote = '';
        let auditMon: ComputerScreen | null = null;
        // Does this batch actually place anything? Same predicate the transform
        // loop below uses, so the two can never disagree about what "positional"
        // means. Keyboard-only batches are untouched by everything here.
        const placesSomething = resolved.some((r) =>
          (r.t === 'move' || r.t === 'down' || r.t === 'up' || r.t === 'click' || r.t === 'wheel')
          && r.x !== undefined && r.y !== undefined);
        // SELF-CORRECTION, free: a 0–1000 space cannot contain a value above
        // 1000, so one DISPROVES the assumption no matter how the model was
        // classified. This is the only cheap guard available here (a value
        // below 1000 proves nothing), and it shrinks "we were wrong about this
        // engine" from "every click is garbage" to "only clicks inside the
        // top-left 1000x1000 are". Harmless for Seed, which never exceeds 1000.
        const overflows = resolved.some((r) =>
          (r.x !== undefined && r.x > 1000) || (r.y !== undefined && r.y > 1000));
        const normalized = ctx.normalizedCoords === true && !overflows;
        // For a normalized model, screen_index stops being optional: 0–1000 is a
        // FRACTION, meaningless until NEXUS knows which monitor it is a fraction
        // of, and never a valid absolute desktop pixel. Letting it through puts
        // every click in the top-left corner — and a transform that only runs
        // when the model happens to pass an optional argument is worse than one
        // that says what it needs, because "sometimes correct" reads as random.
        // MEASURED before shipping: of 413 stored computer_input calls, 190
        // carry coordinates with NO screen_index — every one of them on a CLOUD
        // model (Claude / Gemini / DeepSeek), which this branch never reaches.
        // The single local-engine call in the whole corpus passed the index.
        if (normalized && placesSomething && !Number.isFinite(args?.screen_index)) {
          return { text: 'Error: this model reports positions in a 0–1000 normalized space, which NEXUS can only place once it knows the monitor. Call computer_screenshot (it reports the monitor it captured), then pass that number as "screen_index" alongside the same x/y. No input was sent.' };
        }
        if (Number.isFinite(args?.screen_index)) {
          const sIdx = Math.trunc(args.screen_index);
          const screens = await listComputerScreens();
          const mon = screens.find((s) => s.index === sIdx);
          if (!mon) {
            return { text: `Error: screen_index ${sIdx} does not match any monitor — call computer_screens first (there are ${screens.length}, indices 0..${Math.max(0, screens.length - 1)}). No input was sent.` };
          }
          auditMon = mon;
          // Same four arguments the screenshot used — including ctx.heightTarget.
          // If these two calls ever disagree, every screen_index click lands off.
          const scale = screenScale(mon.width, mon.height, ctx.maxEdge ?? DEFAULT_SCREENSHOT_MAX_EDGE, ctx.heightTarget);
          // Normalized-coordinate models (Seed 2.x, and every LOCAL vision
          // engine — measured 2026-10-11) report x,y in a 0–1000 space that
          // ignores image size; recover the real-screen pixel directly as
          // (reported / 1000 × monitor dimension). screenScale cancels out here
          // (the model never saw pixels), so the normalized branch does NOT use
          // `scale` at all — it is an exact identity, no fitted constant.
          // `normalized` is decided ABOVE, where the >1000 self-correction and
          // the screen_index requirement live; do not re-derive it here.
          for (const r of resolved) {
            if ((r.t === 'move' || r.t === 'down' || r.t === 'up' || r.t === 'click' || r.t === 'wheel') && r.x !== undefined && r.y !== undefined) {
              if (normalized) {
                r.x = Math.round((r.x / 1000) * mon.width) + mon.x;
                r.y = Math.round((r.y / 1000) * mon.height) + mon.y;
              } else {
                r.x = Math.round(r.x / scale) + mon.x;
                r.y = Math.round(r.y / scale) + mon.y;
              }
            }
          }
          scaleNote = normalized
            ? `Coordinates were read as a 0–1000 normalized position and mapped to monitor ${sIdx} (${mon.width}×${mon.height}, plus offset ${mon.x},${mon.y}) on the real screen.`
            : scale < 1
              ? `Coordinates were read as monitor ${sIdx} image pixels and scaled ×${(1 / scale).toFixed(3)} (plus offset ${mon.x},${mon.y}) to the real screen.`
              : `Coordinates were read as monitor ${sIdx} pixels (plus offset ${mon.x},${mon.y}); this monitor is not scaled.`;
        }
        // THE ACTION FRAME IS CAPTURED HERE — before a single event is sent, so
        // the picture shows the screen the commands are about to act on rather
        // than whatever it became afterwards. That ordering IS the fix; drawing
        // on a later capture is what put a click on a button nobody pressed.
        // Everything below is best-effort: a failed capture must never stop the
        // input, which is the real work.
        if (!auditMon) {
          // No screen_index. Take the monitor the commands point at; for a batch
          // with no position at all (keys only) fall back to the monitor the
          // being last looked at, then primary. Costs an enumeration, paid only
          // on this path.
          const withXY = resolved.find((r) => r.x !== undefined && r.y !== undefined);
          const screens = await listComputerScreens();
          auditMon =
            (withXY
              ? screens.find((s) => withXY.x! >= s.x && withXY.x! < s.x + s.width && withXY.y! >= s.y && withXY.y! < s.y + s.height)
              : screens.find((s) => s.index === lastShotMonitor.idx)) ||
            screens.find((s) => s.primary) ||
            screens[0] ||
            null;
        }
        let auditPng: Buffer | null = null;
        if (auditMon) {
          try {
            auditPng = (await captureMonitorPng(auditMon)).png;
          } catch {
            // Losing the frame is acceptable; losing the action is not.
          }
        }
        console.log(`[computer] ${ctx.me}: ${resolved.length} input command(s) — ${resolved.map((r) => r.t).join(', ')}`);
        const script = buildInputScript(resolved);
        const run = await runPS(script, 30000, 4 * 1024 * 1024, true);
        // Written even when execution failed: a frame showing what was ATTEMPTED
        // is exactly what a human needs when nothing happened on screen.
        if (auditPng && auditMon) {
          try {
            const { marks, stack } = planAuditOverlay(resolved, auditMon, ctx.language === 'ja');
            await saveAuditFrame(
              ctx.me, auditMon.index, auditMon, auditPng,
              buildAuditOverlaySvg(auditMon.width, auditMon.height, marks, stack), '_input',
            );
          } catch {
            // Best-effort logging must never block the reply to the being.
          }
        }
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
        if (scaleNote) parts.push(scaleNote);
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
        // UIPI blocks sender→target only when the TARGET sits HIGHER. Equal
        // levels — the normal case, and EVERY case on a machine with UAC
        // disabled — have no boundary to cross, so there is nothing to say.
        // Warning on the target alone made this fire unconditionally there.
        if (fg && typeof fg.priv === 'string') {
          const [sRid, sElev, tRid, tElev] = String(fg.priv).split(',').map((n) => Number(n));
          const known = Number.isFinite(sRid) && Number.isFinite(tRid) && sRid >= 0 && tRid >= 0;
          const higher = known ? tRid > sRid : tElev === 1 && sElev === 0;
          if (higher) {
            const lvl = (rid: number, elev: number) =>
              rid >= 0
                ? { 0: 'untrusted', 0x1000: 'low', 0x2000: 'medium', 0x2100: 'medium+', 0x3000: 'high', 0x4000: 'system' }[rid] ||
                  `0x${rid.toString(16)}`
                : elev === 1
                  ? 'elevated'
                  : 'unknown';
            parts.push(
              `That window's process runs at a higher privilege level than this tool (target ${lvl(tRid, tElev)} ` +
              `vs this tool ${lvl(sRid, sElev)}) — Windows UIPI drops synthesized input across that boundary ` +
              'silently: SendInput can still report success even though nothing was delivered. If input to this ' +
              'app is not visibly working, this is very likely why; it cannot be fixed from inside this tool. ' +
              'Ask the human to either run the target app without elevation, or run Nexus itself elevated to match.',
            );
          }
        }
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
