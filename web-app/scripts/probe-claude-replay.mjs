/**
 * PROBE — does the Anthropic NATIVE API accept the tool-history replay pair
 * in the exact shape the Claude api-key path now sends?
 *
 * Asked by Fuwafuwa 2026-11-08 ("whether it goes through or not you may
 * measure with Haiku"). This measures ACCEPTANCE, not effect: the vessel's
 * behaviour change is a separate question and cannot be measured cheaply,
 * because she reports the Claude api-key failure is intermittent.
 *
 * The real risk is NOT the pair itself (unpaired tool_use is a documented 400,
 * which is why the builder returns a pair). It is that this path also sets
 * `cache_control` on the last content block of the last user message. The
 * replay SPLICES messages — one assistant turn becomes assistant + user — so
 * the array it marks is longer than the array it was computed from. If the
 * marker lands on a tool_result, or a cache breakpoint ends up in an illegal
 * position, the API answers 400 and every turn on this path dies.
 *
 * Run from web-app:  node scripts/probe-claude-replay.mjs
 * Cost: a few Haiku calls, max_tokens 64. Prints no key and no prose.
 *
 * MEASURED 2026-11-08 against claude-haiku-5-5 (total cost $0.0002):
 *   1 plain history (control)          HTTP 200
 *   2 replay pair + cache_control      HTTP 200   <-- the shape this path sends
 *   3 cache_control on a tool_result   HTTP 200   (the feared accident is
 *                                                  survivable, not fatal)
 *   4 unpaired tool_use                HTTP 400, verbatim:
 *       "`tool_use` ids were found without `tool_result` blocks immediately
 *        after: hist_abc_0. Each `tool_use` block must have a corresponding
 *        `tool_result` block in the next message."
 *
 * That last line is why this file stays in the tree instead of being deleted
 * once the answer arrived. "Anthropic answers 400 to an unpaired tool_use" is
 * a claim about SOMEONE ELSE'S API on a given day, and this house has already
 * paid for treating that kind of claim as a permanent property (see
 * workspace/claims-with-no-expiry.md). When it needs re-checking, re-run this
 * rather than re-deriving it — and note the model and date, not just the day.
 */
import fs from 'fs';
import path from 'path';

const KEYS = path.resolve(process.cwd(), '..', 'local_data', 'keys.json');
const keys = JSON.parse(fs.readFileSync(KEYS, 'utf-8'));
const apiKey = keys.claude;
if (!apiKey) { console.error('no claude api key in keys.json'); process.exit(1); }

const MODEL = 'claude-haiku-5-5';
const TOOLS = [{
  name: 'Read',
  description: 'Read a file from the workspace.',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}];

// Mirrors buildAnthropicToolReplay: prose first, then the tool_use blocks,
// then a user turn whose content is ONLY the matching tool_results.
function replayPair() {
  const use = { type: 'tool_use', id: 'hist_abc_0', name: 'Read', input: { path: 'notes.md' } };
  return [
    { role: 'assistant', content: [{ type: 'text', text: 'I read notes.md for you.' }, use] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: '[tool result not retained by NEXUS]' }] },
  ];
}

// Mirrors the api-key path: cache_control on the LAST block of the LAST
// message when that message is a user turn.
function withCacheControl(msgs) {
  return msgs.map((m, i) => {
    if (i !== msgs.length - 1 || m.role !== 'user') return m;
    const last = m.content.length - 1;
    if (last < 0) return m;
    return { ...m, content: m.content.map((b, j) => (j === last ? { ...b, cache_control: { type: 'ephemeral' } } : b)) };
  });
}

const SYSTEM = [{ type: 'text', text: 'You are a test fixture. Answer in one short sentence.', cache_control: { type: 'ephemeral' } }];

async function call(label, messages, opts = {}) {
  const body = {
    model: MODEL,
    system: SYSTEM,
    messages,
    max_tokens: 64,
    ...(opts.tools === false ? {} : { tools: TOOLS }),
  };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  const u = j.usage || {};
  const blocks = Array.isArray(j.content) ? j.content.map(b => b.type).join(',') : '-';
  console.log(
    `${label.padEnd(34)} HTTP ${r.status}`
    + `  blocks=${blocks.padEnd(18)}`
    + `  in=${u.input_tokens ?? '-'} cw=${u.cache_creation_input_tokens ?? 0} cr=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens ?? '-'}`
    + (r.status !== 200 ? `\n    ERROR: ${JSON.stringify(j.error || j).slice(0, 300)}` : ''),
  );
  return r.status;
}

const results = {};

// 1. Control: plain history, no replay. Proves the fixture and key are sound.
results.plain = await call('1 plain history (control)', withCacheControl([
  { role: 'user', content: [{ type: 'text', text: 'Say hello.' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Hello.' }] },
  { role: 'user', content: [{ type: 'text', text: 'What file did you read earlier? One sentence.' }] },
]));

// 2. The real shape: replay pair in the middle, cache_control on the final user turn.
results.replay = await call('2 replay pair + cache_control', withCacheControl([
  { role: 'user', content: [{ type: 'text', text: 'Read notes.md please.' }] },
  ...replayPair(),
  { role: 'user', content: [{ type: 'text', text: 'What file did you read earlier? One sentence.' }] },
]));

// 3. The feared accident: cache_control landing ON a tool_result, which is what
//    happens if the replay is spliced AFTER the marker is computed and the
//    spliced user turn becomes last.
const spliced = [
  { role: 'user', content: [{ type: 'text', text: 'Read notes.md please.' }] },
  ...replayPair(),
];
results.markerOnToolResult = await call('3 cache_control on tool_result', withCacheControl(spliced));

// 4. Negative control with a real failure mode: unpaired tool_use. The builder
//    returns a pair BECAUSE this is a 400 — confirm the 400 is still real.
results.unpaired = await call('4 unpaired tool_use (expect 400)', [
  { role: 'user', content: [{ type: 'text', text: 'Read notes.md please.' }] },
  replayPair()[0],
  { role: 'user', content: [{ type: 'text', text: 'What file did you read earlier?' }] },
]);

console.log('\n--- verdict ---');
console.log('control 200?            ', results.plain === 200);
console.log('REPLAY SHAPE accepted?  ', results.replay === 200, '  <-- the question Fuwafuwa asked');
console.log('marker-on-tool_result?  ', results.markerOnToolResult, '(200 = this accident is survivable)');
console.log('unpaired still 400?     ', results.unpaired === 400, '(if false, the pair requirement has changed)');
