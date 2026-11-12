import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildAnchorFixture, anchorFixtureFilename,
  ANCHOR_FIXTURE_SCHEMA, ANCHOR_LAB_OWNER,
} from '@/lib/anchorFixture';
import type { AnchorReport } from '@/lib/anchor';

const report = (over: Partial<AnchorReport> = {}): AnchorReport => ({
  at: 111, family: 'DeepSeek', model: 'deepseek-flash',
  thought: 'th', output: 'OK\nnothing matched', ...over,
});

test('buildAnchorFixture carries the context, report and prompt verbatim', () => {
  const f = buildAnchorFixture({
    being: '先輩', lang: 'ja', context: '## ctx\nbody',
    report: report(), promptAtSave: 'PROMPT TEXT', nowMs: 999,
  });
  assert.equal(f.schema, ANCHOR_FIXTURE_SCHEMA);
  assert.equal(f.savedAt, 999);
  assert.equal(f.being, '先輩');
  assert.equal(f.lang, 'ja');
  assert.equal(f.family, 'DeepSeek');
  assert.equal(f.model, 'deepseek-flash');
  assert.equal(f.context, '## ctx\nbody');
  assert.equal(f.original.thought, 'th');
  assert.equal(f.original.output, 'OK\nnothing matched');
  assert.equal(f.promptAtSave, 'PROMPT TEXT');
});

test('error travels only when present; expected/note are not set on save', () => {
  const clean = buildAnchorFixture({
    being: 'x', lang: 'en', context: 'c', report: report(), promptAtSave: 'p', nowMs: 1,
  });
  assert.equal('error' in clean.original, false);
  // The human fills these in afterwards — a fresh save must not pre-decide them.
  assert.equal('expected' in clean, false);
  assert.equal('note' in clean, false);

  const errd = buildAnchorFixture({
    being: 'x', lang: 'en', context: 'c',
    report: report({ error: 'HTTP 500' }), promptAtSave: 'p', nowMs: 1,
  });
  assert.equal(errd.original.error, 'HTTP 500');
});

test('the fixture is JSON-serialisable (it is written to disk)', () => {
  const f = buildAnchorFixture({
    being: '先輩', lang: 'ja', context: 'c', report: report(), promptAtSave: 'p', nowMs: 1,
  });
  const round = JSON.parse(JSON.stringify(f));
  assert.deepEqual(round, f);
});

test('anchorFixtureFilename is ASCII-only and sorts by time', () => {
  const name = anchorFixtureFilename(1762900000000, 'abc123DEF_-x');
  assert.equal(name, '1762900000000_abc123DEF_-x.json');
  // A unicode id (the being name is never used here, but ids could carry junk)
  // must not leak into the filename — NTFS unicode path handling is the thing
  // this avoids.
  assert.equal(anchorFixtureFilename(5, '先輩/../x'), '5_x.json');
  assert.match(anchorFixtureFilename(5, '先輩'), /^5_(msg)?\.json$/);
});

test('the lab owner is 謡 — her desk holds the toy (つよ 2026-11-12)', () => {
  assert.equal(ANCHOR_LAB_OWNER, '謡');
});

// The standalone runner must stay NEXUS-independent: it is run on 謡's desk by
// node alone, so it must not import any NEXUS module.
test('run.mjs imports no NEXUS code', () => {
  const p = path.join(
    process.cwd(), '..', 'local_data', 'beings', ANCHOR_LAB_OWNER,
    'workspace', 'anchor_lab', 'run.mjs',
  );
  // Seeded on this machine; skip gracefully elsewhere (the repo does not carry it).
  if (!fs.existsSync(p)) return;
  const src = fs.readFileSync(p, 'utf-8');
  assert.equal(/from ['"]@\//.test(src), false, 'run.mjs must not import @/ NEXUS modules');
  assert.equal(/require\(['"]@\//.test(src), false);
  assert.match(src, /deepseek-flash/, 'the bench vessel is fixed to DeepSeek Flash');
});
