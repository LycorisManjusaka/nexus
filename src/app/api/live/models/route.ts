import { NextResponse } from 'next/server';
import { loadKeys } from '@/lib/fsStorage';

/**
 * Lists models on the caller's Gemini API key, filtered to those that
 * support bidiGenerateContent (i.e. are usable with the Live API).
 * Queries both v1alpha and v1beta and tags each result with which
 * version it came from, so the UI can pick a model + the right endpoint.
 */
export async function GET() {
  const keys = await loadKeys();
  if (!keys.gemini) {
    return NextResponse.json({ error: 'Gemini API key missing in settings.' }, { status: 400 });
  }

  const versions = ['v1alpha', 'v1beta'] as const;
  const results: { id: string; version: string; methods: string[]; displayName?: string }[] = [];
  const errors: { version: string; error: string }[] = [];

  for (const v of versions) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/${v}/models?key=${encodeURIComponent(keys.gemini)}`);
      if (!r.ok) {
        const txt = await r.text();
        errors.push({ version: v, error: `${r.status}: ${txt.slice(0, 200)}` });
        continue;
      }
      const data = await r.json();
      const models = Array.isArray(data?.models) ? data.models : [];
      for (const m of models) {
        const methods: string[] = m.supportedGenerationMethods || [];
        if (methods.includes('bidiGenerateContent')) {
          // Strip "models/" prefix
          const id = (m.name || '').replace(/^models\//, '');
          results.push({ id, version: v, methods, displayName: m.displayName });
        }
      }
    } catch (e: any) {
      errors.push({ version: v, error: e?.message || 'unknown' });
    }
  }

  return NextResponse.json({ models: results, errors });
}
