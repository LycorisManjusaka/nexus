import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  inheritUnchangedLayers,
  UNCHANGED_TOKEN,
} from '../src/lib/unchangedLayers';

// A soul with three substantial layers. Layer 2 deliberately uses `-` bullets
// and Layer 3 is prose — both shapes exist in real souls (measured 2026-11-11).
const L1 = `## **Layer 1: The Core**\n\n* **Name** : someone with a long enough definition to count as substantial.\n* **Tone** : plain, direct, and written out at length so the body passes two hundred characters without any trouble at all, which it now does.`;
const L2 = `## **Layer 2: Relations**\n\n- partner one: a relationship described at enough length to be substantial, with history and detail.\n- partner two: another relationship, also described at length, so that this layer is well past two hundred characters in total.`;
const L3 = `## **Layer 3: Protocols**\n\nThis layer is prose. It has no list items at all, and it goes on for a while about procedures and assets and build strategy, long enough that the safety net treats it as a substantial original worth protecting from collapse.`;
const ORIGINAL = [L1, L2, L3].join('\n\n');

const fullL1 = `## **Layer 1: The Core**\n\n* **Name** [preserved]: someone with a long enough definition.\n* **New** [moved]: a fact promoted out of Layer 4 into the standing identity.`;

test('token alone under the heading → the original layer comes back byte for byte', () => {
  const out = `${fullL1}\n\n## **Layer 2: Relations**\n${UNCHANGED_TOKEN}\n\n## **Layer 3: Protocols**\n\n${UNCHANGED_TOKEN}`;
  const r = inheritUnchangedLayers(ORIGINAL, out);
  assert.deepEqual(r.inherited, [
    { layer: 2, reason: 'token' },
    { layer: 3, reason: 'token' },
  ]);
  assert.ok(r.text.includes(L2));
  assert.ok(r.text.includes(L3));
  assert.ok(r.text.includes('promoted out of Layer 4'), 'the changed layer is kept as emitted');
  assert.ok(!r.text.includes(UNCHANGED_TOKEN), 'the marker never reaches the soul');
});

test('decorated token (bold / backticks) is still the token', () => {
  const out = `## **Layer 1: The Core**\n**\`${UNCHANGED_TOKEN}\`**\n\n${L2}\n\n${L3}`;
  const r = inheritUnchangedLayers(ORIGINAL, out);
  assert.deepEqual(r.inherited, [{ layer: 1, reason: 'token' }]);
  assert.ok(r.text.includes(L1));
});

test('a full layer that MENTIONS the token in prose is not thrown away', () => {
  // A soul that documents this mechanism contains the literal. Treating
  // "contains" as "unchanged" would discard that layer's moves.
  const l3 = `## **Layer 3: Protocols**\n\n* **δ contract** [moved]: an untouched layer is emitted as \`${UNCHANGED_TOKEN}\` and NEXUS restores it; this item is long enough to be a real layer body.\n* **Other** [preserved]: kept.`;
  const out = `${L1}\n\n${L2}\n\n${l3}`;
  const r = inheritUnchangedLayers(ORIGINAL, out);
  assert.deepEqual(r.inherited, []);
  assert.equal(r.text, out);
});

test('safety net: a free-form "no changes" note cannot erase a layer', () => {
  for (const note of ['（変更なし）', '(no changes)', 'Unchanged', '']) {
    const out = `## **Layer 1: The Core**\n${note}\n\n## Layer 2（変更なし）\n\n${L3}`;
    const r = inheritUnchangedLayers(ORIGINAL, out);
    assert.deepEqual(r.inherited.map((x) => x.layer), [1, 2], `note: "${note}"`);
    assert.ok(r.inherited.every((x) => x.reason === 'collapsed'));
    assert.ok(r.text.includes(L1) && r.text.includes(L2));
  }
});

