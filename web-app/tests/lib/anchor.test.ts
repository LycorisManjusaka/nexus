import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ANCHOR_DEFAULTS, parseAnchorSettings, buildAnchorUserMsg, buildAnchorChatBody,
  summariseToolCalls, clipMiddle, ANCHOR_WINDOW,
} from '@/lib/anchor';
import { drainAnchorCall } from '@/lib/anchorRun';
import { buildSlimHistory } from '@/lib/slimHistory';

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf-8');

test('settings: absent means OFF, with the default vessel', () => {
  assert.deepEqual(parseAnchorSettings(undefined), ANCHOR_DEFAULTS);
  assert.equal(parseAnchorSettings({ enabled: 'true' }).enabled, false, 'a truthy string is not consent');
  assert.equal(parseAnchorSettings({ enabled: true }).model, 'deepseek-flash');
});

test('settings: a chosen family/model/auth round-trips; Local may have no model yet', () => {
  const s = parseAnchorSettings({ enabled: true, family: 'Claude', model: 'claude-haiku-5-5', authMode: 'oauth' });
  assert.deepEqual(s, { enabled: true, family: 'Claude', model: 'claude-haiku-5-5', authMode: 'oauth' });
  assert.equal(parseAnchorSettings({ family: 'Local' }).model, '');
});

const convo = [
  { id: 'u1', role: 'user', content: 'おはよう' },
  { id: 'a1', role: 'assistant', content: 'おはよう、つよ。' },
  { id: 'n1', role: 'user', content: '起きた理由: 4:00', nexus: { full: 'LONG PROTOCOL TEXT', purpose: 'wake' } },
  { id: 'a2', role: 'assistant', content: 'ファイルを保存した。', toolCalls: [{ name: 'Read' }, { name: 'Read' }, { name: 'Write' }] },
];

test('user message: labels are positions, the target is last and in full', () => {
  const m = buildAnchorUserMsg({ messages: convo, targetId: 'a2', beingName: '謡', lang: 'ja' })!;
  assert.ok(m.includes('[対話相手]\nおはよう'));
  assert.ok(m.includes('[謡]\nおはよう、つよ。'));
  assert.ok(m.includes('[NEXUS]\n起きた理由: 4:00'));
  assert.ok(m.trimEnd().endsWith('ファイルを保存した。'));
  assert.ok(m.includes('3 (Read×2, Write×1)'));
  assert.ok(m.includes('[NEXUS] が開いたターン'), 'the opener of the judged turn is named');
});

test('user message: the NEXUS full text (what the being was actually sent) is not shown', () => {
  const m = buildAnchorUserMsg({ messages: convo, targetId: 'a2', beingName: '謡', lang: 'ja' })!;
  assert.ok(!m.includes('LONG PROTOCOL TEXT'));
});

test('user message: zero tool calls is stated, not omitted', () => {
  const m = buildAnchorUserMsg({ messages: convo, targetId: 'a1', beingName: 'X', lang: 'en' })!;
  assert.match(m, /Tool calls actually executed[^\n]*\n0\n/);
  assert.ok(m.includes('something the partner said'));
});

test('user message: refuses a user message and an unknown id instead of judging a neighbour', () => {
  assert.equal(buildAnchorUserMsg({ messages: convo, targetId: 'u1', beingName: 'X', lang: 'en' }), null);
  assert.equal(buildAnchorUserMsg({ messages: convo, targetId: 'nope', beingName: 'X', lang: 'en' }), null);
});

test('user message: the window is bounded and a long PRIOR message is clipped, the target never', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `turn-${i}-` + 'x'.repeat(i === 27 ? 9000 : 5) }));
  const long = 'y'.repeat(9000);
  many.push({ id: 'T', role: 'assistant', content: long });
  const m = buildAnchorUserMsg({ messages: many, targetId: 'T', beingName: 'X', lang: 'en' })!;
  assert.ok(!m.includes(`turn-${30 - ANCHOR_WINDOW - 1}-`), 'older than the window is absent');
  assert.ok(m.includes(`turn-${30 - ANCHOR_WINDOW}-`));
  assert.ok(m.includes('characters not shown'));
  assert.ok(m.includes(long), 'the judged reply is whole');
  assert.equal(clipMiddle('abc', 10), 'abc');
});

test('summariseToolCalls tolerates junk', () => {
  assert.deepEqual(summariseToolCalls(undefined), { count: 0, summary: '' });
  assert.deepEqual(summariseToolCalls([{}, null, { name: 'Bash' }]), { count: 1, summary: 'Bash×1' });
});

