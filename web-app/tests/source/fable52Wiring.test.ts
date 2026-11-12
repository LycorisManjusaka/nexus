/**
 * Fable 5.2 — added in lockstep across the functional surfaces, and its sibling
 * is kept OUT on measurement.
 *
 * MEASURED 2026-11-10 via count_tokens on the API key (free, no charge):
 *   claude-fable-5-2   -> 200  (exists)            ← added
 *   claude-mythos-5-2  -> 404 not_found_error      ← NOT added
 *   claude-fable-5-1 / claude-opus-5  -> 200       (controls)
 *
 * Mythos has shadowed Fable in lockstep since 5/5.1, so a future "add the
 * sibling too" edit is the natural mistake. Gate 5 pins the 404 so a dead model
 * cannot be resurrected into the dropdown the way GPT-6 Cyber/Rosalind nearly
 * were.
 *
 * WHY A WIRING TEST. The thinking path handles 5.2 for free (route.ts matches
 * /fable-?5/), so the only add points are the four that list the id verbatim:
 * price row, vision set, family, dropdown option. "It typechecks" does not prove
 * the id reached the <select> a human picks from — that gap shipped twice this
 * week (hidden tool-history checkbox, a draw offset that never reached prod).
 *
 * The price is PROVISIONAL (carried forward from 5.1, unverified — see
 * _NOTE_fable_5_2). Gate 1 only asserts a row EXISTS, not that the number is
 * right: an unpriced new model vanishes from stats (the 16-model hole found
 * 2026-11-09), and that invisibility is what this gate guards against.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { resolvePrice } from '@/lib/modelPricing';
import { VISION_CAPABLE_MODELS } from '@/lib/modelVision';
import { familyFromModelId } from '@/lib/modelFamily';

const CHATAREA = path.join(process.cwd(), 'src', 'components', 'ChatArea.tsx');
// 2026-11-12: the model lists moved out of ChatArea into FamilyModelPicker (one
// component, used by the Model tab and by the anchor's picker). Both files are
// read so gate 5 still covers every place a model id could be offered.
const PICKER = path.join(process.cwd(), 'src', 'components', 'FamilyModelPicker.tsx');
const chatArea = [fs.readFileSync(CHATAREA, 'utf-8'), fs.readFileSync(PICKER, 'utf-8')].join(String.fromCharCode(10));

describe('Fable 5.2 wiring', () => {
  it('1. is priced — a row exists so its turns do not vanish from stats', () => {
    const p = resolvePrice('claude-fable-5-2');
    assert.ok(p, 'claude-fable-5-2 has no price row (would be an invisible-zero hole)');
    assert.equal(p!.input, 10);
    assert.equal(p!.output, 50);
  });

  it('2. is vision-capable (family-level Claude vision)', () => {
    assert.ok(VISION_CAPABLE_MODELS.has('claude-fable-5-2'));
  });

  it('3. resolves to the Claude family', () => {
    assert.equal(familyFromModelId('claude-fable-5-2'), 'Claude');
  });

  it('4. is offered in the model dropdown (reached the screen, not just the type)', () => {
    assert.ok(
      chatArea.includes('<option value="claude-fable-5-2">'),
      'ChatArea dropdown has no claude-fable-5-2 option',
    );
  });

  it('5. its sibling claude-mythos-5-2 is NOT added (measured 404)', () => {
    assert.equal(resolvePrice('claude-mythos-5-2'), null, 'mythos-5-2 was priced — it 404s, do not add it');
    assert.ok(
      !chatArea.includes('claude-mythos-5-2'),
      'ChatArea references claude-mythos-5-2 — a dead model (404) must not reach the dropdown',
    );
  });
});
