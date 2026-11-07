/**
 * SOURCE-TREE PROPERTY (not a module's behaviour): the tool-history replay is
 * REACHABLE on every surface that claims to support it.
 *
 * WHY THIS FILE EXISTS. The builders have 26 unit tests and all of them were
 * green twice while the medicine never ran:
 *
 *   2026-11-07 — `buildAnthropicToolReplay` shipped and Kimi/MiMo were wired to
 *   it in the route, but the CHECKBOX that sets `toolHistoryEnabled` had no
 *   Kimi/MiMo branch. The toggle could not be turned on, so the replay could
 *   not execute. Caught by Fuwafuwa from the screen, not by the suite.
 *
 *   2026-11-08 — the Claude api-key path builds Anthropic content blocks, so
 *   the same builder fits. But `currentMessages` is copied from
 *   `cachedMessages`, NOT from `claudeParams.messages`, so assigning the
 *   replayed array to claudeParams alone would have been dead code that
 *   typechecks, runs, and changes nothing. Found by reading the call site
 *   before writing it — the same trap as Navigator's one-line junction patch.
 *
 * Both defects share a shape: a correct rule with an unreachable call site.
 * Unit tests cannot see reachability; these assertions can.
 *
 * SCOPE, stated rather than implied:
 *   • Reads TEXT. It cannot tell whether the replayed blocks are correct — the
 *     unit tests in tests/lib/toolHistory.test.ts do that. It checks that the
 *     wire exists and that nothing downstream reads around it.
 *   • A rename breaks it. Intended: these names ARE the contract, and a rename
 *     should make someone read this comment.
 *   • It does NOT claim the medicine works on any given vessel. Measured
 *     effect so far: MiniMax 1/16 -> 10/10, Kimi 287K 0 -> 7 calls (Fuwafuwa).
 *     Claude api-key: UNMEASURED — Claude API is not used for tests in this
 *     house (cost), so that evidence has to come from a real turn.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const ROUTE = path.join(process.cwd(), 'src', 'app', 'api', 'chat', 'route.ts');
const CHAT_AREA = path.join(process.cwd(), 'src', 'components', 'ChatArea.tsx');
const route = fs.readFileSync(ROUTE, 'utf-8');
const chatArea = fs.readFileSync(CHAT_AREA, 'utf-8');

describe('source — the tool-history replay is reachable where it is offered', () => {
  it('the Claude api-key path sends the REPLAYED array, not the raw one', () => {
    // The whole defect this pins: `let currentMessages = [...cachedMessages]`
    // silently bypasses the replay, because line ~6036 rebuilds the request as
    // `{ ...claudeParams, messages: currentMessages }` — claudeParams.messages
    // is overwritten on every iteration and never reaches the API.
    assert.match(
      route,
      /let currentMessages = \[\.\.\.claudeHistory\]/,
      'currentMessages must be seeded from claudeHistory (the replayed form). '
      + 'Seeding it from cachedMessages makes the replay dead code.',
    );
    assert.doesNotMatch(
      route,
      /let currentMessages = \[\.\.\.cachedMessages\]/,
      'cachedMessages is the pre-replay array — reading it here reintroduces '
      + 'the 2026-11-08 dead-code path.',
    );
  });

  it('the replay runs AFTER this turn\'s tools are final', () => {
    // buildAnthropicToolReplay drops any call whose name is absent from the
    // tools array it is handed. Running it before `claudeParams.tools` is set
    // would filter every call away and return null — a silent no-op.
    const toolsAssigned = route.indexOf('if (claudeTools.length) claudeParams.tools = claudeTools;');
    const historyBuilt = route.indexOf('const claudeHistory');
    assert.ok(toolsAssigned > 0, 'claudeTools assignment not found — rename?');
    assert.ok(historyBuilt > 0, 'claudeHistory not found — rename?');
    assert.ok(
      historyBuilt > toolsAssigned,
      'claudeHistory must be built after claudeParams.tools is assigned, '
      + 'otherwise knownToolNames is empty and every call is filtered out.',
    );
  });

  it('every surface wired in the route can also be switched on in the UI', () => {
    // The 2026-11-07 bug verbatim: the route consumed toolHistoryEnabled for
    // Kimi/MiMo while the checkbox had no branch for them, so the flag was
    // permanently false. Claude is listed with its auth mode because only the
    // api-key path has a content-block slot for a tool_use; the OAuth path
    // sends prior turns as one text preamble.
    for (const name of ['Kimi', 'MiMo']) {
      assert.ok(
        chatArea.includes(`localAiName === '${name}'`),
        `${name} runs the Anthropic replay in the route but has no branch in `
        + 'the toolHistory checkbox gate — it could never be enabled.',
      );
    }
    assert.ok(
      chatArea.includes("(localAiName === 'Claude' && claudeAuthMode === 'api-key')"),
      'The Claude api-key path carries the replay, so its checkbox must be '
      + 'reachable — and ONLY for api-key, since OAuth has no slot for it.',
    );
  });

  it('the OAuth path is not wired to a replay it cannot carry', () => {
    // Negative control with a real failure mode: if someone passes
    // toolHistoryEnabled into streamClaudeViaAgentSDK, it will typecheck and do
    // nothing, because that path serialises history into `historyText`. The
    // honest form is to leave it out, so the absence is visible.
    const sdkCallStart = route.indexOf('return streamClaudeViaAgentSDK({');
    assert.ok(sdkCallStart > 0, 'streamClaudeViaAgentSDK call site not found — rename?');
    const sdkCallArgs = route.slice(sdkCallStart, sdkCallStart + 2000);
    assert.doesNotMatch(
      sdkCallArgs,
      /toolHistoryEnabled/,
      'The OAuth path has no content-block slot for a tool_use; passing the '
      + 'flag there would be a setting that silently does nothing.',
    );
  });
});
