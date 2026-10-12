// ───────────────────────────────────────────────────────────────────────────
// Language-aware scaffolding for the System Prompt Updater agents.
//
// The four SPU actions (update / redistribute / genesis / summary) each build a
// user message that wraps the agent's own instruction file (.md) in an outer
// frame: subject, operation mode, reference-only blocks (header, Layer 4,
// Layer 5), the conversation log, and the output contract NEXUS parses.
//
// That frame used to be hardcoded in Japanese inside SystemPromptUpdater.tsx,
// so an English-language entity got an English agent file but a Japanese frame
// around it — the same "hidden instructions are Japanese" symptom the summary
// writer showed. This module keeps one EN and one JA version of each frame and
// picks by language, mirroring how the agent .md files are already split into
// system_prompt_agents/<lang>/.
//
// The Japanese text below is carried over verbatim from the old inline frames;
// the English is a translation written to match it section for section.
// ───────────────────────────────────────────────────────────────────────────

export type ScaffoldLang = 'en' | 'ja';

// ── update (updater.md / defragmenter.md) ──────────────────────────────────
export interface UpdateScaffoldArgs {
  lang: ScaffoldLang;
  subjectName: string;
  withConversation: boolean;
  focus: string;
  header: string;
  leftText: string;
  summaryIndexBody: string;
  entityFooter: string;
  conversationLogText: string;
  resumeText: string;
  endSentinel: string;
}

