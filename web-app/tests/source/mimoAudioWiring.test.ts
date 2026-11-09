/**
 * THREE GATES, ONE FACT: "a MiMo V2.6 vessel hears audio natively."
 *
 *   1. modelVision   AUDIO_CAPABLE_MODELS  — switches the ears bridge OFF
 *   2. route.ts      the Anthropic builder — actually sends the audio block
 *   3. attachmentVisibility  wireCarriesMedia() — the label the user reads
 *
 * They must agree or someone gets hurt in a specific way:
 *   1 without 2 → the bridge stands down and the bytes are dropped in silence
 *                 (this was the live bug for mimo-v2.5 before 2026-11-10)
 *   2 without 1 → the clip is transcribed AND sent, paying twice
 *   3 out of step with 2 → the UI promises delivery for bytes we drop
 *
 * WHY A SOURCE TEST FOR GATE 2. The rule has unit tests; the SEND does not —
 * route.ts has no fixture in this repo. Twice in the last week something was
 * written, typechecked, shipped and never ran: the Anthropic tool replay
 * (gated by a checkbox that was hidden for the only families it served) and a
 * draw offset that never reached production. "It compiles" is not "it is
 * wired", and the gap is invisible from the module's own tests.
 *
 * EVIDENCE for the fact itself (2026-11-10, api.xiaomimimo.com/anthropic):
 *   bytes arrive   input_tokens 46 text-only · 55 @1s · 67 @3s · 99 @8s
 *   heard          3 clips of IDENTICAL length (84 tok each, so the token
 *                  count cannot be the tell): flat 440 Hz vs 440→1760 Hz vs
 *                  white noise. Flat-vs-stepped correct 3/3 on all tiers;
 *                  noise named as noise 2/3 (pro called it a tone).
 * A duration slope alone proves encoding, not perception — Muse Spark returned
 * 200 and billed per second while answering "I cannot hear any attached audio"
 * to both silence and a sine. Both halves are required, so both are recorded.
 *
 * mimo-v2.5 is NOT covered: measured the same day, the host now answers
 * `400 Unsupported model mimo-v2.5` to every request, audio block or not. The
 * V2.5 retirement announced 2026-10-21 has actually landed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { isAudioCapable } from '@/lib/modelVision';
import { wireCarriesMedia, type DeliveryContext } from '@/lib/attachmentVisibility';

const ROUTE = path.join(process.cwd(), 'src', 'app', 'api', 'chat', 'route.ts');
const VISIBILITY = path.join(process.cwd(), 'src', 'lib', 'attachmentVisibility.ts');
const route = fs.readFileSync(ROUTE, 'utf-8');
const visibility = fs.readFileSync(VISIBILITY, 'utf-8');

const V26 = ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.6-pro-ultraspeed'];

const ctx = (over: Partial<DeliveryContext> = {}): DeliveryContext => ({
  aiName: 'MiMo',
  specificModel: 'mimo-v2.6-pro',
  isOAuthClaude: false,
  eyesEnabled: false,
  earsEnabled: false,
  watcherEnabled: false,
  ...over,
});

describe('MiMo audio: the three gates agree', () => {
  it('gate 1 — every measured V2.6 tier is audio-capable', () => {
    for (const m of V26) {
      assert.equal(isAudioCapable(m), true, `${m} must be in AUDIO_CAPABLE_MODELS`);
    }
  });

  it('gate 2 — the Anthropic builder really pushes an audio block', () => {
    // Not "the file mentions audio": the push itself, in the `source` envelope
    // MiMo extends the dialect with. `input_audio` (the OpenAI part name) is
    // the shape that measured as dropped, so finding THAT here would be the
    // old mistake wearing the new label.
    assert.match(
      route,
      /contentArr\.push\(\{\s*type:\s*'audio',\s*source:\s*\{\s*type:\s*'base64'/,
      'route.ts no longer sends { type: "audio", source: { type: "base64" ... } }',
    );
    assert.ok(
      !/contentArr\.push\(\{\s*type:\s*'input_audio'/.test(route),
      'input_audio is the OpenAI part name — it measured as silently dropped on this dialect',
    );
  });

  it('gate 2 — the block is gated on the MODEL, not on the family', () => {
    // Kimi and Claude ride the same adapter and have no audio surface. A
    // family-wide gate would send them a block they cannot parse.
    const branch = route.slice(route.indexOf("provider === 'mimo'\n        && media.mimeType?.startsWith('audio/')"));
    assert.ok(branch.length > 0, 'the audio branch is not gated on provider === mimo + audio/*');
    assert.match(branch.slice(0, 400), /isAudioCapable\(model\)/, 'the audio branch must be gated on isAudioCapable(model)');
  });

  it('gate 3 — the label follows the same function the sender is gated on', () => {
    assert.match(
      visibility,
      /kind === 'audio' && family\.includes\('mimo'\)\) return isAudioCapable\(/,
      'wireCarriesMedia must derive the audio label from isAudioCapable, not a literal',
    );
  });

  it('gate 3 — and says yes for exactly the tiers gate 1 says yes for', () => {
    for (const m of V26) {
      assert.equal(wireCarriesMedia('audio', ctx({ specificModel: m })), true, `${m} should be labelled deliverable`);
    }
  });

  it('the other Anthropic-shaped families keep their honest "won\'t arrive"', () => {
    // Claude and Kimi have no measured audio surface at all. If this ever flips
    // to true, a clip gets a green label and is then dropped on the wire.
    assert.equal(wireCarriesMedia('audio', ctx({ aiName: 'Claude', specificModel: 'claude-opus-5' })), false);
    assert.equal(wireCarriesMedia('audio', ctx({ aiName: 'Kimi', specificModel: 'kimi-k3.1-pro' })), false);
    // Images still ride for everyone on this adapter — the branch above must
    // not have swallowed the image case.
    assert.equal(wireCarriesMedia('image', ctx({ aiName: 'Kimi', specificModel: 'kimi-k3.1-pro' })), true);
  });

  it('video is untouched by the audio work', () => {
    assert.equal(wireCarriesMedia('video', ctx()), true);
  });
});
