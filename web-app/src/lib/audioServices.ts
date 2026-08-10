import fs from 'fs';
import fsp from 'fs/promises';
import net from 'net';
import os from 'os';
import path from 'path';
import { spawn, execFile } from 'child_process';

// Start/stop/monitor the local helper processes that make up an "audio session"
// — the voice changer or logger, the ear logger, and the speech-recognition
// clients that feed them.
//
// WHY A GENERIC SERVICE LIST RATHER THAN HARD-CODED PROFILES
// The two workflows (VRChat on the personal PC, Teams on the work PC) differ in
// which processes run, where they're installed, and which mic each recognizer
// listens to. Hard-coding either one would be wrong on the other machine. So a
// service is just: how to start it, and how to tell whether it's already up.
//
// WHY KEYED BY HOSTNAME
// local_data syncs between machines via rclone. A single flat list would carry
// the personal PC's C:\dev\recognize-main paths to the work PC, where they
// don't exist. Keying by hostname lets one synced file hold both machines'
// setups, each seeing only its own.

const DATA_DIR = path.resolve(process.cwd(), '..', 'local_data');
const SERVICES_FILE = path.join(DATA_DIR, 'audio_services.json');

export type ServiceKind = 'exe' | 'python' | 'bat';
export type ProbeType = 'tcp' | 'process';

export interface ServiceProbe {
  type: ProbeType;
  /** tcp: the port it listens on. */
  port?: number;
  /**
   * process: a substring that must appear in the process command line.
   * Required when two copies of the SAME executable run side by side — the two
   * recognizers are distinguished only by their --out_yukacone port.
   */
  match?: string;
}

export interface ServiceDef {
  id: string;
  label: string;
  kind: ServiceKind;
  path: string;
  args?: string[];
  /** Defaults to the directory containing `path`. */
  cwd?: string;
  probe: ServiceProbe;
  /** Included when starting/stopping the whole session. */
  enabled?: boolean;
  /**
   * Microphone selected BY NAME. Resolved to the current `--mic <index>` at
   * launch time.
   *
   * Storing the index is actively unsafe: plugging in any audio device
   * renumbers the list. Measured on this machine, the saved configs said
   * mic 1 = "Microphone (Steam Streaming Mic" and mic 2 = "CABLE-A Output",
   * while recognize.exe --print_mics now reports those two swapped — so the
   * stored indices had silently come to mean each other's device.
   */
  micName?: string;
  /**
   * Launch in a visible console window instead of headless.
   *
   * These tools are interactive: the recognizers draw live mic levels and the
   * voice changer prints its device banner and connection log. That output IS
   * the status display — hiding it removes the only way to tell a working
   * service from a wedged one. It also loses startup errors entirely, which is
   * how a crash-before-bind looks identical to a slow boot.
   */
  showConsole?: boolean;
}

export interface ServiceStatus extends ServiceDef {
  running: boolean;
  pid?: number;
  pathExists: boolean;
}

/**
 * Windows Explorer's "Copy as path" wraps paths in quotes; a pasted value would
 * otherwise fail every existence check. Same normalization as the TTS engines.
 */
