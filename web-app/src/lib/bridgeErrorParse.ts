// Parse an upstream bridge-model HTTP error body into a single human-readable
// sentence. Handles three shapes:
//   • OpenAI-compatible:        { error: { message, code, type } }
//   • Google Gemini:            { error: { message, status, code } }
//   • Raw text / unknown JSON:  best-effort string extraction
//
// DashScope wraps its real message in noise like
//   "<400> InternalError.Algo.InvalidParameter: <real reason>"
// — we strip that prefix so the UI shows just the reason. Same for a few other
// known prefixes from Aliyun/DashScope.

export function parseUpstreamError(errText: string, httpStatus: number): string {
  if (!errText || !errText.trim()) return `HTTP ${httpStatus}`;

  // Try JSON first.
  let msg = '';
  try {
    const parsed = JSON.parse(errText);
    msg =
      parsed?.error?.message ||
      parsed?.message ||
      parsed?.error?.error?.message ||
      '';
  } catch {
    // Not JSON — fall through with the raw text.
  }

  if (!msg) msg = errText;

  // Strip common upstream prefixes.
  // "<400> InternalError.Algo.InvalidParameter: The video file is too short."
  //   →                                       The video file is too short.
  msg = msg.replace(/^\s*<\d+>\s*[A-Za-z][\w.]*\s*:\s*/, '');
  // "The video modality input does not meet the requirements because: <reason>"
  //   →                                                                <reason>
  msg = msg.replace(
    /^The\s+\w+\s+modality\s+input\s+does\s+not\s+meet\s+the\s+requirements\s+because:\s*/i,
    ''
  );

  msg = msg.trim();
  if (!msg) return `HTTP ${httpStatus}`;
  // Cap length for badge use — full text remains in the description for the modal.
  if (msg.length > 240) msg = msg.slice(0, 237) + '…';
  return msg;
}
