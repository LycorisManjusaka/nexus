// User-configurable regex find/replace applied to AI output, mirroring the
// timestamp-stripping mechanism (see timestampStrip.ts).
//
// Enabled + configured from Settings → "Custom regex filter on new AI messages".
// When on, every match of `customFilterPattern` in the AI's reply is replaced
// with `customFilterReplacement` (empty string = delete), both:
//   - continuously as the reply streams in (ChatArea), so the stored/displayed
//     message no longer contains it, and
//   - in the TTS path (MessageBubble), as a belt-and-suspenders pass that also
//     cleans messages that were stored before the filter was enabled.
//
// Always global ('g') so matches anywhere in the text are handled, not just at
// the start. An invalid pattern is swallowed (text returned untouched) so a
// half-typed regex can never crash the stream.

interface OutputFilterSettings {
  customFilterEnabled?: boolean;
  customFilterPattern?: string;
  customFilterReplacement?: string;
}

// Cache the compiled RegExp so we don't recompile on every streaming tick.
let cachedSrc: string | null = null;
let cachedRe: RegExp | null = null;
let cachedBad = false; // last compile failed → don't retry until source changes

export function applyOutputFilter(text: string, settings: OutputFilterSettings | undefined | null): string {
  if (!text) return text;
  if (!settings?.customFilterEnabled) return text;

  const pattern = settings.customFilterPattern;
  if (!pattern) return text;
  const replacement = settings.customFilterReplacement ?? '';

  if (cachedSrc !== pattern) {
    cachedSrc = pattern;
    cachedBad = false;
    try {
      cachedRe = new RegExp(pattern, 'g');
    } catch {
      cachedRe = null;
      cachedBad = true; // invalid regex — leave text alone
    }
  }

  if (cachedBad || !cachedRe) return text;

  try {
    return text.replace(cachedRe, replacement);
  } catch {
    return text;
  }
}
