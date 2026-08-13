import { NextResponse } from 'next/server';
import { listFolders, saveFolder, renameFolder, deleteFolder } from '@/lib/fsStorage';

export async function GET() {
  try {
    const folders = await listFolders();
    return NextResponse.json(folders);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const data = await req.json();
    if (data.action === 'rename') {
      // The report says what actually moved. A rename touches nine places on
      // disk; "success: true" alone would hide a half-finished one.
      const report = await renameFolder(data.oldName, data.newName);
      return NextResponse.json({ success: report.failed.length === 0, report });
    }
    await saveFolder(data.name, data.settings);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const name = searchParams.get('name');
    if (!name) return NextResponse.json({ error: 'Missing name' }, { status: 400 });
    
    await deleteFolder(name);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