export function normalizePath(p: string): string {
  let s = String(p || '').trim();
  while (s.length > 1 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

// ── Config ───────────────────────────────────────────────────────────────────

type ServicesFile = Record<
  string,
  { services: ServiceDef[]; monitorIndex?: number; outputDeviceId?: string }
>;

export function hostKey(): string {
  return (os.hostname() || 'unknown').toLowerCase();
}

async function readFileConfig(): Promise<ServicesFile> {
  try {
    return JSON.parse(await fsp.readFile(SERVICES_FILE, 'utf-8')) || {};
  } catch {
    return {};
  }
}

export async function loadServices(): Promise<ServiceDef[]> {
  const all = await readFileConfig();
  return all[hostKey()]?.services || [];
}

export async function saveServices(services: ServiceDef[]): Promise<void> {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const all = await readFileConfig();
  const clean = (Array.isArray(services) ? services : []).map((s, i) => ({
    id: String(s.id || `svc${i}`),
    label: String(s.label || `Service ${i + 1}`),
    kind: (['exe', 'python', 'bat'].includes(s.kind) ? s.kind : 'exe') as ServiceKind,
    path: normalizePath(s.path || ''),
    args: Array.isArray(s.args) ? s.args.map(String) : [],
    cwd: normalizePath(s.cwd || ''),
    probe: {
      type: (s.probe?.type === 'process' ? 'process' : 'tcp') as ProbeType,
      ...(s.probe?.port ? { port: Number(s.probe.port) } : {}),
      ...(s.probe?.match ? { match: String(s.probe.match) } : {}),
    },
    enabled: s.enabled !== false,
    ...(s.micName ? { micName: String(s.micName) } : {}),
    // Visible by default: these are interactive console tools, and their output
    // is the only real indication that they're working.
    showConsole: s.showConsole !== false,
  }));
  // Preserve the monitor choice across a service-list save.
  all[hostKey()] = { ...(all[hostKey()] || {}), services: clean };
  await fsp.writeFile(SERVICES_FILE, JSON.stringify(all, null, 2), 'utf-8');
}

/** Monitor the console windows are stacked on. Per-machine, like the services. */
export async function loadMonitorIndex(): Promise<number> {
  const all = await readFileConfig();
  const v = all[hostKey()]?.monitorIndex;
  return typeof v === 'number' && v >= 0 ? v : 0;
}

export async function saveMonitorIndex(index: number): Promise<void> {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const all = await readFileConfig();
  const cur = all[hostKey()] || { services: [] };
  all[hostKey()] = { ...cur, monitorIndex: Math.max(0, Number(index) || 0) };
  await fsp.writeFile(SERVICES_FILE, JSON.stringify(all, null, 2), 'utf-8');
}

// ── Probes ───────────────────────────────────────────────────────────────────

/**
 * Can we open a TCP connection to this local port?
 *
 * Deliberately NOT an HTTP request: voice_changer.py and voice_service.py are
 * `websockets.serve` servers and won't answer a plain GET usefully, so an HTTP
 * probe would report them down while they're running — and Nexus would launch a
 * duplicate that then fails to bind the port. A socket connect is
 * protocol-agnostic and correct for HTTP, WebSocket and anything else.
 */
export function isPortOpen(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, '127.0.0.1');
  });
}

function psQuote(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function runPowerShell(script: string, timeoutMs = 10000): Promise<string> {
  return new Promise(resolve => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => resolve(err ? '' : String(stdout || '').trim())
    );
  });
}

/**
 * PID of a process whose command line contains `match`, or 0.
 *
 * Matching on the command line — not the image name — is required because the
 * two speech recognizers are the same recognize.exe and differ only in their
 * `--out_yukacone` port.
 *
 * TWO GUARDS AGAINST FALSE POSITIVES, both learned the hard way:
 *
 * 1. `$_.ProcessId -ne $PID` — the PowerShell process running this very query
 *    has the search string in ITS OWN command line, so an unguarded query
 *    always "finds" itself. That made a stopped recognizer look like it was
 *    running, which would make "Run Audio Session" silently skip starting it.
 *
 * 2. `imageName` narrows to the right executable, so a text editor with the
 *    port number in its title, or a shell scrolled past the command, can't
 *    masquerade as the service.
 */
export async function findPidByCommandLine(match: string, imageName?: string): Promise<number> {
  if (!match) return 0;
  const filter = imageName ? ` -Filter ${psQuote(`Name='${imageName.replace(/'/g, "''")}'`)}` : '';
  const out = await runPowerShell(
    `Get-CimInstance Win32_Process${filter} | ` +
    `Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like ${psQuote('*' + match + '*')} } | ` +
    `Select-Object -First 1 -ExpandProperty ProcessId`
  );
  const pid = parseInt(out, 10);
  return Number.isFinite(pid) ? pid : 0;
}

/** Image name a service's process will appear under in the process table. */
function imageNameFor(def: ServiceDef): string | undefined {
  if (def.kind === 'python') return 'python.exe';
  if (def.kind === 'bat') return undefined;   // cmd.exe wrapper may already be gone
  const base = path.basename(normalizePath(def.path) || '');
  return base || undefined;
}