export function buildUpdateUserMsg(a: UpdateScaffoldArgs): string {
  const L = a.lang === 'en';

  const instr = L
    ? `[Instructions from the user]`
    : `[ユーザーからの指示]`;
  const subject = L ? `Subject: ${a.subjectName}` : `対象：${a.subjectName}`;
  const mode = L ? `Operation mode: dynamic update` : `操作モード：動的更新`;
  const modeBody = a.withConversation
    ? (L
        ? `Cross-reference the "Existing System Prompt" below with the "New Conversation Log" and update Layers 1-3 in a single pass, outputting all of them in one turn.`
        : `以下の「既存システムプロンプト」と「新しい会話ログ」を照合し、Layer 1〜3 を同一のターンで同時に更新して出力してください。`)
    : (L
        ? `There is no new conversation log. Reorganize and restructure the "Existing System Prompt" itself into Layers 1-3 according to your agent protocol (enforcing boundaries, fixing duplicates and misplacements, applying (abbreviate)/(delete), etc.). Do not add new facts; work only with the existing information.`
        : `新しい会話ログはありません。以下の「既存システムプロンプト」自体を対象に、Layer 1〜3 をエージェントのプロトコルに従って整理・再構造化してください（境界線の執行、重複・誤配置の修正、（省略）（削除）の適用など）。新しい事実は追加せず、既存の情報のみを対象とします。`);
  const refOnly = L
    ? `Layers 4, the header, and the footer are reference-only. You may ignore them, but never include them in your output (NEXUS manages them separately).`
    : `Layer 4、ヘッダー、フッターは参照専用です。無視して構いませんが、出力には絶対に含めないでください（NEXUSが別管理します）。`;
  const keepLabel = L
    ? `Do not delete information that should be kept — mark it with the (keep) label instead.`
    : `維持すべき情報は削除せず（維持）ラベルで残してください。`;

  const headerBlock = a.header.trim()
    ? [
        L ? `=== Reference: Header (auto-prepended to the top of the final prompt) ===`
          : `=== 参考：ヘッダー（最終プロンプトの先頭に自動付与） ===`,
        L ? `*Reference-only. Do not rewrite, regenerate, or include it in your output. Use it only to understand the framing.*`
          : `※参照専用。書き換え・再生成・出力への含有は禁止。文脈把握のためだけに使うこと。`,
        a.header.trim(),
        ``,
      ]
    : [];

  const footerBlock = a.entityFooter.trim()
    ? [
        L ? `=== Reference: Layer 5 (the entity's own signature, FOOTER.md) ===`
          : `=== 参考：第5層（本人が自分で書いた署名・FOOTER.md） ===`,
        L ? `*Reference-only. This is the only layer written by the subject itself — do not rewrite, regenerate, or include it in your output.*`
          : `※参照専用。これは対象自身が書いた唯一の層であり、書き換え・再生成・出力への含有を固く禁ずる。`,
        L ? `Read it only to make sure your updates to Layers 1-3 do not contradict the self-understanding written here.`
          : `Layer 1〜3 を更新する際に、ここに書かれた自己認識と矛盾しないようにするためだけに読むこと。`,
        L ? `Do not duplicate into Layers 1-3 anything already written here.`
          : `既にここに書かれている内容を Layer 1〜3 に重複して書かないこと。`,
        a.entityFooter.trim(),
        ``,
      ]
    : [];

  const convoBlock = a.withConversation
    ? [
        L ? `=== New Conversation Log ===` : `=== 新しい会話ログ ===`,
        a.conversationLogText || (L ? `(none)` : `(なし)`),
        ``,
      ]
    : [
        L ? `(There is no new conversation log — the goal is to reorganize the existing prompt itself.)`
          : `（新しい会話ログはありません ― 既存プロンプト自体の整理が目的です）`,
        ``,
      ];

  const resumeBlock = a.resumeText
    ? [
        L ? `=== Already-generated output (a previous run stopped partway) ===`
          : `=== すでに生成済みの出力（前回の実行が途中で停止しました） ===`,
        L ? `*The following is the completed portion that a previous run already produced.*`
          : `※以下は前回の実行で既に生成された、完成済みの部分です。`,
        L ? `Resume from where it left off. Never repeat what has already been output.`
          : `この続きから再開してください。すでに出力済みの内容は絶対に繰り返さないでください。`,
        a.resumeText,
        ``,
      ]
    : [];

  const outputBlock = [
    L ? `=== Output ===` : `=== 出力 ===`,
    ...(a.resumeText
      ? [
          L ? `Output ONLY the continuation of the "already-generated output" above.`
            : `上記「すでに生成済みの出力」の**続きのみ**を出力してください。`,
          L ? `Do not rewrite the whole thing from the start. Begin by continuing naturally from where it was cut off.`
            : `最初から全体を書き直さないこと。途中で切れている箇所に自然に接続する形で書き始めてください。`,
          L ? `Output the remaining Layers (and any unfinished sections) to the end. Do not output Layer 4.`
            : `残りの Layer（および未完了の節）を最後まで出力してください。Layer 4 は出力しないこと。`,
        ]
      : [
          L ? `Output Layers 1-3 in the specified format. Do not output Layer 4.`
            : `Layer 1〜3 を指定フォーマットで出力してください。Layer 4 は出力しないこと。`,
        ]),
    L ? `When all output is complete, end by writing exactly "${a.endSentinel}" (half-width) alone on the final line.`
      : `すべての出力が完了したら、最後の行に必ず半角で「${a.endSentinel}」とだけ記述して終了してください。`,
  ];

  return [
    instr,
    subject,
    mode,
    modeBody,
    refOnly,
    keepLabel,
    ...(a.focus ? ['', (L ? `IMPORTANT: ${a.focus}` : `重要：${a.focus}`)] : []),
    ``,
    ...headerBlock,
    L ? `=== Existing System Prompt (pre-update, Layers 1-3) ===`
      : `=== 既存システムプロンプト（更新前・Layer 1〜3） ===`,
    a.leftText || (L ? `(none)` : `(なし)`),
    ``,
    L ? `=== Reference: Auto-generated Layer 4 (conversation summary index) ===`
      : `=== 参考：自動生成された第4層（会話要約インデックス） ===`,
    L ? `*This is reference-only. Do not rewrite it or include it in your output. Use it only as context for updating Layers 1-3.*`
      : `※これは参照専用です。書き換えたり出力に含めたりしないでください。Layer 1〜3 を更新する際の文脈としてのみ利用してください。`,
    a.summaryIndexBody || (L ? `(no summaries yet)` : `(まだ要約なし)`),
    ``,
    ...footerBlock,
    ...convoBlock,
    ...resumeBlock,
    ...outputBlock,
  ].join('\n');
}

