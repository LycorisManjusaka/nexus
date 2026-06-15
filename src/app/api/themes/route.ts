import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

// These are the built-in system themes that are always shown first with friendly labels.
const SYSTEM_THEMES: { value: string; label: string }[] = [
  { value: 'dark', label: 'Dark (Default)' },
  { value: 'light', label: 'Light' },
];

export async function GET() {
  const cssPath = path.join(process.cwd(), 'src', 'app', 'globals.css');

  const themes = [...SYSTEM_THEMES];

  try {
    const css = fs.readFileSync(cssPath, 'utf-8');

    // Match all class selectors inside @layer base: e.g. .ocean, .architect, etc.
    // We look for lines like "  .classname {" inside the file.
    const matches = css.matchAll(/^\s*\.([a-zA-Z][a-zA-Z0-9_-]*)\s*\{/gm);

    const systemValues = new Set(SYSTEM_THEMES.map(t => t.value));

    for (const match of matches) {
      const name = match[1];
      // Skip utility classes and pseudo-elements, only include theme-like selectors
      if (!systemValues.has(name)) {
        // Capitalize first letter for label
        const label = name.charAt(0).toUpperCase() + name.slice(1);
        if (!themes.find(t => t.value === name)) {
          themes.push({ value: name, label });
        }
      }
    }
  } catch (e) {
    console.error('Could not read globals.css for themes:', e);
  }

  // Always append Custom CSS as the last option
  themes.push({ value: 'custom', label: 'Custom CSS' });

  return NextResponse.json({ themes });
}