/** PID listening on a local TCP port, or 0. */
export async function findPidByPort(port: number): Promise<number> {
  const out = await runPowerShell(
    `(Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | ` +
    `Select-Object -First 1).OwningProcess`
  );
  const pid = parseInt(out, 10);
  return Number.isFinite(pid) ? pid : 0;
}

export async function probeService(def: ServiceDef): Promise<{ running: boolean; pid?: number }> {
  if (def.probe?.type === 'process') {
    const pid = await findPidByCommandLine(def.probe.match || def.path, imageNameFor(def));
    return { running: pid > 0, pid: pid || undefined };
  }
  const port = Number(def.probe?.port || 0);
  if (!port) return { running: false };
  const running = await isPortOpen(port);
  // The PID lookup costs a PowerShell spawn, so only pay it when something is
  // actually there (and it's what Stop needs).
  return running ? { running, pid: (await findPidByPort(port)) || undefined } : { running: false };
}

export async function getServiceStatuses(): Promise<ServiceStatus[]> {
  const defs = await loadServices();
  return Promise.all(
    defs.map(async d => {
      // Probe exactly once per service: a process probe costs a PowerShell
      // spawn, and calling it twice per row would double the panel's latency.
      const p = await probeService(d);
      return {
        ...d,
        running: p.running,
        pid: p.pid,
        pathExists: !!d.path && fs.existsSync(normalizePath(d.path)),
      };
    })
  );
}

// ── Microphones ──────────────────────────────────────────────────────────────

export interface MicDevice { index: number; name: string; }

/**
 * Ask recognize.exe for the current microphone list (`--print_mics`).
 *
 * Output is one `N : Name` per line. Device names can contain Japanese, and the
 * bundled exe writes them in the console's ANSI codepage rather than UTF-8, so
 * mojibake is detected and re-decoded as Shift-JIS — the same fallback the
 * shell tool uses.
 */
export function listMics(exePath: string, timeoutMs = 20000): Promise<MicDevice[]> {
  return new Promise(resolve => {
    const exe = normalizePath(exePath);
    if (!exe || !fs.existsSync(exe)) return resolve([]);
    execFile(
      exe,
      ['--print_mics'],
      { cwd: path.dirname(exe), timeout: timeoutMs, windowsHide: true, encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 },
      (_err, stdout) => {
        const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout || ''));
        let text = buf.toString('utf-8');
        if (text.includes('�')) {
          try { text = new TextDecoder('shift_jis').decode(buf); } catch { /* keep utf-8 */ }
        }
        const mics: MicDevice[] = [];
        for (const line of text.split(/\r?\n/)) {
          const m = /^\s*(\d+)\s*:\s*(.+?)\s*$/.exec(line);
          if (m) mics.push({ index: Number(m[1]), name: m[2] });
        }
        resolve(mics);
      }
    );
  });
}

/**
 * Substitute the CURRENT index for a service's saved microphone name.
 *
 * Matching is prefix-based because recognize.exe truncates names in its own
 * listing ("CABLE-A Output (VB-Audio Virtua" — no closing paren), so an exact
 * comparison against a full Windows device name would never match.
 *
 * Returns the args unchanged plus a warning when the device is gone, rather
 * than silently launching against whatever now happens to sit at that index.
 */
/** True when a path looks like the speech recognizer (the only thing taking --mic). */
export function looksLikeRecognizer(p: string): boolean {
  return /recognize(-gui)?\.exe$/i.test(normalizePath(p || ''));
}

/**
 * Find a recognizer executable among the configured services.
 *
 * The microphone list is a property of the MACHINE, not of one service row, so
 * enumerating it must not depend on which row the user happened to click.
 */
export async function findRecognizerPath(): Promise<string> {
  for (const s of await loadServices()) {
    const p = normalizePath(s.path || '');
    if (looksLikeRecognizer(p) && fs.existsSync(p)) return p;
  }
  return '';
}

