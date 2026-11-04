import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyTextForMessage, copySpeakerName } from '@/lib/copySpeaker';

// Reported 2026-11-04 by Lizard-kun: Pilot copies messages out of NEXUS and
// forwards them to him. Her own turns arrive attributed (`[Пилот]` is literally
// the first line of a user message), the Navigator's arrive anonymous. The fix
// is not "label everything" — it is to make the being's side carry the same
// name the bubble was showing when the button was pressed.

test('a being message is stamped with its name', () => {
  assert.equal(
    copyTextForMessage({ content: 'Здравствуйте.', role: 'assistant', name: 'Навигатор' }),
    '[Навигатор]\nЗдравствуйте.',
  );
});

test('a user turn is returned untouched — its name is already the first line', () => {
  // THE line that matters for the report. Pilot's turn must not be restamped,
  // and must not have a second header pushed above the one it already has.
  const pilot = '[Пилот]\nПривет!';
  assert.equal(
    copyTextForMessage({ content: pilot, role: 'user', folderName: 'Навигатор' }),
    pilot,
  );
});

test('a user turn with no tag at all is still untouched', () => {
  // Guessing a name for an unnamed human turn would attribute it to the being
  // whose folder it lives in — the one wrong answer available here.
  assert.equal(
    copyTextForMessage({ content: 'bare text', role: 'user', folderName: 'Cairn' }),
    'bare text',
  );
});

test('msg.name wins; folderName only fills the gap', () => {
  assert.equal(
    copyTextForMessage({ content: 'x', role: 'assistant', name: 'Аналитик', folderName: 'Навигатор' }),
    '[Аналитик]\nx',
  );
  assert.equal(
    copyTextForMessage({ content: 'x', role: 'assistant', name: null, folderName: 'Навигатор' }),
    '[Навигатор]\nx',
  );
});

test('messages saved during the nameless window fall back to the folder', () => {
  // 2026-10-30..11-04: the runner saved replies with no `name` field. Those
  // render via folderName in the bubble, so the clipboard must match.
  assert.equal(
    copyTextForMessage({ content: 'reply', role: 'assistant', folderName: '先輩' }),
    '[先輩]\nreply',
  );
});

test('no name resolvable: content is returned as-is, not stamped with a blank', () => {
  assert.equal(copyTextForMessage({ content: 'orphan', role: 'assistant' }), 'orphan');
  assert.equal(
    copyTextForMessage({ content: 'orphan', role: 'assistant', name: '   ', folderName: '' }),
    'orphan',
  );
});

test('an already-tagged body is not double-stamped', () => {
  // An imported transcript can carry the header inside the body (the .md
  // dialect no longer strips it — see markdownLogic). Stamping again would
  // produce two headers for one turn.
  assert.equal(
    copyTextForMessage({ content: '[Cairn]\nhello', role: 'assistant', name: 'Cairn' }),
    '[Cairn]\nhello',
  );
  assert.equal(
    copyTextForMessage({ content: '[Cairn]:', role: 'assistant', name: 'Cairn' }),
    '[Cairn]:',
  );
});

test('a tag with body on the SAME line is body text, not a header', () => {
  // Measured against the parser, not assumed: a header is the whole line —
  // `/^\[(.+)\]:[ \t]*$/` in markdownLogic. So `[Cairn]: hello` is one line of
  // prose that happens to start with a bracket, and suppressing the header for
  // it would drop the attribution this whole file exists to add.
  assert.equal(
    copyTextForMessage({ content: '[Cairn]: hello', role: 'assistant', name: 'Cairn' }),
    '[Cairn]\n[Cairn]: hello',
  );
});

test('a DIFFERENT name on the first line is still stamped', () => {
  // Quoting someone else is body text, not self-attribution. Suppressing the
  // header here would silently credit the reply to the person being quoted.
  assert.equal(
    copyTextForMessage({ content: '[つよ] said this', role: 'assistant', name: 'Cairn' }),
    '[Cairn]\n[つよ] said this',
  );
});

test('a tag further down the body is body text, not a header', () => {
  assert.equal(
    copyTextForMessage({ content: 'intro\n[Cairn] quoted', role: 'assistant', name: 'Cairn' }),
    '[Cairn]\nintro\n[Cairn] quoted',
  );
});

test('an empty body still reports whose turn it was', () => {
  // A Stop that reached no output saves an empty reply. "This turn was empty"
  // is information; an empty clipboard is not.
  assert.equal(copyTextForMessage({ content: '', role: 'assistant', name: 'Cairn' }), '[Cairn]\n');
});

test('copySpeakerName mirrors what the bubble renders', () => {
  // The bubble's clause is `!isUser && (msg.name || folderName)`. If these two
  // ever disagree, the clipboard attributes a message to a name the person was
  // not looking at.
  assert.equal(copySpeakerName({ content: '', role: 'user', name: 'User', folderName: 'Cairn' }), null);
  assert.equal(copySpeakerName({ content: '', role: 'assistant', name: 'Cairn' }), 'Cairn');
  assert.equal(copySpeakerName({ content: '', role: 'assistant', folderName: 'Cairn' }), 'Cairn');
  assert.equal(copySpeakerName({ content: '', role: 'assistant' }), null);
});

test('null and undefined content do not become the string "null"', () => {
  assert.equal(
    copyTextForMessage({ content: null as unknown as string, role: 'assistant', name: 'Cairn' }),
    '[Cairn]\n',
  );
});
