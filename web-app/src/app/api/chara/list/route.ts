import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const CHAR_MAP_PATH = path.resolve(process.cwd(), '..', 'local_data', 'character_map.json');

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    if (!fs.existsSync(CHAR_MAP_PATH)) {
      return NextResponse.json({ characters: [], engines: {}, error: 'character_map.json not found' });
    }
    const map = JSON.parse(fs.readFileSync(CHAR_MAP_PATH, 'utf-8'));
    const characters = (map.rules || []).map((r: any) => ({
      name: r.name,
      engine: r.engine,
      charId: r.charId,
    }));
    return NextResponse.json({ characters, engines: map.engines || {} });
  } catch (e: any) {
    return NextResponse.json({ error: e.message, characters: [] }, { status: 500 });
  }
}