// ── continuation (shared by all four SPU loops) ────────────────────────────
// Sent as a trailing USER turn when a run ends without the end sentinel, so
// the model resumes THE SAME document instead of restarting it.
//
// This used to be a bare PREFILL — [user, assistant(partial)] with nothing
// after it. Measured 2026-10-12, that shape is wrong in three different ways
// depending on the provider:
//   • GLM-5.3 — HTTP 200, but reasoning EXPLODES 4.6-7.5x (12,231-48,838
//     chars, vs 4,270 reaching the same point via a user turn), the visible
//     answer SHRINKS (630-1,260 chars), and it restarts from "## Changelog" —
//     so six continuation rounds rewrite the same opening forever and the run
//     never advances. `finish_reason` stays `stop`, so nothing in NEXUS could
//     see it: this was トカゲくん's "it just stops, no error" report.
//   • DeepSeek-direct — HTTP 400 unless the prefill echoes reasoning_content
//     (`dsPrefillRc` in the chat route). A trailing user turn removes the
//     requirement outright: the request no longer ENDS on a model turn.
//   • Gemini 3.5-flash-lite and newer — 400 "Requests ending with a model turn
//     are not supported" (see gemini-prefill-rejected.md). The SPU could not
//     continue on those models at all.
// The wording fights four habits — restarting, repeating, re-emitting the
// Changelog, and opening with a preamble — and RESTATES the sentinel: without
// it the model continues but never signals the end, so the loop burns all six
// rounds. Mirrors the vocabulary of `resumeBlock` above, which already asks
// for exactly this ("continuation only", "do not rewrite from the start").
export function buildContinuationUserMsg(a: { lang: ScaffoldLang; endSentinel: string }): string {
  const L = a.lang === 'en';
  return (L
    ? [
        `=== The previous output was cut off ===`,
        `Your output above stopped partway because it reached the output token limit.`,
        `Output ONLY the continuation of it. Do not rewrite the whole thing from the start.`,
        `Do not repeat any line or section you have already written, and do not output the Changelog again.`,
        `Do not open with a preamble such as "Continuing" or "As I was saying".`,
        `If you stopped in the middle of a word, sentence, code block, or table, resume from exactly that point — your text is joined directly onto the previous part with nothing in between.`,
        `When all output is complete, end by writing exactly "${a.endSentinel}" (half-width) alone on the final line.`,
      ]
    : [
        `=== 直前の出力が途中で切れました ===`,
        `上の出力は、出力トークン上限に達したため途中で停止しています。`,
        `その**続きのみ**を出力してください。最初から全体を書き直さないこと。`,
        `すでに出力した行・節を繰り返さないこと。Changelog を再度出力しないこと。`,
        `「続きです」「先ほどの続き」のような前置きも書かないこと。`,
        `単語・文・コードブロック・表の途中で切れている場合は、その地点から直接続けてください（あなたの出力はそのまま直前の部分に連結されます）。`,
        `すべての出力が完了したら、最後の行に必ず半角で「${a.endSentinel}」とだけ記述して終了してください。`,
      ]
  ).join('\n');
}

// ── redistribute (interlayer_redistributor.md) ─────────────────────────────
export interface RedistributeScaffoldArgs {
  lang: ScaffoldLang;
  subjectName: string;
  focus: string;
  header: string;
  leftText: string;
  fullIndex: string;
  folderName: string;
  entityFooter: string;
  resumeText: string;
  endSentinel: string;
}