export async function resolveArgs(def: ServiceDef): Promise<{ args: string[]; warning?: string }> {
  const args = [...(def.args || [])];
  if (!def.micName) return { args };

  // Only the recognizer accepts --mic. Inventing the flag for anything else
  // would hand an unknown argument to a tool that doesn't understand it — the
  // voice changer, for instance, manages its own devices via
  // device_settings.json and would choke on it.
  const hasMicFlag = args.includes('--mic');
  if (!hasMicFlag && !looksLikeRecognizer(def.path)) {
    return { args, warning: 'this service does not take --mic; the selected microphone was ignored' };
  }

  const mics = await listMics(def.path);
  if (!mics.length) return { args, warning: 'could not read the microphone list; using saved arguments as-is' };

  const want = def.micName.trim().toLowerCase();
  const hit =
    mics.find(m => m.name.toLowerCase() === want) ||
    mics.find(m => m.name.toLowerCase().startsWith(want)) ||
    mics.find(m => want.startsWith(m.name.toLowerCase()));

  if (!hit) {
    return { args, warning: `microphone "${def.micName}" is not connected — NOT started` };
  }

  const i = args.indexOf('--mic');
  if (i >= 0 && i + 1 < args.length) args[i + 1] = String(hit.index);
  else args.push('--mic', String(hit.index));

  return { args };
}

// ── Console window titles & placement ────────────────────────────────────────

/**
 * Title given to a service's console window.
 *
 * Deliberately ASCII-only and prefixed with a fixed marker. Two reasons:
 * the title is set through `cmd`, where a non-ASCII label ("Recognition — my
 * mic → 13000") can be mangled by the console codepage; and the arranger finds
 * windows BY TITLE, so it has to be something we can still match afterwards.
 * The id is included because labels are user-editable and need not be unique.
 */
