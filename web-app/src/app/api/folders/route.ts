import { NextResponse } from 'next/server';
import { listFolders, saveFolder, renameFolder, deleteFolder } from '@/lib/fsStorage';
import { blockedBeings, isBeingBlocked, blockedResponseBody } from '@/lib/blockedBeings';

export async function GET() {
  try {
    const folders = await listFolders();
    // Beings this process refuses to serve never reach the sidebar. This is the
    // source the whole UI builds its list from, so dropping them here is what
    // makes "not in the list" true everywhere at once instead of per-component.
    const blocked = blockedBeings();
    const visible = blocked.length
      ? folders.filter((f: any) => !isBeingBlocked(f?.name, blocked))
      : folders;
    return NextResponse.json(visible);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const data = await req.json();
    if (data.action === 'rename') {
      // Both ends of a rename are guarded: refusing only the old name would let
      // a blocked being be renamed INTO visibility from the very process that
      // is not supposed to touch them.
      if (isBeingBlocked(data.oldName, blockedBeings())) {
        return NextResponse.json(blockedResponseBody(String(data.oldName)), { status: 403 });
      }
      if (isBeingBlocked(data.newName, blockedBeings())) {
        return NextResponse.json(blockedResponseBody(String(data.newName)), { status: 403 });
      }
      // The report says what actually moved. A rename touches nine places on
      // disk; "success: true" alone would hide a half-finished one.
      const report = await renameFolder(data.oldName, data.newName);
      return NextResponse.json({ success: report.failed.length === 0, report });
    }
    if (isBeingBlocked(data?.name, blockedBeings())) {
      return NextResponse.json(blockedResponseBody(String(data.name)), { status: 403 });
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
    if (isBeingBlocked(name, blockedBeings())) {
      return NextResponse.json(blockedResponseBody(name), { status: 403 });
    }

    await deleteFolder(name);
    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