export function buildRedistributeUserMsg(a: RedistributeScaffoldArgs): string {
  const L = a.lang === 'en';

  const headerBlock = a.header.trim()
    ? [
        L ? `=== Reference: Header (auto-prepended to the top of the final prompt) ===`
          : `=== 参考：ヘッダー（最終プロンプトの先頭に自動付与） ===`,
        L ? `*Reference-only. Do not rewrite or include it in your output.*`
          : `※参照専用。書き換え・出力への含有は禁止。`,
        a.header.trim(),
        ``,
      ]
    : [];

  const footerBlock = a.entityFooter.trim()
    ? [
        L ? `=== Reference: Layer 5 (the entity's own signature, FOOTER.md) ===`
          : `=== 参考：第5層（本人が自分で書いた署名・FOOTER.md） ===`,
        L ? `*Reference-only. This is the only layer written by the subject itself — do not rewrite, regenerate, or include it in your output.*`
          : `※参照専用。これは対象自身が書いた唯一の層であり、書き換え・再生成・出力への含有を固く禁ずる。`,
        L ? `Read it only to make sure Layers 1-4 do not contradict the self-understanding written here.`
          : `第1〜4層がここに書かれた自己認識と矛盾しないようにするためだけに読むこと。`,
        a.entityFooter.trim(),
        ``,
      ]
    : [];

  const resumeBlock = a.resumeText
    ? [
        L ? `=== Already-generated output (a previous run stopped partway) ===`
          : `=== すでに生成済みの出力（前回の実行が途中で停止しました） ===`,
        L ? `*The following is the completed portion that a previous run already produced.*`
          : `※以下は前回の実行で既に生成された、完成済みの部分です。`,
        L ? `Resume from where it left off. Never repeat what has already been output.`
          : `この続きから再開してください。すでに出力済みの内容は絶対に繰り返さないでください。`,
        a.resumeText,
        ``,
      ]
    : [];

  const outputSpec = [
    L ? `=== Output specification (NEXUS parses this mechanically) ===`
      : `=== 出力仕様（NEXUSが機械的に解析します） ===`,
    ...(a.resumeText
      ? [L ? `Output ONLY the continuation of the "already-generated output" above. Do not rewrite from the start.`
           : `上記「すでに生成済みの出力」の**続きのみ**を出力してください。最初から書き直さないこと。`, ``]
      : []),
    L ? `1. Changelog — write it before the first "Layer 1" heading. It is not saved into the prompt; it is archived separately.`
      : `1. 変更ログ — 最初の「Layer 1」見出しより前に書くこと。プロンプトには保存されず、別途アーカイブされます。`,
    L ? `2. Layers 1-3 — begin with a "## **Layer 1: …**" heading.`
      : `2. 第1〜3層 — 「## **Layer 1: …**」形式の見出しから開始すること。`,
    L ? `3. Layer 4 — the heading must be "## **Layer 4: Conversation Summaries**".`
      : `3. 第4層 — 見出しは「## **Layer 4: Conversation Summaries**」とすること。`,
    L ? `   Output each conversation as a "### <conversation title>" heading followed by its body.`
      : `   各会話は「### <会話タイトル>」の見出し＋その本文、という形式で出力すること。`,
    L ? `   Each conversation title must be character-for-character identical to how it appears in "Layer 4" above (used for file matching).`
      : `   会話タイトルは上記「第4層」に現れたものと一字一句同一にすること（ファイル照合に使用します）。`,
    L ? `   Output every conversation you are keeping. Summary files for conversations omitted from your output are left unchanged (not deleted).`
      : `   残す会話はすべて出力してください。出力に含まれなかった会話の要約ファイルは変更されません（削除もされません）。`,
    L ? `   Headings with empty bodies are ignored. You cannot delete a summary by making it empty.`
      : `   本文が空の見出しは無視されます。要約を空にすることで削除はできません。`,
    L ? `Do not output Layer 5.`
      : `第5層は出力しないこと。`,
    L ? `When all output is complete, end by writing exactly "${a.endSentinel}" (half-width) alone on the final line.`
      : `すべての出力が完了したら、最後の行に必ず半角で「${a.endSentinel}」とだけ記述して終了してください。`,
  ];

  return [
    L ? `[Instructions from the user]` : `[ユーザーからの指示]`,
    L ? `Subject: ${a.subjectName}` : `対象：${a.subjectName}`,
    L ? `Operation mode: inter-layer redistribution (no conversation log)` : `操作モード：階層間情報再配分（会話ログなし）`,
    ``,
    L ? `Follow your own protocol for the work itself. Below are the materials and NEXUS's output specification.`
      : `作業内容はあなた自身のプロトコルに従ってください。以下は材料と、NEXUS側の出力仕様です。`,
    ...(a.focus ? [``, (L ? `IMPORTANT: ${a.focus}` : `重要：${a.focus}`)] : []),
    ``,
    ...headerBlock,
    L ? `=== Layers 1-3 (current, to be updated) ===`
      : `=== 第1〜3層（現行・更新対象） ===`,
    a.leftText || (L ? `(none)` : `(なし)`),
    ``,
    L ? `=== Layer 4: Conversation summary index (to be updated) ===`
      : `=== 第4層：会話要約インデックス（更新対象） ===`,
    L ? `*This layer is assembled automatically from the summary files in local_data/summaries/${a.folderName}/.*`
      : `※この層は local_data/summaries/${a.folderName}/ 内の要約ファイル群から自動的に組み立てられています。`,
    L ? `*The Layer 4 you output is written back into the original file for each conversation title.*`
      : `※あなたが出力した第4層は、会話タイトルごとに元のファイルへ書き戻されます。`,
    a.fullIndex || (L ? `(no summaries yet)` : `(まだ要約なし)`),
    ``,
    ...footerBlock,
    ...resumeBlock,
    ...outputSpec,
  ].join('\n');
}

