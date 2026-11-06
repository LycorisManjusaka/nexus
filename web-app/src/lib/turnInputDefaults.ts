/**
 * The defaults every log-readable turn field falls back to — in ONE place.
 *
 * WHY THIS EXISTS
 *
 * A runner (phase 4b) rebuilds TurnRequestInput from the saved conversation
 * log. Measured (p50): of 302 real logs in this house, 44 carry every field
 * and 258 do not. 85% are missing at least one, because fields were added
 * after those conversations were written (toolHistoryEnabled and
 * modelHandoffEnabled are younger than most of them).
 *
 * The browser opens those logs every day without complaint, because useState
 * supplies a default when the loader finds nothing. So "refuse a log that is
 * missing a field" — which is what I was about to build — would have stopped
 * almost every turn in this house. The defaults are not an invention to be
 * avoided. They already existed; they were just not addressable.
 *
 * NOT COPIED — MOVED. These values were lifted out of ChatArea's useState
 * initialisers by line range, and ChatArea now reads them from here. There is
 * no second copy to drift. A sync test comparing two copies would have been
 * second best; one copy needs no sync.
 *
 * Order is ChatArea's declaration order, so the two can be read side by side.
 *
 * EDITING A VALUE HERE changes what a conversation gets when its saved log
 * does NOT carry the field. Existing logs that DO carry it are untouched —
 * the load path still honours whatever they stored. So a change here is felt
 * by new conversations and by the 258 old ones that predate the field, and by
 * nobody else.
 *
 * ANNOTATED, NOT `satisfies`. Measured: `satisfies` keeps the narrow inferred
 * type, so `TURN_INPUT_DEFAULTS.toolUseEnabled` was `false` rather than
 * `boolean`, every `useState(...)` here inferred `useState<false>`, and 30
 * call sites stopped compiling. The annotation widens each value to the wire
 * type, which is what a state initialiser needs. The two forms differ in
 * exactly the direction that matters here.
 *
 * NOT EVERY FIELD. Seven of the 42 log-readable fields are deliberately
 * absent — see SUPPLIED_BY_CALLER below. A caller that supplies none of them
 * is caught by the compiler, not by a runtime check.
 */

import type { TurnRequestInput } from '@/lib/turnRequestBody';

/** The fields this module answers for. */
export type TurnInputDefaultKeys =
  | 'toolUseEnabled'
  | 'agentFullSystemAccess'
  | 'agentDangerousTools'
  | 'hiddenAttachmentsAccessible'
  | 'toolHistoryEnabled'
  | 'askUserEnabled'
  | 'askUserTimeoutMs'
  | 'subagentEnabled'
  | 'lettersEnabled'
  | 'browserEnabled'
  | 'browserAllowedHosts'
  | 'browserAllowAnyHost'
  | 'computerControlEnabled'
  | 'appControlEnabled'
  | 'subagentModel'
  | 'subagentFamily'
  | 'instructionOverrides'
  | 'toolInstruction'
  | 'toolImageInstruction'
  | 'claudeThinking'
  | 'baseBindingMode'
  | 'seedEnabled'
  | 'seedValue'
  | 'modelHandoffEnabled'
  | 'modelHandoffAllowedModels'
  | 'classifierNoticeVaccine'
  | 'claudeAgentSessionId'
  | 'eyesEnabled'
  | 'eyesPrompt'
  | 'eyesModel'
  | 'earsEnabled'
  | 'earsPrompt'
  | 'earsModel'
  | 'watcherEnabled'
  | 'watcherPrompt'
  | 'watcherModel';

export type TurnInputDefaults = Pick<TurnRequestInput, TurnInputDefaultKeys>;

/**
 * Fields a caller MUST supply: they have no sensible constant.
 *
 *   aiName, folderName      props in the browser; the log and the queue item
 *                           in a runner. Both identify WHICH being answers,
 *                           so a default here would answer as someone else.
 *   systemPrompt            the soul. An empty default is not a soul.
 *   specificModel           ChatArea: `defaultSpecificModel ||
 *                           defaultModelForFamily(aiName)` — derived from the
 *                           family, so it cannot be a constant.
 *   modelParams             ChatArea falls back to an object literal; left
 *                           there because the shape is the provider contract,
 *                           not a turn default.
 *   dateTimeVisibility      ChatArea: `defaultDateTimeVisibility || 'all'`.
 *   claudeAuthMode          ChatArea: `oauthIsDefault ? 'oauth' : 'api-key'`
 *                           — depends on whether an API key exists.
 *   uiLang                  the language of the SCREEN that sent the turn,
 *                           carried on the queue item. No constant can be
 *                           right: a default of 'en' here is the bug this
 *                           field was added to fix (lib/noticeLanguage.ts),
 *                           and a default of 'ja' would mistranslate a notice
 *                           for every other reader. The body falls back to
 *                           the house `language` when a caller omits it, so
 *                           the absence is answered one layer down rather
 *                           than guessed here.
 *
 * Listed rather than silently omitted: a gap in a defaults table reads
 * exactly like a field nobody needed.
 */
