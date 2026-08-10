import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Base theme modes. Named per-character themes no longer live in globals.css —
// each folder now carries its own CSS scheme (Folder Settings → CSS Theme),
// injected per-folder at runtime. This route therefore no longer reads
// globals.css; it just offers the base modes plus the free-form Custom option.
const SYSTEM_THEMES: { value: string; label: string }[] = [
  { value: 'dark', label: 'Dark (Default)' },
  { value: 'light', label: 'Light' },
];

export async function GET() {
  const themes = [...SYSTEM_THEMES, { value: 'custom', label: 'Custom CSS' }];
  return NextResponse.json({ themes });
}
