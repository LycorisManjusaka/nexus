/**
 * Gemini 4 Carbon wiring (added 2026-11-13).
 *
 * Measured that day against the live API (ListModels + generateContent):
 *   - exists: in=1048576, out=32768
 *   - thinkingLevel 'minimal' -> 400 "Thinking level MINIMAL is not supported";
 *     low / medium / high -> 200
 *   - image, audio and video each answered correctly on BOTH variants of a
 *     mirrored stimulus (left/right, up/down, blue-red/red-blue)
 *   - function calling returns a functionCall part
 *
 * The load-bearing gate is 3: without the no-minimal entry the UI's default
 * thinking level 400s on every single turn (the `pro` substring rule does not
 * match this id) — the model would be in the list and unusable.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { resolvePrice } from '@/lib/modelPricing';
import {
  VISION_CAPABLE_MODELS,
  AUDIO_CAPABLE_MODELS,
  VIDEO_CAPABLE_MODELS,
  resolveGeminiMinThinkingLevel,
} from '@/lib/modelVision';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf-8');
const chatArea = read('components', 'ChatArea.tsx');
const picker = read('components', 'FamilyModelPicker.tsx');
const ID = 'gemini-4-carbon';

describe('Gemini 4 Carbon wiring', () => {
  it('1. is priced at the published rate — a row exists so its turns do not vanish from stats', () => {
    const p = resolvePrice(ID);
    assert.ok(p, `${ID} has no price row (would be an invisible-zero hole)`);
    assert.equal(p!.input, 2.0);
    assert.equal(p!.output, 10);
    assert.equal(p!.cachedInput, 0.1);
  });

  it('2. carries image, audio and video natively (bridges stay off)', () => {
    assert.ok(VISION_CAPABLE_MODELS.has(ID));
    assert.ok(AUDIO_CAPABLE_MODELS.has(ID));
    assert.ok(VIDEO_CAPABLE_MODELS.has(ID));
  });

  it("3. 'minimal' thinking is clamped to 'low' (minimal is a measured 400)", () => {
    assert.equal(resolveGeminiMinThinkingLevel(ID), 'low');
  });

  it('4. is offered in the Model tab picker and in the bridge-model lists', () => {
    assert.ok(picker.includes(`<option value="${ID}">`), 'FamilyModelPicker has no carbon option');
    assert.ok(chatArea.includes(`value: '${ID}'`), 'eyes bridge list has no carbon entry');
    const opts = chatArea.split(`<option value="${ID}">`).length - 1;
    assert.equal(opts, 2, 'ears + video bridge selects should each offer carbon');
  });
});
