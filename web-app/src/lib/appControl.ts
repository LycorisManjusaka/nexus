/**
 * App Control (アプリ操作) — driving Windows applications through UI Automation.
 *
 * This is NOT a replacement for computerTools.ts. The two are different senses:
 *
 *   computer_*  sees pixels and aims at coordinates. It reaches ANYTHING that is
 *               drawn on the screen — games, canvases, remote desktops — and it
 *               needs eyes to aim.
 *   app_*       sees a tree of named controls and addresses them by identity. It
 *               reaches only applications that publish an accessibility tree, and
 *               it needs NO eyes at all — the tree is plain text.
 *
 * So a vision-less vessel can use app_* and cannot use computer_*, and a game can
 * be driven by computer_* and is completely invisible to app_*. Neither one is the
 * better version of the other. They are meant to be held at the same time.
 *
 * ── what a write actually disturbs (all measured on this machine, 2026-09-15) ──
 *
 * The cursor NEVER moves. Not once, in any probe: it read 1117,879 before and
 * after every single operation. That is the property computer_input cannot have,
 * because its whole method is moving the pointer.
 *
 * The KEYBOARD FOCUS does move, and this is the honest caveat:
 *   - ValuePattern.SetValue on a minimized window: text lands, window STAYS
 *     minimized, but the foreground moves to the target's child control. The
 *     focused window can therefore be invisible — the human keeps typing into
 *     nothing. That is worse than a visible steal, not better.
 *   - InvokePattern.Invoke: also RESTORES the window (un-minimizes it).
 *   - Every read (tree walk, property read, value read) disturbs nothing at all.
 *
 * Both are repairable and this module repairs them by default:
 *   - foreground is captured before the action and handed back after
 *     (SetForegroundWindow returned True and the handback verified),
 *   - if the action un-minimized a window, it is put back (keep_background).
 * Both repairs are VERIFIED and REPORTED, never assumed. When a handback fails
 * the being is told so, because a silent failure here is a stolen keyboard.
 *
 * ── traps this code is shaped around (measured, do not re-learn) ──
 *
 *  - IsOffscreen LIES. A minimized window's element reported IsOffscreen=False
 *    while its rect was (-31994,-31925). Visibility is decided from IsIconic /
 *    WindowVisualState, never from IsOffscreen.
 *  - STALE REFS DO NOT THROW. After the owning process died, reading
 *    element.Current.Name returned '' with no exception. So every act
 *    re-resolves the element and re-verifies its identity; a silent empty string
 *    is exactly the failure shape that otherwise passes for success.
 *  - `Add-Type -ErrorAction SilentlyContinue` swallows C# compile errors, so the
 *    helper type is explicitly checked for existence before use.
 *  - Minimized windows cannot be captured: GetWindowRect returns a ghost rect.
 *    app_shot refuses instead of returning a black image.
 *  - Elevated targets are UNMEASURED here. SendInput is known to be dropped into
 *    higher-integrity processes (UIPI); whether UIA is, was never tested. Do not
 *    let anything in this file imply an answer.
 *
 * Audit trail: an action that never moves the cursor has no click circle to
 * show, so each successful act flashes the target element's own rectangle on the
 * real screen (same GDI marker computer_input uses) and appends a line to
 * local_data/beings/<name>/computer_control_logs/app_control.jsonl. When the
 * target is minimized there is nothing to draw, and the report says so rather
 * than quietly skipping it.
 */

import path from 'path';
import fsp from 'fs/promises';
import sharp from 'sharp';
import { DPI_PREFIX, runPS, fireFlash } from './computerTools';
import { beingComputerLogsDir } from './beingPaths';

export const APP_TOOL_NAMES = ['app_windows', 'app_inspect', 'app_act', 'app_shot'] as const;

export interface AppToolCtx {
  /** Entity name — used for the per-being audit log. */
  me: string;
  instructions?: Record<string, string>;
}

export interface AppToolResult {
  text: string;
  image?: { base64: string; mimeType: string };
}

const ACT_ACTIONS = ['invoke', 'set_text', 'toggle', 'select', 'expand', 'collapse', 'focus', 'scroll_into_view', 'read'] as const;
type ActAction = (typeof ACT_ACTIONS)[number];

// ── ref bookkeeping ─────────────────────────────────────────────────────────
// A live UIA element pointer cannot outlive the PowerShell process that made it,
// so a ref is a RECIPE for finding the element again: which window, which path
// of child indices, and what the element looked like when we saw it. app_act
// re-walks the path in a fresh process and refuses to act if the identity no
// longer matches.

interface RefRec {
  path: number[];
  type: string;
  id: string;
  name: string;
}

interface Snapshot {
  hwnd: string;
  title: string;
  takenAt: number;
  refs: Map<string, RefRec>;
}

const snapshots = new Map<string, Snapshot>();

// ── shared PowerShell preamble ──────────────────────────────────────────────