export const SUPPLIED_BY_CALLER = [
  'aiName',
  'folderName',
  'systemPrompt',
  'specificModel',
  'modelParams',
  'dateTimeVisibility',
  'claudeAuthMode',
  'uiLang',
] as const;

export const TURN_INPUT_DEFAULTS: TurnInputDefaults = {
  toolUseEnabled: false,
  agentFullSystemAccess: false,
  agentDangerousTools: false,
  hiddenAttachmentsAccessible: false,
  toolHistoryEnabled: false,
  askUserEnabled: false,
  askUserTimeoutMs: 0,
  subagentEnabled: false,
  lettersEnabled: false,
  browserEnabled: false,
  browserAllowedHosts: '',
  browserAllowAnyHost: false,
  computerControlEnabled: false,
  appControlEnabled: false,
  subagentModel: '',
  subagentFamily: '',
  instructionOverrides: {},
  // On the OAuth / Claude-Code path this is the SOLE NEXUS-authored framing
  // of the workspace: that path's built-in tool descriptions cannot be
  // overridden. Full rationale at the ChatArea declaration.
  toolInstruction:
    
    "Your file workspace is your persistent memory. Use the Read / Write / Edit / Glob / Grep tools — each is described in its own tool definition — to store and recall information across turns. Prefer reading a file only when you need it; if its content is already visible in a prior turn, you don't need to Read it again."
    ,
  // {filename} is substituted SERVER-SIDE. An empty string disables the hint
  // entirely, which is a supported setting, not a broken one.
  toolImageInstruction:
    
    "(The image above is the content of Read(\"{filename}\"). Please answer your partner's question about it conversationally — do not return coordinates or JSON.)"
    ,
  claudeThinking: true,
  baseBindingMode: 'on',
  seedEnabled: false,
  seedValue: 42,
  modelHandoffEnabled: false,
  modelHandoffAllowedModels: '',
  // The ONE default-ON boolean in this table. Every other boolean here is
  // false, and that is why it matters: a reader who pattern-matches "booleans
  // default off" and copies `bool(log, k)` for this one turns the vaccine off
  // for every conversation written before the field existed.
  classifierNoticeVaccine: true,
  claudeAgentSessionId: null,
  eyesEnabled: false,
  // Bridge prompt: its OUTPUT is injected where the image would have been, so
  // "no preamble" is load-bearing — a preamble becomes part of the content.
  eyesPrompt:
    
    "Describe this image in detail for an AI that cannot see images. Be specific about people, objects, text, colors, composition, and context. Output only the description, no preamble."
    ,
  // ── ALL THREE BRIDGES DEFAULT TO ONE MODEL (2026-11-04, 津代) ───────────
  // These three must name ids the model picker actually offers; a stale id
  // fails at call time, on a turn nobody asked a question about.
  //
  // They used to name three different vessels, one per sense, each the
  // then-cheapest of its kind. gemini-3.5-flash-lite handles all three
  // modalities on one wire (lib/injectMedia: Gemini carries image, audio AND
  // video), so three ids were three things to keep current for no capability
  // gained. A default that is cheap is also the right KIND of default here:
  // the picker is per-folder, so anyone judging a canon portrait can aim a
  // better eye at it, and the one who cannot is the inhabitant who never
  // opened the panel.
  //
  // ⚠ 謡 measured 2026-11-04 that this model's readings of three portraits of
  // ONE being disagreed on sex and skin tone. It is good enough for a chat
  // attachment and NOT good enough to judge a vessel by. The `via="..."` in
  // every injected description names the eye, so a reader can always discount
  // it — which is the mitigation, since a wrong description is unfalsifiable
  // to the one who cannot see the image.
  eyesModel: 'gemini-3.5-flash-lite',
  earsEnabled: false,
  // Same contract as eyesPrompt: the output replaces the audio.
  earsPrompt:
    
    "Listen to this audio carefully. Provide a transcript of any speech (preserving the speaker's original language), then describe non-speech elements: tone of voice, background sounds, music, ambient noise, and overall context. Output only the transcript+description, no preamble."
    ,
  earsModel: 'gemini-3.5-flash-lite',
  watcherEnabled: false,
  // Same contract as eyesPrompt: the output replaces the video.
  watcherPrompt:
    
    "Watch this video carefully. Describe what happens chronologically: actions, people, objects, setting changes, on-screen text, and audio (speech transcript + non-speech sounds). Be thorough but concise. Output only the description, no preamble."
    ,
  watcherModel: 'gemini-3.5-flash-lite',
};