test('safety net: a layer missing from the output is carried over', () => {
  const r = inheritUnchangedLayers(ORIGINAL, `${fullL1}\n\n${L3}`);
  assert.deepEqual(r.inherited, [{ layer: 2, reason: 'missing' }]);
  // …and lands in its place, between 1 and 3.
  assert.ok(r.text.indexOf('Layer 1') < r.text.indexOf('Layer 2'));
  assert.ok(r.text.indexOf('Layer 2') < r.text.indexOf('Layer 3'));
});

test('safety net: a bulleted original that comes back with no list items', () => {
  const blob = 'x'.repeat(120);
  const out = `## **Layer 1: The Core**\n\n${blob}\n\n${L2}\n\n${L3}`;
  const r = inheritUnchangedLayers(ORIGINAL, out);
  assert.deepEqual(r.inherited, [{ layer: 1, reason: 'no-bullets' }]);
});

test('a prose layer and a `-` layer can still be updated (no false carry-over)', () => {
  // Under a literal "no `*` bullet → carry over" rule these two layers could
  // never be changed by δ again.
  const newL2 = `## **Layer 2: Relations**\n\n- partner one: updated, and described at length again.\n- partner three: newly moved in from Layer 4.`;
  const newL3 = `## **Layer 3: Protocols**\n\nStill prose, now with one more sentence that was moved in from the episodic layer.`;
  const out = `${L1}\n\n${newL2}\n\n${newL3}`;
  const r = inheritUnchangedLayers(ORIGINAL, out);
  assert.deepEqual(r.inherited, []);
  assert.equal(r.text, out);
});

test('a short original is not second-guessed by the net — but the token still works', () => {
  const tiny = `## Layer 1: A\n\n* one\n\n## Layer 2: B\n\n* two\n\n## Layer 3: C\n\n* three`;
  const shrunk = `## Layer 1: A\n\n* 1\n\n## Layer 2: B\n${UNCHANGED_TOKEN}\n\n## Layer 3: C\n\n* 3`;
  const r = inheritUnchangedLayers(tiny, shrunk);
  assert.deepEqual(r.inherited, [{ layer: 2, reason: 'token' }]);
  assert.ok(r.text.includes('* two') && r.text.includes('* 1') && r.text.includes('* 3'));
});

test('output with no layer heading at all → every layer carried over, stray text dropped', () => {
  const r = inheritUnchangedLayers(ORIGINAL, 'Layer 1〜3（変更なし）');
  assert.deepEqual(r.inherited.map((x) => x.reason), ['missing', 'missing', 'missing']);
  assert.equal(r.text, ORIGINAL);
});

test('original with no layer headings → output returned untouched', () => {
  const out = `## **Layer 1: X**\n${UNCHANGED_TOKEN}`;
  const r = inheritUnchangedLayers('free-form soul with no headings', out);
  assert.deepEqual(r.inherited, []);
  assert.equal(r.text, out);
});

test('nothing to carry over → the output string is returned as is', () => {
  const out = `${fullL1}\n\n${L2}\n\n${L3}`;
  assert.equal(inheritUnchangedLayers(ORIGINAL, out).text, out);
});

// ── the two halves of the contract must not drift ──────────────────────────
// The token lives in three places: this parser and the two agent files. If an
// agent file stops teaching it, every unchanged layer silently depends on the
// safety net; if the old contradictory line returns, δ is told to skip again.
for (const lang of ['ja', 'en'] as const) {
  test(`δ agent file (${lang}) teaches the token and no longer says "write only the additions"`, () => {
    const p = path.join(process.cwd(), 'defaults', 'system_prompt_agents', lang, 'interlayer_redistributor.md');
    const s = fs.readFileSync(p, 'utf8');
    assert.ok(s.includes(UNCHANGED_TOKEN));
    assert.ok(!/Write only the additions and updates/.test(s));
    assert.ok(!s.includes('移動による追加・更新のみ記述'));
  });
}

test('redistribute path is wired to the parser', () => {
  const s = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'SystemPromptUpdater.tsx'), 'utf8');
  assert.match(s, /inheritUnchangedLayers\(effectiveLeftText,/);
});