const UIA_PREFIX = DPI_PREFIX + `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$nxSig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class NxA {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int procId);
}
'@
Add-Type -TypeDefinition $nxSig -ErrorAction SilentlyContinue
if (-not ([System.Management.Automation.PSTypeName]'NxA').Type) { Write-Output "FATAL=helper_type_failed_to_compile"; exit 1 }
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
function NxClean([string]$s) { if ($s -eq $null) { return "" }; return ($s -replace "[\`t\`r\`n]", " ") }
function NxState([IntPtr]$h) {
  if ([NxA]::IsIconic($h)) { return "minimized" }
  if (-not [NxA]::IsWindowVisible($h)) { return "hidden" }
  if ([NxA]::IsZoomed($h)) { return "maximized" }
  return "normal"
}
function NxCaption([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][NxA]::GetWindowText($h, $sb, 512)
  return (NxClean $sb.ToString())
}
function NxProc([IntPtr]$h) {
  $p = 0
  [void][NxA]::GetWindowThreadProcessId($h, [ref]$p)
  $n = "?"
  try { $n = (Get-Process -Id $p -ErrorAction Stop).ProcessName } catch {}
  return ("" + $n + ":" + $p)
}
`;

function psQuote(s: string): string {
  return `'${String(s ?? '').replace(/'/g, "''")}'`;
}

/** Parse `KEY=value` lines into a map (last one wins). */
function kv(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return out;
}

async function logAct(me: string, entry: Record<string, unknown>) {
  try {
    const dir = beingComputerLogsDir(me);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(
      path.join(dir, 'app_control.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n',
      'utf8',
    );
  } catch { /* the audit log must never break the action it is recording */ }
}

// ── window enumeration ──────────────────────────────────────────────────────

interface WinRec {
  hwnd: string;
  state: string;
  x: number; y: number; w: number; h: number;
  proc: string;
  cls: string;
  title: string;
  /**
   * What UIA calls the window, when that is not what its title bar says.
   * Measured 2026-09-15: a WPF window whose Content is a TextBox reports the
   * *textbox text* as its UIA Name, so a tree-only listing would show a title
   * no human can see anywhere on screen. The caption wins; this is kept so a
   * search for the name seen inside the tree still resolves.
   */
  uia: string;
}

async function listWindows(): Promise<{ ok: boolean; wins: WinRec[]; error?: string }> {
  const script = UIA_PREFIX + `
$root = [System.Windows.Automation.AutomationElement]::RootElement
$c = $walker.GetFirstChild($root)
while ($c -ne $null) {
  try {
    $h = [IntPtr]$c.Current.NativeWindowHandle
    $u = NxClean $c.Current.Name
    $t = NxCaption $h
    if ($t -eq "") { $t = $u }
    if ($h -ne [IntPtr]::Zero -and $t -ne "") {
      $r = $c.Current.BoundingRectangle
      $st = NxState $h
      $x = 0; $y = 0; $w = 0; $hh = 0
      try { $x = [int]$r.X; $y = [int]$r.Y; $w = [int]$r.Width; $hh = [int]$r.Height } catch {}
      Write-Output ("W\`t" + $h + "\`t" + $st + "\`t" + $x + "\`t" + $y + "\`t" + $w + "\`t" + $hh + "\`t" + (NxProc $h) + "\`t" + (NxClean $c.Current.ClassName) + "\`t" + $u + "\`t" + $t)
    }
  } catch {}
  $c = $walker.GetNextSibling($c)
}
`;
  const res = await runPS(script, 30000);
  if (!res.ok) return { ok: false, wins: [], error: res.error };
  const wins: WinRec[] = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    const p = line.split('\t');
    if (p[0] !== 'W' || p.length < 11) continue;
    const uia = p[9] || '';
    const title = p.slice(10).join('\t') || uia;
    wins.push({
      hwnd: p[1], state: p[2],
      x: Number(p[3]) || 0, y: Number(p[4]) || 0, w: Number(p[5]) || 0, h: Number(p[6]) || 0,
      proc: p[7], cls: p[8], title, uia: uia === title ? '' : uia,
    });
  }
  return { ok: true, wins };
}

/**
 * Resolve the `window` argument, which is deliberately forgiving: an hwnd
 * exactly as app_windows printed it, or any case-insensitive part of a title.
 * An ambiguous match is an error with the candidates listed — never a guess,
 * because guessing here means typing into the wrong application.
 */
function resolveWindow(arg: string, wins: WinRec[]): { win?: WinRec; error?: string } {
  const q = String(arg ?? '').trim();
  if (!q) return { error: 'Error: the "window" argument is required. Call app_windows first.' };
  const byHwnd = wins.find((w) => w.hwnd === q);
  if (byHwnd) return { win: byHwnd };
  const lower = q.toLowerCase();
  const hits = wins.filter(
    (w) => w.title.toLowerCase().includes(lower) || (w.uia && w.uia.toLowerCase().includes(lower)),
  );
  if (hits.length === 1) return { win: hits[0] };
  if (hits.length === 0) {
    return { error: `Error: no open window matches "${q}". Call app_windows to see what is actually open — the title may have changed, or the window may have closed.` };
  }
  const list = hits.slice(0, 8).map((w) => `  hwnd=${w.hwnd}  ${w.proc}  "${w.title}"`).join('\n');
  return { error: `Error: "${q}" matches ${hits.length} windows. Pass the exact hwnd instead:\n${list}` };
}

// ── tree inspection ─────────────────────────────────────────────────────────

const DEFAULT_MAX_NODES = 200;
const HARD_MAX_NODES = 800;
const DEFAULT_MAX_DEPTH = 12;

/**
 * Translate the UIA patterns an element advertises into the action words
 * app_act actually takes. "readonly" is not an action — it is reported
 * separately, because an element that has a value you can read but not write
 * is a different situation from one with no value at all.
 */