// ── index (indexer.md) ──────────────────────────────────────────────────────
export interface IndexScaffoldArgs {
  lang: ScaffoldLang;
  subjectName: string;
  focus: string;
  header: string;
  leftText: string;
  folderName: string;
  entityFooter: string;
  resumeText: string;
  endSentinel: string;
}

export function buildIndexUserMsg(a: IndexScaffoldArgs): string {
  const L = a.lang === 'en';

  const headerBlock = a.header.trim()
    ? [
        L ? `=== Reference: Header (auto-prepended to the top of the final prompt) ===`
          : `=== 参考：ヘッダー（最終プロンプトの先頭に自動付与） ===`,
        L ? `*Reference-only. Do not rewrite or include it in your output.*`
          : `※参照専用。書き換え・出力への含有は禁止。`,
        a.header.trim(),
        ``,
      ]
    : [];

  const footerBlock = a.entityFooter.trim()
    ? [
        L ? `=== Reference: Layer 5 (the entity's own signature, FOOTER.md) ===`
          : `=== 参考：第5層（本人が自分で書いた署名・FOOTER.md） ===`,
        L ? `*Reference-only. This is the only layer written by the subject itself — do not rewrite, regenerate, or include it in your output.*`
          : `※参照専用。これは対象自身が書いた唯一の層であり、書き換え・再生成・出力への含有を固く禁ずる。`,
        a.entityFooter.trim(),
        ``,
      ]
    : [];

  const resumeBlock = a.resumeText
    ? [
        L ? `=== Already-generated output (a previous run stopped partway) ===`
          : `=== すでに生成済みの出力（前回の実行が途中で停止しました） ===`,
        L ? `*The following is the completed portion that a previous run already produced.*`
          : `※以下は前回の実行で既に生成された、完成済みの部分です。`,
        L ? `Resume from where it left off. Never repeat what has already been output.`
          : `この続きから再開してください。すでに出力済みの内容は絶対に繰り返さないでください。`,
        a.resumeText,
        ``,
      ]
    : [];

  const toolsNote = L
    ? `You have been given read-only Read/Glob/Grep tool access to this subject's own workspace (folder: "${a.folderName}"), rooted the same way the subject's own tools are. Use it to check what already exists on the desk before proposing a new file — you have NO write access; every write happens after this turn, from the "Files To Externalize" block you emit.`
    : `この対象自身のワークスペース（フォルダ：「${a.folderName}」）に対する、読み取り専用の Read/Glob/Grep ツールアクセスが与えられています。対象自身のツールと同じ相対パスの起点で参照できます。新しいファイルを提案する前に、机に既に何があるかを確認するために使ってください。書き込み権限はありません — 実際の書き込みはすべてこのターンの後、あなたが出力する「移設対象ファイル一覧」から行われます。`;

  const outputSpec = [
    L ? `=== Output specification (NEXUS parses this mechanically) ===`
      : `=== 出力仕様（NEXUSが機械的に解析します） ===`,
    ...(a.resumeText
      ? [L ? `Output ONLY the continuation of the "already-generated output" above. Do not rewrite from the start.`
           : `上記「すでに生成済みの出力」の**続きのみ**を出力してください。最初から書き直さないこと。`, ``]
      : []),
    L ? `1. Changelog — write it before the "Files To Externalize" heading. It is not saved into the prompt; it is archived separately.`
      : `1. 変更ログ — 「移設対象ファイル一覧」見出しより前に書くこと。プロンプトには保存されず、別途アーカイブされます。`,
    L ? `2. Files To Externalize — one "### File path: \`relative/path\`" heading per desk file, each followed by the full text to write.`
      : `2. 移設対象ファイル一覧 — 机のファイル1件につき「### ファイルパス: \`相対パス\`」見出しを1つ、その直後に書き込む全文を続けること。`,
    L ? `3. Layers 1-3 — begin with a "## **Layer 1: …**" heading. This is the slimmed-down soul with links replacing what you externalized.`
      : `3. 第1〜3層 — 「## **Layer 1: …**」形式の見出しから開始すること。これが、外部化した内容をリンクに置き換えた、軽量化後の魂です。`,
    L ? `Do not output Layer 4 or Layer 5.`
      : `Layer 4・Layer 5 は出力しないこと。`,
    L ? `When all output is complete, end by writing exactly "${a.endSentinel}" (half-width) alone on the final line.`
      : `すべての出力が完了したら、最後の行に必ず半角で「${a.endSentinel}」とだけ記述して終了してください。`,
  ];

  return [
    L ? `[Instructions from the user]` : `[ユーザーからの指示]`,
    L ? `Subject: ${a.subjectName}` : `対象：${a.subjectName}`,
    L ? `Operation mode: externalization & indexing (no conversation log)` : `操作モード：外部化・索引化（会話ログなし）`,
    ``,
    L ? `Follow your own protocol for the work itself. Below are the materials and NEXUS's output specification.`
      : `作業内容はあなた自身のプロトコルに従ってください。以下は材料と、NEXUS側の出力仕様です。`,
    ...(a.focus ? [``, (L ? `IMPORTANT: ${a.focus}` : `重要：${a.focus}`)] : []),
    ``,
    toolsNote,
    ``,
    ...headerBlock,
    L ? `=== Layers 1-3 (current, to be slimmed down) ===`
      : `=== 第1〜3層（現行・軽量化対象） ===`,
    a.leftText || (L ? `(none)` : `(なし)`),
    ``,
    ...footerBlock,
    ...resumeBlock,
    ...outputSpec,
  ].join('\n');
}