export function consoleTitleFor(def: ServiceDef): string {
  const ascii = (def.label || '').replace(/[^\x20-\x7E]/g, '').replace(/["&|<>^()]/g, ' ').replace(/\s+/g, ' ').trim();
  return `Nexus ${def.id}${ascii ? ` - ${ascii}` : ''}`.slice(0, 120);
}

export interface MonitorInfo {
  index: number;
  device: string;
  primary: boolean;
  x: number; y: number; width: number; height: number;
  workX: number; workY: number; workWidth: number; workHeight: number;
}

/** Enumerate monitors with their virtual-desktop coordinates. */
export async function listMonitors(): Promise<MonitorInfo[]> {
  const out = await runPowerShell(
    `Add-Type -AssemblyName System.Windows.Forms; ` +
    `$i = 0; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { ` +
    `  [PSCustomObject]@{ index=$i; device=$_.DeviceName; primary=$_.Primary; ` +
    `    x=$_.Bounds.X; y=$_.Bounds.Y; width=$_.Bounds.Width; height=$_.Bounds.Height; ` +
    `    workX=$_.WorkingArea.X; workY=$_.WorkingArea.Y; workWidth=$_.WorkingArea.Width; workHeight=$_.WorkingArea.Height }; ` +
    `  $i++ } | ConvertTo-Json -Compress`,
    15000
  );
  if (!out) return [];
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

export interface ArrangeResult { title: string; ok: boolean; }

/**
 * Stack the running services' console windows down the chosen monitor.
 *
 * Uses SetWindowPos through P/Invoke because Windows has no cmdlet for moving
 * another process's window. Windows are matched by the title set at launch;
 * anything not currently on screen is simply skipped, so arranging a partially
 * started session is safe.
 *
 * Positioning uses the WORKING area, not the full bounds, so windows don't end
 * up underneath the taskbar.
 */
export async function arrangeWindows(monitorIndex: number, titles: string[]): Promise<ArrangeResult[]> {
  if (!titles.length) return [];
  const monitors = await listMonitors();
  const mon = monitors[monitorIndex] || monitors.find(m => m.primary) || monitors[0];
  if (!mon) return titles.map(t => ({ title: t, ok: false }));

  const n = titles.length;
  const slotH = Math.floor(mon.workHeight / n);
  const rects = titles.map((t, i) => ({
    title: t,
    x: mon.workX,
    y: mon.workY + i * slotH,
    // Last slot absorbs the rounding remainder so the stack ends flush.
    h: i === n - 1 ? mon.workHeight - slotH * (n - 1) : slotH,
    w: mon.workWidth,
  }));

  const psList = rects
    .map(r => `@{title=${psQuote(r.title)};x=${r.x};y=${r.y};w=${r.w};h=${r.h}}`)
    .join(',');

  const script = `
$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class NxWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
}
'@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
$wins = New-Object System.Collections.ArrayList
$cb = [NxWin+EnumProc]{
  param($h, $l)
  if ([NxWin]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][NxWin]::GetWindowText($h, $sb, 512)
    $t = $sb.ToString()
    if ($t) { [void]$wins.Add([PSCustomObject]@{ h = $h; t = $t }) }
  }
  return $true
}
[void][NxWin]::EnumWindows($cb, [IntPtr]::Zero)
$targets = @(${psList})
$res = foreach ($tg in $targets) {
  $m = $wins | Where-Object { $_.t -like ('*' + $tg.title + '*') } | Select-Object -First 1
  if ($m) {
    [void][NxWin]::ShowWindow($m.h, 9)
    $ok = [NxWin]::SetWindowPos($m.h, [IntPtr]::Zero, $tg.x, $tg.y, $tg.w, $tg.h, 0x0014)
    [PSCustomObject]@{ title = $tg.title; ok = [bool]$ok }
  } else {
    [PSCustomObject]@{ title = $tg.title; ok = $false }
  }
}
$res | ConvertTo-Json -Compress
`.trim();

  const out = await runPowerShell(script, 25000);
  try {
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return titles.map(t => ({ title: t, ok: false }));
  }
}

// ── Windows default output device ────────────────────────────────────────────
//
// IMPORTANT CAVEAT: Windows exposes no PUBLIC API for changing the default
// audio endpoint. Every tool that does it (nircmd, SoundVolumeView,
// AudioDeviceCmdlets) drives the same undocumented COM interface, IPolicyConfig,
// and that is what is used below. None of those tools are installed here, so
// calling it directly avoids adding an external dependency. It has been stable
// across Windows 10 and 11, but it is not a supported API and could break in a
// future release — that risk is the price of the feature existing at all.

export interface OutputDevice { id: string; name: string; isDefault?: boolean; }

/**
 * Active audio RENDER endpoints, read from the MMDevices registry.
 *
 * DeviceState 1 = active; unplugged and disabled endpoints are filtered out so
 * the list matches what Windows itself shows. The display name joins the device
 * description with the endpoint name ("Speakers" + "Steam Streaming Speakers"),
 * which is how they appear in the sound control panel.
 */
export async function listOutputDevices(): Promise<OutputDevice[]> {
  const script = `
$base = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render'
$out = Get-ChildItem $base -ErrorAction SilentlyContinue | ForEach-Object {
  $st = (Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue).DeviceState
  if ($st -eq 1) {
    $p = Get-ItemProperty -Path (Join-Path $_.PSPath 'Properties') -ErrorAction SilentlyContinue
    $desc = $p.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
    $endp = $p.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'
    $name = if ($endp -and $desc) { "$desc ($endp)" } elseif ($desc) { $desc } else { $_.PSChildName }
    [PSCustomObject]@{ id = '{0.0.0.00000000}.' + $_.PSChildName; name = $name }
  }
}
$out | Sort-Object name | ConvertTo-Json -Compress
`.trim();
  const raw = await runPowerShell(script, 20000);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** Make a render endpoint the default for console, multimedia and communications. */
export async function setDefaultOutputDevice(deviceId: string): Promise<{ ok: boolean; error?: string }> {
  if (!deviceId) return { ok: false, error: 'no device selected' };
  const script = `
$sig = @'
using System;
using System.Runtime.InteropServices;
[Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPolicyConfig {
  [PreserveSig] int GetMixFormat(string d, IntPtr f);
  [PreserveSig] int GetDeviceFormat(string d, bool b, IntPtr f);
  [PreserveSig] int ResetDeviceFormat(string d);
  [PreserveSig] int SetDeviceFormat(string d, IntPtr a, IntPtr b);
  [PreserveSig] int GetProcessingPeriod(string d, bool b, IntPtr a, IntPtr c);
  [PreserveSig] int SetProcessingPeriod(string d, IntPtr p);
  [PreserveSig] int GetShareMode(string d, IntPtr m);
  [PreserveSig] int SetShareMode(string d, IntPtr m);
  [PreserveSig] int GetPropertyValue(string d, bool b, IntPtr k, IntPtr v);
  [PreserveSig] int SetPropertyValue(string d, bool b, IntPtr k, IntPtr v);
  [PreserveSig] int SetDefaultEndpoint(string d, int role);
  [PreserveSig] int SetEndpointVisibility(string d, bool v);
}
[ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
public class CPolicyConfigClient { }
// The QueryInterface cast has to happen INSIDE C#. PowerShell 5.1 cannot
// convert a System.__ComObject to a custom interface (casting it throws, even
// though the QI itself succeeds), so the whole call is wrapped in a static
// method and PowerShell only ever touches a string and an int.
public static class NxAudio {
  public static int SetDefault(string id) {
    IPolicyConfig cfg = (IPolicyConfig)new CPolicyConfigClient();
    int last = 0;
    // Roles: 0 eConsole, 1 eMultimedia, 2 eCommunications — all three, which is
    // what the sound control panel does for "Set as default device".
    for (int r = 0; r < 3; r++) { int h = cfg.SetDefaultEndpoint(id, r); if (h != 0) last = h; }
    return last;
  }
}
'@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
$hr = [NxAudio]::SetDefault(${psQuote(deviceId)})
if ($hr -ne 0) { "ERR:0x{0:X8}" -f $hr } else { "OK" }
`.trim();

  const out = await runPowerShell(script, 20000);
  if (out.startsWith('OK')) return { ok: true };
  return { ok: false, error: out ? `IPolicyConfig returned ${out}` : 'no response from PowerShell' };
}

export async function loadOutputDeviceId(): Promise<string> {
  const all = await readFileConfig();
  return all[hostKey()]?.outputDeviceId || '';
}

export async function saveOutputDeviceId(id: string): Promise<void> {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const all = await readFileConfig();
  const cur = all[hostKey()] || { services: [] };
  all[hostKey()] = { ...cur, outputDeviceId: String(id || '') };
  await fsp.writeFile(SERVICES_FILE, JSON.stringify(all, null, 2), 'utf-8');
}

// ── Start / stop ─────────────────────────────────────────────────────────────

export interface ActionResult {
  id: string;
  label: string;
  ok: boolean;
  message: string;
}

// Gap between launches in a session start. Long enough to keep servers ahead of
// the recognizers that feed them, short enough that the request still returns
// promptly.
const LAUNCH_STAGGER_MS = 1200;

export async function startService(def: ServiceDef): Promise<ActionResult> {
  const base = { id: def.id, label: def.label };
  const exePath = normalizePath(def.path);

  const already = await probeService(def);
  if (already.running) return { ...base, ok: true, message: 'already running' };

  if (!exePath) return { ...base, ok: false, message: 'no path configured' };
  if (!fs.existsSync(exePath)) return { ...base, ok: false, message: `not found: ${exePath}` };

  // cwd matters: these tools resolve models, dictionaries and relative log
  // paths against their own directory (voice_changer.bat does `cd` implicitly by
  // running from that folder).
  const cwd = normalizePath(def.cwd || '') || path.dirname(exePath);

  // Resolve the saved microphone NAME to whatever index it holds right now.
  const { args: resolvedArgs, warning } = await resolveArgs(def);
  if (warning && /NOT started/.test(warning)) {
    // Refuse rather than launch against the wrong device. Starting recognition
    // on some other input is worse than not starting: it looks like it worked.
    return { ...base, ok: false, message: warning };
  }

  let command: string;
  let argv: string[];
  if (def.kind === 'python') {
    command = 'python';
    argv = [exePath, ...resolvedArgs];
  } else if (def.kind === 'bat') {
    command = 'cmd.exe';
    argv = ['/c', exePath, ...resolvedArgs];
  } else {
    command = exePath;
    argv = [...resolvedArgs];
  }

  try {
    if (def.showConsole !== false) {
      // A visible console window. Node's `detached: true` sets DETACHED_PROCESS,
      // which gives the child NO console at all — that's why level meters and
      // startup banners disappeared. `start` is the way to get CREATE_NEW_CONSOLE
      // from a command line.
      //
      // Built as ONE string with shell:true rather than an argv array, because
      // cmd re-parses whatever Node hands it and the two quoting rules don't
      // compose. Two things this must get right:
      //
      //  • BACKSLASHES. In cmd, `/` introduces a switch, so `/D C:/dev/foo`
      //    makes `start` read `/dev` and `/foo` as options and fail. Every path
      //    has to be converted, no matter how it was typed or stored.
      //  • The `""` title placeholder. Without it `start` takes the first
      //    quoted token — our executable path — as the window title and
      //    launches nothing at all.
      const win = (p: string) => p.replace(/\//g, '\\');
      const title = consoleTitleFor(def);
      const parts = [
        'start',
        `"${title}"`,
        '/D',
        `"${win(cwd)}"`,
        `"${win(command)}"`,
        ...argv.map(a => (/[\s"]/.test(a) ? `"${win(a).replace(/"/g, '')}"` : win(a))),
      ];
      const line = parts.join(' ');
      console.log(`[audio-session] start "${def.label}": ${line}`);
      const child = spawn(line, { cwd, detached: true, stdio: 'ignore', shell: true, windowsHide: false });
      child.unref();
    } else {
      console.log(`[audio-session] start "${def.label}" (headless): ${command} ${argv.join(' ')}`);
      const child = spawn(command, argv, { cwd, detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
    }
  } catch (e: any) {
    return { ...base, ok: false, message: `launch failed: ${e.message}` };
  }

  // Return as soon as it's launched. Waiting here for the port to open blocked
  // the HTTP response — and therefore the whole panel, including Stop — for up
  // to 45 seconds PER SERVICE; a four-service session took over three minutes
  // during which nothing could be cancelled. Readiness is now reported by the
  // panel's status poll, and the service's own console window shows progress
  // and any startup error directly.
  return { ...base, ok: true, message: 'launching…' };
}

export async function stopService(def: ServiceDef): Promise<ActionResult> {
  const base = { id: def.id, label: def.label };
  const { running, pid } = await probeService(def);
  if (!running) return { ...base, ok: true, message: 'already stopped' };
  if (!pid) return { ...base, ok: false, message: 'running but PID could not be determined' };

  // /T also kills children — recognize.exe is a PyInstaller bundle that spawns
  // its own worker, and killing only the parent would orphan it.
  await runPowerShell(`taskkill /PID ${pid} /T /F`);

  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 300));
    if (!(await probeService(def)).running) {
      console.log(`[audio-session] stopped "${def.label}" (pid ${pid})`);
      return { ...base, ok: true, message: 'stopped' };
    }
  }
  return { ...base, ok: false, message: `PID ${pid} did not exit` };
}

/**
 * Start every enabled service, in list order — servers must be listening before
 * the recognizers that push text at them come up. Sequential, not parallel, for
 * the same reason.
 */
export async function startSession(): Promise<ActionResult[]> {
  const defs = (await loadServices()).filter(d => d.enabled !== false);
  const out: ActionResult[] = [];

  // Switch the Windows default output FIRST, before anything opens an audio
  // device. Applications pick their endpoint when they start, so flipping the
  // default afterwards would leave the services already bound to the old one.
  const wantDevice = await loadOutputDeviceId();
  if (wantDevice) {
    const devices = await listOutputDevices();
    const dev = devices.find(d => d.id === wantDevice);
    if (!dev) {
      out.push({ id: '_output', label: 'Default output device', ok: false, message: 'saved device is not currently available' });
    } else {
      const r = await setDefaultOutputDevice(wantDevice);
      out.push({
        id: '_output', label: 'Default output device', ok: r.ok,
        message: r.ok ? `switched to ${dev.name}` : (r.error || 'failed'),
      });
    }
  }

  for (let i = 0; i < defs.length; i++) {
    out.push(await startService(defs[i]));
    // A short stagger preserves launch ORDER (a recognizer should not start
    // pushing text at a socket that isn't bound yet) without reintroducing the
    // old behaviour of blocking until each one is fully ready.
    if (i < defs.length - 1) await new Promise(r => setTimeout(r, LAUNCH_STAGGER_MS));
  }
  return out;
}

/** Stop in reverse order, so producers go down before their consumers. */
export async function stopSession(): Promise<ActionResult[]> {
  const defs = (await loadServices()).filter(d => d.enabled !== false).reverse();
  const out: ActionResult[] = [];
  for (const d of defs) out.push(await stopService(d));
  return out;
}