const PATTERN_ACTIONS: Record<string, string[]> = {
  invoke: ['invoke'],
  value: ['set_text', 'read'],
  toggle: ['toggle'],
  select: ['select'],
  expand: ['expand', 'collapse'],
  scroll: ['scroll_into_view'],
  text: ['read'],
  focusable: ['focus'],
  readonly: [],
};

function actionsFor(acts: string): string {
  const out: string[] = [];
  for (const a of String(acts || '').split(',')) {
    for (const act of PATTERN_ACTIONS[a.trim()] || []) if (!out.includes(act)) out.push(act);
  }
  return out.join(',');
}

async function inspectWindow(
  win: WinRec,
  opts: { maxNodes: number; maxDepth: number; filter: string; fromPath?: number[] },
): Promise<{ ok: boolean; lines: string[]; refs: Map<string, RefRec>; truncated: boolean; walked: number; ms: number; error?: string }> {
  const fromPath = opts.fromPath && opts.fromPath.length ? opts.fromPath.join('.') : '';
  const script = UIA_PREFIX + `
$win = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]${win.hwnd})
if ($win -eq $null) { Write-Output "FATAL=window_gone"; exit 0 }
$start = $win
$fromPath = ${psQuote(fromPath)}
if ($fromPath -ne "") {
  foreach ($seg in $fromPath.Split(".")) {
    $i = [int]$seg
    $ch = $walker.GetFirstChild($start)
    $k = 0
    while ($ch -ne $null -and $k -lt $i) { $ch = $walker.GetNextSibling($ch); $k++ }
    if ($ch -eq $null) { Write-Output "FATAL=subtree_gone"; exit 0 }
    $start = $ch
  }
}
$maxNodes = ${opts.maxNodes}
$maxDepth = ${opts.maxDepth}
$script:walked = 0
$script:emitted = 0
$script:truncated = $false
$patProps = @(
  @("invoke",   [System.Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty),
  @("value",    [System.Windows.Automation.AutomationElement]::IsValuePatternAvailableProperty),
  @("toggle",   [System.Windows.Automation.AutomationElement]::IsTogglePatternAvailableProperty),
  @("select",   [System.Windows.Automation.AutomationElement]::IsSelectionItemPatternAvailableProperty),
  @("expand",   [System.Windows.Automation.AutomationElement]::IsExpandCollapsePatternAvailableProperty),
  @("scroll",   [System.Windows.Automation.AutomationElement]::IsScrollItemPatternAvailableProperty),
  @("text",     [System.Windows.Automation.AutomationElement]::IsTextPatternAvailableProperty),
  @("focusable",[System.Windows.Automation.AutomationElement]::IsKeyboardFocusableProperty)
)
function Emit($el, [string]$p, [int]$depth) {
  $acts = @()
  foreach ($pp in $patProps) {
    try { if ($el.GetCurrentPropertyValue($pp[1]) -eq $true) { $acts += $pp[0] } } catch {}
  }
  $ty = "?"; $id = ""; $nm = ""; $en = "?"
  try { $ty = $el.Current.ControlType.ProgrammaticName.Replace("ControlType.","") } catch {}
  try { $id = NxClean $el.Current.AutomationId } catch {}
  try { $nm = NxClean $el.Current.Name } catch {}
  try { $en = "" + $el.Current.IsEnabled } catch {}
  $x = 0; $y = 0; $w = 0; $h = 0
  try { $r = $el.Current.BoundingRectangle; $x = [int]$r.X; $y = [int]$r.Y; $w = [int]$r.Width; $h = [int]$r.Height } catch {}
  $val = ""
  try {
    if ($acts -contains "value") {
      $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $val = NxClean $vp.Current.Value
      if ($val.Length -gt 200) { $val = $val.Substring(0,200) + "..." }
      if ($vp.Current.IsReadOnly) { $acts = @($acts | Where-Object { $_ -ne "value" }) + "readonly" }
    }
  } catch {}
  Write-Output ("E\`t" + $p + "\`t" + $depth + "\`t" + $ty + "\`t" + $id + "\`t" + $nm + "\`t" + $x + "\`t" + $y + "\`t" + $w + "\`t" + $h + "\`t" + $en + "\`t" + ($acts -join ",") + "\`t" + $val)
  $script:emitted++
}
function Walk($el, [string]$prefix, [int]$depth) {
  if ($depth -ge $maxDepth) { return }
  $c = $walker.GetFirstChild($el)
  $i = 0
  while ($c -ne $null) {
    if ($script:walked -ge $maxNodes) { $script:truncated = $true; return }
    $script:walked++
    $p = if ($prefix -eq "") { "" + $i } else { $prefix + "." + $i }
    Emit $c $p $depth
    Walk $c $p ($depth + 1)
    if ($script:truncated) { return }
    $c = $walker.GetNextSibling($c)
    $i++
  }
}
$sw = [Diagnostics.Stopwatch]::StartNew()
Walk $start "" 0
$sw.Stop()
Write-Output ("STATS=" + $script:walked + "," + $script:emitted + "," + $sw.ElapsedMilliseconds + "," + $script:truncated)
`;
  const res = await runPS(script, 90000, 16 * 1024 * 1024);
  if (!res.ok) return { ok: false, lines: [], refs: new Map(), truncated: false, walked: 0, ms: 0, error: res.error };

  const refs = new Map<string, RefRec>();
  const lines: string[] = [];
  let walked = 0, ms = 0, truncated = false;
  let n = 0;
  const filt = String(opts.filter || '').trim().toLowerCase();

  for (const line of res.stdout.split(/\r?\n/)) {
    if (line.startsWith('FATAL=')) {
      const why = line.slice(6);
      return {
        ok: false, lines: [], refs, truncated: false, walked: 0, ms: 0,
        error: why === 'window_gone'
          ? 'the window no longer exists (it was closed between app_windows and now)'
          : why === 'subtree_gone'
            ? 'that ref no longer resolves — the window rearranged itself. Call app_inspect on the window again.'
            : why,
      };
    }
    if (line.startsWith('STATS=')) {
      const s = line.slice(6).split(',');
      walked = Number(s[0]) || 0; ms = Number(s[2]) || 0; truncated = String(s[3]).toLowerCase() === 'true';
      continue;
    }
    const p = line.split('\t');
    if (p[0] !== 'E' || p.length < 12) continue;
    const [, epath, depth, type, id, name, x, y, w, h, enabled, acts] = p;
    const val = p.slice(12).join('\t');

    if (filt) {
      const hay = `${type} ${id} ${name} ${val}`.toLowerCase();
      if (!hay.includes(filt)) continue;
    }
    const ref = `e${n++}`;
    refs.set(ref, {
      path: (opts.fromPath || []).concat(epath.split('.').map((s) => Number(s) || 0)),
      type, id, name,
    });
    const indent = '  '.repeat(Math.min(Number(depth) || 0, 10));
    const bits: string[] = [];
    if (id) bits.push(`id=${id}`);
    bits.push(`${w}x${h} at ${x},${y}`);
    if (enabled === 'False') bits.push('DISABLED');
    // The header promises "can: is what app_act will accept", so print the
    // action names, not the UIA pattern names behind them — otherwise the line
    // says "value" for something you address as set_text, and the promise is a
    // small lie you only discover by having a call refused.
    const canon = actionsFor(acts);
    if (canon) bits.push(`can: ${canon}`);
    if (/(^|,)readonly(,|$)/.test(acts)) bits.push('readonly');
    lines.push(
      `${indent}[${ref}] ${type}${name ? ` "${name}"` : ''}  ${bits.join('  ')}` +
      (val ? `\n${indent}      value: ${val}` : ''),
    );
  }
  return { ok: true, lines, refs, truncated, walked, ms };
}

