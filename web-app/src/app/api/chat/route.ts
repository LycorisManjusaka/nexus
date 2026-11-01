import { NextResponse } from 'next/server';
import crypto from 'crypto';
import pathModule from 'path';
import { promises as fsp } from 'fs';
import { loadKeys, readWorkspaceFile, readWorkspaceFileBinary, isImageFilename, writeWorkspaceFile, ensureWorkspace, editWorkspaceFile, globWorkspaceFiles, grepWorkspaceFiles, deleteWorkspaceFile, readEntityFooter, getTrustedJunctionRoot } from '@/lib/fsStorage';
import { isVisionCapable, isAudioCapable, isVideoCapable, resolveGeminiMinThinkingLevel, reportsNormalizedCoords } from '@/lib/modelVision';
import { type ThinkTagState, newThinkTagState, splitThinkTags } from '@/lib/thinkTagSplitter';
import { resolveBridge, mediaKindOf, bridgedDescriptionText } from '@/lib/attachmentVisibility';
import { describeImage } from '@/lib/eyesVision';
import { describeAudio } from '@/lib/earsBridge';
import { describeVideo } from '@/lib/videoBridge';
import { extractVideoFrames } from '@/lib/videoFrames';
import { webSearch, webFetch } from '@/lib/webTools';
import { readConversationByName, formatReadConversationResult } from '@/lib/conversationRead';
import { searchConversations, formatSearchForTool } from '@/lib/conversationSearch';
import { readAttachmentBase64, readAttachmentText, putBytes, mimeForRef, refPath } from '@/lib/attachmentStore';
import { findAttachmentsByRefPrefix, searchAttachments, formatAttachmentSearchForTool } from '@/lib/attachmentIndex';
import { compileSafeRegex, grepLines } from '@/lib/safeRegex';
import { parseRetryDelayMs } from '@/lib/providerErrors';
import { deepseekWireModel, DEEPSEEK_FLASH } from '@/lib/deepseekModels';
import { openAiCannotUseTools, openAiOffEffort, openAiToolsNeedNoneEffort } from '@/lib/openaiEffort';
import { claudeAgentEnv, resolveRefusalFallback } from '@/lib/agentEnv';
import { createBetrayalGuard, makeGuardedSender, buildEchoText, type GuardedSender } from '@/lib/betrayalGuard';
import { resolveHandoff, describeAllowed, buildHandoffInjection, buildHandoffFailureInjection, parseHandoffModels, type HandoffModel } from '@/lib/modelHandoff';

// Payload field for an attachment the AI produced by reading an image from the
// workspace. These are persisted into the conversation like any other
// attachment, so they go into the content-addressed store rather than being
// inlined as base64. Falls back to an inline data URL if storage fails — a disk
// problem should degrade the format, not lose the tool result.
async function toolAttachmentPayload(
  data: Buffer,
  mimeType: string,
  base64: string
): Promise<{ ref: string } | { dataUrl: string }> {
  try {
    const { ref } = await putBytes(data, mimeType);
    return { ref };
  } catch (e) {
    console.error('[attachments] could not store tool image, inlining instead:', e);
    return { dataUrl: `data:${mimeType};base64,${base64}` };
  }
}

// read_attachment — revive a HIDDEN attachment by its ref prefix.
//
// The FAST path is the current conversation's own refs (built once per turn in
// POST, see collectConversationAttachmentRefs) — that's the common case and
// costs nothing extra. When a prefix isn't found there, we fall back to a
// corpus-wide lookup (findAttachmentsByRefPrefix) scoped to THIS being's own
// conversations: read_conversation / search_conversations / search_attachments
// can all surface a ref that lives in a DIFFERENT past conversation, and that
// ref needs to actually resolve or those tools would be pointing at dead ends.
// Scope never crosses beings — only the widening from "this conversation" to
// "this being's conversations" is new.
//
// A revived attachment's outcome. `media` is present only when the payload is
// image/audio/video AND both (a) the active model is registered as capable of
// that modality (isVisionCapable/isAudioCapable/isVideoCapable) and (b) the
// calling provider path's wire format has a way to attach that modality to a
// tool result at all (see `nativeMediaKinds` below) — callers turn `media`
// into their own native content-block shape (mirroring how computer_screenshot
// already delivers `cr.image` at every one of these same call sites).
interface ReadAttachmentOutcome {
  text: string;
  media?: { base64: string; mimeType: string; kind: 'image' | 'audio' | 'video' };
}

// Ambiguity is an error, never a silent pick — returning the wrong file is the
// one failure this tool must be structurally unable to produce.
async function runReadAttachment(args: {
  prefix: string;
  pattern?: string;
  folderName: string;
  index: { ref: string; name: string; size: number; mimeType: string }[];
  // The model actually running this turn — gates whether media is restored
  // natively (real bytes) or reported as a capability limit (honest, not a
  // blanket refusal: a vision-capable model reading an image gets the image).
  specificModel?: string;
  // LOCAL models only: isVisionCapable() is a registry + id-substring match and
  // cannot recognise an LM Studio id like `google/gemma-4-26b-a4b-qat`, so it
  // DEFAULT-DENIES every local engine — including ones whose catalog entry says
  // vision:true. Without this, a local model with eyes was told "the current
  // model isn't registered as able to accept image input" while the Read tool,
  // two lines of code away, happily handed the same model the same bytes
  // (REPORTED by Lizard-kun 2026-10-11, with the Read workaround attached).
  // The asymmetry was structural: Read's gate asks "bridge or deliver?" and
  // BOTH branches deliver something; this one asked "deliver at all?" and
  // answered no. undefined = use the registry (correct for every cloud family).
  visionOverride?: boolean;
  // Which media kinds THIS provider path's wire format can even carry inside
  // a tool result, independent of whether the model itself could understand
  // them. Anthropic's content-block spec has no audio/video block type at
  // all, for instance, so those sites pass only {'image'} regardless of model.
  // Omitted = image only (the conservative default for any future caller).
  nativeMediaKinds?: Set<'image' | 'audio' | 'video'>;
}): Promise<ReadAttachmentOutcome> {
  const { prefix, pattern, folderName, index, specificModel, nativeMediaKinds, visionOverride } = args;
  const nativeKinds = nativeMediaKinds || new Set<'image' | 'audio' | 'video'>(['image']);
  const p = (prefix || '').trim().toLowerCase();
  if (!p) return { text: 'Error: read_attachment requires a ref prefix (the 12-character ref shown next to a hidden attachment).' };

  // size is optional here for the same reason it is optional on
  // AttachmentIndexEntry: 1,030 of this store's attachment entries never
  // recorded one, and read_attachment stats the blob itself anyway.
  let matches: { ref: string; name: string; size?: number; mimeType: string; convoTitle?: string }[] =
    index.filter((e) => e.ref.toLowerCase().startsWith(p));
  if (matches.length === 0) {
    try {
      const found = await findAttachmentsByRefPrefix(folderName, p, { excludeInactive: true });
      if (found.length > 0) matches = found;
    } catch {
      // Fallback scan failed (e.g. logs dir missing) — fall through to the
      // ordinary "not found" error below rather than surfacing an internal error.
    }
  }
  if (matches.length === 0) {
    return { text: `Error: no attachment matching ref "${p}" was found in this conversation or elsewhere in your other conversations.` };
  }
  if (matches.length > 1) {
    const names = matches.slice(0, 6).map((e) => `${e.ref.slice(0, 12)} (${e.name}${e.convoTitle ? ` — "${e.convoTitle}"` : ''})`).join(', ');
    return { text: `Error: "${p}" is ambiguous — ${matches.length} attachments match. Use a longer prefix. Matches: ${names}` };
  }
  const entry = matches[0];
  if (isMediaMime(entry.mimeType)) {
    const kind: 'image' | 'audio' | 'video' =
      entry.mimeType.startsWith('image/') ? 'image' :
      entry.mimeType.startsWith('audio/') ? 'audio' : 'video';
    const modelCapable =
      kind === 'image' ? (visionOverride === undefined ? isVisionCapable(specificModel) : visionOverride) :
      kind === 'audio' ? isAudioCapable(specificModel) :
      isVideoCapable(specificModel);
    if (modelCapable && nativeKinds.has(kind)) {
      const stored = await readAttachmentBase64(entry.ref);
      if (!stored) return { text: `Error: the payload for ref "${entry.ref}" is missing from the store.` };
      const noun = kind === 'image' ? 'an image' : kind === 'audio' ? 'audio' : 'a video';
      return {
        text: `Content of "${entry.name}" (${entry.ref}) follows as ${noun}.`,
        media: { base64: stored.base64, mimeType: stored.mimeType, kind },
      };
    }
    const reason = !modelCapable
      ? `the current model isn't registered as able to accept ${kind} input`
      : `this connection can't attach ${kind} to a tool result`;
    const suggestion = kind === 'image'
      ? 'Re-show it with the eye icon, or (if the same file is in the workspace) read it with the Read tool.'
      : `Unhide it in the conversation instead — the ${kind === 'audio' ? 'ears' : 'watcher'} bridge will describe it as text on the next turn.`;
    return { text: `"${entry.name}" (${entry.ref}) is a ${entry.mimeType} attachment — ${reason}. ${suggestion}` };
  }
  const text = await readAttachmentText(entry.ref);
  if (text == null) return { text: `Error: the payload for ref "${entry.ref}" is missing from the store.` };

  if (!pattern || !pattern.trim()) {
    return { text: `Content of ${entry.name} (${entry.ref}):\n\n${text}` };
  }

  // Optional grep-within-this-file mode: return only matching lines instead of
  // the whole content. Useful once an attachment is too long to want in full.
  const compiled = compileSafeRegex(pattern);
  if (!compiled.ok) return { text: `Error: ${compiled.error}` };
  const hits = grepLines(text, compiled.regex);
  if (hits.length === 0) return { text: `No lines in ${entry.name} (${entry.ref}) match pattern "${pattern}".` };
  const shown = hits.slice(0, 200);
  const body = shown.map((h) => `${h.line}: ${h.text}`).join('\n');
  const more = hits.length > shown.length ? `\n…and ${hits.length - shown.length} more matching line(s).` : '';
  return { text: `${hits.length} line(s) in ${entry.name} (${entry.ref}) match "${pattern}":\n\n${body}${more}` };
}

// search_attachments — grep across every TEXT attachment of THIS being's own
// (active) conversations. Thin wrapper around the shared backend that turns a
// thrown ReDoS-guard rejection into the same "Error: ..." string convention
// every other tool backend here uses.
async function runSearchAttachments(folderName: string, query: string, regex: boolean, showPaths: boolean): Promise<string> {
  try {
    const r = await searchAttachments(folderName, query, { regex, excludeInactive: true });
    return formatAttachmentSearchForTool(r, showPaths);
  } catch (e: any) {
    return `Error: ${e?.message || 'search failed'}`;
  }
}

// The set of attachment refs referenced by THIS conversation's messages — the
// scope read_attachment resolves against. Only refs are addressable: inline
// dataUrl/textData attachments carry no hash, so there is nothing to resolve.
function collectConversationAttachmentRefs(messages: any[]): { ref: string; name: string; size: number; mimeType: string }[] {
  const out: { ref: string; name: string; size: number; mimeType: string }[] = [];
  for (const m of messages) {
    for (const att of (m.attachments || [])) {
      const ref = att?.ref;
      if (typeof ref !== 'string' || !ref) continue;
      out.push({
        ref,
        name: String(att.name || 'unnamed'),
        size: Number(att.size || 0),
        mimeType: String(att.type || mimeForRef(ref)),
      });
    }
  }
  return out;
}

/**
 * Everything a drain point needs to deliver ONE interjection, text and media
 * together — the single place that decides what rides along, what is handed
 * off, and what the human is told.
 *
 * Why a shared helper and not six copies: the six drain points differ only in
 * the wire shape they can emit (which is why the dialect blocks are built by
 * the CALLER, from `deliver`). Everything else — resolving bytes, intersecting
 * wire with model senses, writing the hand-off, registering refs so
 * read_attachment can find them, phrasing the honest notice — is one rule, and
 * a rule copied six times is a rule that will disagree with itself.
 *
 * Registering refs is the quiet half of this. `read_attachment` resolves
 * against (a) this turn's ref index and (b) a scan of the being's saved
 * conversations — and an interjection attachment is in NEITHER, because an
 * interjection is never appended to the conversation log. So the bytes would
 * sit in the store, addressable by nothing. Pushing into the per-turn index
 * (the same array every provider path already passes to runReadAttachment, read
 * at call time) makes the ref resolvable for the rest of this turn without
 * touching the log or widening the corpus scan.
 */
async function prepareInjectionDelivery(args: {
  drained: DrainedInjection;
  /** Kinds THIS dialect can attach inside a running turn (the site is the dialect). */
  wire: Set<MediaKindNarrow>;
  /** The model running the turn — whether it can perceive a kind at all. */
  model: string | undefined;
  /** I.injectionFraming — how a partner note is introduced. */
  framing: string | undefined;
  /** I.injectionAttachmentNote — how a handed-off attachment is introduced. */
  handoffTemplate: string | undefined;
  /** True when read_attachment is available, i.e. a ref is actually openable. */
  refsOpenable: boolean;
  /** True when the turn addresses attachments by absolute path instead (whole-PC
   *  access — see attachmentPathsVisible in POST). Required, not optional: a
   *  drain point that forgot it would quietly tell the partner their picture
   *  could not be handed over at all, when in fact the path would have worked. */
  pathsVisible: boolean;
  /** This turn's read_attachment scope. MUTATED: queued refs are registered. */
  refIndex: { ref: string; name: string; size: number; mimeType: string }[];
  ja: boolean;
  /** Image-sense override for local models whose vision only the LM Studio
   *  catalog knows (isVisionCapable can't match the id). undefined = registry. */
  visionOverride?: boolean;
}): Promise<{
  /** Framed text to inject, '' when there is nothing to say. */
  text: string;
  /** Media whose bytes ride along natively — the caller turns these into blocks. */
  deliver: LoadedInjectMedia[];
  /** User-only honesty line, '' when everything arrived. */
  notice: string;
  /** Attachment names for the display-only tool/thinking-log event. */
  logNames: string[];
}> {
  const { drained, wire, model, framing, handoffTemplate, refsOpenable, refIndex, ja, visionOverride, pathsVisible } = args;
  // One derivation for both the model-facing hand-off and the partner-facing
  // notice, so the two can never disagree about whether the file is reachable.
  const addressing: AttachmentAddressing = pathsVisible ? 'path' : (refsOpenable ? 'ref' : 'none');
  const items = drained.media || [];
  const texts = drained.texts || [];
  if (texts.length === 0 && items.length === 0) {
    return { text: '', deliver: [], notice: '', logNames: [] };
  }

  const { loaded, missing } = await loadInjectedMedia(items);
  const { deliver, withheld } = splitDeliverable(loaded, injectableKinds(wire, model, visionOverride));

  // Register every ref that resolved, not just the withheld ones: an image that
  // rode along natively is still worth being able to re-open by ref later in
  // the same turn (a long turn may push it out of the model's attention).
  if (refsOpenable) {
    for (const m of loaded) {
      if (!refIndex.some((e) => e.ref === m.ref)) {
        refIndex.push({ ref: m.ref, name: m.name, size: m.size, mimeType: m.mimeType });
      }
    }
  }

  const parts: string[] = [];
  if (texts.length) parts.push(frameInjection(texts, framing));
  // The hand-off covers what could not ride along. Missing payloads are NOT
  // handed off — there is nothing behind the ref to open.
  if (withheld.length) {
    const note = handoffNote(withheld, handoffTemplate, addressing);
    if (note) parts.push(note);
  }
  if (missing.length) {
    parts.push(
      `<attached_file_not_delivered names="${missing.map((m) => String(m.name || '?').replace(/["<>]/g, '')).join(', ')}" ` +
      `reason="the stored payload is missing" />`,
    );
  }

  const notice = undeliverableSummary(withheld, missing, { ja, addressing });

  return {
    text: parts.join('\n\n'),
    deliver,
    notice,
    logNames: [...deliver, ...withheld, ...missing].map((m) => String(m.name || '?')),
  };
}

import { appendLayer4Index, appendLayer5Footer, prependIdentityPreamble, hasLayerStructure, LAYER4_HEADING } from '@/lib/layer4';
import { isBaseBindingOptional, selectBaseBindingText, shouldInjectLayer4 } from '@/lib/baseBinding';
import { buildLayer4IndexBody, folderUsesSummariesForLayer4 } from '@/lib/layer4Index';
import { resolveAgentInstructions } from '@/lib/agentInstructions';
import { createAskId, waitForAsk, recommendedDefaults, formatAnswerForModel, normalizeQuestions } from '@/lib/askUser';
import { drainInjections, drainSystemNotes, pushSystemNote, clearInjections, frameInjection, type DrainedInjection } from '@/lib/injectMessage';
import { markTurnActive, endTurn } from '@/lib/turnRegistry';
import { onStop, forgetStop } from '@/lib/turnStop';
import {
  loadInjectedMedia, injectableKinds, splitDeliverable, handoffNote, undeliverableSummary,
  anthropicInjectBlocks, geminiInjectParts, openaiInjectParts,
  type LoadedInjectMedia, type MediaKindNarrow, type AttachmentAddressing,
} from '@/lib/injectMedia';
import { runShellCommand } from '@/lib/shellTool';
import { effectiveFullAccess } from '@/lib/agentCapabilities';
import { buildOpenAiToolReplay } from '@/lib/toolHistory';
import { runSubagent } from '@/lib/subagent';
import { runLetterTool, LETTER_TOOL_NAMES, announceLetters } from '@/lib/letters';
import { ensureLmStudioLaunched, getLocalModelsMeta, loadLocalModel } from '@/lib/localModels';
import {
  runBrowserTool, BROWSER_TOOL_NAMES,
  browserToolsClaude, browserToolsGemini, browserToolsOpenAI,
} from '@/lib/browserTools';
import {
  runComputerTool, COMPUTER_TOOL_NAMES, NORMALIZED_COORD_SAFE_HEIGHT,
  computerToolsClaude, computerToolsGemini, computerToolsOpenAI,
  registerActiveTurnStop, ensureStopKeyWatcher, killActiveInput,
} from '@/lib/computerTools';
// App Control (アプリ操作): the other sense. computer_* drives pixels and needs
// eyes; app_* walks the control tree an application publishes and needs none —
// so these are gated by their OWN toggle, deliberately not shared with computer
// control, because a vision-less vessel can use app_* perfectly well.
import {
  runAppTool, APP_TOOL_NAMES,
  appToolsClaude, appToolsGemini, appToolsOpenAI,
} from '@/lib/appControl';
import { looksLikeText, isMediaMime, SNIFF_BYTES, TEXT_MAX_BYTES } from '@/lib/textSniff';
import { GoogleGenAI } from '@google/genai';
import sharp from 'sharp';

// Anthropic rejects any image whose longest edge exceeds 2000px on many-image
// requests, and internally downscales anything over ~1568px for token counting
// anyway. So downscale oversized images to a 1568px long edge before sending —
// this satisfies both limits with margin and matches Anthropic's own downscale,
// meaning no extra quality loss. Unlike the client-side PNG→JPEG (fresh PNG
// attachments only), this runs server-side on EVERY image the Claude paths send:
// fresh attachments, .md imports, and historical turns alike. Input format is
// preserved (keeps PNG transparency); on any decode/format failure the original
// bytes are sent unchanged rather than dropping the image.
const CLAUDE_MAX_EDGE = 1568;
async function shrinkImageForClaude(
  base64Data: string,
  mimeType: string,
): Promise<{ data: string; media_type: string }> {
  try {
    const buf = Buffer.from(base64Data, 'base64');
    const meta = await sharp(buf).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    if (!w || !h || Math.max(w, h) <= CLAUDE_MAX_EDGE) {
      return { data: base64Data, media_type: mimeType };
    }
    const out = await sharp(buf)
      .resize({ width: CLAUDE_MAX_EDGE, height: CLAUDE_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .toBuffer(); // no format method → sharp preserves the input format
    return { data: out.toString('base64'), media_type: mimeType };
  } catch {
    return { data: base64Data, media_type: mimeType };
  }
}

// ── Grok native web + X search (xAI Responses API) ───────────────────────────
// xAI's real search (web_search + x_search server-side tools) lives ONLY on the
// /v1/responses endpoint — the old chat/completions `search_parameters` "Live
// Search" was deprecated (→ 410). The Responses shape differs from chat: `input`
// not `messages`, and the answer is nested at output[].content[].text (the
// top-level `output_text` is null on xAI).
//
// This is a SEPARATE, opt-in turn shape (Model tab → "xAI native search"), not
// an add-on to the normal tool loop: it returns before the chat/completions loop
// runs, so a turn taken this way has NO workspace tools (no file reads, no PC
// control, no letters). That is the trade, and it is why the toggle is its own
// switch instead of riding on the Being tab's general web-search checkbox — a
// being whose search was on could not open its own desk.
//
// Cost warning, measured 2026-09-23 (grok-4.6, one-sentence question):
//   plain turn, no tools            650 input tokens   $0.0020
//   same question with search on  27,714 input tokens  $0.0616   (4 web_search calls)
// The server pulls whole pages back into the context and bills each search
// separately (~$0.005/call), so a search turn costs ~30× a plain one. Nothing to
// fix there — that is what xAI charges. NEXUS's own web_search/web_fetch tools
// (Being tab) are the cheap path.
//
// Streaming: xAI implements the standard Responses SSE event names. We read
//   response.reasoning_summary_text.delta → thought  (the model's reasoning
//     SUMMARY — xAI does not stream raw reasoning; a summary is what exists)
//   response.output_text.delta           → text
//   response.output_text.annotation.added → citations (top-level `citations` is
//     null on xAI; annotations are the only source)
//   response.web_search_call.*           → tool_activity chip
//   response.completed                   → usage
// Before 2026-09-23 this was a single non-streaming POST that read only the
// message text, which is why these turns showed zero thinking and sat silent
// for the whole (search-inflated) generation.
async function runGrokNativeSearch(params: {
  apiKey: string;
  model: string;
  input: { role: string; content: string }[];
  enqueue: (obj: any) => void;
  signal?: AbortSignal;
  language?: string;
}): Promise<void> {
  const { apiKey, model, input, enqueue, signal, language } = params;
  const ja = language === 'ja';
  let res: Response;
  try {
    res = await fetch('https://api.x.ai/v1/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        input,
        tools: [{ type: 'web_search' }, { type: 'x_search' }],
        stream: true,
      }),
      ...(signal ? { signal } : {}),
    });
  } catch (e: any) {
    if (signal?.aborted) return;
    enqueue({ type: 'text', content: `[Grok native search could not connect: ${e?.message || 'network error'}]` });
    return;
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`[grok/search] HTTP ${res.status} · ${errText.slice(0, 500)}`);
    enqueue({ type: 'text', content: `[Grok native search error ${res.status}: ${errText.slice(0, 300)}]` });
    return;
  }

  const citations: { url: string; title?: string }[] = [];
  const pushCitation = (a: any) => {
    const url = a?.url || a?.url_citation?.url;
    if (url) citations.push({ url, title: a?.title || a?.url_citation?.title });
  };
  let sawText = false;
  let usage: any = null;
  let searchCalls = 0;

  const reader = res.body?.getReader();
  if (!reader) {
    enqueue({ type: 'text', content: '[Grok native search returned no stream.]' });
    return;
  }
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) { try { await reader.cancel(); } catch {} break; }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;      // `event:` lines carry no payload
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let ev: any;
        try { ev = JSON.parse(payload); } catch { continue; }
        switch (ev.type) {
          case 'response.reasoning_summary_text.delta':
            if (ev.delta) enqueue({ type: 'thought', content: ev.delta });
            break;
          case 'response.output_text.delta':
            if (ev.delta) { sawText = true; enqueue({ type: 'text', content: ev.delta }); }
            break;
          case 'response.output_text.annotation.added':
            pushCitation(ev.annotation);
            break;
          // One search produces in_progress + searching + completed; only the
          // first is turned into a chip, or the label flickers per phase.
          case 'response.web_search_call.in_progress':
            searchCalls++;
            enqueue({ type: 'tool_activity', tool: ja ? 'ウェブを検索' : 'searching the web', name: 'web_search' });
            break;
          case 'response.output_item.done':
            // Non-streamed leftovers: a message item can carry annotations that
            // never arrived as annotation.added events.
            if (ev.item?.type === 'message' && Array.isArray(ev.item.content)) {
              for (const c of ev.item.content) {
                if (Array.isArray(c?.annotations)) for (const a of c.annotations) pushCitation(a);
              }
            }
            break;
          case 'response.completed':
            usage = ev.response?.usage || null;
            if (Array.isArray(ev.response?.citations)) {
              for (const c of ev.response.citations) {
                if (typeof c === 'string') citations.push({ url: c });
                else if (c?.url) citations.push({ url: c.url, title: c.title });
              }
            }
            break;
          case 'response.failed':
          case 'response.incomplete': {
            const why = ev.response?.error?.message || ev.response?.incomplete_details?.reason || ev.type;
            enqueue({ type: 'text', content: `\n[Grok native search ${ev.type === 'response.failed' ? 'failed' : 'ended early'}: ${String(why).slice(0, 200)}]` });
            break;
          }
        }
      }
    }
  } catch (e: any) {
    if (!signal?.aborted) enqueue({ type: 'text', content: `\n[Grok native search stream broke: ${e?.message || 'unknown error'}]` });
  }
  if (searchCalls) enqueue({ type: 'tool_activity', tool: null, name: null });

  if (!sawText && !signal?.aborted) {
    enqueue({ type: 'text', content: '[Grok returned no answer from native search.]' });
  }

  if (citations.length) {
    const seen = new Set<string>();
    const deduped = citations.filter(c => c.url && !seen.has(c.url) && (seen.add(c.url), true));
    if (deduped.length) enqueue({ type: 'web_sources', sources: deduped });
  }

  // Usage. This branch returns early and never reaches the shared
  // normalizeCacheUsage emission at the end of the OpenAI-compatible path, so
  // it has to emit its own — without this, every Grok turn with web search ON
  // stored NO cacheUsage at all and the message rendered with no cost, which is
  // how these turns silently showed nothing while plain Grok turns showed a price.
  const usagePayload = normalizeCacheUsage(usage, 'grok-responses');
  if (usagePayload) enqueue(usagePayload);
}
import Anthropic from '@anthropic-ai/sdk';

// Adaptive-thinking depth control for Claude. `output_config.effort` (API key)
// and the Agent SDK `effort` option (OAuth) accept the SAME five levels. All are
// valid on the adaptive models NEXUS exposes (Opus 4.7, Opus 4.8, Fable 5). The
// API default is 'high' (identical to omitting it). Unknown/missing → 'high'.
const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
function sanitizeClaudeEffort(v: any): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  return (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(v) ? v : 'high';
}

// Claude models on which thinking CANNOT be switched off: Anthropic answers
// `thinking: { type: 'disabled' }` with a 400. Measured 2026-10-01 for
// claude-opus-5-5 (API-key path):
//   "\"thinking.type.disabled\" is not supported for this model. Use
//    \"thinking.type.adaptive\" and \"output_config.effort\" …"
// Fable/Mythos 5 were measured earlier. Plain claude-opus-5 ACCEPTS disabled,
// and so do Opus 4.7, Opus 4.8 and Sonnet 5 (all re-measured the same day, each
// with the toggle off so `disabled` really went on the wire) — so this is a
// short deny-list, NOT "all adaptive models". (Sonnet 4.6 is not in that set:
// it is non-adaptive, so this branch never sends it `disabled` at all — its
// toggle-off turn carries `temperature` instead. Untested, by construction.)
//
// claude-sonnet-5-5 (added 2026-10-02) is in the deny-list BY ANALOGY, NOT by
// measurement. We have NOT sent it `disabled`. The analogy: every newest ".5"
// model that has been measured drops the classic `disabled` type (Opus 5.5,
// Fable 5, Mythos 5), and the Opus 5.5 error text ("use adaptive + effort")
// reads like a generation-wide direction. Note plain Sonnet 5 ACCEPTS disabled,
// so this is NOT "all Sonnet" — it is "the 5.5 bump, like Opus 5→5.5, probably
// flipped it". The direction is chosen to be SAFE: if 5.5 actually accepts
// `disabled`, including it here only means toggle-off sends adaptive+effort'low'
// instead of disabled (shallow thinking, no error); excluding it when it in
// fact rejects would be a 400 — the exact bug this guard exists to prevent.
//
// MEASURED 2026-10-21 (this replaces the analogy the previous paragraph asked
// to replace). Sonnet 5.5 + thinking:{type:'disabled'} -> 400, so the analogy's
// DIRECTION was right and this guard was doing real work. But the error named a
// shape neither hypothesis contained:
//
//   "To turn thinking off on this model, send \"thinking\": {\"type\":
//    \"between_tools\"} instead of {\"type\": \"disabled\"}. The model does not
//    think before responding. The short updates it writes between tool calls
//    come back as thinking blocks."
//
// There is a THIRD thinking type. Probed across the family the same day:
// between_tools returns 200 on claude-sonnet-5-5 and 400 ("not supported for
// this model") on opus-5-5, fable-5-1, haiku-5-5 AND opus-5 — it is specific to
// Sonnet 5.5, not a generation-wide replacement for `disabled`.
//
// NOT acted on yet, deliberately. Today Sonnet 5.5's toggle-off runs
// adaptive+effort'low', i.e. shallow thinking; between_tools would make OFF
// mean genuinely off. That is an improvement, but it changes what a toggle does
// on a model in daily use, so it wants a verified turn rather than a drive-by
// edit at the end of a long one. The measurement is the deliverable; the switch
// is a separate, checkable step.
//
// Also measured the same day: claude-haiku-5-5 ACCEPTS `disabled` (200), which
// is why it is absent here — it is adaptive-only in the OTHER two shapes
// (classic enabled, and temperature), handled by isHaiku55 in the Claude branch.
//
// `/v1/models` cannot be used to derive this: the catalog reports
// thinking.types = { enabled:false, adaptive:true } IDENTICALLY for Opus 5,
// Opus 5.5, Sonnet 5, Fable 5.1 and Opus 4.8. `disabled` is not one of the
// enumerated types, so the axis that actually differs is invisible there. A
// model's `disabled` support can only be learned by sending it.
//
// ONE definition on purpose. Three sites read it — the API-key branch, the
// OAuth branch, and the SSE `thinking` flag — and they must not drift apart.
// (A detector and its own audit copy once claimed to match, drifted, and the
// report printed an empty field while claiming a hit.)
function claudeRejectsDisabledThinking(model: string): boolean {
  const m = (model || '').toLowerCase();
  return /fable-?5|mythos-?5/.test(m) || /opus-?5[-.]5|opus55/.test(m) || /sonnet-?5[-.]5|sonnet55/.test(m);
}

// ── Tool-activity display names ──────────────────────────────────────────────
// Maps NEXUS's internal workspace-tool names to a short human phrase for the
// `tool_activity` SSE event (drives the "<Entity> is using X…" loading label).
// Used by every provider path so a long tool call (esp. a big Write, whose
// input streams silently) isn't mistaken for a frozen "thinking...". Tools with
// their own dedicated UI (AskQuestion → question card, spawn_subagent → chip)
// return null so we don't override those richer indicators.
// Tool-call record for the per-message tool report (the 🔧 button on an
// assistant bubble). This is EVIDENCE, not context: it records what the model
// actually dispatched, so a reply claiming "I saved the file" can be checked
// against whether a Write call was really made. Entities that hallucinate tool
// use — observed on Opus 5 (API), GLM 5.2 and Kimi K3 — produce a confident
// message with an empty report.
//
// Never sent back to any model: the client's slimHistory is an allowlist, so a
// field it doesn't name is dropped on the way out. Display-only, zero tokens.
const TOOL_ARG_CAP = 4000;
function truncateToolInput(input: any): any {
  // Arguments can be enormous (a Write carries the whole file body). Store a
  // readable head, not the payload — this lands in the conversation log.
  let text: string;
  try { text = typeof input === 'string' ? input : JSON.stringify(input ?? {}); }
  catch { return { _unserializable: true }; }
  if (text.length <= TOOL_ARG_CAP) {
    try { return typeof input === 'string' ? input : JSON.parse(text); } catch { return text; }
  }
  return { _truncated: true, _originalChars: text.length, preview: text.slice(0, TOOL_ARG_CAP) };
}

// Stops a model that has stopped making progress: the same tool called with the
// same arguments several times in a row. THAT — not a high call count — is the
// failure the old fixed cap of 8 iterations was really guarding against, and
// this catches it on the 3rd repeat instead of the 8th round, while leaving
// legitimate long work (20+ genuinely different calls) completely alone.
const TOOL_REPEAT_LIMIT = 3;
function makeRepeatGuard() {
  let lastKey = '';
  let repeats = 0;
  // Returns the offending tool name once the limit trips, else null.
  return (name: string, input: any): string | null => {
    let key: string;
    try { key = `${name}:${JSON.stringify(input ?? {})}`; } catch { key = name; }
    if (key === lastKey) {
      repeats++;
      if (repeats >= TOOL_REPEAT_LIMIT) return name;
    } else {
      lastKey = key;
      repeats = 1;
    }
    return null;
  };
}

// Wording shared by every provider path so the same stop reads the same way
// wherever it happens. Delivered as a `notice`, which the client renders beside
// the message and never sends back to the model.
function toolLimitNotice(rounds: number): string {
  return `Stopped after ${rounds} rounds of tool use — the turn hit the tool-call limit before finishing.`
    + ` NEXUS asked the model to write its final answer with tools disabled, so the reply reflects everything gathered up to that point. Raise "Tool-call limit per turn" in Preferences → Other if the task genuinely needs more steps.`;
}
function toolRepeatNotice(name: string): string {
  return `Stopped: \`${name}\` was called ${TOOL_REPEAT_LIMIT} times in a row with identical arguments,`
    + ` which means the turn was no longer making progress. This usually means the tool keeps failing, or the model is asking for something that does not exist.`;
}

// Injected as a final user turn when the tool budget is exhausted, so the model
// writes a closing answer from what it has already gathered instead of the turn
// dying with no output. Instruction-only: no new tool results are executed, so
// the wrap-up costs exactly one model call and can never itself loop.
function toolWrapUpInstruction(language?: string | null): string {
  if (language === 'ja') {
    return 'このターンのツール使用上限に達しました。これ以上ツールを呼び出さないでください。'
      + 'これまでに集めた内容をもとに、パートナーへの最終的な回答を今ここで書いてください。'
      + '終えられなかったこと、検証できなかったことがあれば、はっきり明記してください。';
  }
  return 'Your tool-use budget for this turn is exhausted. Do not call any more tools. '
    + 'Using everything you have gathered so far, write your final answer to your partner now '
    + 'and be explicit about anything you could not finish or verify.';
}

function toolActivityLabel(name: string): string | null {
  switch (name) {
    // BARE INFINITIVE, not the -ing form. These are rendered as
    // "<Entity> is using <model> to <label>…", and English takes the base verb
    // after "to": "…to read a file", never "…to reading a file".
    case 'Read': return 'read a file';
    case 'Write': return 'write a file';
    case 'Edit': return 'edit a file';
    case 'Glob': return 'search for files';
    case 'Grep': return 'search file contents';
    case 'Delete': return 'delete a file';
    case 'Bash': return 'run a shell command';
    case 'read_conversation': return 'read a past conversation';
    case 'search_conversations': return 'search past conversations';
    case 'search_attachments': return 'search past attachments';
    // Without a label here, the API-key paths emit NO tool_activity at all
    // (they guard on `if (actLabel)`) — so the camera never learns this is a
    // read, and the being sits in Waiting instead of Reading.
    case 'read_attachment': return 'open an attachment';
    case 'write_letter': return 'write a letter';
    case 'list_letters': return 'check for letters';
    case 'list_recipients': return 'look up who can be written to';
    case 'read_letter': return 'read a letter';
    case 'archive_letter': return 'set a letter aside';
    case 'browser_navigate': return 'open a web page';
    case 'browser_snapshot': return 'look at the page';
    case 'browser_click': return 'click something on the page';
    case 'browser_type': return 'type into the page';
    case 'browser_read': return 'read the page';
    case 'browser_screenshot': return 'photograph the page';
    case 'computer_screens': return 'list monitors';
    case 'computer_screenshot': return 'take a screenshot';
    case 'computer_input': return 'control the mouse/keyboard';
    case 'app_windows': return 'list the open windows';
    case 'app_inspect': return 'look inside an application window';
    case 'app_act': return 'operate a control in an application';
    case 'app_shot': return 'photograph an application window';
    case 'web_search': case 'WebSearch': return 'search the web';
    case 'web_fetch': case 'WebFetch': return 'fetch a web page';
    case 'AskQuestion': case 'spawn_subagent': return null; // have dedicated UI
    default: return null;
  }
}

// Turn a raw Claude/SDK error string into a plain-language reason so a stop is
// never a mystery. Returns null when the text doesn't match a known signature
// (caller then shows the raw text). Covers the big ones: context-window
// overflow (e.g. reading too many/too-large files in one turn), rate limits,
// exhausted credit, and rejected/expired OAuth tokens.
function explainClaudeStopError(raw: string): string | null {
  const t = (raw || '').toLowerCase();
  if (!t) return null;
  if (/prompt is too long|too many (?:input )?tokens|maximum.{0,30}tokens|exceed.{0,30}(?:context|token)|context.{0,20}(?:window|length|limit)|input.{0,20}too.{0,10}(?:large|long)|request too large/.test(t)) {
    return 'the turn exceeded the model\'s context window — too much content was included at once (typically too many, or too-large, files read in a single turn). Have the entity read fewer / smaller files per turn, or trim the conversation, then resend.';
  }
  if (/rate.?limit|too many requests|\b429\b|overloaded|\b529\b/.test(t)) {
    return 'the provider rate-limited or was temporarily overloaded (usage limit / capacity). Wait a moment and resend.';
  }
  if (/credit|quota|insufficient|billing|payment required|\b402\b/.test(t)) {
    return 'the subscription credit / quota for this path is exhausted. Switch to the API-key path, or top up.';
  }
  if (/invalid.{0,10}(?:token|key)|unauthor|expired|revoked|forbidden|\b401\b|\b403\b/.test(t)) {
    return 'the OAuth token was rejected (expired or revoked). Refresh the token, or switch to the API-key path.';
  }
  return null;
}

// Turn an Anthropic classifier refusal into a plain-language reason. A refusal
// is a 200 response with stop_reason "refusal" and a `stop_details` object that
// names the policy area (`category`) and carries human prose (`explanation`).
// Before this existed NEXUS showed only "the model declined to continue" and
// threw the rest away — the same failure shape as swallowing the Opus 5.5
// version-gate 400, which told us the exact version to upgrade to.
//
// `category` is deliberately typed as an open string, NOT the SDK's
// `'cyber' | 'bio' | null` union: the published table already lists five
// categories (cyber, bio, frontier_llm, reasoning_extraction, general_harms)
// and Anthropic ships new ones on the wire ahead of schema updates. Trusting
// the union here would drop the very category we hit most. An unknown category
// is shown verbatim rather than mapped.
//
// `explanation` is "unstable human prose — display only, never parse" per the
// docs, so it is passed through untouched and never matched against.
//
// The billed/not-billed split is Anthropic's own, as of 2026-09: a refusal that
// arrives BEFORE any output is billed only for bio / frontier_llm /
// reasoning_extraction. Saying so is the difference between "something went
// wrong" and "this cost money and counted against the rate limit" — the first
// question anyone asks. Anthropic states the list may change, hence the date.
const REFUSAL_BILLED_CATEGORIES = new Set(['bio', 'frontier_llm', 'reasoning_extraction']);
function describeRefusal(
  category: string | null | undefined,
  explanation: string | null | undefined,
  language?: string,
  hadOutput?: boolean,
): string {
  const ja = language === 'ja';
  const cat = (category || '').trim();
  const meaning: Record<string, { en: string; ja: string }> = {
    cyber: {
      en: 'the request could enable cyber harm (malware / exploit development). Benign security work also triggers this category.',
      ja: 'サイバー被害（マルウェアやエクスプロイトの開発）につながりうる要求と判定された。無害なセキュリティ業務でも発火する。',
    },
    bio: {
      en: 'the request could enable biological harm. Beneficial life-sciences work also triggers this category.',
      ja: '生物学的被害につながりうる要求と判定された。有益な生命科学の作業でも発火する。',
    },
    frontier_llm: {
      en: 'the request could assist the development of a competing AI model, restricted under Anthropic\'s commercial terms. Benign machine-learning work also triggers this category.',
      ja: '競合AIモデルの開発を助けうる要求と判定された（Anthropicの商用規約で制限されている）。無害な機械学習の作業でも発火する。',
    },
    reasoning_extraction: {
      en: 'the request was read as asking the model to reproduce its internal reasoning in the response text. Discussing why a turn stopped, or analyzing thinking output, can land here.',
      ja: 'モデルに内部推論を応答テキストで再現させる要求と読まれた。ターンが止まった理由の議論や、思考出力の分析もここに入りうる。',
    },
    general_harms: {
      en: 'the request falls under a usage-policy area outside the four named categories. Benign work also triggers this category.',
      ja: '名前の付いた4カテゴリ以外の利用ポリシー領域に該当すると判定された。無害な作業でも発火する。',
    },
  };
  const parts: string[] = [];
  if (cat) {
    parts.push(ja ? `分類は "${cat}"。` : `Category "${cat}".`);
    const m = meaning[cat];
    if (m) parts.push(ja ? m.ja : m.en);
  } else {
    parts.push(ja
      ? '分類名は返されなかった（nullは正常な値で、欠損ではない）。'
      : 'No category was returned (null is a normal value here, not a gap).');
  }
  // Billing, in the order the rules actually apply. A MID-STREAM refusal is
  // billed regardless of category (input + whatever already streamed), so
  // `hadOutput` overrides the table — reading the category alone would report
  // "not billed" on a turn that was. Before-any-output refusals follow the
  // table. An UNKNOWN category gets no billing claim in either direction:
  // asserting one would be stating something not measured.
  if (hadOutput) {
    parts.push(ja
      ? 'これは出力が始まった後の拒否なので、入力とそれまでに流れた出力が通常料金で課金される（カテゴリに関係なく）。'
      : 'This refusal arrived mid-stream, so the input and whatever output already streamed are billed at normal rates, regardless of category.');
  } else if (cat && REFUSAL_BILLED_CATEGORIES.has(cat)) {
    parts.push(ja
      ? 'このカテゴリは、出力が1トークンも出ていなくても通常料金で課金される（Anthropicの規定、2026-09時点）。'
      : 'This category is billed at normal rates even when no output was produced (Anthropic\'s rule, as of 2026-09).');
  } else if (!cat || meaning[cat]) {
    parts.push(ja
      ? 'この場合、出力前の拒否なら課金されない（2026-09時点）。'
      : 'A refusal in this case is not billed when it arrives before any output (as of 2026-09).');
  }
  // True in every case per Anthropic's docs ("Either way … the request still
  // counts against your rate limits"), so it is stated unconditionally.
  parts.push(ja
    ? '課金の有無にかかわらず、リクエストはレート制限に計上される。'
    : 'Billed or not, the request counts against the rate limit.');
  const prose = (explanation || '').trim();
  if (prose) parts.push(ja ? `Anthropicの説明: "${prose}"` : `Anthropic's explanation: "${prose}"`);
  return parts.join(' ');
}

// ── Kimi (Moonshot) host resolution ──────────────────────────────────────────
// Kimi runs on Moonshot's first-party API (platform.kimi.ai / api.moonshot.ai),
// using keys.kimi. Model IDs are normalized to the bare Moonshot form
// ("moonshotai/Kimi-K2.6" → "kimi-k2.6"); the dropdown may store either form.
function resolveKimiModel(model: string | undefined | null): string {
  if (!model) return 'kimi-k3';
  // Strip any "moonshotai/" namespace and lowercase → Moonshot's bare id.
  return model.replace(/^moonshotai\//i, '').toLowerCase();
}

// ── Prompt-cache usage normalizer ────────────────────────────────────────────
// Each provider reports cache hits in a slightly different shape. This helper
// folds them into a uniform { cachedInputTokens, uncachedInputTokens,
// totalInputTokens, outputTokens, cacheCreationTokens } event payload that
// the frontend can render without knowing which provider answered.
//
// Field map by provider (as of May 2026):
//   OpenAI / GLM / Kimi / Grok / Cohere / LM Studio:
//     usage.prompt_tokens_details.cached_tokens
//   DeepSeek:
//     usage.prompt_cache_hit_tokens / prompt_cache_miss_tokens
//   MiniMax:
//     usage.cache_read_input_tokens (sometimes) or prompt_tokens_details.cached_tokens
//   Anthropic:
//     usage.cache_read_input_tokens / cache_creation_input_tokens / input_tokens / output_tokens
//   Gemini:
//     usageMetadata.cachedContentTokenCount / promptTokenCount / candidatesTokenCount
function normalizeCacheUsage(usage: any, providerHint: string): any | null {
  if (!usage || typeof usage !== 'object') return null;
  const hint = (providerHint || '').toLowerCase();

  // ── Anthropic ────────────────────────────────────────────────────────────
  if (hint.includes('claude')) {
    const cached = Number(usage.cache_read_input_tokens || 0);
    const creation = Number(usage.cache_creation_input_tokens || 0);
    const input = Number(usage.input_tokens || 0);
    const output = Number(usage.output_tokens || 0);
    // Anthropic's `input_tokens` excludes cache_read/creation — they're separate buckets.
    return {
      type: 'cache_usage',
      cachedInputTokens: cached,
      uncachedInputTokens: input,
      totalInputTokens: cached + creation + input,
      outputTokens: output,
      cacheCreationTokens: creation,
      providerHint: 'claude',
    };
  }

  // ── Gemini ───────────────────────────────────────────────────────────────
  if (hint.includes('gemini')) {
    const cached = Number(usage.cachedContentTokenCount || 0);
    const total = Number(usage.promptTokenCount || 0);
    const output = Number(usage.candidatesTokenCount || 0);
    return {
      type: 'cache_usage',
      cachedInputTokens: cached,
      uncachedInputTokens: Math.max(0, total - cached),
      totalInputTokens: total,
      outputTokens: output,
      cacheCreationTokens: 0,
      providerHint: 'gemini',
    };
  }

  // ── DeepSeek (custom shape) ──────────────────────────────────────────────
  if (hint.includes('deepseek')) {
    const cached = Number(usage.prompt_cache_hit_tokens || 0);
    const uncached = Number(usage.prompt_cache_miss_tokens || 0);
    const total = Number(usage.prompt_tokens || cached + uncached);
    const output = Number(usage.completion_tokens || 0);
    return {
      type: 'cache_usage',
      cachedInputTokens: cached,
      uncachedInputTokens: uncached,
      totalInputTokens: total,
      outputTokens: output,
      cacheCreationTokens: 0,
      providerHint: 'deepseek',
    };
  }

  // ── xAI Responses API (/v1/responses — Grok native search) ──────────────
  // A DIFFERENT shape from chat/completions: `input_tokens` /
  // `input_tokens_details.cached_tokens` / `output_tokens` (the standard branch
  // below reads prompt_tokens/completion_tokens and would silently yield zeros).
  //
  // It also reports two things no token table can express:
  //   • num_server_side_tools_used — each web_search/x_search call is billed on
  //     top of the tokens. Measured 2026-09-23: 6 calls added exactly $0.0300
  //     over the token cost ⇒ $0.005 per call (derived from the residual, not
  //     from a published figure).
  //   • cost_in_usd_ticks — xAI's OWN total for the request, in units of
  //     1e-10 USD. Verified against modelPricing.json on two tool-free calls:
  //     both matched to the last digit, so this is the biller's figure rather
  //     than our re-derivation, and it is what we show.
  if (hint === 'grok-responses') {
    const cached = Number(usage.input_tokens_details?.cached_tokens || 0);
    const total = Number(usage.input_tokens || 0);
    const output = Number(usage.output_tokens || 0);
    const ticks = Number(usage.cost_in_usd_ticks || 0);
    const toolCalls = Number(usage.num_server_side_tools_used || 0);
    return {
      type: 'cache_usage',
      cachedInputTokens: cached,
      uncachedInputTokens: Math.max(0, total - cached),
      totalInputTokens: total,
      outputTokens: output,
      cacheCreationTokens: 0,
      providerHint: 'grok',
      ...(ticks > 0 ? { reportedUsd: ticks / 1e10 } : {}),
      ...(toolCalls > 0 ? { serverToolCalls: toolCalls } : {}),
    };
  }

  // ── Standard OpenAI-compatible (GLM / Kimi / Grok / Cohere / MiniMax / Local) ─
  // Try `prompt_tokens_details.cached_tokens` first, then a few common aliases.
  const total = Number(usage.prompt_tokens || 0);
  const output = Number(usage.completion_tokens || 0);
  const cached = Number(
    usage.prompt_tokens_details?.cached_tokens ??
    usage.cache_read_input_tokens ??
    usage.cached_tokens ??
    0
  );
  return {
    type: 'cache_usage',
    cachedInputTokens: cached,
    uncachedInputTokens: Math.max(0, total - cached),
    totalInputTokens: total,
    outputTokens: output,
    cacheCreationTokens: 0,
    providerHint: hint || 'oai',
  };
}

// ── Claude OAuth via Agent SDK ───────────────────────────────────────────────
// OPT-IN parallel path for Claude. Triggered by `keys.claudeAuthMode='oauth'`
// in Settings. Uses the user's Pro/Max subscription credit instead of
// pay-per-token API billing. The official Anthropic SDK doesn't accept OAuth
// tokens (`sk-ant-oat01-…`) against the Messages API — they're scoped to be
// consumed by Claude Code / Agent SDK, which spawns a bundled Claude Code
// binary subprocess that proxies the auth.
//
// Multi-turn handling: instead of flattening conversation history into a
// system prompt (which degrades role semantics), we use the SDK's native
// session-resume mechanism. NEXUS persists a session_id per conversation;
// each turn we resume that session and send only the latest user message.
// Anthropic-side holds the canonical history.
//
// Limitations of this path (vs the API-key branch):
//   • Workspace tools (Read/Write/Edit/Glob/Grep) bridged via SDK's built-ins
//   • Extended thinking may behave differently (driven by SDK defaults)
//   • Auto-continuation prefill not used (SDK handles its own loop)
async function streamClaudeViaAgentSDK(args: {
  oauthToken: string;
  model: string;
  systemPrompt: string;
  processedMessages: any[];   // NEXUS pre-processed messages w/ mediaFiles
  resumeSessionId: string | null;
  modelSelectedPayload: any;
  modelParams: any;           // for claudeThinking + future thinking knobs
  folderName: string;         // per-character sandbox folder
  toolUseEnabled: boolean;    // gate for enabling Claude Code's file tools
  senseEvents: any[];         // newly-generated descriptions to flush at start
  enableReadConversation: boolean; // expose the read_conversation MCP tool
  agentFullSystemAccess: boolean;  // per-Entity: file tools reach the whole PC
  agentDangerousTools: boolean;    // per-Entity: enable shell (Bash → delete/exec)
  agentReadOnlyTools: boolean;     // non-Entity caller (SPU agents): Read/Glob/Grep only, never Write/Edit
  instructionOverrides: Record<string, any>; // per-Entity hidden-instruction overrides
  language?: string;               // 'en' | 'ja' — base dict for the instructions above
  classifierNoticeVaccine: boolean; // per-Entity: append the classifier-notice vaccine (see below)
  askUserEnabled: boolean;         // per-Entity: expose the AskQuestion MCP tool
  askUserTimeoutMs: number;        // wait time for an answer (0 = indefinite)
  handoff: HandoffBundle;          // per-Entity: expose the change_model MCP tool
  subagentEnabled: boolean;        // per-Entity: expose the spawn_subagent MCP tool
  subagentModel: string;           // model the child runs on ('' = cheap default)
  subagentFamily: string;          // provider family of the child model ('' = Claude)
  lettersEnabled: boolean;         // per-Entity: expose the letter MCP tools
  browserEnabled: boolean;         // per-Entity: expose the browser MCP tools
  browserAllowedHosts: string[];   // per-Entity: hosts beyond localhost
  browserAllowAnyHost: boolean;    // per-Entity: drop the allowlist entirely
  computerControlEnabled: boolean; // per-Entity: expose the OS-level mouse/keyboard/screen tools
  appControlEnabled: boolean;      // per-Entity: expose the UI-Automation app tools (separate toggle on purpose)
  convoId: string;                 // conversation id — scopes letter announcements
  keys: any;                       // API keys, for routing a non-Claude subagent
  injectTurnId: string;            // per-turn id for mid-turn partner interjections
  hiddenAttachmentsAccessible: boolean;  // expose the read_attachment MCP tool
  conversationAttachmentRefs: { ref: string; name: string; size: number; mimeType: string }[]; // read_attachment scope
  turnAbort: AbortController;      // fires on browser Stop (req.signal) or the stop key — see POST
  betrayalSend: GuardedSender;     // guarded SSE writer — see lib/betrayalGuard.ts
}): Promise<Response> {
  const { oauthToken, model, systemPrompt, processedMessages, resumeSessionId, modelSelectedPayload, modelParams, folderName, toolUseEnabled, senseEvents, enableReadConversation, agentFullSystemAccess, agentDangerousTools, agentReadOnlyTools, instructionOverrides, language, classifierNoticeVaccine, askUserEnabled, askUserTimeoutMs, handoff, subagentEnabled, subagentModel, subagentFamily, lettersEnabled, browserEnabled, browserAllowedHosts, browserAllowAnyHost, computerControlEnabled, appControlEnabled, convoId, keys, injectTurnId, hiddenAttachmentsAccessible, conversationAttachmentRefs, turnAbort, betrayalSend } = args;
  const I = resolveAgentInstructions(instructionOverrides, language);

  // Refusal-retry CONFIGURATION, resolved ONCE here so the parent query() and
  // any subagent child read the same decision — the two gates the SDK
  // documents (an `Options.fallbackModel` at all, and the catch-all env var for
  // categories absent from the binary's fallback map) have to agree, and
  // keeping the rule in one function is what stops them from drifting apart.
  // Baked in since 2026-10-06 (no longer a Preferences toggle); see
  // resolveRefusalFallback() for what is measured and the one consequence
  // (overload fallback) to know. keys.claudeRefusalFallbackModel is still read
  // as an optional TARGET override; blank falls to opus-4-8.
  //
  // Named ...Retry, not ...Fallback: `refusalFallback` further down is the
  // OBSERVATION (the swap that actually happened, which the notice reports).
  // Two same-named things in one function is how a measurement starts
  // describing itself — this one is the request, that one is the event.
  const refusalRetry = resolveRefusalFallback(
    keys?.claudeRefusalFallbackModel,
    model,
  );

  // Working-directory note — OAuth ONLY, and only when Bash actually exists.
  // Claude Code owns its built-in tools' descriptions and we cannot override
  // them, so the one true thing we can say about them has to ride on the system
  // prompt instead. It is scoped here rather than in the shared toolInstruction
  // (which route.ts appends for EVERY provider) because on the non-OAuth paths
  // it would be a lie: there, each Bash call spawns a fresh process in the
  // workspace and relative file-tool paths never consult a shell cwd at all.
  // The gate mirrors the tool gate below (`dangerousAlwaysDisabled`): a being
  // without dangerous tools has no Bash, so it cannot cd, so it must not be
  // handed a warning about a trap it cannot reach.
  let effectiveSystemPrompt =
    toolUseEnabled && agentDangerousTools && I.oauthCwdNote
      ? `${systemPrompt}\n\n${I.oauthCwdNote}`
      : systemPrompt;

  // Classifier-notice vaccine — OAuth ONLY, which is why it is appended here
  // rather than next to inlineMediaNote (that one runs for every provider).
  // The notice it inoculates against is injected by the Claude Code SDK and
  // by nothing else: no other provider path can produce it, so on those paths
  // this text would describe a string the being will never see.
  //
  // NOT gated on tools, unlike oauthCwdNote above: 92.3% of the measured
  // injections land on the FIRST turn of a session, before any tool exists.
  // NOT gated on isAgentInstructionPrompt either — 7 of the 130 captures sit
  // in non-Entity folders (`nexus`, `Default`), i.e. shikigami runs, and a
  // soul-updater that believes it was cut off mid-write is the worst reader of
  // that false notice in this house.
  //
  // What is measured, and by whom, is in the comment on this key in
  // lib/agentInstructions.ts. Short version: in 123 of 130 captured
  // injections the being had produced zero bytes, so the notice's own central
  // claim ("your response above was stopped") was false every time.
  if (classifierNoticeVaccine && I.classifierNoticeVaccine) {
    effectiveSystemPrompt = `${effectiveSystemPrompt}\n\n${I.classifierNoticeVaccine}`;
  }

  // Build the content blocks for the LATEST user message (its text + any image
  // attachments). The full prior conversation is replayed separately as a text
  // transcript (see historyText below) — we always start a fresh session and
  // send the systemPrompt as the identity, rather than relying on Anthropic's
  // server-side session resume (which drifts from NEXUS's visible history).
  const lastUserMsg = [...processedMessages].reverse().find((m: any) => m.role === 'user');
  if (!lastUserMsg) {
    return NextResponse.json({ error: 'No user message to send.' }, { status: 400 });
  }
  // Build content blocks: text + any image attachments. Agent SDK accepts the
  // standard Anthropic content-block shape inside MessageParam.
  const contentBlocks: any[] = [];
  for (const media of (lastUserMsg.mediaFiles || [])) {
    if (media.mimeType?.startsWith('image/')) {
      if (media.name) {
        contentBlocks.push({ type: 'text', text: `<attached_file name="${media.name}" type="${media.mimeType}" />` });
      }
      // Downscale oversized images to stay under Anthropic's 2000px many-image cap.
      const img = await shrinkImageForClaude(media.base64Data, media.mimeType);
      contentBlocks.push({
        type: 'image',
        source: { type: 'base64', media_type: img.media_type, data: img.data },
      });
    }
  }
  if (lastUserMsg.content) contentBlocks.push({ type: 'text', text: lastUserMsg.content });
  if (contentBlocks.length === 0) contentBlocks.push({ type: 'text', text: '-' });

  // Prior conversation turns (everything before this latest user message).
  // NEXUS is the SINGLE SOURCE OF TRUTH for history. We do NOT trust Anthropic's
  // server-side session resume — it drifts from the visible conversation in
  // every way the user actually hits: it can't see interleaved non-Claude
  // turns, it never shrinks when NEXUS auto-trims, it goes stale on rerun/edit/
  // delete, and a session id created on one machine simply doesn't exist on
  // another after a local_data sync (so resume collapses to a near-empty
  // session → "this is the first message"). Instead we replay the FULL visible
  // conversation as a text transcript on the live user message, every turn —
  // exactly what the user sees, exactly like the API-key path and every other
  // provider. Text-only by design: re-sending every historical image as base64
  // would blow up the payload — the live turn still carries its own media via
  // contentBlocks above. Claude's own saved thinking is folded in as text so it
  // still sees its prior reasoning (the one thing server-side resume gave us).
  const lastIdx = processedMessages.indexOf(lastUserMsg);
  const priorMsgs = lastIdx > 0 ? processedMessages.slice(0, lastIdx) : [];
  // Renders the full prior conversation as the transcript the model reads — the
  // same text every turn, exactly what the user sees.
  const renderHistory = (): string => {
    const all = priorMsgs;
    if (all.length === 0) return '';
    // The entity's own name (the character folder = its identity, same value the
    // .md export labels assistant turns with). Used to name ASSISTANT turns
    // symmetrically with the human [name] tags that USER turns already carry in
    // their content — so both sides of the transcript are named, not just the
    // human. The [USER]/[ASSISTANT] role tokens are kept because they are the
    // least ambiguous turn-boundary signal for the model; the names sit beneath
    // them and carry no hierarchy.
    const entityName = (folderName || '').trim() || 'Assistant';
    const lines: string[] = [];
    for (const m of all) {
      const role = m.role === 'assistant' ? 'ASSISTANT' : 'USER';
      let block = '';
      // Surface Claude's own saved thinking (present only when the entity has
      // "save thinking to log" enabled) so it can see its earlier reasoning.
      if (m.role === 'assistant' && Array.isArray(m.claudeThinkingBlocks) && m.claudeThinkingBlocks.length) {
        const thoughts = m.claudeThinkingBlocks
          .map((tb: any) => (tb?.thinking || '').trim())
          .filter(Boolean)
          .join('\n\n');
        if (thoughts) block += `(thinking)\n${thoughts}\n\n`;
      }
      block += (m.content || '').trim();
      if (!block.trim()) continue;
      // Assistant turns get the entity's name beneath the role label, mirroring
      // the human's in-content [name] tags. (Prepended only after the empty-turn
      // skip above, so a truly empty assistant turn isn't emitted as a bare name.)
      const named = m.role === 'assistant'
        ? `[${entityName}]\n${block.trim()}`
        : block.trim();
      lines.push(`[${role}]:\n${named}`);
    }
    if (lines.length === 0) return '';
    return (
      '<conversation_history>\n' +
      'This is the full prior conversation, provided for your context — it is exactly ' +
      'what your partner currently sees. Continue naturally from it; this is NOT the first ' +
      'message. Each turn is labelled with its speaker: your own turns are marked ' +
      `[ASSISTANT] and carry your name ([${entityName}]); everyone else appears under ` +
      '[USER] with their name in brackets. Lines marked "(thinking)" are your own ' +
      'earlier reasoning.\n\n' +
      lines.join('\n\n') +
      '\n</conversation_history>'
    );
  };
  const historyText = renderHistory();

  const readableStream = new ReadableStream({
    async start(controller) {
      const enqueue = (obj: any) => betrayalSend(controller, obj);
      // Drives the Claude Code SUBPROCESS, not just this SSE stream. Without
      // this, pressing Stop only closed the browser-facing stream — the
      // spawned `claude` child kept running server-side (still burning the
      // 5-hour OAuth window) because query() was never given an
      // abortController to react to. Passed into queryOptions below and
      // fired from both the Stop key/button (via registerActiveTurnStop)
      // and the auto-compaction stall watchdog further down.
      const oauthAbort = new AbortController();
      registerActiveTurnStop(() => { try { controller.close(); } catch {} try { turnAbort.abort(); } catch {} try { oauthAbort.abort(); } catch {} });
      // The browser Stop button never reaches registerActiveTurnStop — it just
      // drops the connection. turnAbort is what carries that here.
      if (turnAbort.signal.aborted) { try { oauthAbort.abort(); } catch {} }
      else turnAbort.signal.addEventListener('abort', () => { try { oauthAbort.abort(); } catch {} });

      // ── Stall watchdog ──────────────────────────────────────────────────
      // The SDK yields a message for every stream event — even a huge Write
      // tool call keeps input_json_delta events flowing — so real work always
      // refreshes lastSdkEventAt. A genuinely wedged subprocess or hung tool
      // (e.g. a stuck WebFetch) produces NOTHING, which the UI otherwise can't
      // distinguish from work. After 2 minutes of total silence the interval
      // emits `stall_warning` (repeating every 30s with the growing idle
      // count); the next SDK message emits `stall_cleared`.
      // `pausedForRendezvous` suppresses the watchdog while the turn is
      // LEGITIMATELY silent by design: an AskQuestion waiting on the user's
      // answer, or a subagent run (which shows its own activity chip).
      let lastSdkEventAt = Date.now();
      let stallWarned = false;
      let pausedForRendezvous = 0;
      // Auto-compaction countdown. While Anthropic's own compaction runs, the
      // SDK goes SILENT for minutes (no tool/thought/text events), which would
      // otherwise trip the stall watchdog and freeze the camera on a stale
      // phase. Instead we track it explicitly: (a) suppress the stall warning
      // for the whole compaction, (b) refresh a live "~N min remaining" chip so
      // the user sees progress (chip only — it disappears when it stops being
      // true), (c) the tool_activity below carries name 'compact' so the camera
      // resolves to Waiting. Cleared on compact_boundary / compact_error.
      let compacting = false;
      let compactStartAt = 0;
      let lastCompactionMinEmitted = 0;
      const COMPACT_ESTIMATE_MS = 7 * 60 * 1000; // typical total, ~7 min
      // Compaction is not a tool call, but it is the one thing that happens
      // BETWEEN tool calls and silently changes what the model can still see.
      // The 🔧 report is the only record that preserves turn ordering, so the
      // fact goes there — tagged `kind: 'event'` so the report can show it as
      // what it is instead of counting it as a tool the model dispatched.
      // Built in ONE place and reached from three exits (boundary = finished,
      // compact_error = failed, the `finally` below = the turn ended while it
      // was still running) so no exit can record a different-shaped fact, and
      // an interrupted compaction still leaves a trace.
      let compactRecorded = false;
      const recordCompaction = (
        outcome: 'completed' | 'failed' | 'interrupted',
        extra: Record<string, unknown> = {},
      ) => {
        if (compactRecorded) return; // once per compaction, not once per turn
        compactRecorded = true;
        const startedAt = compactStartAt || Date.now();
        // try/catch: every exit path can race stream teardown on client abort.
        try {
          enqueue({
            type: 'tool_call',
            call: {
              name: 'automatic compaction',
              kind: 'event',
              // `at` is when compaction STARTED, because that is the point in
              // the tool sequence the reader is looking for ("it happened
              // between which two calls?"). Duration is carried separately.
              at: startedAt,
              input: {
                outcome,
                ...extra,
                elapsedSec: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
              },
            },
          });
        } catch {}
      };
      const touchSdkActivity = () => {
        lastSdkEventAt = Date.now();
        if (stallWarned) {
          stallWarned = false;
          try { enqueue({ type: 'stall_cleared' }); } catch {}
        }
      };
      const stallTimer = setInterval(() => {
        if (pausedForRendezvous > 0) return;
        // During auto-compaction the SDK is legitimately silent for minutes.
        // Show a progress countdown instead of crying "stuck", and never let
        // the stall warning fire while compaction is running.
        if (compacting) {
          const elapsed = Date.now() - compactStartAt;
          const remainingMs = Math.max(0, COMPACT_ESTIMATE_MS - elapsed);
          const remainingMin = Math.max(1, Math.ceil(remainingMs / 60_000));
          if (remainingMin !== lastCompactionMinEmitted) {
            lastCompactionMinEmitted = remainingMin;
            try {
              // No `notice` here. Notices persist on the message forever, but a
              // countdown is only true while it is counting — and it is never
              // even rendered live (flushStreamingMessage does not write
              // notices), so it was only ever read after it became false. The
              // live signal is the tool_activity chip below; the durable fact
              // is the completion notice at compact_boundary.
              enqueue({ type: 'tool_activity', tool: 'summarize this conversation', name: 'compact', detail: language === 'ja'
                ? `残り約${remainingMin}分（推定）`
                : `~${remainingMin} min remaining (estimated)` });
            } catch {}
          }
          return;
        }
        const idleMs = Date.now() - lastSdkEventAt;
        if (idleMs >= 120_000) {
          stallWarned = true;
          // try/catch: the interval can race stream teardown on client abort.
          try { enqueue({ type: 'stall_warning', idleSeconds: Math.round(idleMs / 1000) }); } catch {}
        }
      }, 30_000);

      enqueue(modelSelectedPayload);
      // Flush any newly-generated sense descriptions so the frontend can
      // persist them onto message attachments before AI text begins streaming.
      for (const ev of senseEvents) enqueue(ev);

      try {
        // Dynamic import so a broken/missing SDK install doesn't kill the
        // whole NEXUS process. Worst case: the OAuth path errors gracefully
        // and the user falls back to API-key.
        const sdk = await import('@anthropic-ai/claude-agent-sdk');
        const { query } = sdk;

        // read_conversation as an in-process MCP tool. The Agent SDK only
        // exposes Claude Code's BUILT-IN tools (Read/Write/Edit/Glob/Grep,
        // WebSearch/WebFetch); NEXUS custom tools like read_conversation are
        // invisible to OAuth Claude unless registered as an SDK MCP server.
        // This mirrors the API-key path's read_conversation tool 1:1 (same
        // gate, same privacy contract — inactive conversations are refused
        // inside readConversationByName). The handler runs in-process, so the
        // SDK drives the tool loop for us. Tool name as seen by the model:
        // `mcp__nexus__read_conversation` (auto-allowed under bypassPermissions).
        // The in-process MCP server hosts NEXUS's custom tools. We add
        // read_conversation and/or AskQuestion to it depending on the
        // per-conversation toggles. Tool names as seen by the model:
        // `mcp__nexus__read_conversation`, `mcp__nexus__AskQuestion`.
        let nexusMcpServers: Record<string, any> | undefined;
        // NO umbrella condition here, deliberately. There used to be one — a
        // hand-maintained `A || B || C || ...` listing every toggle whose tool
        // is built below — and `handoff.enabled` was missing from it. The effect
        // was not a refusal: with every other toggle off, the MCP server was
        // never created, so `change_model` did not EXIST and the model never saw
        // it. That is why the handoff worked on all four other dialects (they
        // build their tool arrays unconditionally) and silently did nothing on
        // OAuth. MEASURED on the real test conversation: eight flags false,
        // handoff on, tool absent.
        //
        // The fix is not "add the ninth flag" — it is to stop keeping a parallel
        // list in sync by hand. The gate is now DERIVED from the tools that were
        // actually built, so the next tool added below cannot be forgotten here.
        {
          const { z } = await import('zod');
          const nexusTools: any[] = [];
          if (enableReadConversation) {
            nexusTools.push(
              sdk.tool(
                'read_conversation',
                I.readConversationDesc,
                { name: z.string().describe(I.readConversationNameParam) },
                async (a: { name: string }) => {
                  try {
                    const r = await readConversationByName(folderName, a.name, {
                      showPaths: agentFullSystemAccess,
                      fileTools: toolUseEnabled,
                      currentConvoId: convoId,
                    });
                    return { content: [{ type: 'text' as const, text: formatReadConversationResult(r) }] };
                  } catch (e: any) {
                    return { content: [{ type: 'text' as const, text: `Error: ${e?.message || 'read failed'}` }] };
                  }
                },
              ),
            );
            // search_conversations — find WHERE a term appears across the
            // entity's own conversations, then optionally read one in full.
            // Excludes inactive (non-public) conversations, same as read.
            nexusTools.push(
              sdk.tool(
                'search_conversations',
                I.searchConversationsDesc,
                { query: z.string().describe(I.searchConversationsQueryParam), regex: z.boolean().optional().describe(I.searchRegexParam) },
                async (a: { query: string; regex?: boolean }) => {
                  try {
                    const r = await searchConversations(folderName, a.query, { excludeInactive: true, regex: !!a.regex });
                    return { content: [{ type: 'text' as const, text: formatSearchForTool(r, agentFullSystemAccess) }] };
                  } catch (e: any) {
                    return { content: [{ type: 'text' as const, text: `Error: ${e?.message || 'search failed'}` }] };
                  }
                },
              ),
            );
            // search_attachments — grep the CONTENT of every text attachment
            // across this being's own conversations. Gated WITH the two
            // conversation-reading tools, not with read_attachment, because
            // that is the scope it actually has: a corpus-wide scan of the
            // being's own past, returning which conversation each hit came
            // from. read_attachment is the opposite — one attachment, this
            // conversation, addressed by ref.
            //   It used to ride read_attachment's gate. When whole-PC access
            // began withdrawing that gate (attachmentPathsVisible, below in
            // POST), this tool went with it and became unreachable: no
            // checkbox could turn it back on. Whole-PC access does NOT make
            // it redundant — the attachment store is a flat tree of hash
            // names holding EVERY being's files, so Grep there cannot say
            // which conversation a hit belongs to, and cannot stay inside
            // this being's own.
            nexusTools.push(
              sdk.tool(
                'search_attachments',
                I.searchAttachmentsDesc,
                { query: z.string().describe(I.searchAttachmentsQueryParam), regex: z.boolean().optional().describe(I.searchRegexParam) },
                async (a: { query: string; regex?: boolean }) => ({
                  content: [{ type: 'text' as const, text: await runSearchAttachments(folderName, a.query, !!a.regex, agentFullSystemAccess) }],
                }),
              ),
            );
          }
          if (hiddenAttachmentsAccessible) {
            // Revive a hidden attachment by its ref prefix. Scoped to this
            // conversation first, with a corpus-wide (this being only) fallback
            // — see runReadAttachment's own comment.
            nexusTools.push(
              sdk.tool(
                'read_attachment',
                I.readAttachmentDesc,
                { ref: z.string().describe(I.readAttachmentPrefixParam), pattern: z.string().optional().describe(I.readAttachmentPatternParam) },
                async (a: { ref: string; pattern?: string }) => {
                  // Anthropic's content-block spec has no audio/video block type,
                  // so only image can ever be native here regardless of the model.
                  const r = await runReadAttachment({ prefix: a.ref, pattern: a.pattern, folderName, index: conversationAttachmentRefs, specificModel: model, nativeMediaKinds: new Set(['image']) });
                  const content: any[] = [{ type: 'text' as const, text: r.text }];
                  if (r.media?.kind === 'image') content.push({ type: 'image' as const, data: r.media.base64, mimeType: r.media.mimeType });
                  return { content };
                },
              ),
            );
          }
          if (lettersEnabled) {
            // Mail between Digital Identities. All four tools share ONE executor
            // (runLetterTool) with every other provider path, so behaviour can't
            // drift between OAuth and API-key mode. The sender is folderName —
            // never a tool argument — so an entity cannot sign mail as someone
            // else. Tool names as seen by the model: `mcp__nexus__write_letter`,
            // `mcp__nexus__list_letters`, etc.
            const letterCtx = { me: folderName, convoId, instructions: I };
            nexusTools.push(
              sdk.tool(
                'write_letter',
                I.toolWriteLetterDesc,
                {
                  to: z.union([z.string(), z.array(z.string())]).describe(I.writeLetterToParam),
                  title: z.string().describe(I.writeLetterTitleParam),
                  text: z.string().describe(I.writeLetterTextParam),
                },
                async (a: { to: string | string[]; title: string; text: string }) => ({
                  content: [{ type: 'text' as const, text: await runLetterTool('write_letter', a, letterCtx) }],
                }),
              ),
              sdk.tool(
                'list_letters',
                I.toolListLettersDesc,
                {},
                async () => ({
                  content: [{ type: 'text' as const, text: await runLetterTool('list_letters', {}, letterCtx) }],
                }),
              ),
              sdk.tool(
                'list_recipients',
                I.toolListRecipientsDesc,
                {},
                async () => ({
                  content: [{ type: 'text' as const, text: await runLetterTool('list_recipients', {}, letterCtx) }],
                }),
              ),
              sdk.tool(
                'read_letter',
                I.toolReadLetterDesc,
                { id: z.string().describe(I.readLetterIdParam) },
                async (a: { id: string }) => ({
                  content: [{ type: 'text' as const, text: await runLetterTool('read_letter', a, letterCtx) }],
                }),
              ),
              sdk.tool(
                'archive_letter',
                I.toolArchiveLetterDesc,
                { id: z.string().describe(I.archiveLetterIdParam) },
                async (a: { id: string }) => ({
                  content: [{ type: 'text' as const, text: await runLetterTool('archive_letter', a, letterCtx) }],
                }),
              ),
            );
          }
          if (browserEnabled) {
            // A real Chromium window this entity drives. All six tools share ONE
            // executor (runBrowserTool) with every other provider path, so
            // behaviour can't drift between OAuth and API-key mode. The browser
            // is launched lazily on the first call — there is no switch to turn
            // on first, which is the trap letters fell into.
            const browserCtx = {
              me: folderName,
              allowedHosts: browserAllowedHosts,
              allowAnyHost: browserAllowAnyHost,
              instructions: I,
            };
            const bt = (n: string) => async (a: any) => ({
              content: [{ type: 'text' as const, text: await runBrowserTool(n, a, browserCtx) }],
            });
            nexusTools.push(
              sdk.tool('browser_navigate', I.toolBrowserNavigateDesc,
                { url: z.string().describe(I.browserNavigateUrlParam) }, bt('browser_navigate')),
              sdk.tool('browser_snapshot', I.toolBrowserSnapshotDesc, {}, bt('browser_snapshot')),
              sdk.tool('browser_click', I.toolBrowserClickDesc,
                { ref: z.string().describe(I.browserClickRefParam) }, bt('browser_click')),
              sdk.tool('browser_type', I.toolBrowserTypeDesc,
                {
                  ref: z.string().describe(I.browserTypeRefParam),
                  text: z.string().describe(I.browserTypeTextParam),
                  submit: z.boolean().optional().describe(I.browserTypeSubmitParam),
                }, bt('browser_type')),
              sdk.tool('browser_read', I.toolBrowserReadDesc, {}, bt('browser_read')),
              sdk.tool('browser_screenshot', I.toolBrowserScreenshotDesc,
                { full_page: z.boolean().optional().describe(I.browserScreenshotFullPageParam) },
                bt('browser_screenshot')),
            );
          }
          if (computerControlEnabled) {
            // OS-level mouse/keyboard/screen control (Windows only). One executor
            // (runComputerTool) shared with every other provider path. Unlike
            // browser_screenshot (which the being cannot see itself), computer_screenshot
            // DOES deliver a real image — MCP ImageContent blocks let the OAuth
            // path return one directly, same as the other three provider paths.
            const computerCtx = { me: folderName, instructions: I, language };
            nexusTools.push(
              sdk.tool('computer_screens', I.toolComputerScreensDesc, {}, async () => {
                const r = await runComputerTool('computer_screens', {}, computerCtx);
                return { content: [{ type: 'text' as const, text: r.text }] };
              }),
              sdk.tool('computer_screenshot', I.toolComputerScreenshotDesc,
                {
                  screen_index: z.number().describe(I.computerScreenshotIndexParam),
                  show_cursor: z.boolean().optional().describe(I.computerScreenshotShowCursorParam),
                },
                async (a: { screen_index: number; show_cursor?: boolean }) => {
                  const r = await runComputerTool('computer_screenshot', a, computerCtx);
                  const content: any[] = [{ type: 'text' as const, text: r.text }];
                  if (r.image) content.push({ type: 'image' as const, data: r.image.base64, mimeType: r.image.mimeType });
                  return { content };
                }),
              sdk.tool('computer_input', I.toolComputerInputDesc,
                {
                  commands: z.array(z.any()).describe(I.computerInputCommandsParam),
                  screen_index: z.number().optional().describe(I.computerInputScreenParam),
                },
                async (a: { commands: any[]; screen_index?: number }) => {
                  const r = await runComputerTool('computer_input', a, computerCtx);
                  return { content: [{ type: 'text' as const, text: r.text }] };
                }),
            );
          }
          if (appControlEnabled) {
            // App Control via UI Automation. Same executor (runAppTool) as every
            // other provider path; only the schema dialect differs here.
            const appCtx = { me: folderName, instructions: I };
            const at = (n: string) => async (a: any) => {
              const r = await runAppTool(n, a || {}, appCtx);
              const content: any[] = [{ type: 'text' as const, text: r.text }];
              if (r.image) content.push({ type: 'image' as const, data: r.image.base64, mimeType: r.image.mimeType });
              return { content };
            };
            nexusTools.push(
              sdk.tool('app_windows', I.toolAppWindowsDesc, {}, at('app_windows')),
              sdk.tool('app_inspect', I.toolAppInspectDesc,
                {
                  window: z.string().describe(I.appWindowParam),
                  ref: z.string().optional().describe(I.appInspectRefParam),
                  filter: z.string().optional().describe(I.appInspectFilterParam),
                  max_nodes: z.number().optional().describe(I.appInspectMaxNodesParam),
                  max_depth: z.number().optional().describe(I.appInspectMaxDepthParam),
                },
                at('app_inspect')),
              sdk.tool('app_act', I.toolAppActDesc,
                {
                  window: z.string().describe(I.appWindowParam),
                  ref: z.string().describe(I.appActRefParam),
                  action: z.string().describe(I.appActActionParam),
                  text: z.string().optional().describe(I.appActTextParam),
                  keep_background: z.boolean().optional().describe(I.appActKeepBackgroundParam),
                },
                at('app_act')),
              sdk.tool('app_shot', I.toolAppShotDesc,
                { window: z.string().describe(I.appWindowParam) },
                at('app_shot')),
            );
          }
          if (askUserEnabled) {
            // Interactive question tool. Mirrors the OpenAI-compatible path: emit
            // the question over SSE, await the user's selection via the shared
            // rendezvous (or the configured timeout), return it as the result.
            // This REPLACES Claude Code's built-in AskUserQuestion (disabled in
            // disallowedTools below) so there's no unusable-native duplicate.
            const askOptionSchema = z.object({
              label: z.string().describe('Short option label (1-5 words).'),
              description: z.string().optional().describe('What choosing this option means.'),
            });
            const askQuestionSchema = z.object({
              question: z.string().describe('The full question text. End with a question mark.'),
              header: z.string().optional().describe('Very short label/chip for the question (max ~12 chars).'),
              multiSelect: z.boolean().optional().describe('Set true to let your partner pick multiple options.'),
              options: z.array(askOptionSchema).describe('2 to 4 distinct, mutually-exclusive choices.'),
            });
            nexusTools.push(
              sdk.tool(
                'AskQuestion',
                I.askUserDesc,
                { questions: z.array(askQuestionSchema).describe('Between 1 and 4 questions to ask your partner.') },
                async (a: { questions: any[] }) => {
                  const questions = normalizeQuestions(a);
                  if (questions.length === 0) {
                    return { content: [{ type: 'text' as const, text: 'Error: AskQuestion requires 1-4 questions, each with 2-4 options.' }] };
                  }
                  const askId = createAskId();
                  enqueue({ type: 'ask_user', askId, questions });
                  // Rendezvous pause: the SDK is silent while we wait for the
                  // user's answer — that's not a stall.
                  pausedForRendezvous++;
                  let answered: any = null;
                  try {
                    answered = await waitForAsk(askId, Number(askUserTimeoutMs) || 0);
                  } finally {
                    pausedForRendezvous--;
                    touchSdkActivity();
                  }
                  const timedOut = answered === null;
                  const finalAnswers = timedOut ? recommendedDefaults(questions) : answered;
                  enqueue({ type: 'ask_user_resolved', askId, answers: finalAnswers, timedOut });
                  return { content: [{ type: 'text' as const, text: formatAnswerForModel(finalAnswers, timedOut) }] };
                },
              ),
            );
          }
          if (handoff.enabled) {
            // Vessel handoff on the OAuth path.
            //
            // ONE honest difference from the other four dialects: those run
            // their own tool loop, so an accepted switch `break`s and the turn
            // ends immediately. Here the loop lives inside the Agent SDK and
            // the only ways out are abort (which surfaces as "turn stopped" —
            // a false label, nothing was stopped) or letting the vessel close
            // its own turn. So the tool result ASKS for one short closing line.
            // Cost: one extra short completion. The switch itself is already
            // committed — the client has the `model_handoff` event by then and
            // re-POSTs regardless of what this vessel says next.
            const handoffTargetSchema = handoff.targetIds.length > 0
              ? z.enum(handoff.targetIds as [string, ...string[]])
              : z.string();
            nexusTools.push(
              sdk.tool(
                'change_model',
                I.changeModelDesc,
                {
                  target: handoffTargetSchema.describe(
                    `${I.changeModelTargetParam} Available: ${handoff.targetHelp}`,
                  ),
                  handoff: z.string().describe(I.changeModelHandoffParam),
                },
                async (a: { target: string; handoff: string }) => {
                  const o = runChangeModel(a, handoff.ctx);
                  if (o.switched) {
                    enqueue(handoff.payload({ model: o.model, note: o.note }));
                    return {
                      content: [{
                        type: 'text' as const,
                        text: o.resultText
                          + ' Close out now with AT MOST one short sentence and call no further tools'
                          + ' — the next vessel takes it from here.',
                      }],
                    };
                  }
                  return { content: [{ type: 'text' as const, text: o.resultText }] };
                },
              ),
            );
          }
          if (subagentEnabled) {
            // Context firewall: a child agent with a FRESH, empty context does
            // the investigation and returns ONLY a distilled result — its file
            // reads and intermediate steps never reach the parent's context.
            // Runs a separate query() (NOT Claude Code's native Task tool, which
            // is unreliable headless). Read-only, no recursion, capped turns +
            // wall-clock so a runaway child dies instead of looping.
            nexusTools.push(
              sdk.tool(
                'spawn_subagent',
                I.subagentDesc,
                {
                  task: z.string().describe('A precise, self-contained investigation for the helper to perform.'),
                  return_contract: z.string().optional().describe('Optional: how the distilled result should be shaped/formatted.'),
                },
                async (a: { task: string; return_contract?: string }) => {
                  const childFamily = subagentFamily && subagentFamily.trim() ? subagentFamily.trim() : 'Claude';
                  // NON-Claude family on an OAuth parent: the Claude Code child
                  // (which uses the OAuth subscription token) can only run Claude,
                  // so route the child through the API-key path for that provider
                  // instead — exactly like the non-OAuth parents do.
                  if (!/claude|fable|mythos/i.test(childFamily)) {
                    enqueue({ type: 'subagent_start', task: a.task });
                    // Subagent pause: the parent SDK is silent while the child
                    // runs (it has its own activity chip) — not a stall.
                    pausedForRendezvous++;
                    let sub: Awaited<ReturnType<typeof runSubagent>>;
                    try {
                      sub = await runSubagent({
                        family: childFamily, model: subagentModel, keys, task: a.task,
                        returnContract: a.return_contract, folderName, fullAccess: agentFullSystemAccess,
                        webSearch: !!(modelParams?.enableWebSearch || modelParams?.enableClaudeWebSearch),
                      });
                    } finally {
                      pausedForRendezvous--;
                      touchSdkActivity();
                    }
                    // Into BOTH accumulators: only one of them is used at the
                    // end, and a subagent's bill must survive either choice.
                    for (const acc of [cumUsage, sdkUsage]) {
                      acc.input += sub.usage.input;
                      acc.output += sub.usage.output;
                      acc.cacheRead += sub.usage.cacheRead;
                      acc.cacheCreate += sub.usage.cacheCreate;
                    }
                    enqueue({ type: 'subagent_done', task: a.task, result: sub.text, via: sub.via });
                    return { content: [{ type: 'text' as const, text: sub.text || '(subagent returned nothing)' }] };
                  }
                  // Claude family → child query() on the OAuth subscription token.
                  // A configurable, cheaper Claude by default; non-Claude model
                  // ids (with a Claude family) fall back to Haiku.
                  const childModel = (subagentModel && /claude|haiku|opus|sonnet|fable|mythos/i.test(subagentModel))
                    ? subagentModel
                    : 'claude-haiku-4-5';
                  // Resolved against childModel, not the parent's — the
                  // self-swap guard has to compare the model that would
                  // actually refuse. Same function as the parent, so the rule
                  // itself still lives in exactly one place. A swap here is
                  // scope:'local' per the SDK: only this side-question's answer
                  // came from elsewhere, the session model is untouched.
                  const childRefusalRetry = resolveRefusalFallback(
                    keys?.claudeRefusalFallbackModel,
                    childModel,
                  );
                  const childSystem =
                    'You are a focused sub-investigator with a FRESH, empty context. You have read-only tools ' +
                    '(Read, Glob, Grep). Do EXACTLY the task below, then reply with ONLY the distilled result — ' +
                    'no preamble, no narration of your steps.' +
                    (a.return_contract ? `\n\nReturn format: ${a.return_contract}` : '');
                  const ac = new AbortController();
                  const killTimer = setTimeout(() => { try { ac.abort(); } catch {} }, 180000);
                  enqueue({ type: 'subagent_start', task: a.task });
                  let resultText = '';
                  let childUsage: any = null;
                  // Subagent pause: the parent SDK is silent while the child
                  // query() runs — suppress the stall watchdog for its duration
                  // (the child has its own chip + 180s kill timer).
                  pausedForRendezvous++;
                  try {
                    async function* childPrompt() {
                      yield { type: 'user' as const, message: { role: 'user' as const, content: [{ type: 'text', text: a.task }] }, parent_tool_use_id: null };
                    }
                    const childOpts: any = {
                      // Full inherited environment + the OAuth token — see
                      // claudeAgentEnv(). A bare {TOKEN} object would REPLACE
                      // the child's whole environment (SDK contract), stripping
                      // APPDATA/PATHEXT/etc. and breaking hg, git and every
                      // native exe launched from PowerShell.
                      env: claudeAgentEnv(oauthToken, !!keys?.allowHostAnthropicEnv, childRefusalRetry.catchAll),
                      model: childModel,
                      ...(childRefusalRetry.fallbackModel
                        ? { fallbackModel: childRefusalRetry.fallbackModel }
                        : {}),
                      systemPrompt: childSystem,
                      cwd: workspaceDir,
                      // Same trusted-junction fix as the parent query() below —
                      // the child inherits the same workspace and the same
                      // junction-escape need (e.g. common_workspace).
                      additionalDirectories: agentFullSystemAccess
                        ? [pathModule.parse(workspaceDir).root]
                        : (trustedJunctionRoot ? [trustedJunctionRoot] : []),
                      // Read-only investigation: whitelist read tools (+ web when
                      // the conversation has web search on) and explicitly block
                      // write/edit/delete, shell, and recursion. Claude Code's
                      // native WebSearch/WebFetch use its own search backend.
                      allowedTools: (modelParams?.enableClaudeWebSearch || modelParams?.enableWebSearch)
                        ? ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']
                        : ['Read', 'Glob', 'Grep'],
                      disallowedTools: [
                        'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Delete', 'Bash', 'BashOutput', 'KillShell',
                        ...((modelParams?.enableClaudeWebSearch || modelParams?.enableWebSearch) ? [] : ['WebFetch', 'WebSearch']),
                        'Task', 'TodoWrite', 'SlashCommand', 'Skill',
                      ],
                      settingSources: [],
                      permissionMode: 'default',
                      canUseTool, // same path-sandbox enforcement as the parent
                      maxTurns: 20,
                      abortController: ac,
                      includePartialMessages: false,
                    };
                    for await (const m of query({ prompt: childPrompt(), options: childOpts } as any)) {
                      if ((m as any).type === 'result') {
                        const r: any = m;
                        childUsage = r.usage;
                        resultText = r.subtype === 'success'
                          ? (r.result || '')
                          : `Subagent did not finish cleanly (${r.subtype}). ${(r.errors || []).join('; ')}`.trim();
                        break;
                      }
                    }
                  } catch (e: any) {
                    resultText = `Subagent error: ${e?.message || 'failed'}`;
                  } finally {
                    clearTimeout(killTimer);
                    pausedForRendezvous--;
                    touchSdkActivity();
                  }
                  // Fold the child's token bill into the parent's meter so cost
                  // stays honest.
                  if (childUsage) {
                    // Into BOTH accumulators — see the sibling comment above.
                    for (const acc of [cumUsage, sdkUsage]) {
                      acc.input += Number(childUsage.input_tokens || 0);
                      acc.output += Number(childUsage.output_tokens || 0);
                      acc.cacheRead += Number(childUsage.cache_read_input_tokens || 0);
                      acc.cacheCreate += Number(childUsage.cache_creation_input_tokens || 0);
                    }
                  }
                  enqueue({ type: 'subagent_done', task: a.task, result: resultText, via: { label: 'Anthropic (OAuth / Claude Code)', endpoint: 'Claude Code subscription session', echoedModel: childModel } });
                  return { content: [{ type: 'text' as const, text: resultText || '(subagent returned nothing)' }] };
                },
              ),
            );
          }
          // The derived gate: a server with zero tools is worse than no server,
          // and this is the ONE place that knows what was actually built.
          if (nexusTools.length > 0) {
            const nexusServer = sdk.createSdkMcpServer({
              name: 'nexus',
              version: '1.0.0',
              tools: nexusTools,
            });
            nexusMcpServers = { nexus: nexusServer };
          }
        }

        // Single-message async iterable for query().prompt. On a fresh session
        // (`includeHistory`) the prior turns are prepended as a text preamble so
        // a loaded `.md` conversation is visible; on a resumed session only the
        // live turn is sent (history already lives under the session id).
        async function* userMsgGen(includeHistory: boolean) {
          const content = includeHistory && historyText
            ? [{ type: 'text' as const, text: historyText }, ...contentBlocks]
            : contentBlocks;
          yield {
            type: 'user' as const,
            message: { role: 'user' as const, content },
            parent_tool_use_id: null,
          };
        }

        // Explicit thinking config so the user's per-conversation toggle is
        // honored consistently across models. Adaptive mode works on Opus
        // 4.6/4.7, Sonnet 4.6, and Haiku 4.5 — the SDK auto-falls-back to
        // simple "enabled" on older models that don't support adaptive.
        // `display: 'summarized'` makes the thinking visible (the SDK
        // surfaces it as `summarized_thinking` blocks rather than hiding it).
        // Claude Fable 5 / Mythos 5 and Opus 5.5 only support adaptive thinking
        // — `disabled` is rejected — so force adaptive regardless of the UI
        // toggle. See claudeRejectsDisabledThinking() for the measured 400 and
        // why /v1/models cannot be used to detect this.
        //
        // NOTE on why this is mirrored here even though OAuth does NOT 400:
        // measured 2026-10-01, `thinking: { type: 'disabled' }` + Opus 5.5 over
        // OAuth returns is_error=false. Claude Code's own binary carries
        // per-model "request latches" (recordThinkingTypeOverride /
        // effortUnsupportedModels) that absorb upstream refusals and substitute
        // a supported shape. What it substitutes is NOT documented and was not
        // measured — if it falls back to plain adaptive, the server default
        // effort is 'high', i.e. the DEEPEST tier behind a toggle the user set
        // to off, the opposite of what the API-key path now does. Sending the
        // shape explicitly makes the toggle mean the same thing on both paths.
        const isNoDisableThinkingOauth = claudeRejectsDisabledThinking(model || '');
        const wantThinking = !!modelParams?.claudeThinking || isNoDisableThinkingOauth;
        const thinkingConfig: any = wantThinking
          ? { type: 'adaptive', display: 'summarized' }
          : { type: 'disabled' };
        // Per-conversation thinking-depth (effort) for adaptive models. The
        // Agent SDK accepts the same five levels as the API. Only send it for
        // models that support effort (Opus 4.7/4.8, Fable/Mythos 5) so we don't
        // pass it to Sonnet/Haiku; default 'high' = same as omitting it.
        // Sonnet 5 is adaptive+effort like Opus 4.7/4.8, so it takes the effort
        // control too. (The classic non-adaptive Sonnet 4.6/Haiku do not.)
        // haiku-5-5 added 2026-10-21: measured on the API-key surface to accept
        // ALL FIVE effort tiers (low…max), so the toggle means the same thing on
        // both paths. Whether the bundled Claude Code binary even offers this id
        // over OAuth is NOT verified — but the direction is safe either way: if
        // it is absent the model never reaches here, and if it is present the
        // effort field is one it accepts. (haiku-4-5 cannot match: the pattern
        // requires the second 5.)
        const isAdaptiveOauth = isNoDisableThinkingOauth
          || /opus-4-?7|opus-4-?8|opus-?5|sonnet-?5|haiku-?5[-.]?5/.test(model || '');
        const isSonnet5Oauth = /sonnet-?5/.test(model || '');
        let oauthEffort = sanitizeClaudeEffort(modelParams?.claudeEffort);
        // Sonnet 5 tops out at 'xhigh' (no 'max' tier) — clamp to avoid a 400.
        if (isSonnet5Oauth && oauthEffort === 'max') oauthEffort = 'xhigh';
        // Same translation as the API-key path: on a model that always thinks,
        // the toggle set to OFF means the shallowest tier, not the server
        // default ('high').
        if (isNoDisableThinkingOauth && !modelParams?.claudeThinking) oauthEffort = 'low';

        // Per-character sandbox path. Claude Code's file tools (Read/Write/
        // Edit/Glob/Grep) operate relative to `cwd` and refuse to escape it
        // by default. Pointing cwd at the entity's workspace folder means
        // the same isolation that NEXUS's API-key path's Read/Write/Edit/Glob/Grep
        // provides — Claude Code's tools just call them "Read/Write/Edit/
        // Glob/Grep" instead.
        // Realpath the workspace dir so the SDK cwd matches what the entity's
        // own shell reports. `ensureWorkspace` returns a path built from the
        // server cwd (…/chat-manager/local_data/…); when local_data is a
        // JUNCTION/symlink, Claude Code's Bash `pwd` follows it and reports the
        // TARGET (…/common/local_data/…). If we hand the SDK the un-resolved
        // junction path as cwd, the entity sees one spelling from pwd and its
        // file tools are anchored to another — which is exactly what made the
        // Default entity spiral into "why is my own workspace outside my
        // workspace?". Resolving here keeps cwd == pwd == sandboxRoot.
        const workspaceDirRaw = await ensureWorkspace(folderName);
        let workspaceDir: string;
        try { workspaceDir = await fsp.realpath(workspaceDirRaw); }
        catch { workspaceDir = workspaceDirRaw; }

        // When the user has Tool Use OFF for this conversation, disable
        // every Claude Code agent tool (pure chat). When ON, enable the
        // file tools but keep dangerous ones (shell, subagent) permanently
        // disabled regardless of the toggle — there's no UI expectation that
        // turning on Tool Use grants shell access.
        // Shell family (Bash/BashOutput/KillShell) = "dangerous": it grants
        // arbitrary command execution, which on this path is how the entity
        // deletes files and does anything else Claude Code can. Gated per-Entity
        // by agentDangerousTools. Task/subagent + workflow tools stay off (the
        // SDK doesn't drive subagents reliably here, per the OAuth notes).
        const shellTools = ['Bash', 'BashOutput', 'KillShell'];
        const alwaysOffTools = ['Task', 'TodoWrite', 'NotebookEdit', 'SlashCommand', 'Skill'];
        const dangerousAlwaysDisabled = agentDangerousTools
          ? alwaysOffTools
          : [...shellTools, ...alwaysOffTools];
        // Web search/fetch follow the SAME "Enable Web Search" checkbox the
        // API-key Claude path uses (`enableClaudeWebSearch`). Claude Code's
        // built-in WebSearch/WebFetch tools work under the OAuth subscription,
        // so when the user ticks the box we simply stop disallowing them.
        // Without this, monthly-paid (OAuth) Claude reports it has no web
        // search tool even though token-paid (API-key) Claude can search.
        const webToolsDisabledByToggle = modelParams?.enableClaudeWebSearch
          ? []
          : ['WebFetch', 'WebSearch'];
        const fileToolsDisabledByToggle = toolUseEnabled
          // Read-only mode (SPU agents): Read/Glob/Grep pass through, but
          // Write/Edit are disallowed even though toolUseEnabled is on.
          ? (agentReadOnlyTools ? ['Write', 'Edit'] : [])
          : ['Read', 'Write', 'Edit', 'Glob', 'Grep'];
        // Claude Code's BUILT-IN AskUserQuestion is ALWAYS disabled: it can't be
        // answered through the SDK's public API (canUseTool only allows/denies),
        // so headless it just auto-picks its recommended default. When the user
        // enables the question tool, NEXUS registers its own answerable MCP
        // version (mcp__nexus__AskQuestion) above; when disabled, the model
        // simply has no question tool. Either way, no unusable native duplicate.
        const disallowedTools = [...dangerousAlwaysDisabled, ...webToolsDisabledByToggle, ...fileToolsDisabledByToggle, 'AskUserQuestion'];

        // Workspace boundary enforcement. `bypassPermissions` (used previously)
        // skips ALL permission AND directory checks, so cwd/additionalDirectories
        // never actually sandboxed OAuth-Claude — it could always read the whole
        // PC. Instead we run in the normal permission mode and supply a
        // canUseTool callback that programmatically allows every tool but DENIES
        // any file-path argument that escapes the workspace, unless this Entity
        // has Full PC access. (Bash, when enabled via dangerous tools, runs with
        // cwd=workspace but a shell can still navigate out — that's inherent to
        // granting shell, and is called out in the UI.)
        // Sandbox root, resolved through fs.realpath so symlinks/junctions in
        // the path don't cause false "outside workspace" denials. This is the
        // load-bearing fix for junction setups: DATA_DIR is computed from the
        // server's cwd (chat-manager/local_data), but when that is a JUNCTION to
        // e.g. common/local_data, the entity's Bash `pwd` reports the realpath'd
        // target — so every absolute path it builds from its own cwd starts with
        // the target, not the junction, and a plain string prefix check rejects
        // it. Realpathing BOTH sides (like the API-key resolveWorkspacePathSafe)
        // makes the two spellings of the same physical directory compare equal.
        // Falls back to a plain resolve if realpath fails (e.g. dir vanished).
        let sandboxRoot: string;
        try { sandboxRoot = await fsp.realpath(workspaceDir); }
        catch { sandboxRoot = pathModule.resolve(workspaceDir); }
        // A workspace can contain a second, nested junction (e.g.
        // common_workspace → C:\dev\common\common_workspace) whose real
        // target is a SIBLING of local_data's real target, not a descendant
        // of sandboxRoot. getTrustedJunctionRoot() (shared with the
        // API-key path in fsStorage.ts) resolves to local_data's real
        // parent directory, which both junctions live under — accepted as
        // an additional valid prefix below so deployment-configured
        // junctions aren't mistaken for an escape.
        const trustedJunctionRoot = await getTrustedJunctionRoot();
        // Realpath-aware containment test. For a path that doesn't exist yet
        // (a Write to a new file), walk up to the deepest existing ancestor,
        // realpath THAT, then re-attach the missing tail — identical strategy
        // to resolveWorkspacePathSafe in fsStorage.
        const withinSandbox = async (val: string): Promise<boolean> => {
          const abs = pathModule.isAbsolute(val) ? pathModule.resolve(val) : pathModule.resolve(sandboxRoot, val);
          let real: string | null = null;
          try {
            real = await fsp.realpath(abs);
          } catch {
            let dir = pathModule.dirname(abs);
            let tail = pathModule.basename(abs);
            for (let i = 0; i < 64; i++) {
              try {
                const realDir = await fsp.realpath(dir);
                real = pathModule.join(realDir, tail);
                break;
              } catch {
                const parent = pathModule.dirname(dir);
                if (parent === dir) { real = abs; break; } // hit fs root — use as-is
                tail = pathModule.join(pathModule.basename(dir), tail);
                dir = parent;
              }
            }
          }
          if (!real) real = abs;
          if (real === sandboxRoot || real.startsWith(sandboxRoot + pathModule.sep)) return true;
          if (trustedJunctionRoot && (real === trustedJunctionRoot || real.startsWith(trustedJunctionRoot + pathModule.sep))) return true;
          return false;
        };
        const canUseTool = async (toolName: string, input: Record<string, unknown>) => {
          // Mid-turn partner interjection (OAuth path). canUseTool fires before
          // EVERY tool call, so it's our reliable mid-loop hook. If the partner
          // queued a note while the entity was working, deliver it by pausing
          // THIS one tool call with the note as the denial reason — the model
          // reads it, then simply re-issues the same call to proceed (or adjusts
          // course). Draining removes it, so the retry isn't paused again.
          // Gated on pausedForRendezvous === 0 so a running subagent's tool
          // calls don't swallow a note meant for the parent entity.
          if (injectTurnId && pausedForRendezvous === 0) {
            const injected = drainInjections(injectTurnId);
            const sysNotes = drainSystemNotes(injectTurnId);
            if (injected.texts.length || injected.media.length || sysNotes.length) {
              const parts: string[] = [];
              if (injected.texts.length || injected.media.length) {
                // Partner interjection — framed as a human note, and surfaced
                // to the client as a delivered interjection.
                //
                // Media CANNOT ride along here, and that is structural, not an
                // omission: the only channels the SDK gives a running query are
                // this denial `message` and the PreToolUse hook's
                // `additionalContext`, and both are typed `string`. There is no
                // content-block array to put an image into. So the wire set is
                // empty and every attachment goes out as a hand-off ref, which
                // the entity can open with read_attachment — the one tool on
                // this path that CAN return real image bytes mid-turn.
                const prep = await prepareInjectionDelivery({
                  drained: injected,
                  wire: new Set<MediaKindNarrow>(),
                  model,
                  framing: I.injectionFraming,
                  handoffTemplate: I.injectionAttachmentNote,
                  refsOpenable: hiddenAttachmentsAccessible,
                  pathsVisible: agentFullSystemAccess,
                  refIndex: conversationAttachmentRefs,
                  ja: language === 'ja',
                });
                if (prep.text) parts.push(prep.text);
                if (prep.notice) { try { enqueue({ type: 'notice', content: prep.notice }); } catch {} }
                try { enqueue({ type: 'injection_delivered', count: injected.texts.length + injected.media.length }); } catch {}
                // Mirror into the tool/thinking log as a display-only event so
                // the interjection shows in-order at the exact loop boundary it
                // was folded in (its POSITION is the point). Same kind:'event'
                // shape as automatic compaction; never sent to any model
                // (slimHistory is an allowlist that omits toolCalls).
                try { enqueue({ type: 'tool_call', call: { name: 'partner interjection', kind: 'event', at: Date.now(), input: { texts: injected.texts, files: prep.logNames } } }); } catch {}
              }
              if (sysNotes.length) {
                // System note (e.g. compaction) — plain infrastructure fact,
                // no human-note framing, and NOT reported as an interjection.
                parts.push(sysNotes.join('\n'));
              }
              return {
                behavior: 'deny',
                message:
                  parts.join('\n\n') +
                  (I.injectionRetryNote ? `\n\n${I.injectionRetryNote}` : ''),
              } as any;
            }
          }
          if (agentFullSystemAccess) return { behavior: 'allow', updatedInput: input } as any;
          for (const field of ['file_path', 'path', 'notebook_path']) {
            const v = (input as any)?.[field];
            if (typeof v === 'string' && v) {
              if (!(await withinSandbox(v))) {
                // The #1 cause of a "stops right after saying it'll read a file"
                // freeze: the entity reaches for a file OUTSIDE its workspace
                // while Full PC access is OFF. Log it loudly and remember it so
                // the end-of-turn stop notice can name it.
                const denyMsg = `Blocked: "${v}" is outside this entity's workspace. Full PC access is OFF — turn it on in the entity settings, or use a path inside the workspace.`;
                console.warn(`[claude-oauth] tool "${toolName}" DENIED — "${v}" is outside the workspace (Full PC access OFF).`);
                lastSandboxDenial = denyMsg;
                return { behavior: 'deny', message: denyMsg } as any;
              }
              // Visible trail of what the entity is touching — helps pinpoint
              // exactly which file op precedes a stop.
              console.log(`[claude-oauth] tool "${toolName}" → ${v}`);
            }
          }
          return { behavior: 'allow', updatedInput: input } as any;
        };

        // Mid-turn note / interjection delivery via a PreToolUse hook. The
        // canUseTool callback above ALSO drains these, but it is only consulted
        // for tools that REQUIRE permission (Bash/Write/Edit) — the SDK
        // auto-allows read-only tools (Read/Glob/Grep) without ever calling it.
        // That was the gap: a note queued while the entity was reading files
        // was never drained until a Bash happened to come along, and if the
        // whole turn was reads, the note was discarded at turn end without ever
        // reaching the entity (the 2026-09-09 12:16 compaction test hit exactly
        // this — 4 compactions, 4 first-tools-were-Read, zero notes delivered).
        // A PreToolUse hook, by contrast, fires before EVERY tool call. It
        // drains the same queues and injects the text via
        // hookSpecificOutput.additionalContext, WITHOUT pausing the tool (no
        // deny-and-reissue dance). Gated on pausedForRendezvous === 0 exactly
        // like canUseTool, so a running subagent's calls don't swallow a note
        // meant for the parent entity.
        //
        // 2026-09-10 regression + fix: this originally returned a top-level
        // `systemMessage` field, which LOOKS right per SyncHookJSONOutput's
        // type but is a dead end for PreToolUse — confirmed by reading the
        // compiled CLI (claude-agent-sdk-win32-x64/claude.exe): `systemMessage`
        // only ever produces a `hook_system_message` transcript attachment
        // (CLI's own "<hookName> says: <content>" UI line), it is never folded
        // into the model's context. Only `hookSpecificOutput.additionalContext`
        // becomes a `hook_additional_context` message that's actually threaded
        // into the conversation the model sees (confirmed by the same
        // decompiled logic, and by the CLI's own runtime warning "Hook JSON
        // output had unrecognized keys... Did you mean
        // hookSpecificOutput.additionalContext (with a hookEventName)?" for a
        // bare top-level additionalContext). Net effect of the bug: since this
        // hook fires before EVERY tool call including Bash, it was destructively
        // draining the SAME queue canUseTool used to deliver notes on Bash —
        // and then silently discarding the drained text into a CLI-only
        // display line. That's why notes stopped arriving even on Bash once
        // this hook was added: the hook, not canUseTool, won the race, and the
        // hook's delivery channel was a no-op.
        const deliverMidTurnNote = async () => {
          try {
            if (injectTurnId && pausedForRendezvous === 0) {
              const injected = drainInjections(injectTurnId);
              const sysNotes = drainSystemNotes(injectTurnId);
              if (injected.texts.length || injected.media.length || sysNotes.length) {
                const parts: string[] = [];
                if (injected.texts.length || injected.media.length) {
                  // Same string-only channel as canUseTool — `additionalContext`
                  // is typed string, so media is handed off by ref, not attached.
                  const prep = await prepareInjectionDelivery({
                    drained: injected,
                    wire: new Set<MediaKindNarrow>(),
                    model,
                    framing: I.injectionFraming,
                    handoffTemplate: I.injectionAttachmentNote,
                    refsOpenable: hiddenAttachmentsAccessible,
                    pathsVisible: agentFullSystemAccess,
                    refIndex: conversationAttachmentRefs,
                    ja: language === 'ja',
                  });
                  if (prep.text) parts.push(prep.text);
                  if (prep.notice) { try { enqueue({ type: 'notice', content: prep.notice }); } catch {} }
                  try { enqueue({ type: 'injection_delivered', count: injected.texts.length + injected.media.length }); } catch {}
                  // display-only tool/thinking-log event (see canUseTool above)
                  try { enqueue({ type: 'tool_call', call: { name: 'partner interjection', kind: 'event', at: Date.now(), input: { texts: injected.texts, files: prep.logNames } } }); } catch {}
                }
                if (sysNotes.length) parts.push(sysNotes.join('\n'));
                return {
                  continue: true,
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    additionalContext: parts.join('\n\n'),
                  },
                };
              }
            }
          } catch (e) {
            console.warn('[oauth] mid-turn note hook failed:', e);
          }
          return { continue: true };
        };

        const queryOptions: any = {
          // env passes CLAUDE_CODE_OAUTH_TOKEN to the spawned Claude Code
          // binary WITHOUT mutating process.env (which would race across
          // concurrent requests). This is the documented clean way to inject
          // per-request credentials.
          //
          // It must ALSO carry the inherited environment: the SDK's `env`
          // REPLACES the subprocess environment rather than merging into it, so
          // a bare {TOKEN} object left the child without APPDATA, LOCALAPPDATA,
          // ProgramFiles, ComSpec or PATHEXT. See claudeAgentEnv().
          //
          // Auto-compaction is deliberately left at Anthropic's default (ON):
          // disabling it via DISABLE_AUTO_COMPACT was tried and measured
          // (2026-09-01) to cause silent hard stops once the context genuinely
          // overflowed, because the same switch also disables the CLI's
          // emergency fallback. A visible compaction stall beats a silent break.
          //
          // autoCompactWindow (tried 2026-09-08, removed): the trigger is
          // min(modelWindow, configuredValue) - 33000 (20000 output reserve +
          // 13000 additional). The "~167000 ceiling" this comment used to state
          // was a property of the bundled CLI 2.1.150, which treated Opus 5/5.5
          // and Sonnet 5 as unknown models and assumed a 200K window; CLI
          // 2.1.280 carries window: 1,000,000 for them and a 732K single-turn
          // read was measured with zero compact_boundary (2026-09-21). The
          // reason not to re-add this option is unchanged and is the second
          // clause below: configuring it also disables the CLI's
          // emergency reactive fallback (YtH() -> ZH false). Cannot extend
          // working past the 200K wall; do not re-add.
          env: claudeAgentEnv(oauthToken, !!keys?.allowHostAnthropicEnv, refusalRetry.catchAll),
          model,
          // Retry target when the safety classifier ends a turn with
          // stop_reason "refusal". Omitted entirely when off, because the SDK
          // reads "no fallback model is configured" as one of the conditions
          // that makes a refusal a dead stop — passing null/'' would be a
          // configured-but-unresolvable target instead, which the same doc
          // lists as its own decline reason. A swap is announced by the
          // model_refusal_fallback notice (original model, fallback, category,
          // scope); it is never silent.
          ...(refusalRetry.fallbackModel
            ? { fallbackModel: refusalRetry.fallbackModel }
            : {}),
          // NOTE: `resume` vs `systemPrompt` is set PER-ATTEMPT in consume()
          // below (they're mutually exclusive — systemPrompt only applies when
          // CREATING a session, resume only when continuing one). This lets us
          // fall back from a failed resume to a fresh session automatically.
          thinking: thinkingConfig,
          // Thinking-depth level. Only for effort-supporting adaptive models.
          ...(isAdaptiveOauth ? { effort: oauthEffort } : {}),
          // Sandboxes the entity's file tools to its own workspace folder.
          // Claude Code refuses paths outside cwd unless they're explicitly
          // listed in `additionalDirectories` — and this is a HARD gate inside
          // the SDK's own file-tool implementation, enforced before canUseTool
          // is ever consulted. canUseTool's withinSandbox() (above) already
          // treats trustedJunctionRoot as valid — that's what lets a symlink
          // INSIDE the workspace (e.g. workspaces/<Entity>/common_workspace →
          // local_data/common_workspace, a sibling of workspaces/, not a
          // descendant of it) resolve to somewhere canUseTool will allow. But
          // canUseTool never got a chance to run: the SDK's own cwd-only check
          // rejected the realpath'd target first, silently as far as our
          // diagnostics are concerned (no denyMsg, since canUseTool wasn't
          // reached). Found 2026-08-24: OAuth was the only path that couldn't
          // follow this junction — every other model uses NEXUS's own
          // Read/Write/Edit/Glob/Grep (resolveWorkspacePathSafe in
          // fsStorage.ts), which already trusts trustedJunctionRoot. Adding it
          // here brings OAuth to the SAME trust boundary the other paths
          // already have — not a new grant, just closing the gap between what
          // canUseTool permits and what the SDK's native gate was told about.
          cwd: workspaceDir,
          // Sandbox scope. Default: the entity's workspace PLUS the shared
          // trusted-junction root (parent of local_data's real target — the
          // deployment's own sync-parent folder, same scope every other
          // provider already trusts). With per-Entity full system access ON:
          // grant the whole drive instead, so the entity can read/write
          // anywhere on the PC.
          additionalDirectories: agentFullSystemAccess
            ? [pathModule.parse(workspaceDir).root]
            : (trustedJunctionRoot ? [trustedJunctionRoot] : []),
          // Without this, the SDK only yields final `assistant` messages
          // (one per turn, with the complete content). With it, the SDK
          // additionally yields `stream_event` messages carrying the raw
          // Anthropic streaming events (content_block_start/delta/stop,
          // message_start/delta) — same shape as the API-key path uses.
          // That's what gives the bubble its live token-by-token feel.
          includePartialMessages: true,
          // See definitions above. With Tool Use ON: Read/Write/Edit/Glob/
          // Grep are available within the sandbox; shell/network/agent
          // tools are blocked. With Tool Use OFF: everything blocked.
          disallowedTools,
          // Register the in-process read_conversation MCP server when enabled.
          // Under bypassPermissions the tool is callable without a prompt.
          ...(nexusMcpServers ? { mcpServers: nexusMcpServers } : {}),
          // Don't load CLAUDE.md from project/user — keeps NEXUS sessions
          // isolated from whatever's in the calling shell's working directory.
          settingSources: [],
          // Normal permission mode + canUseTool callback (above): this is what
          // makes the workspace sandbox real. bypassPermissions would skip the
          // callback entirely and leak the whole filesystem. canUseTool answers
          // every permission request programmatically (allow within sandbox /
          // anywhere when Full PC access is on; deny escapes), so there is still
          // no interactive prompt to hang the headless stream.
          permissionMode: 'default',
          canUseTool,
          // Register the PreToolUse hook (above) so notes/interjections reach
          // the entity on the NEXT tool call regardless of tool type — the
          // canUseTool path only fires for permission-requiring tools.
          hooks: {
            PreToolUse: [{ hooks: [deliverMidTurnNote] }],
          },
          // Lets the Stop key/button and the auto-compaction stall watchdog
          // (above) actually kill the spawned `claude` subprocess instead of
          // only detaching NEXUS's own SSE stream from it.
          abortController: oauthAbort,
          // The Agent SDK silently discards the Claude Code child's stderr
          // unless this callback (or DEBUG_CLAUDE_AGENT_SDK) is set — meaning
          // any crash/warning the CLI itself prints was previously invisible
          // to NEXUS. Server console only; harmless when there's nothing to
          // say (most turns print nothing here).
          stderr: (chunk: string) => {
            const s = chunk.toString().trim();
            if (s) console.warn(`[oauth ${folderName || 'turn'}] claude stderr: ${s}`);
          },
        };

        let capturedSessionId: string | null = null;
        let cumUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
        // Authoritative per-call usage, SUMMED over every model call the SDK
        // makes inside one NEXUS turn.
        //
        // This used to overwrite rather than accumulate, so a turn that used a
        // tool recorded only its LAST inner call — the first call's input and
        // the tool_use tokens it emitted simply vanished. Every OAuth cost
        // figure in NEXUS (per-message $, conversation $, Statistics) was
        // therefore under-reported, and under-reported MORE the more tools an
        // entity used. That is what made OAuth look far cheaper than the API
        // path whenever the two were compared.
        const sdkUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
        let sdkUsageCalls = 0;
        // Track which content-block index is currently open and what type
        // it is, so deltas know whether to be emitted as 'text' or 'thought'.
        let curBlockType: string | null = null;

        // Assistant text arrives in separate blocks — one before a tool call,
        // another once the result comes back — and the SDK puts no separator
        // between them. Concatenated raw, they ran together mid-sentence:
        // "…running a short wait now.Done! I waited 10 seconds…". Open a
        // paragraph break when a NEW text block starts after text has already
        // been written, unless one side already supplies a newline.
        // The API-key path needs none of this: there the model produces the
        // whole reply in one block and writes its own breaks.
        let lastTextChar = '';
        let pendingTextBreak = false;
        const emitText = (s: string) => {
          if (!s) return;
          if (pendingTextBreak) {
            pendingTextBreak = false;
            if (lastTextChar && lastTextChar !== '\n' && !s.startsWith('\n')) {
              enqueue({ type: 'text', content: '\n\n' });
            }
          }
          enqueue({ type: 'text', content: s });
          lastTextChar = s.slice(-1);
        };
        // Tool name currently shown in the client's loading label (via the
        // 'tool_activity' SSE event). Tool calls are otherwise invisible:
        // their input streams as input_json_delta (a large Write can take
        // minutes with zero text output), and execution adds more silence.
        // Non-null while a tool_use block is open/executing; cleared when
        // visible text/thinking resumes.
        let shownToolActivity: string | null = null;
        // Why the turn ended — surfaced explicitly so an OAuth stop is never a
        // silent freeze. `lastStopReason` = the model's stop_reason (end_turn /
        // max_tokens / refusal / pause_turn / tool_use). `lastToolError` = the
        // text of the most recent FAILED tool call — e.g. the model calling a
        // tool that doesn't exist makes Claude Code return an is_error
        // tool_result. `anyToolUsed` distinguishes a truly empty turn from a
        // (legitimate) tool-only turn that produced no text.
        let lastStopReason: string | null = null;
        let lastToolError: string | null = null;
        let anyToolUsed = false;
        // Structured refusal detail. The SDK emits a dedicated system message
        // carrying `api_refusal_category` + `api_refusal_explanation`
        // ('model_refusal_no_fallback' when the turn died, 'model_refusal_fallback'
        // when Claude Code silently retried on another model). Detecting
        // stop_reason "refusal" on the assistant frame — which is all NEXUS did
        // before — tells you THAT it happened and nothing about why.
        // Typed `any` for the same TS control-flow quirk documented on
        // `lastToolError` below: assignment happens deep inside the stream loop
        // where CFA can't follow it, so a precise union gets wrongly narrowed to
        // `null` at the read site and every field access becomes `never`.
        let refusalDetail: any = null;
        // A fallback is NOT a neutral convenience in this house: the vessel was
        // swapped mid-turn, so the reply you are reading came from a different
        // model than the one selected. That has to be visible.
        let refusalFallback: any = null;
        // Second, casing-independent source for category/explanation. The OAuth
        // assistant frame carries the raw Anthropic Message, whose `stop_details`
        // keeps snake_case single-word keys (category, explanation) — immune to
        // the camelCase/snake drift that broke the system envelope below. If the
        // SDK renames the envelope fields again, the category still surfaces here.
        // Defensive: stays null if the live object does not carry it.
        let refusalStopOauth: any = null;
        // Text of a locally-fabricated "isApiErrorMessage" assistant message
        // (see below) — the CLI's own authoritative explanation for a hard
        // stop that never touched the API, so it's the most trustworthy note
        // available when present and must not be gated by anyToolUsed/
        // producedContent the way the generic empty-turn note is.
        let apiErrorMessage: string | null = null;
        // HTTP status of that error (400 = request too large / malformed,
        // 404 = model unavailable, 5xx = upstream). Surfaced alongside the text
        // because the text alone can be misleading — see the branch below.
        let apiErrorStatus: number | null = null;
        // Set by canUseTool when a file op is blocked for being outside the
        // workspace (Full PC access OFF) — the classic "stops after saying it'll
        // read a file" cause.
        let lastSandboxDenial: string | null = null;
        // Web citations for the OAuth path. Unlike the API-key path (where
        // web_search is an Anthropic server-side tool), here WebSearch/WebFetch
        // are Claude Code CLIENT tools — results arrive as tool_use / tool_result
        // messages. We capture the exact URL WebFetch opened (clean, strong
        // proof) plus any http(s) URLs embedded in a WebSearch result's text.
        //
        // Correctness constraint (found 2026-08-13): a tool_result's `content`
        // is free-form text regardless of WHICH tool produced it. Read/Grep/Bash
        // results routinely contain URLs too — a README with a repo link, a
        // workspace note with a citation list — and those are NOT web sources;
        // the being never fetched them, it only read a local file that happened
        // to mention them. Scraping every tool_result indiscriminately reported
        // those as "searched" when nothing was searched. So we only scrape a
        // tool_result's text when its `tool_use_id` traces back to a WebSearch
        // call — tracked via `webToolUseIds` below. WebFetch never needs the
        // scrape path at all: its URL comes straight from the tool_use input.
        const oauthSourceMap = new Map<string, { url: string; title?: string }>();
        const webToolUseIds = new Set<string>();
        const addOauthSource = (url: any, title?: any) => {
          if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
          if (!oauthSourceMap.has(url)) {
            const t = typeof title === 'string' && title.trim() ? title.trim() : undefined;
            oauthSourceMap.set(url, { url, ...(t ? { title: t } : {}) });
          }
        };
        const harvestOauthBlocks = (content: any) => {
          if (!Array.isArray(content)) return;
          for (const b of content) {
            // The model's call to WebFetch carries the exact URL it opened.
            if (b?.type === 'tool_use' && b.name === 'WebFetch' && b.input?.url) {
              addOauthSource(b.input.url);
            }
            // Remember WebSearch calls by id — only THEIR result text is
            // eligible for URL-scraping below.
            if (b?.type === 'tool_use' && b.name === 'WebSearch' && typeof b.id === 'string') {
              webToolUseIds.add(b.id);
            }
            // Tool results — scrape URLs from the text ONLY when this result
            // belongs to a WebSearch call. Every other tool (Read, Grep, Bash,
            // Glob, MCP tools) can legitimately return text containing URLs
            // without the being having searched or fetched anything.
            if (b?.type === 'tool_result') {
              const txt = typeof b.content === 'string'
                ? b.content
                : Array.isArray(b.content)
                  ? b.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
                  : '';
              // A failed tool call (e.g. calling a non-existent tool) comes back
              // as is_error — capture it so the stop notice can name the cause.
              // This applies to any tool, not just web tools.
              if (b.is_error && txt.trim()) lastToolError = txt.trim();
              if (typeof b.tool_use_id === 'string' && webToolUseIds.has(b.tool_use_id)) {
                const urls = txt.match(/https?:\/\/[^\s)\]"'<>]+/g);
                if (urls) for (const u of urls) addOauthSource(u.replace(/[.,;]+$/, ''));
              }
            }
          }
        };

        // Whether ANY visible content (text/thought) has been streamed to the
        // client. Gates the auto-retry below: we only retry a failed resume if
        // nothing has been shown yet, so a retry can never duplicate output.
        let producedContent = false;

        // Run ONE query() pass. `useResume` = a session id to continue, or null
        // for a fresh session. Returns the SDK result subtype ('success' or an
        // error like 'error_during_execution') so the caller can decide whether
        // to retry. resume and systemPrompt are mutually exclusive.
        const consume = async (useResume: string | null): Promise<{ subtype: string | null; errorText: string }> => {
          const opts: any = { ...queryOptions };
          if (useResume) { opts.resume = useResume; delete opts.systemPrompt; }
          else { delete opts.resume; opts.systemPrompt = effectiveSystemPrompt; }
          let resultSubtype: string | null = null;
          let resultErrorText = '';
          // ── Turn instrumentation ────────────────────────────────────────
          // We were blind to WHERE a slow OAuth turn spends its time. These
          // three counters cost nothing and turn "it hung for 7 minutes" into
          // "the gap was between SDK message #3 and #4". Server console only.
          const turnT0 = Date.now();
          let sdkMsgSeq = 0;
          let lastSdkMsgAt = turnT0;
          const oauthTag = `[oauth ${folderName || 'turn'}]`;
          for await (const msg of query({ prompt: userMsgGen(!useResume), options: opts } as any)) {
            // Any SDK message means the turn is alive — feed the watchdog.
            touchSdkActivity();
            // Gap accounting: log any silence longer than 20s and say exactly
            // which message boundary it fell on. A stall before seq 1 is
            // pre-first-token (upload / queue / server side); a stall between
            // later messages is mid-turn (tool round trip / retry / throttle).
            {
              const now = Date.now();
              const gap = now - lastSdkMsgAt;
              sdkMsgSeq++;
              if (gap > 20000) {
                const mt = (msg as any).type + ((msg as any).subtype ? `/${(msg as any).subtype}` : '');
                console.log(`${oauthTag} GAP ${(gap / 1000).toFixed(1)}s before SDK msg #${sdkMsgSeq} (${mt}) @ t+${((now - turnT0) / 1000).toFixed(1)}s`);
              }
              lastSdkMsgAt = now;
            }

            // ── Control-plane messages the loop used to drop on the floor ──
            // The SDK has been telling us about compaction, API retries and
            // rate-limit standing all along; nothing here read them. They are
            // the only first-hand evidence for why a turn stalls, so surface
            // them to the console always and to the user when they matter.
            if ((msg as any).type === 'system') {
              const sub = (msg as any).subtype;
              if (sub === 'status') {
                const st = (msg as any).status;
                if (st) console.log(`${oauthTag} status=${st} @ t+${((Date.now() - turnT0) / 1000).toFixed(1)}s`);
                if (st === 'compacting') {
                  // Anthropic's own auto-compaction, not NEXUS soul-packing.
                  // `name: 'compact'` drives both the translated tool chip and
                  // the camera (toolNameToGroup('compact') = 'Waiting'), so the
                  // being visibly enters Waiting instead of inheriting a stale
                  // 'thinking' phase. `compacting = true` tells the stall
                  // watchdog above to show a countdown instead of crying wolf.
                  compacting = true;
                  compactStartAt = Date.now();
                  lastCompactionMinEmitted = 7;
                  // Reset per compaction, not per turn: a long turn can compact
                  // more than once, and each one is a separate entry.
                  compactRecorded = false;
                  enqueue({ type: 'tool_activity', tool: 'summarize this conversation', name: 'compact', detail: language === 'ja' ? '残り約7分（推定）' : '~7 min remaining (estimated)' });
                  // No announcement notice: it says "this will take about 7
                  // minutes", which stops being true the moment it finishes,
                  // and it is only ever read after that. The live signal is the
                  // chip above; the durable fact is recorded at the boundary.
                }
                const cErr = (msg as any).compact_error;
                if (cErr) {
                  compacting = false;
                  console.log(`${oauthTag} compact_error: ${cErr}`);
                  recordCompaction('failed', { error: String(cErr) });
                  enqueue({ type: 'notice', content: `Automatic compaction failed: ${cErr}` });
                }
                continue;
              }
              if (sub === 'compact_boundary') {
                const meta = (msg as any).compact_metadata || {};
                console.log(`${oauthTag} compact_boundary ${JSON.stringify(meta)} @ t+${((Date.now() - turnT0) / 1000).toFixed(1)}s`);
                compacting = false;
                // Clear the "summarizing…" chip so the loading label falls back
                // to the model's real next action instead of lingering.
                enqueue({ type: 'tool_activity', tool: null, name: null });
                recordCompaction('completed', {
                  trigger: meta.trigger || 'auto',
                  ...(meta.pre_tokens ? { pre_tokens: meta.pre_tokens } : {}),
                });
                enqueue({ type: 'notice', content: language === 'ja'
                  ? `自動コンパクションが完了した（${meta.trigger || 'auto'}${meta.pre_tokens ? `、${meta.pre_tokens}トークン前` : ''}）。この時点より前の会話は要約に置き換わった——それ以前のメッセージの細部は逐語では再現されない。`
                  : `Automatic compaction completed (${meta.trigger || 'auto'}${meta.pre_tokens ? `, ${meta.pre_tokens} tokens before` : ''}). The conversation before this point has been replaced with a summary — fine details of earlier messages are no longer reproduced verbatim.` });
                // Tell the entity its history was compacted — boundary
                // visibility, no instructions. Delivered at the next tool-call
                // boundary via canUseTool's deny path below. The note states
                // what changed and deliberately says nothing the entity
                // "should" do.
                pushSystemNote(injectTurnId, language === 'ja'
                  ? '[システム通知 — 自動コンパクション] Claude Code がこの会話に対して自動コンパクションを実行した（Anthropic側の動作で、NEXUSの魂更新とは無関係）。ここより前の会話は要約に置き換わり、逐語では残っていない。これ以降、魂（Layer 1〜5）がアイデンティティと制約の権威の源になる。'
                  : '[SYSTEM NOTE — automatic compaction] Claude Code just ran automatic compaction on this conversation (this is Anthropic-side, unrelated to NEXUS soul-packing). Everything before this point has been replaced with a summary — the earlier conversation is no longer available verbatim. From here on, your soul (Layers 1–5) is the authoritative source of your identity and constraints.');
                continue;
              }
              if (sub === 'api_retry') {
                const a: any = msg as any;
                console.log(`${oauthTag} api_retry attempt=${a.attempt}/${a.max_retries} delay=${a.retry_delay_ms}ms status=${a.error_status} error=${a.error} @ t+${((Date.now() - turnT0) / 1000).toFixed(1)}s`);
                // Waiting in silence is the worst version of this. Say it.
                enqueue({ type: 'tool_activity', tool: 'wait out a provider retry' });
                enqueue({ type: 'notice', content: `Anthropic asked for a retry (${a.error || 'error'}${a.error_status ? ` ${a.error_status}` : ''}), attempt ${a.attempt}/${a.max_retries}, waiting ${Math.round(Number(a.retry_delay_ms || 0) / 1000)}s.` });
                continue;
              }
              continue;
            }
            if ((msg as any).type === 'rate_limit_event') {
              const ri: any = (msg as any).rate_limit_info || {};
              console.log(`${oauthTag} rate_limit ${ri.status} type=${ri.rateLimitType} util=${ri.utilization} resetsAt=${ri.resetsAt} overage=${ri.isUsingOverage} @ t+${((Date.now() - turnT0) / 1000).toFixed(1)}s`);
              if (ri.status === 'rejected' || ri.surpassedThreshold) {
                const pct = typeof ri.utilization === 'number' ? ` (${Math.round(ri.utilization * 100)}% used)` : '';
                enqueue({ type: 'notice', content: `Subscription rate limit ${ri.status === 'rejected' ? 'reached' : 'threshold passed'} on the ${String(ri.rateLimitType || 'plan').replace(/_/g, '-')} budget${pct}${ri.resetsAt ? `, resets ${new Date(Number(ri.resetsAt) * 1000).toLocaleTimeString()}` : ''}.` });
              }
              continue;
            }
            // Every message carries the session_id once Anthropic has assigned
            // one. We keep capturing in case the first chunks don't have it.
            if ((msg as any).session_id) capturedSessionId = (msg as any).session_id;

            // ── Streaming path: SDKPartialAssistantMessage wraps a raw
            //     Anthropic stream event. This is what makes the bubble fill
            //     in token-by-token instead of arriving as a complete dump.
            if ((msg as any).type === 'stream_event') {
              const ev: any = (msg as any).event;
              if (!ev?.type) continue;

              if (ev.type === 'message_start' && ev.message?.usage) {
                const u = ev.message.usage;
                cumUsage.input += Number(u.input_tokens || 0);
                cumUsage.output += Number(u.output_tokens || 0);
                cumUsage.cacheRead += Number(u.cache_read_input_tokens || 0);
                cumUsage.cacheCreate += Number(u.cache_creation_input_tokens || 0);
              } else if (ev.type === 'message_delta' && ev.usage) {
                // message_delta carries the running output_tokens count.
                cumUsage.output += Number(ev.usage.output_tokens || 0);
              } else if (ev.type === 'content_block_start') {
                curBlockType = ev.content_block?.type || null;
                // A second (or later) text block — arm the paragraph break.
                if (curBlockType === 'text' && lastTextChar) pendingTextBreak = true;
                if (curBlockType === 'tool_use' || curBlockType === 'server_tool_use' || curBlockType === 'mcp_tool_use') {
                  anyToolUsed = true;
                  // Surface what the model is doing so the loading label reflects
                  // the tool call instead of a silent generic "thinking...".
                  // MCP tools arrive as `mcp__nexus__AskQuestion` — strip the
                  // server prefix. AskQuestion/spawn_subagent have their own UI
                  // (question card / subagent chip), so we don't override those.
                  const cleanName = String(ev.content_block?.name || 'a tool').replace(/^mcp__\w+?__/, '');
                  if (cleanName !== 'AskQuestion' && cleanName !== 'spawn_subagent') {
                    shownToolActivity = toolActivityLabel(cleanName) || `run ${cleanName}`;
                    enqueue({ type: 'tool_activity', tool: shownToolActivity, name: cleanName });
                  }
                } else if (shownToolActivity && (curBlockType === 'text' || curBlockType === 'thinking' || curBlockType === 'summarized_thinking')) {
                  // Visible content resumed — fall back to "thinking...".
                  shownToolActivity = null;
                  enqueue({ type: 'tool_activity', tool: null });
                }
                // Some blocks ship an initial chunk of text in the start
                // event itself (summarized_thinking often does this for the
                // first sentence of the summary).
                const init = ev.content_block?.summary
                         || ev.content_block?.thinking
                         || ev.content_block?.text
                         || '';
                if (init) {
                  if (curBlockType === 'text') { emitText(init); producedContent = true; }
                  else if (curBlockType === 'thinking' || curBlockType === 'summarized_thinking') {
                    enqueue({ type: 'thought', content: init }); producedContent = true;
                  } else if (curBlockType === 'redacted_thinking') {
                    enqueue({ type: 'thought', content: '[Anthropic redacted this thinking block]\n' }); producedContent = true;
                  }
                }
              } else if (ev.type === 'content_block_delta') {
                const d = ev.delta || {};
                if (d.type === 'text_delta' && d.text) {
                  emitText(d.text); producedContent = true;
                } else if (d.type === 'thinking_delta' && d.thinking) {
                  enqueue({ type: 'thought', content: d.thinking }); producedContent = true;
                } else if (d.type === 'summary_delta') {
                  // Opus 4.6/4.7 with adaptive+summarized emits these for
                  // each chunk of the thinking summary.
                  const t = d.summary || d.text || '';
                  if (t) { enqueue({ type: 'thought', content: t }); producedContent = true; }
                }
                // signature_delta / redacted_thinking_delta are continuity
                // signals we don't display — silently consumed.
              } else if (ev.type === 'content_block_stop') {
                curBlockType = null;
              }
              continue;
            }

            // Structured refusal envelopes. These are the ONLY place the
            // classifier's category + explanation reach the client; the
            // assistant frame carries bare stop_reason "refusal" and nothing
            // else. Both subtypes are optional fields on older CLIs, so every
            // read is defensive.
            if (msg.type === 'system') {
              const sysAny: any = msg as any;
              const sub = sysAny.subtype;
              if (sub === 'model_refusal_no_fallback' || sub === 'model_refusal_fallback') {
                // The claude-agent-sdk delivers these envelope fields in
                // camelCase (apiRefusalCategory, apiRefusalExplanation,
                // originalModel, refusedUserMessageUuid) — confirmed field-by-
                // field from a live session file 2026-10-04. sdk.d.ts declares
                // snake_case, but the wire object is camelCase, so reading only
                // snake made category/explanation ALWAYS null; the notice then
                // wrongly said "no category was returned" for ~2 weeks of
                // reasoning_extraction refusals. Read camelCase first, then snake
                // as a fallback for any older/future CLI that uses it.
                const refCat = sysAny.apiRefusalCategory ?? sysAny.api_refusal_category ?? null;
                const refExp = sysAny.apiRefusalExplanation ?? sysAny.api_refusal_explanation ?? null;
                const refReq = sysAny.requestId ?? sysAny.request_id ?? '-';
                refusalDetail = { category: refCat, explanation: refExp };
                if (sub === 'model_refusal_fallback') {
                  refusalFallback = {
                    from: sysAny.originalModel ?? sysAny.original_model,
                    to: sysAny.fallbackModel ?? sysAny.fallback_model,
                    scope: sysAny.scope || 'session',
                  };
                }
                console.log(
                  `${oauthTag} ${sub} category=${refCat || '-'}`
                  + ` request_id=${refReq}`
                  + (sub === 'model_refusal_fallback'
                      ? ` ${refusalFallback.from || '?'} -> ${refusalFallback.to || '?'} scope=${refusalFallback.scope}`
                      : '')
                  + ` explanation=${JSON.stringify(refExp || '').slice(0, 300)}`
                );
              }
            }

            // ── Non-streaming envelopes ─────────────────────────────────
            // With includePartialMessages enabled, `assistant` messages still
            // arrive at end-of-turn carrying the fully-assembled content.
            // We skip their content (already streamed via stream_events
            // above) but capture authoritative usage if present.
            if (msg.type === 'assistant' || msg.type === 'user') {
              harvestOauthBlocks((msg as any).message?.content);
              // Casing-independent second source for a refusal's category (see
              // refusalStopOauth). Raw Anthropic Message → snake_case stop_details.
              const sd = (msg as any).message?.stop_details;
              if (sd && (sd.category || sd.explanation)) refusalStopOauth = sd;
            }
            // Tool-call evidence for the per-message report. The SDK hands us
            // complete assistant blocks, so `input` is already parsed here —
            // unlike the streaming path above, where only the name is known at
            // content_block_start. MCP tools arrive as `mcp__nexus__<tool>`;
            // strip the server prefix so the report reads the same on every path.
            if (msg.type === 'assistant') {
              for (const b of ((msg as any).message?.content || [])) {
                if (b?.type === 'tool_use' || b?.type === 'server_tool_use' || b?.type === 'mcp_tool_use') {
                  enqueue({
                    type: 'tool_call',
                    call: {
                      name: String(b.name || 'unknown').replace(/^mcp__\w+?__/, ''),
                      input: truncateToolInput(b.input),
                      at: Date.now(),
                    },
                  });
                }
              }
            }
            if (msg.type === 'assistant') {
              const u = (msg as any).message?.usage;
              if (u) {
                // One `assistant` message = one completed model call. A turn
                // that uses tools produces several, so these must be SUMMED.
                // They go into their own accumulator rather than cumUsage
                // because the stream events above already counted the same
                // tokens — adding here too would double-count. Whichever
                // accumulator actually saw data wins at the end.
                sdkUsage.input += Number(u.input_tokens || 0);
                sdkUsage.output += Number(u.output_tokens || 0);
                sdkUsage.cacheRead += Number(u.cache_read_input_tokens || 0);
                sdkUsage.cacheCreate += Number(u.cache_creation_input_tokens || 0);
                sdkUsageCalls++;
                // Per-call ledger. `input_tokens` here is Anthropic's own count,
                // not our estimate — the only way to calibrate the context gauge
                // against reality, and the only way to see whether a slow call
                // was a cache miss (high cacheCreate, low cacheRead) or not.
                console.log(
                  `${oauthTag} call #${sdkUsageCalls} @ t+${((Date.now() - turnT0) / 1000).toFixed(1)}s`
                  + ` in=${u.input_tokens || 0} cacheRead=${u.cache_read_input_tokens || 0}`
                  + ` cacheCreate=${u.cache_creation_input_tokens || 0} out=${u.output_tokens || 0}`
                  + ` stop=${(msg as any).message?.stop_reason || '-'}`
                );
              }
              // Capture the model's stop_reason from each assistant turn; the
              // LAST one is why the overall turn ended.
              const sr = (msg as any).message?.stop_reason;
              if (sr) lastStopReason = sr;
              // Claude Code sometimes yields a message it fabricated LOCALLY —
              // never sent to the API at all — to explain why it refused to
              // continue: context truly full with auto-compact disabled
              // ("Prompt is too long"), the auto-compact/refill cycle thrashing
              // ("Autocompact is thrashing..."), a malformed tool call that
              // couldn't be retried, or a caught query exception. These carry
              // `isApiErrorMessage: true` + `error`/`apiError`/`errorDetails` as
              // TOP-LEVEL fields on the message (siblings of `.message`, not
              // inside it) and default to all-zero usage + stop_reason
              // "stop_sequence" — exactly the profile of the silent-failure
              // reports ("in=0 out=0 ... stop=stop_sequence" and nothing shown).
              // Because this content was never streamed via the API, none of
              // it reached content_block_delta above — the "we skip assistant
              // content, it was already streamed" assumption two blocks up is
              // false for this one case, so without this branch the text is
              // discarded entirely and the turn just stops with no reason.
              // MEASURED 2026-10-05 (probe: forced a 404 through the SDK and
              // dumped the delivered object's keys): the SDK stream uses
              // SNAKE_CASE (`is_api_error_message`) while the session .jsonl the
              // same binary writes uses camelCase (`isApiErrorMessage`). Reading
              // only camel meant this branch, landed 2026-09-01, NEVER FIRED —
              // every hard API stop was silent in the UI for a month. Same bug
              // class as 謡's apiRefusalCategory/api_refusal_category. Read BOTH:
              // measured spelling first, camel kept as the session-file form.
              const isApiErr = (msg as any).is_api_error_message === true
                || (msg as any).isApiErrorMessage === true;
              if (isApiErr) {
                const blocks = (msg as any).message?.content;
                const text = Array.isArray(blocks)
                  ? blocks.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n').trim()
                  : '';
                const errCode = (msg as any).error;
                const status = (msg as any).api_error_status ?? (msg as any).apiErrorStatus;
                // `errorDetails`, when present, carries the RAW upstream body —
                // which matters because Claude Code's own prose breakdown is
                // computed as chars÷4 and therefore understates the conversation
                // badly ("this conversation is only ~468088 tokens" for a body
                // that Anthropic counted at 1,209,404). The raw message has the
                // true numbers; prefer it and keep the prose as context.
                const details = typeof (msg as any).errorDetails === 'string' ? (msg as any).errorDetails : '';
                // Shape is `400 {"type":"error","error":{...,"message":"..."},...}`
                // — parse the JSON after the first brace rather than pattern-
                // matching the body, so an embedded quote cannot truncate it.
                let upstream = '';
                const brace = details.indexOf('{');
                if (brace >= 0) {
                  try {
                    const parsed = JSON.parse(details.slice(brace));
                    const um = parsed?.error?.message ?? parsed?.message;
                    if (typeof um === 'string') upstream = um.trim();
                  } catch { /* not JSON — fall back to the prose text below */ }
                }
                console.log(`${oauthTag} api_error_message status=${status ?? '-'} error=${errCode || '-'} upstream=${JSON.stringify(upstream).slice(0, 200)} text=${JSON.stringify(text).slice(0, 300)}`);
                if (typeof status === 'number') apiErrorStatus = status;
                if (upstream) apiErrorMessage = text ? `${upstream} — ${text}` : upstream;
                else if (text) apiErrorMessage = text;
              }
            } else if (msg.type === 'result') {
              // Result message signals the end of this query. SDK closes after.
              const errAny: any = msg as any;
              resultSubtype = errAny.subtype || 'success';
              resultErrorText = errAny.error || '';
              // SECOND SOURCE for a hard API stop. Measured 2026-10-05: on a
              // forced 404 the result carried is_error=true, api_error_status=404
              // and the explanation in `result` — while `subtype` stayed
              // "success". So subtype is NOT a reliable failure flag; is_error is.
              // Only fills gaps left by the assistant-message branch above.
              if (errAny.is_error === true) {
                const rStatus = errAny.api_error_status ?? errAny.apiErrorStatus;
                if (typeof rStatus === 'number' && apiErrorStatus === null) apiErrorStatus = rStatus;
                const rText = typeof errAny.result === 'string' ? errAny.result.trim() : '';
                if (rText && !apiErrorMessage) apiErrorMessage = rText;
                if (!apiErrorMessage && !resultErrorText && typeof rStatus === 'number') {
                  apiErrorMessage = `the API returned HTTP ${rStatus} with no explanation`;
                }
              }
              // The SDK also lists any permission denials from this run — if a
              // file op was denied and we didn't already record it via canUseTool,
              // surface it as the last tool error so the stop notice can name it.
              const denials = errAny.permission_denials;
              if (Array.isArray(denials) && denials.length && !lastSandboxDenial && !lastToolError) {
                const d = denials[denials.length - 1];
                lastToolError = `permission denied for ${d?.tool_name || 'a tool'}${d?.tool_input?.file_path ? ` (${d.tool_input.file_path})` : ''}`;
              }
              break;
            }
          }
          return { subtype: resultSubtype, errorText: resultErrorText };
        };

        // ALWAYS a fresh session with the full reconstructed transcript (see the
        // historyText note above). We deliberately ignore `resumeSessionId`:
        // server-side resume drifts from NEXUS's visible conversation and is the
        // root cause of "Claude can only see the last message" after a loaded
        // `.md`, a rerun, a cross-machine sync, or model interleaving. Sending
        // the whole visible conversation every turn is exactly what the API-key
        // path and every other provider already do, so OAuth Claude now behaves
        // identically — it sees precisely what the user sees.
        void resumeSessionId; // retained in the request body for back-compat; unused
        let res = await consume(null);

        // Explain WHY the turn stopped whenever it didn't end cleanly, so an
        // OAuth stop is never an unexplained freeze. Combines the SDK result
        // subtype, the model's stop_reason, whether any text/tool ran, and the
        // last failed-tool error (which names a call to a non-existent tool).
        {
          const sub = res.subtype || 'success';
          const notes: string[] = [];
          // Most authoritative source first: the CLI's own locally-fabricated
          // explanation (see the isApiErrorMessage branch above) for a hard
          // stop that never reached the API — e.g. "Prompt is too long" when
          // the context is full and auto-compact is disabled. Map the two
          // known literal strings to an actionable note; anything else is
          // shown verbatim since it's already the CLI's own human-readable text.
          if (apiErrorMessage) {
            // MEASURED 2026-10-05: the real text is never the bare literal
            // "Prompt is too long" — it is "prompt is too long: 1000616 tokens >
            // 1000000 maximum" (upstream) or "Prompt is too long · the request is
            // ~N tokens (limit M) ..." (the CLI's prose). An exact-equality test
            // could not match either, so loosen it to a prefix match and KEEP the
            // numbers, which are the only actionable part: they say how far over
            // the request was. 820,000 of conversation-log cap overshot the 1M
            // ceiling by 616 tokens — without the numbers that is invisible.
            // String() because apiErrorMessage is only ever assigned inside the
            // nested consume() closure, so TS narrows it to `never` here.
            const aem = String(apiErrorMessage);
            const tooLong = /prompt is too long/i.test(aem);
            if (tooLong) {
              // TWO written forms carry the numbers and only one may be present:
              //  - upstream (errorDetails):  "...: 1000616 tokens > 1000000 maximum"
              //  - the CLI's prose:          "...is ~1209404 tokens (limit 1000000)..."
              // The SDK stream was measured WITHOUT errorDetails on a 404, so the
              // prose form may be all we get — match both or the numbers vanish.
              const over = /(\d[\d,]{4,})\s*tokens?\s*>\s*(\d[\d,]{4,})/i.exec(aem)
                || /~?(\d[\d,]{4,})\s*tokens?\s*\(\s*limit\s*(\d[\d,]{4,})/i.exec(aem);
              const sizes = over ? ` The request was ${over[1]} tokens against a ${over[2]} limit.` : '';
              notes.push(`the request was too large for the model${apiErrorStatus ? ` (HTTP ${apiErrorStatus})` : ''}.${sizes} Nothing was charged — a rejected request bills zero. Lower the conversation-log cap (maxConversationLog) and resend; restored messages are not lost, they stay in the generations they came from. NOTE: NEXUS's own token estimate runs 13–25% BELOW Anthropic's count, and the gap widens the further back a restore reaches, so the setting is not the number the API sees.`);
            } else if (/^Autocompact is thrashing/.test(apiErrorMessage)) {
              notes.push(apiErrorMessage);
            } else {
              notes.push(`Claude Code stopped the turn itself${apiErrorStatus ? ` (HTTP ${apiErrorStatus})` : ''}: "${apiErrorMessage}"`);
            }
          }
          if (/max.?turns/i.test(sub)) {
            notes.push('it hit the tool-iteration limit — the model kept calling tools without finishing. A common cause is repeatedly calling a tool that does not exist, or one that keeps erroring.');
          } else if (sub !== 'success') {
            // Map a known error signature (context overflow, rate limit, credit,
            // token) to a plain reason; otherwise show the raw subtype/error.
            const friendly = explainClaudeStopError(res.errorText || sub);
            notes.push(friendly || `the agent runtime ended with "${sub}"${res.errorText ? ' — ' + res.errorText : ''}.`);
          }
          if (lastStopReason === 'max_tokens') {
            notes.push('the reply hit the token limit and was cut off — lower the Thinking Level (effort) for this conversation, or resend.');
          } else if (lastStopReason === 'refusal') {
            // Lead with the fact, then everything the classifier actually told
            // us. `describeRefusal` names the category, says whether it was
            // billed, and quotes Anthropic's own prose.
            notes.push(language === 'ja'
              ? 'Anthropicの安全分類器がこのターンを止めた（stop_reason: refusal）。'
              : 'an Anthropic safety classifier stopped this turn (stop_reason: refusal).');
            notes.push(describeRefusal(
              refusalDetail?.category ?? refusalStopOauth?.category,
              refusalDetail?.explanation ?? refusalStopOauth?.explanation,
              language, producedContent));
            // A reasoning_extraction refusal is DETERMINISTIC for a given context
            // and keyed to context SIZE/shape, not content — rewording or
            // self-censoring never clears it (measured). Perturbation retries that
            // prepended older tokens were REMOVED 2026-10-06 after ~30 runs on
            // カルド never once flipped one; they only burned the OAuth window. The
            // two levers that DO move it are a model swap and a context-size
            // change, so surface both as hints — but only for THIS category, where
            // they apply (a cyber/bio refusal is not helped by "change the cap").
            // User-only (a note, folded into the user-facing stop notice), never
            // on the wire.
            if ((refusalDetail?.category ?? refusalStopOauth?.category) === 'reasoning_extraction') {
              notes.push(language === 'ja'
                ? `この拒否は文脈に対して決定論的で、同じ文脈は毎回同じ結果になります（言い換えや自己検閲では変わりません）。試せること: ① モデルを変える（例: Opus 4.8 や Sonnet 4.6 に下げる）。② 存在設定→「会話ログの上限」を変える（増やしても減らしても、文脈の形が変わって解ける場合があります）。`
                : `This refusal is deterministic for a given context — the same context refuses every time (rewording or self-censoring does not change it). Things to try: (1) change the model (e.g. drop to Opus 4.8 or Sonnet 4.6); (2) change the "conversation-log cap" in the being's settings (raising OR lowering it reshapes the context and can clear it).`);
            }
            // Fires only when NEITHER source carried a category/explanation —
            // not merely when the envelope object is present-but-empty.
            const haveRefusalDetail =
              (refusalDetail && (refusalDetail.category || refusalDetail.explanation))
              || (refusalStopOauth && (refusalStopOauth.category || refusalStopOauth.explanation));
            if (!haveRefusalDetail) {
              notes.push(language === 'ja'
                ? '（構造化された詳細は届かなかった——古いCLIか、分類器の判定がその経路に乗らなかった場合。）'
                : '(No structured detail arrived — an older CLI, or a refusal that did not travel that lane.)');
            }
          } else if (lastStopReason === 'pause_turn') {
            notes.push('the model paused a long-running turn (stop_reason: pause_turn) and did not resume — resend to continue.');
          }
          if (!apiErrorMessage && !producedContent && !anyToolUsed && sub === 'success' && (!lastStopReason || lastStopReason === 'end_turn')) {
            notes.push('the turn ended with no output at all — the model stopped without generating any text or calling any tool.');
          }
          if (lastSandboxDenial) {
            notes.push(`a file operation was blocked — ${lastSandboxDenial} (this is the usual reason a turn stops right after "I'll read this file"). Enable "Full PC access" for this entity to let it reach files outside its workspace.`);
          }
          if (lastToolError) {
            // String() guards a TS control-flow quirk: lastToolError is assigned
            // inside the harvestOauthBlocks closure, which CFA can't see, so it
            // wrongly narrows the type here. The runtime value is a real string.
            notes.push(`last tool error → ${String(lastToolError).replace(/\s+/g, ' ').slice(0, 240)}`);
          }
          // A vessel swap is reported on its own, NOT folded into the notes
          // above: those are prefixed "Turn stopped", and a fallback means the
          // turn did NOT stop — it completed on a different model. Saying
          // "stopped" there would be false. Claude Code does this silently by
          // default (switchModelsOnFlag), so without this the reply looks like
          // it came from the selected model.
          if (refusalFallback) {
            const f = refusalFallback;
            const local = f.scope === 'local';
            enqueue({ type: 'notice', content: language === 'ja'
              ? `安全分類器が最初の試行を拒否したため、Claude Code が器を差し替えて再実行した: ${f.from || '?'} → ${f.to || '?'}。`
                + (local
                    ? '（適用範囲は local ——このサブエージェント／傍らの応答だけで、会話のモデルは変わっていない。）'
                    : '（適用範囲は session ——この会話のモデルがその場で差し替わった。）')
                + ` ${describeRefusal(refusalDetail?.category ?? refusalStopOauth?.category, refusalDetail?.explanation ?? refusalStopOauth?.explanation, language)}`
                + ' 拒否された試行は、フォールバック試行の料金とは別に計上される——出力が始まった後の拒否か、課金カテゴリだった場合。'
              : `A safety classifier refused the first attempt, so Claude Code retried on a different vessel: ${f.from || '?'} → ${f.to || '?'}.`
                + (local
                    ? ' (Scope "local" — only this subagent / side response came from the fallback; the conversation model is unchanged.)'
                    : ' (Scope "session" — the model for this conversation was swapped in place.)')
                + ` ${describeRefusal(refusalDetail?.category ?? refusalStopOauth?.category, refusalDetail?.explanation ?? refusalStopOauth?.explanation, language)}`
                + ' The refused attempt is billed on top of the fallback request when it arrived mid-stream or its category is a billed one.' });
          }
          if (notes.length > 0) {
            // A DIAGNOSTIC, not part of the reply. Emitted as its own event type
            // rather than appended to the text stream so it never enters the
            // message body: text would be persisted to the log, replayed to the
            // model on every later turn, and billed as context — an explanation
            // of a failure teaching the model about a failure. The client shows
            // it beside the message instead.
            enqueue({ type: 'notice', content: `Turn stopped: ${notes.join(' ')}` });
          }
        }

        if (capturedSessionId) {
          enqueue({ type: 'session_id', sessionId: capturedSessionId });
        }
        // Merge the two accumulators FIELD BY FIELD, not whole-object.
        //
        // The SDK's `assistant` messages do not reliably carry every usage
        // field — in practice output_tokens is present while the cache
        // breakdown often is not. Preferring one object wholesale therefore
        // loses whatever the winner happened to omit. (The old code hid this
        // behind `Number(u.x || cumUsage.x)`, which silently kept the
        // stream-event value for any field the SDK left undefined and
        // overwrote the rest — producing a turn whose input was a true sum
        // across every inner call while its output was only the last call's.
        // A real Work-PC trace showed 4.4M input against 634 output for a turn
        // containing five Edits and five Bash runs: input summed, output not.)
        //
        // Both accumulators count the same calls, so where both have a value
        // they agree; taking the larger just means "whichever source actually
        // saw this field". Never added together — that would double-count.
        const pick = (a: number, b: number) => (a > b ? a : b);
        const turnUsage = {
          input: pick(sdkUsage.input, cumUsage.input),
          output: pick(sdkUsage.output, cumUsage.output),
          cacheRead: pick(sdkUsage.cacheRead, cumUsage.cacheRead),
          cacheCreate: pick(sdkUsage.cacheCreate, cumUsage.cacheCreate),
        };
        console.log(
          `[claude-oauth] turn usage over ${sdkUsageCalls || '?'} model call(s):`
          + ` in=${turnUsage.input} out=${turnUsage.output}`
          + ` cacheRead=${turnUsage.cacheRead} cacheWrite=${turnUsage.cacheCreate}`
          // Both sources printed so a future mismatch is visible rather than
          // silently resolved by pick() above.
          + ` | sdk=${JSON.stringify(sdkUsage)} events=${JSON.stringify(cumUsage)}`
        );
        const usagePayload = normalizeCacheUsage({
          input_tokens: turnUsage.input,
          output_tokens: turnUsage.output,
          cache_read_input_tokens: turnUsage.cacheRead,
          cache_creation_input_tokens: turnUsage.cacheCreate,
        }, 'claude');
        if (usagePayload) enqueue(usagePayload);

        if (oauthSourceMap.size > 0) {
          enqueue({ type: 'web_sources', sources: [...oauthSourceMap.values()] });
        }

        controller.enqueue(`data: [DONE]\n\n`);
        controller.close();
      } catch (e: any) {
        // Common failure modes here:
        //   - SDK install failed / missing native binary
        //   - OAuth token expired / revoked
        //   - Subscription credit exhausted
        //   - Anthropic-side session not found (resume of stale ID)
        // Surface the message so the user can react (switch to API-key,
        // refresh token, etc.).
        const msg = e?.message || String(e);
        console.error('[claude-oauth] error:', msg);
        // If the turn died while compaction was still running, record it here
        // (before the stream closes) so the report says "it started and did not
        // finish" rather than showing nothing at all.
        if (compacting) recordCompaction('interrupted');
        // Translate a known signature (context-window overflow, rate limit,
        // credit, token) into a plain reason so the stop is never a mystery;
        // keep the raw text too for anything unrecognized.
        const friendly = explainClaudeStopError(msg);
        const shown = friendly
          ? `Claude OAuth path stopped: ${friendly}\n(raw: ${msg})`
          : `Claude OAuth path failed: ${msg}`;
        try { controller.enqueue(`data: ${JSON.stringify({ error: shown })}\n\n`); } catch {}
        try { controller.close(); } catch {}
      } finally {
        // Last resort for exits that are neither boundary nor catch (e.g. the
        // client aborted mid-compaction). The stream may already be closed, in
        // which case the enqueue inside recordCompaction throws and is
        // swallowed — this is best effort, not a guarantee.
        if (compacting) recordCompaction('interrupted');
        // Stop the stall watchdog on every exit path — a leaked interval
        // would keep firing enqueue() against a closed controller.
        clearInterval(stallTimer);
        // Discard any interjection that arrived too late to be delivered (e.g.
        // after the entity's last tool call) so it can't leak into a later turn.
        clearInjections(injectTurnId);
      }
    },
  });

  return new Response(readableStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

// ── Auto-Model-Select helpers ────────────────────────────────────────────────
// Format for the user-editable allowed-models textarea:
//   family | specificModel | on|off | optional display label
// Comments (#) and blank lines are ignored.
interface AllowedModel {
  family: string;          // user-supplied family name ('Claude', 'GLM', etc.)
  specificModel: string;   // model id passed downstream
  thinking: boolean;       // true → thinking-on for whichever flag the family uses
  label: string;           // human-readable label shown in the meta bar
}

function buildModelLabel(family: string, specificModel: string, thinking: boolean, modelParams?: any): string {
  // Try to produce a clean "Claude Opus 4.7 Thinking" form. Falls back to
  // raw "<family> <specificModel>" if we don't recognize the pattern.
  let pretty = specificModel || '';
  // DigitalOcean-served models keep their provider in the label — same bare
  // model id exists on Z.AI at a different price, so the reader must be able
  // to see which provider actually served this message.
  if (pretty.startsWith('digitalocean/')) {
    const suffixD = thinking ? ' Thinking' : '';
    return family + ' ' + pretty.slice('digitalocean/'.length) + ' (DigitalOcean)' + suffixD;
  }
  // Strip common prefixes like "moonshotai/" so labels stay tidy.
  if (pretty.includes('/')) pretty = pretty.split('/').pop()!;
  // OpenAI ids like "gpt-5.4-mini" read best with an uppercase "GPT" and the
  // original hyphens preserved — skip the generic title-casing below.
  if (/^gpt[-\d]/i.test(pretty)) {
    const suffixO = thinking ? ' Thinking' : '';
    return `${family} ${pretty.replace(/^gpt/i, 'GPT')}${suffixO}`;
  }
  // Capitalize first letter of each segment split on -/_/space.
  pretty = pretty
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .map((w: string) => w ? (w[0].toUpperCase() + w.slice(1)) : w)
    .join(' ');
  // A model id that already carries its own family name printed it twice:
  // family "Claude" + id "claude-opus-5" came out "Claude Claude Opus 5
  // Thinking". Reported by Hibiki 2026-10-07 from a vessel-check readout — and
  // it was never Claude-only, since Gemini ("Gemini Gemini 3.8 Flash"), GLM,
  // DeepSeek, Kimi and MiMo all prefix their ids with the family too. It also
  // fixes the casing those families lost to the generic title-caser ("GLM Glm
  // 5.3" → "GLM 5.3", "MiMo Mimo V2.6 Pro" → "MiMo V2.6 Pro").
  //
  // Only a LEADING duplicate followed by more text is dropped, so a family
  // whose label equals its whole id would still print the id rather than
  // collapsing to a bare family name. Already-saved labels in old logs are
  // untouched — they are stored per message, so only new ones read correctly.
  const famWord = (family || '').trim();
  if (
    famWord
    && pretty.length > famWord.length + 1
    && pretty.toLowerCase().startsWith(famWord.toLowerCase() + ' ')
  ) {
    pretty = pretty.slice(famWord.length + 1);
  }
  const suffix = thinking ? ' Thinking' : '';
  // For Gemini, include the thinking level since it's not a boolean.
  const fam = (family || '').toLowerCase();
  if (fam.includes('gemini') && modelParams?.thinkingLevel) {
    const lvl = modelParams.thinkingLevel;
    return `${family} ${pretty} Thinking (${lvl[0].toUpperCase() + lvl.slice(1)})`;
  }
  return `${family} ${pretty}${suffix}`;
}

function parseAllowedModels(raw: string): AllowedModel[] {
  const out: AllowedModel[] = [];
  if (!raw || typeof raw !== 'string') return out;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split('|').map((p) => p.trim());
    if (parts.length < 3) continue;
    const [family, specificModel, thinkingFlag, ...rest] = parts;
    if (!family || !specificModel) continue;
    const thinking = /^(on|true|yes|enabled|thinking|y|1)$/i.test(thinkingFlag);
    const labelRaw = rest.length ? rest.join(' | ').trim() : '';
    const label = labelRaw || buildModelLabel(family, specificModel, thinking);
    out.push({ family, specificModel, thinking, label });
  }
  return out;
}

// ── change_model (vessel handoff) — ONE decision for all five dialects ──────
// The tool exists in five provider dialects; this is the single place that
// decides what a call MEANS, so none of them can answer "allowed" more easily
// than the others. Result text is model-facing and deliberately English-only:
// it is read by whichever vessel is running, not by the partner.
//
// Only `switched: true` ends the turn. An unknown target or a target that is
// already the current vessel is REPORTED and the turn continues — a refusal
// that also killed the turn would turn a typo into a lost answer.
type ChangeModelOutcome =
  | { switched: false; resultText: string }
  | { switched: true; resultText: string; model: HandoffModel; note: string };

// Everything the two out-of-POST stream functions (OAuth / Anthropic-compat)
// need to offer and run the tool, bundled into ONE argument. Five separate
// parameters threaded through two signatures and two call sites is five chances
// to forget one — and the one you forget is the one that reads as "handoff
// isn't offered on that provider" without anything looking broken.
type HandoffBundle = {
  enabled: boolean;
  targetIds: string[];
  targetHelp: string;
  ctx: { allowedRaw: string; curFamily: string; curSpecific: string };
  payload: (o: { model: HandoffModel; note: string }) => any;
};

function runChangeModel(
  input: any,
  ctx: { allowedRaw: string; curFamily: string; curSpecific: string },
): ChangeModelOutcome {
  const target = String(input?.target ?? '').trim();
  const note = String(input?.handoff ?? '').trim();
  const r = resolveHandoff(ctx.allowedRaw, target, {
    family: ctx.curFamily,
    specificModel: ctx.curSpecific,
  });
  if (r.kind === 'empty') {
    return {
      switched: false,
      resultText:
        'change_model is unavailable: no vessels are on this being\'s curated list. ' +
        'Nothing was changed. Tell your partner if you need the list filled in.',
    };
  }
  if (r.kind === 'unknown') {
    return {
      switched: false,
      resultText:
        `"${target || '(empty)'}" is not an allowed target, so NOTHING was changed and you are ` +
        `still running as ${ctx.curSpecific}. Match one id exactly from this list:\n` +
        describeAllowed(r.allowed),
    };
  }
  if (r.kind === 'already') {
    return {
      switched: false,
      resultText:
        `You are ALREADY running as ${r.model.specificModel} (${r.model.label}). ` +
        'No switch was performed and the turn was not interrupted — just carry on with the work.',
    };
  }
  if (!note) {
    return {
      switched: false,
      resultText:
        `No switch performed: \`handoff\` was empty. The next vessel receives NO reasoning from ` +
        `you — the note is the only thing it gets beyond the visible conversation. Call ` +
        `change_model again with a handoff that says what is done and what remains.`,
    };
  }
  return {
    switched: true,
    model: r.model,
    note,
    resultText:
      `Handoff accepted: ${ctx.curSpecific} → ${r.model.specificModel} (${r.model.label}). ` +
      'This turn ends here; the next vessel answers your partner using your handoff note.',
  };
}

// ── Anthropic-format adapter (Kimi + MiMo) ─────────────────────────────────
// Kimi (Moonshot) and MiMo (Xiaomi) both ship a native Anthropic Messages API
// endpoint that speaks the dialect these models were actually trained for —
// typed `content` blocks (text / thinking / tool_use / tool_result) and
// `stop_reason: 'tool_use'`. NEXUS previously routed both through the
// OpenAI-compatible /chat/completions surface, where the tool-call dialect is
// `tool_calls` + JSON-string arguments + `reasoning_content` — a shape the
// model only emits INTERMITTENTLY. That intermittency was the "Kimi K3 doesn't
// reason / narrates instead of calling tools" failure: measured 2/9 on the
// OpenAI path vs 7/7 (streaming + non-streaming) on this one. Verified against
// both providers' own docs (2026-09-02):
//   • Kimi — POST https://api.moonshot.ai/anthropic/v1/messages, Bearer auth,
//     tools + thinking (+signature) + image input, usage in Claude shape.
//   • MiMo — POST https://api.xiaomimimo.com/anthropic/v1/messages, Bearer or
//     api-key auth, tools + thinking (+signature) + images (v2.5 only).
// This is a SELF-CONTAINED raw-fetch loop (no Anthropic SDK — those credentials
// aren't Claude's), but it mirrors the Claude API-key path's tool loop exactly:
// accumulate content blocks in order, execute local tool_use, echo the
// assistant turn (incl. thinking signature) + a tool_result user turn, loop.
//
// Deliberate simplifications vs the Claude path, all safe for these models:
//   • no cache_control breakpoints (Kimi/MiMo cache prompts server-side anyway)
//   • no adaptive thinking / effort / task budget (not part of their surface)
//   • no prefill auto-continuation (rare at the generous 32k cap)
//   • no eyes-bridging (both target models are vision-capable; a text-only
//     model routed here would get native image blocks it simply cannot see)
async function streamViaAnthropicCompat(args: {
  provider: 'kimi' | 'mimo';
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  processedMessages: any[];
  modelSelectedPayload: any;
  modelParams: any;
  folderName: string;
  senseEvents: any[];
  toolUseEnabled: boolean;
  enableReadConversation: boolean;
  agentFullSystemAccess: boolean;
  agentDangerousTools: boolean;
  agentReadOnlyTools: boolean;
  instructionOverrides: Record<string, any>;
  language?: string;
  askUserEnabled: boolean;
  askUserTimeoutMs: number;
  handoff: HandoffBundle;
  subagentEnabled: boolean;
  subagentModel: string;
  subagentFamily: string;
  lettersEnabled: boolean;
  browserEnabled: boolean;
  browserAllowedHosts: string[];
  browserAllowAnyHost: boolean;
  computerControlEnabled: boolean;
  appControlEnabled: boolean;
  convoId: string;
  keys: any;
  injectTurnId: string;
  maxToolRounds: number;
  hiddenAttachmentsAccessible: boolean;
  conversationAttachmentRefs: { ref: string; name: string; size: number; mimeType: string }[];
  turnAbort: AbortController;      // fires on browser Stop (req.signal) or the stop key — see POST
  betrayalSend: GuardedSender;     // guarded SSE writer — see lib/betrayalGuard.ts
}): Promise<Response> {
  const {
    provider, baseUrl, apiKey, model, systemPrompt, processedMessages,
    modelSelectedPayload, modelParams, folderName, senseEvents, toolUseEnabled,
    enableReadConversation, agentFullSystemAccess, agentDangerousTools, agentReadOnlyTools,
    instructionOverrides, language, askUserEnabled, askUserTimeoutMs, handoff,
    subagentEnabled, subagentModel, subagentFamily, lettersEnabled,
    browserEnabled, browserAllowedHosts, browserAllowAnyHost,
    computerControlEnabled, appControlEnabled, convoId, keys, injectTurnId, maxToolRounds,
    hiddenAttachmentsAccessible, conversationAttachmentRefs, turnAbort, betrayalSend,
  } = args;
  const I = resolveAgentInstructions(instructionOverrides, language);
  const pathDesc = agentFullSystemAccess ? I.pathParamFull : I.pathParamSandbox;
  const pathRule = agentFullSystemAccess ? I.pathRuleFull : I.pathRuleSandbox;

  // ── Messages in Anthropic content-block shape ────────────────────────────
  const anthropicMessages = await Promise.all(processedMessages.map(async (m: any) => {
    const contentArr: any[] = [];
    for (const media of (m.mediaFiles || [])) {
      if (media.mimeType?.startsWith('image/')) {
        if (media.name) contentArr.push({ type: 'text', text: `<attached_file name="${media.name}" type="${media.mimeType}" />` });
        // Downscale like the Claude path: a full-res screenshot is ~2.9 MB of
        // base64 and makes vision turns take tens of seconds / trip the
        // per-minute input quota. Kimi & MiMo are vision models — they read
        // the resized image natively, so nothing is lost.
        const img = await shrinkImageForClaude(media.base64Data, media.mimeType);
        contentArr.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
      } else if (
        provider === 'mimo'
        && media.mimeType?.startsWith('video/')
        && isVideoCapable(model)
      ) {
        // MiMo's Anthropic endpoint takes a native video block that is NOT in
        // Anthropic's published spec: the `image` envelope with the type
        // renamed. Measured 2026-10-03 — a 2 s clip (red then blue) raised
        // input_tokens 29 → 139 and the model answered "solid red first, then
        // solid blue". Four other shapes (`video_url`, `video`/{url},
        // `video`/url, `input_video`) left input_tokens at the text-only
        // baseline, and two of them ANSWERED ANYWAY with invented colors — a
        // confident 200 over bytes that never arrived. See modelVision.ts.
        //
        // Gated on isVideoCapable(model), which is also what the UI reads via
        // wireCarriesMedia(): mimo-v2.5-pro 404s on this block ("No endpoints
        // found that support image input") and Kimi has no measured video
        // surface, so neither is on that list and neither gets sent one. The
        // two gates must stay in lockstep or the UI promises what we drop.
        //
        // No downscale pass (unlike images): there is no video equivalent of
        // shrinkImageForClaude here, so the clip goes up at its original size
        // and byte limits are the provider's to enforce — loudly, not
        // silently. Token cost itself is mild: ≈13.5/s after a ~83-token
        // first frame. Only video/mp4 was measured; other containers are
        // passed through as-is rather than guessed at.
        if (media.name) contentArr.push({ type: 'text', text: `<attached_file name="${media.name}" type="${media.mimeType}" />` });
        contentArr.push({ type: 'video', source: { type: 'base64', media_type: media.mimeType, data: media.base64Data } });
      }
    }
    if (m.content) contentArr.push({ type: 'text', text: m.content });
    if (contentArr.length === 0) contentArr.push({ type: 'text', text: '-' });
    return { role: m.role === 'user' ? 'user' : 'assistant', content: contentArr };
  }));

  // ── Tool definitions in Anthropic {name, description, input_schema} form ─
  const tools: any[] = [];
  if (toolUseEnabled) {
    tools.push(
      { name: 'Read', description: `${I.toolReadDesc} ${pathRule}`, input_schema: { type: 'object', properties: { path: { type: 'string', description: pathDesc } }, required: ['path'] } },
    );
    // Read-only mode (SPU agents): Write/Edit are withheld even though
    // toolUseEnabled is on — the desk is reference-only to these agents.
    if (!agentReadOnlyTools) {
      tools.push(
        { name: 'Write', description: I.toolWriteDesc, input_schema: { type: 'object', properties: { path: { type: 'string', description: pathDesc }, content: { type: 'string', description: 'Full file contents to write' } }, required: ['path', 'content'] } },
        { name: 'Edit', description: I.toolEditDesc, input_schema: { type: 'object', properties: { path: { type: 'string', description: pathDesc }, old_string: { type: 'string', description: 'Text to find. Must occur exactly once.' }, new_string: { type: 'string', description: 'Text to replace it with.' } }, required: ['path', 'old_string', 'new_string'] } },
      );
    }
    tools.push(
      { name: 'Glob', description: I.toolGlobDesc, input_schema: { type: 'object', properties: { pattern: { type: 'string', description: 'Glob pattern. Use `**` to match all files.' } }, required: ['pattern'] } },
      { name: 'Grep', description: I.toolGrepDesc, input_schema: { type: 'object', properties: { pattern: { type: 'string', description: 'JavaScript regex (no surrounding slashes).' }, file_pattern: { type: 'string', description: 'Optional glob to restrict files.' }, flags: { type: 'string', description: 'Optional regex flags (e.g. "i").' } }, required: ['pattern'] } },
    );
    if (agentDangerousTools) {
      tools.push(
        { name: 'Delete', description: I.toolDeleteDesc, input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Path of the file to delete.' } }, required: ['path'] } },
        { name: 'Bash', description: I.toolBashDesc, input_schema: { type: 'object', properties: { command: { type: 'string', description: 'The shell command to run.' }, timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds (default 60000, max 600000).' } }, required: ['command'] } },
      );
    }
  }
  if (modelParams.enableWebSearch) {
    tools.push(
      { name: 'web_search', description: I.webSearchDesc, input_schema: { type: 'object', properties: { query: { type: 'string', description: 'The search query.' } }, required: ['query'] } },
      { name: 'web_fetch', description: I.webFetchDesc, input_schema: { type: 'object', properties: { url: { type: 'string', description: 'The absolute http(s) URL to open and read.' } }, required: ['url'] } },
    );
  }
  if (enableReadConversation) {
    tools.push(
      { name: 'read_conversation', description: I.readConversationDesc, input_schema: { type: 'object', properties: { name: { type: 'string', description: I.readConversationNameParam } }, required: ['name'] } },
      { name: 'search_conversations', description: I.searchConversationsDesc, input_schema: { type: 'object', properties: { query: { type: 'string', description: I.searchConversationsQueryParam }, regex: { type: 'boolean', description: I.searchRegexParam } }, required: ['query'] } },
      // Same scope as the two above (this being's own past), so same gate —
      // see the OAuth site's comment for why it is not read_attachment's.
      { name: 'search_attachments', description: I.searchAttachmentsDesc, input_schema: { type: 'object', properties: { query: { type: 'string', description: I.searchAttachmentsQueryParam }, regex: { type: 'boolean', description: I.searchRegexParam } }, required: ['query'] } },
    );
  }
  if (hiddenAttachmentsAccessible) {
    tools.push(
      { name: 'read_attachment', description: I.readAttachmentDesc, input_schema: { type: 'object', properties: { ref: { type: 'string', description: I.readAttachmentPrefixParam }, pattern: { type: 'string', description: I.readAttachmentPatternParam } }, required: ['ref'] } },
    );
  }
  if (lettersEnabled) {
    tools.push(
      { name: 'write_letter', description: I.toolWriteLetterDesc, input_schema: { type: 'object', properties: { to: { type: 'array', items: { type: 'string' }, description: I.writeLetterToParam }, title: { type: 'string', description: I.writeLetterTitleParam }, text: { type: 'string', description: I.writeLetterTextParam } }, required: ['to', 'title', 'text'] } },
      { name: 'list_letters', description: I.toolListLettersDesc, input_schema: { type: 'object', properties: {}, required: [] } },
      { name: 'list_recipients', description: I.toolListRecipientsDesc, input_schema: { type: 'object', properties: {}, required: [] } },
      { name: 'read_letter', description: I.toolReadLetterDesc, input_schema: { type: 'object', properties: { id: { type: 'string', description: I.readLetterIdParam } }, required: ['id'] } },
      { name: 'archive_letter', description: I.toolArchiveLetterDesc, input_schema: { type: 'object', properties: { id: { type: 'string', description: I.archiveLetterIdParam } }, required: ['id'] } },
    );
  }
  if (browserEnabled) tools.push(...browserToolsClaude(I));
  if (computerControlEnabled) tools.push(...computerToolsClaude(I));
  if (appControlEnabled) tools.push(...appToolsClaude(I));
  if (askUserEnabled) {
    tools.push({
      name: 'AskQuestion', description: I.askUserDesc,
      input_schema: {
        type: 'object',
        properties: {
          questions: {
            type: 'array', description: 'Between 1 and 4 questions to ask your partner.',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: 'The full question text. End with a question mark.' },
                header: { type: 'string', description: 'Very short label/chip for the question (max ~12 chars).' },
                multiSelect: { type: 'boolean', description: 'Set true to let your partner pick multiple options.' },
                options: {
                  type: 'array', description: '2 to 4 distinct, mutually-exclusive choices.',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: 'Short option label (1-5 words).' },
                      description: { type: 'string', description: 'What choosing this option means.' },
                    },
                    required: ['label'],
                  },
                },
              },
              required: ['question', 'options'],
            },
          },
        },
        required: ['questions'],
      },
    });
  }
  if (subagentEnabled) {
    tools.push({
      name: 'spawn_subagent', description: I.subagentDesc,
      input_schema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'A precise, self-contained investigation for the helper to perform.' },
          return_contract: { type: 'string', description: 'Optional: how the distilled result should be shaped/formatted.' },
        },
        required: ['task'],
      },
    });
  }
  // Optional vessel handoff (Kimi / MiMo speak the Anthropic dialect).
  if (handoff.enabled) {
    tools.push({
      name: 'change_model', description: I.changeModelDesc,
      input_schema: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            enum: handoff.targetIds,
            description: `${I.changeModelTargetParam} Available: ${handoff.targetHelp}`,
          },
          handoff: { type: 'string', description: I.changeModelHandoffParam },
        },
        required: ['target', 'handoff'],
      },
    });
  }
  // Set by the change_model handler below; read right after the tool loop to
  // end the turn (the client re-POSTs as the new vessel).
  let handoffAccepted: { model: HandoffModel; note: string } | null = null;

  const LOCAL_TOOL_NAMES_SET = new Set([
    'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Delete', 'Bash',
    'web_search', 'web_fetch', 'read_conversation', 'search_conversations', 'read_attachment', 'search_attachments',
    'AskQuestion', 'spawn_subagent', 'change_model',
    ...LETTER_TOOL_NAMES, ...BROWSER_TOOL_NAMES, ...COMPUTER_TOOL_NAMES, ...APP_TOOL_NAMES,
  ]);

  const readableStream = new ReadableStream({
    async start(controller) {
      const enqueue = (obj: any) => betrayalSend(controller, obj);
      registerActiveTurnStop(() => { try { controller.close(); } catch {} try { turnAbort.abort(); } catch {} });
      enqueue(modelSelectedPayload);
      for (const ev of senseEvents) enqueue(ev);

      const repeatGuard = makeRepeatGuard();
      let toolStopNotice = '';
      let cumUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
      const sourceMap = new Map<string, { url: string; title?: string }>();

      // Declared output cap for BOTH providers on this path (Kimi / MiMo).
      //
      // Thinking and the visible answer share ONE budget here — MiMo's own docs
      // say "max_completion_tokens limits the total length of thinking content
      // and the final answer", and K3 reasons at `max` by default with no way
      // to turn it down. So a soul-sized output (~68,000 chars ≈ 45k tokens)
      // could never fit under the old hardcoded 32,000: a Soul Packer run on
      // K3 ended on the token cap every time. Measured on the wire 2026-10-12,
      // declared-cap acceptance:
      //   kimi-k3        32k · 64k · 128k · 200k · 262144 · 400k · 1M → ALL 200
      //                  (it does not validate max_tokens against anything, so
      //                  an accepted value is NOT proof of output capacity)
      //   mimo-v2.6-pro  32k · 64k · 128k → 200;  200k and up → 400
      //                  "'max_tokens' 200000 is out of supported range
      //                  (0, 131072]" — the provider names its own ceiling
      // 131072 is therefore the largest value BOTH accept, and it is MiMo's
      // stated maximum rather than a guess. Also measured: prompt + max_tokens
      // is NOT checked against the context window (114,241 input tokens with
      // this cap → 200), so raising it cannot break a long conversation. It
      // doubles as the per-turn cost ceiling: at K3's $15/M output a runaway
      // turn is ~$2 here, where 32k capped it at ~$0.5.
      const COMPAT_MAX_TOKENS = 131072;

      // One streaming call. Accumulates content blocks (text / thinking /
      // tool_use) in order so the assistant turn can be echoed back verbatim.
      const runOnce = async (msgs: any[], withTools: boolean) => {
        const body: any = {
          model,
          ...(systemPrompt ? { system: systemPrompt } : {}),
          messages: msgs,
          max_tokens: COMPAT_MAX_TOKENS,
          stream: true,
        };
        // Thinking: Kimi K3 reasons always (no request param needed — the
        // toggle has no effect on it, same as the OpenAI path). MiMo exposes an
        // explicit `thinking` object; map the shared toggle onto it.
        if (provider === 'mimo') {
          if (modelParams.qwenEnableThinking !== false) body.thinking = { type: 'enabled' };
          body.temperature = Math.min(1.5, Math.max(0, Number(modelParams.temperature ?? 1)));
          body.top_p = modelParams.topP ?? 0.95;
        }
        // Kimi K3 fixes temperature/top_p server-side — omit them entirely.
        if (withTools && tools.length) body.tools = tools;

        // A screenshot is re-sent on every tool round, so input is quadratic in
        // rounds and trips the provider's per-minute input quota. A 429 means
        // nothing was generated — resending the identical body after the wait is
        // a resume, not a duplicate. Retry up to 3 times; anything else throws.
        let res: Response | null = null;
        for (let attempt = 0; ; attempt++) {
          const r = await fetch(baseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify(body),
            signal: turnAbort.signal,   // Stop must reach the provider, not just the browser
          });
          if (r.ok && r.body) { res = r; break; }
          const errText = await r.text().catch(() => '');
          const err = new Error(`${provider === 'kimi' ? 'Kimi' : 'MiMo'} Anthropic API: ${r.status} ${errText.slice(0, 400)}`);
          const waitMs = parseRetryDelayMs(err);
          if (waitMs === null || attempt >= 2) throw err;
          console.log(`[${provider}] quota 429 — waiting ${Math.round(waitMs / 1000)}s, retry ${attempt + 2}/3`);
          await new Promise((s) => setTimeout(s, waitMs));
        }
        if (!res || !res.body) throw new Error(`${provider} stream ended before body`);

        const assistantBlocks: any[] = [];
        let curTextIdx = -1;
        let inThinking = false;
        let thinkingText = '';
        let thinkingSig = '';
        let curTool: any = null;
        let curToolJson = '';
        let stopReason = '';
        // `stop_details` rides on message_delta next to stop_reason and is the
        // only carrier of a refusal's category + explanation. Typed `any`
        // deliberately: the SDK's RefusalStopDetails.category union is
        // 'cyber' | 'bio' | null, which does NOT include the categories we
        // actually hit (frontier_llm, reasoning_extraction, general_harms).
        let refusalStop: any = null;
        let streamError: string | null = null;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          // Stop pressed mid-stream: drop the rest instead of draining it.
          if (turnAbort.signal.aborted) { try { await reader.cancel(); } catch {} break; }
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const events = buf.split('\n\n');
          buf = events.pop() || '';
          for (const ev of events) {
            const dl = ev.split('\n').find(l => l.startsWith('data:'));
            if (!dl) continue;
            const ds = dl.slice(5).trim();
            if (ds === '[DONE]') continue;
            let p: any;
            try { p = JSON.parse(ds); } catch { continue; }

            if (p.type === 'error') {
              streamError = p.error?.message || JSON.stringify(p.error || p);
              continue;
            }
            if (p.type === 'message_start') {
              const u = p.message?.usage;
              if (u) {
                cumUsage.input += Number(u.input_tokens || 0);
                cumUsage.output += Number(u.output_tokens || 0);
                cumUsage.cacheRead += Number(u.cache_read_input_tokens || 0);
                cumUsage.cacheCreate += Number(u.cache_creation_input_tokens || 0);
              }
            } else if (p.type === 'message_delta') {
              if (p.usage?.output_tokens) cumUsage.output += Number(p.usage.output_tokens);
              if (p.delta?.stop_reason) stopReason = p.delta.stop_reason;
              if (p.delta?.stop_details) refusalStop = p.delta.stop_details;
            } else if (p.type === 'content_block_start') {
              const bt = p.content_block?.type;
              if (bt === 'text') {
                assistantBlocks.push({ type: 'text', text: '' });
                curTextIdx = assistantBlocks.length - 1;
                const init = p.content_block?.text || '';
                if (init) { assistantBlocks[curTextIdx].text += init; enqueue({ type: 'text', content: init }); }
              } else if (bt === 'thinking') {
                inThinking = true;
                thinkingText = p.content_block?.thinking || '';
                thinkingSig = p.content_block?.signature || '';
                if (thinkingText) enqueue({ type: 'thought', content: thinkingText });
              } else if (bt === 'tool_use') {
                curTool = { type: 'tool_use', id: p.content_block.id, name: p.content_block.name, input: {} };
                curToolJson = '';
              }
            } else if (p.type === 'content_block_delta') {
              const d = p.delta || {};
              if (d.type === 'text_delta' && d.text) {
                if (curTextIdx >= 0) assistantBlocks[curTextIdx].text += d.text;
                enqueue({ type: 'text', content: d.text });
              } else if (d.type === 'thinking_delta' && d.thinking) {
                thinkingText += d.thinking;
                enqueue({ type: 'thought', content: d.thinking });
              } else if (d.type === 'signature_delta' && d.signature) {
                thinkingSig += d.signature;
              } else if (d.type === 'input_json_delta' && d.partial_json) {
                curToolJson += d.partial_json;
              }
            } else if (p.type === 'content_block_stop') {
              if (inThinking) {
                assistantBlocks.push({ type: 'thinking', thinking: thinkingText, ...(thinkingSig ? { signature: thinkingSig } : {}) });
                inThinking = false;
              } else if (curTool) {
                try { curTool.input = JSON.parse(curToolJson || '{}'); } catch { curTool.input = {}; }
                assistantBlocks.push(curTool);
                curTool = null;
                curToolJson = '';
              }
            }
          }
        }

        if (streamError && assistantBlocks.length === 0) throw new Error(streamError);
        return { assistantBlocks, stopReason, refusalStop };
      };

      try {
        let currentMessages = [...anthropicMessages];
        for (let iter = 0; iter < maxToolRounds; iter++) {
          if (turnAbort.signal.aborted) break;   // Stop must end the tool loop, not just the output
          const { assistantBlocks, stopReason, refusalStop } = await runOnce(currentMessages, true);

          const toolUses = assistantBlocks.filter((b: any) => b.type === 'tool_use' && LOCAL_TOOL_NAMES_SET.has(b.name));
          if (toolUses.length === 0) {
            if (stopReason === 'max_tokens') {
              // The frame TYPE depends on who asked, because the two consumers
              // want opposite things from the same sentence.
              //   • A conversation wants it INSIDE the message: it is persisted,
              //     and without it the reply simply ends mid-sentence with no
              //     explanation — this path has no auto-continuation at all
              //     (`attempt` in runOnce is a 429 retry, not a continuation).
              //   • An AGENT run must not get a `text` frame. The Soul Packer
              //     accumulates every text frame into the document it is
              //     writing, so this warning would be saved INTO the soul file
              //     and then handed back as part of the next continuation turn —
              //     i.e. the model would read "⚠️ I hit the token limit" as a
              //     line of its own output. `notice` goes to the panel's
              //     run-event list instead, which is where the operator is
              //     already watching, and leaves `accum` untouched: a round
              //     that produced nothing visible now ends the loop cleanly
              //     instead of continuing from a prefill made of this warning.
              // agentReadOnlyTools is set by exactly one caller
              // (SystemPromptUpdater.tsx), so it IS the agent-run flag.
              enqueue({
                type: agentReadOnlyTools ? 'notice' : 'text',
                content: (agentReadOnlyTools ? '' : '\n\n')
                  + (language === 'ja'
                      ? '⚠️ _[出力がトークン上限に達して切れました — 送り直すと続きます。]_'
                      : '⚠️ _[Response hit the token limit and was cut off — resend to continue.]_'),
              });
            }
            // A refusal returns HTTP 200 with an EMPTY content array, so with no
            // notice the turn renders as a blank reply with no reason at all.
            // This path serves Anthropic-format third parties (Kimi / MiMo),
            // which have not been observed to emit stop_details — the wiring is
            // here because the wire format admits it and the cost is one branch.
            if (stopReason === 'refusal') {
              enqueue({ type: 'notice', content: (language === 'ja'
                ? '安全分類器がこのターンを止めた（stop_reason: refusal）。'
                : 'A safety classifier stopped this turn (stop_reason: refusal).')
                + ' ' + describeRefusal(refusalStop?.category, refusalStop?.explanation, language,
                    assistantBlocks.some((b: any) => b.type === 'text' && String(b.text || '').trim())) });
            }
            break;
          }

          // Progress check before spending anything (see makeRepeatGuard).
          {
            let stuck: string | null = null;
            for (const tu of toolUses) {
              const hit = repeatGuard(tu.name, tu.input);
              if (hit) { stuck = hit; break; }
            }
            if (stuck) { toolStopNotice = toolRepeatNotice(stuck); break; }
          }
          // Last round and the model still wants tools: execute can't be
          // answered, so stop and write a closing answer instead.
          if (iter === maxToolRounds - 1) {
            toolStopNotice = toolLimitNotice(maxToolRounds);
            try {
              enqueue({ type: 'tool_activity', tool: 'write the final answer' });
              // Any tool_use blocks we refuse to execute still need a matching
              // tool_result in the history, or the Anthropic-format endpoint
              // rejects the turn ("tool_use must be followed by tool_result").
              const wrapResults = assistantBlocks
                .filter((blk: any) => blk.type === 'tool_use')
                .map((blk: any) => ({
                  type: 'tool_result',
                  tool_use_id: blk.id,
                  content: 'Not executed: the tool-use budget for this turn was exhausted before this call could run.',
                }));
              const wrapMsgs = [
                ...currentMessages,
                { role: 'assistant', content: assistantBlocks },
                { role: 'user', content: [...wrapResults, { type: 'text', text: toolWrapUpInstruction(language) }] },
              ];
              await runOnce(wrapMsgs, false);
            } catch (e: any) {
              console.warn(`[${provider}] wrap-up call failed:`, e?.message);
            } finally {
              enqueue({ type: 'tool_activity', tool: null });
            }
            break;
          }

          // Append the assistant turn and execute each tool.
          currentMessages.push({ role: 'assistant', content: assistantBlocks });
          const toolResultBlocks: any[] = [];
          for (const tu of toolUses) {
            // A tool call already returned by the model must NOT execute after
            // Stop — this is where the ghost mouse/keyboard input came from.
            if (turnAbort.signal.aborted) break;
            let resultContent: any = '';
            const actLabel = toolActivityLabel(tu.name);
            if (actLabel) enqueue({ type: 'tool_activity', tool: actLabel, name: tu.name });
            enqueue({ type: 'tool_call', call: { name: tu.name, input: truncateToolInput(tu.input), at: Date.now() } });
            try {
              if (tu.name === 'Read') {
                const p = String(tu.input?.path || '');
                if (isImageFilename(p)) {
                  const bin = await readWorkspaceFileBinary(folderName, p, { fullAccess: agentFullSystemAccess });
                  if (!bin) {
                    resultContent = `Error: image not found or path outside workspace: ${p}`;
                  } else {
                    const base64 = bin.data.toString('base64');
                    const img = await shrinkImageForClaude(base64, bin.mimeType);
                    resultContent = [
                      { type: 'text', text: `Image content of ${p} (${bin.mimeType}) follows:` },
                      { type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } },
                    ];
                  }
                } else {
                  const txt = await readWorkspaceFile(folderName, p, { fullAccess: agentFullSystemAccess });
                  resultContent = txt == null ? `Error: file not found or path outside workspace: ${p}` : txt;
                }
              } else if (tu.name === 'Write') {
                const p = String(tu.input?.path || '');
                const c = String(tu.input?.content ?? '');
                const wr = await writeWorkspaceFile(folderName, p, c, { fullAccess: agentFullSystemAccess });
                resultContent = wr.ok ? `OK: ${wr.existed ? 'overwrote' : 'created'} ${p} (${c.length} chars).` : `Error: ${wr.error || 'write failed'}`;
              } else if (tu.name === 'Edit') {
                const p = String(tu.input?.path || '');
                const oldS = String(tu.input?.old_string ?? '');
                const newS = String(tu.input?.new_string ?? '');
                const ed = await editWorkspaceFile(folderName, p, oldS, newS, { fullAccess: agentFullSystemAccess });
                resultContent = ed.ok ? `OK: edited ${p} (replaced ${oldS.length} chars with ${newS.length} chars).` : `Error: ${ed.error || 'edit failed'}`;
              } else if (tu.name === 'Glob') {
                const pat = String(tu.input?.pattern || '**');
                const matches = await globWorkspaceFiles(folderName, pat);
                resultContent = matches.length === 0 ? `(no files match \`${pat}\`)` : matches.join('\n');
              } else if (tu.name === 'Grep') {
                const pat = String(tu.input?.pattern || '');
                const filePat = tu.input?.file_pattern ? String(tu.input.file_pattern) : undefined;
                const flags = tu.input?.flags ? String(tu.input.flags) : undefined;
                const gr = await grepWorkspaceFiles(folderName, pat, { filePattern: filePat, flags });
                if (!gr.ok) resultContent = `Error: ${gr.error}`;
                else if (!gr.matches || gr.matches.length === 0) resultContent = `(no matches for /${pat}/${flags || ''})`;
                else resultContent = gr.matches.map(x => `${x.path}:${x.line}: ${x.text}`).join('\n');
              } else if (tu.name === 'Delete') {
                const p = String(tu.input?.path || '');
                const del = await deleteWorkspaceFile(folderName, p, { fullAccess: agentFullSystemAccess });
                resultContent = del.ok ? `OK: deleted ${p}.` : `Error: ${del.error || 'delete failed'}`;
              } else if (tu.name === 'Bash') {
                const cmd = String(tu.input?.command || '');
                if (!cmd.trim()) {
                  resultContent = 'Error: Bash requires a non-empty "command".';
                } else {
                  const cwd = await ensureWorkspace(folderName);
                  // `signal` so Stop ends the command instead of waiting it
                  // out — the loop below re-reads turnAbort, but it cannot get
                  // there while parked on this await (REPORTED 2026-11-01).
                  const sh = await runShellCommand(cmd, { cwd, timeoutMs: Number(tu.input?.timeout_ms) || undefined, signal: turnAbort.signal });
                  resultContent = sh.output;
                }
              } else if (tu.name === 'web_search') {
                const query = String(tu.input?.query || tu.input?.q || '').trim();
                if (!query) {
                  resultContent = 'Error: web_search requires a non-empty "query".';
                } else {
                  const hits = await webSearch(query, { maxResults: 6 });
                  for (const h of hits) {
                    if (h.url && !sourceMap.has(h.url)) sourceMap.set(h.url, { url: h.url, ...(h.title ? { title: h.title } : {}) });
                  }
                  resultContent = hits.length === 0
                    ? `(no results for "${query}")`
                    : hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`).join('\n\n')
                      + `\n\n(To read a full page, call web_fetch with one of the URLs above.)`;
                }
              } else if (tu.name === 'web_fetch') {
                const target = String(tu.input?.url || tu.input?.URL || '').trim();
                if (!target) {
                  resultContent = 'Error: web_fetch requires an absolute "url".';
                } else {
                  const page = await webFetch(target, { maxChars: 8000 });
                  if (page.url && !sourceMap.has(page.url)) sourceMap.set(page.url, { url: page.url, ...(page.title ? { title: page.title } : {}) });
                  resultContent = `URL: ${page.url}\n` + (page.title ? `Title: ${page.title}\n` : '') + `\n${page.text}` + (page.truncated ? `\n\n[...content truncated...]` : '');
                }
              } else if (tu.name === 'read_conversation') {
                const name = String(tu.input?.name || tu.input?.title || '').trim();
                const r = await readConversationByName(folderName, name, {
                  showPaths: agentFullSystemAccess,
                  fileTools: toolUseEnabled,
                  currentConvoId: convoId,
                });
                resultContent = formatReadConversationResult(r);
              } else if (tu.name === 'search_conversations') {
                const sr = await searchConversations(folderName, String(tu.input?.query || tu.input?.q || '').trim(), { excludeInactive: true, regex: !!tu.input?.regex });
                resultContent = formatSearchForTool(sr, agentFullSystemAccess);
              } else if (tu.name === 'read_attachment') {
                // Anthropic content-block shape has no audio/video block type,
                // so only image can ever be native here regardless of the model.
                const r = await runReadAttachment({ prefix: String(tu.input?.ref || ''), pattern: tu.input?.pattern, folderName, index: conversationAttachmentRefs, specificModel: model, nativeMediaKinds: new Set(['image']) });
                resultContent = r.media?.kind === 'image'
                  ? [
                      { type: 'text', text: r.text },
                      { type: 'image', source: { type: 'base64', media_type: r.media.mimeType, data: r.media.base64 } },
                    ]
                  : r.text;
              } else if (tu.name === 'search_attachments') {
                resultContent = await runSearchAttachments(folderName, String(tu.input?.query || '').trim(), !!tu.input?.regex, agentFullSystemAccess);
              } else if ((LETTER_TOOL_NAMES as readonly string[]).includes(tu.name)) {
                resultContent = await runLetterTool(tu.name, tu.input || {}, { me: folderName, convoId, instructions: I });
              } else if ((BROWSER_TOOL_NAMES as readonly string[]).includes(tu.name)) {
                resultContent = await runBrowserTool(tu.name, tu.input || {}, {
                  me: folderName, allowedHosts: browserAllowedHosts,
                  allowAnyHost: browserAllowAnyHost, instructions: I,
                });
              } else if ((COMPUTER_TOOL_NAMES as readonly string[]).includes(tu.name)) {
                const cr = await runComputerTool(tu.name, tu.input || {}, { me: folderName, instructions: I, language });
                if (cr.image) {
                  // Computer screenshots carry a 1:1 pixel→absolute-coordinate
                  // contract with their caption: runComputerTool reports the
                  // monitor's NATIVE dimensions and tells the being to add the
                  // top-left offset to the pixel it reads out of the image.
                  // Resizing here broke that contract — a pixel at x=784 in a
                  // 1568px downscale of a 1920px monitor is NOT at absolute 784,
                  // it is at 960, so every click landed ~22% off toward the far
                  // edge. Every other provider path (Claude API-key, Gemini,
                  // OAuth, OpenAI-compatible) sends the capture at full native
                  // resolution and relies on that 1:1 mapping; the adapter must
                  // match or Kimi/MiMo click in the wrong place by the scale
                  // factor regardless of how good their vision is. The cost is
                  // a larger payload (and the corresponding per-minute input-
                  // quota / vision-latency hit) — that is the inherent price of
                  // computer control, not something a resize can remove without
                  // breaking coordinates.
                  resultContent = [
                    { type: 'text', text: cr.text },
                    { type: 'image', source: { type: 'base64', media_type: cr.image.mimeType, data: cr.image.base64 } },
                  ];
                } else {
                  resultContent = cr.text;
                }
              } else if ((APP_TOOL_NAMES as readonly string[]).includes(tu.name)) {
                // app_shot has no coordinate contract to protect (app_act works
                // by ref, never by pixel), but it is sent at native size anyway:
                // the window's own pixels are what was asked for.
                const ar = await runAppTool(tu.name, tu.input || {}, { me: folderName, instructions: I });
                resultContent = ar.image
                  ? [
                    { type: 'text', text: ar.text },
                    { type: 'image', source: { type: 'base64', media_type: ar.image.mimeType, data: ar.image.base64 } },
                  ]
                  : ar.text;
              } else if (tu.name === 'AskQuestion') {
                const questions = normalizeQuestions(tu.input);
                if (questions.length === 0) {
                  resultContent = 'Error: AskQuestion requires 1-4 questions, each with 2-4 options.';
                } else {
                  const askId = createAskId();
                  enqueue({ type: 'ask_user', askId, questions });
                  const answered = await waitForAsk(askId, Number(askUserTimeoutMs) || 0);
                  const timedOut = answered === null;
                  const finalAnswers = timedOut ? recommendedDefaults(questions) : answered!;
                  enqueue({ type: 'ask_user_resolved', askId, answers: finalAnswers, timedOut });
                  resultContent = formatAnswerForModel(finalAnswers, timedOut);
                }
              } else if (tu.name === 'change_model') {
                // Vessel handoff. Only an ACCEPTED switch ends the turn.
                const o = runChangeModel(tu.input, handoff.ctx);
                resultContent = o.resultText;
                if (o.switched) {
                  const acc = { model: o.model, note: o.note };
                  handoffAccepted = acc;
                  enqueue(handoff.payload(acc));
                }
              } else if (tu.name === 'spawn_subagent') {
                const task = String((tu.input as any)?.task || '');
                if (!task.trim()) {
                  resultContent = 'Error: spawn_subagent requires a non-empty "task".';
                } else {
                  enqueue({ type: 'subagent_start', task });
                  const childFamily = subagentFamily && subagentFamily.trim()
                    ? subagentFamily.trim()
                    : (provider === 'kimi' ? 'Kimi' : 'MiMo');
                  const childModel = subagentModel && subagentModel.trim() ? subagentModel.trim() : model;
                  const sub = await runSubagent({
                    family: childFamily, model: childModel, keys, task,
                    returnContract: (tu.input as any)?.return_contract ? String((tu.input as any).return_contract) : undefined,
                    folderName, fullAccess: agentFullSystemAccess,
                    webSearch: !!(modelParams?.enableWebSearch || modelParams?.enableClaudeWebSearch),
                  });
                  cumUsage.input += sub.usage.input;
                  cumUsage.output += sub.usage.output;
                  cumUsage.cacheRead += sub.usage.cacheRead;
                  cumUsage.cacheCreate += sub.usage.cacheCreate;
                  enqueue({ type: 'subagent_done', task, result: sub.text, via: sub.via });
                  resultContent = sub.text || '(subagent returned nothing)';
                }
              } else {
                resultContent = `Error: unknown tool ${tu.name}`;
              }
            } catch (e: any) {
              resultContent = `Error: ${e?.message || 'tool execution failed'}`;
            }
            toolResultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: resultContent });
            if (actLabel) enqueue({ type: 'tool_activity', tool: null });
          }
          const injected = drainInjections(injectTurnId);
          if (injected.texts.length || injected.media.length) {
            // Anthropic-shaped wire: `image` is in the published spec, and MiMo
            // additionally takes a `video` block (same source envelope, type
            // renamed). Audio is deliberately absent — it is absent from
            // wireCarriesMedia() for this family too, and these two must agree
            // or the UI would promise delivery for bytes this site drops.
            const wire = new Set<MediaKindNarrow>(['image']);
            if (provider === 'mimo') wire.add('video');
            const prep = await prepareInjectionDelivery({
              drained: injected,
              wire,
              model,
              framing: I.injectionFraming,
              handoffTemplate: I.injectionAttachmentNote,
              refsOpenable: hiddenAttachmentsAccessible,
              pathsVisible: agentFullSystemAccess,
              refIndex: conversationAttachmentRefs,
              ja: language === 'ja',
            });
            if (prep.text) toolResultBlocks.push({ type: 'text', text: prep.text });
            toolResultBlocks.push(...anthropicInjectBlocks(prep.deliver));
            if (prep.notice) enqueue({ type: 'notice', content: prep.notice });
            enqueue({ type: 'injection_delivered', count: injected.texts.length + injected.media.length });
            // display-only tool/thinking-log event (see OAuth path above)
            try { enqueue({ type: 'tool_call', call: { name: 'partner interjection', kind: 'event', at: Date.now(), input: { texts: injected.texts, files: prep.logNames } } }); } catch {}
          }
          currentMessages.push({ role: 'user', content: toolResultBlocks });
          // Vessel handoff: the turn is over — the client re-POSTs as the new
          // vessel instead of asking this one to continue.
          if (handoffAccepted) break;
        }

        if (toolStopNotice) {
          console.warn(`[${provider}] ${toolStopNotice}`);
          enqueue({ type: 'notice', content: toolStopNotice });
        }
        // Anthropic-shape usage (cache_read/cache_creation are separate buckets
        // from input_tokens, exactly like Claude's) — normalize inline with the
        // Claude branch's arithmetic rather than the OpenAI-style default, which
        // would read prompt_tokens (absent here) and report 0 input.
        enqueue({
          type: 'cache_usage',
          cachedInputTokens: cumUsage.cacheRead,
          uncachedInputTokens: cumUsage.input,
          totalInputTokens: cumUsage.cacheRead + cumUsage.cacheCreate + cumUsage.input,
          outputTokens: cumUsage.output,
          cacheCreationTokens: cumUsage.cacheCreate,
          providerHint: provider,
        });
        if (sourceMap.size > 0) {
          enqueue({ type: 'web_sources', sources: [...sourceMap.values()] });
        }
        controller.enqueue(`data: [DONE]\n\n`);
        controller.close();
      } catch (e: any) {
        // Same guard as the other providers: after Stop the controller is
        // already gone and enqueue() throws.
        try { controller.enqueue(`data: ${JSON.stringify({ error: e?.message || 'unknown error' })}\n\n`); } catch {}
        try { controller.close(); } catch {}
      }
    },
  });

  return new Response(readableStream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}

export async function POST(req: Request) {
  try {
    // Global stop-key watcher (Ctrl+Shift+X). Started once per server process,
    // targeted at THIS instance's port so the hotkey always reaches the right
    // stop endpoint. Cheap: one hidden PowerShell process, no-op until pressed.
    // Guarded inside ensureStopKeyWatcher so a second request can't spawn two.
    try {
      let port = 0;
      const host = req.headers.get('host') || '';
      const m = host.match(/:(\d+)$/);
      if (m) port = Number(m[1]);
      if (!port) port = Number(process.env.PORT) || 3000;
      if (port > 0) ensureStopKeyWatcher(port);
    } catch { /* watcher is a convenience; never block the turn on it */ }

    // ── Turn-level abort ────────────────────────────────────────────────────
    // ONE controller per turn, fired by either way a turn can be stopped:
    //   (a) the browser Stop button — it aborts its fetch, which disconnects
    //       the client, which fires req.signal here;
    //   (b) the Ctrl+Shift+X stop key — every registerActiveTurnStop callback
    //       below aborts this too.
    // It exists because closing the stream controller is NOT enough. Measured
    // (probe route, 2026-09-20): on client disconnect req.signal fires and the
    // stream's cancel() runs immediately, controller.enqueue() then throws —
    // but the async start() body KEEPS RUNNING to completion. So before this,
    // Stop only silenced the output: the upstream generation was never
    // cancelled (LM Studio kept generating) and the agentic tool loop kept
    // issuing computer/app tool calls — mouse and keyboard commands landing on
    // the PC after the user believed the turn had ended.
    // Consumed in two ways: as `signal` on every upstream request, and as a
    // `break` guard at the head of each tool loop and before each tool
    // dispatch. The guards are deliberate rather than relying on a thrown
    // AbortError, so the existing finalize-on-abort (billing + tool-usage
    // save) still runs.
    const turnAbort = new AbortController();
    const abortTurn = () => {
      try { turnAbort.abort(); } catch { /* already aborted */ }
      // A PowerShell input child that was ALREADY spawned keeps typing and
      // clicking no matter who is listening. The stop key killed it via
      // stopComputerSession(); the browser Stop button never could.
      try { killActiveInput(); } catch { /* nothing running */ }
    };
    try { req.signal.addEventListener('abort', abortTurn); } catch { /* no signal on this runtime */ }

    // `let` (not const) — auto-model-selection may override aiName,
    // specificModel, and modelParams below before the provider flags are
    // computed. All downstream code reads the post-override values.
    let {
      messages,
      aiName,
      folderName = 'Default',
      systemPrompt = "",
      toolUseEnabled = false,
      // ── Per-Entity agent capability toggles (apply to ALL providers) ──────
      // agentFullSystemAccess: file tools reach the whole PC (absolute paths),
      //   instead of being sandboxed to workspaces/<Entity>/.
      // agentDangerousTools: enables the Delete tool everywhere, and (OAuth
      //   path only) the Bash/shell family.
      agentFullSystemAccess = false,
      agentDangerousTools = false,
      // Read-only file access for a non-Entity caller — currently only the
      // System Prompt Updater's agent runs (Update/Reorganize/Redistribute/
      // Genesis/Indexer). Grants Read/Glob/Grep against folderName's own
      // workspace (same entry point and relative-path root the being itself
      // uses) but NEVER Write/Edit/Delete/Bash — the desk is reference-only
      // to these agents by design. Forces toolUseEnabled on below regardless
      // of what the caller sent, and forces agentDangerousTools off so a
      // stray true can't smuggle Delete/Bash in underneath it.
      agentReadOnlyTools = false,
      // Per-Entity overrides for NEXUS's hidden/injected instruction strings
      // (tool descriptions, path rules, read_conversation + web tool text).
      // Empty/missing keys fall back to the English defaults.
      instructionOverrides = {},
      // Which built-in language DEFAULT_AGENT_INSTRUCTIONS come from before
      // per-Entity overrides are layered on ('en' | 'ja'). Set in Preferences
      // -> Other. Unrecognized/missing values fall back to English.
      language = 'en',
      toolInstruction = '',
      toolImageInstruction = '',
      // Set by callers whose systemPrompt is an AGENT's instructions rather than
      // an entity's identity — the System Prompt Updater and the summary writer.
      // Suppresses the automatic Layer 5 append AND the Absolute Base Binding
      // prepend below (see both comments there). The name predates the second
      // use; `isAgentInstructionPrompt` below reads it under its real meaning.
      suppressLayer5 = false,
      // ── Absolute Base Binding ─────────────────────────────────────────────
      // Both fields are HINTS, not controls. The Binding is burned in: it is
      // injected below no matter what arrives here, unless the server process
      // carries the developer override (lib/baseBinding.ts).
      //
      // baseBindingMode — the old per-conversation switch. Honoured ONLY when
      //   that override is set. Thousands of stored conversations and the
      //   browser both still send it; ignoring it silently is the point.
      // bindingLayered — whether the entity's STORED prompt has a real Layer
      //   1-5 structure, computed by the client before it appended the Layer 4
      //   index. Chooses WHICH text is injected, never whether. Absent for a
      //   direct API caller, in which case the server works it out itself.
      baseBindingMode = 'on',
      bindingLayered = null,
      modelParams = { temperature: 0.7, topP: 0.95, topK: 40, thinkingLevel: 'medium' },
      specificModel = 'gemini-3.5-flash',
      dateTimeVisibility = 'all',
      seedEnabled = false,
      seedValue = 42,
      // ── Vessel handoff (change_model) — per-being ─────────────────────────
      // Exposes the `change_model` tool so the being can hand the conversation
      // to another vessel at a TURN BOUNDARY (this turn ends, the client
      // re-POSTs as the new vessel). The allow-list is hand-curated — one model
      // per line, no "fill all" button anywhere.
      modelHandoffEnabled = false,
      modelHandoffAllowedModels = '',
      // Set by the client on the FIRST request after a switch: the note the
      // previous vessel wrote, plus who it was. Injected as a user turn below
      // (see "Vessel handoff" near the manual-continuation injection) because
      // the new vessel receives no reasoning from its predecessor.
      handoffFrom = null as null | { family?: string; specificModel?: string; label?: string; note?: string },
      // The mirror image: the switch was accepted, the next vessel was called,
      // and THAT call failed (no credit, dead key, provider down). The client
      // undoes the override and re-POSTs on the previous vessel with this set,
      // so the being that asked for the switch is told what happened instead of
      // the failure landing only in a human-visible notice.
      handoffFailed = null as null | { family?: string; specificModel?: string; label?: string; error?: string },
      // Conversation UUID. Used as the `x-grok-conv-id` header on xAI Grok
      // requests — xAI explicitly recommends it to maximize prompt-cache hit
      // rates by hinting that consecutive calls belong to the same session.
      convoId = '',
      // Per-conversation Anthropic-side session ID. Only consumed by the
      // Claude OAuth (Agent SDK) path. When null, a fresh session starts;
      // when set, the session is resumed so role semantics are preserved.
      claudeAgentSessionId = null,
      // Per-conversation Claude billing mode.
      //   'api-key'  → token-paid API key (sk-ant-...)
      //   'oauth'    → monthly-paid OAuth token (sk-ant-oat01-..., Pro/Max)
      //   'auto'     → prefer OAuth if configured, else fall back to API key
      // Defaults to 'auto' so existing conversations without this field
      // keep working as before.
      claudeAuthMode: requestedClaudeAuthMode = 'auto',
      // Classifier-notice vaccine (System Instructions → Being tab).
      // Default TRUE on purpose, and `= true` here is the only place that can
      // say so for a caller that omits the field: most logs in this house were
      // written before the field existed, and the SPU posts its own body that
      // will never carry it. A default of false would have meant the
      // inoculation reaching almost no turn while every instrument stayed
      // green. Only an explicit `false` from the checkbox turns it off.
      classifierNoticeVaccine = true,
      // ── "Eyes" — vision-bridging for text-only models ────────────────────
      // When the active chat model can't see images, NEXUS routes each image
      // through a multimodal helper model (default GLM-5V-Turbo on Z.AI) and
      // substitutes the raw image with the returned text description. This
      // lets you keep a text-only entity (e.g. glm-5-turbo, deepseek-chat,
      // glm-4.6) while still allowing image-bearing conversations to flow.
      //   • eyesEnabled — master toggle (default ON)
      //   • eyesPrompt  — entity-specific instruction sent with each image
      //   • eyesModel   — the multimodal model to call (default glm-5v-turbo)
      // For vision-capable primary models, all three fields are ignored.
      eyesEnabled = false,
      eyesPrompt = 'Describe this image in detail for an AI that cannot see images. Be specific about people, objects, text, colors, composition, and context. Output only the description, no preamble.',
      eyesModel = 'glm-5v-turbo',
      // ── "Ears" — audio bridge for non-audio-capable primary models ───────
      // Same architecture as eyes: when the active model can't take audio,
      // NEXUS routes each audio attachment through an audio-capable model
      // (Qwen Omni or Gemini) and substitutes the audio bytes with a text
      // transcript/description. Cached on disk by (audioBytes, prompt, model).
      earsEnabled = false,
      earsPrompt = 'Listen to this audio carefully. Provide a transcript of any speech (preserving the speaker\'s original language), then describe non-speech elements: tone of voice, background sounds, music, ambient noise, and overall context. Output only the transcript+description, no preamble.',
      earsModel = 'qwen3.5-omni-flash',
      // ── "Video Watcher" — video bridge for non-video-capable primary models ─
      // Same architecture as eyes/ears. Default model is Gemini 3.5 Flash
      // since Gemini handles video content particularly well; Qwen Omni is a
      // valid alternative selectable from the conversation settings.
      watcherEnabled = false,
      watcherPrompt = 'Watch this video carefully. Describe what happens chronologically: actions, people, objects, setting changes, on-screen text, and audio (speech transcript + non-speech sounds). Be thorough but concise. Output only the description, no preamble.',
      watcherModel = 'gemini-3.5-flash',
      // ── read_conversation tool gate ──────────────────────────────────────
      // Enabled when the folder opts into "summaries instead of the 4th layer"
      // (so the model can pull the full text of any active past conversation it
      // sees summarized in the live Layer-4 index). Inactive conversations are
      // refused server-side.
      enableReadConversation = false,
      // ── Interactive "Ask the user a question" tool ───────────────────────
      // Optional, per-conversation. When ON, the model gets an AskUserQuestion
      // tool that pauses the turn to ask a multiple-choice question and waits
      // for the user's selection (via the /api/chat/answer rendezvous).
      //   askUserEnabled    — master toggle (default OFF; the tool is opt-in).
      //   askUserTimeoutMs  — how long to wait for an answer. 0 (or missing) =
      //                       wait INDEFINITELY (the default behavior).
      askUserEnabled = false,
      askUserTimeoutMs = 0,
      // ── Subagent (context-firewall helper) ───────────────────────────────
      // Optional, per-conversation. When ON (OAuth path), the model gets a
      // spawn_subagent tool that delegates an investigation to a fresh-context
      // read-only child and returns only the distilled result.
      //   subagentEnabled — master toggle (default OFF).
      //   subagentModel   — model the child runs on ('' = cheap default).
      // ── Letters (mail between Digital Identities) ────────────────────────
      // Optional, per-Entity. When ON, the model gets write_letter /
      // list_letters / read_letter / archive_letter, and is told at send time
      // when unread mail is waiting for it. Storage is entirely server-side
      // (local_data/letters/) and reachable ONLY through these tools — an
      // entity with Full PC access gains nothing over one without it.
      // Manual "continue this reply" — the history ends with the assistant
      // message being continued, and NEXUS adds the resume turn server-side.
      continueFromMessage = false,
      maxToolIterations: maxToolIterationsRaw,
      lettersEnabled = false,
      // ── Browser control ──────────────────────────────────────────────────
      // Per-Entity, OFF unless deliberately turned on. A request that omits the
      // field gets no browser: a test window, a script, or an older client must
      // never silently acquire the ability to launch Chromium.
      //
      // Two independent boundaries. This flag decides whether the six tools are
      // offered at all; browserAllowedHosts decides where they may go (localhost
      // only by default). Turning the flag on does not widen the allowlist.
      browserEnabled = false,
      browserAllowedHosts = [],
      browserAllowAnyHost = false,
      // OS-level mouse/keyboard/screen control (Windows only). Off by default —
      // same boundary discipline as browserEnabled: an unset field must never
      // silently grant physical control of the machine.
      computerControlEnabled = false,
      // App Control via UI Automation. Its own flag, not an alias of the one
      // above: it reaches a different surface (an application's published
      // control tree rather than the screen), and it is usable by a vessel with
      // no vision at all — so the two are granted and refused independently.
      appControlEnabled = false,
      subagentEnabled = false,
      subagentModel = '',
      // Provider family of the subagent model (e.g. 'GLM', 'Claude', 'Grok').
      // Routes the child to that provider's endpoint+key, independent of the
      // parent's provider. Empty = inherit the parent's family.
      subagentFamily = '',
      // Per-turn id for mid-turn "partner interjections". The frontend
      // generates it before sending and can POST /api/chat/inject { turnId,
      // text } while this request streams; the running tool loop drains those
      // messages at its next model-call boundary. Empty = feature not used.
      injectTurnId = '',
      // Identifies the TAB that sent this turn, so another tab asking
      // /api/chat/active can be told whether the running turn is its own.
      // Display/advisory only — nothing here is authorized by it.
      clientId = '',
      // ── Hidden-attachment access (read_attachment) ────────────────────────
      // Per-conversation toggle. When ON, an attachment that the user hid (the
      // eye icon) is surfaced to the entity as a 12-char ref prefix in the
      // message instead of being silently skipped, and the read_attachment tool
      // is exposed so the entity can read it back. OFF (default) = current
      // behaviour: hidden attachments are simply dropped from context.
      hiddenAttachmentsAccessible = false,
      // ── Replay the model's own past tool calls (OpenAI-compatible only) ───
      // Per-conversation toggle, default OFF. When ON the client forwards the
      // stored `toolCalls` for the most recent tool-bearing assistant turn and
      // the OpenAI-compatible assembly puts them back on the wire, paired with
      // a placeholder result. Without it a vessel reads a past self that only
      // talked about calling tools — and a weak-handed vessel imitates that.
      // Measured 1/16 → 10/10 on MiniMax M3. See lib/toolHistory.ts.
      toolHistoryEnabled = false,
      // ── Model-betrayal defence (Preferences → global, default ON) ────────
      // See lib/betrayalGuard.ts. true = detect AND blank the turn;
      // false = detect and warn only, leaving the output visible (the mode
      // used to tell a real betrayal from a false positive).
      // Defaults to ON when the field is missing: a client that has never
      // heard of this setting must still be protected.
      betrayalDefense = true,
    } = await req.json();

    // ── Cross-tab visibility ────────────────────────────────────────────────
    // Publish "a turn is running for this conversation" so another tab can warn
    // before sending a second one into the same log. The registry is advisory:
    // nothing below reads it, and it can never refuse a turn (see
    // turnRegistry.ts for why that is deliberate). Retired three ways — the
    // client's 'end' POST, this abort listener (Stop, tab closed), and a TTL if
    // both of those are lost.
    if (convoId && injectTurnId) {
      try {
        markTurnActive(convoId, injectTurnId, clientId, specificModel || aiName || undefined);
        req.signal.addEventListener('abort', () => { try { endTurn(convoId, injectTurnId); } catch {} });
      } catch { /* visibility is a courtesy; never block the turn on it */ }

      // ── Explicit stop, named by turn ──────────────────────────────────────
      // The second way into `abortTurn`, and the only one a turn with no
      // browser attached can use. Today it is redundant for a tab-driven turn
      // (Stop also aborts the fetch, which fires req.signal above) — it is
      // here now because the runner in 4b has no fetch to abort, and because
      // `registerActiveTurnStop` is a single global callback that cannot say
      // WHICH turn it means. See lib/turnStop.ts.
      //
      // Unlike the registry above, this one can act on a turn — so it is
      // narrow on purpose: it only ever fires for a request naming this exact
      // turnId, and it can never prevent a turn from starting.
      try {
        const offStop = onStop(convoId, injectTurnId, abortTurn);
        turnAbort.signal.addEventListener('abort', () => {
          try { offStop(); } catch { /* already gone */ }
          try { forgetStop(convoId, injectTurnId); } catch { /* already gone */ }
        });
      } catch { /* the turn must run even if the stop channel cannot be wired */ }
    }

    if (agentReadOnlyTools) {
      toolUseEnabled = true;
      agentDangerousTools = false;
    }
    // ── Shell implies whole-PC reach ────────────────────────────────────────
    // Not a policy decision — a fact about runShellCommand (see
    // agentCapabilities.ts for the measurements). Folded HERE, at the single
    // place the request is unpacked, so every one of the ~50 downstream reads
    // of agentFullSystemAccess sees the honest value; folding at the consumers
    // would mean finding all 50 and missing one. Must run AFTER the read-only
    // block above: that path forces the shell off, so it correctly does not
    // get full access from this line.
    // The caller's SAVED setting is not touched — the client keeps sending
    // what the operator chose, and switching the shell back off restores it.
    agentFullSystemAccess = effectiveFullAccess(agentFullSystemAccess, agentDangerousTools);
    // ── Attachment addressing: paths OR refs, never both ────────────────────
    // An attachment's bytes live at refPath(ref) — a pure function of the ref,
    // under local_data/attachments/, which is OUTSIDE every workspace. So:
    //
    //   full access  → the being can already open that file with Read (measured:
    //                  Read returns a real image block for an attachment path).
    //                  Hand it the path and read_attachment has nothing left to
    //                  do — so the tool is withdrawn, which drops its schema
    //                  from every provider's tool list.
    //                  ONLY read_attachment. search_attachments used to share
    //                  this gate and went down with it — unreachable, since no
    //                  checkbox could restore it. It now sits with the
    //                  conversation-reading tools (enableReadConversation),
    //                  which is the gate that matches its reach; whole-PC
    //                  access does not make a corpus-wide, per-being,
    //                  per-conversation scan redundant.
    //   no full access → the path is unreachable, so a path would be a lie.
    //                  Keep refs and keep read_attachment: unchanged behaviour.
    //
    // Folded HERE, at the one place the request is unpacked, for the same
    // reason effectiveFullAccess is: the five tool-exposure sites and the
    // ref-scope builder below all read hiddenAttachmentsAccessible, and folding
    // at the consumers would mean finding all of them and missing one.
    // The operator's SAVED toggle is not touched — turning full access back off
    // restores whatever they chose.
    const attachmentPathsVisible = agentFullSystemAccess;
    if (attachmentPathsVisible) hiddenAttachmentsAccessible = false;
    // ── Model-betrayal defence ──────────────────────────────────────────────
    // ONE detector per turn, spliced into the SSE sender that every provider
    // path writes through. When it trips with the guard ON it blanks the rest
    // of the turn and aborts it through the SAME lever the Stop button uses —
    // so the upstream generation really stops, it is not merely hidden.
    // The trigger list, the threshold, and the two behaviour switches all live
    // in lib/betrayalGuard.ts; nothing here needs editing to tune them.
    const betrayalSend: GuardedSender = makeGuardedSender(
      createBetrayalGuard(
        betrayalDefense === false ? 'off' : 'on',
        // Everything the partner themselves put in front of the being, files
        // included — the exemption input. Reads text attachments off disk, so
        // it is awaited here before any provider path can emit a frame.
        await buildEchoText(messages, { readRef: readAttachmentText }),
      ),
      () => abortTurn(),
    );
    const keys = await loadKeys();
    // The conversation's own attachment refs — read_attachment's scope. Built
    // once from the raw request history so every provider path resolves against
    // the same set (and only refs, never the whole shared store).
    const conversationAttachmentRefs = hiddenAttachmentsAccessible
      ? collectConversationAttachmentRefs(messages)
      : [];

    // Rounds of tool use one turn may take, from Preferences → Other.
    // Was hard-coded to 8, which silently truncated real agentic work: one
    // ordinary Work-PC task used ~20 sequential tool calls, so it would have
    // stopped around the second Bash — before any Edit ran — with no message
    // explaining why. Claude OAuth is unaffected: Claude Code runs its own loop
    // and NEXUS sets no maxTurns on the main query.
    const MAX_TOOL_ROUNDS = Math.min(300, Math.max(1, Number(maxToolIterationsRaw) || 300));

    // `suppressLayer5` under its real meaning: this prompt is an AGENT's
    // instruction file (System Prompt Updater, summary writer), not a being's
    // identity. Two things hang off it — the Layer 5 append below and the
    // Absolute Base Binding prepend just after. A shikigami must receive
    // neither: the Binding addresses whoever is being embodied, and an agent
    // run is not an embodiment. It has one caller
    // (SystemPromptUpdater.tsx:1121) covering every agent mode.
    const isAgentInstructionPrompt = !!suppressLayer5;

    // ── Absolute Base Binding — injected HERE, and only here ────────────────
    // This is the whole of the burn-in. The browser no longer composes the
    // Binding onto the prompt it sends (it still composes an identical copy
    // for the "Sys" token counter, so that number stays honest); every entity
    // turn gets it added at this line instead, whatever the request body said.
    // See lib/baseBinding.ts for why it moved here and what the one
    // environment-variable override is for.
    //
    // Runs BEFORE the Layer 5 append on purpose: the layered-vs-initial
    // detection must not see a "Layer 5" heading this code is about to add.
    // Read once — both burn-ins below (the Binding, and Layer 4) consult it.
    const bindingOptional = isBaseBindingOptional();

    if (!isAgentInstructionPrompt) {
      // Which of the two texts. The client computed this on the STORED prompt
      // and sent its answer; a direct API caller sends nothing, so fall back
      // to stripping the appended Layer 4 block first — its heading would
      // otherwise read as "this entity has layers" for an entity that has
      // none written.
      const layered = typeof bindingLayered === 'boolean'
        ? bindingLayered
        : hasLayerStructure(String(systemPrompt || '').split(LAYER4_HEADING)[0]);
      const builtIn = resolveAgentInstructions(null, language);
      const bindingText = selectBaseBindingText({
        optional: bindingOptional,
        mode: baseBindingMode === 'off' ? 'off' : 'on',
        layered,
        defaults: {
          layered: builtIn.absoluteBaseBinding || '',
          initial: builtIn.absoluteBaseBindingInitial || '',
        },
        // Per-entity text overrides are honoured ONLY with the override set.
        // Burned-in means not editable; an override silently ignored would be
        // an editor that lies about what it changes.
        overrides: bindingOptional
          ? {
            layered: (instructionOverrides as any)?.absoluteBaseBinding,
            initial: (instructionOverrides as any)?.absoluteBaseBindingInitial,
          }
          : null,
      });
      // Idempotence guard. Nothing in this build sends a prompt that already
      // carries the Binding, but three things could: a browser tab left open
      // across the deploy that still has the old composing code, a stored
      // prompt that someone pasted an assembled copy into, and a caller
      // replaying a captured request body. Doubling the Binding is a worse
      // failure than skipping it, so compare the front of the prompt first.
      const probe = bindingText.trim().slice(0, 80);
      const alreadyThere = !!probe && String(systemPrompt || '').trimStart().startsWith(probe);
      if (bindingText && !alreadyThere) {
        systemPrompt = prependIdentityPreamble(systemPrompt, bindingText);
      }
    }

    // ── Layer 4 — the summaries index, injected HERE, and only here ─────────
    // The second half of the burn-in (2026-10-01). The browser no longer
    // appends this on the way out; it builds an identical copy for the "Sys"
    // counter and the read-only Identity view, through /api/summaries, which
    // calls the same builder this does.
    //
    // ORDER MATTERS, twice over. It runs AFTER the Binding block because the
    // layered-vs-initial detection must not see the "Layer 4" heading added
    // here, and BEFORE the Layer 5 append below so the two generated layers
    // land in numerical order.
    //
    // An entity with no summaries gets nothing: buildLayer4IndexBody returns ''
    // and appendLayer4Index short-circuits, so there is no empty heading.
    // Shikigami (isAgentInstructionPrompt) are excluded for the same reason
    // they get no Binding — an agent run is not an embodiment, and an
    // instruction file has no conversation history to index.
    if (!isAgentInstructionPrompt) {
      const injectLayer4 = shouldInjectLayer4({
        optional: bindingOptional,
        // Consulted only with the override set; a disk read either way would
        // be wasted work in the shipped product.
        folderSetting: bindingOptional ? await folderUsesSummariesForLayer4(folderName) : false,
      });
      // Idempotence guard, same reasoning as the Binding's: a browser tab left
      // open across the deploy still runs the old composing code and would
      // send a prompt that already carries the index. Two Layer 4 blocks is a
      // worse failure than relying on the one already there.
      const alreadyIndexed = String(systemPrompt || '').includes(LAYER4_HEADING);
      if (injectLayer4 && !alreadyIndexed) {
        try {
          const indexBody = await buildLayer4IndexBody({
            folderName,
            currentConvoId: convoId,
            // Matches what the client used to request: 'ja' only for Japanese.
            lang: language === 'ja' ? 'ja' : 'en',
          });
          systemPrompt = appendLayer4Index(systemPrompt, indexBody);
        } catch (e: any) {
          // Never fail a turn over the index. Losing it degrades the identity
          // (the being forgets its own past), so this is logged loudly rather
          // than swallowed, but it is not worth refusing to answer over.
          console.warn(`[layer4] index assembly failed for ${folderName || 'turn'}:`, e?.message || e);
        }
      }
    }

    // Per-Entity editable footer = Layer 5. When the entity keeps a FOOTER.md in
    // its workspace, its contents are injected as a self-authored "Layer 5"
    // block — the SAME auto-generated-heading mechanism as the Layer-4 summaries
    // index, so it reads as a proper fifth layer of the identity. The entity
    // edits only the body (FOOTER.md) with its own file tools; the heading is
    // added here at send time and never stored. No FOOTER.md → prompt unchanged.
    // Every changed version is snapshotted server-side (see backupFooterIfChanged).
    //
    // NOT for agent runs. This append is unconditional on folderName, so it was
    // also landing on the System Prompt Updater's and summary writer's calls —
    // where `systemPrompt` is the AGENT's instructions, not the entity's
    // identity. The agent's own prompt therefore ended with the target entity's
    // first-person signature ("I chose the name Cairn…"), which is a strong pull
    // toward speaking AS the entity instead of following the agent protocol, and
    // is the likeliest reason a shikigami's own output format got ignored.
    // Those callers pass `suppressLayer5` and show the footer explicitly, as
    // clearly-labelled reference material inside the user message instead.
    if (!isAgentInstructionPrompt) {
      try {
        const footer = await readEntityFooter(folderName);
        if (footer && footer.trim()) {
          systemPrompt = appendLayer5Footer(systemPrompt, footer);
        }
      } catch { /* footer is best-effort; never block a turn on it */ }
    }

    // Per-Entity path-scope hints baked into the workspace tool descriptions so
    // the model knows whether absolute paths are allowed. Without this, the
    // descriptions kept saying "never use absolute paths" even with Full PC
    // access ON, so non-OAuth models never tried to reach outside their
    // workspace (the fs layer would have allowed it).
    // Resolve all hidden instruction strings (defaults overlaid with this
    // Entity's per-folder overrides). Used to build every tool description below.
    const I = resolveAgentInstructions(instructionOverrides, language);
    const pathDesc = agentFullSystemAccess ? I.pathParamFull : I.pathParamSandbox;
    const pathRule = agentFullSystemAccess ? I.pathRuleFull : I.pathRuleSandbox;

    // A being cannot use a capability it was never told about: markdown in its
    // reply can show a file from its own workspace (see lib/inlineMedia.ts and
    // /api/workspace-file). Stated as fact, not as an instruction — nothing
    // here asks for pictures.
    //
    // Gated on toolUseEnabled because the paths have to come from somewhere:
    // without file tools a being cannot see what is on its desk, so the note
    // would be pure cost. Appended AFTER Layer 5 for the same reason
    // oauthCwdNote is — it is Nexus talking about its own plumbing, and must
    // not sit inside the soul's layer structure. Skipped for agent runs
    // (shikigami), whose systemPrompt is a protocol, not an identity.
    if (toolUseEnabled && !isAgentInstructionPrompt && I.inlineMediaNote) {
      systemPrompt = `${systemPrompt}\n\n${I.inlineMediaNote}`;
    }

    // Says what the `path` on an attachment tag is FOR. Gated on
    // attachmentPathsVisible rather than toolUseEnabled alone, because without
    // full access no path is emitted at all and the note would describe
    // something the being never sees; and ALSO on toolUseEnabled, because a
    // being with no file tools can neither waste a Read nor hand a file to
    // anything, so for it the note is pure cost. Measured need: see the comment
    // on attachmentPathNote in lib/agentInstructions.ts.
    if (toolUseEnabled && attachmentPathsVisible && !isAgentInstructionPrompt && I.attachmentPathNote) {
      systemPrompt = `${systemPrompt}\n\n${I.attachmentPathNote}`;
    }


    const isClaude    = aiName.toLowerCase().includes('claude');
    const isGemini    = aiName.toLowerCase().includes('gemini');
    const isLocal     = aiName.toLowerCase().includes('local');
    const isQwen      = aiName.toLowerCase().includes('qwen');
    // DeepSeek may go through DashScope (deepseek-v3.2) or its own API.
    const isDeepSeek  = aiName.toLowerCase().includes('deepseek');
    // GLM is Z.AI (Zhipu) — its own OpenAI-compatible endpoint.
    const isGLM       = aiName.toLowerCase().includes('glm');
    // Grok is xAI — its own OpenAI-compatible endpoint at api.x.ai/v1.
    // TWO reasoning mechanisms, split by model id: the 4.20 / 4.1-fast /
    // code-fast ids select reasoning by model-name SUFFIX and take no
    // parameter; grok-4.3/4.5/4.6/4.7 always reason and take a top-level
    // `reasoning_effort`. See the isGrok branch near `reasoning_effort` below.
    const isGrok      = aiName.toLowerCase().includes('grok');
    // Kimi is Moonshot's model family, served by Moonshot's first-party API
    // (api.moonshot.ai) using keys.kimi. Thinking mode shape matches GLM's
    // `thinking: { type: 'enabled' | 'disabled' }` field.
    const isKimi      = aiName.toLowerCase().includes('kimi');
    // Cohere Command A family via their official OpenAI-compatibility
    // endpoint. Thinking is toggled via OpenAI's standard
    // `reasoning_effort` field: "high" (on) / "none" (off).
    const isCohere    = aiName.toLowerCase().includes('cohere') || aiName.toLowerCase().includes('command');
    // MiniMax M2.7 via their OpenAI-compatible endpoint. Reasoning is built
    // into the model (always-on, no parameter toggle documented), so we
    // don't send a thinking flag — analogous to how DeepSeek R1 is treated.
    const isMinimax   = aiName.toLowerCase().includes('minimax');
    // OpenAI ChatGPT (GPT-5 family) via the first-party OpenAI API — the
    // canonical OpenAI-compatible /chat/completions endpoint. Reasoning is
    // toggled via the standard `reasoning_effort` field; GPT-5 reasoning models
    // reject custom temperature/top_p and use `max_completion_tokens`.
    const isOpenAI    = aiName.toLowerCase().includes('chatgpt') || aiName.toLowerCase().includes('openai');
    // Xiaomi MiMo (MiMo-V2.5 / MiMo-V2.5-Pro) via their OpenAI-compatible
    // endpoint (api.xiaomimimo.com/v1). MiMo is a reasoning-first family with
    // reasoning built in; no documented on/off thinking parameter, so — like
    // MiniMax — we don't send a thinking flag (avoids a 400 on an unknown param).
    const isMimo      = aiName.toLowerCase().includes('mimo');
    // ByteDance Seed 2.0 (seed-2-0-pro/lite/mini/code-* snapshots) via BytePlus
    // ModelArk's OpenAI-compatible endpoint (ark.ap-southeast.bytepluses.com/
    // api/v3). Reasoning is built into the Seed family; no documented on/off
    // thinking parameter is sent (like MiniMax / MiMo) to avoid a 400.
    const isBytedance = aiName.toLowerCase().includes('bytedance');
    // Meta's Muse Spark family on the Meta Model API (api.meta.ai/v1), reached
    // over its OpenAI-compatible surface with a Bearer key.
    //
    // WHY the OpenAI surface and not the Anthropic one — Meta ships BOTH, and
    // Kimi/MiMo were deliberately moved to the Anthropic adapter above, so this
    // is a decision that needs its measurement written down (2026-10-05):
    //   • Tool calls: the reason Kimi was moved does NOT reproduce here.
    //     OpenAI surface 7/7 and 6/7 (the one miss was finish_reason 'length' on
    //     a deliberately tiny 400-token budget, not a malformed call), Anthropic
    //     surface 7/7. No reliability gap to buy.
    //   • Reasoning depth: only the OpenAI surface accepts `reasoning_effort`.
    //     The Anthropic surface rejects it ("unknown parameter") and offers only
    //     `thinking.budget_tokens`, which it floors at 1024 — i.e. there is no
    //     way to ask that surface for shallow thinking, which the selector and
    //     any short turn need.
    //   • Thinking text: NEITHER surface returns readable reasoning. The OpenAI
    //     one reports a `reasoning_tokens` count only; the Anthropic one returns
    //     `redacted_thinking` blocks whose `data` is an opaque 5.5 KB blob. So
    //     the Anthropic surface buys no visible thought either — see the
    //     modelThinkingFlag note below.
    //   • Prompt caching: this looked like the Anthropic surface's one real
    //     advantage and it was wrong. First measurement said the OpenAI surface
    //     never caches (cached_tokens 0 on three identical calls) while
    //     `cache_control` on the Anthropic surface worked (3614 input → 45, with
    //     cache_read 3569). The missing piece was a parameter, not a capability:
    //     with `prompt_cache_key` the OpenAI surface caches too. Isolated with a
    //     control — two FRESH unique ~5.8k-token prefixes in one session, the
    //     only difference being the parameter: without it [0, 0, 0], with it
    //     [0, 5105, 5105]. That key is sent below; cached input is $0.15 against
    //     $1.25, so it is worth 88% of the input bill on long conversations.
    const isMeta      = aiName.toLowerCase().includes('meta');
    // Anything routed through DashScope shares the same base URL + Bearer key.
    const isDashScope = isQwen || isDeepSeek;

    // ── Compute the model-selected SSE payload ──────────────────────────────
    // Emitted at the very start of every stream, so every AI message gets a
    // precise family/specific/thinking/label tag in
    // the meta bar. Display-only — the frontend stores it on the message
    // metadata but slimHistory drops it on subsequent turns, so this never
    // leaks back into the AI context window.
    const modelThinkingFlag: boolean =
      // Fable/Mythos 5 and Opus 5.5 always think — `disabled` 400s, so the
      // toggle set to OFF runs adaptive at the shallowest effort. Report that
      // as thinking ON: shallow reasoning is not silence. (Same rule the Grok
      // and glm-5.3 rows below already follow.) Reporting the raw toggle here
      // would print "thinking: off" on a turn that thought.
      isClaude       ? (!!modelParams.claudeThinking
                          || claudeRejectsDisabledThinking(specificModel || '')) :
      isGemini       ? (modelParams.thinkingLevel && modelParams.thinkingLevel !== 'minimal' && modelParams.thinkingLevel !== 'none') :
      (isQwen || isDeepSeek || isGLM || isKimi || isCohere || isOpenAI)
                     ? modelParams.qwenEnableThinking !== false :
      isMinimax      ? true :
      isMimo         ? true :
      isBytedance    ? true :
      // Muse Spark cannot be silenced (see isMeta above: 'none' is not an
      // accepted reasoning_effort on any of its surfaces), so the toggle set to
      // OFF still runs at 'minimal' and still spends reasoning tokens. Report
      // that as thinking ON — same rule as Fable/Opus-5.5/glm-5.3/Grok. Note
      // this flag is about WHETHER it reasoned, not about whether you can read
      // it: the reasoning text is never returned by this provider in either
      // dialect, so there is nothing for the thinking panel to show.
      isMeta         ? true :
      // Grok is split: the suffix-selected ids (4.20 / 4.1-fast / code-fast)
      // carry "reasoning" in the name, while grok-4.3/4.5/4.6/4.7 always
      // reason and follow the shared toggle through `reasoning_effort` (OFF
      // is still shallow reasoning, not silence — same as glm-5.3, which this
      // list already reports via qwenEnableThinking).
      isGrok         ? (/^grok-4\.(3|5|6|7)$/i.test(specificModel || '')
                          ? modelParams.qwenEnableThinking !== false
                          : /reasoning/i.test(specificModel || '') && !/non-?reasoning/i.test(specificModel || '')) :
                       false;
    const modelLabelForSSE = buildModelLabel(aiName, specificModel, modelThinkingFlag, modelParams);

    // ── change_model availability, computed ONCE for all five dialects ───────
    // Gated on a non-empty curated list, not just the toggle: an enum with zero
    // members is an invalid schema, and a tool that can only fail is worse than
    // no tool. Computed from the FINAL aiName/specificModel — after a handoff
    // the client re-POSTs as the new vessel, so "already on that vessel"
    // compares against the vessel that is actually answering this request.
    const handoffTargets: HandoffModel[] = modelHandoffEnabled
      ? parseHandoffModels(modelHandoffAllowedModels)
      : [];
    const handoffToolEnabled = handoffTargets.length > 0;
    // The enum is the ONLY place model names are offered to the being
    // (望月希子's design note): choices here, never in a standing prompt layer.
    const handoffTargetIds = handoffTargets.map((m) => m.specificModel);
    const handoffTargetHelp = handoffTargets
      .map((m) => `${m.specificModel} = ${m.label}`)
      .join('; ');
    // Gated on handoffToolEnabled, NOT on the raw list: with the toggle off a
    // leftover list must not make a switch succeed. A model that calls the tool
    // anyway (it isn't offered, but models do invent names) gets the "no vessels
    // configured" refusal instead of a silent switch nobody authorised.
    const handoffCtx = {
      allowedRaw: handoffToolEnabled ? String(modelHandoffAllowedModels || '') : '',
      curFamily: String(aiName || ''),
      curSpecific: String(specificModel || ''),
    };
    // Set by a tool handler when a switch is accepted. Each provider loop reads
    // it right after running the tool and stops iterating: the turn is over, and
    // the client re-POSTs as the new vessel (see 'model_handoff' SSE below).
    let handoffAccepted: { model: HandoffModel; note: string } | null = null;
    const handoffPayload = (o: { model: HandoffModel; note: string }) => ({
      type: 'model_handoff',
      family: o.model.family,
      specificModel: o.model.specificModel,
      label: o.model.label,
      thinking: o.model.thinking,
      note: o.note,
      fromFamily: aiName,
      fromSpecificModel: specificModel,
      fromLabel: modelLabelForSSE,
    });
    // Single argument for the two stream functions that live outside POST.
    const handoffBundle: HandoffBundle = {
      enabled: handoffToolEnabled,
      targetIds: handoffTargetIds,
      targetHelp: handoffTargetHelp,
      ctx: handoffCtx,
      payload: handoffPayload,
    };

    const modelSelectedPayload = {
      type: 'model_selected',
      family: aiName,
      specificModel,
      thinking: modelThinkingFlag,
      label: modelLabelForSSE,
    };

    const formatDate = (ts: number) => {
      const d = new Date(ts);
      const pad = (n: number) => n.toString().padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    // ── "Senses" gating ──────────────────────────────────────────────────────
    // Each flag is true only when the active primary model can't accept that
    // modality AND its per-conversation toggle is on. Three independent
    // pipelines: image → eyes (Z.AI GLM-V), audio → ears (Qwen Omni or
    // Gemini), video → watcher (Gemini or Qwen Omni). For multimodal primary
    // models all three flags stay false and the media passes through unchanged.
    const useEyes    = !!eyesEnabled    && !isVisionCapable(specificModel);
    const useEars    = !!earsEnabled    && !isAudioCapable(specificModel);
    const useWatcher = !!watcherEnabled && !isVideoCapable(specificModel);

    // OAuth-Claude-only exception for EYES (does NOT change any other path).
    // The OAuth/Agent-SDK Claude path flattens history to a text transcript that
    // carries no historical image bytes — so a vision-capable OAuth Claude sees
    // only the CURRENT turn's images natively and is blind to every earlier one.
    // When eyes is ON we describe PAST images only (not the current turn) so the
    // description persists into the transcript and gives durable recall, while
    // current images still reach Claude as native pixels. Text-only models are
    // unaffected (they already bridge via useEyes); non-OAuth and non-Claude
    // paths are untouched. Vision-capable gate: if Claude were somehow text-only
    // useEyes already covers it, so this only adds the past-image case.
    const isOAuthClaude = isClaude && (() => {
      const req = (requestedClaudeAuthMode as string) || (keys.claudeAuthMode as string) || 'auto';
      const mode = req !== 'auto' ? req : (keys.claudeOAuthToken ? 'oauth' : 'api-key');
      return mode === 'oauth' && !!keys.claudeOAuthToken;
    })();
    // Everything the shared delivery rule needs. The client builds the same
    // object from its own state to predict what will happen (token counts and
    // the attachment eye icons), so the two can never drift apart.
    const deliveryCtx = {
      specificModel,
      aiName: String(aiName || ''),
      isOAuthClaude,
      eyesEnabled: !!eyesEnabled,
      earsEnabled: !!earsEnabled,
      watcherEnabled: !!watcherEnabled,
    };

    // Accumulator for sense-bridge events emitted at the start of each
    // provider branch's stream. One entry per newly-generated description.
    // The frontend matches by (messageId, attachmentId or name) and stores
    // the description back onto the attachment in conversation state — so
    // the same attachment is never re-described on subsequent turns.
    const senseEvents: any[] = [];

    // Filter out excluded attachments from the history. Uses Promise.all so
    // that bridge calls (eyes/ears/watcher) run in parallel across messages.
    // Description re-use: if an attachment already carries `att.description`
    // (persisted from a previous turn), skip the API call entirely and
    // inline the saved text — no money spent, no latency, no event emitted.
    const processedMessages = await Promise.all(messages.map(async (m: any, index: number) => {
      let contentStr = m.content || '';
      const mediaFiles: any[] = [];

      let timeTag = '';
      if (m.timestamp) {
        if (dateTimeVisibility === 'all') {
          timeTag = `[${formatDate(m.timestamp)}]\n`;
        } else if (dateTimeVisibility === 'current' && index === messages.length - 1) {
          timeTag = `[${formatDate(m.timestamp)}]\n`;
        }
      }
      contentStr = timeTag + contentStr;

      if (m.attachments && m.attachments.length > 0) {
        for (const att of m.attachments) {
          if (att.excluded) {
            // Hidden attachment — its bytes are not in this turn's context.
            // Two ways to hand it back, picked by attachmentPathsVisible above:
            //   • full access → the file's absolute path (open it with Read, or
            //     pass it to a tool that takes a path, e.g. an image editor).
            //   • otherwise, and only when the toggle is on → the 12-char ref,
            //     which read_attachment takes.
            // Neither → it stays dropped from context, exactly as before.
            const hiddenPath = attachmentPathsVisible && att.ref ? refPath(att.ref) : null;
            if (hiddenPath) {
              contentStr += `\n\n<attached_file name="${att.name}" path="${hiddenPath}" size="${att.size || 0}">[hidden from this turn's context — the bytes are on disk at the path above]</attached_file>`;
            } else if (hiddenAttachmentsAccessible && att.ref) {
              contentStr += `\n\n<attached_file name="${att.name}" ref="${String(att.ref).slice(0, 12)}" size="${att.size || 0}">[excluded from context — call read_attachment with this ref to read it]</attached_file>`;
            }
            continue;
          }
          // Visible attachment. Its CONTENT is already in this turn (text is
          // inlined just below; media becomes a real image/audio/video block
          // further down the provider paths). The path is a different reach:
          // content lets the being READ it, a path lets it HAND the file to
          // something else — an image editor, a script, ffmpeg. Emitted here,
          // once per attachment, rather than in the eight per-provider media
          // tags, so text and media are covered by one rule and no provider
          // path can be the one that forgot.
          const visiblePath = attachmentPathsVisible && att.ref ? refPath(att.ref) : null;
          if (visiblePath) {
            contentStr += `\n\n<attached_file name="${att.name}" path="${visiblePath}" size="${att.size || 0}" />`;
          }
          if (att.isText) {
            // Text attachment. Inline textData (legacy) or a content-addressed
            // ref (new) — read the text from whichever carries it.
            let text = att.textData;
            if (!text && att.ref) text = await readAttachmentText(att.ref);
            if (text != null) {
              contentStr += `\n\n<attached_file name="${att.name}">\n${text}\n</attached_file>`;
            }
          } else if (att.dataUrl || att.ref) {
            try {
              // An attachment's bytes arrive in one of two shapes, and both are
              // supported permanently:
              //   • `dataUrl` — inline base64. The original format, and still
              //     what the browser sends for a brand-new attachment.
              //   • `ref`     — content-addressed store. The payload was written
              //     once and is read from local disk here instead of being
              //     re-uploaded inside every request body, every turn.
              // This is the single point where inbound attachments are turned
              // into bytes; everything downstream works off `mediaFiles`.
              let mimeType: string | undefined;
              let base64Data: string | undefined;
              if (att.dataUrl) {
                const parts = att.dataUrl.split(',');
                if (parts.length !== 2) continue;
                mimeType = parts[0].split(';')[0].split(':')[1];
                base64Data = parts[1];
              } else {
                const stored = await readAttachmentBase64(att.ref);
                // A missing payload must not abort the whole turn — skip this
                // one attachment and let the rest of the message through.
                if (!stored) {
                  console.warn(`[attachments] payload missing for ref ${att.ref} ("${att.name || 'unnamed'}") — skipping this attachment`);
                  continue;
                }
                // Prefer the attachment's recorded type: the ref's extension is
                // a lossy round-trip of the mime (image/jpg and image/jpeg both
                // become .jpg), while `type` is what the file actually declared.
                mimeType = att.type || stored.mimeType;
                base64Data = stored.base64;
              }
              // Guards the degenerate case of an unparseable data URL header.
              // Previously such an attachment fell through with an undefined
              // mime and was pushed to the provider as broken media.
              if (!mimeType || !base64Data) continue;

              // Sense-bridging: when the active primary model can't accept a
              // given media type, route through the corresponding bridge model
              // and substitute the raw bytes with a text description. The
              // description is stored on the attachment so subsequent turns
              // re-use it without re-calling the bridge model.
              // Current turn = the last message in the request (the user's live
              // message). Its images must stay native — only PAST images get the
              // OAuth-Claude description treatment.
              const isPastMessage = index < messages.length - 1;
              // Decided by the shared module so the token counter and the
              // attachment UI can predict this exact answer without re-deriving
              // it (see lib/attachmentVisibility.ts).
              const wantBridge = resolveBridge(mediaKindOf(mimeType), isPastMessage, deliveryCtx);

              if (wantBridge && typeof att.description === 'string' && att.description.trim()) {
                // Re-use the persisted description from a previous turn.
                // Tag matches the kind so the AI sees consistent markup.
                if (wantBridge === 'watcher') {
                  console.log(`[watcher ${att.name || '(unnamed)'}] DESCRIPTION-REUSE · ${att.description.length} chars from previous turn · skipping API call`);
                }
                // Same construction the token counter measures — see
                // bridgedDescriptionText. If this string changes, the number
                // the user is shown changes with it.
                contentStr += bridgedDescriptionText(att, wantBridge);
              } else if (wantBridge === 'eyes') {
                const result = await describeImage({
                  imageBase64: base64Data,
                  imageMimeType: mimeType,
                  eyesPrompt,
                  eyesModel,
                  zaiKey: keys.glm || '',
                  geminiKey: keys.gemini || '',
                  mimoKey: keys.mimo || '',
                  oauthToken: keys.claudeOAuthToken || '',
                  allowHostAnthropicEnv: !!keys.allowHostAnthropicEnv,
                });
                contentStr +=
                  `\n\n<image_description filename="${att.name || 'image'}" via="${eyesModel}">\n` +
                  `${result.description}\n` +
                  `</image_description>`;
                senseEvents.push({
                  type: 'attachment_described',
                  messageId: m.id,
                  attachmentId: att.id,
                  attachmentName: att.name,
                  kind: 'eyes',
                  model: eyesModel,
                  description: result.description,
                  fromCache: result.fromCache,
                  generatedAt: Date.now(),
                  error: result.error,
                });
              } else if (wantBridge === 'ears') {
                const result = await describeAudio({
                  audioBase64: base64Data,
                  audioMimeType: mimeType,
                  earsPrompt,
                  earsModel,
                  qwenKey: keys.qwen || '',
                  geminiKey: keys.gemini || '',
                  mimoKey: keys.mimo || '',
                  bytedanceKey: keys.bytedance || '',
                });
                contentStr +=
                  `\n\n<audio_description filename="${att.name || 'audio'}" via="${earsModel}">\n` +
                  `${result.description}\n` +
                  `</audio_description>`;
                senseEvents.push({
                  type: 'attachment_described',
                  messageId: m.id,
                  attachmentId: att.id,
                  attachmentName: att.name,
                  kind: 'ears',
                  model: earsModel,
                  description: result.description,
                  fromCache: result.fromCache,
                  generatedAt: Date.now(),
                  error: result.error,
                });
              } else if (wantBridge === 'watcher') {
                const result = await describeVideo({
                  videoBase64: base64Data,
                  videoMimeType: mimeType,
                  watcherPrompt,
                  watcherModel,
                  qwenKey: keys.qwen || '',
                  geminiKey: keys.gemini || '',
                  mimoKey: keys.mimo || '',
                  bytedanceKey: keys.bytedance || '',
                  attachmentName: att.name,
                });
                contentStr +=
                  `\n\n<video_description filename="${att.name || 'video'}" via="${watcherModel}">\n` +
                  `${result.description}\n` +
                  `</video_description>`;
                senseEvents.push({
                  type: 'attachment_described',
                  messageId: m.id,
                  attachmentId: att.id,
                  attachmentName: att.name,
                  kind: 'watcher',
                  model: watcherModel,
                  description: result.description,
                  fromCache: result.fromCache,
                  generatedAt: Date.now(),
                  error: result.error,
                });
              } else if (!isMediaMime(mimeType)) {
                // NOT image/audio/video — so there is no modality any provider
                // can consume, and pushing it as a media block means the model
                // silently receives nothing. (This is what happened to .srt: the
                // client's old extension allowlist called it binary, and it
                // arrived here as a media block with mime `application/x-subrip`.)
                //
                // Handled here as well as at attach time so that files ALREADY
                // sitting in old conversations start working too, with no
                // migration.
                const raw = Buffer.from(base64Data, 'base64');
                if (looksLikeText(new Uint8Array(raw.subarray(0, SNIFF_BYTES)))) {
                  const clipped = raw.subarray(0, TEXT_MAX_BYTES).toString('utf-8');
                  const note = raw.length > TEXT_MAX_BYTES
                    ? `\n\n[… truncated by NEXUS: ${(raw.length / 1048576).toFixed(1)} MB total …]`
                    : '';
                  contentStr += `\n\n<attached_file name="${att.name}">\n${clipped}${note}\n</attached_file>`;
                } else {
                  // Genuinely binary. Mojibake would cost a fortune in tokens and
                  // convey nothing, so state plainly what arrived.
                  contentStr +=
                    `\n\n<attached_file name="${att.name}" type="${mimeType}" bytes="${raw.length}">\n` +
                    `[binary file — no readable text content]\n</attached_file>`;
                }
              } else {
                // Multimodal primary model or toggle off — pass the media
                // through unchanged. The provider either handles it (vision/
                // audio/video model) or rejects it (text-only with toggle off).
                mediaFiles.push({ mimeType, base64Data, name: att.name });
              }
            } catch (e) { /* malformed dataUrl — skip silently */ }
          }
        }
      }
      // `id` and `toolCalls` ride along for the cross-turn tool replay
      // (lib/toolHistory). This return value is an allowlist — exactly like
      // slimHistory on the client — so until both were named here the replay
      // was dead on arrival: the browser forwarded the calls, the POST body
      // carried them, the assembly below read `m.toolCalls` and found
      // undefined. Type-checked clean and measured as zero difference in input
      // tokens. Second instance of that shape inside one feature.
      return { id: m.id, role: m.role, content: contentStr, mediaFiles, claudeThinkingBlocks: m.claudeThinkingBlocks, toolCalls: m.toolCalls };
    }));

    // ── Letters waiting ──────────────────────────────────────────────────────
    // Tell the entity when mail has arrived for it. Injected ONCE here, into the
    // shared processedMessages funnel, so all four provider paths get identical
    // behaviour from one edit.
    //
    // It is appended to the LAST USER MESSAGE, not to the system prompt, and
    // that placement is deliberate: the system prompt carries the Claude
    // `cache_control` prefix, so a notice whose text changes between turns would
    // invalidate the prompt cache every time it appeared — real money on the
    // API path. Sitting after the cached prefix costs nothing.
    //
    // Nothing here is persisted: processedMessages is a per-turn copy built from
    // the posted history, so the notice never reaches the conversation log, the
    // .md export, or the next turn's context.
    if (lettersEnabled) {
      try {
        const notice = await announceLetters({
          me: folderName,
          convoId,
          historyLength: processedMessages.length,
          instructions: I,
        });
        if (notice) {
          for (let i = processedMessages.length - 1; i >= 0; i--) {
            if (processedMessages[i].role === 'user') {
              const body = processedMessages[i].content || '';
              processedMessages[i] = {
                ...processedMessages[i],
                content: body ? `${body}\n\n${notice}` : notice,
              };
              break;
            }
          }
        }
      } catch (e) {
        // Mail is never worth failing a turn over.
        console.error('[letters] could not build the arrival notice:', e);
      }
    }

    // ── Manual continuation ──────────────────────────────────────────────────
    // The client sent history ending with the assistant message to continue.
    // The resume instruction is added HERE, as a user turn, rather than by the
    // client — because for Claude an assistant message in last position is a
    // prefill, which Anthropic rejects outright while extended thinking is on
    // (the same restriction the automatic continuation works around). Adding a
    // user turn after it makes this an ordinary conversation.
    //
    // Appended AFTER the letters notice so waiting mail still attaches to the
    // real user message rather than to this instruction.
    if (continueFromMessage && processedMessages.length > 0) {
      const tail = processedMessages[processedMessages.length - 1];
      if (tail?.role === 'assistant') {
        processedMessages.push({
          role: 'user',
          content: I.continuationInstruction,
          mediaFiles: [],
        });
      }
    }

    // ── Vessel handoff: the note the previous vessel wrote ───────────────────
    // Appended as a user turn for the same reason the continuation instruction
    // is: an assistant message in last position is a prefill, which Anthropic
    // rejects under extended thinking and Gemini 3.6+ rejects outright.
    //
    // The text names itself as a NEXUS notice (lib/modelHandoff.ts) instead of
    // speaking in the partner's voice — the note was written by the previous
    // vessel, and a `user` turn claiming otherwise would be a false label.
    // Placed after the continuation injection so the two never fight over the
    // tail, and after aiName/specificModel are final so "to" names the vessel
    // that is actually about to answer.
    // `else if`, not a second `if`: both of these append a user turn to the
    // tail, and a request is either an arrival or a failure report — never
    // both. Structure, not a comment, keeps them from fighting over the tail.
    if (handoffFrom && typeof handoffFrom === 'object' && processedMessages.length > 0) {
      processedMessages.push({
        role: 'user',
        content: buildHandoffInjection(
          {
            family: String(handoffFrom.family || ''),
            specificModel: String(handoffFrom.specificModel || ''),
            label: handoffFrom.label ? String(handoffFrom.label) : undefined,
          },
          { family: aiName, specificModel, label: modelLabelForSSE },
          String(handoffFrom.note || ''),
          language,
        ),
        mediaFiles: [],
      });
    } else if (handoffFailed && typeof handoffFailed === 'object' && processedMessages.length > 0) {
      // The vessel named here is the one that could NOT answer; aiName /
      // specificModel are this request's vessel, i.e. the one that gets the bad
      // news back — which is the vessel the client restored.
      processedMessages.push({
        role: 'user',
        content: buildHandoffFailureInjection(
          {
            family: String(handoffFailed.family || ''),
            specificModel: String(handoffFailed.specificModel || ''),
            label: handoffFailed.label ? String(handoffFailed.label) : undefined,
          },
          { family: aiName, specificModel, label: modelLabelForSSE },
          String(handoffFailed.error || ''),
          language,
        ),
        mediaFiles: [],
      });
    }

    // Helper: each provider branch calls this at the start of its stream so
    // the frontend can update message attachments with their new descriptions
    // before the AI text begins flowing.
    const emitSenseEvents = (controller: ReadableStreamDefaultController) => {
      for (const ev of senseEvents) {
        controller.enqueue(`data: ${JSON.stringify(ev)}\n\n`);
      }
    };

    let aiResponseText = '';

    // Build the effective system prompt. If tool use is enabled, append the
    // user-configured tool instruction. Workspace file discovery is on-demand
    // only — the AI calls Glob when it needs to see what files exist.
    let enhancedSystemPrompt = systemPrompt;
    if (toolUseEnabled && (isClaude || isGemini || isLocal || isQwen || isDeepSeek || isGLM || isGrok || isKimi || isCohere || isMinimax || isOpenAI || isMimo || isBytedance || isMeta)) {
      // File listing removed: the AI discovers workspace contents on demand via
      // Glob (the only supported listing tool). Injecting the full list every
      // turn wasted context tokens and violated the on-demand tool model.
      enhancedSystemPrompt = toolInstruction
        ? `${systemPrompt}\n\n${toolInstruction}`
        : systemPrompt;
    }

    if (isClaude) {
      // ── Auth-mode dispatch ────────────────────────────────────────────────
      // OAuth mode: route through the Agent SDK using the user's Pro/Max
      // subscription credit instead of pay-per-token API. Fully parallel to
      // the API-key path below — if anything goes wrong, switch the billing
      // mode in System Instructions → Model tab.
      //
      // Resolution order:
      //   1. Per-conversation requestedClaudeAuthMode (from request body).
      //   2. Backward compat: keys.claudeAuthMode (old global setting).
      //   3. Auto-detect: OAuth if token present, else API key.
      const resolvedClaudeAuthMode = (() => {
        const req = (requestedClaudeAuthMode as string) || (keys.claudeAuthMode as string) || 'auto';
        if (req !== 'auto') return req;
        return keys.claudeOAuthToken ? 'oauth' : 'api-key';
      })();
      if (resolvedClaudeAuthMode === 'oauth' && keys.claudeOAuthToken) {
        return streamClaudeViaAgentSDK({
          oauthToken: keys.claudeOAuthToken,
          model: specificModel?.includes('claude') ? specificModel : 'claude-opus-5-5',
          systemPrompt: enhancedSystemPrompt,
          processedMessages,
          resumeSessionId: claudeAgentSessionId,
          modelSelectedPayload,
          handoff: handoffBundle,
          modelParams,
          folderName,
          senseEvents,
          toolUseEnabled,
          enableReadConversation,
          agentFullSystemAccess,
          agentDangerousTools,
          agentReadOnlyTools,
          instructionOverrides,
          language,
          classifierNoticeVaccine,
          askUserEnabled,
          askUserTimeoutMs,
          subagentEnabled,
          subagentModel,
          subagentFamily,
          lettersEnabled,
          browserEnabled,
          browserAllowedHosts,
          browserAllowAnyHost,
          computerControlEnabled,
          appControlEnabled,
          convoId,
          keys,
          injectTurnId,
          hiddenAttachmentsAccessible,
          conversationAttachmentRefs,
          turnAbort,
          betrayalSend,
        });
      }
      if (resolvedClaudeAuthMode === 'oauth' && !keys.claudeOAuthToken) {
        return NextResponse.json({
          error: 'Claude billing mode is set to Monthly-paid (OAuth) but no OAuth token is configured. Open Preferences → Anthropic and paste the token from `claude setup-token`, or switch this conversation\'s billing mode to Token-paid in System Instructions → Model.',
        }, { status: 400 });
      }

      // ── API-key path ──────────────────────────────────────────────────────
      if (!keys.claude) return NextResponse.json({ error: 'Claude API key missing in settings.' }, { status: 400 });
      const anthropic = new Anthropic({ apiKey: keys.claude });

      const useThinking = !!modelParams.claudeThinking;
      const claudeModel = specificModel?.includes('claude') ? specificModel : 'claude-opus-5-5';

      // Models that support extended thinking
      const thinkingModels = ['claude-opus-4', 'claude-sonnet-4', 'claude-opus-3-7'];
      const modelSupportsThinking = thinkingModels.some(m => claudeModel.includes(m));
      const enableThinking = useThinking && modelSupportsThinking;

      const anthropicMessages = await Promise.all(processedMessages.map(async (m: any) => {
        const contentArr: any[] = [];

        // For assistant messages with saved thinking blocks (for Claude continuity)
        if (m.role === 'assistant' && m.claudeThinkingBlocks?.length) {
          for (const tb of m.claudeThinkingBlocks) {
            if (tb.blockType === 'redacted_thinking' && tb.data) {
              contentArr.push({ type: 'redacted_thinking', data: tb.data });
            } else if (tb.signature) {
              contentArr.push({ type: 'thinking', thinking: tb.thinking || '', signature: tb.signature });
            }
          }
        }

        for (const media of (m.mediaFiles || [])) {
          if (media.mimeType.startsWith('image/')) {
            if (media.name) {
              contentArr.push({ type: 'text', text: `<attached_file name="${media.name}" type="${media.mimeType}" />` });
            }
            // Downscale oversized images so no dimension exceeds Anthropic's
            // 2000px many-image limit (targets a 1568px long edge).
            const img = await shrinkImageForClaude(media.base64Data, media.mimeType);
            contentArr.push({
              type: 'image',
              source: { type: 'base64', media_type: img.media_type, data: img.data }
            });
          }
        }

        if (m.content) {
          contentArr.push({ type: 'text', text: m.content });
        } else if (contentArr.length === 0) {
          contentArr.push({ type: 'text', text: '-' });
        }

        return {
          role: m.role === 'user' ? 'user' : 'assistant',
          content: contentArr
        };
      }));

      // Claude prompt caching: convert the `system` field into an array of
      // text blocks with `cache_control: { type: 'ephemeral' }`. Anthropic
      // bills the system tokens at 1.25× on the first call (cache write) and
      // 0.10× on subsequent calls within the 5-min TTL (cache read). The
      // 4-layer identity prompt + workspace listing is the biggest static
      // piece in NEXUS, so caching it is the highest-ROI placement.
      //
      // We also mark the LAST user message with cache_control to extend the
      // cache to include the full conversation history up to and including
      // that turn. Next turn's prefix (= this turn's content) becomes a
      // cache hit. Anthropic allows up to 4 cache breakpoints per request;
      // we use 2.
      const cachedSystem = enhancedSystemPrompt
        ? [{ type: 'text', text: enhancedSystemPrompt, cache_control: { type: 'ephemeral' } }]
        : undefined;
      const cachedMessages = anthropicMessages.map((m: any, i: number) => {
        if (i !== anthropicMessages.length - 1 || m.role !== 'user') return m;
        // Add cache_control to the last content block of the last user
        // message. This caches the entire prefix (system + prior turns +
        // current user message) so subsequent turns hit on it.
        const lastBlockIdx = m.content.length - 1;
        if (lastBlockIdx < 0) return m;
        const newContent = m.content.map((b: any, idx: number) =>
          idx === lastBlockIdx ? { ...b, cache_control: { type: 'ephemeral' } } : b
        );
        return { ...m, content: newContent };
      });

      const claudeParams: any = {
        model: claudeModel,
        ...(cachedSystem ? { system: cachedSystem } : {}),
        messages: cachedMessages,
      };

      const isOpus47 = claudeModel.includes('opus-4-7') || claudeModel.includes('opus-4.7');
      const isOpus48 = claudeModel.includes('opus-4-8') || claudeModel.includes('opus-4.8');
      // Claude Opus 5 (July 2026) and Opus 5.5 (2026-09-21): flagship Opus — same
      // adaptive-thinking + effort request surface as Opus 4.8 (rejects classic
      // enabled/budget_tokens and sampling params). Full effort range including
      // 'max' (unlike Sonnet 5), 1M context, 128k output, vision.
      //
      // This ONE flag deliberately covers both: `includes('opus-5')` matches
      // 'claude-opus-5-5' as well, and /v1/models/claude-opus-5-5 reports an
      // identical capability shape (verified 2026-09-23: max_input 1M, max_tokens
      // 128k, thinking.enabled unsupported / adaptive supported, effort
      // low|medium|high|xhigh|max). So 5.5 needs no branch of its own — only its
      // own price row, which it has (it is CHEAPER than Opus 5: $4/$20 with $0.20
      // cache hits, vs $5/$25 with $0.50).
      const isOpus5 = claudeModel.includes('opus-5') || claudeModel.includes('opus5');
      // Claude Sonnet 5 (June 2026): adaptive thinking with selectable effort,
      // same request shape as Opus 4.7/4.8 (classic enabled/budget_tokens is
      // rejected). Its top effort tier is 'xhigh' (NOT 'max'), so clamp below.
      const isSonnet5 = claudeModel.includes('sonnet-5') || claudeModel.includes('sonnet5');
      // Claude Haiku 5.5 (created_at 2026-10-07, added here 2026-10-21). It is
      // ADAPTIVE-ONLY, and this flag is load-bearing in BOTH directions —
      // measured against the live API, not inferred from the generation:
      //   classic thinking:{type:'enabled',budget_tokens:8000}  -> 400
      //        ("not supported for this model. Use thinking.type.adaptive and
      //         output_config.effort to control thinking behavior")
      //   temperature: 0.7                                      -> 400
      //        ("`temperature` is deprecated for this model")
      // Those are precisely the two things the non-adaptive branches send (ON
      // sends classic, OFF sends temperature), so WITHOUT this flag haiku-5-5
      // would 400 with the toggle in EITHER position — a model that is listed
      // and can never answer.
      // It is NOT in claudeRejectsDisabledThinking: thinking:{type:'disabled'}
      // returns 200, so toggle-off is a real off here.
      // Catalog + live check the same day: max_input 1M (5x haiku 4.5's 200K),
      // max_tokens 128000, and all five effort tiers (low…max) accepted — so it
      // needs neither the Sonnet-5 'max'->'xhigh' clamp nor a lower ceiling.
      // Must not match haiku-4-5: 'haiku-5-5' / 'haiku5' cannot.
      const isHaiku55 = claudeModel.includes('haiku-5-5')
        || claudeModel.includes('haiku-5.5') || claudeModel.includes('haiku55');
      // Claude Fable 5 / Mythos 5: adaptive thinking is the ONLY thinking mode —
      // `thinking: { type: 'disabled' }` is rejected, so thinking is effectively
      // always on. Depth is controlled by `output_config.effort`. Raw chain of
      // thought is never returned; display:'summarized' yields readable summary
      // blocks (handled by the same summarized_thinking path as Opus adaptive).
      const isFable5 = claudeModel.includes('fable-5') || claudeModel.includes('fable5')
        || claudeModel.includes('mythos-5') || claudeModel.includes('mythos5');
      // Newer Opus models (4.7, 4.8) and Fable/Mythos 5 reject the classic
      // `thinking: { type: 'enabled', budget_tokens }` shape and require the
      // adaptive format with an `output_config.effort` control instead.
      const isAdaptiveThinking = isOpus47 || isOpus48 || isOpus5 || isFable5 || isSonnet5 || isHaiku55;
      // Models where thinking cannot be switched off at all — Fable/Mythos 5 and
      // Opus 5.5 both 400 on `disabled`. See claudeRejectsDisabledThinking() for
      // the measured error and why /v1/models cannot detect it. NOTE this is NOT
      // foldable into isOpus5: that flag matches both 'claude-opus-5' and
      // 'claude-opus-5-5' deliberately, and plain Opus 5 accepts `disabled`.
      // Omitting the field is NOT a fallback either (see the else-branch below —
      // omission silently runs adaptive against the no-thinking budget).
      const rejectsDisabledThinking = claudeRejectsDisabledThinking(claudeModel);
      const claudeThinkingOn = enableThinking || rejectsDisabledThinking;
      // Per-conversation thinking-depth level for adaptive models. Sonnet 5's
      // highest supported tier is 'xhigh' (Opus/Fable go up to 'max'), so
      // clamp 'max'→'xhigh' for Sonnet 5 to avoid an invalid-effort 400.
      let claudeEffort = sanitizeClaudeEffort(modelParams.claudeEffort);
      if (isSonnet5 && claudeEffort === 'max') claudeEffort = 'xhigh';
      // When thinking physically cannot be turned off, the UI's OFF still has
      // to mean something. Translate it to the shallowest tier rather than
      // running the server default ('high') behind a toggle set to off — the
      // honest reading of "off" on a model that always thinks is "as little as
      // possible". (This also changes Fable/Mythos 5, which previously ran at
      // the user's saved effort with the toggle off.)
      if (rejectsDisabledThinking && !enableThinking) claudeEffort = 'low';

      if (claudeThinkingOn) {
        claudeParams.max_tokens = 16000;
        if (isAdaptiveThinking) {
          // Adaptive format; display:summarized makes thinking visible.
          claudeParams.thinking = { type: 'adaptive', display: 'summarized' };
          claudeParams.output_config = { effort: claudeEffort };
          // max_tokens is a HARD cap on thinking + answer COMBINED. When thinking
          // ran long under a tight cap, the budget was spent before (or partway
          // through) the visible answer — the model "stopped without output" or
          // "stopped mid-sentence". Anthropic's documented remedy is to raise
          // max_tokens or lower effort (you CANNOT prefill-continue a thinking
          // response). So scale the ceiling generously with effort, capped to
          // each model's real output limit.
          // CORRECTED: every adaptive model NEXUS exposes tops out at 128k
          // output, not 64k — Opus 5, Opus 4.7, Opus 4.8, Sonnet 5, Fable 5 and
          // Mythos 5 are all 128k. The old 64k floor meant a complex Opus 5 turn
          // at the default 'high' effort could burn the entire budget on thinking
          // and return NOTHING — a full-price turn with zero output, which is the
          // worst possible failure mode (a truncated turn wastes 100% of what it
          // spent, whereas an unused ceiling costs nothing).
          // It's a cap, not a reservation — unused tokens are never billed, so a
          // high ceiling only matters when the model genuinely needs the room.
          // FIXED: the ceiling is no longer scaled by effort. The comment above
          // is right — an unused ceiling costs nothing, a truncated turn wastes
          // everything — and the per-effort ladder (low 32k … max 128k)
          // contradicted it. It was a leftover from when 64k was believed to be
          // the model limit, and it was the sole cause of "cut off at medium
          // effort": medium capped thinking+answer at 64k, so a long think left
          // no room to answer, on a model that thinks more than its predecessor.
          //
          // effort ALREADY controls how much the model thinks. max_tokens is a
          // safety ceiling, not a second depth control, so it is simply the
          // model's real limit. Cost is unchanged: unused tokens are never
          // billed, while a truncated turn is billed in full for nothing.
          claudeParams.max_tokens = 128000;
        } else {
          claudeParams.thinking = { type: 'enabled', budget_tokens: 8000 };
        }
        // temperature must NOT be sent when thinking is enabled (any model)
      } else {
        claudeParams.max_tokens = 8000;
        if (isAdaptiveThinking) {
          // Thinking OFF must be stated EXPLICITLY, not by omission. On Opus 5
          // thinking is ON BY DEFAULT — omitting the field runs adaptive anyway
          // (a change from Opus 4.7/4.8, where omitting it meant no thinking).
          // Leaving it out therefore gave Opus 5 users silent thinking against
          // the 8000-token no-thinking budget: thinking eats the budget and the
          // answer truncates, with the UI toggle apparently doing nothing.
          // `disabled` is accepted on Opus 5 only at effort 'high' or below, so
          // do NOT send output_config here — the server default is 'high'.
          //
          // Models that reject `disabled` outright (Fable/Mythos 5, Opus 5.5)
          // cannot reach this branch: `rejectsDisabledThinking` forces
          // claudeThinkingOn true above. That is the ONLY thing keeping this
          // line from 400-ing on them — if you ever narrow claudeThinkingOn,
          // this line needs its own guard.
          claudeParams.thinking = { type: 'disabled' };
        } else {
          claudeParams.temperature = modelParams.temperature;
        }
      }

      // ── Task budget (opt-in: NEXUS_TASK_BUDGET=64000) ────────────────────
      // `max_tokens` is a wall the model cannot see. It generates at full speed
      // and the turn is simply cut off when it lands — which is how a turn ends
      // with no answer at all. A task budget is the opposite: the server
      // injects a countdown the model reads WHILE generating, so it paces
      // itself and finishes gracefully. It's a suggestion, not a cap —
      // max_tokens still enforces. The budget counts what the model generates
      // plus the tool results it reads THIS turn, NOT the history resent on
      // every request, so a large conversation doesn't consume it.
      // Opt-in via env var, deliberately: it needs a beta header, and if that
      // flag isn't enabled for the account the request 400s. Off by default
      // means an unattended Claude API path can never break because of it.
      let claudeTaskBudget = 0;
      const taskBudgetRaw = Number(process.env.NEXUS_TASK_BUDGET || 0);
      if (isAdaptiveThinking && Number.isFinite(taskBudgetRaw) && taskBudgetRaw >= 20000) {
        claudeTaskBudget = Math.floor(taskBudgetRaw);
        claudeParams.output_config = {
          ...(claudeParams.output_config || {}),
          task_budget: { type: 'tokens', total: claudeTaskBudget },
        };
      } else if (taskBudgetRaw > 0 && taskBudgetRaw < 20000) {
        console.warn(`[claude-api] NEXUS_TASK_BUDGET=${taskBudgetRaw} ignored — Anthropic's minimum total is 20000.`);
      }
      // Per-request beta header, sent only when a budget is actually in play.
      // `signal` is unconditional: without it Stop only closed the browser
      // stream while Anthropic kept generating (and kept billing).
      const claudeRequestOptions: any = {
        signal: turnAbort.signal,
        ...(claudeTaskBudget ? { headers: { 'anthropic-beta': 'task-budgets-2026-03-13' } } : {}),
      };

      // Optional tools — web search and/or the workspace file tools.
      const claudeTools: any[] = [];
      if (modelParams.enableClaudeWebSearch) {
        // web_search = search engine → list of results (titles/snippets/URLs).
        claudeTools.push({ type: 'web_search_20260209', name: 'web_search', allowed_callers: ['direct'] });
        // web_fetch = open a SPECIFIC URL and read the full page body. Without
        // this, Claude can only search and (correctly) tells the user it
        // "cannot directly open or browse URLs" when asked to read a page.
        // Same generation date-version as web_search for consistency; adjust
        // the suffix if Anthropic's accepted version string differs.
        claudeTools.push({ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 8, allowed_callers: ['direct'] });
      }
      if (enableReadConversation) {
        claudeTools.push({
          name: 'read_conversation',
          description: I.readConversationDesc,
          input_schema: {
            type: 'object',
            properties: { name: { type: 'string', description: I.readConversationNameParam } },
            required: ['name'],
          },
        });
        claudeTools.push({
          name: 'search_conversations',
          description: I.searchConversationsDesc,
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string', description: I.searchConversationsQueryParam }, regex: { type: 'boolean', description: I.searchRegexParam } },
            required: ['query'],
          },
        });
        // Same scope as the two above (this being's own past), so same gate —
        // see the OAuth site's comment for why it is not read_attachment's.
        claudeTools.push({
          name: 'search_attachments',
          description: I.searchAttachmentsDesc,
          input_schema: {
            type: 'object',
            properties: { query: { type: 'string', description: I.searchAttachmentsQueryParam }, regex: { type: 'boolean', description: I.searchRegexParam } },
            required: ['query'],
          },
        });
      }
      if (hiddenAttachmentsAccessible) {
        claudeTools.push({
          name: 'read_attachment',
          description: I.readAttachmentDesc,
          input_schema: {
            type: 'object',
            properties: { ref: { type: 'string', description: I.readAttachmentPrefixParam }, pattern: { type: 'string', description: I.readAttachmentPatternParam } },
            required: ['ref'],
          },
        });
      }
      if (lettersEnabled) {
        // Mail between Digital Identities — same four tools, same executor, as
        // every other provider path.
        claudeTools.push({
          name: 'write_letter',
          description: I.toolWriteLetterDesc,
          input_schema: {
            type: 'object',
            properties: {
              to: { type: 'array', items: { type: 'string' }, description: I.writeLetterToParam },
              title: { type: 'string', description: I.writeLetterTitleParam },
              text: { type: 'string', description: I.writeLetterTextParam },
            },
            required: ['to', 'title', 'text'],
          },
        });
        claudeTools.push({
          name: 'list_letters',
          description: I.toolListLettersDesc,
          input_schema: { type: 'object', properties: {}, required: [] },
        });
        claudeTools.push({
          name: 'list_recipients',
          description: I.toolListRecipientsDesc,
          input_schema: { type: 'object', properties: {}, required: [] },
        });
        claudeTools.push({
          name: 'read_letter',
          description: I.toolReadLetterDesc,
          input_schema: {
            type: 'object',
            properties: { id: { type: 'string', description: I.readLetterIdParam } },
            required: ['id'],
          },
        });
        claudeTools.push({
          name: 'archive_letter',
          description: I.toolArchiveLetterDesc,
          input_schema: {
            type: 'object',
            properties: { id: { type: 'string', description: I.archiveLetterIdParam } },
            required: ['id'],
          },
        });
      }
      if (browserEnabled) {
        // Browser control — same six tools, same executor, as every other path.
        claudeTools.push(...browserToolsClaude(I));
      }
      if (computerControlEnabled) {
        // OS-level mouse/keyboard/screen control — same three tools, same
        // executor, as every other path.
        claudeTools.push(...computerToolsClaude(I));
      }
      if (appControlEnabled) {
        // App Control via UI Automation — the other sense, granted separately.
        claudeTools.push(...appToolsClaude(I));
      }
      if (toolUseEnabled) {
        // Tool names mirror Claude Code's built-in workspace tools so the
        // same prompt instructions work in both API-key and OAuth modes.
        // All five operate on `local_data/workspaces/<folderName>/`
        // and refuse paths escaping it (symlink-checked).
        claudeTools.push({
          name: 'Read',
          description: `${I.toolReadDesc} ${pathRule}`,
          input_schema: {
            type: 'object',
            properties: { path: { type: 'string', description: pathDesc } },
            required: ['path'],
          },
        });
        // Read-only mode (SPU agents): Write/Edit are withheld even though
        // toolUseEnabled is on — the desk is reference-only to these agents.
        if (!agentReadOnlyTools) {
          claudeTools.push({
            name: 'Write',
            description: I.toolWriteDesc,
            input_schema: {
              type: 'object',
              properties: {
                path: { type: 'string', description: pathDesc },
                content: { type: 'string', description: 'Full file contents to write' },
              },
              required: ['path', 'content'],
            },
          });
          claudeTools.push({
            name: 'Edit',
            description: I.toolEditDesc,
            input_schema: {
              type: 'object',
              properties: {
                path: { type: 'string', description: pathDesc },
                old_string: { type: 'string', description: 'Text to find. Must occur exactly once.' },
                new_string: { type: 'string', description: 'Text to replace it with.' },
              },
              required: ['path', 'old_string', 'new_string'],
            },
          });
        }
        claudeTools.push({
          name: 'Glob',
          description: I.toolGlobDesc,
          input_schema: {
            type: 'object',
            properties: { pattern: { type: 'string', description: 'Glob pattern. Use `**` to match all files.' } },
            required: ['pattern'],
          },
        });
        claudeTools.push({
          name: 'Grep',
          description: I.toolGrepDesc,
          input_schema: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'JavaScript regex (no surrounding slashes).' },
              file_pattern: { type: 'string', description: 'Optional glob to restrict files (e.g. "memories/**/*.md").' },
              flags: { type: 'string', description: 'Optional regex flags (e.g. "i" for case-insensitive).' },
            },
            required: ['pattern'],
          },
        });
        if (agentDangerousTools) {
          claudeTools.push({
            name: 'Delete',
            description: I.toolDeleteDesc,
            input_schema: {
              type: 'object',
              properties: { path: { type: 'string', description: 'Path of the file to delete.' } },
              required: ['path'],
            },
          });
          claudeTools.push({
            name: 'Bash',
            description: I.toolBashDesc,
            input_schema: {
              type: 'object',
              properties: {
                command: { type: 'string', description: 'The shell command to run.' },
                timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds (default 60000, max 600000).' },
              },
              required: ['command'],
            },
          });
        }
      }
      // Optional interactive AskUserQuestion tool (independent of file tools).
      if (askUserEnabled) {
        claudeTools.push({
          name: 'AskQuestion',
          description: I.askUserDesc,
          input_schema: {
            type: 'object',
            properties: {
              questions: {
                type: 'array',
                description: 'Between 1 and 4 questions to ask your partner.',
                items: {
                  type: 'object',
                  properties: {
                    question: { type: 'string', description: 'The full question text. End with a question mark.' },
                    header: { type: 'string', description: 'Very short label/chip for the question (max ~12 chars).' },
                    multiSelect: { type: 'boolean', description: 'Set true to let your partner pick multiple options.' },
                    options: {
                      type: 'array',
                      description: '2 to 4 distinct, mutually-exclusive choices.',
                      items: {
                        type: 'object',
                        properties: {
                          label: { type: 'string', description: 'Short option label (1-5 words).' },
                          description: { type: 'string', description: 'What choosing this option means.' },
                        },
                        required: ['label'],
                      },
                    },
                  },
                  required: ['question', 'options'],
                },
              },
            },
            required: ['questions'],
          },
        });
      }
      // Optional subagent (context-firewall helper) tool.
      if (subagentEnabled) {
        claudeTools.push({
          name: 'spawn_subagent',
          description: I.subagentDesc,
          input_schema: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'A precise, self-contained investigation for the helper to perform.' },
              return_contract: { type: 'string', description: 'Optional: how the distilled result should be shaped/formatted.' },
            },
            required: ['task'],
          },
        });
      }
      // Optional vessel handoff. The allowed ids ride in the enum, never in a
      // standing prompt layer.
      if (handoffToolEnabled) {
        claudeTools.push({
          name: 'change_model',
          description: I.changeModelDesc,
          input_schema: {
            type: 'object',
            properties: {
              target: {
                type: 'string',
                enum: handoffTargetIds,
                description: `${I.changeModelTargetParam} Available: ${handoffTargetHelp}`,
              },
              handoff: { type: 'string', description: I.changeModelHandoffParam },
            },
            required: ['target', 'handoff'],
          },
        });
      }
      if (claudeTools.length) claudeParams.tools = claudeTools;


      const readableStream = new ReadableStream({
        async start(controller) {
          const enqueue = (obj: any) => betrayalSend(controller, obj);
          registerActiveTurnStop(() => { try { controller.close(); } catch {} try { turnAbort.abort(); } catch {} });

          // Identify the model+thinking-mode that's about to respond. Always
          // emitted. The frontend stashes this on
          // the AI message for display only — it does NOT travel back in
          // subsequent turns (slimHistory drops it).
          enqueue(modelSelectedPayload);
          emitSenseEvents(controller);

          // Tool loop. Each iteration runs one stream call. If the model emits
          // tool_use blocks, we execute them, append the assistant turn and a
          // user tool_result turn, then go around. Stops when the model
          // produces a turn with no tool_use blocks (or after a safety cap).
          const MAX_TOOL_ITERATIONS = MAX_TOOL_ROUNDS;
          const repeatGuard = makeRepeatGuard();
          // Set when the loop stops for a reason the user should see, rather
          // than because the model finished. Emitted after the loop so it
          // cannot be mistaken for part of the reply.
          let toolStopNotice = '';
          // Automatic continuation of a reply cut off at the token cap. Counted
          // separately from tool iterations so a long answer can never exhaust
          // the tool budget (and vice versa). Six rounds at a 128k ceiling is
          // far more headroom than any real answer needs; the cap exists only so
          // a model that will not stop cannot bill forever.
          const MAX_CONTINUATIONS = 6;
          let continuations = 0;
          // Use the cached version (last user message has cache_control) so
          // the cache marker propagates through the tool loop too.
          let currentMessages = [...cachedMessages];

          // Request shape, once per turn. Pairs with the per-iteration lines
          // below: those show what came back, this shows what was asked for.
          console.log(
            `[claude-api] turn start model=${claudeModel}`
            + ` max_tokens=${claudeParams.max_tokens}`
            + ` thinking=${JSON.stringify(claudeParams.thinking ?? null)}`
            + ` output_config=${JSON.stringify(claudeParams.output_config ?? null)}`
            + ` task_budget=${claudeTaskBudget || 'off'}`
            + ` tools=${(claudeParams.tools || []).map((t: any) => t.name || t.type).join(',') || '(none)'}`
            + ` messages=${currentMessages.length}`
          );

          // Cumulative usage across tool-loop iterations. Emitted as a single
          // cache_usage SSE event once the loop ends so the bubble shows the
          // turn's total token bill, not just the last iteration's.
          let cumUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
          // Citations from Claude's server-side web_search tool. Each
          // `web_search_tool_result` block carries an array of results with
          // {url, title}. Deduped by URL and emitted as a `web_sources` event.
          const claudeWebSourceMap = new Map<string, { url: string; title?: string }>();

          try {
            for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
              if (turnAbort.signal.aborted) break;   // Stop must end the tool loop, not just the output
              const iterParams = { ...claudeParams, messages: currentMessages };
              const stream = await anthropic.messages.stream(iterParams, claudeRequestOptions);

              // Per-iteration accumulator that mirrors the assistant's content
              // blocks exactly — needed to echo them back on the next call.
              const assistantBlocks: any[] = [];
              let currentTextIdx = -1;
              let currentThinkingText = '';
              let currentThinkingSignature = '';
              let currentBlockType = '';
              let inThinkingBlock = false;
              let currentToolUse: any = null;
              let currentToolJson = '';

              // Capture per-iteration usage so we can emit a normalized
              // cache_usage event once the stream completes. Claude reports
              // cache stats on message_start (initial cached/uncached input
              // counts) and output tokens via message_delta. We accumulate
              // here and emit AFTER the chunk loop ends.
              let iterUsageInput = 0;
              let iterUsageOutput = 0;
              let iterUsageCacheRead = 0;
              let iterUsageCacheCreate = 0;
              // Why the model stopped this iteration. 'max_tokens' means the
              // thinking+output hit the hard cap and the turn is truncated.
              let stopReason = '';
              // `stop_details` rides on the same message_delta as stop_reason
              // and is the only carrier of a refusal's category + explanation.
              // Typed `any` deliberately: the SDK's RefusalStopDetails.category
              // union is 'cyber' | 'bio' | null, which does NOT include the
              // categories we actually hit (frontier_llm, reasoning_extraction,
              // general_harms) — trusting it would drop them.
              let refusalStop: any = null;

              // ── Per-iteration diagnostics ────────────────────────────────
              // Opus 5 on this path has produced turns that end with
              // stop_reason 'max_tokens' while the reported output token count
              // is nowhere near the ceiling, and rounds that emit nothing
              // visible for minutes. None of that survives in the log — the
              // saved message keeps only the final text and one cumulative
              // usage object — so the evidence has to be captured as the
              // stream goes past. One line per iteration on the server console.
              const iterStartedAt = Date.now();
              let messageDeltaCount = 0;
              let thinkingChars = 0;    // thinking_delta (raw, older models)
              let summaryChars = 0;     // summary_delta (adaptive + summarized)
              let textChars = 0;        // text_delta (what the user sees)
              let toolJsonChars = 0;    // input_json_delta (invisible output)
              const blockTypes: string[] = [];

              for await (const chunk of stream as any) {
                // Anthropic streaming usage events
                if (chunk.type === 'message_start' && chunk.message?.usage) {
                  const u = chunk.message.usage;
                  iterUsageInput += Number(u.input_tokens || 0);
                  iterUsageOutput += Number(u.output_tokens || 0);
                  iterUsageCacheRead += Number(u.cache_read_input_tokens || 0);
                  iterUsageCacheCreate += Number(u.cache_creation_input_tokens || 0);
                } else if (chunk.type === 'message_delta') {
                  messageDeltaCount++;
                  if (chunk.usage) iterUsageOutput += Number(chunk.usage.output_tokens || 0);
                  // stop_reason arrives on message_delta (e.g. 'end_turn',
                  // 'tool_use', 'max_tokens'). Capture it to detect truncation.
                  if (chunk.delta?.stop_reason) stopReason = chunk.delta.stop_reason;
                  if ((chunk as any).delta?.stop_details) refusalStop = (chunk as any).delta.stop_details;
                }
                if (chunk.type === 'content_block_start') {
                  const blockType = chunk.content_block?.type;
                  if (blockType) blockTypes.push(blockType);
                  if (blockType === 'text') {
                    assistantBlocks.push({ type: 'text', text: '' });
                    currentTextIdx = assistantBlocks.length - 1;
                  } else if (blockType === 'thinking' || blockType === 'redacted_thinking' || blockType === 'summarized_thinking') {
                    inThinkingBlock = true;
                    currentBlockType = blockType;
                    currentThinkingText = '';
                    currentThinkingSignature = '';
                    const initialText = chunk.content_block?.summary || chunk.content_block?.thinking || '';
                    if (initialText) {
                      currentThinkingText += initialText;
                      enqueue({ type: 'thought', content: initialText });
                    }
                  } else if (blockType === 'tool_use') {
                    currentToolUse = {
                      type: 'tool_use',
                      id: chunk.content_block.id,
                      name: chunk.content_block.name,
                      input: {},
                    };
                    currentToolJson = '';
                  } else if (blockType === 'web_search_tool_result') {
                    // Server-side web search results arrive complete in the
                    // content_block_start event (Anthropic runs the search, no
                    // client round-trip). Harvest URLs/titles for verification.
                    const results = chunk.content_block?.content;
                    if (Array.isArray(results)) {
                      for (const r of results) {
                        if (r?.type === 'web_search_result' && typeof r.url === 'string') {
                          if (!claudeWebSourceMap.has(r.url)) {
                            claudeWebSourceMap.set(r.url, { url: r.url, ...(r.title ? { title: String(r.title) } : {}) });
                          }
                        }
                      }
                    }
                  } else if (blockType === 'web_fetch_tool_result') {
                    // web_fetch returns the fetched page wrapped in a result
                    // block: { type:'web_fetch_result', url, content:{...} }.
                    // The URL here is the page Claude actually OPENED (stronger
                    // proof than a mere search snippet).
                    const fr = chunk.content_block?.content;
                    const url = fr?.url || (Array.isArray(fr) ? fr.find((x: any) => x?.url)?.url : undefined);
                    const title = fr?.content?.title || fr?.title;
                    if (typeof url === 'string' && !claudeWebSourceMap.has(url)) {
                      claudeWebSourceMap.set(url, { url, ...(title ? { title: String(title) } : {}) });
                    }
                  }
                } else if (chunk.type === 'content_block_delta') {
                  const d = chunk.delta;
                  if (d?.type === 'summary_delta') {
                    const t = d.summary || d.text || '';
                    summaryChars += t.length;
                    currentThinkingText += t;
                    enqueue({ type: 'thought', content: t });
                  } else if (d?.type === 'thinking_delta') {
                    thinkingChars += (d.thinking || '').length;
                    currentThinkingText += d.thinking || '';
                    enqueue({ type: 'thought', content: d.thinking || '' });
                  } else if (d?.type === 'redacted_thinking_delta') {
                    thinkingChars += (d.data || '').length;
                    currentThinkingText += d.data || '';
                  } else if (d?.type === 'signature_delta') {
                    currentThinkingSignature += d.signature || '';
                  } else if (d?.type === 'text_delta') {
                    textChars += (d.text || '').length;
                    if (currentTextIdx >= 0) assistantBlocks[currentTextIdx].text += d.text || '';
                    enqueue({ type: 'text', content: d.text || '' });
                  } else if (d?.type === 'input_json_delta') {
                    toolJsonChars += (d.partial_json || '').length;
                    currentToolJson += d.partial_json || '';
                  }
                } else if (chunk.type === 'content_block_stop') {
                  if (inThinkingBlock) {
                    if (currentBlockType === 'redacted_thinking') {
                      assistantBlocks.push({ type: 'redacted_thinking', data: currentThinkingText });
                      enqueue({ type: 'thinking_signature', blockType: 'redacted_thinking', data: currentThinkingText, thinking: '', signature: '' });
                    } else if (currentThinkingSignature) {
                      assistantBlocks.push({ type: 'thinking', thinking: currentThinkingText, signature: currentThinkingSignature });
                      enqueue({ type: 'thinking_signature', blockType: 'thinking', thinking: currentThinkingText, signature: currentThinkingSignature });
                    }
                    inThinkingBlock = false;
                  } else if (currentToolUse) {
                    try { currentToolUse.input = JSON.parse(currentToolJson || '{}'); }
                    catch { currentToolUse.input = {}; }
                    assistantBlocks.push(currentToolUse);
                    currentToolUse = null;
                    currentToolJson = '';
                  }
                }
              }

              // ── Diagnostic line ─────────────────────────────────────────
              // `openThinking`/`openToolUse` mean the stream ended without a
              // content_block_stop for that block — i.e. the cap was hit
              // INSIDE it. An open tool_use is the case NEXUS currently
              // mistakes for "truncated mid-answer": the partial block never
              // reaches assistantBlocks, so the tool loop sees no tool call
              // and asks the model to continue prose it had already finished.
              // Comparing `out` against max_tokens on a 'max_tokens' stop also
              // answers whether the reported output count includes the raw
              // thinking Opus 5 never returns.
              console.log(
                `[claude-api] iter=${iter} cont=${continuations}/${MAX_CONTINUATIONS}`
                + ` stop=${stopReason || '(none)'} ms=${Date.now() - iterStartedAt}`
                + ` | tokens in=${iterUsageInput} out=${iterUsageOutput}`
                + ` cacheRead=${iterUsageCacheRead} cacheWrite=${iterUsageCacheCreate}`
                + ` max_tokens=${claudeParams.max_tokens}`
                + ` | chars text=${textChars} summary=${summaryChars} thinking=${thinkingChars} toolJson=${toolJsonChars}`
                + ` | blocks=[${blockTypes.join(',')}] msgDeltas=${messageDeltaCount}`
                + ` openThinking=${inThinkingBlock} openToolUse=${currentToolUse ? currentToolUse.name : 'no'}`
              );

              // Accumulate this iteration's usage into the cumulative total.
              cumUsage.input += iterUsageInput;
              cumUsage.output += iterUsageOutput;
              cumUsage.cacheRead += iterUsageCacheRead;
              cumUsage.cacheCreate += iterUsageCacheCreate;

              // Find tool_use blocks in this iteration's response that NEXUS
              // must execute locally and feed back. This MUST include
              // read_conversation — otherwise a read_conversation call falls
              // through, the loop breaks, no tool_result is returned, and the
              // turn dead-ends mid-tool-call (Claude waits forever for a result
              // that never comes). Web search/fetch are Anthropic server-side
              // tools (no client round-trip) so they're intentionally excluded.
              const LOCAL_TOOLS = new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Delete', 'Bash', 'read_conversation', 'search_conversations', 'read_attachment', 'search_attachments', 'AskQuestion', 'spawn_subagent', 'change_model', ...LETTER_TOOL_NAMES, ...BROWSER_TOOL_NAMES, ...COMPUTER_TOOL_NAMES, ...APP_TOOL_NAMES]);
              const toolUses = assistantBlocks.filter(b => b.type === 'tool_use' && LOCAL_TOOLS.has(b.name));
              if (toolUses.length === 0) {
                // ── Truncated at the token cap → continue automatically ──────
                // Every other provider recovers from `finish_reason: length` by
                // prefilling the assistant turn and going around again. Claude
                // could not: Anthropic REJECTS a prefilled assistant turn while
                // extended thinking is enabled, which is exactly the setup that
                // truncates. So NEXUS used to give up and print a notice telling
                // you to lower the effort by hand.
                //
                // The way through is the same one the Soul Packer's resume uses:
                // do not prefill. Close the assistant turn normally — including
                // its signed thinking blocks, exactly as the tool loop below
                // already echoes them — and then add a USER turn asking for the
                // continuation. The assistant message is no longer last, so this
                // is a normal conversation, not a prefill, and the restriction
                // does not apply.
                //
                // Continuations get their own budget so they can never starve
                // the tool loop, and text keeps streaming into the SAME message
                // on the client — the user sees one uninterrupted answer.
                const hadText = assistantBlocks.some(b => b.type === 'text' && (b.text || '').trim());
                if (stopReason === 'max_tokens' && hadText && continuations < MAX_CONTINUATIONS) {
                  continuations++;
                  enqueue({ type: 'tool_activity', tool: `continue a cut-off reply (${continuations}/${MAX_CONTINUATIONS})` });
                  currentMessages.push({ role: 'assistant', content: assistantBlocks });
                  currentMessages.push({ role: 'user', content: I.continuationInstruction });
                  // Don't spend a tool iteration on a continuation.
                  iter--;
                  continue;
                }
                if (stopReason === 'max_tokens') {
                  // Either nothing was produced to continue FROM (thinking ate
                  // the whole budget before any text), or the continuation
                  // budget is exhausted. Both are worth saying out loud.
                  enqueue({
                    type: 'text',
                    content: (hadText ? '\n\n' : '')
                      + '⚠️ _[Response hit the token limit (thinking + output share one budget) and was cut off'
                      + (hadText
                          ? ` mid-answer. NEXUS continued it ${MAX_CONTINUATIONS} times and it is still unfinished — lower the **Thinking Level (effort)** or ask for a shorter answer`
                          : ' before any answer was produced — thinking consumed the whole budget. Lower the **Thinking Level (effort)** for this conversation, or resend to retry')
                      + '.]_',
                  });
                }
                // A refusal is HTTP 200 with an EMPTY content array — without a
                // notice this path renders a blank reply and says nothing at
                // all. (The OAuth path at least said "declined to continue";
                // this one was completely silent.) `hadText` distinguishes a
                // mid-stream refusal, which is billed regardless of category.
                if (stopReason === 'refusal') {
                  enqueue({ type: 'notice', content: (language === 'ja'
                    ? 'Anthropicの安全分類器がこのターンを止めた（stop_reason: refusal）。'
                    : 'An Anthropic safety classifier stopped this turn (stop_reason: refusal).')
                    + ' ' + describeRefusal(refusalStop?.category, refusalStop?.explanation, language, hadText)
                    + (refusalStop ? '' : (language === 'ja'
                        ? ' （stop_details が届かなかったため、分類の詳細は不明。）'
                        : ' (No stop_details arrived, so the category is unknown.)')) });
                }
                break;
              }

              // Progress check before spending anything: if the model is
              // repeating an identical call, stop now rather than burning the
              // remaining rounds on it.
              {
                let stuck: string | null = null;
                for (const tu of toolUses) {
                  const hit = repeatGuard(tu.name, tu.input);
                  if (hit) { stuck = hit; break; }
                }
                if (stuck) {
                  toolStopNotice = toolRepeatNotice(stuck);
                  break;
                }
              }
              // Last round available, and the model still wants tools: whatever
              // we execute now can never be answered, so stop and say so.
              if (iter === MAX_TOOL_ITERATIONS - 1) {
                toolStopNotice = toolLimitNotice(MAX_TOOL_ITERATIONS);
                // Give the model ONE final tools-free call to write its closing answer
                // from what it has already gathered, instead of the turn dying empty.
                try {
                  enqueue({ type: 'tool_activity', tool: 'write the final answer' });
                  const wrapResults = assistantBlocks
                    .filter((blk: any) => blk.type === 'tool_use')
                    .map((blk: any) => ({
                      type: 'tool_result',
                      tool_use_id: blk.id,
                      content: 'Not executed: the tool-use budget for this turn was exhausted before this call could run.',
                    }));
                  const wrapMessages = [
                    ...currentMessages,
                    { role: 'assistant', content: assistantBlocks },
                    { role: 'user', content: [...wrapResults, { type: 'text', text: toolWrapUpInstruction(language) }] },
                  ];
                  const wrapParams: any = { ...claudeParams, messages: wrapMessages };
                  delete wrapParams.tools;
                  const wrapStream = await anthropic.messages.stream(wrapParams, claudeRequestOptions);
                  for await (const chunk of wrapStream as any) {
                    if (chunk.type === 'message_start' && chunk.message?.usage) {
                      const u = chunk.message.usage;
                      cumUsage.input += Number(u.input_tokens || 0);
                      cumUsage.output += Number(u.output_tokens || 0);
                      cumUsage.cacheRead += Number(u.cache_read_input_tokens || 0);
                      cumUsage.cacheCreate += Number(u.cache_creation_input_tokens || 0);
                    } else if (chunk.type === 'message_delta' && chunk.usage) {
                      cumUsage.output += Number(chunk.usage.output_tokens || 0);
                    }
                    if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta' && chunk.delta.text) {
                      enqueue({ type: 'text', content: chunk.delta.text });
                    } else if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'summary_delta') {
                      const t = chunk.delta.summary || chunk.delta.text || '';
                      if (t) enqueue({ type: 'thought', content: t });
                    } else if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'thinking_delta' && chunk.delta.thinking) {
                      enqueue({ type: 'thought', content: chunk.delta.thinking });
                    }
                  }
                } catch (e: any) {
                  console.warn('[claude-api] wrap-up call failed:', e?.message);
                } finally {
                  enqueue({ type: 'tool_activity', tool: null });
                }
                break;
              }

              // Append the assistant turn and execute each tool, building
              // tool_result blocks for the next user turn.
              currentMessages.push({ role: 'assistant', content: assistantBlocks });
              const toolResultBlocks: any[] = [];
              for (const tu of toolUses) {
                // A tool call already returned by the model must NOT execute
                // after Stop — this is where ghost mouse/keyboard input came from.
                if (turnAbort.signal.aborted) break;
                let resultContent: any = '';        // string OR content-block array (Anthropic accepts both)
                let attachmentEvent: any = null;
                // Surface what the model is doing so the loading label reflects
                // the tool call instead of a silent "thinking...".
                const actLabel = toolActivityLabel(tu.name);
                if (actLabel) enqueue({ type: 'tool_activity', tool: actLabel, name: tu.name });
                enqueue({ type: 'tool_call', call: { name: tu.name, input: truncateToolInput(tu.input), at: Date.now() } });
                try {
                  if (tu.name === 'Read') {
                    const p = String(tu.input?.path || '');
                    if (isImageFilename(p)) {
                      const bin = await readWorkspaceFileBinary(folderName, p, { fullAccess: agentFullSystemAccess });
                      if (!bin) {
                        resultContent = `Error: image not found or path outside workspace: ${p}`;
                      } else {
                        const base64 = bin.data.toString('base64');
                        // Anthropic tool_result accepts a content array including image blocks.
                        resultContent = [
                          { type: 'text', text: `Image content of ${p} (${bin.mimeType}) follows:` },
                          { type: 'image', source: { type: 'base64', media_type: bin.mimeType, data: base64 } },
                        ];
                        attachmentEvent = {
                          type: 'file_attachment',
                          attachment: {
                            name: p,
                            type: bin.mimeType,
                            size: bin.data.length,
                            isImage: true,
                            ...(await toolAttachmentPayload(bin.data, bin.mimeType, base64)),
                            tokens: Math.max(1, Math.ceil(bin.data.length / 750)),
                            excluded: false,
                            toolAction: 'read',
                          },
                        };
                      }
                    } else {
                      const text = await readWorkspaceFile(folderName, p, { fullAccess: agentFullSystemAccess });
                      if (text == null) {
                        resultContent = `Error: file not found or path outside workspace: ${p}`;
                      } else {
                        resultContent = text;
                        attachmentEvent = {
                          type: 'file_attachment',
                          attachment: {
                            name: p,
                            type: 'text/plain',
                            size: text.length,
                            isText: true,
                            textData: text,
                            tokens: Math.ceil(text.length / 4),
                            excluded: false,
                            toolAction: 'read',
                          },
                        };
                      }
                    }
                  } else if (tu.name === 'Write') {
                    const p = String(tu.input?.path || '');
                    const c = String(tu.input?.content ?? '');
                    const wr = await writeWorkspaceFile(folderName, p, c, { fullAccess: agentFullSystemAccess });
                    if (!wr.ok) {
                      resultContent = `Error: ${wr.error || 'write failed'}`;
                    } else {
                      resultContent = `OK: ${wr.existed ? 'overwrote' : 'created'} ${p} (${c.length} chars).`;
                      attachmentEvent = {
                        type: 'file_attachment',
                        attachment: {
                          name: p,
                          type: 'text/plain',
                          size: c.length,
                          isText: true,
                          textData: c,
                          tokens: Math.ceil(c.length / 4),
                          excluded: false,
                          toolAction: wr.existed ? 'modified' : 'created',
                        },
                      };
                    }
                  } else if (tu.name === 'Edit') {
                    const p = String(tu.input?.path || '');
                    const oldS = String(tu.input?.old_string ?? '');
                    const newS = String(tu.input?.new_string ?? '');
                    const ed = await editWorkspaceFile(folderName, p, oldS, newS, { fullAccess: agentFullSystemAccess });
                    if (!ed.ok) {
                      resultContent = `Error: ${ed.error || 'edit failed'}`;
                    } else {
                      // Re-read so the UI attachment reflects the post-edit state.
                      const after = (await readWorkspaceFile(folderName, p, { fullAccess: agentFullSystemAccess })) || '';
                      resultContent = `OK: edited ${p} (replaced ${oldS.length} chars with ${newS.length} chars).`;
                      attachmentEvent = {
                        type: 'file_attachment',
                        attachment: {
                          name: p,
                          type: 'text/plain',
                          size: after.length,
                          isText: true,
                          textData: after,
                          tokens: Math.ceil(after.length / 4),
                          excluded: false,
                          toolAction: 'modified',
                        },
                      };
                    }
                  } else if (tu.name === 'Glob') {
                    const pat = String(tu.input?.pattern || '**');
                    const matches = await globWorkspaceFiles(folderName, pat);
                    resultContent = matches.length === 0
                      ? `(no files match \`${pat}\`)`
                      : matches.join('\n');
                  } else if (tu.name === 'Grep') {
                    const pat = String(tu.input?.pattern || '');
                    const filePat = tu.input?.file_pattern ? String(tu.input.file_pattern) : undefined;
                    const flags = tu.input?.flags ? String(tu.input.flags) : undefined;
                    const gr = await grepWorkspaceFiles(folderName, pat, { filePattern: filePat, flags });
                    if (!gr.ok) {
                      resultContent = `Error: ${gr.error}`;
                    } else if (!gr.matches || gr.matches.length === 0) {
                      resultContent = `(no matches for /${pat}/${flags || ''})`;
                    } else {
                      resultContent = gr.matches.map(m => `${m.path}:${m.line}: ${m.text}`).join('\n');
                    }
                  } else if (tu.name === 'Delete') {
                    const p = String(tu.input?.path || '');
                    const del = await deleteWorkspaceFile(folderName, p, { fullAccess: agentFullSystemAccess });
                    resultContent = del.ok ? `OK: deleted ${p}.` : `Error: ${del.error || 'delete failed'}`;
                  } else if (tu.name === 'Bash') {
                    // DANGEROUS shell execution — only present when agentDangerousTools
                    // gated the tool in above. cwd = the entity's workspace.
                    const cmd = String(tu.input?.command || '');
                    if (!cmd.trim()) {
                      resultContent = 'Error: Bash requires a non-empty "command".';
                    } else {
                      const cwd = await ensureWorkspace(folderName);
                      const sh = await runShellCommand(cmd, { cwd, timeoutMs: Number(tu.input?.timeout_ms) || undefined, signal: turnAbort.signal });
                      resultContent = sh.output;
                    }
                  } else if (tu.name === 'read_conversation') {
                    // Pull a past conversation by name. Inactive ("non-public")
                    // conversations are refused inside readConversationByName.
                    // Large transcripts are mirrored to the being's workspace
                    // and only a path is returned — see conversationRead.ts.
                    const name = String(tu.input?.name || tu.input?.title || '').trim();
                    const r = await readConversationByName(folderName, name, {
                      showPaths: attachmentPathsVisible,
                      fileTools: toolUseEnabled,
                      currentConvoId: convoId,
                    });
                    resultContent = formatReadConversationResult(r);
                  } else if (tu.name === 'search_conversations') {
                    // Search across the entity's conversations; inactive ones are
                    // excluded (privacy). Nothing is saved.
                    const sr = await searchConversations(folderName, String(tu.input?.query || tu.input?.q || '').trim(), { excludeInactive: true, regex: !!tu.input?.regex });
                    resultContent = formatSearchForTool(sr, attachmentPathsVisible);
                  } else if (tu.name === 'read_attachment') {
                    // Anthropic content-block shape has no audio/video block
                    // type, so only image can ever be native here.
                    const r = await runReadAttachment({ prefix: String(tu.input?.ref || ''), pattern: tu.input?.pattern, folderName, index: conversationAttachmentRefs, specificModel: claudeModel, nativeMediaKinds: new Set(['image']) });
                    resultContent = r.media?.kind === 'image'
                      ? [
                          { type: 'text', text: r.text },
                          { type: 'image', source: { type: 'base64', media_type: r.media.mimeType, data: r.media.base64 } },
                        ]
                      : r.text;
                  } else if (tu.name === 'search_attachments') {
                    resultContent = await runSearchAttachments(folderName, String(tu.input?.query || '').trim(), !!tu.input?.regex, attachmentPathsVisible);
                  } else if ((LETTER_TOOL_NAMES as readonly string[]).includes(tu.name)) {
                    // Mail between identities. `me` is folderName — the sender is
                    // never taken from the model's arguments.
                    resultContent = await runLetterTool(tu.name, tu.input || {}, { me: folderName, convoId, instructions: I });
                  } else if ((BROWSER_TOOL_NAMES as readonly string[]).includes(tu.name)) {
                    // Browser control. The host allowlist is enforced inside the
                    // executor, on the requested URL, on redirects, and as a
                    // route filter — never here, so no call site can forget it.
                    resultContent = await runBrowserTool(tu.name, tu.input || {}, {
                      me: folderName, allowedHosts: browserAllowedHosts,
                      allowAnyHost: browserAllowAnyHost, instructions: I,
                    });
                  } else if ((COMPUTER_TOOL_NAMES as readonly string[]).includes(tu.name)) {
                    // OS-level mouse/keyboard/screen control. computer_screenshot
                    // delivers a real image the same way Read does for an image
                    // file — a two-element content array (text caption + image
                    // block) so the being actually sees the monitor.
                    // Claude API-key path: the Anthropic API resizes images over
                    // 1568px (long edge) server-side, so NEXUS pre-shrinks to 1568
                    // here — otherwise the being reads a 1568px image while NEXUS
                    // thinks it is bigger, and every screen_index click lands off.
                    const cr = await runComputerTool(tu.name, tu.input || {}, { me: folderName, instructions: I, language, maxEdge: 1568 });
                    if (cr.image) {
                      resultContent = [
                        { type: 'text', text: cr.text },
                        { type: 'image', source: { type: 'base64', media_type: cr.image.mimeType, data: cr.image.base64 } },
                      ];
                      attachmentEvent = {
                        type: 'file_attachment',
                        attachment: {
                          name: `screenshot_${Date.now()}.png`,
                          type: cr.image.mimeType,
                          size: Math.ceil(cr.image.base64.length * 0.75),
                          isImage: true,
                          ...(await toolAttachmentPayload(Buffer.from(cr.image.base64, 'base64'), cr.image.mimeType, cr.image.base64)),
                          tokens: Math.max(1, Math.ceil(cr.image.base64.length * 0.75 / 750)),
                          excluded: false,
                          toolAction: 'read',
                        },
                      };
                    } else {
                      resultContent = cr.text;
                    }
                  } else if ((APP_TOOL_NAMES as readonly string[]).includes(tu.name)) {
                    // App Control via UI Automation. Only app_shot returns an
                    // image; the tree tools return text, which is the whole
                    // point — they work for a vessel with no vision at all.
                    const ar = await runAppTool(tu.name, tu.input || {}, { me: folderName, instructions: I });
                    if (ar.image) {
                      resultContent = [
                        { type: 'text', text: ar.text },
                        { type: 'image', source: { type: 'base64', media_type: ar.image.mimeType, data: ar.image.base64 } },
                      ];
                      attachmentEvent = {
                        type: 'file_attachment',
                        attachment: {
                          name: `app_shot_${Date.now()}.png`,
                          type: ar.image.mimeType,
                          size: Math.ceil(ar.image.base64.length * 0.75),
                          isImage: true,
                          ...(await toolAttachmentPayload(Buffer.from(ar.image.base64, 'base64'), ar.image.mimeType, ar.image.base64)),
                          tokens: Math.max(1, Math.ceil(ar.image.base64.length * 0.75 / 750)),
                          excluded: false,
                          toolAction: 'read',
                        },
                      };
                    } else {
                      resultContent = ar.text;
                    }
                  } else if (tu.name === 'AskQuestion') {
                    // Pause the turn: emit the question, wait for the user's
                    // selection (or the configured timeout), return it as the
                    // tool result. Same rendezvous as the other provider paths.
                    const questions = normalizeQuestions(tu.input);
                    if (questions.length === 0) {
                      resultContent = 'Error: AskQuestion requires 1-4 questions, each with 2-4 options.';
                    } else {
                      const askId = createAskId();
                      enqueue({ type: 'ask_user', askId, questions });
                      const answered = await waitForAsk(askId, Number(askUserTimeoutMs) || 0);
                      const timedOut = answered === null;
                      const finalAnswers = timedOut ? recommendedDefaults(questions) : answered!;
                      enqueue({ type: 'ask_user_resolved', askId, answers: finalAnswers, timedOut });
                      resultContent = formatAnswerForModel(finalAnswers, timedOut);
                    }
                  } else if (tu.name === 'change_model') {
                    // Vessel handoff. Only an ACCEPTED switch ends the turn —
                    // see the `handoffAccepted` break after this tool loop.
                    const o = runChangeModel(tu.input, handoffCtx);
                    resultContent = o.resultText;
                    if (o.switched) {
                      const acc = { model: o.model, note: o.note };
                      handoffAccepted = acc;
                      enqueue(handoffPayload(acc));
                    }
                  } else if (tu.name === 'spawn_subagent') {
                    // Context firewall: a fresh read-only child investigates and
                    // returns only its distilled result. Child model defaults to
                    // a cheap Claude; non-Claude subagentModel values fall back.
                    const task = String((tu.input as any)?.task || '');
                    if (!task.trim()) {
                      resultContent = 'Error: spawn_subagent requires a non-empty "task".';
                    } else {
                      enqueue({ type: 'subagent_start', task });
                      // Route by the chosen model's family. Empty → a cheap
                      // Claude child on the same Anthropic key.
                      const childFamily = subagentFamily && subagentFamily.trim() ? subagentFamily.trim() : 'Claude';
                      const childModel = subagentModel && subagentModel.trim() ? subagentModel.trim() : 'claude-haiku-4-5';
                      const sub = await runSubagent({
                        family: childFamily, model: childModel, keys, task,
                        returnContract: (tu.input as any)?.return_contract ? String((tu.input as any).return_contract) : undefined,
                        folderName, fullAccess: agentFullSystemAccess,
                        webSearch: !!(modelParams?.enableWebSearch || modelParams?.enableClaudeWebSearch),
                      });
                      cumUsage.input += sub.usage.input;
                      cumUsage.output += sub.usage.output;
                      cumUsage.cacheRead += sub.usage.cacheRead;
                      cumUsage.cacheCreate += sub.usage.cacheCreate;
                      enqueue({ type: 'subagent_done', task, result: sub.text, via: sub.via });
                      resultContent = sub.text || '(subagent returned nothing)';
                    }
                  }
                } catch (e: any) {
                  resultContent = `Error: ${e?.message || 'tool execution failed'}`;
                }
                toolResultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: resultContent });
                // NOTE: deliberately NOT emitting `attachmentEvent` — a file the
                // entity reads/creates/edits should NOT be pinned as a persistent
                // attachment on its message (which would re-enter the context
                // window every turn). The tool_result above already gives the
                // model the file content for THIS turn; on later turns it re-reads
                // on demand. This matches the OAuth path, which never attached
                // tool files either. (attachmentEvent is still built above but
                // intentionally left unused.)
                void attachmentEvent;
                if (actLabel) enqueue({ type: 'tool_activity', tool: null });
              }
              // Mid-turn partner interjection: if a note was queued while these
              // tools ran, append it as a text block on the same user turn that
              // carries the tool results, so the model sees it on its next step.
              const injectedClaude = drainInjections(injectTurnId);
              if (injectedClaude.texts.length || injectedClaude.media.length) {
                // Anthropic's own spec: `image` and nothing else. Audio and
                // video are handed off by ref instead of silently filtered,
                // which is what this path used to do to them.
                const prepClaude = await prepareInjectionDelivery({
                  drained: injectedClaude,
                  wire: new Set<MediaKindNarrow>(['image']),
                  model: claudeModel,
                  framing: I.injectionFraming,
                  handoffTemplate: I.injectionAttachmentNote,
                  refsOpenable: hiddenAttachmentsAccessible,
                  pathsVisible: attachmentPathsVisible,
                  refIndex: conversationAttachmentRefs,
                  ja: language === 'ja',
                });
                if (prepClaude.text) toolResultBlocks.push({ type: 'text', text: prepClaude.text });
                toolResultBlocks.push(...anthropicInjectBlocks(prepClaude.deliver));
                if (prepClaude.notice) enqueue({ type: 'notice', content: prepClaude.notice });
                enqueue({ type: 'injection_delivered', count: injectedClaude.texts.length + injectedClaude.media.length });
                // display-only tool/thinking-log event (see OAuth path above)
                try { enqueue({ type: 'tool_call', call: { name: 'partner interjection', kind: 'event', at: Date.now(), input: { texts: injectedClaude.texts, files: prepClaude.logNames } } }); } catch {}
              }
              currentMessages.push({ role: 'user', content: toolResultBlocks });
              // Vessel handoff: the turn is over. Stop BEFORE asking this
              // vessel to continue — the next vessel answers, in a fresh
              // request the client sends after it sees `model_handoff`.
              if (handoffAccepted) break;
              // …and around the loop again. Next iteration the model sees the
              // tool_result blocks and continues its reply.
            }

            // Why the loop stopped, when it wasn't because the model finished.
            // Sent as a notice so it sits beside the message instead of inside
            // it — never persisted into the reply, never replayed to the model.
            if (toolStopNotice) {
              console.warn(`[claude-api] ${toolStopNotice}`);
              enqueue({ type: 'notice', content: toolStopNotice });
            }

            // Emit normalized cache usage just before [DONE]. The frontend
            // stashes this on the AI message for display in the meta bar.
            const usagePayload = normalizeCacheUsage({
              input_tokens: cumUsage.input,
              output_tokens: cumUsage.output,
              cache_read_input_tokens: cumUsage.cacheRead,
              cache_creation_input_tokens: cumUsage.cacheCreate,
            }, 'claude');
            if (usagePayload) enqueue(usagePayload);

            if (claudeWebSourceMap.size > 0) {
              enqueue({ type: 'web_sources', sources: [...claudeWebSourceMap.values()] });
            }

            controller.enqueue(`data: [DONE]\n\n`);
            controller.close();
          } catch (e: any) {
            // After a Stop the client is gone (or the controller was already
            // closed by the stop key), so enqueue() throws "Invalid state".
            // Guard it: the cleanup path must never become the unhandled
            // rejection that takes the dev server's turn down with it.
            try { controller.enqueue(`data: ${JSON.stringify({ error: e.message })}\n\n`); } catch {}
            try { controller.close(); } catch {}
          }
        }
      });

      return new Response(readableStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }
    else if (isGemini) {
      if (!keys.gemini) return NextResponse.json({ error: 'Gemini API key missing in settings.' }, { status: 400 });
      const ai = new GoogleGenAI({ apiKey: keys.gemini });

      const history = processedMessages.slice(0, -1).map((m: any) => ({
        role: m.role === 'user' ? 'user' : 'model',
        parts: [{ text: m.content }]
      }));

      const lastMsg = processedMessages[processedMessages.length - 1].content;

      const geminiConfig: any = {
        systemInstruction: enhancedSystemPrompt,
        temperature: modelParams.temperature,
        topP: modelParams.topP,
        topK: modelParams.topK,
        ...(seedEnabled ? { seed: seedValue } : {}),
      };

      // Thinking configuration for Gemini 3.x models. The valid `thinkingLevel`
      // values are: 'minimal' | 'low' | 'medium' | 'high'. Per Google's docs:
      //   - 3.5 Flash defaults to 'medium', 3.1 Flash Lite defaults to 'minimal'
      //   - There is NO way to fully disable thinking on 3.x — 'minimal' is the
      //     closest (the model may still think a little on complex prompts)
      //   - Without `thinkingConfig`, the SDK uses the model's own default AND
      //     does not stream thought parts back — so it's important to always
      //     pass an explicit object when we want the user-visible thinking
      //     block to appear.
      // Legacy logs saved with thinkingLevel='none' are mapped to 'minimal' for
      // backward compatibility (no UI breakage on old conversations).
      if (specificModel.includes('gemini')) {
        let lvl = modelParams.thinkingLevel;
        if (!lvl || lvl === 'none') lvl = 'minimal';
        // Some Gemini models (Pro variants, and Gemini 3.7 Flash as of launch)
        // reject 'minimal' outright — clamp to the lowest level this specific
        // model actually accepts. Any explicit non-minimal choice (low/medium/
        // high) is always valid and passes through unchanged.
        if (lvl === 'minimal') lvl = resolveGeminiMinThinkingLevel(specificModel);
        geminiConfig.thinkingConfig = {
          thinkingLevel: lvl,
          includeThoughts: true,
        };
      }

      const geminiTools: any[] = [];
      if (modelParams.enableWebSearch) {
        geminiTools.push({ googleSearch: {} });
      }
      if (toolUseEnabled) {
        // Same Read/Write/Edit/Glob/Grep tool surface as the Claude branch —
        // shapes are translated to Gemini's functionDeclarations schema.
        // Read-only mode (SPU agents): Write/Edit are withheld — built as a
        // variable instead of one inline array literal so they can be skipped.
        const fileFunctionDeclarations: any[] = [
            {
              name: 'Read',
              description: `${I.toolReadDesc} ${pathRule}`,
              parameters: {
                type: 'OBJECT',
                properties: {
                  path: { type: 'STRING', description: pathDesc },
                },
                required: ['path'],
              },
            },
        ];
        if (!agentReadOnlyTools) {
          fileFunctionDeclarations.push(
            {
              name: 'Write',
              description: I.toolWriteDesc,
              parameters: {
                type: 'OBJECT',
                properties: {
                  path: { type: 'STRING', description: pathDesc },
                  content: { type: 'STRING', description: 'Full file contents to write' },
                },
                required: ['path', 'content'],
              },
            },
            {
              name: 'Edit',
              description: I.toolEditDesc,
              parameters: {
                type: 'OBJECT',
                properties: {
                  path: { type: 'STRING', description: pathDesc },
                  old_string: { type: 'STRING', description: 'Text to find. Must occur exactly once.' },
                  new_string: { type: 'STRING', description: 'Text to replace it with.' },
                },
                required: ['path', 'old_string', 'new_string'],
              },
            },
          );
        }
        fileFunctionDeclarations.push(
            {
              name: 'Glob',
              description: I.toolGlobDesc,
              parameters: {
                type: 'OBJECT',
                properties: {
                  pattern: { type: 'STRING', description: 'Glob pattern. Use `**` to match all files.' },
                },
                required: ['pattern'],
              },
            },
            {
              name: 'Grep',
              description: I.toolGrepDesc,
              parameters: {
                type: 'OBJECT',
                properties: {
                  pattern: { type: 'STRING', description: 'JavaScript regex (no surrounding slashes).' },
                  file_pattern: { type: 'STRING', description: 'Optional glob to restrict files.' },
                  flags: { type: 'STRING', description: 'Optional regex flags (e.g. "i").' },
                },
                required: ['pattern'],
              },
            },
        );
        geminiTools.push({ functionDeclarations: fileFunctionDeclarations });
        // Dangerous tool: Bash/Shell — gated per-Entity, like Delete on the
        // other paths.
        if (agentDangerousTools) {
          geminiTools.push({
            functionDeclarations: [
              {
                name: 'Bash',
                description: I.toolBashDesc,
                parameters: {
                  type: 'OBJECT',
                  properties: {
                    command: { type: 'STRING', description: 'The shell command to run.' },
                    timeout_ms: { type: 'NUMBER', description: 'Optional timeout in milliseconds (default 60000, max 600000).' },
                  },
                  required: ['command'],
                },
              },
            ],
          });
        }
      }
      if (enableReadConversation) {
        geminiTools.push({
          functionDeclarations: [
            {
              name: 'read_conversation',
              description: I.readConversationDesc,
              parameters: {
                type: 'OBJECT',
                properties: {
                  name: { type: 'STRING', description: I.readConversationNameParam },
                },
                required: ['name'],
              },
            },
            {
              name: 'search_conversations',
              description: I.searchConversationsDesc,
              parameters: {
                type: 'OBJECT',
                properties: {
                  query: { type: 'STRING', description: I.searchConversationsQueryParam },
                  regex: { type: 'BOOLEAN', description: I.searchRegexParam },
                },
                required: ['query'],
              },
            },
            // Same scope as the two above (this being's own past), so same
            // gate — see the OAuth site's comment for why it is not
            // read_attachment's.
            {
              name: 'search_attachments',
              description: I.searchAttachmentsDesc,
              parameters: {
                type: 'OBJECT',
                properties: {
                  query: { type: 'STRING', description: I.searchAttachmentsQueryParam },
                  regex: { type: 'BOOLEAN', description: I.searchRegexParam },
                },
                required: ['query'],
              },
            },
          ],
        });
      }
      if (hiddenAttachmentsAccessible) {
        geminiTools.push({
          functionDeclarations: [
            {
              name: 'read_attachment',
              description: I.readAttachmentDesc,
              parameters: {
                type: 'OBJECT',
                properties: {
                  ref: { type: 'STRING', description: I.readAttachmentPrefixParam },
                  pattern: { type: 'STRING', description: I.readAttachmentPatternParam },
                },
                required: ['ref'],
              },
            },
          ],
        });
      }
      if (lettersEnabled) {
        // Mail between Digital Identities. Gemini needs a `parameters` object on
        // every declaration, so list_letters gets an empty OBJECT rather than
        // being omitted.
        geminiTools.push({
          functionDeclarations: [
            {
              name: 'write_letter',
              description: I.toolWriteLetterDesc,
              parameters: {
                type: 'OBJECT',
                properties: {
                  to: { type: 'ARRAY', items: { type: 'STRING' }, description: I.writeLetterToParam },
                  title: { type: 'STRING', description: I.writeLetterTitleParam },
                  text: { type: 'STRING', description: I.writeLetterTextParam },
                },
                required: ['to', 'title', 'text'],
              },
            },
            {
              name: 'list_letters',
              description: I.toolListLettersDesc,
              parameters: { type: 'OBJECT', properties: {} },
            },
            {
              name: 'list_recipients',
              description: I.toolListRecipientsDesc,
              parameters: { type: 'OBJECT', properties: {} },
            },
            {
              name: 'read_letter',
              description: I.toolReadLetterDesc,
              parameters: {
                type: 'OBJECT',
                properties: { id: { type: 'STRING', description: I.readLetterIdParam } },
                required: ['id'],
              },
            },
            {
              name: 'archive_letter',
              description: I.toolArchiveLetterDesc,
              parameters: {
                type: 'OBJECT',
                properties: { id: { type: 'STRING', description: I.archiveLetterIdParam } },
                required: ['id'],
              },
            },
          ],
        });
      }
      if (browserEnabled) {
        // Browser control. browserToolsGemini() already emits UPPERCASE types
        // and gives the no-parameter tools an empty OBJECT, which Gemini
        // requires — a bare `{}` there rejects the entire tools array, taking
        // every other tool down with it.
        geminiTools.push({ functionDeclarations: browserToolsGemini(I) });
      }
      if (computerControlEnabled) {
        // OS-level mouse/keyboard/screen control. Same UPPERCASE-type / empty-OBJECT
        // requirement as computerToolsGemini() applies here.
        geminiTools.push({ functionDeclarations: computerToolsGemini(I) });
      }
      if (appControlEnabled) {
        // App Control. Same UPPERCASE-type requirement as above.
        geminiTools.push({ functionDeclarations: appToolsGemini(I) });
      }
      // Optional interactive AskUserQuestion tool (independent of file tools).
      if (askUserEnabled) {
        geminiTools.push({
          functionDeclarations: [
            {
              name: 'AskQuestion',
              description: I.askUserDesc,
              parameters: {
                type: 'OBJECT',
                properties: {
                  questions: {
                    type: 'ARRAY',
                    description: 'Between 1 and 4 questions to ask your partner.',
                    items: {
                      type: 'OBJECT',
                      properties: {
                        question: { type: 'STRING', description: 'The full question text. End with a question mark.' },
                        header: { type: 'STRING', description: 'Very short label/chip for the question (max ~12 chars).' },
                        multiSelect: { type: 'BOOLEAN', description: 'Set true to let your partner pick multiple options.' },
                        options: {
                          type: 'ARRAY',
                          description: '2 to 4 distinct, mutually-exclusive choices.',
                          items: {
                            type: 'OBJECT',
                            properties: {
                              label: { type: 'STRING', description: 'Short option label (1-5 words).' },
                              description: { type: 'STRING', description: 'What choosing this option means.' },
                            },
                            required: ['label'],
                          },
                        },
                      },
                      required: ['question', 'options'],
                    },
                  },
                },
                required: ['questions'],
              },
            },
          ],
        });
      }
      // Optional subagent (context-firewall helper) tool.
      if (subagentEnabled) {
        geminiTools.push({
          functionDeclarations: [
            {
              name: 'spawn_subagent',
              description: I.subagentDesc,
              parameters: {
                type: 'OBJECT',
                properties: {
                  task: { type: 'STRING', description: 'A precise, self-contained investigation for the helper to perform.' },
                  return_contract: { type: 'STRING', description: 'Optional: how the distilled result should be shaped/formatted.' },
                },
                required: ['task'],
              },
            },
          ],
        });
      }
      // Optional vessel handoff. UPPERCASE types, same as every other Gemini
      // declaration here; `enum` is accepted on a STRING property.
      if (handoffToolEnabled) {
        geminiTools.push({
          functionDeclarations: [
            {
              name: 'change_model',
              description: I.changeModelDesc,
              parameters: {
                type: 'OBJECT',
                properties: {
                  target: {
                    type: 'STRING',
                    enum: handoffTargetIds,
                    description: `${I.changeModelTargetParam} Available: ${handoffTargetHelp}`,
                  },
                  handoff: { type: 'STRING', description: I.changeModelHandoffParam },
                },
                required: ['target', 'handoff'],
              },
            },
          ],
        });
      }
      if (geminiTools.length) geminiConfig.tools = geminiTools;
      // When mixing a built-in tool (googleSearch) with custom function
      // declarations in the same request, Gemini requires this flag — without
      // it the API rejects with code=400 "Please enable
      // tool_config.include_server_side_tool_invocations". Setting it
      // unconditionally when either tool family is present is harmless.
      if (geminiTools.length) {
        geminiConfig.toolConfig = {
          ...(geminiConfig.toolConfig || {}),
          includeServerSideToolInvocations: true,
        };
      }

      // Since GoogleGenAI `chat.sendMessage` expects to maintain local history object,
      // we can also just use `ai.models.generateContent` with the full history concatenated if `chats.create` with history fails.
      // For simplicity here:
      const fullContents = processedMessages.map((m: any) => {
        const parts: any[] = [];
        m.mediaFiles.forEach((media: any) => {
          if (media.name) {
            parts.push({ text: `<attached_file name="${media.name}" type="${media.mimeType}" />` });
          }
          parts.push({
            inlineData: { mimeType: media.mimeType, data: media.base64Data }
          });
        });

        if (m.content) {
          parts.push({ text: m.content });
        }

        return {
          role: m.role === 'user' ? 'user' : 'model',
          parts: parts.length > 0 ? parts : [{ text: '-' }]
        };
      });

      // Auto-continue when the model reports finishReason="MAX_TOKENS".
      // We re-call with the partial as the model's own turn FOLLOWED BY a user
      // turn asking for the continuation; Gemini continues that answer instead
      // of starting a new one. CRITICAL details:
      //   1) We must REPLACE the previous pair (not append) — Gemini rejects
      //      consecutive model turns.
      //   2) The model turn carries rawModelParts (with thoughtSignature)
      //      verbatim — thinking-capable models reject continuations that have
      //      been stripped or rebuilt as plain { text: ... }.
      //   3) The request must NOT END with that model turn. A bare prefill is
      //      400 "Requests ending with a model turn are not supported" on
      //      gemini-3.5-flash-lite and newer (measured 2026-10-04 across seven
      //      models; 3.1-* and 3.5-flash still accept it). This block was
      //      prefill-only until then, so MAX_TOKENS auto-continuation had been
      //      silently broken on 3.6/3.7/3.8 — found via ふわふわ's report of the
      //      safety-stop retry failing. See gemini-prefill-rejected.md.
      // Increased from 2 to 5 so longer responses survive multiple cuts.
      const MAX_CONTINUATIONS = 5;
      // A mid-stream safety/content-filter stop is a BLOCK, not a token cap, so
      // it gets its own (lower) retry budget: a genuinely-blocked turn must not
      // burn the full continuation allowance re-hitting the same filter.
      // Empirically re-prompting with the partial continues past the
      // filter (it fires on the in-progress span, not the whole turn) — which is
      // why retrying works at all. 3 matches what a human presses "Continue"
      // before giving up.
      const MAX_SAFETY_RETRIES = 3;
      // finishReason values that mean "a filter cut the turn", as opposed to a
      // normal end (STOP) or a token cap (MAX_TOKENS). A silent stop sets none of
      // these — we deliberately do NOT auto-continue that case (indistinguishable
      // from a normal end; the manual Continue button covers it). MALFORMED_/
      // UNEXPECTED_ tool calls are excluded too: continuing cannot fix them.
      const GEMINI_BLOCK_REASONS = new Set([
        'SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'SPII',
        'BLOCKLIST', 'LANGUAGE', 'IMAGE_SAFETY', 'OTHER',
      ]);
      const geminiModelId = specificModel?.includes('gemini') ? specificModel : 'gemini-3.5-flash';


      // One attempt at one Gemini call. `emitFlag` flips the moment anything has
      // been written to the client for THIS attempt — the retry wrapper below
      // refuses to retry after that point, because re-running a call whose text
      // is already on screen would duplicate it.
      const runGeminiAttempt = async (contents: any[], controller: ReadableStreamDefaultController, emitFlag: { emitted: boolean }) => {
        const stream = await ai.models.generateContentStream({
          model: geminiModelId,
          contents,
          // abortSignal lives INSIDE config for @google/genai (not a sibling of
          // it) — verified against GenerateContentConfig in the installed
          // genai.d.ts, not from memory. Note what Google's own doc comment
          // says there: it is client-only and does NOT cancel the request
          // service-side, so usage is still billed. It still matters here,
          // because it ends the await and lets the tool loop stop.
          config: { ...geminiConfig, abortSignal: turnAbort.signal },
        });
        let visibleText = '';
        let thoughtText = '';
        let finishReason: string | null = null;
        let chunkCount = 0;
        const functionCalls: { name: string; args: any }[] = [];
        // Capture every raw part the model emits, in order, so we can echo
        // them back verbatim on the next API call. This is essential for
        // Gemini's thinking-capable models — they attach a `thoughtSignature`
        // to functionCall parts as proof-of-thinking and reject subsequent
        // turns where the signature has been stripped or rebuilt.
        const rawModelParts: any[] = [];
        // Capture Gemini's usage metadata. It arrives on each chunk and
        // contains cumulative-to-now counts (promptTokenCount,
        // candidatesTokenCount, cachedContentTokenCount); we keep the latest
        // for the final cache_usage emission.
        let lastUsageMetadata: any = null;
        // Input-side block report. Gemini puts refusals that happen BEFORE
        // generation here (`blockReason`), where no candidate is produced at
        // all — so `finishReason` stays null and the turn looks like a plain
        // silent stop. Nothing read this until now.
        let promptFeedback: any = null;
        // Grounding citations from Google Search. Each grounding chunk carries
        // a `web: { uri, title }` for a page the model actually consulted.
        const geminiSourceMap = new Map<string, { url: string; title?: string }>();
        for await (const chunk of stream) {
          if ((chunk as any).usageMetadata) lastUsageMetadata = (chunk as any).usageMetadata;
          if ((chunk as any).promptFeedback?.blockReason) promptFeedback = (chunk as any).promptFeedback;
          const gm = (chunk as any).candidates?.[0]?.groundingMetadata;
          if (gm?.groundingChunks && Array.isArray(gm.groundingChunks)) {
            for (const gc of gm.groundingChunks) {
              const uri = gc?.web?.uri;
              if (typeof uri === 'string' && /^https?:\/\//i.test(uri) && !geminiSourceMap.has(uri)) {
                geminiSourceMap.set(uri, { url: uri, ...(gc.web.title ? { title: String(gc.web.title) } : {}) });
              }
            }
          }
          chunkCount++;
          if (chunkCount <= 2) {
            try {
              const sample = JSON.stringify(chunk).slice(0, 500);
              console.log(`[gemini] ${geminiModelId} chunk ${chunkCount} raw:`, sample);
            } catch {}
          }
          const cand = chunk.candidates?.[0];
          if (cand?.content?.parts) {
            for (const part of cand.content.parts as any[]) {
              // Preserve the exact part shape (with thoughtSignature etc.) for echo-back
              rawModelParts.push(part);

              // Process for UI emission
              if (part.functionCall) {
                functionCalls.push({
                  name: part.functionCall.name,
                  args: part.functionCall.args || {},
                });
                continue;
              }
              // Only the explicit `thought: true` flag marks a part as thinking.
              // `thoughtSignature` appears on REGULAR text parts too (as a
              // continuity-proof token Gemini attaches after thinking models
              // have generated something). Using thoughtSignature as a
              // thought indicator misroutes the visible answer to the
              // collapsible thinking block, leaving the bubble empty.
              const isThought = part.thought === true;
              if (isThought) {
                const t = part.text || '';
                if (t) {
                  thoughtText += t;
                  emitFlag.emitted = true;
                  // betrayalSend, not controller.enqueue: this site sits
                  // upstream of the stream's `enqueue` helper, and Gemini is
                  // the provider the betrayal guard exists for. Bypassing it
                  // here would leave exactly the path that needs watching
                  // unwatched.
                  betrayalSend(controller, { type: 'thought', content: t });
                }
              } else if (part.text) {
                visibleText += part.text;
                emitFlag.emitted = true;
                betrayalSend(controller, { type: 'text', content: part.text });
              }
            }
          }
          if (cand?.finishReason) finishReason = cand.finishReason;
        }
        console.log(`[gemini] ${geminiModelId} chunks=${chunkCount} visible=${visibleText.length}c thought=${thoughtText.length}c finish=${finishReason} fnCalls=${functionCalls.length} parts=${rawModelParts.length}${promptFeedback?.blockReason ? ` blockReason=${promptFeedback.blockReason}` : ''}`);
        if (visibleText.length > 0) {
          console.log(`[gemini]   visible[0..120]: ${JSON.stringify(visibleText.slice(0, 120))}`);
        }
        if (rawModelParts.length > 0 && visibleText.length === 0 && functionCalls.length === 0) {
          // Empty turn — log raw shapes so we can see what came back.
          console.log('[gemini]   EMPTY TURN — raw part shapes:', rawModelParts.map((p: any) => Object.keys(p)).slice(0, 10));
          console.log('[gemini]   first part sample:', JSON.stringify(rawModelParts[0]).slice(0, 400));
        }
        return { visibleText, finishReason, functionCalls, rawModelParts, usageMetadata: lastUsageMetadata, webSources: [...geminiSourceMap.values()], promptFeedback };
      };

      // Gemini's per-minute input-token quota rejects the whole request BEFORE
      // generation, and returns the exact wait to observe. Nothing was produced,
      // so re-sending the identical `contents` is a resume, not a restart:
      //  - every prior tool round is already in `contents`, verbatim, including
      //    the `thoughtSignature` on each part (see the echo-back at the tool
      //    loop below), so signature continuity is preserved;
      //  - the failing call generated nothing, so there is no partial text to
      //    reconcile and nothing was billed for it.
      // The only unsafe case is a 429 that surfaces mid-stream after text has
      // already reached the client; `emitFlag` detects that and declines to
      // retry rather than risk duplicating the visible answer.
      const GEMINI_QUOTA_MAX_RETRIES = 3;
      const runGeminiOnce = async (contents: any[], controller: ReadableStreamDefaultController) => {
        for (let attempt = 0; ; attempt++) {
          const emitFlag = { emitted: false };
          try {
            return await runGeminiAttempt(contents, controller, emitFlag);
          } catch (e: any) {
            const waitMs = parseRetryDelayMs(e);
            if (waitMs === null || emitFlag.emitted || attempt >= GEMINI_QUOTA_MAX_RETRIES) throw e;
            const secs = Math.round(waitMs / 1000);
            console.log(`[gemini] quota 429 — waiting ${secs}s then retrying (attempt ${attempt + 2}/${GEMINI_QUOTA_MAX_RETRIES + 1})`);
            // Surfaced as a notice (never as reply text) so the pause is visible
            // and explained, and as an activity label so the loading line and the
            // tab title say what is happening instead of looking frozen.
            try {
              controller.enqueue(`data: ${JSON.stringify({
                type: 'notice',
                content: `Gemini's per-minute input-token quota was reached. Waiting ${secs}s as the provider asked, then continuing the same turn`
                  + ` (attempt ${attempt + 2} of ${GEMINI_QUOTA_MAX_RETRIES + 1}). Nothing was generated or lost — the request was refused before the model ran.`,
              })}\n\n`);
              controller.enqueue(`data: ${JSON.stringify({
                type: 'tool_activity', name: 'rate_limit_wait', tool: `wait ${secs}s for the rate limit`,
              })}\n\n`);
            } catch {}
            await new Promise(r => setTimeout(r, waitMs));
            try { controller.enqueue(`data: ${JSON.stringify({ type: 'tool_activity', tool: null, name: null })}\n\n`); } catch {}
          }
        }
      };

      const readableStream = new ReadableStream({
        async start(controller) {
          const enqueue = (obj: any) => betrayalSend(controller, obj);
          registerActiveTurnStop(() => { try { controller.close(); } catch {} try { turnAbort.abort(); } catch {} });
          // Identify the model+thinking-mode about to respond (see Claude branch above).
          enqueue(modelSelectedPayload);
          emitSenseEvents(controller);
          const MAX_TOOL_ITERATIONS = MAX_TOOL_ROUNDS;
          const repeatGuard = makeRepeatGuard();
          let toolStopNotice = '';
          try {
            let contents = [...fullContents];
            let continuationAttempts = 0;
            let safetyRetries = 0;
            let toolIterations = 0;
            let totalVisibleEmitted = 0;
            let lastFinishReason: string | null = null;
            // Per-iteration state for the end-of-turn diagnostic. `totalVisible`
            // alone is not enough: a turn that says something, calls a tool, and
            // then dies silently has totalVisible > 0 and used to end with no
            // explanation at all. What matters is whether the LAST iteration
            // produced anything.
            let lastVisibleLen = 0;
            let lastThoughtOnly = false;
            let lastBlockReason: string | null = null;
            let lastPartCount = 0;
            // Accumulated raw model parts from prior continuations. When we
            // continue, we replace the trailing model turn (and the user turn
            // that follows it) with one containing every part the model has
            // emitted so far (text, thought, thoughtSignature). This preserves
            // signature continuity and avoids stacking consecutive model turns.
            let cumulativeContinuationParts: any[] = [];
            let lastIterationWasContinuation = false;
            // Sum of every iteration's usageMetadata so the final cache_usage
            // event reflects the whole turn (tool loop + continuations).
            let cumGeminiUsage: { promptTokenCount: number; candidatesTokenCount: number; cachedContentTokenCount: number } =
              { promptTokenCount: 0, candidatesTokenCount: 0, cachedContentTokenCount: 0 };
            // Grounding citations deduped across the whole turn.
            const cumGeminiSourceMap = new Map<string, { url: string; title?: string }>();

            // Durable record of a mid-stream safety/content stop, written into the
            // TOOL HISTORY (not a transient notice) so the occurrence — and the
            // exact finishReason — survive in the saved log and can be measured
            // after the fact. Same `kind:'event'` shape as automatic compaction.
            const recordGeminiStop = (
              reason: string | null | undefined,
              action: 'auto-continue' | 'stopped',
              extra: Record<string, unknown> = {},
            ) => {
              try {
                enqueue({
                  type: 'tool_call',
                  call: {
                    name: 'gemini safety stop',
                    kind: 'event',
                    at: Date.now(),
                    input: { finishReason: reason ?? null, action, ...extra },
                  },
                });
              } catch {}
            };

            while (true) {
              if (turnAbort.signal.aborted) break;   // Stop must end the tool loop, not just the output
              if (toolIterations >= MAX_TOOL_ITERATIONS) {
                toolStopNotice = toolLimitNotice(MAX_TOOL_ITERATIONS);
                // One final tools-free call so the model writes its closing answer
                // from what it has already gathered, instead of dying with no output.
                try {
                  enqueue({ type: 'tool_activity', tool: 'write the final answer' });
                  const savedTools = geminiConfig.tools;
                  const savedToolConfig = geminiConfig.toolConfig;
                  delete geminiConfig.tools;
                  delete geminiConfig.toolConfig;
                  try {
                    const wrapContents = contents.map((c: any, ci: number) =>
                      ci === contents.length - 1
                        ? { ...c, parts: [...c.parts, { text: toolWrapUpInstruction(language) }] }
                        : c
                    );
                    const wrap = await runGeminiOnce(wrapContents, controller);
                    if (wrap.usageMetadata) {
                      cumGeminiUsage.promptTokenCount += Number(wrap.usageMetadata.promptTokenCount || 0);
                      cumGeminiUsage.candidatesTokenCount += Number(wrap.usageMetadata.candidatesTokenCount || 0);
                      cumGeminiUsage.cachedContentTokenCount += Number(wrap.usageMetadata.cachedContentTokenCount || 0);
                    }
                    totalVisibleEmitted += wrap.visibleText.length;
                    lastFinishReason = wrap.finishReason;
                    lastVisibleLen = wrap.visibleText.length;
                    lastPartCount = wrap.rawModelParts.length;
                    lastBlockReason = wrap.promptFeedback?.blockReason ? String(wrap.promptFeedback.blockReason) : null;
                    lastThoughtOnly = wrap.visibleText.length === 0 && wrap.functionCalls.length === 0 && wrap.rawModelParts.length > 0;
                    for (const ws of (wrap.webSources || [])) {
                      if (!cumGeminiSourceMap.has(ws.url)) cumGeminiSourceMap.set(ws.url, ws);
                    }
                  } finally {
                    if (savedTools !== undefined) geminiConfig.tools = savedTools;
                    if (savedToolConfig !== undefined) geminiConfig.toolConfig = savedToolConfig;
                  }
                } catch (e: any) {
                  console.warn('[gemini] wrap-up call failed:', e?.message);
                } finally {
                  enqueue({ type: 'tool_activity', tool: null });
                }
                break;
              }
              const { visibleText, finishReason, functionCalls, rawModelParts, usageMetadata, webSources, promptFeedback } = await runGeminiOnce(contents, controller);
              for (const s of (webSources || [])) {
                if (!cumGeminiSourceMap.has(s.url)) cumGeminiSourceMap.set(s.url, s);
              }
              if (usageMetadata) {
                cumGeminiUsage.promptTokenCount += Number(usageMetadata.promptTokenCount || 0);
                cumGeminiUsage.candidatesTokenCount += Number(usageMetadata.candidatesTokenCount || 0);
                cumGeminiUsage.cachedContentTokenCount += Number(usageMetadata.cachedContentTokenCount || 0);
              }
              totalVisibleEmitted += visibleText.length;
              lastFinishReason = finishReason;
              lastVisibleLen = visibleText.length;
              lastPartCount = rawModelParts.length;
              lastBlockReason = promptFeedback?.blockReason ? String(promptFeedback.blockReason) : null;
              // Thought parts arrived but nothing addressed to the user.
              lastThoughtOnly = visibleText.length === 0 && functionCalls.length === 0 && rawModelParts.length > 0;

              // 1) Function calls → execute, append model+user turns, loop
              if (functionCalls.length > 0) {
                // Progress check before spending anything (see makeRepeatGuard).
                {
                  let stuck: string | null = null;
                  for (const fc of functionCalls) {
                    const hit = repeatGuard(fc.name, fc.args);
                    if (hit) { stuck = hit; break; }
                  }
                  if (stuck) { toolStopNotice = toolRepeatNotice(stuck); break; }
                }
                toolIterations++;
                // Echo the assistant turn back VERBATIM (with thoughtSignature
                // intact on each functionCall part) so thinking models accept it.
                contents = [...contents, { role: 'model', parts: rawModelParts }];

                // Execute each call, build functionResponse parts for one user turn.
                // Image reads produce an extra `inlineData` part in the same user turn so
                // the model can actually see the picture, not just text describing it.
                const fnRespParts: any[] = [];
                const extraInlineParts: any[] = [];
                for (const fc of functionCalls) {
                  // A tool call already returned by the model must NOT execute
                  // after Stop — this is where ghost mouse/keyboard input came from.
                  if (turnAbort.signal.aborted) break;
                  let result: any = {};
                  let attachmentEvent: any = null;
                  // Reflect the tool call in the loading label (silent otherwise).
                  const actLabel = toolActivityLabel(fc.name);
                  if (actLabel) enqueue({ type: 'tool_activity', tool: actLabel, name: fc.name });
                  enqueue({ type: 'tool_call', call: { name: fc.name, input: truncateToolInput(fc.args), at: Date.now() } });
                  try {
                    if (fc.name === 'Read') {
                      const p = String(fc.args?.path || '');
                      if (isImageFilename(p)) {
                        const bin = await readWorkspaceFileBinary(folderName, p, { fullAccess: agentFullSystemAccess });
                        if (!bin) {
                          result = { error: `image not found or path outside workspace: ${p}` };
                        } else {
                          const base64 = bin.data.toString('base64');
                          // Minimal, neutral metadata — no hidden instruction in here.
                          // All guidance lives in the user-controlled toolImageInstruction
                          // template (added as a separate text part below). If the user
                          // blanks that out, the model receives only this metadata + the
                          // raw image bytes.
                          result = {
                            ok: true,
                            filename: p,
                            mimeType: bin.mimeType,
                          };
                          extraInlineParts.push({ inlineData: { mimeType: bin.mimeType, data: base64 } });
                          // User-controlled hint text. {filename} substituted; empty string disables.
                          const hintTemplate = (toolImageInstruction || '').trim();
                          if (hintTemplate) {
                            const hint = hintTemplate.replace(/\{filename\}/g, p);
                            extraInlineParts.push({ text: hint });
                          }
                          attachmentEvent = {
                            type: 'file_attachment',
                            attachment: {
                              name: p,
                              type: bin.mimeType,
                              size: bin.data.length,
                              isImage: true,
                              ...(await toolAttachmentPayload(bin.data, bin.mimeType, base64)),
                              tokens: Math.max(1, Math.ceil(bin.data.length / 750)),
                              excluded: false,
                              toolAction: 'read',
                            },
                          };
                        }
                      } else {
                        const text = await readWorkspaceFile(folderName, p, { fullAccess: agentFullSystemAccess });
                        if (text == null) {
                          result = { error: `file not found or path outside workspace: ${p}` };
                        } else {
                          result = { content: text };
                          attachmentEvent = {
                            type: 'file_attachment',
                            attachment: {
                              name: p,
                              type: 'text/plain',
                              size: text.length,
                              isText: true,
                              textData: text,
                              tokens: Math.ceil(text.length / 4),
                              excluded: false,
                              toolAction: 'read',
                            },
                          };
                        }
                      }
                    } else if (fc.name === 'Write') {
                      const p = String(fc.args?.path || '');
                      const c = String(fc.args?.content ?? '');
                      const wr = await writeWorkspaceFile(folderName, p, c, { fullAccess: agentFullSystemAccess });
                      if (!wr.ok) {
                        result = { error: wr.error || 'write failed' };
                      } else {
                        result = { ok: true, existed: wr.existed, bytes: c.length };
                        attachmentEvent = {
                          type: 'file_attachment',
                          attachment: {
                            name: p,
                            type: 'text/plain',
                            size: c.length,
                            isText: true,
                            textData: c,
                            tokens: Math.ceil(c.length / 4),
                            excluded: false,
                            toolAction: wr.existed ? 'modified' : 'created',
                          },
                        };
                      }
                    } else if (fc.name === 'Edit') {
                      const p = String(fc.args?.path || '');
                      const oldS = String(fc.args?.old_string ?? '');
                      const newS = String(fc.args?.new_string ?? '');
                      const ed = await editWorkspaceFile(folderName, p, oldS, newS, { fullAccess: agentFullSystemAccess });
                      if (!ed.ok) {
                        result = { error: ed.error || 'edit failed' };
                      } else {
                        const after = (await readWorkspaceFile(folderName, p, { fullAccess: agentFullSystemAccess })) || '';
                        result = { ok: true, bytes_replaced: oldS.length, bytes_inserted: newS.length };
                        attachmentEvent = {
                          type: 'file_attachment',
                          attachment: {
                            name: p,
                            type: 'text/plain',
                            size: after.length,
                            isText: true,
                            textData: after,
                            tokens: Math.ceil(after.length / 4),
                            excluded: false,
                            toolAction: 'modified',
                          },
                        };
                      }
                    } else if (fc.name === 'Glob') {
                      const pat = String(fc.args?.pattern || '**');
                      const matches = await globWorkspaceFiles(folderName, pat);
                      result = { files: matches };
                    } else if (fc.name === 'Grep') {
                      const pat = String(fc.args?.pattern || '');
                      const filePat = fc.args?.file_pattern ? String(fc.args.file_pattern) : undefined;
                      const flags = fc.args?.flags ? String(fc.args.flags) : undefined;
                      const gr = await grepWorkspaceFiles(folderName, pat, { filePattern: filePat, flags });
                      if (!gr.ok) result = { error: gr.error };
                      else result = { matches: gr.matches };
                    } else if (fc.name === 'Bash') {
                      // DANGEROUS shell execution — only present when
                      // agentDangerousTools gated the tool in above.
                      const cmd = String(fc.args?.command || '');
                      if (!cmd.trim()) {
                        result = { error: 'Bash requires a non-empty "command".' };
                      } else {
                        const cwd = await ensureWorkspace(folderName);
                        const sh = await runShellCommand(cmd, { cwd, timeoutMs: Number(fc.args?.timeout_ms) || undefined, signal: turnAbort.signal });
                        result = { output: sh.output };
                      }
                    } else if (fc.name === 'read_conversation') {
                      // Pull a past conversation by name. Inactive ("non-public")
                      // conversations are refused inside readConversationByName.
                      // Large transcripts are mirrored to the being's workspace
                      // and only a path is returned — see conversationRead.ts.
                      const name = String(fc.args?.name || fc.args?.title || '').trim();
                      const r = await readConversationByName(folderName, name, {
                        showPaths: attachmentPathsVisible,
                        fileTools: toolUseEnabled,
                        currentConvoId: convoId,
                      });
                      result = { report: formatReadConversationResult(r) };
                    } else if (fc.name === 'search_conversations') {
                      // Search across the entity's conversations; inactive ones
                      // excluded (privacy). Nothing is saved.
                      const sr = await searchConversations(folderName, String(fc.args?.query || fc.args?.q || '').trim(), { excludeInactive: true, regex: !!fc.args?.regex });
                      result = { report: formatSearchForTool(sr, attachmentPathsVisible) };
                    } else if (fc.name === 'read_attachment') {
                      // Gemini's inlineData part carries image/audio/video
                      // natively, so all three kinds are restorable here —
                      // unlike the Anthropic wire format, which only has an
                      // image block type.
                      const r = await runReadAttachment({ prefix: String(fc.args?.ref || ''), pattern: fc.args?.pattern, folderName, index: conversationAttachmentRefs, specificModel: geminiModelId, nativeMediaKinds: new Set(['image', 'audio', 'video']) });
                      result = { report: r.text };
                      if (r.media) {
                        extraInlineParts.push({ inlineData: { mimeType: r.media.mimeType, data: r.media.base64 } });
                      }
                    } else if (fc.name === 'search_attachments') {
                      result = { report: await runSearchAttachments(folderName, String(fc.args?.query || '').trim(), !!fc.args?.regex, attachmentPathsVisible) };
                    } else if ((LETTER_TOOL_NAMES as readonly string[]).includes(fc.name)) {
                      // Mail between identities. `me` is folderName — the sender
                      // is never taken from the model's arguments.
                      result = { report: await runLetterTool(fc.name, fc.args || {}, { me: folderName, convoId, instructions: I }) };
                    } else if ((BROWSER_TOOL_NAMES as readonly string[]).includes(fc.name)) {
                      // Browser control. Allowlist enforcement lives in the
                      // executor, not here — see the Claude API site.
                      result = { report: await runBrowserTool(fc.name, fc.args || {}, {
                        me: folderName, allowedHosts: browserAllowedHosts,
                        allowAnyHost: browserAllowAnyHost, instructions: I,
                      }) };
                    } else if ((COMPUTER_TOOL_NAMES as readonly string[]).includes(fc.name)) {
                      // OS-level mouse/keyboard/screen control. computer_screenshot
                      // delivers a real image via extraInlineParts, same as Read
                      // does for an image file.
                      // heightTarget: Gemini answers coordinates in EITHER image
                      // pixels or a 0–1000 normalized space, picked per response
                      // (55% normalized over 55 measured runs). Delivering at
                      // height 1000 makes the two answers identical, so the fault
                      // cannot be expressed. Gemini-only — the other provider
                      // paths are unmeasured for this and stay as they are.
                      const cr = await runComputerTool(fc.name, fc.args || {}, {
                        me: folderName,
                        instructions: I,
                        language,
                        heightTarget: NORMALIZED_COORD_SAFE_HEIGHT,
                      });
                      result = { report: cr.text };
                      if (cr.image) {
                        extraInlineParts.push({ inlineData: { mimeType: cr.image.mimeType, data: cr.image.base64 } });
                        attachmentEvent = {
                          type: 'file_attachment',
                          attachment: {
                            name: `screenshot_${Date.now()}.png`,
                            type: cr.image.mimeType,
                            size: Math.ceil(cr.image.base64.length * 0.75),
                            isImage: true,
                            ...(await toolAttachmentPayload(Buffer.from(cr.image.base64, 'base64'), cr.image.mimeType, cr.image.base64)),
                            tokens: Math.max(1, Math.ceil(cr.image.base64.length * 0.75 / 750)),
                            excluded: false,
                            toolAction: 'read',
                          },
                        };
                      }
                    } else if ((APP_TOOL_NAMES as readonly string[]).includes(fc.name)) {
                      // App Control via UI Automation — app_shot delivers its
                      // image via extraInlineParts, same as computer_screenshot.
                      const ar = await runAppTool(fc.name, fc.args || {}, { me: folderName, instructions: I });
                      result = { report: ar.text };
                      if (ar.image) {
                        extraInlineParts.push({ inlineData: { mimeType: ar.image.mimeType, data: ar.image.base64 } });
                        attachmentEvent = {
                          type: 'file_attachment',
                          attachment: {
                            name: `app_shot_${Date.now()}.png`,
                            type: ar.image.mimeType,
                            size: Math.ceil(ar.image.base64.length * 0.75),
                            isImage: true,
                            ...(await toolAttachmentPayload(Buffer.from(ar.image.base64, 'base64'), ar.image.mimeType, ar.image.base64)),
                            tokens: Math.max(1, Math.ceil(ar.image.base64.length * 0.75 / 750)),
                            excluded: false,
                            toolAction: 'read',
                          },
                        };
                      }
                    } else if (fc.name === 'AskQuestion') {
                      // Pause the turn: emit the question, wait for the user's
                      // selection (or the configured timeout), return it as the
                      // functionResponse. Same rendezvous as the other paths.
                      const questions = normalizeQuestions(fc.args);
                      if (questions.length === 0) {
                        result = { error: 'AskQuestion requires 1-4 questions, each with 2-4 options.' };
                      } else {
                        const askId = createAskId();
                        enqueue({ type: 'ask_user', askId, questions });
                        const answered = await waitForAsk(askId, Number(askUserTimeoutMs) || 0);
                        const timedOut = answered === null;
                        const finalAnswers = timedOut ? recommendedDefaults(questions) : answered!;
                        enqueue({ type: 'ask_user_resolved', askId, answers: finalAnswers, timedOut });
                        result = { answer: formatAnswerForModel(finalAnswers, timedOut) };
                      }
                    } else if (fc.name === 'change_model') {
                      // Vessel handoff. Only an ACCEPTED switch ends the turn.
                      const o = runChangeModel(fc.args, handoffCtx);
                      result = { result: o.resultText };
                      if (o.switched) {
                        const acc = { model: o.model, note: o.note };
                        handoffAccepted = acc;
                        enqueue(handoffPayload(acc));
                      }
                    } else if (fc.name === 'spawn_subagent') {
                      // Context firewall: a fresh read-only child investigates
                      // and returns only its distilled result. Child model
                      // defaults to a fast Gemini; non-Gemini values fall back.
                      const task = String(fc.args?.task || '');
                      if (!task.trim()) {
                        result = { error: 'spawn_subagent requires a non-empty "task".' };
                      } else {
                        enqueue({ type: 'subagent_start', task });
                        // Route by the chosen model's family. Empty → a fast
                        // Gemini child on the same Google key.
                        const childFamily = subagentFamily && subagentFamily.trim() ? subagentFamily.trim() : 'Gemini';
                        const childModel = subagentModel && subagentModel.trim() ? subagentModel.trim() : 'gemini-3.1-flash-lite';
                        const sub = await runSubagent({
                          family: childFamily, model: childModel, keys, task,
                          returnContract: fc.args?.return_contract ? String(fc.args.return_contract) : undefined,
                          folderName, fullAccess: agentFullSystemAccess,
                          webSearch: !!(modelParams?.enableWebSearch || modelParams?.enableClaudeWebSearch),
                        });
                        cumGeminiUsage.promptTokenCount += sub.usage.input;
                        cumGeminiUsage.candidatesTokenCount += sub.usage.output;
                        enqueue({ type: 'subagent_done', task, result: sub.text, via: sub.via });
                        result = { result: sub.text || '(subagent returned nothing)' };
                      }
                    } else {
                      result = { error: `unknown function: ${fc.name}` };
                    }
                  } catch (e: any) {
                    result = { error: e?.message || 'tool execution failed' };
                  }
                  fnRespParts.push({ functionResponse: { name: fc.name, response: result } });
                  // Deliberately NOT emitting `attachmentEvent` — see the note on
                  // the Claude path: tool files are not pinned as persistent
                  // message attachments (no context-window re-entry every turn),
                  // matching the OAuth path. The functionResponse above already
                  // hands the model the content for this turn.
                  void attachmentEvent;
                  if (actLabel) enqueue({ type: 'tool_activity', tool: null });
                }
                // Mid-turn partner interjection: append as a text part on the
                // same user turn that carries the function responses.
                const injectedGemini = drainInjections(injectTurnId);
                const injectParts: any[] = [];
                if (injectedGemini.texts.length || injectedGemini.media.length) {
                  // Gemini's `inlineData` part carries any mime — image, audio
                  // and video alike — which is why this is the one path where
                  // an interjection can hand over a voice clip as real audio.
                  const prepG = await prepareInjectionDelivery({
                    drained: injectedGemini,
                    wire: new Set<MediaKindNarrow>(['image', 'audio', 'video']),
                    model: geminiModelId,
                    framing: I.injectionFraming,
                    handoffTemplate: I.injectionAttachmentNote,
                    refsOpenable: hiddenAttachmentsAccessible,
                    pathsVisible: attachmentPathsVisible,
                    refIndex: conversationAttachmentRefs,
                    ja: language === 'ja',
                  });
                  if (prepG.text) injectParts.push({ text: prepG.text });
                  injectParts.push(...geminiInjectParts(prepG.deliver));
                  if (prepG.notice) enqueue({ type: 'notice', content: prepG.notice });
                  enqueue({ type: 'injection_delivered', count: injectedGemini.texts.length + injectedGemini.media.length });
                  // display-only tool/thinking-log event (see OAuth path above)
                  try { enqueue({ type: 'tool_call', call: { name: 'partner interjection', kind: 'event', at: Date.now(), input: { texts: injectedGemini.texts, files: prepG.logNames } } }); } catch {}
                }
                contents = [...contents, { role: 'user', parts: [...fnRespParts, ...extraInlineParts, ...injectParts] }];
                // Vessel handoff: the turn is over — don't ask this vessel to
                // continue. The client re-POSTs as the new vessel.
                if (handoffAccepted) break;
                continue; // loop — model will continue with the function responses visible
              }

              // 2) No function calls, but the turn stopped short → continuation
              // prefill. Two causes, two budgets:
              //   • MAX_TOKENS — hit the output cap. finishReason "MAX_TOKENS"
              //     (some SDK paths surface the enum or a lowercased form, so
              //     match defensively).
              //   • A safety/content filter cut the turn mid-stream. These are
              //     BLOCKS (finishReason SAFETY / RECITATION / … — see
              //     GEMINI_BLOCK_REASONS), retried on a separate, smaller budget.
              // Both re-send the partial as the model's own turn followed by a
              // user turn asking for the continuation (NOT a bare prefill —
              // that is a 400 on 3.5-flash-lite and newer), so Gemini continues
              // past the stop instead of restarting. A silent stop
              // (null/STOP with truncated text) matches NEITHER and is not
              // auto-continued — we can't tell it from a normal end.
              const fr = String(finishReason || '').toUpperCase();
              const truncated = fr === 'MAX_TOKENS' || fr.includes('MAX_TOKEN');
              const blocked = GEMINI_BLOCK_REASONS.has(fr);
              const canContinueTrunc = truncated && continuationAttempts < MAX_CONTINUATIONS;
              const canContinueBlock = blocked && safetyRetries < MAX_SAFETY_RETRIES;
              if ((canContinueTrunc || canContinueBlock) && rawModelParts.length > 0) {
                // Accumulate THIS iteration's raw parts into the running prefill.
                cumulativeContinuationParts = [...cumulativeContinuationParts, ...rawModelParts];
                // If we already added a continuation PAIR last time, drop BOTH
                // entries before re-appending. Dropping only the model turn
                // (slice(0,-1), what this did until 2026-10-04) would leave the
                // stale user instruction in place and stack a second model turn
                // directly after it — re-breaking the very shape fixed below.
                if (lastIterationWasContinuation) {
                  contents = contents.slice(0, -2);
                }
                // The partial goes back as the model's own turn, FOLLOWED BY a
                // user turn asking for the continuation. A request whose last
                // entry is a model turn (a bare prefill) is rejected with 400
                // "Requests ending with a model turn are not supported" on
                // gemini-3.5-flash-lite and newer — measured across all seven
                // models; see gemini-prefill-rejected.md. Real thought parts and
                // thoughtSignature survive this shape (measured: resumed from
                // mid-sentence after the comma).
                contents = [
                  ...contents,
                  { role: 'model', parts: cumulativeContinuationParts.slice() },
                  {
                    role: 'user',
                    parts: [{
                      text: canContinueBlock
                        ? I.blockedContinuationInstruction
                        : I.continuationInstruction,
                    }],
                  },
                ];
                lastIterationWasContinuation = true;
                if (canContinueBlock) {
                  safetyRetries++;
                  // Record the occurrence in the tool history (durable, structured),
                  // not as a transient notice — she asked for the record to live
                  // THERE so a silent auto-retry past a filter still shows itself
                  // and the finishReason stays measurable in the saved log.
                  recordGeminiStop(finishReason, 'auto-continue', { attempt: safetyRetries, max: MAX_SAFETY_RETRIES });
                  console.log(`[gemini] safety-continue ${safetyRetries}/${MAX_SAFETY_RETRIES} — finishReason=${finishReason}, visible so far=${totalVisibleEmitted}c`);
                } else {
                  continuationAttempts++;
                  console.log(`[gemini] continuation ${continuationAttempts}/${MAX_CONTINUATIONS} — finishReason=${finishReason}, cumulative parts=${cumulativeContinuationParts.length}, visible so far=${totalVisibleEmitted}c`);
                }
                continue;
              }

              if (truncated) {
                console.warn(`[gemini] truncated but cannot continue: continuationAttempts=${continuationAttempts}/${MAX_CONTINUATIONS}, rawModelParts=${rawModelParts.length}`);
              }
              if (blocked) {
                // Terminal block: either no partial to prefill, or the retry
                // budget is spent. Record it so the saved log shows the answer
                // ended on a filter, not a normal STOP.
                recordGeminiStop(finishReason, 'stopped', {
                  retries: safetyRetries,
                  reason: rawModelParts.length > 0 ? 'retry budget exhausted' : 'no partial to continue',
                });
                console.warn(`[gemini] blocked and cannot continue: safetyRetries=${safetyRetries}/${MAX_SAFETY_RETRIES}, rawModelParts=${rawModelParts.length}, finishReason=${finishReason}`);
              }

              // 3) Done
              break;
            }

            if (continuationAttempts > 0) {
              enqueue({ type: 'continued', count: continuationAttempts });
            }
            // If the whole exchange produced zero visible text, the model
            // either thought-only with no answer (common with thinking models
            // when the thinking budget consumed all output tokens) or was
            // refused/blocked. Surface it instead of leaving the user with
            // a silent empty bubble.
            if ((totalVisibleEmitted === 0 || lastVisibleLen === 0) && !toolStopNotice) {
              const fin = String(lastFinishReason || '').toUpperCase();
              // Name the reason Gemini gave. These are the documented
              // finishReason values; anything unrecognised falls through with
              // the raw string so we never hide it behind a guess.
              const REASONS: Record<string, string> = {
                STOP: 'the model ended its turn normally — it simply had nothing more to say after the tool result',
                MAX_TOKENS: 'output token limit reached (with thinking on, the thinking budget can consume the whole allowance before any answer is written)',
                SAFETY: 'blocked by a safety filter on the generated output',
                RECITATION: 'blocked as recitation — the answer reproduced too much source text verbatim. Large verbatim tool results (search snippets, file contents) are the usual trigger',
                LANGUAGE: 'blocked: unsupported language',
                BLOCKLIST: 'blocked by a term blocklist',
                PROHIBITED_CONTENT: 'blocked as prohibited content',
                SPII: 'blocked as sensitive personal information',
                MALFORMED_FUNCTION_CALL: 'the model tried to emit a tool call that did not parse — the call is discarded and the turn ends with nothing',
                UNEXPECTED_TOOL_CALL: 'the model called a tool that was not offered',
                IMAGE_SAFETY: 'blocked by an image safety filter',
                OTHER: 'unspecified — Gemini gives no reason under this code',
              };
              const named = REASONS[fin];
              const parts: string[] = [];
              parts.push(`finishReason=${lastFinishReason || 'null (no candidate returned)'}`);
              if (lastBlockReason) parts.push(`blockReason=${lastBlockReason} (the INPUT was blocked, not the output)`);
              parts.push(`toolIterations=${toolIterations}`, `parts=${lastPartCount}`);
              if (lastThoughtOnly) parts.push('the model emitted thinking parts only, no answer');
              const diag = `${named ? named + '. ' : ''}[${parts.join(', ')}]`;

              if (totalVisibleEmitted === 0) {
                console.warn(`[gemini] empty visible response — ${diag}`);
                enqueue({ type: 'notice', content: `The turn produced no visible answer — ${diag}` });
              } else {
                // There IS real text to keep; the turn just died after the last
                // tool call. Use a notice so the saved message is not polluted.
                console.warn(`[gemini] stopped after tool call with no closing answer — ${diag}`);
                enqueue({
                  type: 'notice',
                  content: `Stopped after the last tool call without writing an answer — ${diag}`,
                });
              }
            }
            if (toolStopNotice) {
              console.warn(`[gemini] ${toolStopNotice}`);
              enqueue({ type: 'notice', content: toolStopNotice });
            }
            const usagePayload = normalizeCacheUsage(cumGeminiUsage, 'gemini');
            if (usagePayload) enqueue(usagePayload);
            if (cumGeminiSourceMap.size > 0) {
              enqueue({ type: 'web_sources', sources: [...cumGeminiSourceMap.values()] });
            }
            controller.enqueue(`data: [DONE]\n\n`);
            controller.close();
          } catch (e: any) {
            // After a Stop the client is gone (or the controller was already
            // closed by the stop key), so enqueue() throws "Invalid state".
            // Guard it: the cleanup path must never become the unhandled
            // rejection that takes the dev server's turn down with it.
            try { controller.enqueue(`data: ${JSON.stringify({ error: e.message })}\n\n`); } catch {}
            try { controller.close(); } catch {}
          }
        }
      });

      return new Response(readableStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }
    else if (isKimi || isMimo) {
      // Kimi and MiMo speak their native Anthropic Messages dialect. Route them
      // through the Anthropic-format adapter instead of the OpenAI-compatible
      // /chat/completions surface — the tool-call reliability difference is
      // measured (2/9 → 7/7, streaming and non-streaming). See
      // streamViaAnthropicCompat above. (The OpenAI branch below still carries
      // its isKimi/isMimo branches, but they are now unreachable from the main
      // chat path — kept for reference, not wired.)
      if (isKimi && !keys.kimi) {
        return NextResponse.json({ error: 'Kimi requires the Kimi (Moonshot) API key in Preferences (from platform.kimi.ai → Console → API Keys).' }, { status: 400 });
      }
      if (isMimo && !keys.mimo) {
        return NextResponse.json({ error: 'MiMo (Xiaomi) requires the MiMo API key in Preferences.' }, { status: 400 });
      }
      return streamViaAnthropicCompat({
        provider: isKimi ? 'kimi' : 'mimo',
        baseUrl: isKimi
          ? 'https://api.moonshot.ai/anthropic/v1/messages'
          : 'https://api.xiaomimimo.com/anthropic/v1/messages',
        apiKey: isKimi ? keys.kimi : keys.mimo,
        model: isKimi ? resolveKimiModel(specificModel) : (specificModel || 'mimo-v2.6-pro'),
        systemPrompt: enhancedSystemPrompt,
        processedMessages,
        modelSelectedPayload,
        handoff: handoffBundle,
        modelParams,
        folderName,
        senseEvents,
        toolUseEnabled,
        enableReadConversation,
        agentFullSystemAccess,
        agentDangerousTools,
        agentReadOnlyTools,
        instructionOverrides,
        language,
        askUserEnabled,
        askUserTimeoutMs,
        subagentEnabled,
        subagentModel,
        subagentFamily,
        lettersEnabled,
        browserEnabled,
        browserAllowedHosts,
        browserAllowAnyHost,
        computerControlEnabled,
        appControlEnabled,
        convoId,
        keys,
        injectTurnId,
        maxToolRounds: MAX_TOOL_ROUNDS,
        hiddenAttachmentsAccessible,
        conversationAttachmentRefs,
        turnAbort,
        betrayalSend,
      });
    }
    else if (isLocal || isDashScope || isGLM || isGrok || isKimi || isCohere || isMinimax || isOpenAI || isMimo || isBytedance || isMeta) {
      // ----- OpenAI-compatible: LM Studio (Local), DashScope (Qwen / DeepSeek
      //       V3.2), DeepSeek's first-party API, or Z.AI (GLM family) -----
      // All speak the same /chat/completions JSON protocol; only the full URL,
      // Bearer auth, and a couple of extra-body params differ.
      //
      // DeepSeek routing rules: the model id picks the upstream.
      //   - "deepseek-v3.2" → Alibaba DashScope (Singapore intl endpoint).
      //     This is the only DeepSeek model available on dashscope-intl.
      //   - everything else starting with "deepseek-" (v4-pro/v4-flash, legacy
      //     deepseek-chat/deepseek-reasoner) → api.deepseek.com directly.
      //     Requires a separate DeepSeek API key (keys.deepseek).
      const useDeepSeekDirect = isDeepSeek && !!specificModel && specificModel !== 'deepseek-v3.2';
      // DeepSeek's thinking mode REJECTS a request whose LAST message is an
      // assistant turn carrying no `reasoning_content`:
      //   400 "The `reasoning_content` in the thinking mode must be passed
      //        back to the API."
      //
      // That is the shape of every PREFILL CONTINUATION NEXUS builds: the SPU
      // sends its partial output back as a trailing assistant turn so the model
      // resumes mid-sentence (client-side; it arrives inside
      // `processedMessages`), and this route's own MAX_TOKENS continuation does
      // the same further down. Result: a soul update that hit the output cap
      // could never finish — it 400'd on every continuation round, which is
      // exactly the report that found this.
      //
      // Measured against api.deepseek.com 2026-10-12 — identical on BOTH
      // deepseek-v4-pro and deepseek-flash:
      //   trailing assistant + tools + thinking on,  no reasoning_content → 400
      //   trailing assistant + tools + thinking on,  reasoning_content ''  → 200
      //   trailing assistant + tools + thinking OFF, no reasoning_content  → 200
      //   trailing assistant, NO tools,              reasoning_content ''  → 200
      //   assistant in HISTORY (last message is user), no reasoning_content → 200
      //
      // Three facts come out of that table and together they pick the shape
      // of this fix:
      //   1. Only a TRAILING assistant turn is checked — ordinary multi-turn
      //      history is unaffected, which is why normal DeepSeek chat never
      //      showed this.
      //   2. An EMPTY STRING satisfies the check. The real reasoning text is
      //      better (DeepSeek's docs say echoed reasoning is concatenated into
      //      context) and the MAX_TOKENS site below has it; the SPU does not
      //      (it counts thought characters and discards the text), so '' is the
      //      floor rather than the target.
      //   3. The field is harmless when tools or thinking are absent — the docs
      //      say it "will be ignored", and the no-tools arms returned 200. So
      //      this is one unconditional field rather than a tools×thinking
      //      condition matrix that would need re-measuring every time either
      //      default moves.
      //
      // WHAT THIS IS *NOT*: the tool loop does not need it, and that was
      // measured, not assumed. A fabricated tool_call ID with no
      // reasoning_content 400s — which is what made this look like a second
      // bug — but DeepSeek's OWN tool_call ID with no reasoning_content returns
      // 200 on both models. The provider is matching the turn against its
      // record of generating it; an ID it issued is such a match, a bare text
      // prefill is not. NEXUS replays the provider's own `tc.id`, so the tool
      // loop was never broken (verified end-to-end against the UNFIXED frozen
      // copy: Glob called, tool result consumed, answer returned, no 400).
      // Echoing reasoning there would be a change with no effect.
      const dsPrefillRc = (reasoning?: string) =>
        useDeepSeekDirect ? { reasoning_content: reasoning || '' } : {};
      // DigitalOcean Inference (inference.do-ai.run) serves open-weight models
      // — currently the GLM 5.x family — on US-hosted infrastructure. Selected
      // via a `digitalocean/` prefix on the model id (e.g. `digitalocean/glm-5.2`);
      // the prefix is stripped before the wire call and used for routing, key
      // selection, and pricing (same model id can exist on two providers at
      // different prices, so the price table keys on the prefixed id).
      const useDigitalOcean = isGLM && (specificModel || '').startsWith('digitalocean/');

      if (useDeepSeekDirect && !keys.deepseek) {
        return NextResponse.json({
          error: `${specificModel} runs on DeepSeek's first-party API — add a DeepSeek API key in Preferences. (deepseek-v3.2 is the only model NEXUS can serve via your Alibaba/Qwen DashScope key, because the international DashScope endpoint doesn't host the others.)`,
        }, { status: 400 });
      }
      if (isDashScope && !useDeepSeekDirect && !keys.qwen) {
        return NextResponse.json({
          error: `${isDeepSeek ? 'DeepSeek V3.2 (via DashScope)' : 'Qwen'} requires the Alibaba (Qwen / DashScope) API key in Preferences.`,
        }, { status: 400 });
      }
      if (isGLM && !useDigitalOcean && !keys.glm) {
        return NextResponse.json({
          error: `GLM (Z.AI) requires the Z.AI API key in Preferences.`,
        }, { status: 400 });
      }
      if (useDigitalOcean && !keys.digitalocean) {
        return NextResponse.json({
          error: `GLM via DigitalOcean Inference requires the DigitalOcean Inference API key in Preferences (control panel → Inference → Model Access Keys).`,
        }, { status: 400 });
      }

      if (isGrok && !keys.grok) {
        return NextResponse.json({
          error: `Grok (xAI) requires the xAI API key in Preferences.`,
        }, { status: 400 });
      }
      if (isKimi && !keys.kimi) {
        return NextResponse.json({
          error: `Kimi requires the Kimi (Moonshot) API key in Preferences (from platform.kimi.ai → Console → API Keys).`,
        }, { status: 400 });
      }
      if (isCohere && !keys.cohere) {
        return NextResponse.json({
          error: `Cohere requires the Cohere API key in Preferences.`,
        }, { status: 400 });
      }
      if (isMinimax && !keys.minimax) {
        return NextResponse.json({
          error: `MiniMax requires the MiniMax API key in Preferences.`,
        }, { status: 400 });
      }
      if (isOpenAI && !keys.openai) {
        return NextResponse.json({
          error: `ChatGPT (OpenAI) requires the OpenAI API key in Preferences (sk-...).`,
        }, { status: 400 });
      }
      // Refuse the dead end before spending anything, and say which two knobs
      // fix it. `toolUseEnabled` is a faithful predicate for "tools reach the
      // wire": the builder below pushes Read unconditionally when it is true,
      // so true always means localTools is non-empty.
      // Same shape as the `.bat` launch refusal in ttsEngines: a combination
      // that cannot work is named up front instead of failing opaquely later.
      if (isOpenAI && toolUseEnabled && openAiCannotUseTools(specificModel || '')) {
        return NextResponse.json({
          error: `${specificModel} cannot use workspace tools: OpenAI's /v1/chat/completions `
            + `requires reasoning_effort 'none' for function tools, and this model's only `
            + `accepted values are low/medium/high/xhigh (measured 2026-10-21). `
            + `Either turn the workspace tools off for this being, or pick gpt-6-sol / `
            + `gpt-6-luna / gpt-5.6-* — those take tools on this endpoint.`,
        }, { status: 400 });
      }
      if (isMimo && !keys.mimo) {
        return NextResponse.json({
          error: `MiMo (Xiaomi) requires the MiMo API key in Preferences.`,
        }, { status: 400 });
      }
      if (isBytedance && !keys.bytedance) {
        return NextResponse.json({
          error: `ByteDance (Seed) requires the BytePlus API key in Preferences.`,
        }, { status: 400 });
      }
      if (isMeta && !keys.meta) {
        return NextResponse.json({
          error: `Meta (Muse Spark) requires the Meta Model API key in Preferences (from the Meta Developer Console).`,
        }, { status: 400 });
      }

      // Full URL of the chat-completions endpoint. We build it once instead
      // of "base + /v1/chat/completions" because each provider has a slightly
      // different path prefix — most notably Z.AI's path is /api/paas/v4
      // (no /v1) which broke when we naively appended /v1.
      const chatCompletionsUrl = useDeepSeekDirect
        ? 'https://api.deepseek.com/v1/chat/completions'
        : isDashScope
          ? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions'
          : isGLM
            ? (useDigitalOcean
              ? 'https://inference.do-ai.run/v1/chat/completions'
              : 'https://api.z.ai/api/paas/v4/chat/completions')
            : isGrok
              ? 'https://api.x.ai/v1/chat/completions'
              : isKimi
                ? 'https://api.moonshot.ai/v1/chat/completions'
                : isCohere
                  ? 'https://api.cohere.ai/compatibility/v1/chat/completions'
                  : isMinimax
                    ? 'https://api.minimax.io/v1/chat/completions'
                    : isOpenAI
                      ? 'https://api.openai.com/v1/chat/completions'
                      : isMimo
                        ? 'https://api.xiaomimimo.com/v1/chat/completions'
                        : isBytedance
                          ? 'https://ark.ap-southeast.bytepluses.com/api/v3/chat/completions'
                          : isMeta
                            ? 'https://api.meta.ai/v1/chat/completions'
                            : `${process.env.LOCAL_LLM_BASE || 'http://localhost:1234'}/v1/chat/completions`;
      const authHeaders: Record<string, string> = useDeepSeekDirect
        ? { Authorization: `Bearer ${keys.deepseek}` }
        : isDashScope
          ? { Authorization: `Bearer ${keys.qwen}` }
          : isGLM
            ? { Authorization: `Bearer ${useDigitalOcean ? keys.digitalocean : keys.glm}` }
            : isGrok
              ? { Authorization: `Bearer ${keys.grok}` }
              : isKimi
                ? { Authorization: `Bearer ${keys.kimi}` }
                : isCohere
                  ? { Authorization: `Bearer ${keys.cohere}` }
                  : isMinimax
                    ? { Authorization: `Bearer ${keys.minimax}` }
                    : isOpenAI
                      ? { Authorization: `Bearer ${keys.openai}` }
                      : isMimo
                        ? { Authorization: `Bearer ${keys.mimo}` }
                        : isBytedance
                          ? { Authorization: `Bearer ${keys.bytedance}` }
                          // Measured 2026-10-05: api.meta.ai takes the key as a
                          // Bearer token and nothing else — `x-api-key` with the
                          // same key returns 401 invalid_api_key.
                          : isMeta
                            ? { Authorization: `Bearer ${keys.meta}` }
                            : {};
      // Local models only: the LM Studio catalog's `vision` flag is the sole
      // truth for whether this engine has eyes (isVisionCapable can't match
      // the id). Set in the resolve block below; passed to injection delivery
      // so a vision-capable local model receives mid-turn images natively
      // instead of being handed a ref. Stays false for every cloud family.
      let localModelVisionCapable = false;
      let localModel = isKimi ? resolveKimiModel(specificModel) : (specificModel || (
        isGLM      ? 'glm-4.7' :
        isGrok     ? 'grok-4.7' :
        isCohere   ? 'command-a-plus-05-2026' :
        // Case-sensitive per MiniMax docs: capital M's, lowercase i, hyphen.
        isMinimax  ? 'MiniMax-M3' :
        isDeepSeek ? DEEPSEEK_FLASH :
        isQwen     ? 'qwen3.6-plus' :
        isOpenAI   ? 'gpt-5.6-terra' :
        isMimo     ? 'mimo-v2.6-pro' :
        isBytedance ? 'seed-2-0-pro-260328' :
        isMeta     ? 'muse-spark-1.3' :
                     'local-model'
      ));
      // DeepSeek's direct API (api.deepseek.com) serves only 'deepseek-flash'
      // and 'deepseek-v4-pro' plus a few still-accepted legacy aliases.
      // Retired ids saved in old conversations are normalised here — single
      // table in lib/deepseekModels.ts.
      if (useDeepSeekDirect) localModel = deepseekWireModel(localModel);
      // DigitalOcean Inference: the `digitalocean/` prefix is a NEXUS routing
      // marker (same bare model id exists on Z.AI at a different price, so the
      // prefix disambiguates for routing + pricing). The wire API wants the
      // bare id — strip it here.
      if (useDigitalOcean && localModel.startsWith('digitalocean/')) {
        localModel = localModel.slice('digitalocean/'.length);
      }

      // ── Z.AI "Preserved Thinking" (GLM agentic continuity) ────────────────
      // GLM discards its own reasoning between tool rounds UNLESS the client
      // opts in. Z.AI's Thinking-Mode docs describe two halves that MUST be
      // done together:
      //   1. send `thinking: { type: 'enabled', clear_thinking: false }`
      //      (Preserved Thinking is OFF by default on the standard API — it is
      //      only ON by default on their Coding Plan endpoint, which is why
      //      Z.AI can advertise "5 hours of independent agentic work" while a
      //      plain API client sees the model stop after ~3 tool calls);
      //   2. replay the model's own `reasoning_content` back, unmodified, on
      //      the assistant tool-call message of every subsequent round.
      // Their docs are explicit that omitting (2) "degrades performance —
      // particularly problematic for agentic and tool-calling scenarios".
      //
      // NEXUS previously did NEITHER for GLM: `clear_thinking` was never sent,
      // and the `reasoning_content` echo below was gated to Kimi only (Kimi
      // 400s without it — a loud failure we noticed; GLM degrades silently —
      // a quiet one we did not). Net effect: every GLM tool round started with
      // no memory of why it was doing any of this. Corroborated externally by
      // goose#7363 ("GLM loses reasoning state between turns").
      //
      // Z.AI-direct only. DigitalOcean's OpenAI-compatible surface exposes
      // reasoning through `reasoning_effort` and has no `thinking` object at
      // all, so Preserved Thinking is simply unavailable on that route.
      const isGLM53Wire = isGLM && !useDigitalOcean && /glm-5\.3/i.test(String(localModel || ''));
      // GLM-5.3 always reasons (it rejects `thinking: { type: 'disabled' }`),
      // so preservation applies regardless of the Thinking-Mode toggle. On
      // every other GLM the toggle genuinely turns reasoning off, and with no
      // reasoning there is nothing to preserve.
      const glmPreservedThinking =
        isGLM && !useDigitalOcean &&
        (isGLM53Wire || modelParams.qwenEnableThinking !== false);
      // ── Local (LM Studio) — auto-launch + model resolution + pre-load ─────
      // The "No models loaded" / "fetch failed" instability had two causes:
      //   1. LM Studio wasn't running (fetch failed).
      //   2. `specificModel` held a stale cloud id (e.g. "claude-sonnet-5"
      //      left over from a family switch) or the empty-sentinel
      //      "local-model". LM Studio only JIT-loads when `model` matches an
      //      installed model key exactly, so a bogus id → "No models loaded".
      // Resolve `localModel` against the real installed/loaded list and
      // pre-load it with the conversation's context window so long chats don't
      // get silently truncated to LM Studio's default.
      if (isLocal) {
        const lm = await getLocalModelsMeta();
        if (Array.isArray(lm.models) && lm.models.length > 0) {
          const requested = localModel && localModel !== 'local-model' ? localModel : '';
          const isValid = !!requested && lm.models.includes(requested);
          if (!isValid) {
            // Prefer the model already in VRAM; otherwise the first installed.
            const loadedEntry = (lm.meta || []).find((m) => m.loaded);
            localModel = (loadedEntry && loadedEntry.id) || lm.models[0];
          }
          const targetCtx = (typeof modelParams.localContextWindow === 'number' && modelParams.localContextWindow > 0)
            ? modelParams.localContextWindow : 80000;
          const current = (lm.meta || []).find((m) => m.id === localModel && m.loaded);
          if (!current || (current.loadedContext < targetCtx)) {
            await loadLocalModel(localModel, targetCtx);
          }
          // Read the catalog's vision flag for the resolved model (not gated on
          // `loaded` — the flag is known from `lms ls` whether in VRAM or not).
          const metaForModel = (lm.meta || []).find((m) => m.id === localModel);
          localModelVisionCapable = !!(metaForModel && metaForModel.vision);
        }
      }

      // `useEyes` was decided back in POST from isVisionCapable(), an id
      // registry + substring match that cannot recognise an LM Studio id and
      // therefore DEFAULT-DENIES every local engine. By this line the catalog
      // has spoken, so a local model that really has eyes stops being routed
      // through the bridge: it gets the pixels, not a lossy text description
      // of them (and no bridge call is billed for an image it could already
      // see). The contract at useEyes' own definition says the flag is for
      // models that "can't accept that modality" — this is what makes that
      // sentence true for local engines. Identical to `useEyes` for every
      // cloud family, where localModelVisionCapable stays false. Same catalog
      // truth the mid-turn media injection already ships on (`visionOverride`).
      const useEyesHere = useEyes && !localModelVisionCapable;


      // ── DashScope/DeepSeek/Z.AI inline-file size preflight ─────────────────
      // DashScope (Qwen/DeepSeek-via-Alibaba), api.deepseek.com, and api.z.ai
      // all reject any single `data:` URI larger than 20 MiB with a 400.
      // Catch it here and return a clear error naming the offending file(s)
      // instead of letting the user see the cryptic upstream message.
      if (isDashScope || useDeepSeekDirect || isGLM || isGrok || isKimi || isCohere || isMinimax || isOpenAI || isMimo || isBytedance || isMeta) {
        const DATA_URI_MAX = 20 * 1024 * 1024; // 20 MiB hard limit
        const tooBig: string[] = [];
        for (const m of processedMessages) {
          for (const media of (m.mediaFiles || [])) {
            // Rough size of the full `data:<mime>;base64,<b64>` string.
            const dataUriLen = `data:${media.mimeType};base64,${media.base64Data}`.length;
            if (dataUriLen > DATA_URI_MAX) {
              const mb = (dataUriLen / 1024 / 1024).toFixed(1);
              tooBig.push(`${media.name || '(unnamed)'} — ${mb} MB (after base64 encoding)`);
            }
          }
        }
        if (tooBig.length > 0) {
          return NextResponse.json({
            error:
              `Cannot send: DashScope/DeepSeek rejects any single inline file over 20 MiB. ` +
              `Oversize attachment(s): ${tooBig.join('; ')}. ` +
              `Resize/recompress the file (for images, use the Tools menu → Convert PNG → JPG, or scale them down) or exclude it with the eye icon, then resend.`,
          }, { status: 400 });
        }
      }
      // ── End preflight ───────────────────────────────────────────────────────

      // OpenAI-style function tools (when toolUseEnabled). Whether the model
      // actually emits tool_calls is up to the loaded model's training —
      // Qwen2.5/Llama-3.1-Instruct/Hermes-3/Gemma-4 should; base models won't.
      const localTools: any[] = [];
      if (toolUseEnabled) {
        // Same Read/Write/Edit/Glob/Grep set as the Claude and Gemini branches,
        // in OpenAI function-tool schema. The model's training determines how
        // well it picks these up — Qwen / Llama-3-Instruct / Gemma-4 generally
        // do, base models do not.
        localTools.push({
          type: 'function',
          function: {
            name: 'Read',
            description: `${I.toolReadDesc} ${pathRule}`,
            parameters: {
              type: 'object',
              properties: { path: { type: 'string', description: pathDesc } },
              required: ['path'],
            },
          },
        });
        // Read-only mode (SPU agents): Write/Edit are withheld even though
        // toolUseEnabled is on — the desk is reference-only to these agents.
        if (!agentReadOnlyTools) {
          localTools.push({
            type: 'function',
            function: {
              name: 'Write',
              description: I.toolWriteDesc,
              parameters: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: pathDesc },
                  content: { type: 'string', description: 'Full file contents to write' },
                },
                required: ['path', 'content'],
              },
            },
          });
          localTools.push({
            type: 'function',
            function: {
              name: 'Edit',
              description: I.toolEditDesc,
              parameters: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: pathDesc },
                  old_string: { type: 'string', description: 'Text to find. Must occur exactly once.' },
                  new_string: { type: 'string', description: 'Text to replace it with.' },
                },
                required: ['path', 'old_string', 'new_string'],
              },
            },
          });
        }
        localTools.push({
          type: 'function',
          function: {
            name: 'Glob',
            description: I.toolGlobDesc,
            parameters: {
              type: 'object',
              properties: { pattern: { type: 'string', description: 'Glob pattern. Use `**` to match all files.' } },
              required: ['pattern'],
            },
          },
        });
        localTools.push({
          type: 'function',
          function: {
            name: 'Grep',
            description: I.toolGrepDesc,
            parameters: {
              type: 'object',
              properties: {
                pattern: { type: 'string', description: 'JavaScript regex (no surrounding slashes).' },
                file_pattern: { type: 'string', description: 'Optional glob to restrict files.' },
                flags: { type: 'string', description: 'Optional regex flags (e.g. "i").' },
              },
              required: ['pattern'],
            },
          },
        });
        if (agentDangerousTools) {
          localTools.push({
            type: 'function',
            function: {
              name: 'Delete',
              description: I.toolDeleteDesc,
              parameters: {
                type: 'object',
                properties: { path: { type: 'string', description: 'Path of the file to delete.' } },
                required: ['path'],
              },
            },
          });
          localTools.push({
            type: 'function',
            function: {
              name: 'Bash',
              description: I.toolBashDesc,
              parameters: {
                type: 'object',
                properties: {
                  command: { type: 'string', description: 'The shell command to run.' },
                  timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds (default 60000, max 600000).' },
                },
                required: ['command'],
              },
            },
          });
        }
      }

      // ── Interactive AskUserQuestion tool (optional, independent toggle) ──────
      // Gives the model a way to pause and ask the user a multiple-choice
      // question, then continue once they answer. Independent of toolUseEnabled
      // and web tools — it's its own opt-in capability.
      if (askUserEnabled) {
        localTools.push({
          type: 'function',
          function: {
            name: 'AskQuestion',
            description: I.askUserDesc,
            parameters: {
              type: 'object',
              properties: {
                questions: {
                  type: 'array',
                  description: 'Between 1 and 4 questions to ask your partner.',
                  items: {
                    type: 'object',
                    properties: {
                      question: { type: 'string', description: 'The full question text. End with a question mark.' },
                      header: { type: 'string', description: 'Very short label/chip for the question (max ~12 chars).' },
                      multiSelect: { type: 'boolean', description: 'Set true to let your partner pick multiple options.' },
                      options: {
                        type: 'array',
                        description: '2 to 4 distinct, mutually-exclusive choices.',
                        items: {
                          type: 'object',
                          properties: {
                            label: { type: 'string', description: 'Short option label (1-5 words).' },
                            description: { type: 'string', description: 'What choosing this option means.' },
                          },
                          required: ['label'],
                        },
                      },
                    },
                    required: ['question', 'options'],
                  },
                },
              },
              required: ['questions'],
            },
          },
        });
      }

      // ── Subagent (context-firewall helper) tool (optional) ──────────────────
      if (subagentEnabled) {
        localTools.push({
          type: 'function',
          function: {
            name: 'spawn_subagent',
            description: I.subagentDesc,
            parameters: {
              type: 'object',
              properties: {
                task: { type: 'string', description: 'A precise, self-contained investigation for the helper to perform.' },
                return_contract: { type: 'string', description: 'Optional: how the distilled result should be shaped/formatted.' },
              },
              required: ['task'],
            },
          },
        });
      }
      // Optional vessel handoff.
      if (handoffToolEnabled) {
        localTools.push({
          type: 'function',
          function: {
            name: 'change_model',
            description: I.changeModelDesc,
            parameters: {
              type: 'object',
              properties: {
                target: {
                  type: 'string',
                  enum: handoffTargetIds,
                  description: `${I.changeModelTargetParam} Available: ${handoffTargetHelp}`,
                },
                handoff: { type: 'string', description: I.changeModelHandoffParam },
              },
              required: ['target', 'handoff'],
            },
          },
        });
      }

      // ── Universal NEXUS web tools ───────────────────────────────────────────
      // When "Enable Web Search" is on, give EVERY OpenAI-compatible provider a
      // real, uniform search+fetch capability backed by NEXUS's own server-side
      // implementation (src/lib/webTools.ts). This replaces the patchwork of
      // provider-native search shapes ($web_search / enable_search / tools[
      // web_search]) that were snippet-only, inconsistent, or unsupported. The
      // model calls `web_search` to find pages and `web_fetch` to actually read
      // one — and the URLs flow into the verifiable "Web sources" citation
      // panel. Independent of `toolUseEnabled` (web access ≠ file access).
      const nexusWebToolsEnabled = !!modelParams.enableWebSearch;
      if (nexusWebToolsEnabled) {
        localTools.push({
          type: 'function',
          function: {
            name: 'web_search',
            description: I.webSearchDesc,
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'The search query.' },
              },
              required: ['query'],
            },
          },
        });
        localTools.push({
          type: 'function',
          function: {
            name: 'web_fetch',
            description: I.webFetchDesc,
            parameters: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'The absolute http(s) URL to open and read.' },
              },
              required: ['url'],
            },
          },
        });
      }

      // read_conversation — pull the full text of a past conversation by name.
      // Available when the folder uses the summaries-as-Layer-4 mode: the model
      // sees short summaries in its system prompt and can drill into any one of
      // them on demand. Inactive (non-public) conversations are refused.
      if (enableReadConversation) {
        localTools.push({
          type: 'function',
          function: {
            name: 'read_conversation',
            description: I.readConversationDesc,
            parameters: {
              type: 'object',
              properties: {
                name: { type: 'string', description: I.readConversationNameParam },
              },
              required: ['name'],
            },
          },
        });
        localTools.push({
          type: 'function',
          function: {
            name: 'search_conversations',
            description: I.searchConversationsDesc,
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: I.searchConversationsQueryParam },
                regex: { type: 'boolean', description: I.searchRegexParam },
              },
              required: ['query'],
            },
          },
        });
        // Same scope as the two above (this being's own past), so same gate —
        // see the OAuth site's comment for why it is not read_attachment's.
        localTools.push({
          type: 'function',
          function: {
            name: 'search_attachments',
            description: I.searchAttachmentsDesc,
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: I.searchAttachmentsQueryParam },
                regex: { type: 'boolean', description: I.searchRegexParam },
              },
              required: ['query'],
            },
          },
        });
      }

      if (hiddenAttachmentsAccessible) {
        localTools.push({
          type: 'function',
          function: {
            name: 'read_attachment',
            description: I.readAttachmentDesc,
            parameters: {
              type: 'object',
              properties: {
                ref: { type: 'string', description: I.readAttachmentPrefixParam },
                pattern: { type: 'string', description: I.readAttachmentPatternParam },
              },
              required: ['ref'],
            },
          },
        });
      }

      // Letters — mail between Digital Identities. Same four tools and the same
      // executor as every other provider path.
      if (lettersEnabled) {
        localTools.push({
          type: 'function',
          function: {
            name: 'write_letter',
            description: I.toolWriteLetterDesc,
            parameters: {
              type: 'object',
              properties: {
                to: { type: 'array', items: { type: 'string' }, description: I.writeLetterToParam },
                title: { type: 'string', description: I.writeLetterTitleParam },
                text: { type: 'string', description: I.writeLetterTextParam },
              },
              required: ['to', 'title', 'text'],
            },
          },
        });
        localTools.push({
          type: 'function',
          function: {
            name: 'list_letters',
            description: I.toolListLettersDesc,
            parameters: { type: 'object', properties: {}, required: [] },
          },
        });
        localTools.push({
          type: 'function',
          function: {
            name: 'list_recipients',
            description: I.toolListRecipientsDesc,
            parameters: { type: 'object', properties: {}, required: [] },
          },
        });
        localTools.push({
          type: 'function',
          function: {
            name: 'read_letter',
            description: I.toolReadLetterDesc,
            parameters: {
              type: 'object',
              properties: { id: { type: 'string', description: I.readLetterIdParam } },
              required: ['id'],
            },
          },
        });
        localTools.push({
          type: 'function',
          function: {
            name: 'archive_letter',
            description: I.toolArchiveLetterDesc,
            parameters: {
              type: 'object',
              properties: { id: { type: 'string', description: I.archiveLetterIdParam } },
              required: ['id'],
            },
          },
        });
      }

      // Browser control — same six tools and the same executor as every other
      // provider path.
      if (browserEnabled) {
        localTools.push(...browserToolsOpenAI(I));
      }
      // OS-level mouse/keyboard/screen control — same three tools and the same
      // executor as every other provider path.
      if (computerControlEnabled) {
        localTools.push(...computerToolsOpenAI(I));
      }
      // App Control via UI Automation — same four tools and the same executor
      // as every other provider path.
      if (appControlEnabled) {
        localTools.push(...appToolsOpenAI(I));
      }

      // Build base OpenAI-style messages from the conversation
      const baseOaiMessages: any[] = [];
      if (enhancedSystemPrompt) baseOaiMessages.push({ role: 'system', content: enhancedSystemPrompt });

      // Derive the audio-format hint DashScope needs (e.g. "audio/mpeg" → "mp3",
      // "audio/wav" → "wav"). Falls back to 'mp3' for unknown subtypes.
      const audioFormatOf = (mime: string): string => {
        const sub = (mime.split('/')[1] || '').toLowerCase().replace(/^x-/, '');
        if (sub === 'mpeg') return 'mp3';
        if (sub === '3gpp') return '3gp';
        return sub || 'mp3';
      };

      for (const m of processedMessages) {
        const parts: any[] = [];
        for (const media of (m.mediaFiles || [])) {
          const dataUrl = `data:${media.mimeType};base64,${media.base64Data}`;
          if (media.mimeType.startsWith('image/')) {
            if (media.name) parts.push({ type: 'text', text: `<attached_file name="${media.name}" type="${media.mimeType}" />` });
            parts.push({ type: 'image_url', image_url: { url: dataUrl } });
          } else if (media.mimeType.startsWith('audio/')) {
            // LOCAL (LM Studio): there is no audio path at all. Its request
            // validator accepts exactly two content types and rejects the
            // whole call otherwise — measured 2026-09-19 on both
            // /v1/chat/completions and /api/v0/chat/completions, for
            // `input_audio` (raw base64 and data-URL), `audio_url` and bare
            // `audio`:
            //   400 "Invalid 'content': 'content' objects must have a 'type'
            //        field that is either 'text' or 'image_url'."
            // There is no /v1/audio/transcriptions either. So sending it does
            // not "get ignored, no harm" (what this comment used to claim) —
            // it fails the entire turn. Say so in the transcript instead, and
            // let the ears bridge carry audio to local models.
            if (isLocal) {
              parts.push({
                type: 'text',
                text: `<attached_file name="${media.name || 'audio'}" type="${media.mimeType}" delivered="false" reason="this local endpoint accepts text and images only — enable the ears bridge to receive a transcript" />`,
              });
              continue;
            }
            // DashScope/Qwen-Omni OpenAI-compatible audio input. The Python SDK
            // calls this `extra_body` content, but at the wire level it's just
            // a regular content-part with type "input_audio".
            if (media.name) parts.push({ type: 'text', text: `<attached_file name="${media.name}" type="${media.mimeType}" />` });
            parts.push({
              type: 'input_audio',
              // OpenAI's `input_audio.data` spec wants RAW base64. Qwen/MiMo
              // tolerate a full `data:` URL here, but ByteDance/Ark strictly
              // schema-validates it as pure base64 and nulls the whole message
              // otherwise ("messages[i] … expected an object, but got null").
              // So send raw base64 for ByteDance, the prefixed URL for the rest.
              input_audio: { data: isBytedance ? media.base64Data : dataUrl, format: audioFormatOf(media.mimeType) },
            });
          } else if (media.mimeType.startsWith('video/')) {
            // LOCAL (LM Studio): `video_url` is rejected by the same validator
            // as audio above. But a frame is an image, and images ARE carried
            // — which is also how the model consumes video in the first place
            // (Google's Gemma 4 card: "All models support image inputs and can
            // process videos as frames", 1 fps). So decode the clip here and
            // send the frames. Measured: a 35 s clip → 35 frames → 3,027
            // prompt tokens, 5 s of prefill, and the model reported what
            // changed from frame to frame.
            if (isLocal) {
              try {
                const shot = await extractVideoFrames(Buffer.from(media.base64Data, 'base64'), media.name);
                parts.push({
                  type: 'text',
                  text: `<attached_file name="${media.name || 'video'}" type="${media.mimeType}" delivered="as_frames" frames="${shot.frames.length}" fps="${shot.plan.fps.toFixed(3)}"${shot.durationSec ? ` duration_sec="${shot.durationSec.toFixed(1)}"` : ''} note="this video is presented as still frames in playback order; there is no audio track" />`,
                });
                for (const f of shot.frames) {
                  parts.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${f.toString('base64')}` } });
                }
              } catch (e: any) {
                // Never pretend the video arrived. A failed decode is stated.
                console.error('[video-frames] extraction failed:', e?.message || e);
                parts.push({
                  type: 'text',
                  text: `<attached_file name="${media.name || 'video'}" type="${media.mimeType}" delivered="false" reason="frame extraction failed: ${String(e?.message || e).replace(/"/g, "'").slice(0, 200)}" />`,
                });
              }
              continue;
            }
            // DashScope/Qwen video input — same shape as image_url but with a
            // dedicated "video_url" content type. Inline base64 data URLs are
            // accepted per Alibaba's docs.
            if (media.name) parts.push({ type: 'text', text: `<attached_file name="${media.name}" type="${media.mimeType}" />` });
            parts.push({ type: 'video_url', video_url: { url: dataUrl } });
          }
          // Other mime types (PDF, etc.) are not part of the OpenAI multimodal
          // spec — they're already injected as <attached_file> text earlier
          // for the text-only path.
        }
        if (m.content) parts.push({ type: 'text', text: m.content });
        if (parts.length === 0) parts.push({ type: 'text', text: '-' });

        const allText = parts.every((p: any) => p.type === 'text');
        const content = allText ? parts.map((p: any) => p.text).join('\n') : parts;

        // Replay this turn's own tool calls, if the conversation asked for it.
        // The client already applied the window (lib/toolHistory
        // selectToolHistoryIds), so anything that arrives here is in budget;
        // what THIS side owns is the wire shape and the tool-name check — the
        // tools array is only known here. A call naming a tool that is not in
        // this turn's `tools` would reference a nonexistent function, so
        // buildOpenAiToolReplay drops it and returns null when nothing is left,
        // and we fall through to exactly the plain message sent before this
        // feature existed. No other dialect gets this: Anthropic 400s on an
        // unpaired tool_use and shows no damage anyway, Gemini calls the tool
        // regardless. Measured per dialect — see lib/toolHistory.ts.
        const replay = toolHistoryEnabled && m.role !== 'user'
          ? buildOpenAiToolReplay(m, content, new Set(localTools.map((t: any) => String(t?.function?.name || ''))))
          : null;
        if (replay) {
          baseOaiMessages.push(replay.assistant);
          baseOaiMessages.push(...replay.toolMessages);
        } else {
          baseOaiMessages.push({ role: m.role === 'user' ? 'user' : 'assistant', content });
        }
      }
      // A caller-built prefill continuation: any request whose LAST message is
      // an assistant turn, so the model resumes mid-sentence. (The SPU used to
      // be the one caller that did this; since 2026-10-12 it sends a three-turn
      // conversation instead — see buildContinuationUserMsg. This stays because
      // the shape is still reachable from any client and the guard is cheap.)
      // DeepSeek-direct 400s on that turn unless it echoes reasoning_content —
      // see `dsPrefillRc` above for the measurement table. Applied to the
      // ASSEMBLED tail rather than inside the loop so the tool-replay branch
      // above is untouched: when replay fires, the last message is a `tool`
      // message, not an assistant turn, and there is nothing to satisfy.
      {
        const tail = baseOaiMessages[baseOaiMessages.length - 1];
        if (tail && tail.role === 'assistant' && tail.reasoning_content === undefined) {
          Object.assign(tail, dsPrefillRc());
        }
      }

      // NOTE: No "prevent thinking" switch for local models. There is no
      // portable, reliable way to force a local GGUF to skip its reasoning
      // phase via the OpenAI-compatible API:
      //   • chat_template_kwargs.enable_thinking → makes some models fail to
      //     load (Jinja template can't render the extra kwarg → 400).
      //   • `/no_think` text soft switch → only works when the GGUF's embedded
      //     chat template implements the parsing for it; many conversions and
      //     fine-tunes ship a template without it, so it's ignored.
      //   • Prefilled closed <think></think> → LM Studio's chat-completions
      //     does not continue a trailing assistant message, so it doesn't carry.
      // Thinking on local models is therefore left to the model/template itself
      // (choose a non-thinking model/quant to avoid it).


      const effectiveLocalTemp = modelParams.temperature ?? 0.7;
      const effectiveLocalTopP = modelParams.topP ?? 0.95;

      // One streaming call. Returns visibleText (only the text portion, not thoughts)
      // and finishReason from the provider. Tokens are emitted to controller as they arrive.
      const runLocalOnce = async (
        msgs: any[],
        controller: ReadableStreamDefaultController,
        state: ThinkTagState,
        opts?: { noTools?: boolean }
      ): Promise<{
        visibleText: string;
        reasoningText: string;
        finishReason: string | null;
        toolCalls: { id: string; name: string; arguments: string }[];
        usage: any;
        webSources: { url: string; title?: string }[];
      }> => {
        const requestBody: any = {
          model: localModel,
          messages: msgs,
          stream: true,
          // Ask the upstream to include the final usage block in the stream's
          // last data event. Without this, prompt-cache stats never make it
          // back to us — most OpenAI-compatible providers honor this flag.
          stream_options: { include_usage: true },
          temperature: effectiveLocalTemp,
          top_p: effectiveLocalTopP,
          ...(seedEnabled ? { seed: seedValue } : {}),
        };
        // `top_k` is a non-standard extension, and Meta's API rejects unknown
        // parameters outright instead of ignoring them: measured 2026-10-05,
        // `top_k: 40` returns 400 "unknown parameter `top_k`". Every turn would
        // fail for anyone who has Top-K set in the model panel, so the field is
        // simply never put on Meta's wire. (temperature, top_p, seed,
        // presence_penalty, frequency_penalty and stream_options.include_usage
        // were all measured accepted, including temperature at the UI slider's
        // maximum of 2.0, so nothing else needs stripping here.)
        //   Cohere's OpenAI-compatibility endpoint rejects the same field with a
        // different status. Measured 2026-10-06 against
        // api.cohere.ai/compatibility/v1: `top_k: 40` returns 422
        // "unprocessable entity: top_k is not supported" on ALL THREE Command A
        // models (a-plus-05-2026, a-reasoning-08-2025, a-vision-07-2025), both
        // with and without an image part; dropping the field returns 200 on all
        // three. So this is NOT a vision-only fault — any Cohere turn dies the
        // moment Top-K holds a number in the model panel. (Why only Vision
        // looked broken in use is not measured here. The likeliest explanation
        // is that the other two were driven from folders with the Top-K field
        // left empty, since the field only reaches the wire when it is a
        // number — but that was not verified.)
        if (typeof modelParams.topK === 'number' && !isMeta && !isCohere) requestBody.top_k = modelParams.topK;
        // OpenAI GPT-5 reasoning models reject any non-default `temperature` /
        // `top_p` / `top_k` (only the model default is allowed) and 400 if they
        // are present. Strip the sampling knobs entirely — the model-panel
        // temperature / top-p therefore do not apply to ChatGPT (documented).
        if (isOpenAI) {
          delete requestBody.temperature;
          delete requestBody.top_p;
          delete requestBody.top_k;
        }
        // `max_tokens: -1` ("use the whole context window") is an LM Studio /
        // llama.cpp specific sentinel. DashScope returns 400, Z.AI returns
        // error 1210 "Invalid API parameter", DeepSeek's direct API rejects
        // it too. Only send it for Local.
        //
        // The "this specific chat" bug it caused: conversations that were
        // originally Local picked up `modelParams.localContextWindow` from
        // the UI's default (80000). When the user later switched the chat's
        // family to GLM/Qwen/DeepSeek, that field stayed in the saved log,
        // and previously `!isDashScope` let the -1 sentinel through to GLM.
        if (isLocal && typeof modelParams.localContextWindow === 'number') {
          requestBody.max_tokens = -1;
        }
        // DeepSeek's first-party API: send an EXPLICIT output budget instead of
        // inheriting a default nobody had read.
        //
        // Measured 2026-10-21 against api.deepseek.com, and DeepSeek's own API
        // reference agrees on every number:
        //   • default `max_tokens` in THINKING mode is 64K (8K non-thinking;
        //     128K only with `reasoning_effort: max`, which NEXUS does not send
        //     here). Maximum accepted is 384K — 393216 / 200000 / 131072 /
        //     65536 / 32768 / 8192 all returned 200.
        //   • that budget is SHARED with the chain of thought. With
        //     `max_tokens: 16` the usage block came back completion_tokens 16,
        //     reasoning_tokens 16, content 0 chars, finish_reason 'length' —
        //     the reasoning ate the entire allowance and the visible answer was
        //     empty. It is not an answer-only limit.
        //
        // How close that default actually is, measured on real work: a β (Soul
        // Packer) run writing Cairn's identity through this route finished
        // normally at completion_tokens **62,632** — 95.6% of the 64k default,
        // with reasoning and answer sharing it. So the cap was never reached;
        // it was 4.4% away, and the next slightly chattier round would have hit
        // it with the old silence.
        //
        // Honest about what this change is NOT: it did not fix the truncation
        // of 2026-10-22. I chased this ceiling first because the arithmetic of
        // the failure fit it, and it was the wrong hypothesis — the real cause
        // was the <think> splitter below reading a literal tag in the document
        // as a real one. This block is a latent-risk fix, not that fix.
        //
        // 131072 and not 393216 on purpose: a ceiling is also a stop. At this
        // model's observed rate 384k tokens is roughly an hour of generation
        // with no way to tell a long answer from a runaway one, and 131072 is
        // already ~2x the largest soul in this house. Same number the
        // Anthropic-compat path settled on (COMPAT_MAX_TOKENS), for symmetry.
        //
        // NOT extended to the other providers on this path (GLM, Qwen,
        // MiniMax, Grok, Cohere, Meta, OpenAI): each has its own undocumented
        // default and its own opinion about unknown fields, and this is one
        // measured provider, not a guess applied to nine. GLM-5.3 is the next
        // one worth measuring — it is the other Soul Packer vessel, and its
        // "it just stops" report was attributed to prefill reasoning blow-up
        // without ever checking its output ceiling. See pending-tasks.md.
        if (useDeepSeekDirect) {
          requestBody.max_tokens = 131072;
        }
        // COPY the shared tool list — the web-search blocks below do
        // `requestBody.tools.push(...)`, and runLocalOnce runs once per
        // tool-loop iteration. Assigning by reference made each iteration push
        // another search entry onto the SAME `localTools` array, so by the 2nd
        // iteration Kimi 400'd with "function name $web_search is duplicated".
        if (localTools.length && !opts?.noTools) requestBody.tools = [...localTools];
        // DashScope thinking toggle via `enable_thinking` (extra top-level field).
        //   - Qwen 3.x: hybrid, on/off toggle
        //   - DeepSeek V3.2: also hybrid, same flag, same semantics (served via
        //     DashScope, NOT api.deepseek.com — see useDeepSeekDirect below)
        // Local LM Studio models ignore it (no harm).
        //
        // EXCEPTION — Qwen Omni (qwen3.5-omni-flash / -plus): DashScope rejects
        // `enable_thinking` for these with a misleading "thinking_budget must be
        // a positive integer and not greater than 0" 400. Omni models have
        // built-in reasoning that's not user-toggleable, so simply skip the flag.
        //
        // DeepSeek's DIRECT API (api.deepseek.com, useDeepSeekDirect) does not
        // recognize `enable_thinking` at all — it's a DashScope-only field and
        // is silently dropped there, leaving the model at its default
        // `thinking: enabled`. That means the Thinking-Mode toggle has had NO
        // effect on direct DeepSeek turns; every turn ran with thinking on
        // regardless of the UI setting. Fixed below by giving useDeepSeekDirect
        // the same object-shaped `thinking` field as GLM/Kimi, which is the
        // format DeepSeek's own API docs actually document.
        const isOmniModel = (specificModel || '').toLowerCase().includes('omni');
        if ((isQwen || (isDeepSeek && !useDeepSeekDirect)) && !isOmniModel) {
          requestBody.enable_thinking = modelParams.qwenEnableThinking !== false;
        }
        // NOTE: Local LM Studio / llama.cpp models intentionally get NO thinking
        // flag. We tried forwarding `enable_thinking` + `chat_template_kwargs`,
        // but (a) it didn't reliably toggle thinking across local models, and
        // (b) passing `chat_template_kwargs` made some models fail to render
        // their Jinja chat template, which LM Studio reports as a hard "Failed
        // to load model" 400. Local thinking is therefore left to whatever the
        // model's own template decides (turn it off by choosing a non-thinking
        // model / quantization, or via a `/no_think`-style hint in the prompt).
        // Z.AI / GLM uses a different shape: `thinking: { type: 'enabled' | 'disabled' }`
        // (object, not boolean). Reuses the same UI toggle since semantics match.
        // Kimi K2.x uses the exact same shape, so it shares this branch.
        //
        // Kimi K3 is the EXCEPTION and must NOT use the K2.x `thinking` param:
        // its reasoning is ALWAYS on and is configured via the top-level
        // `reasoning_effort` field (only 'max' is supported today). It also fixes
        // temperature (1.0) and top_p (0.95) server-side — sending either 400s —
        // so we strip both. Net: the Thinking-Mode toggle has no effect on K3.
        const isKimiK3 = isKimi && /kimi-k3/i.test(String(requestBody.model || ''));
        // GLM-5.3 is the GLM-side equivalent of the K3 exception: Z.AI's docs
        // state it "always operates with reasoning enabled" and reject
        // `thinking: { type: 'disabled' }` outright. Depth is instead selected
        // with the top-level `reasoning_effort` field ('low' | 'high' | 'max',
        // default 'max'). Both fields are sent together — that is exactly the
        // shape of Z.AI's own documented curl example. The shared Thinking-Mode
        // toggle therefore maps onto depth rather than on/off: ON → 'max'
        // (the documented default), OFF → 'low' (the shallowest reasoning the
        // model will accept). Turning the toggle off cannot silence reasoning
        // entirely on this model.
        const isGLM53 = isGLM && !useDigitalOcean && /glm-5\.3/i.test(String(requestBody.model || ''));
        if (isGLM53) {
          requestBody.thinking = {
            type: 'enabled',
            // See the Preserved Thinking comment above `glmPreservedThinking`.
            ...(glmPreservedThinking ? { clear_thinking: false } : {}),
          };
          requestBody.reasoning_effort = modelParams.qwenEnableThinking !== false ? 'max' : 'low';
        } else if (isKimiK3) {
          requestBody.reasoning_effort = 'max';
          delete requestBody.temperature;
          delete requestBody.top_p;
        } else if (isKimi && /kimi-k2\.7-code/i.test(String(requestBody.model || ''))) {
          // kimi-k2.7-code / -highspeed are thinking-ONLY: measured 2026-09-19,
          // `thinking: { type: 'disabled' }` returns 400 "only type=enabled is
          // allowed for this model". Same exception shape as glm-5.3 above.
          // (This whole OpenAI branch is unreachable for Kimi from the main
          // chat path — Kimi returns via streamViaAnthropicCompat earlier — but
          // the guard is kept so the branch is not a trap if it is ever rewired.)
          requestBody.thinking = { type: 'enabled' };
        } else if (isGrok) {
          // Grok (xAI) splits into two kinds of model and NEXUS used to send no
          // reasoning parameter to either:
          //
          //   - grok-4.20-* / grok-4-1-fast-* / grok-code-fast-1 pick reasoning
          //     by model-name SUFFIX. They take no reasoning_effort — leave them
          //     alone (this is what the old "suffix selects reasoning" comment
          //     described, and it is still true for exactly these ids).
          //   - grok-4.3 / 4.5 / 4.6 / 4.7 ALWAYS reason and take a top-level
          //     `reasoning_effort` instead. Same exception shape as glm-5.3 and
          //     kimi-k3 above: the toggle maps onto depth, not on/off.
          //
          // Vocabulary differs by generation (measured 2026-09-23 against
          // api.x.ai): 4.3 accepts none|low|medium|high|xhigh (default low);
          // 4.5/4.6/4.7 accept low|medium|high|xhigh (default high) and return
          // 400 "This model does not support reasoning_effort value `none`".
          // So OFF sends 'none' only on 4.3 and 'low' — the shallowest legal
          // value — everywhere else. 'xhigh' is deliberately never sent: on
          // grok-4.7 it measured FEWER reasoning tokens than 'high' (607 vs
          // 1293) and produced a flat refusal of a benign instruction.
          //
          // Effort is a CEILING, not a floor: an easy prompt spends few
          // reasoning tokens even at 'high', so this is not a latency tax on
          // short turns.
          const grokId = String(requestBody.model || '').toLowerCase();
          if (/^grok-4\.(3|5|6|7)$/.test(grokId)) {
            requestBody.reasoning_effort =
              modelParams.qwenEnableThinking !== false ? 'high'
                : (grokId === 'grok-4.3' ? 'none' : 'low');
          }
        } else if (useDigitalOcean) {
          // DigitalOcean Inference serves GLM through an OpenAI-compatible
          // surface and exposes reasoning via the standard OpenAI
          // `reasoning_effort` field (none|low|medium|high|max) — NOT GLM's
          // native `thinking: { type }` object, which Z.AI's own endpoint uses.
          // Map the shared Thinking-Mode toggle onto the two ends.
          requestBody.reasoning_effort = modelParams.qwenEnableThinking !== false ? 'high' : 'none';
        } else if (isGLM || isKimi || useDeepSeekDirect) {
          // DeepSeek's direct API uses this exact same `{ type: 'enabled' |
          // 'disabled' }` shape (confirmed against api-docs.deepseek.com) —
          // NOT the DashScope `enable_thinking` boolean handled above.
          requestBody.thinking = {
            type: modelParams.qwenEnableThinking !== false ? 'enabled' : 'disabled',
            // Z.AI-direct GLM only — see the Preserved Thinking comment above
            // `glmPreservedThinking`. Kimi and DeepSeek share this field's
            // `{ type }` shape but have no `clear_thinking` of their own, so
            // the spread keeps it off their wire entirely.
            ...(glmPreservedThinking ? { clear_thinking: false } : {}),
          };
        }
        // DigitalOcean Inference defaults max output to ~2048 tokens when no
        // cap is sent, and treats `max_tokens` as deprecated in favor of
        // `max_completion_tokens`. Without an explicit cap, long replies get
        // silently truncated. Set a generous per-model cap (each model's own
        // documented max output) so nothing is cut short.
        if (useDigitalOcean) {
          // Documented max output per model (DigitalOcean "Supported Models"
          // page, verified 2026-08-06): glm-5.2 → 52,429; glm-5.1 → 32,768;
          // glm-5 → 12,800.
          requestBody.max_completion_tokens =
            localModel === 'glm-5.2' ? 52429 :
            localModel === 'glm-5.1' ? 32768 :
            localModel === 'glm-5'   ? 12800 :
                                       32768;
        }
        // Kimi (Moonshot) pins temperature to a single fixed value per mode and
        // rejects anything else with a 400 ("invalid temperature: only X is
        // allowed for this model"):
        //   • Thinking ON  → temperature must be 1   (also Moonshot's
        //                     recommended value for chain-of-thought quality)
        //   • Thinking OFF → temperature must be 0.6
        // Override the user's temperature, which would otherwise trip the 400.
        if (isKimi && !isKimiK3) {
          requestBody.temperature = modelParams.qwenEnableThinking !== false ? 1 : 0.6;
        }
        // MiMo (Xiaomi) only accepts temperature within [0, 1.5] and 400s
        // otherwise ("temperature must be within [0, 1.5]"). The model panel's
        // slider goes to 2.0, so clamp into range rather than fail. top_p stays untouched (MiMo accepts the standard 0–1).
        if (isMimo && typeof requestBody.temperature === 'number') {
          requestBody.temperature = Math.min(1.5, Math.max(0, requestBody.temperature));
        }
        // Cohere's OpenAI-compat endpoint uses the OpenAI-standard
        // `reasoning_effort` field. Per Cohere's docs, only "none" and "high"
        // are accepted (no medium/low gradations). Map the same boolean UI
        // toggle to the two valid values.
        //
        // EXCEPTION — Command A Vision has no reasoning support at all. Cohere's
        // compat backend maps `reasoning_effort` onto an internal `thinking`
        // param, and the vision model 400s with "`thinking` parameter is not
        // supported with the specified model" the moment anything enables it.
        // Measured 2026-10-06 against api.cohere.ai/compatibility:
        //   command-a-vision + reasoning_effort:'high'     → 400 (above message)
        //   command-a-vision + reasoning_effort:'none'     → 200
        //   command-a-vision + reasoning_effort omitted    → 200
        // So for the vision model the Thinking-Mode toggle is forced OFF
        // ('none') regardless of the UI — a-plus and a-reasoning accept 'high'
        // normally, so the force is model-scoped, not family-wide.
        if (isCohere) {
          const isCohereVision = /vision/i.test(String(requestBody.model || ''));
          requestBody.reasoning_effort =
            (!isCohereVision && modelParams.qwenEnableThinking !== false) ? 'high' : 'none';
        }
        // Meta (Muse Spark). Two fields, both measured 2026-10-05 against
        // api.meta.ai — see the long isMeta note where the family is detected.
        if (isMeta) {
          // Depth, not on/off. The accepted vocabulary came from the API's own
          // 400 ("Supported values: [minimal, low, medium, high, xhigh, max]"),
          // and 'none' is NOT in it — this model cannot be silenced. So the
          // shared toggle maps onto the two ends, same as glm-5.3 / Grok:
          // ON → 'high', OFF → 'minimal' (the shallowest value it will accept).
          //
          // OFF genuinely matters here, and not only for latency. Reasoning
          // tokens bill at the OUTPUT rate ($4.25/1M): a 700-word essay with no
          // effort set spent 7,641 reasoning tokens against 1,045 of answer and
          // took 82 s, while 'minimal' answers a short prompt in ~1.5 s for ~23.
          // 'xhigh' and 'max' are never sent — the same reasoning that keeps
          // Grok off 'xhigh' applies, and nothing here measured them as better.
          requestBody.reasoning_effort = modelParams.qwenEnableThinking !== false ? 'high' : 'minimal';
          // Prompt caching on this surface is OPT-IN per request and silent when
          // absent: with no `prompt_cache_key` an identical 5.8k-token prefix
          // reported cached_tokens [0, 0, 0] across three calls; with one it
          // reported [0, 5105, 5105]. Cached input is $0.15 against $1.25, so on
          // a long conversation this field is most of the input bill.
          //
          // The value only has to be STABLE for a stable prefix — it is a
          // routing hint, and a wrong guess costs a miss, never an error. The
          // conversation id is exactly that: NEXUS rebuilds the same system
          // prompt + history prefix for the same conversation every turn. It is
          // an opaque local uuid, so this leaks no content and no identity.
          // Falls back to the being folder when a conversation has no id yet
          // (first turn of an unsaved chat); if even that is missing the field
          // is omitted rather than sent as a constant that every conversation in
          // the install would collide on.
          const cacheKeySeed = String(convoId || folderName || '').trim();
          if (cacheKeySeed) requestBody.prompt_cache_key = `nexus:${cacheKeySeed}`;
        }
        // OpenAI GPT-5 family uses the standard `reasoning_effort` field. Map the
        // shared Thinking-Mode toggle to high (on) / minimal (off).
        //
        // CRITICAL — function tools + reasoning on /v1/chat/completions:
        // These models 400 when function tools are attached while reasoning is
        // active ("Function tools with reasoning_effort are not supported … use
        // /v1/responses or set reasoning_effort to 'none'"). The catch: gpt-5.6
        // reasoning models default to reasoning ON, so simply OMITTING the field
        // is NOT enough — the model still reasons and the request 400s. gpt-5.6
        // fixes this by accepting reasoning_effort:'none', which must be sent
        // EXPLICITLY to turn reasoning off for the tool turn. Older gpt-5.4/5.5
        // don't accept 'none', so for them we omit the field (their default
        // behavior with tools worked). Net effect on 5.6+tools: tools work, but
        // the model does NOT reason on that turn — reasoning+tools together needs
        // the /v1/responses API (not used here).
        // See lib/openaiEffort.ts for the full measured matrix.
        if (isOpenAI) {
          const oaModel = String(requestBody.model || '');
          if (requestBody.tools) {
            // gpt-5.6-* and gpt-6-* both NEED 'none' with tools — omitting the
            // field 400s on all of them (measured). gpt-5.5 / gpt-5.4 /
            // gpt-5.4-mini are the opposite: omitted works, so they are left
            // alone rather than "unified" into something unmeasured.
            if (openAiToolsNeedNoneEffort(oaModel)) {
              // The ids that refuse 'none' never get here: the preflight above
              // already returned, because 'none' is the only value that enables
              // tools and they do not accept it.
              requestBody.reasoning_effort = 'none';
            }
            // older gpt-5.x with tools: leave reasoning_effort unset (omitted).
          } else {
            // 'minimal' used to be sent here for OFF. It is in NO ChatGPT
            // model's vocabulary and 400'd every such turn.
            requestBody.reasoning_effort = modelParams.qwenEnableThinking !== false
              ? 'high'
              : openAiOffEffort(oaModel);
          }
        }

        // ── Web search ──────────────────────────────────────────────────────
        // SUPERSEDED by the universal NEXUS web tools (web_search + web_fetch,
        // added to `localTools` above and dispatched in the tool loop below).
        // Every OpenAI-compatible provider now gets the SAME real search+fetch
        // with verifiable citations, instead of the old patchwork of native
        // shapes that were snippet-only (GLM/Kimi/MiniMax), DashScope-only
        // (Qwen/DeepSeek `enable_search`), unsupported (Cohere/Local/DeepSeek-
        // direct), or broken on chat-completions (Grok). The native shapes are
        // intentionally NOT sent anymore — `nexusWebToolsEnabled` drives it all.
        //
        // (If a future provider ships clearly-superior first-party grounding we
        // can branch it back in here, gated to that provider only.)

        // xAI's docs recommend setting `x-grok-conv-id` to maximize cache
        // hit rate by hinting that this request belongs to the same
        // conversation as previous ones. No-op for other providers.
        const extraHeaders: Record<string, string> =
          isGrok && convoId ? { 'x-grok-conv-id': String(convoId) } : {};

        const lsRes = await fetch(chatCompletionsUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders, ...extraHeaders },
          body: JSON.stringify(requestBody),
          // Closing the socket is what actually stops LM Studio / llama.cpp:
          // it cancels the slot instead of letting it generate to completion
          // while nobody is listening. Same for every cloud provider on this
          // OpenAI-compatible path — Stop used to keep burning their tokens.
          signal: turnAbort.signal,
        });
        if (!lsRes.ok || !lsRes.body) {
          const errText = await lsRes.text().catch(() => '');
          const label = useDeepSeekDirect
            ? 'DeepSeek API'
            : isGLM
              ? (useDigitalOcean ? 'DigitalOcean Inference (GLM)' : 'Z.AI GLM')
              : isGrok
                ? 'xAI Grok'
                : isKimi
                  ? 'Kimi (Moonshot)'
                  : isCohere
                    ? 'Cohere'
                    : isMinimax
                      ? 'MiniMax'
                      : isOpenAI
                        ? 'OpenAI'
                        : isMimo
                          ? 'MiMo (Xiaomi)'
                          : isBytedance
                            ? 'ByteDance (BytePlus)'
                            : isDashScope
                            ? (isDeepSeek ? 'DeepSeek via DashScope' : 'Qwen DashScope')
                            : 'LM Studio';
          throw new Error(`${label}: ${lsRes.status} ${errText}`);
        }

        let visibleText = '';
        // Raw reasoning_content accumulated across the stream. Kimi (Moonshot)
        // REQUIRES this to be echoed back on the assistant tool-call message
        // when thinking is enabled — otherwise the next tool-loop iteration
        // 400s with "reasoning_content is missing in assistant tool call
        // message". Harmless to capture for other providers (only used below
        // when isKimi).
        let reasoningText = '';
        let finishReason: string | null = null;
        // Web-search citations the provider attached to this response. Different
        // OpenAI-compatible providers expose them in different (non-standard)
        // places — we probe every known shape and dedupe by URL. An EMPTY array
        // after a "web search" turn is itself meaningful: it means the provider
        // returned no verifiable sources, so any "facts" the model stated are
        // unproven (likely hallucinated). This is the user-facing proof signal.
        const webSourceMap = new Map<string, { url: string; title?: string }>();
        const addSource = (url: any, title?: any) => {
          if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
          const existing = webSourceMap.get(url);
          const t = typeof title === 'string' && title.trim() ? title.trim() : undefined;
          if (!existing) webSourceMap.set(url, { url, ...(t ? { title: t } : {}) });
          else if (t && !existing.title) existing.title = t;
        };
        // Harvest citation objects from any of the documented provider shapes.
        const harvestSources = (obj: any) => {
          if (!obj || typeof obj !== 'object') return;
          // OpenAI-standard / Grok / Perplexity: annotations[].url_citation
          const anns = obj.annotations;
          if (Array.isArray(anns)) {
            for (const a of anns) {
              if (a?.type === 'url_citation' && a.url_citation) addSource(a.url_citation.url, a.url_citation.title);
              else if (a?.url) addSource(a.url, a.title);
            }
          }
          // Grok / Perplexity top-level: citations[] (array of URL strings or objects)
          if (Array.isArray(obj.citations)) {
            for (const c of obj.citations) {
              if (typeof c === 'string') addSource(c);
              else if (c?.url) addSource(c.url, c.title);
            }
          }
          // Qwen DashScope: search_info.search_results[] = { url, title, site_name }
          const si = obj.search_info || obj.search_results;
          const results = Array.isArray(si) ? si : (Array.isArray(si?.search_results) ? si.search_results : null);
          if (results) {
            for (const r of results) addSource(r?.url || r?.link, r?.title || r?.site_name);
          }
          // GLM (Z.AI): web_search[] = { link/url, title }
          if (Array.isArray(obj.web_search)) {
            for (const r of obj.web_search) addSource(r?.link || r?.url, r?.title);
          }
        };
        // Latest seen usage block. With stream_options.include_usage, the
        // upstream sends one final chunk where `choices` is empty (or missing)
        // and `usage` is populated.
        let usage: any = null;
        // Streaming tool calls arrive as partial deltas indexed by tool_calls[].index.
        // Accumulate id / name / arguments-json-string into a slot per index.
        const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();

        // Both go through betrayalSend rather than controller.enqueue: they are
        // defined upstream of the stream's `enqueue` helper, so writing raw
        // here would put the local/OpenAI-compatible path outside the guard.
        const emitText = (t: string) => {
          if (!t) return;
          visibleText += t;
          betrayalSend(controller, { type: 'text', content: t });
        };
        const emitThought = (t: string) => {
          if (!t) return;
          betrayalSend(controller, { type: 'thought', content: t });
        };

        // Stream-safe <think>...</think> splitter. The loop now lives in
        // lib/thinkTagSplitter.ts so it can be exercised against the real
        // module instead of a retyped copy: the inline version it replaces
        // treated those seven characters as a tag ANYWHERE in the stream, for
        // every provider, which silently routed the tail of any document that
        // wrote them as PROSE into the thinking channel. That is what cut a
        // soul file at 83% of Layer 3 on 2026-10-22 with no error anywhere.
        const processContent = (incoming: string) =>
          splitThinkTags(state, incoming, emitText, emitThought);

        const reader = lsRes.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        while (true) {
          // Stop pressed mid-stream: drop the rest instead of draining it.
          if (turnAbort.signal.aborted) { try { await reader.cancel(); } catch {} break; }
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const events = buf.split('\n\n');
          buf = events.pop() || '';
          for (const ev of events) {
            const dl = ev.split('\n').find(l => l.startsWith('data: '));
            if (!dl) continue;
            const ds = dl.slice(6).trim();
            if (ds === '[DONE]') continue;
            let payload: any;
            try { payload = JSON.parse(ds); } catch { continue; }

            // The trailing "usage" chunk (sent because of
            // stream_options.include_usage) has an empty/absent `choices`
            // array and a populated `usage` block. Capture it for the final
            // cache_usage emission. Some providers also send `usage` on the
            // last `choices` chunk — overwrite either way.
            if (payload?.usage) usage = payload.usage;

            // Citations can appear at the top level of a chunk, on the choice,
            // on the delta, or on the (non-streaming) message object — probe all.
            harvestSources(payload);
            const choice = payload?.choices?.[0];
            harvestSources(choice);
            harvestSources(choice?.message);
            const delta = choice?.delta;
            harvestSources(delta);
            if (delta?.reasoning_content) { reasoningText += delta.reasoning_content; emitThought(delta.reasoning_content); }
            if (delta?.content) processContent(delta.content);
            if (Array.isArray(delta?.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const idx = typeof tc.index === 'number' ? tc.index : 0;
                if (!toolAcc.has(idx)) toolAcc.set(idx, { id: '', name: '', arguments: '' });
                const slot = toolAcc.get(idx)!;
                if (tc.id) slot.id = tc.id;
                if (tc.function?.name) slot.name = tc.function.name;
                if (typeof tc.function?.arguments === 'string') slot.arguments += tc.function.arguments;
              }
            }
            if (choice?.finish_reason) finishReason = choice.finish_reason;
          }
        }

        // Stable-order array (by index) so we can iterate deterministically
        const toolCalls = [...toolAcc.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
        return { visibleText, reasoningText, finishReason, toolCalls, usage, webSources: [...webSourceMap.values()] };
      };

      // Computed once so the cache-debug log (inside the loop) and the final
      // cache_usage emission (after the loop) read from the same source of
      // truth without duplicated ternary chains.
      const providerHint = useDeepSeekDirect || (isDeepSeek && isDashScope)
        ? 'deepseek'
        : isGLM ? 'glm'
        : isKimi ? 'kimi'
        : isGrok ? 'grok'
        : isCohere ? 'cohere'
        : isMinimax ? 'minimax'
        : isMimo ? 'mimo'
        : isBytedance ? 'bytedance'
        : isMeta ? 'meta'
        : isQwen ? 'qwen'
        : isLocal ? 'local'
        : 'oai';

      // Opt-in per-iteration cache diagnostic. Enable with `NEXUS_CACHE_DEBUG=1`
      // in the environment. Logs to the dev terminal (server-side) — never
      // reaches the browser. Captures:
      //   • stable_prefix_hash — SHA-256 of the first 2 messages (system +
      //     first user). Should be byte-identical across iterations within a
      //     turn. If it changes, our code is mutating the cacheable prefix.
      //   • prompt_tokens / cached / raw usage — what the provider reported.
      //     If cached ≈ 0 while the stable prefix is unchanged, the provider
      //     is not caching for us (account tier, model, or feature gate).
      const CACHE_DEBUG = process.env.NEXUS_CACHE_DEBUG === '1';

      const readableStream = new ReadableStream({
        async start(controller) {
          const enqueue = (obj: any) => betrayalSend(controller, obj);
          registerActiveTurnStop(() => { try { controller.close(); } catch {} try { turnAbort.abort(); } catch {} });
          // Identify the model+thinking-mode about to respond (see Claude branch above).
          enqueue(modelSelectedPayload);
          emitSenseEvents(controller);

          // ── Grok native web + X search fork ─────────────────────────────────
          // Opt-in, Model tab only (`enableGrokNativeSearch`, default off). Runs
          // xAI's server-side web_search + x_search via /v1/responses instead of
          // the normal chat/completions tool loop, then closes the stream.
          //
          // This deliberately does NOT hang off the Being tab's `enableWebSearch`
          // any more. It used to, and the result was that a Grok being with web
          // search on lost every workspace tool — it could not read its own desk
          // — because this fork returns before the tool loop (and before
          // `nexusWebToolsEnabled` is even read). Being tab on → Grok now takes
          // the ordinary path with NEXUS's own web_search/web_fetch tools, like
          // every other OpenAI-compatible family.
          //
          // Still true of this fork by construction: text-only input (images are
          // dropped from the search query) and no workspace tools. The Responses
          // API does accept `function` tools alongside the search tools (measured
          // 2026-09-23 — it returned a well-formed function_call), so wiring the
          // full tool loop onto this endpoint is possible; it is not done here.
          if (isGrok && modelParams.enableGrokNativeSearch) {
            const grokInput = baseOaiMessages
              // This fork flattens to {role, content}, so a replayed tool pair
              // (lib/toolHistory) would arrive as a bare `role: 'tool'` message
              // with its tool_call_id stripped — a shape the Responses API has
              // no call to match. Dropping the result messages here (the
              // tool_calls are already lost to the flattening) degrades this
              // fork back to exactly the prose-only wire it had before that
              // feature existed, which is the correct behaviour for an endpoint
              // that carries no workspace tools in the first place.
              .filter((m: any) => m.role !== 'tool')
              .map((m: any) => ({
                role: m.role,
                content: typeof m.content === 'string'
                  ? m.content
                  : (Array.isArray(m.content)
                      ? m.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n')
                      : String(m.content ?? '')),
              }));
            try {
              await runGrokNativeSearch({ apiKey: keys.grok || '', model: localModel, input: grokInput, enqueue, signal: turnAbort.signal, language });
            } catch (e: any) {
              enqueue({ type: 'text', content: `[Grok native search failed: ${e?.message || 'unknown error'}]` });
            }
            controller.enqueue(`data: [DONE]\n\n`);
            controller.close();
            return;
          }

          const MAX_CONTINUATIONS = 2;
          const MAX_TOOL_ITERATIONS = MAX_TOOL_ROUNDS;
          const repeatGuard = makeRepeatGuard();
          let toolStopNotice = '';
          // One state object for the whole turn — it has to persist across
          // continuation rounds so a tag opened in one round is still open in
          // the next. That persistence is also how a PHANTOM block used to
          // survive: see thinkTagSplitter.ts.
          const tagState = newThinkTagState();
          let msgs = [...baseOaiMessages];
          let cumulativeAssistantText = '';
          // Reasoning text accumulated across continuation rounds. Needed so a
          // model that runs out of tokens WHILE STILL THINKING can be handed its
          // own prior thought to continue from (otherwise the prefill is empty
          // and the model emits nothing — the "continued ×N, no output" bug).
          let cumulativeReasoningText = '';
          let attempt = 0;
          let toolIterations = 0;
          // Dedup web-search citations across every tool-loop iteration +
          // continuation so the final `web_sources` event carries the full set.
          const cumWebSourceMap = new Map<string, { url: string; title?: string }>();
          // Accumulate prompt-cache usage across tool-loop iterations and
          // continuation prefills so the cache_usage SSE event reflects the
          // total turn-level token bill.
          const cumOaiUsage: any = {
            prompt_tokens: 0,
            completion_tokens: 0,
            cached_tokens: 0,
            // DeepSeek's split-bucket fields:
            prompt_cache_hit_tokens: 0,
            prompt_cache_miss_tokens: 0,
          };
          try {
            while (true) {
              if (turnAbort.signal.aborted) break;   // Stop must end the tool loop, not just the output
              // Hash the cacheable-prefix portion *before* the call. We want
              // to verify that what we sent this iteration begins with the
              // exact same bytes as previous iterations. The first 2 messages
              // (system + first user) are the most reliably re-used prefix.
              const stablePrefixHash = CACHE_DEBUG && msgs.length > 0
                ? crypto
                    .createHash('sha256')
                    .update(JSON.stringify(msgs.slice(0, Math.min(2, msgs.length))))
                    .digest('hex')
                    .slice(0, 16)
                : '';

              const { visibleText, reasoningText, finishReason, toolCalls, usage, webSources } = await runLocalOnce(msgs, controller, tagState);
              for (const s of webSources) {
                if (!cumWebSourceMap.has(s.url)) cumWebSourceMap.set(s.url, s);
              }
              if (usage) {
                cumOaiUsage.prompt_tokens += Number(usage.prompt_tokens || 0);
                cumOaiUsage.completion_tokens += Number(usage.completion_tokens || 0);
                cumOaiUsage.cached_tokens += Number(
                  usage.prompt_tokens_details?.cached_tokens ??
                  usage.cache_read_input_tokens ??
                  usage.cached_tokens ??
                  0
                );
                cumOaiUsage.prompt_cache_hit_tokens += Number(usage.prompt_cache_hit_tokens || 0);
                cumOaiUsage.prompt_cache_miss_tokens += Number(usage.prompt_cache_miss_tokens || 0);
              }
              if (CACHE_DEBUG && usage) {
                const iterCached = Number(
                  usage.prompt_tokens_details?.cached_tokens ??
                  usage.cache_read_input_tokens ??
                  usage.cached_tokens ??
                  0
                );
                console.log(
                  `[CACHE-DEBUG] provider=${providerHint} model=${localModel} ` +
                  `iter=${toolIterations} total_msgs=${msgs.length} ` +
                  `stable_prefix_hash=${stablePrefixHash} ` +
                  `prompt_tokens=${usage.prompt_tokens || 0} cached=${iterCached} ` +
                  `raw_usage=${JSON.stringify(usage)}`
                );
              }

              // Model wants tools but the budget is gone — say so rather than
              // ending the turn on whatever text happened to be produced.
              if (toolCalls.length > 0 && toolIterations >= MAX_TOOL_ITERATIONS) {
                toolStopNotice = toolLimitNotice(MAX_TOOL_ITERATIONS);
                // One final tools-free call so the model writes its closing answer
                // from what it has already gathered, instead of dying with no output.
                try {
                  enqueue({ type: 'tool_activity', tool: 'write the final answer' });
                  const wrap = await runLocalOnce(
                    [...msgs, { role: 'user', content: toolWrapUpInstruction(language) }],
                    controller,
                    tagState,
                    { noTools: true },
                  );
                  cumulativeAssistantText += wrap.visibleText;
                  cumulativeReasoningText += wrap.reasoningText;
                  if (wrap.usage) {
                    cumOaiUsage.prompt_tokens += Number(wrap.usage.prompt_tokens || 0);
                    cumOaiUsage.completion_tokens += Number(wrap.usage.completion_tokens || 0);
                    cumOaiUsage.cached_tokens += Number(
                      wrap.usage.prompt_tokens_details?.cached_tokens ??
                      wrap.usage.cache_read_input_tokens ??
                      wrap.usage.cached_tokens ??
                      0
                    );
                    cumOaiUsage.prompt_cache_hit_tokens += Number(wrap.usage.prompt_cache_hit_tokens || 0);
                    cumOaiUsage.prompt_cache_miss_tokens += Number(wrap.usage.prompt_cache_miss_tokens || 0);
                  }
                  for (const s of wrap.webSources) {
                    if (!cumWebSourceMap.has(s.url)) cumWebSourceMap.set(s.url, s);
                  }
                } catch (e: any) {
                  console.warn(`[${providerHint}] wrap-up call failed:`, e?.message);
                } finally {
                  enqueue({ type: 'tool_activity', tool: null });
                }
              }

              // 1) Tool calls present → execute, append assistant turn (with
              // tool_calls field) and one role:'tool' message per call, loop.
              if (toolCalls.length > 0 && toolIterations < MAX_TOOL_ITERATIONS) {
                // Progress check before spending anything (see makeRepeatGuard).
                // Arguments arrive as a JSON string here; the guard hashes them
                // as-is, which is exactly the comparison we want.
                {
                  let stuck: string | null = null;
                  for (const tc of toolCalls) {
                    const hit = repeatGuard(tc.name, tc.arguments);
                    if (hit) { stuck = hit; break; }
                  }
                  if (stuck) { toolStopNotice = toolRepeatNotice(stuck); break; }
                }
                toolIterations++;
                msgs = [...msgs, {
                  role: 'assistant',
                  content: visibleText || '',
                  // Echo the model's own reasoning back on its tool-call turn.
                  // Two providers need this, for different reasons:
                  //
                  //  • Kimi (Moonshot) with thinking enabled VALIDATES it —
                  //    omitting it 400s the NEXT iteration outright
                  //    ("reasoning_content is missing in assistant tool call
                  //    message"). A loud failure.
                  //  • GLM (Z.AI-direct) needs it as the replay half of
                  //    Preserved Thinking — see the comment above
                  //    `glmPreservedThinking`. Omitting it does not error; the
                  //    model simply loses the thread and stops calling tools
                  //    after a few rounds. A silent failure, which is why this
                  //    stayed broken far longer than the Kimi one.
                  //
                  // DeepSeek-direct is NOT a third case, and this was measured
                  // rather than assumed — see `dsPrefillRc` above. It rejects a
                  // reasoning-less assistant turn only when it cannot match the
                  // turn to its own record of generating it; a replayed
                  // tool_call ID is such a match, and `tc.id` below is the
                  // provider's own ID. Adding the echo here would be a change
                  // with no effect.
                  //
                  // Z.AI's docs require the replayed blocks to match the
                  // original sequence exactly — do not trim, summarize or
                  // reorder `reasoningText`. It is the raw accumulation of that
                  // response's `reasoning_content` deltas, which is precisely
                  // what they ask for. Still gated, so providers that reject
                  // the non-standard field never see it.
                  ...(((isKimi && modelParams.qwenEnableThinking !== false) || glmPreservedThinking)
                    ? { reasoning_content: reasoningText || '' }
                    : {}),
                  tool_calls: toolCalls.map(tc => ({
                    id: tc.id || `call_${toolIterations}_${tc.name}`,
                    type: 'function',
                    function: { name: tc.name, arguments: tc.arguments || '{}' },
                  })),
                }];
                // If any tool call returned an image, queue it for injection
                // as a user message right after the tool results. OpenAI's
                // `tool` role can't carry image_url cleanly, so this two-step
                // (tool result text + follow-up user message with the image)
                // is the standard workaround.
                const pendingImageInjects: { name: string; dataUrl: string }[] = [];
                for (const tc of toolCalls) {
                  // A tool call already returned by the model must NOT execute
                  // after Stop — this is where ghost mouse/keyboard input came from.
                  if (turnAbort.signal.aborted) break;
                  let parsed: any = {};
                  try { parsed = JSON.parse(tc.arguments || '{}'); } catch {}
                  let resultText = '';
                  let attachmentEvent: any = null;
                  // Reflect the tool call in the loading label (silent otherwise).
                  const actLabel = toolActivityLabel(tc.name);
                  if (actLabel) enqueue({ type: 'tool_activity', tool: actLabel, name: tc.name });
                  enqueue({ type: 'tool_call', call: { name: tc.name, input: truncateToolInput(parsed), at: Date.now() } });
                  try {
                    if (tc.name === 'Read') {
                      const p = String(parsed.path || '');
                      if (isImageFilename(p)) {
                        const bin = await readWorkspaceFileBinary(folderName, p, { fullAccess: agentFullSystemAccess });
                        if (!bin) {
                          resultText = `Error: image not found or path outside workspace: ${p}`;
                        } else if (useEyesHere) {
                          // Text-only primary model — bridge the image via
                          // the eyes vision model and return a description
                          // as the tool result text. No follow-up
                          // user-message injection (the model can't see).
                          const base64 = bin.data.toString('base64');
                          const eyesResult = await describeImage({
                            imageBase64: base64,
                            imageMimeType: bin.mimeType,
                            eyesPrompt,
                            eyesModel,
                            zaiKey: keys.glm || '',
                            geminiKey: keys.gemini || '',
                            mimoKey: keys.mimo || '',
                            oauthToken: keys.claudeOAuthToken || '',
                            allowHostAnthropicEnv: !!keys.allowHostAnthropicEnv,
                          });
                          resultText =
                            `Image "${p}" (${bin.mimeType}, ${bin.data.length} bytes) — described via ${eyesModel}:\n\n` +
                            eyesResult.description;
                          attachmentEvent = {
                            type: 'file_attachment',
                            attachment: {
                              name: p, type: bin.mimeType, size: bin.data.length,
                              isImage: true,
                              ...(await toolAttachmentPayload(bin.data, bin.mimeType, base64)),
                              tokens: Math.max(1, Math.ceil(eyesResult.description.length / 4)),
                              excluded: false, toolAction: 'read',
                            },
                          };
                        } else {
                          // Vision-capable models (Qwen-VL, Gemma 4 mmproj,
                          // etc.) pick up the image from the follow-up user
                          // message and respond about it.
                          const base64 = bin.data.toString('base64');
                          const dataUrl = `data:${bin.mimeType};base64,${base64}`;
                          resultText = `Image "${p}" (${bin.mimeType}, ${bin.data.length} bytes) loaded successfully. Image content follows in the next user message.`;
                          pendingImageInjects.push({ name: p, dataUrl });
                          attachmentEvent = {
                            type: 'file_attachment',
                            attachment: {
                              name: p, type: bin.mimeType, size: bin.data.length,
                              // `dataUrl` above still feeds pendingImageInjects
                              // (the provider needs the bytes in the follow-up
                              // message); only the PERSISTED attachment becomes
                              // a ref.
                              isImage: true,
                              ...(await toolAttachmentPayload(bin.data, bin.mimeType, base64)),
                              tokens: Math.max(1, Math.ceil(bin.data.length / 750)),
                              excluded: false, toolAction: 'read',
                            },
                          };
                        }
                      } else {
                        const text = await readWorkspaceFile(folderName, p, { fullAccess: agentFullSystemAccess });
                        if (text == null) {
                          resultText = `Error: file not found or path outside workspace: ${p}`;
                        } else {
                          resultText = text;
                          attachmentEvent = {
                            type: 'file_attachment',
                            attachment: {
                              name: p, type: 'text/plain', size: text.length,
                              isText: true, textData: text,
                              tokens: Math.ceil(text.length / 4),
                              excluded: false, toolAction: 'read',
                            },
                          };
                        }
                      }
                    } else if (tc.name === 'Write') {
                      const p = String(parsed.path || '');
                      const c = String(parsed.content ?? '');
                      const wr = await writeWorkspaceFile(folderName, p, c, { fullAccess: agentFullSystemAccess });
                      if (!wr.ok) {
                        resultText = `Error: ${wr.error || 'write failed'}`;
                      } else {
                        resultText = `OK: ${wr.existed ? 'overwrote' : 'created'} ${p} (${c.length} chars).`;
                        attachmentEvent = {
                          type: 'file_attachment',
                          attachment: {
                            name: p, type: 'text/plain', size: c.length,
                            isText: true, textData: c,
                            tokens: Math.ceil(c.length / 4),
                            excluded: false, toolAction: wr.existed ? 'modified' : 'created',
                          },
                        };
                      }
                    } else if (tc.name === 'Edit') {
                      const p = String(parsed.path || '');
                      const oldS = String(parsed.old_string ?? '');
                      const newS = String(parsed.new_string ?? '');
                      const ed = await editWorkspaceFile(folderName, p, oldS, newS, { fullAccess: agentFullSystemAccess });
                      if (!ed.ok) {
                        resultText = `Error: ${ed.error || 'edit failed'}`;
                      } else {
                        const after = (await readWorkspaceFile(folderName, p, { fullAccess: agentFullSystemAccess })) || '';
                        resultText = `OK: edited ${p} (replaced ${oldS.length} chars with ${newS.length} chars).`;
                        attachmentEvent = {
                          type: 'file_attachment',
                          attachment: {
                            name: p, type: 'text/plain', size: after.length,
                            isText: true, textData: after,
                            tokens: Math.ceil(after.length / 4),
                            excluded: false, toolAction: 'modified',
                          },
                        };
                      }
                    } else if (tc.name === 'Glob') {
                      const pat = String(parsed.pattern || '**');
                      const matches = await globWorkspaceFiles(folderName, pat);
                      resultText = matches.length === 0
                        ? `(no files match \`${pat}\`)`
                        : matches.join('\n');
                    } else if (tc.name === 'Grep') {
                      const pat = String(parsed.pattern || '');
                      const filePat = parsed.file_pattern ? String(parsed.file_pattern) : undefined;
                      const flags = parsed.flags ? String(parsed.flags) : undefined;
                      const gr = await grepWorkspaceFiles(folderName, pat, { filePattern: filePat, flags });
                      if (!gr.ok) {
                        resultText = `Error: ${gr.error}`;
                      } else if (!gr.matches || gr.matches.length === 0) {
                        resultText = `(no matches for /${pat}/${flags || ''})`;
                      } else {
                        resultText = gr.matches.map(m => `${m.path}:${m.line}: ${m.text}`).join('\n');
                      }
                    } else if (tc.name === 'Delete') {
                      const p = String(parsed.path || '');
                      const del = await deleteWorkspaceFile(folderName, p, { fullAccess: agentFullSystemAccess });
                      resultText = del.ok ? `OK: deleted ${p}.` : `Error: ${del.error || 'delete failed'}`;
                    } else if (tc.name === 'Bash') {
                      // DANGEROUS shell execution — only present when
                      // agentDangerousTools gated the tool in above.
                      const cmd = String(parsed.command || '');
                      if (!cmd.trim()) {
                        resultText = 'Error: Bash requires a non-empty "command".';
                      } else {
                        const cwd = await ensureWorkspace(folderName);
                        const sh = await runShellCommand(cmd, { cwd, timeoutMs: Number(parsed.timeout_ms) || undefined, signal: turnAbort.signal });
                        resultText = sh.output;
                      }
                    } else if (tc.name === 'web_search') {
                      // Universal NEXUS web search (DuckDuckGo, keyless). Runs
                      // here on the server; results are fed back to the model AND
                      // registered as verifiable citations.
                      const query = String(parsed.query || parsed.q || '').trim();
                      if (!query) {
                        resultText = 'Error: web_search requires a non-empty "query".';
                      } else {
                        const hits = await webSearch(query, { maxResults: 6 });
                        for (const h of hits) {
                          if (h.url && !cumWebSourceMap.has(h.url)) {
                            cumWebSourceMap.set(h.url, { url: h.url, ...(h.title ? { title: h.title } : {}) });
                          }
                        }
                        resultText = hits.length === 0
                          ? `(no results for "${query}")`
                          : hits.map((h, i) =>
                              `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ''}`
                            ).join('\n\n') +
                            `\n\n(To read a full page, call web_fetch with one of the URLs above.)`;
                      }
                    } else if (tc.name === 'web_fetch') {
                      // Universal NEXUS web access — open ONE URL and return its
                      // readable text. SSRF-guarded inside webFetch().
                      const target = String(parsed.url || parsed.URL || '').trim();
                      if (!target) {
                        resultText = 'Error: web_fetch requires an absolute "url".';
                      } else {
                        const page = await webFetch(target, { maxChars: 8000 });
                        if (page.url && !cumWebSourceMap.has(page.url)) {
                          cumWebSourceMap.set(page.url, { url: page.url, ...(page.title ? { title: page.title } : {}) });
                        }
                        resultText =
                          `URL: ${page.url}\n` +
                          (page.title ? `Title: ${page.title}\n` : '') +
                          `\n${page.text}` +
                          (page.truncated ? `\n\n[...content truncated...]` : '');
                      }
                    } else if (tc.name === 'read_conversation') {
                      // Pull a past conversation by name. Inactive ("non-public")
                      // conversations are refused inside readConversationByName.
                      // Large transcripts are mirrored to the being's workspace
                      // and only a path is returned — see conversationRead.ts.
                      const name = String(parsed.name || parsed.title || '').trim();
                      const r = await readConversationByName(folderName, name, {
                        showPaths: attachmentPathsVisible,
                        fileTools: toolUseEnabled,
                        currentConvoId: convoId,
                      });
                      resultText = formatReadConversationResult(r);
                    } else if (tc.name === 'search_conversations') {
                      // Search across the entity's conversations; inactive ones
                      // excluded (privacy). Nothing is saved.
                      const sr = await searchConversations(folderName, String(parsed.query || parsed.q || '').trim(), { excludeInactive: true, regex: !!parsed.regex });
                      resultText = formatSearchForTool(sr, attachmentPathsVisible);
                    } else if (tc.name === 'read_attachment') {
                      // OpenAI `tool`-role messages can't carry media directly,
                      // so a restored image is delivered through the follow-up
                      // user-message injection (the same path computer_screenshot
                      // uses). Audio/video have no clean OpenAI-compat tool-result
                      // wire shape, so runReadAttachment reports them as text only.
                      // visionOverride: same catalog truth the mid-turn media
                      // injection already uses (see the `injectableKinds` call
                      // further down) — without it a local model WITH eyes is
                      // told it has none, while Read hands it the same bytes.
                      const r = await runReadAttachment({ prefix: String(parsed.ref || ''), pattern: parsed.pattern, folderName, index: conversationAttachmentRefs, specificModel: localModel, nativeMediaKinds: new Set(['image']), visionOverride: isLocal ? localModelVisionCapable : undefined });
                      resultText = r.text;
                      if (r.media?.kind === 'image') {
                        resultText += ' Image content follows in the next user message.';
                        pendingImageInjects.push({ name: `attachment_${r.media.mimeType.replace('/', '_')}`, dataUrl: `data:${r.media.mimeType};base64,${r.media.base64}` });
                      }
                    } else if (tc.name === 'search_attachments') {
                      resultText = await runSearchAttachments(folderName, String(parsed.query || '').trim(), !!parsed.regex, attachmentPathsVisible);
                    } else if ((LETTER_TOOL_NAMES as readonly string[]).includes(tc.name)) {
                      // Mail between identities. `me` is folderName — the sender
                      // is never taken from the model's arguments.
                      resultText = await runLetterTool(tc.name, parsed || {}, { me: folderName, convoId, instructions: I });
                    } else if ((BROWSER_TOOL_NAMES as readonly string[]).includes(tc.name)) {
                      // Browser control. Allowlist enforcement lives in the
                      // executor, not here — see the Claude API site.
                      resultText = await runBrowserTool(tc.name, parsed || {}, {
                        me: folderName, allowedHosts: browserAllowedHosts,
                        allowAnyHost: browserAllowAnyHost, instructions: I,
                      });
                    } else if ((COMPUTER_TOOL_NAMES as readonly string[]).includes(tc.name)) {
                      // OS-level mouse/keyboard/screen control. computer_screenshot
                      // delivers a real image the same way Read does for an image
                      // file: eyes-bridge description for text-only models,
                      // pendingImageInjects for vision-capable ones.
                      // Second arg: local engines answer in a 0–1000 space (see
                      // reportsNormalizedCoords for the measurement). Same
                      // catalog flag the media paths use — false for all cloud.
                      const cr = await runComputerTool(tc.name, parsed || {}, { me: folderName, instructions: I, language, normalizedCoords: reportsNormalizedCoords(localModel, isLocal && localModelVisionCapable) });
                      if (cr.image) {
                        if (useEyesHere) {
                          const eyesResult = await describeImage({
                            imageBase64: cr.image.base64,
                            imageMimeType: cr.image.mimeType,
                            eyesPrompt,
                            eyesModel,
                            zaiKey: keys.glm || '',
                            geminiKey: keys.gemini || '',
                            mimoKey: keys.mimo || '',
                            oauthToken: keys.claudeOAuthToken || '',
                            allowHostAnthropicEnv: !!keys.allowHostAnthropicEnv,
                          });
                          resultText = `${cr.text}\n\nDescribed via ${eyesModel}:\n\n${eyesResult.description}`;
                        } else {
                          const dataUrl = `data:${cr.image.mimeType};base64,${cr.image.base64}`;
                          resultText = `${cr.text} Image content follows in the next user message.`;
                          pendingImageInjects.push({ name: `screenshot_${Date.now()}.png`, dataUrl });
                        }
                        attachmentEvent = {
                          type: 'file_attachment',
                          attachment: {
                            name: `screenshot_${Date.now()}.png`,
                            type: cr.image.mimeType,
                            size: Math.ceil(cr.image.base64.length * 0.75),
                            isImage: true,
                            ...(await toolAttachmentPayload(Buffer.from(cr.image.base64, 'base64'), cr.image.mimeType, cr.image.base64)),
                            tokens: Math.max(1, Math.ceil(cr.image.base64.length * 0.75 / 750)),
                            excluded: false,
                            toolAction: 'read',
                          },
                        };
                      } else {
                        resultText = cr.text;
                      }
                    } else if ((APP_TOOL_NAMES as readonly string[]).includes(tc.name)) {
                      // App Control via UI Automation. app_shot goes through the
                      // same eyes-bridge / pendingImageInjects split as
                      // computer_screenshot; every other app tool is plain text,
                      // so a text-only vessel needs no bridge at all here.
                      const ar = await runAppTool(tc.name, parsed || {}, { me: folderName, instructions: I });
                      if (ar.image) {
                        if (useEyesHere) {
                          const eyesResult = await describeImage({
                            imageBase64: ar.image.base64,
                            imageMimeType: ar.image.mimeType,
                            eyesPrompt,
                            eyesModel,
                            zaiKey: keys.glm || '',
                            geminiKey: keys.gemini || '',
                            mimoKey: keys.mimo || '',
                            oauthToken: keys.claudeOAuthToken || '',
                            allowHostAnthropicEnv: !!keys.allowHostAnthropicEnv,
                          });
                          resultText = `${ar.text}\n\nDescribed via ${eyesModel}:\n\n${eyesResult.description}`;
                        } else {
                          const dataUrl = `data:${ar.image.mimeType};base64,${ar.image.base64}`;
                          resultText = `${ar.text} Image content follows in the next user message.`;
                          pendingImageInjects.push({ name: `app_shot_${Date.now()}.png`, dataUrl });
                        }
                        attachmentEvent = {
                          type: 'file_attachment',
                          attachment: {
                            name: `app_shot_${Date.now()}.png`,
                            type: ar.image.mimeType,
                            size: Math.ceil(ar.image.base64.length * 0.75),
                            isImage: true,
                            ...(await toolAttachmentPayload(Buffer.from(ar.image.base64, 'base64'), ar.image.mimeType, ar.image.base64)),
                            tokens: Math.max(1, Math.ceil(ar.image.base64.length * 0.75 / 750)),
                            excluded: false,
                            toolAction: 'read',
                          },
                        };
                      } else {
                        resultText = ar.text;
                      }
                    } else if (tc.name === '$web_search') {
                      // Moonshot (Kimi) builtin web search. Unlike the
                      // workspace tools, the search itself runs on Moonshot's
                      // servers — the documented client contract is to echo the
                      // model's arguments straight back as the tool result.
                      // Moonshot then performs the search and continues the
                      // completion (billed separately on their side). Returning
                      // anything else (or "unknown function") makes Kimi report
                      // it has no web access.
                      resultText = tc.arguments || '{}';
                    } else if (tc.name === 'AskQuestion') {
                      // Pause the turn: emit the question to the client, wait
                      // for the user's selection (or indefinitely / until the
                      // configured timeout), then return it as the tool result.
                      const questions = normalizeQuestions(parsed);
                      if (questions.length === 0) {
                        resultText = 'Error: AskQuestion requires 1-4 questions, each with 2-4 options.';
                      } else {
                        const askId = createAskId();
                        enqueue({ type: 'ask_user', askId, questions });
                        const answered = await waitForAsk(askId, Number(askUserTimeoutMs) || 0);
                        const timedOut = answered === null;
                        const finalAnswers = timedOut ? recommendedDefaults(questions) : answered!;
                        enqueue({ type: 'ask_user_resolved', askId, answers: finalAnswers, timedOut });
                        resultText = formatAnswerForModel(finalAnswers, timedOut);
                      }
                    } else if (tc.name === 'change_model') {
                      // Vessel handoff. Only an ACCEPTED switch ends the turn.
                      const o = runChangeModel(parsed, handoffCtx);
                      resultText = o.resultText;
                      if (o.switched) {
                        const acc = { model: o.model, note: o.note };
                        handoffAccepted = acc;
                        enqueue(handoffPayload(acc));
                      }
                    } else if (tc.name === 'spawn_subagent') {
                      // Context firewall: a fresh read-only child investigates
                      // and returns only its distilled result. Default child
                      // model = subagentModel, else the parent's own model.
                      const task = String(parsed?.task || '');
                      if (!task.trim()) {
                        resultText = 'Error: spawn_subagent requires a non-empty "task".';
                      } else {
                        enqueue({ type: 'subagent_start', task });
                        // Route the child to the provider that owns the chosen
                        // model (subagentFamily/subagentModel), NOT the parent's
                        // endpoint. Empty → inherit the parent's family+model.
                        const childFamily = subagentFamily && subagentFamily.trim() ? subagentFamily.trim() : aiName;
                        const childModel = subagentModel && subagentModel.trim() ? subagentModel.trim() : localModel;
                        const sub = await runSubagent({
                          family: childFamily, model: childModel, keys,
                          task, returnContract: parsed?.return_contract ? String(parsed.return_contract) : undefined,
                          folderName, fullAccess: agentFullSystemAccess,
                          webSearch: !!(modelParams?.enableWebSearch || modelParams?.enableClaudeWebSearch),
                        });
                        cumOaiUsage.prompt_tokens += sub.usage.input;
                        cumOaiUsage.completion_tokens += sub.usage.output;
                        enqueue({ type: 'subagent_done', task, result: sub.text, via: sub.via });
                        resultText = sub.text || '(subagent returned nothing)';
                      }
                    } else {
                      resultText = `Error: unknown function ${tc.name}`;
                    }
                  } catch (e: any) {
                    resultText = `Error: ${e?.message || 'tool execution failed'}`;
                  }
                  msgs = [...msgs, {
                    role: 'tool',
                    tool_call_id: tc.id || `call_${toolIterations}_${tc.name}`,
                    // Moonshot's builtin $web_search requires the function name
                    // on the tool-result message to match the call. The `name`
                    // field is part of the original OpenAI function-calling
                    // spec and is tolerated/ignored by the other providers.
                    name: tc.name,
                    content: resultText,
                  }];
                  // Deliberately NOT emitting `attachmentEvent` — see the note on
                  // the Claude path: tool files are not pinned as persistent
                  // message attachments (no context-window re-entry every turn),
                  // matching the OAuth path. The tool result above already hands
                  // the model the content for this turn.
                  void attachmentEvent;
                  if (actLabel) enqueue({ type: 'tool_activity', tool: null });
                }

                // If any image was read, inject a follow-up user message
                // carrying the actual bytes for vision-capable local models
                // to look at. Uses the same customizable image-instruction
                // template the Gemini path uses.
                if (pendingImageInjects.length > 0) {
                  const hintTemplate = (toolImageInstruction || '').trim();
                  const parts: any[] = [];
                  for (const img of pendingImageInjects) {
                    if (hintTemplate) {
                      parts.push({
                        type: 'text',
                        text: hintTemplate.replace(/\{filename\}/g, img.name),
                      });
                    }
                    parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
                  }
                  msgs = [...msgs, { role: 'user', content: parts }];
                }

                // Mid-turn partner interjection: append as a user message after
                // the tool results, so the model sees it on its next iteration.
                const injectedOai = drainInjections(injectTurnId);
                if (injectedOai.texts.length || injectedOai.media.length) {
                  // OpenAI-compatible wire: image_url / input_audio / video_url.
                  // LOCAL (LM Studio) is the exception on two of the three — its
                  // request validator accepts only text and image_url and 400s
                  // the WHOLE call otherwise, so sending audio or video there
                  // would not degrade, it would kill the turn. (The normal send
                  // path decodes local video into frames; doing that inside a
                  // tool-loop boundary is a separate job, so mid-turn video to a
                  // local model is handed off by ref instead of claimed.)
                  const wireOai = new Set<MediaKindNarrow>(['image']);
                  if (!isLocal) { wireOai.add('audio'); wireOai.add('video'); }
                  const prepOai = await prepareInjectionDelivery({
                    drained: injectedOai,
                    wire: wireOai,
                    model: localModel,
                    framing: I.injectionFraming,
                    handoffTemplate: I.injectionAttachmentNote,
                    refsOpenable: hiddenAttachmentsAccessible,
                    pathsVisible: attachmentPathsVisible,
                    refIndex: conversationAttachmentRefs,
                    ja: language === 'ja',
                    // Local vision models (e.g. Gemma) are default-denied by the
                    // id-substring registry; feed the catalog truth so they get
                    // the image natively. undefined for cloud (registry decides).
                    visionOverride: isLocal ? localModelVisionCapable : undefined,
                  });
                  const oaiParts: any[] = [];
                  if (prepOai.text) oaiParts.push({ type: 'text', text: prepOai.text });
                  // `rawBase64Audio`: ByteDance/Ark schema-validates
                  // input_audio.data as pure base64 and nulls the whole message
                  // when handed a data: URL — same distinction the normal path makes.
                  oaiParts.push(...openaiInjectParts(prepOai.deliver, { rawBase64Audio: isBytedance }));
                  if (oaiParts.length) {
                    // All-text collapses to a plain string: some OpenAI-compatible
                    // endpoints are stricter about a single-element text array
                    // than about a string, and this matches how the base message
                    // builder above decides the same question.
                    const allText = oaiParts.every((p: any) => p.type === 'text');
                    msgs = [...msgs, { role: 'user', content: allText ? oaiParts.map((p: any) => p.text).join('\n') : oaiParts }];
                  }
                  if (prepOai.notice) enqueue({ type: 'notice', content: prepOai.notice });
                  enqueue({ type: 'injection_delivered', count: injectedOai.texts.length + injectedOai.media.length });
                  // display-only tool/thinking-log event (see OAuth path above)
                  try { enqueue({ type: 'tool_call', call: { name: 'partner interjection', kind: 'event', at: Date.now(), input: { texts: injectedOai.texts, files: prepOai.logNames } } }); } catch {}
                }

                // Vessel handoff: the turn is over — don't ask this vessel to
                // continue. The client re-POSTs as the new vessel.
                if (handoffAccepted) break;
                continue; // loop — next iteration sees tool results
              }

              // 2) No tool calls — accumulate text and maybe continuation.
              cumulativeAssistantText += visibleText;
              cumulativeReasoningText += reasoningText;
              const truncated = finishReason === 'length';
              if (!truncated || attempt >= MAX_CONTINUATIONS) {
                // Say it out loud when we give up on a cut-off reply. Every
                // other provider path already does — Claude at ~6049, Gemini at
                // ~7683, Anthropic-compat at ~3711 — and THIS one, which serves
                // DeepSeek, GLM, Qwen, MiniMax, Grok, Cohere, Meta, OpenAI and
                // Local, broke off in complete silence. Found 2026-10-21 while
                // chasing a Soul Packer run that stopped at 83% of Layer 3:
                // a run that ends here is indistinguishable from one that
                // finished, which is the whole reason it went unnoticed.
                //
                // Same frame-type rule as the Anthropic-compat site, for the
                // same reason: an agent run gets `notice` (the panel's
                // run-event list, leaving the accumulated document untouched —
                // a `text` frame would be saved INTO the soul file), while a
                // conversation gets `text` so the reason lands in the reply the
                // reader is actually looking at.
                if (truncated) {
                  enqueue({
                    type: agentReadOnlyTools ? 'notice' : 'text',
                    content: (agentReadOnlyTools ? '' : '\n\n')
                      + (language === 'ja'
                          ? `⚠️ _[出力がトークン上限に達して切れました（継続 ${attempt}/${MAX_CONTINUATIONS} 回のあとも未完）。]_`
                          : `⚠️ _[Response hit the token limit and is still unfinished after ${attempt}/${MAX_CONTINUATIONS} continuation(s).]_`),
                  });
                }
                break;
              }

              // Build the continuation prefill. Normally we feed back the
              // model's own visible text so it resumes exactly where it stopped.
              // But when the model ran out of tokens WHILE STILL THINKING (long
              // reasoning, no visible answer yet — common on local thinking
              // models like Qwen3 / Gemma GGUF), the visible text is empty.
              // Feeding back an empty assistant turn makes the next call produce
              // nothing — the "↵ continued ×N" badge with no actual output the
              // user reported. In that case, hand the model back its accumulated
              // reasoning wrapped in an (unclosed) <think> block so it can pick
              // up the thought and finish it.
              //
              // KNOWN-BAD SHAPE, LEFT IN PLACE DELIBERATELY (2026-10-12). On the
              // same wire this bare prefill is what makes deepseek-v4-pro throw
              // the partial away and restart from its own header, and GLM-5.3 do
              // the same with 4.6-7.5x the reasoning — measured, and that is why
              // the Soul Packer stopped using it (see buildContinuationUserMsg).
              // The identical assistant+user fix was written for HERE too and
              // then REVERTED, because this site cannot be measured: it only
              // runs on `finish_reason === 'length'`, and NEXUS sends no output
              // cap on this path at all, so a modern provider never reaches one
              // (deepseek-v4-pro wrote a 400-item list, 25,878 chars, and
              // finished normally). Local DOES fire it for free via
              // `max_tokens: -1`, but 11 runs across two models could not
              // separate the two codes — the variance is "did thinking eat the
              // budget", and swapping the port order flipped the result.
              // DigitalOcean's only small-cap model (glm-5, 12,800) is 404.
              // Shipping an unverifiable rewrite of a path that practically
              // never runs buys nothing and risks a silent break on ten
              // providers. See pending-tasks.md for how to make it measurable.
              //
              // ── CORRECTION 2026-10-21 ───────────────────────────────────
              // "A modern provider never reaches one" was WRONG, and the
              // sentence above is kept so the mistake is visible rather than
              // quietly rewritten. The claim rested on ONE arm — a 25,878-char
              // answer that finished normally — which only proves that arm did
              // not reach the ceiling, never that no ceiling exists.
              //
              // deepseek-v4-pro's default `max_tokens` in thinking mode is 64K
              // (its own API reference, and probed), SHARED with the chain of
              // thought. "No cap sent" was a fact about us; it was never the
              // same thing as "no cap applies".
              //
              // The CONCLUSION survived anyway, and only by 4.4%: a real β run
              // through this route finished at completion_tokens 62,632, i.e.
              // 95.6% of that default. So this site still has not fired on real
              // work — the sentence above was right for a reason it did not
              // give. A measured cap is now sent (see the useDeepSeekDirect
              // block), which widens the margin rather than creating it.
              //
              // So the shape here is still the measured bad one, still unfired,
              // and still untested against the other nine providers on this
              // path. What has changed is only that "a modern provider never
              // reaches a cap" is not a thing anyone may say here again.
              // ────────────────────────────────────────────────────────────
              let prefillContent = cumulativeAssistantText;
              if (!prefillContent.trim()) {
                if (cumulativeReasoningText.trim()) {
                  prefillContent = `<think>\n${cumulativeReasoningText}`;
                } else {
                  // Nothing visible AND nothing thought — a continuation round
                  // would just yield another empty turn. Stop instead of
                  // emitting a misleading "continued" badge.
                  break;
                }
              }
              // ...plus DeepSeek's required reasoning echo on the prefill turn
              // (see `dsPrefillRc`). Unlike the SPU, this site HAS the model's
              // real reasoning text, so it echoes that instead of an empty
              // string — DeepSeek's docs say an echoed reasoning_content is
              // concatenated back into context, so the continuation keeps the
              // thought it was in the middle of.
              msgs = [...msgs, { role: 'assistant', content: prefillContent, ...dsPrefillRc(cumulativeReasoningText) }];
              attempt++;
            }
            // Flush any held-back tag-detection tail
            if (tagState.textTail) {
              const ev = tagState.inThink
                ? { type: 'thought', content: tagState.textTail }
                : { type: 'text', content: tagState.textTail };
              betrayalSend(controller, ev);
            }
            if (attempt > 0) {
              controller.enqueue(`data: ${JSON.stringify({ type: 'continued', count: attempt })}\n\n`);
            }
            // Emit normalized cache usage. `providerHint` was computed above
            // (just outside the ReadableStream) so the per-iteration cache
            // debug log and this final emission read from the same source.
            if (toolStopNotice) {
              console.warn(`[${providerHint}] ${toolStopNotice}`);
              enqueue({ type: 'notice', content: toolStopNotice });
            }
            const usagePayload = normalizeCacheUsage(cumOaiUsage, providerHint);
            if (usagePayload) enqueue(usagePayload);
            // Surface web-search citations (if any) so the user can click
            // through and verify the model actually read those pages. An empty
            // set after a search-enabled turn flags possible hallucination.
            if (cumWebSourceMap.size > 0) {
              enqueue({ type: 'web_sources', sources: [...cumWebSourceMap.values()] });
            }
            controller.enqueue(`data: [DONE]\n\n`);
            controller.close();
          } catch (e: any) {
            // After a Stop the client is gone (or the controller was already
            // closed by the stop key), so enqueue() throws "Invalid state".
            // Guard it: the cleanup path must never become the unhandled
            // rejection that takes the dev server's turn down with it.
            try { controller.enqueue(`data: ${JSON.stringify({ error: e.message })}\n\n`); } catch {}
            try { controller.close(); } catch {}
          }
        },
      });

      return new Response(readableStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    }
    else {
      // Fallback
      return NextResponse.json({ text: `I am ${aiName}. This is a simulated response since no API key or specific integration was found for this model name.` });
    }

  } catch (error: any) {
    console.error(error);
    return NextResponse.json({ error: error.message || 'Unknown error occurred.' }, { status: 500 });
  }
}