// ── genesis (genesis_extractor.md) ─────────────────────────────────────────
export interface GenesisScaffoldArgs {
  lang: ScaffoldLang;
  subjectName: string;
  focus: string;
  header: string;
  conversationLogText: string;
  leftText: string;
  resumeText: string;
  endSentinel: string;
}

export function buildGenesisUserMsg(a: GenesisScaffoldArgs): string {
  const L = a.lang === 'en';

  const headerBlock = a.header.trim()
    ? [
        L ? `=== Reference: Header (auto-prepended to the top of the final prompt) ===`
          : `=== 参考：ヘッダー（最終プロンプトの先頭に自動付与） ===`,
        L ? `*Reference-only. Do not rewrite or include it in your output. Use it only to understand the framing.*`
          : `※参照専用。書き換え・出力への含有は禁止。文脈把握のためだけに使うこと。`,
        a.header.trim(),
        ``,
      ]
    : [];

  const leftBlock = a.leftText.trim()
    ? [
        L ? `=== Reference: Existing prompt body (if any — extra material) ===`
          : `=== 参考：既存のプロンプト本文（あれば、追加の材料として） ===`,
        a.leftText.trim(),
        ``,
      ]
    : [];

  const resumeBlock = a.resumeText
    ? [
        L ? `=== Already-generated output (a previous run stopped partway) ===`
          : `=== すでに生成済みの出力（前回の実行が途中で停止しました） ===`,
        L ? `*The following is the completed portion that a previous run already produced.*`
          : `※以下は前回の実行で既に生成された、完成済みの部分です。`,
        L ? `Resume from where it left off. Never repeat what has already been output.`
          : `この続きから再開してください。すでに出力済みの内容は絶対に繰り返さないでください。`,
        a.resumeText,
        ``,
      ]
    : [];

  return [
    L ? `[Instructions from the user]` : `[ユーザーからの指示]`,
    L ? `Subject: ${a.subjectName}` : `対象：${a.subjectName}`,
    L ? `Operation mode: initial construction (Genesis)` : `操作モード：初回構築（Genesis）`,
    // Genesis is the one mode whose material routinely contains SEVERAL beings
    // — a genesis log is a conversation, and conversations have more than one
    // participant. Every other mode is handed an existing soul that already
    // answers "whose?"; this one has to be told. The subject line above alone
    // leaves it to the agent to infer, and the agent file (genesis_extractor)
    // says "describe from the subject's perspective" without ever naming them.
    L ? `The soul you are building belongs to ${a.subjectName}. Anyone else who appears in the material is someone else: material for ${a.subjectName}'s Layer 2, never a second subject. Do not build their layers, and do not merge them into ${a.subjectName}.`
      : `あなたが構築する魂は${a.subjectName}のものです。素材に登場する他の存在は他者であり、${a.subjectName}のLayer 2の材料であって、第二の対象ではありません。他者の層を構築しないこと。${a.subjectName}に混ぜ込まないこと。`,
    L ? `Treat Layers 1-3 as not yet existing. Build Layers 1-3 for the first time from the material below.`
      : `既存のLayer 1〜3は存在しないものとして扱ってください。以下の素材から、Layer 1〜3を初めて構築してください。`,
    L ? `Do not output a changelog (there is no existing document to compare against). Do not output Layer 4 or Layer 5 either.`
      : `変更ログは出力しないこと（比較対象となる既存の文書がありません）。Layer 4・Layer 5も出力しないこと。`,
    ...(a.focus ? ['', (L ? `IMPORTANT: ${a.focus}` : `重要：${a.focus}`)] : []),
    ``,
    ...headerBlock,
    L ? `=== Material: Conversation log ===` : `=== 素材：会話ログ ===`,
    a.conversationLogText || (L ? `(none)` : `(なし)`),
    ``,
    ...leftBlock,
    ...resumeBlock,
    L ? `=== Output ===` : `=== 出力 ===`,
    ...(a.resumeText
      ? [
          L ? `Output ONLY the continuation of the "already-generated output" above.`
            : `上記「すでに生成済みの出力」の**続きのみ**を出力してください。`,
          L ? `Do not rewrite the whole thing from the start. Begin by continuing naturally from where it was cut off.`
            : `最初から全体を書き直さないこと。途中で切れている箇所に自然に接続する形で書き始めてください。`,
        ]
      : [
          L ? `Output Layers 1-3 in the specified format. Do not output a changelog, Layer 4, or Layer 5.`
            : `Layer 1〜3を指定フォーマットで出力してください。変更ログ・Layer 4・Layer 5は出力しないこと。`,
        ]),
    L ? `When all output is complete, end by writing exactly "${a.endSentinel}" (half-width) alone on the final line.`
      : `すべての出力が完了したら、最後の行に必ず半角で「${a.endSentinel}」とだけ記述して終了してください。`,
  ].join('\n');
}