// ── acting ──────────────────────────────────────────────────────────────────

async function actOnRef(
  win: WinRec,
  rec: RefRec,
  action: ActAction,
  text: string,
  keepBackground: boolean,
): Promise<{ ok: boolean; info: Record<string, string>; error?: string }> {
  const isWrite = action !== 'read';
  const script = UIA_PREFIX + `
$hwnd = [IntPtr]${win.hwnd}
$win = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
if ($win -eq $null) { Write-Output "FATAL=window_gone"; exit 0 }
$fgBefore = [NxA]::GetForegroundWindow()
$stateBefore = NxState $hwnd
Write-Output ("FG_BEFORE=" + $fgBefore)
Write-Output ("STATE_BEFORE=" + $stateBefore)

$el = $win
foreach ($seg in ${psQuote(rec.path.join('.'))}.Split(".")) {
  $i = [int]$seg
  $ch = $walker.GetFirstChild($el)
  $k = 0
  while ($ch -ne $null -and $k -lt $i) { $ch = $walker.GetNextSibling($ch); $k++ }
  if ($ch -eq $null) { Write-Output "FATAL=path_gone"; exit 0 }
  $el = $ch
}

# Identity re-check. A dead element does NOT throw - it answers with empty
# strings - so a match on empty everything must not count as a match.
$aType = "?"; $aId = ""; $aName = ""
try { $aType = $el.Current.ControlType.ProgrammaticName.Replace("ControlType.","") } catch {}
try { $aId = NxClean $el.Current.AutomationId } catch {}
try { $aName = NxClean $el.Current.Name } catch {}
Write-Output ("ACTUAL_TYPE=" + $aType)
Write-Output ("ACTUAL_ID=" + $aId)
Write-Output ("ACTUAL_NAME=" + $aName)
$eType = ${psQuote(rec.type)}
$eId = ${psQuote(rec.id)}
$eName = ${psQuote(rec.name)}
if ($aType -ne $eType -or $aId -ne $eId -or $aName -ne $eName) { Write-Output "FATAL=identity_changed"; exit 0 }

$r = $el.Current.BoundingRectangle
$rx = 0; $ry = 0; $rw = 0; $rh = 0
try { $rx = [int]$r.X; $ry = [int]$r.Y; $rw = [int]$r.Width; $rh = [int]$r.Height } catch {}
Write-Output ("RECT=" + $rx + "," + $ry + "," + $rw + "," + $rh)
Write-Output ("ENABLED=" + $el.Current.IsEnabled)

# Capture what is there BEFORE touching it. set_text replaces the whole
# contents, so without this the previous text exists nowhere afterwards —
# learned the hard way: an automated "edit the first editable element" wiped a
# human's unsaved buffer, and the only reason it was recoverable was that a
# copy happened to survive somewhere else. Base64 so newlines survive intact.
try {
  $vpb = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $vb = "" + $vpb.Current.Value
  if ($vb.Length -gt 2000) { $vb = $vb.Substring(0,2000) }
  Write-Output ("VALUE_BEFORE_B64=" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($vb)))
} catch {}

$act = ${psQuote(action)}
$done = $false
try {
  switch ($act) {
    "invoke" { $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); $done = $true }
    "set_text" {
      $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      if ($vp.Current.IsReadOnly) { throw "this element is read-only" }
      $vp.SetValue(${psQuote(text)})
      $done = $true
    }
    "toggle" { $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle(); $done = $true }
    "select" { $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select(); $done = $true }
    "expand" { $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand(); $done = $true }
    "collapse" { $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse(); $done = $true }
    "focus" { $el.SetFocus(); $done = $true }
    "scroll_into_view" { $el.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern).ScrollIntoView(); $done = $true }
    "read" { $done = $true }
  }
  Write-Output ("RESULT=" + $(if ($done) { "ok" } else { "unknown_action" }))
} catch {
  Write-Output ("RESULT=error")
  Write-Output ("ERRMSG=" + (NxClean $_.Exception.Message))
}
Start-Sleep -Milliseconds 300

# read back whatever the element can tell us about itself now.
# Two forms on purpose: a flattened one-liner for the summary note, and the
# untouched bytes in base64 — newlines and tabs are exactly the characters a
# one-line note has to destroy, and they are exactly the ones you need intact
# if you are reading a document rather than glancing at a field.
$got = $false
try {
  $vp2 = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $vraw = "" + $vp2.Current.Value
  $got = $true
} catch {}
if (-not $got) {
  # An element can expose text without exposing a value: multiline Win32 edit
  # controls do exactly this (measured — they carry TextPattern only).
  try {
    $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    $vraw = "" + $tp.DocumentRange.GetText(6000)
    $got = $true
  } catch {}
}
if ($got) {
  if ($vraw.Length -gt 6000) { $vraw = $vraw.Substring(0,6000) }
  Write-Output ("VALUE_AFTER_B64=" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($vraw)))
  $vv = NxClean $vraw
  if ($vv.Length -gt 400) { $vv = $vv.Substring(0,400) + "..." }
  Write-Output ("VALUE_AFTER=" + $vv)
}
try {
  $tg = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
  Write-Output ("TOGGLE_AFTER=" + $tg.Current.ToggleState)
} catch {}
try {
  $ec = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
  Write-Output ("EXPAND_AFTER=" + $ec.Current.ExpandCollapseState)
} catch {}
try {
  $si = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
  Write-Output ("SELECTED_AFTER=" + $si.Current.IsSelected)
} catch {}

$fgAfter = [NxA]::GetForegroundWindow()
$stateAfter = NxState $hwnd
Write-Output ("FG_AFTER=" + $fgAfter)
Write-Output ("STATE_AFTER=" + $stateAfter)

# Put back what the action disturbed, then VERIFY - never assume.
$keepBg = ${keepBackground ? '$true' : '$false'}
if ($keepBg -and $stateBefore -eq "minimized" -and $stateAfter -ne "minimized") {
  try {
    $wp = $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
    $wp.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Minimized)
    Start-Sleep -Milliseconds 300
  } catch { Write-Output ("REMINIMIZE_ERR=" + (NxClean $_.Exception.Message)) }
  Write-Output ("STATE_RESTORED=" + $(if ((NxState $hwnd) -eq "minimized") { "True" } else { "False" }))
}
if ($fgAfter -ne $fgBefore -and $fgBefore -ne [IntPtr]::Zero) {
  [void][NxA]::SetForegroundWindow($fgBefore)
  Start-Sleep -Milliseconds 400
  $fgFinal = [NxA]::GetForegroundWindow()
  Write-Output ("FG_FINAL=" + $fgFinal)
  Write-Output ("FG_RESTORED=" + $(if ($fgFinal -eq $fgBefore) { "True" } else { "False" }))
}
`;
  const res = await runPS(script, 60000, 4 * 1024 * 1024, isWrite);
  if (!res.ok) return { ok: false, info: {}, error: res.error };
  const info = kv(res.stdout);
  if (info.FATAL) {
    const why = info.FATAL;
    return {
      ok: false, info,
      error:
        why === 'window_gone' ? 'the window has closed since app_inspect ran.'
          : why === 'path_gone' ? 'that element is gone — the window rearranged itself. Run app_inspect again to get fresh refs.'
            : why === 'identity_changed'
              ? `that ref now points at a DIFFERENT control (expected ${JSON.stringify(rec.type)}/${JSON.stringify(rec.name)}, found ${JSON.stringify(info.ACTUAL_TYPE || '')}/${JSON.stringify(info.ACTUAL_NAME || '')}). Nothing was done. Run app_inspect again.`
              : why,
    };
  }
  return { ok: true, info };
}

