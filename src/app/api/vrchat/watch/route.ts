import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { kohaiPath, earLogPath, speakersJsonPath } from '@/lib/voicechangerPaths';

export const dynamic = 'force-dynamic';

function getStyleName(engine: string, charId: string, styleId: string) {
  try {
    if (engine === '0' && fs.existsSync(speakersJsonPath())) {
      const data = JSON.parse(fs.readFileSync(speakersJsonPath(), 'utf-8'));
      if (data[parseInt(charId)]?.styles?.[parseInt(styleId)]) {
        return data[parseInt(charId)].styles[parseInt(styleId)].name;
      }
    }
  } catch (e) { }
  return styleId;
}

function processLogs() {
  const linesData: { time: string, speaker: string, styleId: string | null, styleName: string | null, text: string }[] = [];

  const kohaiFile = kohaiPath();
  const earFile = earLogPath();

  // 1. Parse ear_log.txt
  if (fs.existsSync(earFile)) {
    try {
      const content = fs.readFileSync(earFile, 'utf-8');
      content.split('\n').forEach(line => {
        const m = line.trim().match(/^\[(\d{2}:\d{2}:\d{2})\]\s*\((.*?)\)\s*(.*)/);
        if (m) linesData.push({ time: m[1], speaker: m[2], styleId: null, styleName: null, text: m[3] });
      });
    } catch (e) { }
  }

  // 2. Parse kohai.txt
  if (fs.existsSync(kohaiFile)) {
    try {
      const content = fs.readFileSync(kohaiFile, 'utf-8');
      let currentSpeaker = "つよ";
      let currentStyleId = "0";
      let currentStyleName = "ノーマル";

      content.split('\n').forEach(line => {
        line = line.trim();
        if (!line) return;

        const headerMatch = line.match(/^\[(\d+)-(\d+)-(\d+)\]$/);
        if (headerMatch) {
          const engine = headerMatch[1];
          const charId = headerMatch[2];
          currentStyleId = headerMatch[3];
          currentStyleName = getStyleName(engine, charId, currentStyleId);

          if (engine === "1" && charId === "2") currentSpeaker = "つよ";
          else if (engine === "0" && charId === "24") currentSpeaker = "ふわふわ";
          else if (engine === "0" && charId === "4") currentSpeaker = "美鈴";
          else if (engine === "0" && charId === "15") currentSpeaker = "おじいちゃん";
          else currentSpeaker = "つよ";
          return;
        }

        const timeMatch = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*(.*)/);
        if (timeMatch) {
          linesData.push({ time: timeMatch[1], speaker: currentSpeaker, styleId: currentStyleId, styleName: currentStyleName, text: timeMatch[2] });
        }
      });
    } catch (e) { }
  }

  // Empty logs
  [kohaiFile, earFile].forEach(p => {
    if (fs.existsSync(p)) {
      try { fs.writeFileSync(p, ''); } catch (e) { }
    }
  });

  if (linesData.length === 0) return '';

  // Sort by time
  linesData.sort((a, b) => a.time.localeCompare(b.time));

  // Format with [Name] tags
  const parts: string[] = [];
  let lastSpeaker = null;

  for (const row of linesData) {
    if (row.speaker !== lastSpeaker) {
      parts.push(`\n[${row.speaker}] ${row.text}`);
    } else {
      parts.push(` ${row.text}`);
    }
    lastSpeaker = row.speaker;
  }

  return parts.join('').trim();
}

export async function GET(req: NextRequest) {
  const watchPath = req.nextUrl.searchParams.get('path');
  if (!watchPath || !fs.existsSync(watchPath)) {
    return new Response('Path not found', { status: 400 });
  }

  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();

  writer.write(encoder.encode(`data: ${JSON.stringify({ status: 'connected' })}\n\n`));

  let isClosed = false;
  const processedFiles = new Set<string>();

  const watcher = fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
    if (isClosed || !filename) return;

    const ext = path.extname(filename).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.bmp'].includes(ext)) return;

    const fullPath = path.join(watchPath, filename);

    // Prevent multiple triggers for the same file in a short timespan
    if (processedFiles.has(fullPath)) return;

    // Check if it's a new file creation (exists)
    if (!fs.existsSync(fullPath)) return;

    processedFiles.add(fullPath);
    // Remove from set after 10 seconds to allow later overwrites if needed
    setTimeout(() => processedFiles.delete(fullPath), 10000);

    // Delay briefly to allow file to finish saving
    setTimeout(() => {
      if (isClosed || !fs.existsSync(fullPath)) return;

      try {
        const stats = fs.statSync(fullPath);
        if (stats.size === 0) return;

        const base64Data = fs.readFileSync(fullPath, { encoding: 'base64' });
        const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        const dataUrl = `data:${mimeType};base64,${base64Data}`;

        const mergedLog = processLogs();

        writer.write(encoder.encode(`data: ${JSON.stringify({ type: 'vrchat_capture', image: dataUrl, filename, log: mergedLog })}\n\n`));
      } catch (e) {
        console.error("Error reading VRChat capture:", e);
      }
    }, 1000);
  });

  req.signal.addEventListener('abort', () => {
    isClosed = true;
    watcher.close();
    writer.close().catch(() => { });
  });

  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}