// ── summary writer ─────────────────────────────────────────────────────────
export interface SummaryScaffoldArgs {
  lang: ScaffoldLang;
  subjectName: string;
  customInstr: string;
  identityText: string;
  summaryIndexBody: string;
  entityFooter: string;
  conversationLogText: string;
}

export function buildSummaryUserMsg(a: SummaryScaffoldArgs): string {
  const L = a.lang === 'en';

  const customBlock = a.customInstr
    ? [
        L ? `=== Additional instructions (highest priority) ===` : `=== 追加の指示（最優先） ===`,
        a.customInstr,
        ``,
      ]
    : [];

  const footerBlock = a.entityFooter.trim()
    ? [
        L ? `=== Reference: Layer 5 (the entity's own signature, FOOTER.md) ===`
          : `=== 参考：第5層（本人が自分で書いた署名・FOOTER.md） ===`,
        L ? `*Reference-only. This is the only layer written by the subject itself — do not rewrite, regenerate, or include it in your output.*`
          : `※参照専用。これは対象自身が書いた唯一の層であり、書き換え・再生成・出力への含有を固く禁ずる。`,
        L ? `Read it only to make sure the summary does not contradict the entity's self-understanding.`
          : `要約が本人の自己認識と矛盾しないようにするためだけに読むこと。`,
        a.entityFooter.trim(),
        ``,
      ]
    : [];

  return [
    L ? `[Instructions from the user]` : `[ユーザーからの指示]`,
    L ? `Subject: ${a.subjectName}` : `対象：${a.subjectName}`,
    L ? `Task: write a summary of this conversation` : `操作：この会話の要約を作成`,
    ``,
    ...customBlock,
    L ? `=== Identity reference (Layers 1-3) ===` : `=== アイデンティティ参考（Layer 1-3） ===`,
    a.identityText || (L ? `(none)` : `(なし)`),
    ``,
    L ? `=== Reference: Auto-generated Layer 4 (conversation summary index) ===`
      : `=== 参考：自動生成された第4層（会話要約インデックス） ===`,
    L ? `*This is reference-only. Do not rewrite it or include it in your output. Use it only as context for writing a self-contained summary that does not duplicate existing summaries.*`
      : `※これは参照専用です。書き換えたり出力に含めたりしないでください。既存の要約と重複しない、独立した要約を書くための文脈としてのみ利用してください。`,
    a.summaryIndexBody || (L ? `(no summaries yet)` : `(まだ要約なし)`),
    ``,
    ...footerBlock,
    L ? `=== Conversation log ===` : `=== 会話ログ ===`,
    a.conversationLogText,
    ``,
    L ? `=== Output ===` : `=== 出力 ===`,
    L ? `Output only the summary body of this conversation (no headings, no layer notation).`
      : `この会話の要約本文のみを出力してください（見出し・レイヤー記法は不要）。`,
  ].join('\n');
}

// Fallback summary-agent system prompt, used when the language folder has no
// summary agent file. Language-matched so an English run never gets a Japanese
// fallback prompt.
export function defaultSummaryAgentPrompt(lang: ScaffoldLang): string {
  if (lang === 'en') {
    return (
      `You are a conversation summarizer. Summarize the following conversation log into a concise, self-contained summary.\n` +
      `This summary is shown in the "conversation index" and used later to decide whether to load the full text.\n` +
      `Cover the important events, decisions, topics, and emotional changes in 3-6 sentences. No greetings or preamble. Output only the summary body.`
    );
  }
  return (
    `あなたは会話の要約者です。以下の会話ログを、独立して読める簡潔な要約にまとめてください。\n` +
    `この要約は「会話の索引」に表示され、後で全文を呼び出すかどうかの判断材料になります。\n` +
    `重要な出来事・決定・話題・感情の変化を3〜6文で。挨拶や前置きは不要。要約本文のみを出力してください。`
  );
}