// ── per-window capture ──────────────────────────────────────────────────────

async function shotWindow(win: WinRec, outPath: string): Promise<{ ok: boolean; error?: string; w?: number; h?: number }> {
  const script = UIA_PREFIX + `
Add-Type -AssemblyName System.Drawing
$pwSig = @'
using System;
using System.Runtime.InteropServices;
public class NxPW {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rr, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
}
'@
Add-Type -TypeDefinition $pwSig -ErrorAction SilentlyContinue
if (-not ([System.Management.Automation.PSTypeName]'NxPW').Type) { Write-Output "FATAL=helper_type_failed_to_compile"; exit 1 }
$h = [IntPtr]${win.hwnd}
if ([NxA]::IsIconic($h)) { Write-Output "FATAL=minimized"; exit 0 }
$rc = New-Object NxPW+R
if (-not [NxPW]::GetWindowRect($h, [ref]$rc)) { Write-Output "FATAL=no_rect"; exit 0 }
$w = $rc.Rr - $rc.L
$hh = $rc.B - $rc.T
if ($w -le 0 -or $hh -le 0) { Write-Output "FATAL=empty_rect"; exit 0 }
$bmp = New-Object System.Drawing.Bitmap $w, $hh
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
# flag 2 = PW_RENDERFULLCONTENT. Flag 0 loses DirectComposition content on
# modern WinUI windows (measured: 47% non-black), so it is never used here.
$okPW = [NxPW]::PrintWindow($h, $dc, 2)
$g.ReleaseHdc($dc)
$g.Dispose()
$bmp.Save(${psQuote(outPath)}, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("PRINTWINDOW=" + $okPW)
Write-Output ("SIZE=" + $w + "," + $hh)
`;
  const res = await runPS(script, 45000);
  if (!res.ok) return { ok: false, error: res.error };
  const info = kv(res.stdout);
  if (info.FATAL === 'minimized') {
    return { ok: false, error: 'that window is minimized, and a minimized window cannot be captured — Windows reports a ghost rectangle for it. Either use app_inspect (the tree is still readable while minimized), or ask the human to restore the window.' };
  }
  if (info.FATAL) return { ok: false, error: info.FATAL };
  const [w, h] = String(info.SIZE || '0,0').split(',').map((n) => Number(n) || 0);
  return { ok: true, w, h };
}

