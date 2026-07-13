// videoSplit.ts — server-side ffmpeg orchestration for oversize video attachments.
//
// Providers on the OpenAI-compatible path reject any single inline base64 `data:`
// URI larger than 20 MiB (see the preflight in api/chat/route.ts). base64 inflates
// raw bytes by 4/3, so a raw file must stay under ~15 MiB to encode under 20 MiB.
//
// Strategy (deliberately "compress first, split only if needed"):
//   1. Re-encode the whole clip once at CRF 28 (H.264/AAC, mp4).
//   2. If the re-encoded file already fits under the base64 cap → return it as a
//      SINGLE part (preserves temporal continuity — no pointless splitting).
//   3. If it's still too big → stream-copy segment it into <name>_part1.mp4,
//      <name>_part2.mp4, … each comfortably under the cap.
//
// The CRF-28 encode forces keyframes every 2 s so the stream-copy segmenter can
// cut on a fine grid regardless of the source GOP; without this a long-GOP source
// could produce a segment that can't be cut small enough.

import { spawn } from 'child_process';
import { promises as fs, existsSync } from 'fs';
import os from 'os';
import path from 'path';

// Provider hard cap on the full `data:<mime>;base64,<data>` string length.
const BASE64_LIMIT = 20 * 1024 * 1024;
// Target RAW bytes per part. 20 MiB base64 ≈ 15 MiB raw; 14 MiB leaves margin for
// the `data:` prefix and per-segment mp4 container overhead.
const TARGET_RAW_BYTES = 14 * 1024 * 1024;

export interface VideoPart {
  name: string;      // e.g. clip_part1.mp4 (or clip.mp4 when a single re-encoded file)
  buffer: Buffer;
}

/** Approximate length of the `data:video/mp4;base64,<n bytes>` string. */
function base64UriLen(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4 + 'data:video/mp4;base64,'.length;
}

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

function run(bin: string, args: string[], timeoutMs = 300_000): Promise<{ code: number; stdout: string; stderr: string }> {
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

async function probeDuration(ffprobe: string, file: string): Promise<number> {
  const { stdout } = await run(
    ffprobe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
    30_000,
  );
  const d = parseFloat(stdout.trim());
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/**
 * Re-encode a video at CRF 28 and, if still oversize, split it into parts that
 * each fit under the 20 MiB base64 cap. Returns one part when compression alone
 * suffices. Throws if ffmpeg fails; callers should fall back to the original file.
 */
export async function splitVideoForUpload(input: Buffer, originalName: string): Promise<VideoPart[]> {
  const ffmpeg = resolveBin('ffmpeg');
  const ffprobe = resolveBin('ffprobe');
  const base = (originalName || 'video').replace(/\.[^.]+$/, '') || 'video';
  const srcExt = (path.extname(originalName || '') || '.mp4').toLowerCase();

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-vsplit-'));
  const inputPath = path.join(tmpDir, `input${srcExt}`);
  const encodedPath = path.join(tmpDir, 'encoded.mp4');

  try {
    await fs.writeFile(inputPath, input);

    // ── Pass 1: re-encode at CRF 28 with 2 s keyframes ──────────────────────
    const enc = await run(ffmpeg, [
      '-y', '-i', inputPath,
      '-c:v', 'libx264', '-crf', '28', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-force_key_frames', 'expr:gte(t,n_forced*2)',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      encodedPath,
    ]);
    if (enc.code !== 0 || !existsSync(encodedPath)) {
      throw new Error(`ffmpeg encode failed (code ${enc.code}): ${enc.stderr.slice(-400)}`);
    }

    const encStat = await fs.stat(encodedPath);
    // Compression alone was enough → one continuous file, no split.
    if (base64UriLen(encStat.size) <= BASE64_LIMIT) {
      return [{ name: `${base}.mp4`, buffer: await fs.readFile(encodedPath) }];
    }

    // ── Pass 2: segment the re-encoded file (stream copy, keyframe-aligned) ──
    const duration = await probeDuration(ffprobe, encodedPath);
    const bytesPerSec = duration > 0 ? encStat.size / duration : encStat.size;

    // Retry with progressively shorter segments if keyframe granularity leaves a
    // part above the cap (rare once 2 s keyframes are forced).
    let segTime = duration > 0 ? (TARGET_RAW_BYTES / bytesPerSec) * 0.9 : 30;
    for (let attempt = 0; attempt < 3; attempt++) {
      // Clear any parts from a previous attempt.
      for (const f of await fs.readdir(tmpDir)) {
        if (/^part_\d+\.mp4$/.test(f)) await fs.unlink(path.join(tmpDir, f)).catch(() => {});
      }
      segTime = Math.max(2, segTime);
      const seg = await run(ffmpeg, [
        '-y', '-i', encodedPath,
        '-c', 'copy', '-map', '0',
        '-f', 'segment', '-segment_time', segTime.toFixed(2), '-reset_timestamps', '1',
        path.join(tmpDir, 'part_%03d.mp4'),
      ]);
      if (seg.code !== 0) {
        throw new Error(`ffmpeg segment failed (code ${seg.code}): ${seg.stderr.slice(-400)}`);
      }

      const partFiles = (await fs.readdir(tmpDir))
        .filter(f => /^part_\d+\.mp4$/.test(f))
        .sort();
      const stats = await Promise.all(partFiles.map(async f => ({
        f, size: (await fs.stat(path.join(tmpDir, f))).size,
      })));
      const oversize = stats.some(s => base64UriLen(s.size) > BASE64_LIMIT);

      if (!oversize || attempt === 2) {
        const parts: VideoPart[] = [];
        for (let i = 0; i < partFiles.length; i++) {
          parts.push({
            name: `${base}_part${i + 1}.mp4`,
            buffer: await fs.readFile(path.join(tmpDir, partFiles[i])),
          });
        }
        // Should always have ≥1; if segmentation produced nothing, fall back to
        // the single re-encoded file rather than returning empty.
        if (parts.length === 0) {
          return [{ name: `${base}.mp4`, buffer: await fs.readFile(encodedPath) }];
        }
        return parts;
      }
      segTime *= 0.6; // tighten and retry
    }

    // Unreachable, but keep the type checker happy.
    return [{ name: `${base}.mp4`, buffer: await fs.readFile(encodedPath) }];
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