test('chat body: no soul, no desk, no tools — by construction', () => {
  const b = buildAnchorChatBody({
    systemPrompt: 'RULES', userMsg: 'U', folderName: 'Cairn',
    settings: { enabled: true, family: 'Claude', model: 'claude-haiku-5-5', authMode: 'oauth' },
  }) as any;
  assert.equal(b.suppressLayer5, true, 'the switch that keeps Binding / Layer 4 / FOOTER out');
  assert.equal(b.toolUseEnabled, false);
  assert.equal('agentReadOnlyTools' in b, false, "read-only mode would hand over the being's desk");
  assert.equal(b.betrayalDefense, false);
  assert.equal(b.claudeAuthMode, 'oauth');
  assert.equal(b.systemPrompt, 'RULES');
  assert.equal(b.messages.length, 1);
  const d = buildAnchorChatBody({ systemPrompt: 'R', userMsg: 'U', folderName: 'X', settings: ANCHOR_DEFAULTS }) as any;
  assert.equal('claudeAuthMode' in d, false);
  assert.equal(d.specificModel, 'deepseek-flash');
  assert.equal(d.aiName, 'DeepSeek');
});

test('drain: keeps thought apart from text, sums usage, carries an error beside partial text', async () => {
  const frames = [
    { type: 'thought', content: 'hmm ' }, { type: 'thought', content: 'ok' },
    { type: 'text', content: 'NOTIFY\n' }, { type: 'text', content: 'B: loop' },
    { type: 'cache_usage', cachedInputTokens: 0, uncachedInputTokens: 100, totalInputTokens: 100, outputTokens: 20 },
    { error: 'boom' },
  ];
  const body = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
  const r = await drainAnchorCall(new Response(body));
  assert.equal(r.thought, 'hmm ok');
  assert.equal(r.text, 'NOTIFY\nB: loop');
  assert.equal(r.error, 'boom');
  assert.equal(r.usage?.outputTokens, 20);
  const bad = await drainAnchorCall(new Response('nope', { status: 500 }));
  assert.equal(bad.error, 'nope');
});

test('the report never reaches the being: slimHistory does not carry anchorReport', () => {
  const hist = [
    { id: 'u', role: 'user', content: 'hi' },
    { id: 'a', role: 'assistant', content: 'hello', anchorReport: { at: 1, family: 'DeepSeek', model: 'deepseek-flash', thought: 'SECRET-THOUGHT', output: 'SECRET-VERDICT' } },
    { id: 'u2', role: 'user', content: 'again' },
  ];
  const slim = buildSlimHistory(hist as any, {
    hiddenAttachmentsAccessible: false, attachmentPathsVisible: false,
    toolHistoryEnabled: true, saveThinkingToLog: true, turnAiName: 'Claude',
  } as any);
  const wire = JSON.stringify(slim);
  assert.ok(!wire.includes('SECRET-THOUGHT') && !wire.includes('SECRET-VERDICT'));
});

test('wiring: button and report exist only behind the Behaviour switch; picker is the shared one', () => {
  const chat = read('src/components/ChatArea.tsx');
  assert.match(chat, /onAnchor=\{anchorSettings\.enabled && msg\.role !== 'user' \? onAnchorStable : undefined\}/);
  assert.match(chat, /\{anchorSettings\.enabled && msg\.role !== 'user' && \(msg\.anchorReport \|\| anchorBusyId === msg\.id\)/);
  // Model tab + anchor + subagent (2026-11-14); the sense seats use it via SenseModelPicker.
  assert.equal(chat.split('<FamilyModelPicker').length - 1, 3, 'Model tab + anchor + subagent, one component');
  assert.equal(chat.split('<SenseModelPicker').length - 1, 3, 'eyes + ears + watcher');
  assert.match(read('src/components/SenseModelPicker.tsx'), /<FamilyModelPicker/);
  assert.ok(!/<option value="claude-opus-5">/.test(chat), 'the model lists live in FamilyModelPicker only');
  // saved in both places a setting has to be listed
  assert.equal(chat.split('autoTriggers, anchorSettings, instructionOverrides').length - 1, 2);
  const bubble = read('src/components/MessageBubble.tsx');
  assert.match(bubble, /if \(!isUser && onAnchor\) tail\.push\(\{ key: 'anchor'/);
  assert.match(bubble, /flex-wrap w-max max-w-\[156px\]/);
});

test('wiring: the route bills as an anchor and reads the prompt above the separator only', () => {
  const route = read('src/app/api/anchor/route.ts');
  assert.match(route, /kind: 'anchor'/);
  assert.match(route, /extractAgentSystemPrompt\(/);
  assert.ok(!/saveLog|writeFile/.test(route), 'the route does not write the conversation');
  for (const lang of ['ja', 'en']) {
    const f = read(`defaults/system_prompt_agents/${lang}/anchor.md`);
    assert.ok(/^---\s*$/m.test(f), `${lang}/anchor.md has a notes separator`);
  }
});