// ── tool specs ──────────────────────────────────────────────────────────────

interface AppToolProp { type: string; description: string }
interface AppToolSpec { name: string; description: string; properties: Record<string, AppToolProp>; required: string[] }

export function appToolSpecs(I: Record<string, string>): AppToolSpec[] {
  return [
    {
      name: 'app_windows',
      description: I.toolAppWindowsDesc,
      properties: {},
      required: [],
    },
    {
      name: 'app_inspect',
      description: I.toolAppInspectDesc,
      properties: {
        window: { type: 'string', description: I.appWindowParam },
        ref: { type: 'string', description: I.appInspectRefParam },
        filter: { type: 'string', description: I.appInspectFilterParam },
        max_nodes: { type: 'integer', description: I.appInspectMaxNodesParam },
        max_depth: { type: 'integer', description: I.appInspectMaxDepthParam },
      },
      required: ['window'],
    },
    {
      name: 'app_act',
      description: I.toolAppActDesc,
      properties: {
        window: { type: 'string', description: I.appWindowParam },
        ref: { type: 'string', description: I.appActRefParam },
        action: { type: 'string', description: I.appActActionParam },
        text: { type: 'string', description: I.appActTextParam },
        keep_background: { type: 'boolean', description: I.appActKeepBackgroundParam },
      },
      required: ['window', 'ref', 'action'],
    },
    {
      name: 'app_shot',
      description: I.toolAppShotDesc,
      properties: {
        window: { type: 'string', description: I.appWindowParam },
      },
      required: ['window'],
    },
  ];
}

export function appToolsClaude(I: Record<string, string>) {
  return appToolSpecs(I).map((s) => ({
    name: s.name,
    description: s.description,
    input_schema: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, { type: v.type, description: v.description }])),
      ...(s.required.length ? { required: s.required } : {}),
    },
  }));
}

export function appToolsOpenAI(I: Record<string, string>) {
  return appToolSpecs(I).map((s) => ({
    type: 'function' as const,
    function: {
      name: s.name,
      description: s.description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, { type: v.type, description: v.description }])),
        ...(s.required.length ? { required: s.required } : {}),
      },
    },
  }));
}

/** Gemini shape — UPPERCASE types (see computerToolsGemini for why this matters). */
export function appToolsGemini(I: Record<string, string>) {
  return appToolSpecs(I).map((s) => ({
    name: s.name,
    description: s.description,
    parameters: {
      type: 'OBJECT',
      properties: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, { type: v.type.toUpperCase(), description: v.description }])),
      ...(s.required.length ? { required: s.required } : {}),
    },
  }));
}

// ── executor ────────────────────────────────────────────────────────────────
// One executor, thin call sites — same discipline as runComputerTool and
// runBrowserTool, so a fix can never land on four provider paths out of five.

