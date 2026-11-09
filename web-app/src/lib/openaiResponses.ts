// ── OpenAI /v1/responses dialect — converters ────────────────────────────────
//
// gpt-6.1-sol and gpt-6-astra cannot use function tools on /v1/chat/completions:
// tools there require reasoning_effort 'none', and those two reject 'none' (their
// vocabulary is low|medium|high|xhigh — see lib/openaiEffort.ts). The documented
// route is /v1/responses, which DOES take function tools with any effort.
//
// NEXUS's whole tool loop is built in chat/completions shape: `messages` with
// {role:'assistant', tool_calls:[...]} turns and {role:'tool', tool_call_id}
// results. Rather than fork the outer loop and the (large, closure-entangled)
// tool executor, the responses path TRANSLATES AT THE BOUNDARY: the same chat
// `messages` array is converted to the responses `input` array on every call,
// and the responses stream is mapped back to the same {toolCalls,...} shape the
// loop already consumes. The outer loop never learns which dialect ran.
//
// Why stateless (no previous_response_id) is correct here — measured 2026-11-09
// against api.openai.com/v1/responses with gpt-6.1-sol:
//   • Round 1 (effort low AND high) emits ONLY a `function_call` output item —
//     no separate `reasoning` item to thread back.
//   • Round 2, resending [user, function_call, function_call_output] with NO
//     reasoning item, returned 200 and the correct final answer at both efforts.
// So the reasoning-item threading that reasoning models sometimes need does not
// arise on this path, and each call can rebuild the full `input` from `messages`
// exactly like chat/completions rebuilds the full `messages` every iteration.
//
// The call_id is the join key: a responses `function_call` carries `call_id`
// (call_...). The parser returns it as the tool call's `id`; the outer loop
// echoes it onto the {role:'assistant', tool_calls:[{id}]} turn and the
// {role:'tool', tool_call_id} result; this converter maps those back to a
// `function_call` / `function_call_output` pair whose call_ids match.

/** A chat-format function tool: {type:'function', function:{name,description,parameters}}. */
export interface ChatTool {
  type: 'function';
  function: { name: string; description?: string; parameters?: unknown };
}

/** Responses-format tool: flat, not nested under `function`. */
export interface ResponsesTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: unknown;
}

export function chatToolsToResponsesTools(tools: ChatTool[] | undefined): ResponsesTool[] {
  if (!Array.isArray(tools)) return [];
  const out: ResponsesTool[] = [];
  for (const t of tools) {
    const fn = t?.function;
    if (!fn || !fn.name) continue;
    out.push({
      type: 'function',
      name: fn.name,
      ...(fn.description ? { description: fn.description } : {}),
      ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
    });
  }
  return out;
}

/** One content part of a chat user message that carries an image. */
interface ChatContentPart {
  type: string;
  text?: string;
  image_url?: { url?: string } | string;
}

/** Convert a chat message's `content` (string | part[]) to a responses user
 *  content value. A plain string stays a string; an array is mapped part-by-part
 *  to input_text / input_image (responses takes image_url as a STRING, not the
 *  chat {url:...} object). Unknown parts are dropped. */
function toResponsesUserContent(content: unknown): unknown {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  const parts: unknown[] = [];
  for (const p of content as ChatContentPart[]) {
    if (p?.type === 'text' && typeof p.text === 'string') {
      parts.push({ type: 'input_text', text: p.text });
    } else if (p?.type === 'image_url') {
      const url = typeof p.image_url === 'string' ? p.image_url : p.image_url?.url;
      if (url) parts.push({ type: 'input_image', image_url: url });
    }
  }
  return parts;
}

/** Flatten any chat `content` (string | part[]) to plain text — used for
 *  assistant and tool-result text, which responses takes as a bare string. */
function flattenText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as ChatContentPart[])
      .filter(p => p?.type === 'text' && typeof p.text === 'string')
      .map(p => p.text as string)
      .join('\n');
  }
  return String(content ?? '');
}

interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
  tool_call_id?: string;
}

/** Convert the chat-format `messages` array to a responses `input` array.
 *
 *  - system  → {role:'developer', content}   (GPT-6 prefers developer; system is
 *              accepted too, but developer is the documented role for instructions)
 *  - user    → {role:'user', content}         (string stays string; image parts
 *              become input_text / input_image)
 *  - assistant text        → {role:'assistant', content:<string>}  (skipped if empty)
 *  - assistant tool_calls  → one {type:'function_call', call_id, name, arguments}
 *  - tool result           → {type:'function_call_output', call_id, output}
 *
 *  Non-standard chat fields (reasoning_content, name, …) are not carried: the
 *  responses API has no slot for them and rejects unknown item keys. */
export function chatMessagesToResponsesInput(msgs: ChatMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const m of msgs || []) {
    if (!m || !m.role) continue;
    if (m.role === 'system' || m.role === 'developer') {
      input.push({ role: 'developer', content: flattenText(m.content) });
    } else if (m.role === 'user') {
      input.push({ role: 'user', content: toResponsesUserContent(m.content) });
    } else if (m.role === 'assistant') {
      const text = flattenText(m.content);
      if (text) input.push({ role: 'assistant', content: text });
      for (const tc of m.tool_calls || []) {
        if (!tc?.function?.name) continue;
        input.push({
          type: 'function_call',
          call_id: tc.id || '',
          name: tc.function.name,
          arguments: tc.function.arguments || '{}',
        });
      }
    } else if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id || '',
        output: flattenText(m.content),
      });
    }
    // Any other role is dropped — responses has no equivalent.
  }
  return input;
}

/** Responses streaming event → effect. The event names are the standard
 *  Responses SSE set (same ones the xAI native-search fork reads). Captured so
 *  the parser in route.ts and a test can agree on one list. */
export const RESPONSES_EVENT = {
  textDelta: 'response.output_text.delta',
  reasoningDelta: 'response.reasoning_summary_text.delta',
  fnArgsDelta: 'response.function_call_arguments.delta',
  itemAdded: 'response.output_item.added',
  itemDone: 'response.output_item.done',
  completed: 'response.completed',
} as const;
