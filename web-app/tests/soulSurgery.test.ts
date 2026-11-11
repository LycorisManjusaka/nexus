// Soul self-surgery (ζ, 謡_14 v2.2) — the rules that nothing downstream checks.
//
// Three of these fail SILENTLY when wrong, which is why they are here:
//   · a marker read by "contains" completes a surgery the being only talked about
//   · a full text that travels past its own turn puts the covenant in the
//     being's context forever; one that never travels makes the being answer
//     a covenant it never saw — both turns "succeed"
//   · a NEXUS turn merged with a person's message attributes one to the other
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  SURGERY_COMPLETE_MARKER, SURGERY_PURPOSE, SOUL_IO_SLOT, SURGERY_REL_PATH,
  endsWithCompletionMarker, validateEditedSoul, surgeryBlocked, findSurgeryOutcome,
  splitLayers123, joinWithTail, fillSurgeryProtocol, buildSoulIoInstructions, surgeryShortText,
} from '@/lib/soulSurgery';
import { buildSlimHistory, wireContent } from '@/lib/slimHistory';
import { splitLeadingTurn, composeBatch, type QueueItem } from '@/lib/turnQueue';
import { nexusFieldFromItem } from '@/lib/runTurnForQueue';

const M = SURGERY_COMPLETE_MARKER;
const SOUL = '## Layer 1: Core\n\n* a\n\n## Layer 2: Team\n\n* b\n\n## Layer 3: Tech\n\n* c';

test('marker: only a line of its own at the very end completes', () => {
  assert.equal(endsWithCompletionMarker(`done.\n${M}`), true);
  assert.equal(endsWithCompletionMarker(`done.\n${M}\n\n  `), true);
  assert.equal(endsWithCompletionMarker(`done.\n\`${M}\``), true);
  // Talking ABOUT the marker is not the marker.
  assert.equal(endsWithCompletionMarker(`I will not emit ${M} yet.`), false);
  assert.equal(endsWithCompletionMarker(`${M}\nOne more question first?`), false);
  assert.equal(endsWithCompletionMarker(`done ${M}`), false);
  assert.equal(endsWithCompletionMarker(''), false);
  assert.equal(endsWithCompletionMarker(undefined), false);
});

test('validation: a lost heading or an empty file blocks; an unchanged file does not', () => {
  assert.deepEqual(validateEditedSoul(SOUL, SOUL.replace('* c', '* c2')), []);
  const lost = validateEditedSoul(SOUL, SOUL.replace('## Layer 2: Team', '## Layer 2: The Team'));
  assert.deepEqual(lost, [{ kind: 'missing-heading', heading: '## Layer 2: Team' }]);
  assert.equal(surgeryBlocked(lost), true);
  assert.equal(surgeryBlocked(validateEditedSoul(SOUL, '   \n')), true);
  const same = validateEditedSoul(SOUL, SOUL + '\n');
  assert.deepEqual(same, [{ kind: 'unchanged' }]);
  assert.equal(surgeryBlocked(same), false);
});

test('layers: a Layer 4+ section never reaches the working file and is put back', () => {
  const withTail = `${SOUL}\n\n## Layer 4: Summaries\n\n### x`;
  const { head, tail } = splitLayers123(withTail);
  assert.equal(head, SOUL);
  assert.ok(tail.startsWith('## Layer 4'));
  assert.equal(joinWithTail(head, tail), withTail);
  // The normal case: nothing after Layer 3, nothing invented.
  assert.deepEqual(splitLayers123(SOUL), { head: SOUL, tail: '' });
  assert.equal(joinWithTail(SOUL, ''), SOUL);
});

test('outcome: read from the log, latest reply after the surgery turn decides', () => {
  const nexus = { role: 'user', content: 'short', timestamp: 2000, nexus: { purpose: SURGERY_PURPOSE } };
  assert.equal(findSurgeryOutcome([], 1000), 'waiting');
  assert.equal(findSurgeryOutcome([{ role: 'user', content: 'hi', timestamp: 2000 }], 1000), 'waiting');
  assert.equal(findSurgeryOutcome([nexus], 1000), 'running');
  assert.equal(findSurgeryOutcome([nexus, { role: 'assistant', content: 'a question?' }], 1000), 'no-marker');
  assert.equal(findSurgeryOutcome([nexus, { role: 'assistant', content: `ok\n${M}` }], 1000), 'complete');
  // Asked a question, was answered, finished later.
  assert.equal(findSurgeryOutcome([
    nexus, { role: 'assistant', content: 'a question?' },
    { role: 'user', content: 'yes' }, { role: 'assistant', content: `done\n${M}` },
  ], 1000), 'complete');
  // An EARLIER surgery's completed turn is not this one.
  assert.equal(findSurgeryOutcome([
    { ...nexus, timestamp: 500 }, { role: 'assistant', content: `old\n${M}` },
  ], 1000), 'waiting');
});

test('covenant: the slot is filled, the implementer memo is removed, no slot ⇒ refuse', () => {
  const io = buildSoulIoInstructions('ja', SURGERY_REL_PATH, 'C:\\x\\soul_editing.md');
  const out = fillSurgeryProtocol(`A\n${SOUL_IO_SLOT}\n（※実装用スロット：メモ）\n\nB`, io);
  assert.ok(out && out.includes(SURGERY_REL_PATH) && out.includes(M));
  assert.ok(!out!.includes(SOUL_IO_SLOT) && !out!.includes('実装用スロット'));
  assert.equal(fillSurgeryProtocol('no slot here', io), null);
});