export async function runAppTool(name: string, args: any, ctx: AppToolCtx): Promise<AppToolResult> {
  const me = ctx?.me || 'Default';
  try {
    switch (name) {
      case 'app_windows': {
        const { ok, wins, error } = await listWindows();
        if (!ok) return { text: `Error: could not enumerate windows (this feature is Windows-only). ${error || ''}`.trim() };
        if (!wins.length) return { text: 'No titled top-level windows are open.' };
        const lines = wins.map((w) =>
          `  hwnd=${w.hwnd}  [${w.state}]  ${w.w}x${w.h} at ${w.x},${w.y}  ${w.proc}  "${w.title}"` +
          (w.uia ? `  (UIA calls it "${w.uia}")` : ''));
        return {
          text:
            `${wins.length} window(s). Pass either the hwnd or a distinctive part of the title as "window".\n` +
            `A [minimized] window can still be inspected and acted on — it just cannot be captured with app_shot.\n` +
            lines.join('\n'),
        };
      }

      case 'app_inspect': {
        const all = await listWindows();
        if (!all.ok) return { text: `Error: could not enumerate windows. ${all.error || ''}`.trim() };
        const { win, error } = resolveWindow(args?.window, all.wins);
        if (!win) return { text: error! };

        let fromPath: number[] | undefined;
        const refArg = String(args?.ref || '').trim();
        if (refArg) {
          const snap = snapshots.get(me);
          const rec = snap && snap.hwnd === win.hwnd ? snap.refs.get(refArg) : undefined;
          if (!rec) {
            return { text: `Error: ref "${refArg}" is not a ref from your latest app_inspect of this window. Refs are only valid until the next app_inspect, and only for the window they came from.` };
          }
          fromPath = rec.path;
        }

        const maxNodes = Math.max(10, Math.min(HARD_MAX_NODES, Number(args?.max_nodes) || DEFAULT_MAX_NODES));
        const maxDepth = Math.max(1, Math.min(30, Number(args?.max_depth) || DEFAULT_MAX_DEPTH));
        const filter = String(args?.filter || '');

        const r = await inspectWindow(win, { maxNodes, maxDepth, filter, fromPath });
        if (!r.ok) return { text: `Error: ${r.error}` };

        // Refs are per-being and replaced wholesale: an old ref must never
        // silently resolve against a newer tree.
        snapshots.set(me, { hwnd: win.hwnd, title: win.title, takenAt: Date.now(), refs: r.refs });

        const head =
          `Window "${win.title}" (${win.proc}, ${win.state}) — walked ${r.walked} node(s) in ${r.ms} ms` +
          (filter ? `, showing ${r.refs.size} matching "${filter}"` : '') + '.';
        const tail = r.truncated
          ? `\n\n(TRUNCATED at ${maxNodes} nodes — this is a partial view. Narrow it with "filter", or start from a ref with "ref", or raise "max_nodes" up to ${HARD_MAX_NODES}.)`
          : '';
        if (!r.lines.length) {
          return {
            text: head + (filter
              ? `\n\nNothing matched. The control may be named differently than it looks — try a shorter filter, or drop "filter" to see the whole tree.`
              : `\n\nThis window publishes no accessibility tree. Some applications (games, custom-drawn canvases, some WinForms apps) draw their own UI and are invisible to app_*. For those, computer_screenshot + computer_input is the only way in.`),
          };
        }
        return {
          text:
            `${head}\nThe "can:" list is what app_act will accept for that ref.\n\n` +
            r.lines.join('\n') + tail +
            `\n\nRefs are valid until your next app_inspect. app_act re-checks each element's identity before acting and refuses if it changed.`,
        };
      }

      case 'app_act': {
        const action = String(args?.action || '').trim().toLowerCase() as ActAction;
        if (!ACT_ACTIONS.includes(action)) {
          return { text: `Error: unknown action "${args?.action}". Valid actions: ${ACT_ACTIONS.join(', ')}.` };
        }
        const all = await listWindows();
        if (!all.ok) return { text: `Error: could not enumerate windows. ${all.error || ''}`.trim() };
        const { win, error } = resolveWindow(args?.window, all.wins);
        if (!win) return { text: error! };

        const refArg = String(args?.ref || '').trim();
        const snap = snapshots.get(me);
        if (!snap || snap.hwnd !== win.hwnd) {
          return { text: `Error: you have no current inspection of this window. Call app_inspect on it first — refs only exist relative to a specific inspection.` };
        }
        const rec = snap.refs.get(refArg);
        if (!rec) {
          return { text: `Error: ref "${refArg}" is not in your latest app_inspect of "${win.title}". Call app_inspect again and use a ref from that result.` };
        }
        const text = String(args?.text ?? '');
        if (action === 'set_text' && !text) {
          return { text: 'Error: action "set_text" needs a "text" argument. To clear a field, pass an empty string explicitly via text:"" — this guard exists so an omitted argument never silently erases something.' };
        }
        const keepBackground = args?.keep_background !== false;

        const r = await actOnRef(win, rec, action, text, keepBackground);
        if (!r.ok) {
          await logAct(me, { tool: 'app_act', window: win.title, hwnd: win.hwnd, ref: refArg, action, ok: false, error: r.error });
          return { text: `Nothing was done: ${r.error}` };
        }
        const i = r.info;
        const [rx, ry, rw, rh] = String(i.RECT || '0,0,0,0').split(',').map((n) => Number(n) || 0);

        // The visible mark. An action that never moves the cursor has no click
        // circle, so the element's own rectangle is what gets flashed — and when
        // there is nothing to flash, that is said out loud rather than skipped.
        const visible = i.STATE_BEFORE !== 'minimized' && i.STATE_BEFORE !== 'hidden' && rw > 0 && rh > 0 && rx > -30000 && ry > -30000;
        if (visible && action !== 'read') fireFlash(rx, ry, rw, rh, 900);

        let prevText = '';
        if (i.VALUE_BEFORE_B64) {
          try { prevText = Buffer.from(i.VALUE_BEFORE_B64, 'base64').toString('utf8'); } catch { /* not fatal */ }
        }

        const notes: string[] = [];
        if (i.RESULT === 'error') {
          notes.push(`The action FAILED: ${i.ERRMSG || 'unknown error'}`);
          if (i.ENABLED === 'False') notes.push('That element is disabled — IsEnabled was already False before the attempt.');
        }
        let nowText = '';
        if (i.VALUE_AFTER_B64) {
          try { nowText = Buffer.from(i.VALUE_AFTER_B64, 'base64').toString('utf8'); } catch { /* not fatal */ }
        }
        // For `read` the point IS the exact characters, so give them verbatim.
        // For every other action this is a glance, and a flattened line is kinder.
        if (action === 'read' && nowText) {
          notes.push(`contents (${nowText.length} characters, exactly as stored):\n---8<---\n${nowText}\n---8<---`);
        } else if (i.VALUE_AFTER !== undefined) {
          notes.push(`value now: ${i.VALUE_AFTER}`);
        }
        if (i.TOGGLE_AFTER) notes.push(`toggle state now: ${i.TOGGLE_AFTER}`);
        if (i.EXPAND_AFTER) notes.push(`expand state now: ${i.EXPAND_AFTER}`);
        if (i.SELECTED_AFTER) notes.push(`selected: ${i.SELECTED_AFTER}`);

        const disturb: string[] = [];
        if (i.FG_AFTER && i.FG_BEFORE && i.FG_AFTER !== i.FG_BEFORE) {
          if (i.FG_RESTORED === 'True') disturb.push('keyboard focus was taken by this action and has been handed back to the window that had it');
          else disturb.push('WARNING: this action took the keyboard focus and it could NOT be handed back — the human at the machine may now be typing into a different window than they expect. Tell them.');
        } else {
          disturb.push('keyboard focus unchanged');
        }
        if (i.STATE_BEFORE === 'minimized') {
          if (i.STATE_AFTER !== 'minimized') {
            disturb.push(i.STATE_RESTORED === 'True'
              ? 'the window popped up and has been put back to minimized'
              : 'WARNING: the window was minimized, this action un-minimized it, and it could not be minimized again — it is now on screen');
          } else {
            disturb.push('the window stayed minimized');
          }
        }
        disturb.push(visible && action !== 'read'
          ? 'a red rectangle was flashed around the element on the real screen'
          : action === 'read' ? 'no marker (reads are not marked)'
            : 'NO marker could be drawn — the target is not visible on screen, so this action left no trace the human could see');
        disturb.push('the mouse cursor did not move');

        await logAct(me, {
          tool: 'app_act', window: win.title, hwnd: win.hwnd, ref: refArg,
          element: `${rec.type} "${rec.name}"${rec.id ? ` id=${rec.id}` : ''}`,
          action, text: action === 'set_text' ? text.slice(0, 200) : undefined,
          previousValue: action === 'set_text' ? prevText.slice(0, 2000) : undefined,
          ok: i.RESULT === 'ok', error: i.ERRMSG,
          focusTaken: i.FG_AFTER !== i.FG_BEFORE, focusRestored: i.FG_RESTORED,
          stateBefore: i.STATE_BEFORE, stateAfter: i.STATE_AFTER, marked: visible && action !== 'read',
        });

        const verb = action === 'read' ? 'Read' : i.RESULT === 'ok' ? 'Done' : 'FAILED';
        return {
          text:
            `${verb}: ${action} on [${refArg}] ${rec.type}${rec.name ? ` "${rec.name}"` : ''} in "${win.title}".\n` +
            (action === 'set_text' && i.RESULT === 'ok'
              ? `\nThe contents BEFORE this write were:\n---8<---\n${prevText}\n---8<---\nset_text replaces everything, so this is the only remaining copy. If you replaced something that was not yours to replace, put it back with set_text using exactly the text above.\n`
              : '') +
            (notes.length ? notes.join('\n') + '\n' : '') +
            `\nWhat this disturbed: ${disturb.join('; ')}.` +
            (i.RESULT === 'ok' && action !== 'read'
              ? `\n\nThe call succeeded — that means the application accepted the request, not that it did what you wanted. Verify with app_inspect.`
              : ''),
        };
      }

      case 'app_shot': {
        const all = await listWindows();
        if (!all.ok) return { text: `Error: could not enumerate windows. ${all.error || ''}`.trim() };
        const { win, error } = resolveWindow(args?.window, all.wins);
        if (!win) return { text: error! };

        const dir = beingComputerLogsDir(me);
        await fsp.mkdir(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const raw = path.join(dir, `app_shot_${stamp}.png`);
        const r = await shotWindow(win, raw);
        if (!r.ok) return { text: `Error: ${r.error}` };

        let buf: Buffer<ArrayBufferLike> = await fsp.readFile(raw);
        let note = '';
        if ((r.w || 0) > 1568) {
          buf = await sharp(buf).resize({ width: 1568 }).png().toBuffer();
          note = ` (downscaled from ${r.w}x${r.h} for transport — do not read coordinates off this image; app_* addresses controls by ref, not by pixel)`;
        }
        await logAct(me, { tool: 'app_shot', window: win.title, hwnd: win.hwnd, file: raw, size: `${r.w}x${r.h}` });
        return {
          text: `Captured the window "${win.title}" (${win.proc}), ${r.w}x${r.h}${note}. This is the window's own pixels — it works even when the window is behind others. Saved for the human at ${raw}.`,
          image: { base64: buf.toString('base64'), mimeType: 'image/png' },
        };
      }

      default:
        return { text: `Error: unknown app tool "${name}".` };
    }
  } catch (e: any) {
    return { text: `Error running ${name}: ${String(e?.message || e).slice(0, 400)}` };
  }
}
