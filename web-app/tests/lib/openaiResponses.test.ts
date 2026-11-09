/**
 * OpenAI /v1/responses boundary converters.
 *
 * gpt-6.1-sol / gpt-6-astra cannot use function tools on /v1/chat/completions,
 * so NEXUS routes them to /v1/responses and TRANSLATES the chat-format message
 * loop to the responses `input` shape on every call (lib/openaiResponses.ts).
 * These are the pure converters; the live round-trip was measured 2026-11-09
 * (gpt-6.1-sol: tool call -> execute -> function_call_output -> final answer).
 *
 * The load-bearing invariant is the CALL_ID JOIN: a responses function_call is
 * matched to its function_call_output by `call_id`. The chat loop carries that
 * id as tool_calls[].id on the assistant turn and tool_call_id on the result;
 * if the converter read the wrong field for either, the second round would 400
 * ("No tool output found for function call ...") or lose the thread. One test
 * pins exactly that round-trip.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chatToolsToResponsesTools, chatMessagesToResponsesInput } from '../../src/lib/openaiResponses';

describe('chatToolsToResponsesTools', () => {
  it('flattens {function:{...}} into the responses flat tool shape', () => {
    const out = chatToolsToResponsesTools([
      { type: 'function', function: { name: 'get_weather', description: 'd', parameters: { type: 'object' } } },
    ]);
    assert.deepEqual(out, [{ type: 'function', name: 'get_weather', description: 'd', parameters: { type: 'object' } }]);
  });

  it('drops entries with no name and tolerates undefined', () => {
    assert.deepEqual(chatToolsToResponsesTools(undefined), []);
    const out = chatToolsToResponsesTools([
      { type: 'function', function: { name: '' } } as any,
      { type: 'function', function: { name: 'ok' } },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'ok');
  });

  it('omits description/parameters when absent (no undefined keys on the wire)', () => {
    const out = chatToolsToResponsesTools([{ type: 'function', function: { name: 'bare' } }]);
    assert.deepEqual(out, [{ type: 'function', name: 'bare' }]);
  });
});

describe('chatMessagesToResponsesInput', () => {
  it('maps system -> developer', () => {
    const out = chatMessagesToResponsesInput([{ role: 'system', content: 'be terse' }]);
    assert.deepEqual(out, [{ role: 'developer', content: 'be terse' }]);
  });

  it('keeps a plain string user message as a string', () => {
    const out = chatMessagesToResponsesInput([{ role: 'user', content: 'hi' }]);
    assert.deepEqual(out, [{ role: 'user', content: 'hi' }]);
  });

  it('converts a user image part to input_image with image_url as a STRING', () => {
    const out = chatMessagesToResponsesInput([{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    }]) as any[];
    assert.deepEqual(out[0].content, [
      { type: 'input_text', text: 'what is this' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    ]);
  });

  it('emits function_call items for an assistant turn and skips empty assistant text', () => {
    const out = chatMessagesToResponsesInput([{
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } }],
    }]) as any[];
    // Empty assistant text produces NO message item — only the function_call.
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Tokyo"}' });
  });

  it('maps a tool result to function_call_output keyed by tool_call_id', () => {
    const out = chatMessagesToResponsesInput([{ role: 'tool', tool_call_id: 'call_9', content: 'Sunny' }]) as any[];
    assert.deepEqual(out, [{ type: 'function_call_output', call_id: 'call_9', output: 'Sunny' }]);
  });

  it('CALL_ID JOIN: the assistant tool_call id and the tool_call_id land on matching call_ids', () => {
    // This is the exact sequence the outer loop builds between rounds.
    const out = chatMessagesToResponsesInput([
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_ABC', function: { name: 'get_weather', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_ABC', content: 'Sunny' },
    ]) as any[];
    const fc = out.find(i => i.type === 'function_call');
    const fco = out.find(i => i.type === 'function_call_output');
    assert.ok(fc && fco, 'both items present');
    assert.equal(fc.call_id, 'call_ABC');
    assert.equal(fco.call_id, 'call_ABC');
    // Same key on both halves — without it the responses API cannot pair them.
    assert.equal(fc.call_id, fco.call_id);
  });

  it('does not carry non-standard chat fields (reasoning_content, name) onto items', () => {
    const out = chatMessagesToResponsesInput([{
      role: 'assistant',
      content: 'hello',
      reasoning_content: 'secret thoughts',
      name: 'bob',
    } as any]) as any[];
    assert.deepEqual(out, [{ role: 'assistant', content: 'hello' }]);
  });
});
