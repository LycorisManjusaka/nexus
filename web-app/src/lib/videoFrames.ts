// videoFrames.ts — server-side ffmpeg frame sampling for local (LM Studio)
// models, which cannot receive a video any other way. See `videoFramePlan.ts`
// for WHY (measured LM Studio validator behaviour) and for the plan constants
// shared with the browser's token counter.
//
// Deliberately mirrors `videoSplit.ts`: same binary resolution, same spawn
// wrapper, same temp-dir discipline. Two copies of eight lines is cheaper than
// a shared helper that both files then have to agree about.

import { spawn } from 'child_process';
import { promises as fs, existsSync } from 'fs';
import os from 'os';
import path from 'path';

import { FRAME_LONG_EDGE, MAX_FRAMES, planVideoFrames, type FramePlan } from './videoFramePlan';

/** Resolve ffmpeg / ffprobe: env override → known local install → PATH. */
function resolveBin(name: 'ffmpeg' | 'ffprobe'): string {
  const envKey = name === 'ffmpeg' ? 'NEXUS_FFMPEG' : 'NEXUS_FFPROBE';
  const candidates = [
    process.env[envKey],
    process.platform === 'win32'
      ? `C:\\software\\ffmpeg-8.1-essentials_build\\bin\\${name}.exe`
      : null,
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* ignore */ }
  }
  return name; // fall back to PATH
}

function run(bin: string, args: string[], timeoutMs = 180_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${path.basename(bin)} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

export interface ExtractedFrames {
  /** JPEG bytes, in playback order. */
  frames: Buffer[];
  /** Clip length in seconds as ffprobe reported it (0 when unknown). */
  durationSec: number;
  /** The plan that was executed. */
  plan: FramePlan;
}

/**
 * Sample a video into JPEG frames.
 *
 * Throws on ffmpeg failure — the caller decides what to tell the entity, and
 * "no frames" must never be reported as "here is the video".
 */
export async function extractVideoFrames(input: Buffer, originalName?: string): Promise<ExtractedFrames> {
  const ffmpeg = resolveBin('ffmpeg');
  const ffprobe = resolveBin('ffprobe');
  const srcExt = (path.extname(originalName || '') || '.mp4').toLowerCase();

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-vframes-'));
  const inputPath = path.join(tmpDir, `input${srcExt}`);

  try {
    await fs.writeFile(inputPath, input);

    // Duration first: the frame plan (and therefore the sampling rate) depends
    // on it, and the browser already computed the same plan from the same
    // number when it counted tokens.
    let durationSec = 0;
    try {
      const { stdout } = await run(
        ffprobe,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', inputPath],
        30_000,
      );
      const d = parseFloat(stdout.trim());
      if (Number.isFinite(d) && d > 0) durationSec = d;
    } catch { /* unknown duration — fall through to a 1 fps pass with a hard cap */ }

    const plan = planVideoFrames(durationSec);

    // Scale so the LONG edge is FRAME_LONG_EDGE, whichever way the video is
    // oriented, and keep dimensions even (-2) for the JPEG encoder.
    const scale =
      `scale='if(gt(iw,ih),${FRAME_LONG_EDGE},-2)':'if(gt(iw,ih),-2,${FRAME_LONG_EDGE})'`;
    // `count` is 0 only when ffprobe could not report a duration; sample at the
    // nominal rate then and let MAX_FRAMES bound it.
    const fps = plan.count > 0 ? plan.fps : 1;
    const limit = plan.count > 0 ? plan.count : MAX_FRAMES;

    const res = await run(ffmpeg, [
      '-y', '-i', inputPath,
      '-vf', `fps=${fps.toFixed(6)},${scale}`,
      '-frames:v', String(limit),
      '-q:v', '4',
      path.join(tmpDir, 'f_%04d.jpg'),
    ]);
    if (res.code !== 0) {
      throw new Error(`ffmpeg frame extraction failed (code ${res.code}): ${res.stderr.slice(-400)}`);
    }

    const files = (await fs.readdir(tmpDir)).filter(f => /^f_\d+\.jpg$/.test(f)).sort();
    if (files.length === 0) {
      throw new Error('ffmpeg produced no frames');
    }
    const frames: Buffer[] = [];
    for (const f of files) frames.push(await fs.readFile(path.join(tmpDir, f)));

    // Report what actually came out, not what was asked for.
    return { frames, durationSec, plan: { fps, count: frames.length } };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
