import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { saveLog } from '@/lib/fsStorage';

const DATA_DIR = path.resolve(process.cwd(), '..', 'local_data');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const folderName = searchParams.get('folder');
    if (!folderName) return NextResponse.json({ error: 'Missing folder' }, { status: 400 });

    const backupDir = path.join(BACKUPS_DIR, folderName);
    
    let files: string[] = [];
    try {
      files = await fs.readdir(backupDir);
    } catch (e) {
      // Directory might not exist if no backups yet
      return NextResponse.json([]);
    }

    const backupPromises = files.filter(file => file.endsWith('.json')).map(async (file) => {
      let fileHandle;
      try {
        fileHandle = await fs.open(path.join(backupDir, file), 'r');
        const buffer = Buffer.alloc(16384); // Read only first 16KB
        const { bytesRead } = await fileHandle.read(buffer, 0, 16384, 0);
        const dataChunk = buffer.toString('utf-8', 0, bytesRead);
        
        const titleMatch = dataChunk.match(/"title"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
        const idMatch = dataChunk.match(/"id"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
        const updatedMatch = dataChunk.match(/"updatedAt"\s*:\s*(\d+)/);

        const parts = file.replace('.json', '').split('_');
        const dateStr = parts.slice(1).join('_'); // Extracted date YYYY-MM-DD
        
        return {
          backupFile: file,
          originalConvoId: idMatch ? idMatch[1] : parts[0],
          date: dateStr,
          title: titleMatch ? titleMatch[1] : 'Unknown Conversation',
          timestamp: updatedMatch ? parseInt(updatedMatch[1]) : 0
        };
      } catch (e) {
        return null;
      } finally {
        if (fileHandle) await fileHandle.close();
      }
    });

    const backupsList = await Promise.all(backupPromises);
    const backups = backupsList.filter((b): b is NonNullable<typeof b> => b !== null);

    // Sort by descending timestamp/date
    backups.sort((a, b) => b.date.localeCompare(a.date) || b.timestamp - a.timestamp);
    return NextResponse.json(backups);

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { folderName, backupFile } = await req.json();
    if (!folderName || !backupFile) return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });

    const filePath = path.join(BACKUPS_DIR, folderName, backupFile);
    const data = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(data);

    // Create a restored clone
    const newConvoId = uuidv4();
    parsed.id = newConvoId;
    parsed.title = `${parsed.title || 'Conversation'} (Restored)`;
    parsed.updatedAt = Date.now();

    await saveLog(newConvoId, parsed);

    return NextResponse.json({ success: true, newConvoId });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
