import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  wireCarriesMedia,
  undeliverableReason,
  applyAutoHide,
  type DeliveryContext,
} from '@/lib/attachmentVisibility';

// ── What these tests are guarding ─────────────────────────────────────────
//
// This module answers one question — "will this attachment actually reach the
// entity?" — and the cost of answering it wrong is not cosmetic. When it said
// "yes" for a kind the provider cannot parse, the WHOLE TURN died on a 422
// before the model was reached:
//
//   DeepSeek API: 422 "Failed to deserialize the JSON body into the target
//   type: messages[0]: unknown variant `video_url`, expected one of `text`,
//   `image_url`, `file`"
//
// Reported by つよ 2026-11-05 ("動画を送ったらさぁ、これが出てくるわけ").
//
// The repair was one line in wireCarriesMedia. Everything downstream — the
// auto-exclude, the amber "won't arrive" badge, the token counter — was
// already correct and already waiting on this function's answer. So the line
// these tests hold is narrow and load-bearing: DeepSeek carries images, and
// nothing else.
//
// The second half guards the OTHER direction. `family.includes('deepseek')` is
// a substring match on a free-text field; a future edit that broadens it (or
// writes the rule as "OpenAI-compatible families carry images only") would
// quietly stop sending audio and video to GLM and Qwen, where they work. A
// false "won't arrive" is a lie in the same way a false "arrives" is — it just
// fails silently instead of loudly, which is worse.

const ctx = (over: Partial<DeliveryContext> = {}): DeliveryContext => ({
  specificModel: 'deepseek-flash',
  aiName: 'DeepSeek',
  isOAuthClaude: false,
  eyesEnabled: false,
  earsEnabled: false,
  watcherEnabled: false,
  ...over,
});

// ── The 422 ────────────────────────────────────────────────────────────────

test('DeepSeek wire carries images and refuses audio/video', () => {
  assert.equal(wireCarriesMedia('image', ctx()), true);
  // Both of these were `true` when the 422 was reported.
  assert.equal(wireCarriesMedia('video', ctx()), false);
  // Audio rides on the same evidence: `input_audio` is absent from the list
  // DeepSeek itself printed as its accepted variants.
  assert.equal(wireCarriesMedia('audio', ctx()), false);
});

test('a DeepSeek video is reported undeliverable with the wire reason', () => {
  assert.equal(undeliverableReason('video', false, ctx()), 'wire');
  assert.equal(undeliverableReason('audio', false, ctx()), 'wire');
  assert.equal(undeliverableReason('image', false, ctx()), null);
});

test('the watcher outranks the wire — a described clip arrives as text', () => {
  // The repair must not make Watcher-on conversations worse. A description is
  // text, and every wire carries text.
  assert.equal(undeliverableReason('video', false, ctx({ watcherEnabled: true })), null);
  assert.equal(undeliverableReason('audio', false, ctx({ earsEnabled: true })), null);
});

test('an undeliverable DeepSeek clip is auto-excluded, which is what stops the 422', () => {
  // This is the end-to-end claim in miniature: the send path never sees an
  // excluded attachment, so marking it here is the whole repair.
  const messages = [
    { attachments: [{ id: 'a1', isVideo: true, type: 'video/mp4' }] },
  ];
  const { changed, next } = applyAutoHide(messages as any, {
    sessionActive: false,
    keepMessages: 15,
    lastUserMsgIndex: 0,
    ctx: ctx(),
  });
  assert.equal(changed, true);
  assert.equal((next[0] as any).attachments[0].excluded, true);
  assert.equal((next[0] as any).attachments[0].autoHidden, true);
});

test('an image on the same path is left alone', () => {
  const messages = [
    { attachments: [{ id: 'a1', isImage: true, type: 'image/png' }] },
  ];
  const { changed } = applyAutoHide(messages as any, {
    sessionActive: false,
    keepMessages: 15,
    lastUserMsgIndex: 0,
    ctx: ctx(),
  });
  assert.equal(changed, false);
});

// ── The other direction: do not over-report loss ───────────────────────────

test('other OpenAI-compatible families still carry all three', () => {
  for (const aiName of ['GLM', 'Qwen', 'Grok', 'Minimax', 'ChatGPT']) {
    const c = ctx({ aiName, specificModel: 'glm-5.3' });
    assert.equal(wireCarriesMedia('image', c), true, `${aiName} image`);
    assert.equal(wireCarriesMedia('audio', c), true, `${aiName} audio`);
    assert.equal(wireCarriesMedia('video', c), true, `${aiName} video`);
  }
});

test('an unknown family claims nothing — silence is not evidence of loss', () => {
  const c = ctx({ aiName: '' });
  assert.equal(wireCarriesMedia('video', c), true);
  assert.equal(undeliverableReason('video', false, c), null);
});

test('text and other kinds are never a wire question', () => {
  assert.equal(wireCarriesMedia('text', ctx()), true);
  assert.equal(wireCarriesMedia('other', ctx()), true);
});

// ── Neighbours that must not have moved ────────────────────────────────────

test('the Anthropic-shaped families keep their existing answers', () => {
  const claude = ctx({ aiName: 'Claude', specificModel: 'claude-opus-5' });
  assert.equal(wireCarriesMedia('image', claude), true);
  assert.equal(wireCarriesMedia('video', claude), false);
  assert.equal(wireCarriesMedia('audio', claude), false);

  // Meta: images only, measured separately.
  const meta = ctx({ aiName: 'Meta', specificModel: 'muse-spark' });
  assert.equal(wireCarriesMedia('image', meta), true);
  assert.equal(wireCarriesMedia('audio', meta), false);

  // Local (LM Studio): audio cannot arrive, video is decoded to frames.
  const local = ctx({ aiName: 'Local', specificModel: 'google/gemma-4-26b' });
  assert.equal(wireCarriesMedia('audio', local), false);
  assert.equal(wireCarriesMedia('video', local), true);
});

test('OAuth past images are still reported, independently of the wire', () => {
  const c = ctx({ aiName: 'Claude', specificModel: 'claude-opus-5', isOAuthClaude: true });
  assert.equal(undeliverableReason('image', true, c), 'oauth-transcript');
  assert.equal(undeliverableReason('image', false, c), null);
});