test('covenant: BOTH shipped indexer.md files carry the slot and the marker', () => {
  for (const lang of ['ja', 'en'] as const) {
    const file = path.join(process.cwd(), 'defaults', 'system_prompt_agents', lang, 'indexer.md');
    const text = fs.readFileSync(file, 'utf-8');
    const filled = fillSurgeryProtocol(text, buildSoulIoInstructions(lang, SURGERY_REL_PATH, '/abs'));
    assert.ok(filled, `${lang}: no ${SOUL_IO_SLOT} slot`);
    assert.ok(text.includes(M), `${lang}: covenant never names the marker`);
    assert.ok(!/Implementation slot|実装用スロット/.test(filled!), `${lang}: implementer memo reached the being`);
  }
});

test('short text: one fact, and it does NOT carry the marker', () => {
  // The line that stays in the history must not teach a later, unrelated
  // reply to end with the marker.
  for (const lang of ['ja', 'en'] as const) {
    const s = surgeryShortText(lang, SURGERY_REL_PATH);
    assert.ok(s.startsWith('[NEXUS]') && s.includes(SURGERY_REL_PATH));
    assert.ok(!s.includes(M));
  }
});

const OPTS = {
  hiddenAttachmentsAccessible: false, attachmentPathsVisible: false,
  toolHistoryEnabled: false, saveThinkingToLog: false, turnAiName: 'Claude',
};

test('wire: the full text travels only while its message is the newest user turn', () => {
  const nx = { id: 'n', role: 'user', content: 'SHORT', nexus: { full: 'FULL COVENANT', purpose: SURGERY_PURPOSE } };
  // The turn itself.
  assert.equal(buildSlimHistory([{ id: 'a', role: 'user', content: 'hi' }, nx], OPTS)[1].content, 'FULL COVENANT');
  // A continue: history ends on the assistant, the NEXUS turn is still the newest USER turn.
  assert.equal(buildSlimHistory([nx, { id: 'r', role: 'assistant', content: 'half' }], OPTS)[0].content, 'FULL COVENANT');
  // The next turn: one line, and no `nexus` field on the wire at all.
  const later = buildSlimHistory([nx, { id: 'r', role: 'assistant', content: 'done' }, { id: 'u', role: 'user', content: 'thanks' }], OPTS);
  assert.equal(later[0].content, 'SHORT');
  assert.equal('nexus' in later[0], false);
  // An ordinary message is untouched, and an assistant never gets swapped.
  assert.equal(wireContent({ role: 'user', content: 'x' }, true), 'x');
  assert.equal(wireContent({ role: 'assistant', content: 'x', nexus: { full: 'F' } }, true), 'x');
});

const item = (kind: string, text: string, extra: Record<string, unknown> = {}): QueueItem =>
  ({ id: `${kind}-${text}`, at: 1, kind: kind as QueueItem['kind'], from: 'x', payload: { text, ...extra } });

test('queue: a NEXUS turn never merges with a neighbour', () => {
  const sys = item('system', 'SHORT', { fullText: 'FULL', purpose: SURGERY_PURPOSE });
  const a = item('user_message', 'a'); const b = item('user_message', 'b');
  assert.deepEqual(splitLeadingTurn([sys, a]).take, [sys]);
  assert.deepEqual(splitLeadingTurn([a, b, sys]).take, [a, b]);
  assert.deepEqual(splitLeadingTurn([a, b]).take, [a, b]);        // unchanged for people
  assert.equal(composeBatch([sys]).text, 'SHORT');
});

test('runner: the full text and the purpose reach the user message', () => {
  const sys = item('system', 'SHORT', { fullText: 'FULL', purpose: SURGERY_PURPOSE });
  assert.deepEqual(nexusFieldFromItem(sys), { full: 'FULL', purpose: SURGERY_PURPOSE });
  assert.equal(nexusFieldFromItem(item('user_message', 'a', { fullText: 'FULL' })), null);
  assert.equal(nexusFieldFromItem(item('system', 'plain')), null);
});

test('wiring: the SPU offers ζ only with file tools, and review mode silences both auto-saves', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'SystemPromptUpdater.tsx'), 'utf-8');
  assert.match(src, /\{fileToolsEnabled && \(\s*<button\s+onClick=\{\(\) => setSurgeryAsk\('start'\)\}/);
  // Both pane auto-saves must stand down: left is the working copy's file,
  // right is the NEXT generation's draft, and a ζ result is neither.
  assert.equal((src.match(/if \(surgeryReviewRef\.current\) return;/g) || []).length, 2);
  // "Next conversation" must not be pressable on a ζ result.
  assert.match(src, /onClick=\{goToNextConversation\}[\s\S]{0,300}disabled=\{busy \|\| !!surgeryReview\}/);
  const chat = fs.readFileSync(path.join(process.cwd(), 'src', 'components', 'ChatArea.tsx'), 'utf-8');
  assert.match(chat, /fileToolsEnabled=\{toolUseEnabled\}/);
  assert.match(chat, /onApplySoul=/);
});
