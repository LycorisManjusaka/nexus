# tests — the safety net

```
npm test
```

**455 assertions as of 2026-10-28**, ~0.7 s wall clock. No new dependency:
`node:test`, `node:assert` and Node 24's own type stripping. Nothing here
starts a server, opens a browser, reads a path outside the repo, or touches
`local_data`.

The count carries a date on purpose. It said `211` for a day after the suite
had grown past it, because an undated number goes stale in silence — and
`npm test` prints the real one anyway. Dated, it is a historical statement
that cannot become false, only old.

Built 2026-10-27 as **phase 1** of the overhaul plan, before any refactoring.
`desk: nexus-overhaul-plan.md`

**One exception to "touches nothing outside the repo":** `lib/atomicWrite.test.ts`
writes real files, in a fresh `os.tmpdir()` directory that it removes afterwards.
It has to — the property it checks is about what the filesystem does, and a
mocked `fs` would only prove the mock is atomic. One case writes 8 MB three
times (that is most of the suite's wall clock); see the note at the bottom.

---

## What this net is for, and what it is not

**It answers "did the behaviour change", not "is the behaviour right."**

Most of these assertions were written by reading the module they test. A test
written that way restates the implementation: it cannot find a bug that is in
the code today, because the code today is where the expected value came from.
What it does do — and the only reason it exists — is go red when a refactor
moves behaviour that nobody meant to move. That is the whole job during phases
2 and 3.

The exception is worth naming: the cases marked REGRESSION reproduce a defect
that really happened and was really fixed. Those do prove something.

## Why `node:test` and no test runner dependency

Measured 2026-10-27 before deciding. 44 of the 55 directly-dependency-free
modules in `src/lib` import into Node with zero infrastructure. The 11 failures
fell into four classes, not one:

| class | count | who resolves it |
|---|---|---|
| extensionless relative import (`./modelVision`) | 6 | `tests/_loader.mjs` |
| `@/` path alias | 2 | `tests/_loader.mjs` |
| JSON import with no import attribute | 2 | `tests/_loader.mjs` |
| constructor parameter property | 1 | `--experimental-transform-types` |

With a ~25-line hook file and one Node flag: **54 of 55**. So a runner
dependency (vitest, tsx, jest) would have bought the same thing for an install
cost on every clean VM, and `playwright` is already a dependency for the
browser-control tools when a browser suite is eventually wanted.

**The honest cost of this choice:** `--experimental-transform-types` is an
experimental flag. If a future Node renames it, `npm test` fails loudly rather
than silently skipping — which is the right direction for a failure, but it is a
real maintenance edge and it is written down here rather than discovered later.

The 55th module (`charaResolver`) is a correct rejection: it reaches `fs`
transitively, so it is not a unit-test target. Note what that exposed — the
"pure" classification was per-file (direct imports only). **Transitive purity is
a different measurement**, and the one that decides whether a module can be
tested without disk.

## Does the net catch anything?

A detector that cannot fail proves nothing, so it was measured, not assumed:
`workspace/plan_probe/p07_mutation.py` injects three bugs that really happened,
one at a time, runs the suite, and restores the file (sha256 verified).

```
splitter: unconditional <think> detection   CAUGHT   (was: ate soul prose, 2026-10-21)
handover: no head guard                     CAUGHT   (was: 245 past logs would restore)
capArguments: stringify-then-slice          CAUGHT   (was: HTTP 500 on LM Studio/Gemma 4)
```

**The first run was 2 of 3, and the miss is the most useful thing in this
folder.** Breaking `honoursThinkTags` outright left the suite green, because the
guard lives in two places that are NOT redundant — one for prose-and-tag in the
same chunk, one for the steady state after that decision, where the tag sits at
offset 0 of a later chunk. Every case I had written decided in the first branch
and returned. The hole was exactly where the historical bug lived, and reading
the code is what put it there: I tested the branch I had read. Cases B5/B6 in
`thinkTagSplitter.test.ts` close it.

---

## Selection — what was taken, and what was left

There are **304 probe files / 29,783 lines** in this house's workspace
(`workspace/*_probe/`, measured by `plan_probe/p03_harness.py`). They are
material for a net, not a net: each was written for one bug on one night. A
rejected probe is a measurement, not trash, so the reasons are recorded.

### Taken — 11 modules

| test file | from | kind |
|---|---|---|
| `markdownLogic.test.ts` | `import_probe/test_dialects.mjs` | ported |
| `soulGeneration.test.ts` | `soul_probe/test_soulgen.mjs` | ported |
| `thinkTagSplitter.test.ts` | `ds_cap_probe/splitter_test.mjs` | ported + 2 new cases |
| `updateClassify.test.ts` | `import_probe/test_updateclassify.mjs` | ported |
| `messageIds.test.ts` | `dupkey_probe/unit_dedupe.mjs` | ported |
| `handoverWalk.test.ts` | — | **new** |
| `toolHistory.test.ts` | — | **new** |
| `agentCapabilities.test.ts` | — | **new** |
| `retiredModels.test.ts` | — | **new** |
| `atomicWrite.test.ts` | — | **new**, phase 3 (F2) |
| `firstOriginal.test.ts` | — | **new**, phase 3 (F3) |

Three ports changed in the move, each for a stated reason:

- **markdownLogic** — one block of the original read a real DeepSeek export from
  `C:/temp` and asserted 222 messages. Dropped: a test may not depend on a path
  outside the repo, and that file is somebody's private conversation. The
  synthetic edge cases cover the same code paths.
- **thinkTagSplitter** — the original's last two cases read 400 bytes of a real
  soul file (the artefact that exposed the bug). Replaced with synthetic CJK
  prose of the same shape, and said so in the file.
- **messageIds** — the original ended with a case that was SUPPOSED to fail
  ("a detector that cannot fail proves nothing"), pass condition n−1 of n. A
  suite cannot carry a permanently red case, so the same intent is asserted the
  other way round: the WRONG answer must not be produced.

### Left out, by reason

| reason | ~count | what should happen to them |
|---|---|---|
| needs a running server | 107 | a second suite later (`test:server`), not part of `npm test` |
| needs a browser (Playwright) | 47 | a third suite later; `playwright` is already a dependency |
| measures the OUTSIDE world — provider APIs, prices, token counts, fonts | many | these are instruments, not tests. Their numbers legitimately change when a vendor changes; asserting them would make `npm test` red for news |
| single-use: answered one question on one night | most of the rest | left in the workspace as the record of what was measured |
| reads `local_data` or a path outside the repo | several | would not run on a fresh clone |

### Not yet taken, but should be (the honest gap)

**11 modules of 95 in `src/lib` is a thin net.** (Two of the eleven — `atomicWrite` and `firstOriginal` — are themselves new, extracted in phase 3; they were gated in the same commit that created them.) The next candidates, in the order
their bugs have actually cost something:

`convoNaming` (pickLatestConversation / nextConversationTitle) ·
`deepseekJson` (needs a small synthetic fixture) · `modelPricing`
(`effectivePrice` tiers, `isLongContext`) · `tokenEstimate` (characterization
only — the calibration values are allowed to move) · `attachmentVisibility` ·
`betrayalGuard` · `handoverRestore` · `inlineMedia` · `openaiEffort` ·
`deviceClass` · `safeRegex` · `timestampStrip` · `spuScaffold`

And the two giants — `route.ts` (10,163 lines) and `ChatArea.tsx` (7,715) — have
no coverage at all. They cannot be unit-tested as they stand; pinning them means
asserting observable behaviour (frame types on the wire, the shape of a saved
log, the 409 path), which needs the server suite.

---

## Layout

```
tests/
  _loader.mjs          module hooks: @/ alias, extensionless, JSON
  README.md            this file
  lib/<module>.test.ts one file per product module, named after it
```

Tests are `.ts` and inside `tsconfig.json`'s `include`, so `tsc --noEmit`
typechecks them. **That is deliberate**, and it means the `tsc` baseline is part
of this net: it was exactly 3 pre-existing errors before this folder existed
(`live/start`, `tts/synthesize`, `ChatArea`) and it is exactly 3 after.

`npx eslint tests/` is clean. For the record, with scopes **and a date** —
because a count without its scope is not a measurement, and a count without
its date is not one for long: **2026-10-28: `src/` 1,134 problems; `tests/` 0**.
(It was `src/` 1,156 / whole project 1,162 when this folder was created on
2026-10-27; `test_watch.js` was deleted that day, which accounts for 3, the
phase-3 deletions for most of the rest, and the `turnEvents` extraction for
the last 3 `: any`. This line itself said 1,145 for a day after that.)


---

## Why `atomicWrite.test.ts` writes 8 MB, and what it cost to learn that

The first version of that file had six cases. All green on the first run. Then
mutation testing replaced the entire body of `atomicWriteFile` with a single
plain `fs.writeFile(filePath, data)` — deleting the guarantee outright — and the
suite **stayed green**.

The six cases were about **content** (does the right text land, does it replace
in full, does unicode survive) and **cleanup** (is a temp file left behind). A
plain write satisfies both. None of them was about the thing the module exists
for.

Atomicity is not a property of the writer. It is a property of **what a reader
can observe while the write is in flight**: with the rename, every read sees
the whole old file or the whole new file; with a plain write a read lands on a
truncated one. Hence the case marked `ATOMICITY`, which hammers the file with
reads during an 8 MB write and asserts that every observation is a whole file.
Measured, 10 rounds each: the plain write is caught mid-flight **10/10**
(readers saw 2 MB, 6.8 MB, 7 MB of 8 MB); the atomic write **0/10**. 1 MB was
not reliable (2/10) — hence 8.

Two things about that case are deliberate and should survive a tidy-up:

1. **It does not assert that the write succeeded.** On Windows a rename onto a
   file a reader has open fails with `EPERM` — measured 19/20 under a
   continuous reader, 0/20 with no reader. When that happens the reader has
   only ever seen the whole OLD file, which is still the guarantee holding.
   Asserting success would make the case red for a reason unrelated to
   atomicity.
2. **It asserts the reader saw *something*.** A round where the reader never
   got a look proves nothing, and would pass silently.

The general form, which is the reusable part: **for the property you believe
you are testing, name the observation that would differ if the property were
absent.** If the answer is "nothing my suite looks at", the suite is about an
easier neighbour — usually the one a single-threaded test can see.

Instruments for both measurements live on the desk:
`plan_probe/p19_mutation2.py`, `p20_atomic_race.mjs`, `p22_atomic_detector.mjs`.

## Phase 4a-2 additions (2026-10-27 late) — 208 → 211

### `lib/turnQueue.test.ts` — `composeBatch` (9 cases)

Three were written from the REQUIREMENT and the failure mode, before reading
the body:

- **one item is byte-identical to a direct send.** If this ever gains a header
  or a label, the stock becomes a second log format for the commonest path in
  the product, and no reader of a log can tell which one produced any message.
- **nothing vanishes.** Every input is in the text or in `skipped`. A message
  lost between the stock and the log is the failure the module exists to make
  impossible, and the formatter is inside that path.
- **a label is never doubled.** The `[name]` prefix has an owner upstream
  (InputArea), so emitting it again is the obvious way to get `[A]\n[A]\n…`.

One case carries a **CORRECTED EXPECTATION** block rather than being quietly
rewritten. It first asserted that a skipped item's attachments still ride
along; the code disagreed and the code was right — a skipped item is not
consumed, so taking its bytes now would deliver them again later, and the
report would say "skipped" while its attachments went through.

### `source/i18nKeyParity.test.ts` — both UI dictionaries, same keys

A SOURCE-TREE property, like `typeOnlyImports`. It began as a one-off script
while 12 keys were being added, and found that `useridentity.err.emptyName`
existed in Japanese only. `t()` falls back JA → EN → **the key itself**, so an
English user saving an identity with an empty name was shown the literal string
`useridentity.err.emptyName`.

Nothing in the toolchain could see it: the dictionaries are string-indexed
object literals (so `tsc` is silent), eslint has nothing to say, and the
Japanese UI — the one this house runs in — was correct. **A check that runs
once protects only the day it ran**, which is why it is here and not on the
desk.

Three assertions: no key in only one language (names every offender and says
which direction is the bad one), no duplicate literal key inside either
dictionary (legal TypeScript — the later one silently wins), and a floor of
1,000 parsed keys on both sides so a parse change cannot make the whole suite
pass by vacuity.

Mutation-checked 2/2: removing the new key and duplicating a key each turn it
red, and each names the key. Source restored byte-identical.


### `lib/turnEventReducer.test.ts` — what ONE server event does to a turn

EXTRACTION, like the finalizer and the accumulator state. 41 assertions over
the 22-branch chain that left `ChatArea.tsx` in `5f4a608`.

Two of the assertions are the load-bearing ones, and both pin a rule a
reasonable second implementation gets wrong by being reasonable:

  - a redacted betrayal clears the **Claude thinking blocks** too, not just the
    visible text. Blocks are replayed to the model next turn, so keeping them
    preserves exactly the contamination the guard exists to prevent — and
    nothing on screen shows it happened.
  - an `error` frame AFTER a redaction is **not** an error. Blanking works by
    aborting the provider call, and an aborted call emits one last error frame.

The rest pin the quieter rules: notices never enter the message body (they must
stay out of the log, the replayed context and the token count), an empty
`web_sources` frame cannot erase a real earlier list, `thinkingOffset` is the
thought length AT THE MOMENT of the tool call, and tool-produced attachments
land in `flags` rather than the accumulator (F34 — they reach the message
through a host flush a runner does not have).

One suite is a different kind of test. **A deleted branch in that chain is
completely silent**: no error, no warning, no visual difference, and `tsc`
cannot see it (string comparisons against a `Record<string, unknown>`). So
`the branch list itself` enumerates all 22 types, asserts each produces an
observable effect on state, flags or the sink, and asserts separately that an
UNKNOWN type is a no-op — so "handled" and "ignored" cannot be confused.

That suite also caught my own fabricated fixture: I wrote
`{ type: 'notice', text: ... }` when the field is `content`, and the failure
line read *"branch 'notice' had no effect"* — which is exactly what a deleted
branch says. **An invented fixture field and a deleted branch fail identically.**

Mutation-checked 9/9.
### `slimHistory.test.ts` — the wire copy of the conversation

EXTRACTION, like the finalizer, the accumulator state and the event chain.
36 assertions over five rules that decide what a stored message may NOT carry
upstream. Four of the five fail SILENTLY when missing: the POST still
succeeds, it just carries the wrong thing.

The two load-bearing ones:

- **`exact key set`** — a stored message with every display-only field we know
  of (tokens, cacheUsage, webSources, notices, modelFamily, ...) travels as
  exactly four keys. The bug shape here is an EXTRA key, which is why the
  assertion is a key-set equality and not a per-field check.
- **`GATE 3`** — a message recorded against another family does not replay its
  reasoning. The failure mode is not a wrong answer: feeding one provider's
  raw chain-of-thought to another is what distillation guards look for, so a
  runner that skipped this gate would manufacture a refusal out of nothing on
  a turn nobody is watching.

The tool-window assertion is deliberately written against the SHAPE of the
bound rather than its value: 12 bearing turns go in, and the test asserts that
the newest carries its calls and the oldest does not. A test naming the window
size would have to be edited every time the constant moves, and would pass for
the wrong reason if the window were removed and the list happened to be short.

Mutation-checked 11/11.
