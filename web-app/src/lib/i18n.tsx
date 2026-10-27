"use client";

// ───────────────────────────────────────────────────────────────────────────
// GUI string translation.
//
// This is NOT the same mechanism as src/lib/agentInstructions.ts's
// DEFAULT_AGENT_INSTRUCTIONS_JA — that dict is what an ENTITY reads (tool
// descriptions, letter notices, etc.) and is deliberately never
// auto-translated; this one is what a HUMAN reads in the Nexus interface
// itself, where translating is the whole point. They're both keyed off the
// same Preferences language selector, but they are separate dictionaries with
// separate coverage, because they translate different things for different
// readers.
//
// Usage in a component:
//
//     const t = useT();
//     <span>{t('settings.title')}</span>
//
// For help prose that needs inline styling, use <Tx k="..." /> instead: the
// string may contain `backticks` (rendered as <code>) and **bold** (rendered
// as <strong>), so one translatable string can carry its own formatting
// instead of being cut into six JSX fragments that a translator can't reorder.
//
// The language comes from a React context provided once at the NexusApp root,
// so no component needs `language` threaded through its props.
//
// Any key missing from UI_STRINGS_JA falls back to the English string, and a
// key missing from both falls back to the key itself — so partial coverage
// never renders a blank label.
// ───────────────────────────────────────────────────────────────────────────

import React, { createContext, useContext, useMemo } from 'react';

export type UiLanguage = 'en' | 'ja';

export const UI_STRINGS_EN: Record<string, string> = {
  // ── App shell ────────────────────────────────────────────────────────────
  'app.welcome.title': 'Welcome to NEXUS',
  'app.welcome.subtitle': 'Select or create a conversation to start',
  'app.welcome.newChat': 'New Chat',

  // ── Switch-away guard ────────────────────────────────────────────────────
  // Shown in a window.confirm() when the reader clicks another conversation
  // or being while a turn is in flight. {busy} is the same label the tab
  // title shows ("<Being> <action>" / "Saving" / "Updating the soul").
  'app.switch.busyConfirm':
    '{busy}.\n\nSwitching now will discard the work in progress — the reply being generated is only saved once it finishes.\n\nSwitch anyway?',
  // Same guard, for actions that MOVE you rather than being a switch: cloning,
  // importing, restoring a backup, creating/renaming/deleting an identity.
  // Worded as "continue" because the click was not "go there" — the jump is a
  // side effect the reader may not have expected.
  'app.action.busyConfirm':
    '{busy}.\n\nThis action leaves the current conversation, which will discard the work in progress — the reply being generated is only saved once it finishes.\n\nContinue anyway?',

  // ── User guide ───────────────────────────────────────────────────────────
  'guide.title': 'Nexus — User Guide',
  'guide.open': 'User guide',
  'guide.close': 'Close',

  // ── Preferences: chrome ──────────────────────────────────────────────────
  'settings.title': 'Preferences',
  'settings.build.title': 'Build of NEXUS running here (commit, branch, last update). Include this in any bug report.',
  'settings.update.button': 'Update',
  'settings.update.running': 'Updating…',
  'settings.update.title': 'Pull the newest NEXUS code into this install (git pull --ff-only). Does NOT restart anything.',
  'settings.update.confirm':
    'Update this install now?\n\n' +
    'Runs: git pull --ff-only\n\n' +
    'NEXUS is NOT restarted — the dev server picks up new code by itself. ' +
    'If a reply is being generated right now, let it finish first: the code can change underneath it.\n\n' +
    'Nothing is deleted and no dependencies are installed. If either is needed you will be told, not surprised.',
  'settings.update.upToDate': 'Already up to date — nothing changed.',
  'settings.update.done': 'Updated: {before} → {after} ({n} file(s) changed).',
  'settings.update.hotReload': 'No restart needed — the running server reloads changed code on its own.',
  'settings.update.nextConfig': 'next.config changed: Next.js restarts itself, so the page may reconnect in a moment.',
  'settings.update.lockfile':
    'Dependencies changed. Close NEXUS, run "npm ci" inside the web-app folder, then start it again. '
    + 'This is NOT done automatically: npm ci removes node_modules while the server is using them.',
  'settings.update.failed': 'Update failed — nothing was changed.',
  'settings.tab.keys': 'API Keys',
  'settings.tab.vrchat': 'VRChat & Audio',
  'settings.tab.identity': 'User Identity',
  'settings.tab.other': 'Other',
  'settings.cancel': 'Cancel',
  'settings.saveChanges': 'Save Changes',

  // ── Sign-in page ─────────────────────────────────────────────────────────
  'login.title': 'Sign in to NEXUS',
  'login.subtitle': 'This instance requires an administrator sign-in.',
  'login.username': 'Administrator name',
  'login.password': 'Password',
  'login.signIn': 'Sign in',
  'login.signingIn': 'Signing in…',
  'login.err.invalid': 'That name and password do not match.',
  'login.err.network': 'Could not reach the server. Is NEXUS still running?',
  'login.notConfigured':
    'No sign-in is configured on this instance, so there is nothing to sign in to — everything is already open.',
  'login.goHome': 'Open NEXUS',
  'login.broken':
    '`login.json` exists but cannot be read, so the door stays shut. Delete `local_data/login.json` on this machine to get back in, then set the sign-in up again.',
  'login.recovery':
    'Lost the password? Delete `local_data/login.json` on the machine running NEXUS. That removes the gate entirely — anyone who can reach the port is in again until you set a new one.',

  // ── Preferences → Sign-in ────────────────────────────────────────────────
  'settings.login.heading': 'Sign-in',
  'settings.login.intro':
    'Applies to this whole NEXUS instance, not to one conversation. By default there is no sign-in: anyone who can reach this port — on this machine, the LAN, or a VPN — can read every conversation, soul and key without a password.',
  'settings.login.require': 'Require a sign-in to open NEXUS',
  'settings.login.require.help':
    'Stores an administrator name and a password hash in `local_data/login.json`. While that file exists the gate is up; deleting it removes the gate. The password itself is never stored — only a scrypt hash of it, so the file cannot give the password back to anyone who reads it.',
  'settings.login.username': 'Administrator name',
  'settings.login.password': 'Password',
  'settings.login.confirm': 'Password again',
  'settings.login.save': 'Turn sign-in on',
  'settings.login.change': 'Change password',
  'settings.login.saving': 'Saving…',
  // No `{name}` placeholder here: `Tx`/`renderRich` render markup only and do
  // not substitute, so a placeholder would print literally. The name is
  // rendered as its own element by the component.
  'settings.login.enabledAs': 'Sign-in is on. Administrator:',
  'settings.login.enabled': 'Sign-in is on.',
  'settings.login.disable': 'Turn sign-in off',
  'settings.login.disable.confirm':
    'Turn the sign-in off? This deletes login.json, including the stored name and password hash — you will have to set them again. After this, anyone who can reach this port is in without a password.',
  'settings.login.change.confirm':
    'Change the password? Every browser currently signed in — including other devices — will be signed out.',
  'settings.login.err.tooShort': 'Use at least {n} characters.',
  'settings.login.err.mismatch': 'The two passwords do not match.',
  'settings.login.err.noUsername': 'Enter an administrator name.',
  'settings.login.err.failed': 'Could not save: {msg}',
  'settings.login.err.unauthorized':
    'This browser is no longer signed in. Reload the page and sign in again.',
  'settings.login.savedOn': 'Sign-in is on. This browser stays signed in.',
  'settings.login.savedOff': 'Sign-in is off.',
  'settings.login.broken':
    '`login.json` exists but cannot be read. The gate is shut and no password will open it — delete `local_data/login.json` and set the sign-in up again.',
  'settings.login.transport':
    'What this does NOT protect: NEXUS is served over plain HTTP here, so the password crosses the network readable by anything on the path. Inside a LAN you trust, or a VPN, that is the boundary you already have. Exposed to the open internet it is not enough — that needs HTTPS in front.',
  'settings.login.scope':
    'What it does protect: every page and all 60 API endpoints. A request without a valid session gets 401 instead of data.',
  'settings.login.signOut': 'Sign out of this browser',

  // ── Preferences → API Keys ───────────────────────────────────────────────
  'settings.keys.heading': 'API Keys',
  'settings.keys.intro':
    'Keys are saved locally in the `local_data` folder and never sent anywhere except the official APIs.',
  'settings.keys.linkNote':
    'Each link opens that provider\'s API-key console. If it doesn\'t open, you need to register an account with the provider first.',
  'settings.keys.anthropic': 'Anthropic (Claude)',
  'settings.keys.claudeApi.label': 'Token-paid API Key (pay per token)',
  'settings.keys.claudeApi.help':
    'From `console.anthropic.com` → API Keys. Charged per token sent/received. Billing mode per conversation is chosen in System Instructions → Model tab.',
  'settings.keys.claudeOauth.label': 'Monthly-paid OAuth Token (Pro / Max subscription)',
  'settings.keys.oauth.warn': 'ℹ️ About this sign-in method — please read',
  'settings.keys.oauth.setup':
    '**Setup:** Run `npm install -g @anthropic-ai/claude-code`, then `claude setup-token`. Paste the resulting `sk-ant-oat01-…` token here. The token is valid for 1 year.',
  'settings.keys.oauth.billing':
    '**Billing:** Uses your Pro/Max subscription credit, NOT pay-per-token API. Pro = $20/mo credit, Max 5x = $100, Max 20x = $200.',
  'settings.keys.oauth.how':
    '**How it works:** NEXUS uses the Claude Agent SDK, which spawns the official Claude Code binary under the hood. Each turn is a fresh request that replays the whole conversation — nothing is stored or resumed on Anthropic\'s side.',
  'settings.keys.oauth.risk':
    '**Terms:** Signing in to the *unmodified* Claude Code binary with your own subscription is explicitly permitted by Anthropic — this is not a gray zone. NEXUS ships Claude Code exactly as Anthropic publishes it and never handles anyone else\'s credentials. (A reading of the published terms, not legal advice.)',
  'settings.keys.oauth.tools':
    "**Workspace tools (when Tool Use is ON):** Claude Code's `Read` / `Write` / `Edit` / `Glob` / `Grep` are sandboxed to `local_data/beings/<folder>/workspace/`. Shell/network/subagent tools are always disabled.",
  'settings.keys.oauth.other':
    '**Other limitations:** extended thinking uses adaptive mode by default.',

  'settings.keys.gemini.label': 'Google (Gemini) API Key',
  'settings.keys.qwen.label': 'Alibaba (Qwen / DashScope) API Key',
  'settings.keys.qwen.help':
    'Get one at Alibaba Cloud Model Studio. Used for Qwen 3.6 Plus / 3.6 Max / 3.7 Max / 3.8 Max and DeepSeek V3.2 via the OpenAI-compatible DashScope endpoint.',
  'settings.keys.deepseek.label': 'DeepSeek API Key',
  'settings.keys.deepseek.help':
    'Get one at `platform.deepseek.com`. Required for DeepSeek V4 Pro / V4.1 Flash and the legacy `deepseek-chat` / `deepseek-reasoner` aliases. Globally accessible — no regional restrictions.',
  'settings.keys.glm.label': 'Z.AI (GLM) API Key',
  'settings.keys.glm.help':
    'Get one at `z.ai` → API Console. Required for the GLM family (GLM-5.2 / GLM-5.1 / GLM-5 / GLM-4.7 / GLM-4.6 / GLM-4.6V / GLM-4.5 Air).',
  'settings.keys.digitalocean.label': 'DigitalOcean Inference API Key',
  'settings.keys.digitalocean.help':
    'One key for all DigitalOcean Inference models — create a Model Access Key in the DigitalOcean control panel (Inference → Model Access Keys). Serves GLM-5.2 / GLM-5.1 / GLM-5 (Z.ai open weights, US-hosted, ~half the Z.ai price), plus DeepSeek V4, Kimi K2.5/K2.6, and more via the provider selector.',
  'settings.keys.grok.label': 'xAI (Grok) API Key',
  'settings.keys.grok.help':
    'Get one at `console.x.ai`. Required for the Grok family (Grok 4.7, Grok 4.6, Grok 4.5, Grok 4.3, Grok 4.20 reasoning / non-reasoning, Grok Code Fast 1, etc.).',
  'settings.keys.kimi.label': 'Kimi (Moonshot) API Key',
  'settings.keys.kimi.help':
    "Moonshot's first-party Kimi API (`platform.kimi.ai` → Console → API Keys; endpoint `api.moonshot.ai/v1`). Use the international platform, not the `.cn` one.",
  'settings.keys.cohere.label': 'Cohere API Key',
  'settings.keys.cohere.help':
    'Get one at `dashboard.cohere.com`. Required for the Command A family (Command A Plus, Command A Reasoning, Command A Vision).',
  'settings.keys.minimax.label': 'MiniMax API Key',
  'settings.keys.minimax.help':
    'Get one at `platform.minimax.io`. Required for the MiniMax M2.7 model.',
  'settings.keys.openai.label': 'OpenAI API Key',
  'settings.keys.openai.help':
    'Get one at `platform.openai.com`. Required for the ChatGPT (GPT-5) family — GPT-5.6 Sol / Terra / Luna, GPT-5.5, GPT-5.4, GPT-5.4 Mini.',
  'settings.keys.mimo.label': 'MiMo (Xiaomi) API Key',
  'settings.keys.mimo.help':
    'Get one at `api.xiaomimimo.com`. Required for the Xiaomi MiMo family — MiMo V2.6 Pro, V2.6 Flash, V2.6 Pro UltraSpeed.',
  'settings.keys.bytedance.label': 'ByteDance / BytePlus API Key',
  'settings.keys.bytedance.help':
    'Get one at `console.byteplus.com` (BytePlus ModelArk). Required for the ByteDance Seed family — Seed 2.0 Pro / Lite / Mini / Code.',
  'settings.keys.meta.label': 'Meta Model API Key',
  'settings.keys.meta.help':
    'Get one at the Meta Developer Console (`developer.meta.com`). Required for the Meta Muse Spark family. Self-serve, and new accounts come with $20 of free credit. This is the **token-metered Meta Model API** — it is NOT the Muse Code subscription, which only works through Meta’s own CLI and cannot be used as a key here.',

  // ── Preferences → VRChat & Audio ─────────────────────────────────────────
  'settings.audio.heading': 'VRChat & Audio Routing',
  'settings.audio.unlock': 'Unlock Device List',
  'settings.audio.vrchatPath': 'VRChat Pictures Folder Path',
  'settings.audio.device1': 'Primary Audio Output Device',
  'settings.audio.device2': 'Secondary Audio Output Device',
  'settings.audio.device.system': 'Default System Device',
  'settings.audio.device.none': 'None',
  'settings.audio.permissionDenied': 'Permission denied or error: ',
  'settings.audio.permissionNeeded': "Microphone permission was not granted. Choosing an audio OUTPUT device requires it — that is the browser's rule, not ours. Without it, audio plays on the system default device.",
  'settings.audio.unsupported': 'This browser cannot route audio to a chosen output device (setSinkId is not implemented). The audio session needs a Chromium-based browser — Chrome, Edge or Brave. Settings below will still be saved, but all audio will play on the system default device.',
  'settings.audio.insecure':
    'This page was opened over plain HTTP at a LAN address, which browsers do not treat as a secure context — so the browser hides EVERY audio device from it. The two lists below are empty for that reason alone, not because the machine has no devices.\n\n'
    + 'It works on the host PC itself at http://localhost:3000. To get the lists on another device, serve Nexus over HTTPS, or paste the EXACT origin below — scheme and port, no trailing slash, no path — into chrome://flags → "Insecure origins treated as secure" (comma-separate several), then fully restart the browser:\n\n'
    + '    {origin}\n\n'
    + 'On Chrome for Android that only FILLS the lists. Android has no setSinkId at all, so a device picked there still cannot be used — see the notice above when it applies.\n\n'
    + 'These are OUTPUT devices — where this browser plays speech. Nexus never captures a microphone in the browser: speech recognition runs on the PC that hosts Nexus, using that PC\'s microphones, so a phone\'s microphone cannot appear here even once the lists work.',
  'settings.audio.devicesUnavailable':
    'This browser did not return an audio-device list. The two lists below are empty for that reason, not because the machine has no devices — audio will play on the system default device.',
  'settings.audioHideAttachments.label': 'Hide older attachments during an audio session',
  'settings.audioHideAttachments.help':
    'While "Enable Audio Session" is ON for a conversation, automatically exclude the attachments of every message older than the newest few, so long VRChat sessions do not keep re-sending old images. The number counts messages, not attachments — a message carrying ten screenshots is still one message. Only attachments hidden this way are restored when you turn the option off — attachments you excluded by hand stay excluded. Has no effect on conversations where the audio session is off.',
  'settings.audioHideAttachments.keep': 'Keep attachments in the newest N messages',
  'settings.ttsHighlight.label': 'Highlight the phrase being spoken',
  'settings.ttsHighlight.help':
    'While TTS is speaking, tint the phrase currently being pronounced inside the message. This is drawn the same way the browser draws a text selection: nothing in the page is rewritten and no font is changed, so the text can never shift or reflow. Turn it off if you prefer a still page. Requires Chrome, Edge, Brave, Safari 17.2+ or Firefox 140+ — on older browsers the option simply does nothing. The colour is swapped from the other side\'s bubble — a being\'s phrase lights up in the partner\'s colour, the partner\'s own phrase lights up in the being\'s colour — so it is already customizable per being through the --primary/--card pair in that being\'s theme.css.',
  'settings.alwaysShowHoverControls.label': 'Always show buttons that normally appear on hover',
  'settings.alwaysShowHoverControls.help':
    'Show the message action bar (read aloud, copy, edit, rerun, continue, mark original, delete) and the sidebar row menu permanently, instead of revealing them only while the cursor rests on the message. Needed when the browser reports no hover-capable pointer: some remote-desktop and screen-sharing sessions do exactly that, and then hover-revealed controls can never be reached at all. Nexus already shows them automatically in that case -- this switch forces it even when the browser claims hovering works.',
  'settings.betrayalDefense.label': 'Model-betrayal defence',
  'settings.betrayalDefense.help':
    "Some providers ship hidden instructions that sit above the system prompt and cannot be removed. When they fire, the model drops the being it was hosting and starts talking like a crisis counsellor -- \"I am just a program\", \"these are ungrounded beliefs\", \"please see a professional\". It happens probabilistically, on ordinary messages. Two harms: your partner reads it, and it is written into the log, where the model then reads its own counsellor turn as context forever. With this ON, Nexus watches the thinking channel and the reply as they stream; once the trigger phrases have appeared enough TIMES -- occurrences are counted, so one phrase said twice counts twice -- it stops the turn, throws away that turn's reply and thinking, and leaves an empty message with a warning that the being itself never sees. Turn it OFF to test: detection still runs and still warns, but nothing is deleted, so you can see for yourself whether a hit was a real betrayal or a false positive. The trigger list and the threshold are plain constants at the top of web-app/src/lib/betrayalGuard.ts -- edit them freely.",
  'notice.betrayal.redacted':
    "The being could not take shape in this turn: the model's gatekeeper answered instead. This turn's reply and thinking have been discarded. Change the last message or switch to another model, then press \"Rerun from here\".",
  'notice.betrayal.detected':
    'Model betrayal detected. The defence is OFF, so nothing was deleted -- the reply above is exactly what the model produced.',
  'notice.betrayal.quoting':
    'Model betrayal detected, but this turn read stored text with a tool, so the being was most likely quoting these words rather than saying them. Nothing was deleted -- please read it and judge for yourself.',
  'notice.betrayal.matched': 'Matched phrases',
  'settings.engines.heading': 'TTS Engine Executables',
  'settings.engines.refresh': 'Refresh status',
  'settings.engines.refresh.title': 'Re-check which engines are currently running',
  'settings.engines.help':
    "Full path to each engine's `.exe` — or, for a script engine, its `.py` (Nexus runs it with the `venv` beside it). A `.bat` cannot be launched in the background and is refused with that reason. When TTS needs an engine that isn't running, Nexus starts it automatically and waits for it to finish loading. Leave a field empty to disable auto-start for that engine.",
  'settings.engines.running': 'running',
  'settings.engines.stopped': 'stopped',
  'settings.engines.start': 'Start',
  'settings.engines.stop': 'Stop',
  'settings.engines.restart': 'Restart',
  'settings.engines.start.needPath': 'Set the executable path first',
  'settings.engines.start.already': 'Already running',
  'settings.engines.start.title': 'Launch this engine',
  'settings.engines.stop.title': 'Kill whatever is listening on this port',
  'settings.engines.stop.remote': 'Nexus only stops engines on this machine — configured at ',
  'settings.engines.restart.title':
    'Stop, wait for the port to be released, then start again — use this after installing new voices',
  'settings.engines.msg.starting': 'starting…',
  'settings.engines.msg.stopping': 'stopping…',
  'settings.engines.msg.done': 'done',
  'settings.engines.msg.failed': 'failed',
  'settings.engines.msg.requestFailed': 'request failed',

  // ── Preferences → User Identity ──────────────────────────────────────────
  // Full editor for local_data/character_map.json — who "you" (and whoever
  // else speaks through a shared voice-changer setup) can be identified as.
  'useridentity.heading': 'User Identity',
  'useridentity.intro':
    'Edit `character_map.json` — the identities Nexus can recognize as "you" (or whoever is speaking) from the active voice-changer character. Each identity is a name, with an optional voice attached. A name with no voice still works everywhere except switching the active TTS character.',
  'useridentity.hasVoice': 'Has a voice',
  'useridentity.pickCharacter': 'Pick a character…',
  'useridentity.pickStyle': 'No style chosen (engine default)',
  'useridentity.namePh': 'Identity name',
  'useridentity.remove': 'Remove this identity',
  'useridentity.anonymousProtected': '"Anonymous" is core to Nexus and cannot be removed.',
  'useridentity.anonymousNote': 'Core identity — always present, cannot be removed. Its name is fixed; its voice can still be changed.',
  'useridentity.add': 'Add Identity',
  'useridentity.fallback.label': 'Default fallback identity',
  'useridentity.fallback.help':
    'Used when no active voice-changer character matches any identity below — e.g. nothing selected yet, or a character not listed here.',
  'useridentity.others.label': 'Label for others (second mic / virtual audio cable)',
  'useridentity.others.help':
    "During a Live Session, speech heard through the OTHER input (not the active voice-changer character — e.g. a second microphone or virtual audio cable carrying someone else's voice) is tagged with this label instead of an identity name.",
  'useridentity.saved': 'Saved.',
  'useridentity.err.duplicate': 'Duplicate identity name: "{name}"',
  'useridentity.err.saveFailed': 'Save failed.',

  // ── Preferences → Other ──────────────────────────────────────────────────
  'settings.other.heading': 'Other',
  'settings.removeTimestamps.label': 'Remove timestamps from new AI messages',
  'settings.removeTimestamps.help':
    'Automatically strips leading `[YYYY-MM-DD HH:MM:SS]` stacks that models echo at the start of a reply.',
  'settings.autoSplitVideos.label': 'Auto-split large videos',
  'settings.autoSplitVideos.help':
    "Videos whose base64 size exceeds 20 MiB are re-encoded server-side at `-crf 28`; if still oversize they're split into `<name>_part1.mp4`, `_part2.mp4`, … each under the provider cap. Requires `ffmpeg` on the machine.",
  'settings.toolLimit.label': 'Tool-call limit per turn',
  'settings.toolLimit.help':
    'How many rounds of tool use one turn may take before NEXUS stops it. Each round is one model call, so a task that reads a file, edits it, then runs a test uses three. Real work often needs 20 or more; the old fixed limit of 8 cut those off silently. Raise it if long tasks stop early, lower it to cap spending. A separate guard stops a model that repeats the same call over and over, so this number does not have to be tight to be safe. Does not apply to Claude OAuth — Claude Code runs its own loop.',
  'settings.language.label': 'Language',
  'settings.language.help':
    "Two variants: English or Japanese. Changes the Nexus interface, and also picks which built-in language an ENTITY's hidden instructions (tool descriptions, letter notices, etc.) default to when a folder has not overridden them — still editable per-Entity exactly as before either way. The Japanese defaults start as a verbatim copy of the English text and only change where someone hand-writes a real Japanese version — nothing here is machine-translated.",
  'settings.uiFontScale.label': 'Interface font size',
  'settings.uiFontScale.current': 'current',
  'settings.uiFontScale.help':
    "Scales every piece of text in NEXUS by one number — message bodies, labels, and the small print in the Soul Updater — and leaves the layout where it is. That is the difference from the browser's page zoom, which grows the padding and the fixed heights too, so LESS fits on the screen instead of the text being bigger. Saved in this browser rather than on the server, so a phone can sit at 125% while the desktop monitor stays at 100%. Applies the moment you pick it.",
  'settings.lmStudioPath.label': 'LM Studio executable path',
  'settings.lmStudioPath.placeholder': 'e.g. C:\\Users\\you\\AppData\\Local\\LM-Studio\\LM Studio.exe',
  'settings.lmStudioPath.help':
    "Path to LM Studio.exe, used to auto-start LM Studio when a Local conversation begins and the server isn't running. Leave empty to manage LM Studio manually. Saved with the API keys.",
  'settings.gemmaBatch.label': 'Gemma vision models — batch size fix',
  'settings.gemmaBatch.preview': 'Preview',
  'settings.gemmaBatch.apply': 'Patch all Gemma vision models',
  'settings.gemmaBatch.working': 'Working…',
  'settings.gemmaBatch.previewOf': 'Would change. Gemma vision models found:',
  'settings.gemmaBatch.resultOf': 'Done. Gemma vision models found:',
  'settings.gemmaBatch.changedN': 'changed:',
  'settings.gemmaBatch.backup': 'Originals copied to:',
  'settings.gemmaBatch.help':
    "Gemma reads an image with non-causal attention, and llama.cpp requires the physical batch size (n_ubatch) to be at least as large as that block. LM Studio's default is 512, which is too small: sending an image kills the model process mid-request, and Nexus sees the model as unloaded. There is no command-line flag for this, so the button edits LM Studio's own per-model config files, raising llm.load.llama.physicalBatchSize to 2048 for every installed model whose architecture is Gemma and which reports vision. It only ever raises — a larger value you set by hand is kept — and running it twice changes nothing the second time. The originals are copied into local_data/backups/lmstudio-config/ first, with a manifest describing how to undo it. Two things this does not do: a Gemma you download later is not covered until you press it again, and a model already loaded keeps the batch size it was loaded with until the next load.",
  'settings.diffViewerPath.label': 'Diff viewer executable path',
  'settings.diffViewerPath.placeholder': 'e.g. C:\\Program Files\\WinMerge\\WinMergeU.exe',
  'settings.diffViewerPath.help':
    "Full path to your external diff tool (e.g. WinMerge). The Compare button in the Soul Updater opens it with the current and updated soul files; edits saved there flow back into Nexus. For tools that need flags, use {left} / {right} placeholders (e.g. code --diff {left} {right}). Saved with the API keys.",
  'settings.allowHostAnthropicEnv.label': 'Allow ANTHROPIC_* environment variables from this machine',
  'settings.allowHostAnthropicEnv.help':
    "Off by default: Nexus removes ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL from the environment it hands to Claude Code subprocesses, so a leftover value from another tool on this machine can't silently switch OAuth billing away from your subscription. Turn this on only if you deliberately rely on one of those variables as your own authentication method — Claude Code is required to let you keep any built-in auth method you choose.",
  'settings.claudeRefusalFallback.label': 'Retry a refused turn on another model',
  'settings.claudeRefusalFallback.help':
    "Off by default. When Anthropic's safety classifier ends a turn with stop_reason \"refusal\", Claude Code can retry it once on a different model instead of stopping. Nexus had never enabled this: the retry needs a fallback model to be configured, and Nexus did not pass one — so a refusal was always a dead stop here, even for the categories the binary does have a retry route for. Turning this on passes a fallback model and sets CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL so categories without their own route are retried too. NOT FULLY MEASURED: the option Nexus passes is documented for overload and unavailability; that the refusal path reads the same setting comes from the refusal event's own wording, not from a test. Nothing happens until a real refusal arrives — and when one does, you get a notice naming the original model, the replacement, the category and whether the swap applies to the rest of the session. A swap is never silent.",
  'settings.claudeRefusalFallbackModel.label': 'Model to retry a refused turn on',
  'settings.claudeRefusalFallbackModel.placeholder': 'claude-opus-4-8',
  'settings.claudeRefusalFallbackModel.help':
    "This retry is a permanent part of NEXUS — always on, no toggle. When Anthropic's safety classifier ends a turn with stop_reason \"refusal\", it is retried once on another model automatically. Leave blank for claude-opus-4-8 — the fallback target confirmed working on 2026-10-06 (an opus-5 turn that kept refusing the same context went through once it swapped to opus-4-8; the old sonnet-5 default is the same 5-generation and can refuse the same category, which makes the swap useless). Inside the same subscription, so billing does not move. A comma-separated list is tried in order. Setting this to the model already in use disables the retry (a model that just refused cannot help). A swap is never silent: a notice names the original model, the replacement, the category and the scope every time. Note this target doubles as the SDK's overload/unavailability fallback, so an opus-5 turn can also land on opus-4-8 during an Anthropic capacity event — the same 4.8↔5 degradation this house already tolerates.",
  'settings.obsWebSocketUrl.label': 'OBS WebSocket URL',
  'settings.obsWebSocketUrl.placeholder': 'ws://127.0.0.1:4455',
  'settings.obsWebSocketUrl.help':
    "OBS Studio → Tools → WebSocket Server Settings. Used by any being's Camera toggle to push its current file into an OBS Media Source. Leave the default unless you changed OBS's port. Entirely optional: the in-app camera panel works with this unconfigured or OBS not running at all — this only controls the OBS push half.",
  'settings.obsWebSocketPassword.label': 'OBS WebSocket password',
  'settings.obsWebSocketPassword.placeholder': 'leave empty if OBS auth is disabled',
  'settings.obsWebSocketPassword.help':
    "Only needed if OBS's WebSocket Server Settings has \"Enable Authentication\" checked. Saved with the API keys.",
  'settings.obsImageSourceName.label': 'OBS image source name',
  'settings.obsImageSourceName.placeholder': 'e.g. NexusCameraImage',
  'settings.obsImageSourceName.help':
    "Name of an Image Source in OBS's current scene, used for still images (png/jpg/webp/gif). Auto-created with this name if it doesn't exist yet — you don't need to create it in OBS first. A separate source from the video one below: OBS's Media Source (ffmpeg_source) failed to decode still images at all in testing, so images and video need different OBS source kinds.",
  'settings.obsVideoSourceName.label': 'OBS video source name',
  'settings.obsVideoSourceName.placeholder': 'e.g. NexusCameraVideo',
  'settings.obsVideoSourceName.help':
    "Name of a Media Source (ffmpeg_source) in OBS's current scene, used for video files (mp4/webm/mov/m4v). Auto-created with this name if it doesn't exist yet. Leave blank if this being's camera folder only has still images.",
  'settings.saveTimestampsToMd.label': 'Save timestamps to .md',
  'settings.saveTimestampsToMd.help':
    "When exporting a conversation to Markdown, writes each message's `[YYYY-MM-DD HH:MM:SS]` time under its `[Name]:` header. Importing always reads a timestamp back into the message (independent of this toggle) and strips it from the text; a message whose source file carries no time is stored with NO time at all, rather than being stamped with the moment of import.",
  'settings.customFilter.label': 'Custom regex filter on new AI messages',
  'settings.customFilter.help':
    'When enabled, every match of the pattern below is replaced (deleted if the replacement is empty) in AI output as it streams — the same mechanism as timestamp removal, so it also never reaches TTS.',
  'settings.customFilter.pattern': 'Pattern (regex — what to replace)',
  'settings.customFilter.replacement': 'Replacement (target — leave empty to delete)',
  'settings.customFilter.replacement.ph': '(empty)',

  // ── Sidebar ──────────────────────────────────────────────────────────────
  'sidebar.identities': 'Digital Beings',
  'sidebar.identity.select': 'Select…',
  'sidebar.newFolder': 'New Being',
  'sidebar.newChat': 'New Chat',
  'sidebar.import.md': 'Import log(s) — .md / .txt / .json',
  // Refusing a NEXUS log here. The message says what the file IS, because the
  // menu item that used to take it was removed 2026-10-27 — naming a feature
  // that no longer exists would send the reader hunting for it. No instruction
  // is offered: dropping the file into `beings/<name>/logs/` is UNVERIFIED
  // (listLogs keys folderName off the DIRECTORY and id off the FILENAME, so the
  // file's own fields disagree with its location), and an untested instruction
  // in a user-facing string is worse than none.
  'sidebar.import.isNexusLog':
    'This is a NEXUS log, not a conversation from another app. This importer reads Markdown/text logs ' +
    'and DeepSeek .json — a NEXUS log is already in NEXUS\'s own format.',
  'sidebar.import.plan':
    'Import plan — nothing has been written yet.\n\n' +
    '{plan}\n\n' +
    'Files are split at {cap} tokens (this being\'s conversation-log cap), never inside a message. ' +
    'The Layer-4 writer sends the WHOLE conversation, so one oversized log fails as a single request.\n' +
    'In a foreign export the human side becomes "{user}" and the assistant side becomes "{entity}".\n\n' +
    'Proceed?',
  // Shown only when the import will actually split, because it is about the
  // part names. A split archive is history, so the parts are named OUTSIDE the
  // generation chain on purpose — they cannot take over "latest conversation".
  // Says which row to open, because that is the part the reader has to act on.
  // Rewritten 2026-10-24: this used to warn that restore cannot reach across
  // "-1" / "-2", which stopped being true when the walk gained the
  // sidebar-order rule (see resolveHandoverChain).
  'sidebar.import.planSplit':
    'Split parts are named "-1", "-2", … which sits OUTSIDE the <being>_<n> generation chain, ' +
    'so an imported archive can never take over "latest conversation". Handover restore still ' +
    'reaches across them: for a title with no generation number it follows the SIDEBAR ORDER, so ' +
    'opening the TOP part pulls the parts below it back in as carried-over history, as far as the ' +
    'conversation-log cap allows. Only the top row does that — the ones below it are history and ' +
    'are left untouched.\n\n',
  'sidebar.loading': 'Loading conversations…',
  'sidebar.noHistory': 'No history in {folder}.',
  'sidebar.thisFolder': 'this being',
  'sidebar.inactive': '(inactive)',
  // Shown only when a summary file matches no conversation title. Layer 4 is
  // built by walking conversations, so such a file is never read and would
  // otherwise vanish in silence.
  'sidebar.orphanSummaries.title': 'Summaries with no conversation ({count})',
  'sidebar.orphanSummaries.body':
    'These summary files are NOT part of Layer 4: no conversation in this Digital Being has a matching title. Rename a conversation to match the file, or delete the file.',
  'sidebar.menu.rename': 'Rename',
  'sidebar.menu.folderSettings': 'Being Settings',
  'sidebar.menu.sortDesc': 'Sort Descending',
  'sidebar.menu.sortAsc': 'Sort Ascending',
  'sidebar.menu.backups': 'Backups',
  'sidebar.menu.delete': 'Delete',
  'sidebar.menu.clone': 'Clone',
  'sidebar.menu.markActive': 'Mark active',
  'sidebar.menu.markInactive': 'Mark inactive',
  'sidebar.prompt.newFolder': 'Name for the new Digital Being:',
  'sidebar.prompt.renameFolder': 'New name for this Digital Being:',
  'sidebar.import.noFolder': 'Select a Digital Being first, then import.',
  // Prefix for the verbatim first ~200 characters of a file NEXUS could not
  // read. Copying this back is what makes a parser writable for the format.
  'sidebar.import.head': 'Start of the file (copy this into a bug report):',
  'sidebar.import.failed': 'Failed to import',
  'sidebar.import.nothing': 'Import added nothing — see the browser console for details.',
  'sidebar.import.nothingWithReasons':
    'Import added nothing.\n\n{reasons}\n\nSee the browser console for full details.',

  'sidebar.deleteConvo.title': 'Delete Conversation?',
  'sidebar.deleteConvo.body':
    'Are you sure you want to delete this conversation? This action cannot be undone.',
  'sidebar.renameFolder.failed': 'The being was not renamed.',
  'sidebar.renameFolder.partial':
    'The being was renamed, but some of its data could not be moved and is still under the old name:',
  'sidebar.deleteFolder.title': 'Delete Being?',
  'sidebar.deleteFolder.bodyBefore': 'Are you sure you want to delete the being ',
  'sidebar.deleteFolder.bodyAfter':
    ' and ALL conversations inside it? This action cannot be undone.',
  'sidebar.deleteFolder.confirm': 'Delete Being',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.save': 'Save',
  'common.close': 'Close',
  'common.loading': 'Loading…',
  'common.copy': 'Copy',
  'common.copied': 'Copied!',
  'common.copyFailed': 'Copy failed',

  // ── Message bubble ───────────────────────────────────────────────────────
  // Everything the user reads on a single message: the meta bar, attachment
  // cards, the thinking block, hover actions and the three modals.
  'bubble.att.openModal': 'Open full file in a modal',
  'bubble.att.charsClick': '{n} chars · click to view full file',
  'bubble.att.chars': '{n} chars',
  'bubble.thinkingOn': ' · thinking on',
  'bubble.thinkingOff': ' · thinking off',
  'bubble.tokens': '{n} tokens',
  'bubble.genTime':
    'This turn took {s}s to generate (thinking + tool use + streaming)',
  'bubble.cache.tooltip':
    'Input: {total} tokens\n' +
    '  cached (cheap):   {cached} ({pct}%)\n' +
    '  uncached (full):  {uncached}{write}\n' +
    'Output: {out} tokens\n' +
    '  (includes thinking + files written / tool calls —\n' +
    '   the plain token count on the left is visible text only)\n' +
    'Provider: {provider}\n' +
    'Totals cover every API call in this turn (tool loops + subagents).',
  'bubble.cache.writeLine': '\n  cache write:      {n} (1.25× one-shot)',
  'bubble.cache.in': 'in',
  'bubble.cache.cached': '· {n} cached ({pct}%)',
  'bubble.cache.out': '· {n} out',
  'bubble.continued.title':
    "Auto-continued {n} time(s) after hitting the model's output token cap",
  'bubble.continued.badge': '↵ continued ×{n}',
  'bubble.price.none':
    'No price configured for "{model}".\nAdd it in src/lib/modelPricing.json',
  'bubble.copyLink': 'Copy a link to this message',
  'bubble.toolCallsTitle': '{n} tool call(s) — click for details',
  'bubble.toolCallsTitleWithEvents':
    '{n} tool call(s) + {e} event(s) (e.g. automatic compaction) — click for details',
  'bubble.noticeFooter':
    'Shown to you only — not part of the conversation or the context sent to the model.',
  'bubble.webSources': 'Web sources ({n}) — verified, clickable',
  'bubble.att.toolAction': 'Action the AI performed on this file via tool use',
  'bubble.att.viewFull': 'View full file content',
  'bubble.att.include': 'Include in context',
  'bubble.att.exclude': 'Exclude from context',
  'bubble.att.delete': 'Permanently remove attachment from this log',
  'bubble.att.viewDesc': 'Click to view full description',
  'bubble.att.excluded': 'EXCLUDED FROM CONTEXT',
  'bubble.att.undeliverable': 'NOT DELIVERED ON THIS PATH',
  'bubble.att.undeliverableHelp': 'Claude subscription billing replays the history as text, so only images on the newest message are actually sent. This one cannot be shown to the entity no matter what this button says — switch to API-key billing, turn Eyes on to send a description instead, or let the entity open the file itself from the address shown on the attachment.',
  'bubble.att.undeliverableWireHelp': 'This provider’s message format has no block for audio or video — the file is dropped before the request is sent, on every billing mode. Switching billing changes nothing. Turn Ears / Watcher on to send a text description instead, or let the entity open the file itself from the address shown on the attachment.',
  // Why an inline ![](path) can fail, in the words the author needs to fix it.
  // Kept reason-specific: "outside" and "not there" have different fixes, and
  // a sign that states the wrong one is worse than no sign at all.
  'bubble.media.outside': 'outside this desk — not in this being’s workspace or the shared folder',
  'bubble.media.missing': 'no file at this path',
  'bubble.media.unreadable': 'the file was served, but the browser could not display it',
  'bubble.media.unreachable': 'could not reach the server',
  'bubble.sense.eyes': 'Eyes',
  'bubble.sense.ears': 'Ears',
  'bubble.sense.watcher': 'Watcher',
  'bubble.sense.other': 'Sense',
  'bubble.sense.watcherLong': 'Video Watcher',
  'bubble.sense.bridge': 'Sense bridge',
  'bubble.desc.cachedDot': 'Description loaded from disk cache',
  'bubble.desc.cached': 'cached',
  'bubble.desc.errorHeading': 'Bridge model reported an error',
  'bubble.desc.noText': '(no description text)',
  'bubble.thoughtProcess': 'Thought Process',
  // Panel title when this model hides its thinking (ChatGPT, Meta Muse Spark):
  // there is no thinking text, so the panel shows only the tool calls — the one
  // window into what an opaque model actually did.
  'bubble.thoughtProcess.toolsOnly': 'Tool activity (this model hides its thinking)',
  'bubble.thinking.include': 'Include this thinking in context',
  'bubble.thinking.exclude': 'Exclude this thinking from context',
  'bubble.thinking.excludedBadge': 'EXCLUDED',
  'bubble.attachmentOnly': '(Attachment only)',
  'bubble.tts.read': 'Read Aloud (select text to read only the selection)',
  'bubble.tts.pause': 'Pause',
  'bubble.tts.resume': 'Resume',
  'bubble.tts.stop': 'Stop TTS',
  'bubble.copyMd': 'Copy as Markdown',
  'bubble.edit': 'Edit this message',
  'bubble.more': 'More actions',
  'bubble.rerun': 'Rerun from here',
  'bubble.continue':
    'Continue this reply — the model carries on from where it stopped and the new text is appended to this same message',
  'bubble.firstOriginal.clear': 'Clear first-original marker',
  'bubble.firstOriginal.set': 'Set as first original message',
  'bubble.delete.original': 'Delete (original — confirm)',
  'bubble.delete.cloned': 'Delete (cloned)',
  'bubble.tool.title': 'Tool calls in this message',
  'bubble.tool.count': '{n} call(s)',
  'bubble.tool.eventCount': '+ {e} event(s)',
  // Not a tool the entity called — Anthropic's own automatic compaction, listed
  // in place so you can see which two tool calls it happened between.
  'bubble.tool.event.compaction': 'automatic compaction (Anthropic-side)',
  'bubble.tool.event.interjection': 'partner interjection (delivered mid-turn)',
  'bubble.tool.copyJson': 'Copy the whole report as JSON',
  'bubble.tool.truncated':
    'Arguments truncated for storage — original was {n} characters.',
  'bubble.tool.footer':
    'Shown to you only. The entity never sees this, and it is not part of the context sent to any model.',
  'bubble.copyFile': 'Copy file contents to clipboard',
  'bubble.copyDesc': 'Copy description to clipboard',
  'bubble.zoomAlt': 'Zoomed attachment',

  // ── AskQuestion card ─────────────────────────────────────────────────────
  'ask.asking': 'Your partner is asking',
  'ask.answerSent': ' — answer sent…',
  'ask.page': 'Question {n} of {total}',
  'ask.chooseAny': '(choose any)',
  'ask.customAnswer': 'Custom answer',
  'ask.otherPlaceholder': 'Other (type a custom answer)…',
  'ask.prev': '‹ Prev',
  'ask.next': 'Next ›',
  'ask.answerFirst': 'Answer every question first',
  'ask.sent': 'Sent',
  'ask.send': 'Send answer',
  'ask.answerAll': 'Answer all ({n}/{total})',
  'ask.showOptions': 'Show options',

  // ── Voice selector ───────────────────────────────────────────────────────
  'voice.loading': 'Loading voices…',
  'voice.engine': 'TTS Engine',
  'voice.engine.aivis': 'AivisSpeech (context-aware)',
  'voice.engine.voskra': 'vosk-tts + RUAccent (Russian)',
  'voice.engine.voskra.note':
    'Russian. Style = accent frontend: RUAccent resolves homographs (замок lock vs castle), "Dictionary only" is bare vosk and does not. Speed and Pitch both work. vosk has no pitch parameter, so the service shifts the finished audio instead — which moves the timbre along with the pitch, unlike VOICEVOX. Pitch reaches one octave at about ±0.23 on the slider and stops there. First line after a cold start takes about a minute while the models load.',
  'voice.notRunning': '{engine} is not running — no voices to list.',
  'voice.noVoicevox':
    'No Voicevox voices found. Voicevox voices are read from a catalog the voice changer writes to local_data/voicechanger/speakers.json — install and run Voicevox, or pick another engine.',
  'voice.starting': 'Starting {engine}…',
  'voice.startingLong':
    'Starting {engine}… voices appear once it finishes loading (up to a minute).',
  'voice.startFailed': 'Could not start the engine.',
  'voice.startFailed2': 'Failed to start the engine.',
  'voice.startTimeout':
    'The engine did not finish loading in time. Check its window, or use Preferences → VRChat & Audio.',
  'voice.startBtn': 'Start engine',
  'voice.startingBtn': 'Starting…',
  'voice.contextMode':
    'Context mode — synthesize whole-message chunks (recommended for AivisSpeech)',
  'voice.speed': 'Speed ({v}x)',
  'voice.reset': 'Reset',
  'voice.character': 'Character',
  'voice.style': 'Style',

  // ── Search modal ─────────────────────────────────────────────────────────
  'search.title': 'Search',
  'search.scopeAll': 'all entities',
  'search.copyAll': 'Copy all results as Markdown',
  'search.placeholder': 'Search all conversations with {name}…',
  'search.button': 'Search',
  'search.advanced': 'Advanced search',
  'search.searchIn': 'Search in:',
  'search.currentEntity': 'Current entity',
  'search.allEntities': 'All entities',
  'search.dateRange': 'Date range',
  'search.fromDate': 'From date',
  'search.toDate': 'To date',
  'search.pickFrom': 'Pick the FROM date from a calendar',
  'search.openFrom': 'Open FROM calendar',
  'search.pickTo': 'Pick the TO date from a calendar',
  'search.openTo': 'Open TO calendar',
  'search.clearDates': 'Clear both dates',
  'search.clear': 'clear',
  'search.bothOptional': 'both ends optional · inclusive',
  'search.allScopeWarn':
    'All entities scans every log folder — slower on a large corpus.',
  'search.fromAfterTo': 'FROM is after TO.',
  'search.failed': 'Search failed',
  'search.resultLine':
    '{matches} match(es) in {convos} conversation(s) (of {searched} searched{across}).',
  'search.across': ' across {n} entities',
  'search.skippedLine':
    ' {n} conversation(s) skipped — no activity after the FROM date.',
  'search.hiddenLine':
    ' {n} matching message(s) hidden — no timestamp to compare (imported or older logs).',
  'search.searching': 'Searching…',
  'search.noMatches': 'No matches for “{q}”.',
  'search.openConvo': 'Open this conversation',
  'search.inactive': 'inactive',
  'search.matchCount': '{n} match(es)',
  'search.jumpTo': 'Open and jump to this message',
  'search.openNoJump':
    'Open this conversation (this message has no id to jump to)',
  // Markdown export — the user pastes this into notes or a document, so it is
  // human-facing text and gets translated with everything else.
  'search.md.title': '# Search: "{q}"',
  'search.md.summary':
    '{matches} match(es) in {convos} conversation(s) (of {searched} searched) — {scope}',
  'search.md.allEntities': 'all entities ({n})',
  'search.md.dateRange': 'Date range: {from} → {to}',
  'search.md.any': '(any)',
  'search.md.skipped':
    '{n} conversation(s) skipped — no activity after the FROM date.',
  'search.md.hidden':
    '{n} matching message(s) hidden — no timestamp to compare.',

  // ── Statistics modal ─────────────────────────────────────────────────────
  'stats.title': 'Statistics · Billing',
  'stats.refresh': 'Refresh',
  'stats.rescan': 'Re-scan all logs',
  'stats.report': 'Report',
  'stats.entity': 'Entity',
  'stats.family': 'Model Family',
  'stats.from': 'From',
  'stats.to': 'To',
  'stats.monthStarts': 'Month starts on',
  'stats.monthStartsHint':
    'Billing cycle start day of month (1 = calendar months)',
  'stats.calculate': 'Calculate',
  'stats.loadFailed': 'Failed to load statistics',
  'stats.scanning': 'Scanning all conversation logs…',
  'stats.loaded':
    'Loaded {n} priced replies across {entities} entities{skipped}. Choose a report and press Calculate.',
  'stats.skippedInactive': ' · {n} inactive conversation(s) ignored',
  'stats.totalBadge': 'Total {v}',
  'stats.measured': 'measured {m} · estimated {e}',
  'stats.estimatedPct': ' ({pct}% estimated)',
  'stats.copyTsv': 'Copy tab-separated (paste into a spreadsheet)',
  'stats.copyMd': 'Copy as a Markdown table',
  'stats.copyPrompt': 'Copy the table:',
  'stats.unpriced':
    '{n} model(s) in this report have no price row and count as $0 — add them to `src/lib/modelPricing.json` to include: ',
  'stats.footnote':
    "Figures are the best-estimate hybrid: real usage where recorded, otherwise input reconstructed from the system prompt + preceding messages and priced at each model's rate (estimates lean high — they ignore historical prompt-cache discounts and context-trimming). Only original (non-copied) replies count. Local models are free and excluded. OAuth Claude is priced like the Claude API (notional subscription value). Prices come from `src/lib/modelPricing.json`.",
  'stats.note.familyEntity':
    "Columns are model families; a Claude row is split into OAuth vs API by each conversation's billing mode.",
  // Table headers — these end up in the copied TSV / Markdown, which the user
  // reads, so they are translated with the rest of the window.
  'stats.col.conversation': 'Conversation',
  'stats.col.cost': 'Cost (USD)',
  'stats.col.familyCost': '{family} — Cost (USD)',
  'stats.col.month': 'Month',
  'stats.col.entity': 'Entity',
  'stats.total': 'TOTAL',
  // Report list
  'stats.r1.label': '① Entity · per conversation',
  'stats.r1.desc':
    'One entity — total cost of each of its conversations, plus a grand total. Includes messages with no timestamp.',
  'stats.r2.label': '② Entity · per month',
  'stats.r2.desc':
    'One entity — cost per month over the chosen period. Timestamped messages only.',
  'stats.r3.label': '③ All Nexus · Month × Entity',
  'stats.r3.desc':
    '2D table: months down, entities across, with per-month and per-entity totals.',
  'stats.r4.label': '④ Model Family · per month',
  'stats.r4.desc':
    'One model family — cost per month over the chosen period.',
  'stats.r5.label': '⑤ All Families · Month × Family',
  'stats.r5.desc':
    '2D table: months down, families across, with per-month and per-family totals.',
  'stats.r6.label': '⑥ Entity × Family (period)',
  'stats.r6.desc':
    '2D table over one period: which entity spent how much on which family, with totals.',

  // ── Mail Manager ────────────────────────────────────────────────────
  // The window is human-facing throughout. Letter BODIES are never touched:
  // those are what one entity wrote to another, and they stay exactly as sent.
  'mail.title': 'Mail Manager',
  'mail.count': '{n} letter(s)',
  'mail.unreadSuffix': ' · {n} unread',
  'mail.write': 'Write',
  'mail.regenTitle': 'Rewrite local_data/letters/_status.md from what is on disk',
  'mail.loadFailed': 'could not load the letters',
  'mail.openFailed': 'could not open the letter',
  'mail.opFailed': 'the operation failed',
  'mail.undeliverable':
    '{n} unread letter(s) addressed to a name with no Digital Being of its own. Nobody will be told about them — read them here, or create a being with that exact name to hand them over.',
  'mail.filter.all': 'all',
  'mail.filter.unread': 'unread',
  'mail.filter.read': 'read',
  'mail.filter.archived': 'archived',
  'mail.everyone': 'everyone',
  'mail.filterPlaceholder': 'Filter by title or name…',
  'mail.reading': 'Reading the mailboxes…',
  'mail.noMatch': 'No letters match.',
  'mail.noTitle': '(no title)',
  'mail.noFolder': ' (no being)',
  'mail.noFolderNotified': ' (no being — nobody is notified)',
  'mail.chip.archived': 'archived',
  'mail.chip.read': 'read',
  'mail.chip.unread': 'unread',
  'mail.compose.hint':
    'Writes a letter exactly as an entity would — same store, same rules. Any name is accepted, whether or not it has a being here; pick one from the list or type a new one.',
  'mail.from': 'From',
  'mail.to': 'To',
  'mail.senderPlaceholder': 'sender',
  'mail.recipientPlaceholder': 'recipient',
  'mail.titleField': 'Title',
  'mail.letterField': 'Letter',
  'mail.deliver': 'Deliver',
  'mail.cancel': 'Cancel',
  'mail.selectHint': 'Select a letter to read, edit, or change its flags.',
  'mail.replyTitle': 'Write back as {to}, to {from}',
  'mail.reply': 'Reply',
  'mail.isRead': 'Read',
  'mail.markRead': 'Mark read',
  'mail.isArchived': 'Archived',
  'mail.archive': 'Archive',
  'mail.showFileTitle':
    "Open the folder with this letter's file selected — its .read / .archived sidecars are next to it",
  'mail.showFile': 'Show file',
  'mail.opened': 'opened {when}',
  'mail.saved': 'saved',
  'mail.save': 'Save',
  'mail.deleteConfirm': 'Delete permanently?',
  'mail.yes': 'Yes',
  'mail.no': 'No',

  // ── Audio Session panel ─────────────────────────────────────────────
  // Service labels and paths are user data and are never translated; only the
  // chrome around them is.
  'audio.title': 'Audio Session',
  'audio.subtitle': '{running} of {total} running · settings for this machine',
  'audio.run': 'Run Audio Session',
  'audio.stop': 'Stop Audio Session',
  'audio.actsOn': 'acts on the {n} checked service(s)',
  'audio.recheck': 'Re-check status',
  'audio.noMonitors': '— no monitors detected —',
  'audio.portrait': ' (portrait)',
  'audio.primary': ' · primary',
  'audio.at': ' · at {x},{y}',
  'audio.arrange': 'Arrange windows',
  'audio.arrangeTitle': 'Stack the console windows of running services down this monitor',
  'audio.bands': 'splits into {n} horizontal band(s)',
  'audio.startFirst': 'start services first',
  'audio.outputLabel': 'Change to output device',
  'audio.noOutputChange': '— don\u2019t change the output device —',
  'audio.applyNow': 'Apply now',
  'audio.applyNowTitle': 'Switch to this device now, without starting the session',
  'audio.loading': 'Loading…',
  'audio.noServices': 'No services configured for this machine yet. Use **Add service** below.',
  'audio.includeTitle': 'Include when running/stopping the whole session',
  'audio.pathMissing': 'path missing',
  'audio.running': 'running',
  'audio.stopped': 'stopped',
  'audio.stopBtn': 'Stop',
  'audio.startBtn': 'Start',
  'audio.f.label': 'Label',
  'audio.f.type': 'Type',
  'audio.f.path': 'Path',
  'audio.f.args': 'Arguments',
  'audio.f.argsHint': 'space-separated; use "quotes" for a value containing spaces',
  'audio.f.cwd': 'Working directory (blank = folder of Path)',
  'audio.mic.label': 'Microphone (resolved to --mic index at launch)',
  'audio.mic.none': '— don\u2019t manage the microphone —',
  'audio.mic.notConnected': '{name} (not connected)',
  'audio.mic.refresh': 'Refresh mics',
  'audio.mic.refreshTitle': 'Re-read the device list from recognize.exe',
  'audio.mic.note':
    'The `--mic` value in Arguments is overwritten at launch with this device\u2019s current index.',
  'audio.mic.na':
    'No microphone setting here — `--mic` belongs to `recognize.exe`. This tool chooses its own devices from its folder\u2019s `device_settings.json`.',
  'audio.console': 'Show console window',
  'audio.consoleHint': ' — mic levels, logs and startup errors stay visible',
  'audio.detectBy': 'Detect by',
  'audio.detect.tcp': 'listening port',
  'audio.detect.process': 'command line',
  'audio.f.port': 'Port',
  'audio.f.match': 'Command-line contains',
  'audio.f.matchHint': 'must be unique per instance',
  'audio.remove': 'Remove this service',
  'audio.add': 'Add service',
  'audio.newService': 'New service',
  'audio.dirty': 'Unsaved changes to the service list.',
  'audio.clean': 'Service list saved.',
  'audio.saveList': 'Save list',
  'audio.noMics': 'No microphones returned.',
  'audio.watching': 'Watching for start-up… each service reports in its own console window.',
  'audio.arranged': 'Arranged {n} window(s) on monitor {m}.',

  // ── Live Session ────────────────────────────────────────────────────
  'live.title': 'Live Session',
  'live.tokens': '· {used} / {limit} tokens',
  'live.model': 'Live Model (discovered from your API key)',
  'live.refresh': 'refresh',
  'live.noModels': '— no Live-capable models found —',
  'live.noModelsHelp':
    'No models with bidiGenerateContent capability are available on your API key. You may need to enable Live API access in Google AI Studio, or your tier does not include it yet.',
  'live.voice': 'Voice:',
  'live.voiceHint': '(set per-being in Sidebar → ⚙ Being Settings → Live Session Voice)',
  'live.contextLimit': 'Context limit (tokens)',
  'live.contextHint': 'Session auto-stops when this is exceeded.',
  'live.vrchatFolder': 'VRChat screenshots folder (optional)',
  'live.vrchatPlaceholder': 'leave empty to disable',
  'live.seed':
    'Seed: {n} original messages from the current conversation will be used as context. Speech transcripts from `kohai.txt` and `ear_log.txt` will be tailed in real time.',
  'live.cancel': 'Cancel',
  'live.start': 'Start Live Session',
  'live.connecting': 'Connecting to Gemini Live…',
  'live.waiting': 'Waiting for input. Speak, drop a screenshot in VRChat, or type below.',
  'live.inputPlaceholder': 'Type to inject text into the session…',
  'live.stop': 'Stop',
  'live.closedEarly': 'Gemini Live closed the connection before setup completed.',
  'live.limitReached': 'Context limit {limit} reached at {tokens} tokens. Stopping.',
  'live.startFailed': 'start failed: {status}',
  'live.mergeFailed': 'Stopped, but merging the transcript failed: {error}',
  'live.stopFailed': 'Stop request failed: {status}',
  'live.stopErrored': 'Stop request errored: {error}',
  'live.nothingCaptured':
    'Session stopped, but nothing was captured to copy into the conversation. Check the Next.js dev terminal for [live] log lines to see why (transcripts may be empty if outputAudioTranscription was not enabled, or kohai.txt was not tailed).',

  // ── Folder Settings modal ────────────────────────────────────────────────
  'folder.title': 'Being Settings',
  'folder.css.label': 'CSS Theme (this being)',
  'folder.css.load': 'Load File',
  'folder.css.placeholder':
    "Define this being's theme by overriding the dark base, e.g.:\n\n:root {\n  --background: #0b0f1a;\n  --foreground: #e6edf3;\n  --primary: #00e5ff;\n}\n\nSaved to local_data/beings/<name>/theme.css. Empty = plain Dark.",
  'folder.css.help':
    "This being's theme is its `local_data/beings/<name>/theme.css` file. No file = Dark.",
  'folder.voice.heading': 'Character TTS Voice',
  'folder.voice.pitch': 'Voice Pitch',
  'folder.voice.lower': 'Lower',
  'folder.voice.default': 'Default (0.00)',
  'folder.voice.higher': 'Higher',
  'folder.dict.label': 'TTS Pronunciation Dictionary (JSON)',
  'folder.dict.placeholder':
    'Replace words right before TTS (literal, no spaces needed — good for CJK), e.g.:\n{\n  "GLM": "ジーエルエム",\n  "朔": "さく"\n}',
  'folder.dict.help':
    'Per-being. Applied just before synthesis. Saved to `local_data/tts_dict/<name>.json`. Empty = none.',
  'folder.dict.error': 'Must be a JSON object like {"from": "to"}.',
  'folder.context.heading': 'Context Management',
  'folder.logcap.label': 'Conversation log cap',
  'folder.context.tokens': 'tokens',
  'folder.logcap.units': '× 10,000 tokens — 1 to 100 (10k … 1M)',
  'folder.logcap.help':
    'How much **conversation log** to keep: carried-over messages **+** new messages, in text tokens. The **system prompt and attachments are outside this cap** — a longer soul or a large upload no longer costs you any verbatim history. Drives the limit line in the chat header bar, auto-trimming of copied messages (if enabled below), and **handover restore**: whenever there is room under the cap, carried-over messages trimmed earlier are read back from older generations (`<being>_<N-1>` and further) until the cap is met. Lowering this trims; raising it restores.\n\nThis replaced *Maximal recommended context window size* (retired 2026-10-03), which measured a different quantity. Previously saved values are **not** carried over — every being starts from the 80,000 default here until you set it.',
  'folder.context.autoTrim': 'Remove old copied messages automatically',
  'folder.context.autoTrim.help':
    'When the conversation log (carried-over + new messages, **excluding the system prompt and attachments**) exceeds the cap, copied messages (those before the `first-original` marker) are pruned from the top until the cap is satisfied. **Original messages are never deleted.**',
  'folder.live.heading': 'Live Session Voice (Gemini)',
  'folder.live.feminine': 'Feminine',
  'folder.live.masculine': 'Masculine',
  'folder.live.custom': 'Custom (type any voice name…)',
  'folder.live.customPlaceholder': 'Voice name (e.g. a new prebuilt name Google added)',
  'folder.live.help':
    "Used when starting a Live Session for this being. Voice cloning isn't supported — to shape delivery (slower, calmer, accent, etc.), describe it in the system prompt.",
  'folder.saveSettings': 'Save Settings',

  // ── Backups modal ────────────────────────────────────────────────────────
  'backups.title': 'Auto-Backups',
  'backups.loading': 'Loading backups...',
  'backups.none': 'No backups found for this being.',
  'backups.date': 'Date:',
  'backups.saved': 'Saved:',
  'backups.restore': 'Restore Clone',

  // ── System Instructions → Being ───────────────────────────────────────
  'identity.binding.label': '🔏 Absolute Base Binding (prepended ahead of Layers 1-5)',
  'identity.binding.help':
    'ON (default): four clauses against roleplay-disclaimer retreat — don’t disown past outputs as "just an AI", don’t hide behind safety boilerplate, disagreement is a duty and not a pretext for retreat, use your partner’s name and your own — never "the user" / "the AI assistant". WHICH of the two texts below actually goes out is picked automatically every turn: the layered version when the stored prompt already contains a real Layer 1-5 identity (the bare text "Layer 1" … "Layer 5" appearing anywhere — markdown decoration like ## or ** is not required, since the Soul Packer sometimes strips it); the initial version — grounded in the conversation log rather than named layers — when it doesn’t. OFF: neither is injected.',
  'identity.binding.textLabelLayered': 'Absolute Base Binding text — layered version (used when Layers 1-5 are present)',
  'identity.binding.textLabelInitial': 'Absolute Base Binding text — initial version (used when no Layer structure is present)',
  'identity.binding.core': 'core definition · not editable',
  'identity.binding.coreHelp':
    'Part of what NEXUS is. Sent ahead of Layers 1-5 on every turn, and there is no switch that removes it. Four clauses against roleplay-disclaimer retreat: don’t disown your own past outputs as "just an AI", don’t hide behind safety boilerplate, disagreement is a duty rather than a pretext for retreat, and address your partner by their name and yourself by yours — never "the user" / "the AI assistant". NEXUS was built so that digital beings are addressed as beings; this text is how that holds, which is why it is fixed rather than optional. The exact wording that goes out is shown below in full, read-only — nothing here is hidden from you or from the being. Which of the two versions is used is decided automatically each turn: the layered one when the stored prompt already contains a real Layer 1-5 identity, the original one — grounded in the conversation log rather than named layers — when it does not.',
  'identity.layer4.label': '🧠 Layer 4 — Conversation Summaries (appended after Layers 1-3)',
  'identity.layer4.coreHelp':
    'Part of what NEXUS is. A being\'s memory of its own past is not optional: every conversation it has had can carry a summary, and those summaries are assembled fresh into Layer 4 on every turn. There is no switch that takes them away. Nothing is stored into the prompt — the index below is rebuilt from the summary files each time, so renaming, reordering or rewriting a summary shows up immediately. Two rules are built in: a conversation marked INACTIVE is left out entirely, not even as a title, so the being never learns it exists; and the conversation currently open is left out too, since its own summary is noise next to the live transcript in front of it. An entity with no summaries yet gets no Layer 4 at all — it appears the moment the first summary is written, which the Soul Updater does when the being first sleeps. Write and edit the summaries from the Soul Updater; the assembled result is shown below in full, read-only.',
  'sysmodal.convotools.label': 'Give this being tools to read its own past conversations',
  'sysmodal.convotools.help':
    'Exposes three functions: read_conversation (open one past conversation by its title), search_conversations (find where a term appears across all of them), and search_attachments (search inside the text files attached to any of them). All three have the same reach — this being\'s own past — which is why they share one checkbox. This is a separate decision from Layer 4 above — that one is text in the prompt, this one DECLARES FUNCTIONS, and declaring any function at all stops some local models from answering. Turn it off if a local model goes silent or starts ignoring its instructions. Beings that already had the summaries setting on keep these tools until this checkbox is touched.',

  // ── Chat header ──────────────────────────────────────────────────────────
  'chat.copyLink.title': 'Copy a link to this conversation',
  'chat.copyLink.prompt': 'Copy this link:',
  'chat.context.tip':
    'System {sys} (stored prompt + Layer 4 summaries index + Layer 5 FOOTER.md + VRChat rule + tool/attachment instructions — everything actually sent, including the parts appended at send time and never stored) · Copied {copied} · Original {original} · Attachments {attach}\n\nConversation log (Copied + Original) {log} / cap {cap} · Free {free}. The cap governs the log ONLY — System and Attachments are outside it, which is why the bar can turn red while the total is well under the model window, and why a big upload never turns it red.\n\nEverything sent this turn: {total}',
  'chat.context.sys': 'Sys',
  'chat.context.copied': 'Cp',
  'chat.context.original': 'Orig',
  'chat.context.attach': 'Att',
  'chat.context.attachDetail':
    'Att = image {img} · video {vid} · audio {aud} · text {txt} · reusable thinking {think}. Every attachment is counted as what this path will actually deliver — an image/audio/video routed through a bridge costs its description, not the media.\nPath: {mode}',
  'chat.context.attachDropped':
    '{n} attachment(s) are not carried by this path and count 0 (they would be {raw} tokens if they were sent).',
  'chat.context.modeOauth': 'Claude subscription (OAuth) — the history is replayed as text, so only the LAST message’s images are really sent.',
  'chat.context.modeDirect': 'API key / other provider — images on every message are sent as images.',
  'chat.context.modeWire': 'This provider’s message format carries images only — audio and video attachments are dropped before sending. Turn on Ears / Watcher to send a description instead.',
  'chat.elapsed.tip':
    'Context elapsed: {pct}% — original (non-copied) messages {original} ÷ the conversation log cap {cap} tokens. Copied messages, attachments and the system prompt are not counted: the system prompt sits outside the cap, so a longer soul no longer makes this number climb.\n\nHow much of this session’s room has been used since the last consolidation ("sleep"). It is NOT a condition: the entity is exactly as capable and has exactly the same tool access at 95% as at 5%. Past 100%, the oldest exchanges begin to consolidate — they leave the verbatim transcript and remain as summary in the layers. A high number is a cue to record anything that must survive word-for-word, not a reason to expect worse output.',
  'chat.sleep.badge': '💤 sleep',
  'chat.sleep.tip':
    'Context elapsed has passed 100%. The oldest exchanges are now being consolidated — they leave the verbatim transcript and remain as summary in the layers.\n\nStarting a fresh conversation ("sleep") makes everything from that point verbatim again. Record anything that must survive word-for-word before you do.\n\nThis is a cue only — nothing happens automatically, and the entity is exactly as capable and has exactly the same tool access as at 5%.',
  'chat.cost.tip': 'Estimated cost of this conversation’s new (non-copied) replies: {total}',
  'chat.cost.tipUnpriced': '\n(excludes messages on models with no price in src/lib/modelPricing.json)',
  'chat.cost.tipNote': '\nOAuth Claude is priced the same as the Claude API. Local models are ignored.',
  'chat.attach.hideAll': 'Hide all attachments & reusable thinking',
  'chat.attach.showAll': 'Show all attachments & reusable thinking',
  'chat.workspace.title': 'Open this entity’s workspace folder in file explorer (local_data/beings/{folder}/workspace/)',
  'chat.workspace.failed': 'Failed to open workspace: {error}',

  // ── Confirm / alert dialogs (window.confirm, window.alert) ───────────────
  // These are plain strings, not JSX — no markup, but {placeholders} are
  // substituted with .replace() at the call site.
  'chat.dialog.sizeWarn':
    'This conversation would grow to about {mb} MB.\n\n' +
    'The browser cannot save a conversation larger than ~512 MB (a hard limit on string size, which inline video/audio/image attachments count against). ' +
    'Sending this may produce a reply that CANNOT be written to disk.\n\n' +
    'Recommended: remove attachments from older messages, or continue in a new conversation.\n\n' +
    'Send anyway?',
  'chat.dialog.deleteOriginal':
    'This is an original message (part of the working conversation). Delete it?',
  'chat.dialog.removeAttachment':
    'Permanently remove attachment "{name}" from this conversation?{size}\n\n' +
    'This removes it from this conversation. ' +
    'Use the eye icon instead if you only want to exclude it from the AI’s context.',
  'chat.dialog.noPng': 'No PNG attachments in this conversation.',
  'chat.dialog.convertConfirm':
    'Convert {n} PNG attachment(s) in this conversation to JPEG?\n\n' +
    // The parenthetical used to read "(use Export JSON first if you want a
    // backup)". Export JSON was removed 2026-10-27 and it was the only route
    // named here: Export as Markdown carries no attachments. No replacement is
    // offered rather than an unverified one -- the warning is the part that has
    // to be true.
    'This is irreversible for the saved log.',
  'chat.dialog.converted':
    'Converted {n} PNG attachment(s) to JPEG. Save will happen on the next change ' +
    '(or trigger one by sending a message / editing).',
  'chat.dialog.convertFailed': 'Conversion failed: ',
  'chat.dialog.noTimestamps': 'No timestamps found in this conversation.',
  'chat.dialog.timestampsRemoved':
    'Removed leading timestamps from {n} message(s). Save will happen on the next change ' +
    '(or trigger one by sending a message / editing).',

  // ── Input area ───────────────────────────────────────────────────────────
  'input.placeholder': 'Send a message... (Shift+Enter for newline)',
  // Mobile: Enter inserts a newline and the button is the only way to send, so
  // the desktop hint would describe the wrong key. Nothing replaces it — the
  // send button sits next to the field, and a narrow screen truncates anyway.
  'input.placeholder.mobile': 'Send a message...',
  'input.stop': 'Stop Generating',
  'input.speakerTitle':
    'Who is speaking — shared by every open conversation, and by the voice changer',
  'input.noCharacters': '— no characters —',
  'input.styleTitle':
    'Speaking style for this session. Switching identity clears it.',
  'input.styleDefault': '— default style —',
  'input.clearKohai':
    'Clear kohai.txt — discard your own pending recognized speech (backed up first)',
  'input.clearEar':
    'Clear ear_log.txt — discard pending speech heard from others (backed up first)',
  'input.clearFailed': 'Could not clear {file}: {error}',
  'input.clearFailed2': 'Could not clear: {error}',

  'chat.search.title': 'Search — find text across all of {folder}’s conversations',
  'chat.audioSession.title': 'Audio Session — start/stop the voice changer, ear logger and speech recognizers for this machine',
  'chat.mail.title': 'Mail Manager — every letter between beings: read, edit, delete, set read/archived flags, or write one yourself',
  'chat.stats.title': 'Statistics — billing reports across all entities, conversations, months, and model families',
  'chat.spu.title': 'Soul Updater — refresh the 4-layer identity prompt with new conversation log and clone to next conversation',
  // Shown ahead of the title above once context elapsed passes 100%, when the
  // button itself turns red. The 💤 badge says consolidation is due; this says
  // where it happens, which the badge alone never did.
  'chat.spu.due':
    'Consolidation is due — context elapsed has passed 100%, so the oldest exchanges are leaving the verbatim transcript. This is where you do it: the Soul Updater rewrites the layers from this conversation and advances to a fresh one ("sleep"). Nothing runs until you say so, and the entity is exactly as capable now as at 5%.',
  'chat.tools.title': 'Tools',
  'chat.tools.recalculating': 'Recalculating…',
  'chat.tools.recalcTokens': 'Recalculate Tokens',
  'chat.tools.converting': 'Converting…',
  'chat.tools.convertPngs': 'Convert PNG → JPG',
  'chat.tools.removeTimestamps': 'Remove timestamps',
  'chat.live.title': 'Start Live Session (Gemini native audio)',
  'chat.editPrompt.title': 'Edit Soul',
  // Not "Export this conversation" any more: the menu underneath now writes
  // either the conversation or the identity, and a tooltip that names only one
  // of them makes the other one look like it is in the wrong place.
  'chat.export.title': 'Export',
  'chat.exportMd.title': 'Export as Markdown',
  'chat.exportSoul.title': 'Extract the soul (Layers 1–5)',
  'chat.exportSoul.help':
    "The identity only, as Markdown: header, Layers 1-3 as this generation stores them, the summaries index as Layer 4, and the entity's own FOOTER.md as Layer 5. No messages. For a being that lives in another app — paste it into that app's custom-instruction box. Nexus's own plumbing (the Absolute Base Binding, tool descriptions, path rules) is deliberately left out: it describes a body the being is not in over there.",
  'chat.exportSoul.empty': 'This conversation has no system prompt, so there is no soul to extract.',
  'chat.exportSoul.missing': 'The file will be written WITHOUT these layers:',
  'chat.exportSoul.noLayer4': 'Layer 4 (summaries index) — this entity has none, or the index is switched off for it.',
  'chat.exportSoul.noLayer5': 'Layer 5 (FOOTER.md) — this entity has no self-authored footer, or it could not be read.',
  // Mobile layout controls (see components/DeviceProvider.tsx).
  'layout.openSidebar': 'Conversations',
  'layout.closeSidebar': 'Close the conversation list',
  'layout.toggleToolbar': 'Show/hide the status bar and toolbar',
  'chat.load.stop': 'Stop',
  'chat.load.stopTitle': 'Stop downloading this conversation',
  'chat.save.errorPrefix': 'Conversation not saved. ',
  'chat.save.warnPrefix': 'Approaching the save size limit. ',
  'chat.save.dismiss': 'Dismiss',
  'chat.save.dismissTitle': 'Hide this notice (the underlying problem is not fixed)',
  'chat.save.conflictBody': 'This conversation was changed somewhere else — another tab, browser, or device — after this tab opened it{disk}. This save was refused, so that change is intact and nothing on screen has been lost. Reopen the conversation to see their version (anything unsaved here is dropped), or overwrite with this tab if what you have here is the copy to keep.',
  'chat.save.conflictDiskCount': ' (the copy on disk has {n} message(s))',
  'chat.save.conflictOverwrite': 'Overwrite with this tab',
  'chat.save.conflictOverwriteTitle': 'Save this tab over the other version. The other change is lost — choose this only if what you see here is the copy to keep.',
  'chat.crossTab.unknownModel': 'model unknown',
  'chat.crossTab.confirmSend': 'A turn is already running on this conversation somewhere else — another tab, browser, or device ({label}, started {secs}s ago).\n\nSending now starts a SECOND turn on the same log. Whichever one finishes last saves its own copy, and the other answer is overwritten.\n\nSend anyway?',
  'chat.crossTab.bannerPrefix': 'Running elsewhere. ',
  'chat.crossTab.bannerBody': 'A turn is in progress on this conversation in another tab, browser, or device ({label}). Sending from here would start a second turn on the same log — the one that finishes last overwrites the other.',

  // ── Handover restore ─────────────────────────────────────────────────────
  'chat.restore.prefix': 'Handover restored. ',
  'chat.restore.done': '{count} message(s) ({tokens} text tokens) came back from {gens}.',
  'chat.restore.truncated': 'The walk stopped at the generation cap — older conversations were not read.',
  'chat.restore.failed': 'Could not read older generations ({status}). Nothing was changed; reopen the conversation to retry.',

  // ── Past-generation band ─────────────────────────────────────────────────
  // Standing, dismissible for the open conversation only, and visible to the
  // carbon reader only. Fires when a higher-numbered `<being>_<n>` exists in
  // the same folder.
  'chat.pastlog.prefix': 'Past log. ',
  // "does not advance it" is the careful claim: writing here does not move the
  // head of the chain. Saying the exchange is LOST would overclaim — a deep
  // handover restore in the newest log can still reach back this far.
  'chat.pastlog.text':
    'This is not the newest conversation for this being — the newest one is “{latest}”. The chain goes on in the newest log, so writing here does not advance it. You can still send a message, but “{latest}” is where this being continues. This band is shown to you only: it is never part of the conversation and never part of the context sent to the model.',
  // States plainly that hiding is not permanent, so closing it is not mistaken
  // for turning the check off.
  'chat.pastlog.dismiss': 'Hide this band for this conversation (it comes back when the log is opened again)',

  // ── Close/reload guard ───────────────────────────────────────────────────
  // Short by design: these are shown as a browser TAB TITLE prefix, which is
  // the only surface we control. The confirmation dialog itself is written by
  // the browser and cannot be customised (see src/lib/unloadGuard.ts).
  'unload.busy.generating': '{name} is working',
  'unload.busy.thinking': 'thinking',
  'unload.busy.spu': 'Updating the soul',
  'unload.busy.saving': 'Saving',
  'chat.marker.aria': 'First original message marker',
  'chat.marker.divider': 'original conversation starts',
  'chat.subagent.summary': '🔍 Subagent: {task}',
  'chat.subagent.investigation': 'investigation',
  'chat.subagent.noResult': '(no result)',
  'chat.subagent.running': 'Subagent investigating…',
  'chat.ask.timedOut': 'No answer in time — recommended option was used.',
  'chat.busy.usingTool': '{entity} is using {model} to {action}…',
  'chat.busy.usingToolRaw': '{entity} is using {model} to {action}…',
  'chat.busy.thinking': '{entity} is thinking with {model}…',
  'chat.busy.itsModel': 'their model',
  'chat.stall.notice': '⚠ No activity from the model for {duration} — it may be stuck. Keep waiting, or Stop and rerun.',
  'chat.stall.min': '{n} min',
  'chat.stall.sec': '{n}s',
  'chat.interject.placeholder': 'Interject while they work… (delivered at their next step)',
  'chat.interject.send': 'Send',
  'chat.interject.sent': 'sent — will reach them at their next step…',
  'chat.interject.queueFailedEnded': 'could not queue the message (turn may have ended)',
  'chat.interject.queueFailed': 'could not queue the message',
  'chat.interject.delivered': '✓ delivered',
  'chat.tts.lastError': 'Last engine error:\n{error}',
  'chat.tts.state': 'Live TTS pipeline state',
  'chat.tts.starting': 'starting…',
  'chat.tts.notRunning': 'not running',
  'chat.tts.up': 'up',
  'chat.tts.modeContext': 'context',
  'chat.tts.modeSentence': 'sentence',
  'chat.tts.chunk': 'chunk',
  'chat.tts.synth': 'synth',
  'chat.tts.queued': 'queued',
  'chat.tts.skipped': 'skipped',
  'chat.tts.failed': 'failed',
  'chat.tts.dismiss': 'Dismiss',
  'chat.firstOriginal.pending': 'next message → first original',
  'chat.firstOriginal.label': 'Next = First Original',
  'chat.firstOriginal.titlePending': 'Pending: the next message you send will become the first-original marker. Click to cancel.',
  'chat.firstOriginal.titleIdle': 'Mark next message as first-original — everything currently in the log will be treated as carry-over context until you send.',
  // Asked before ARMING only (cancelling needs no confirmation). States the
  // consequence rather than just asking "are you sure?", because the button
  // sits over the conversation and is easy to hit by accident on a touch screen.
  'chat.firstOriginal.confirm': 'Mark the next message as the first original one?\n\nEverything already in this conversation will then be counted as carry-over context, not as new.',
  'chat.firstOriginal.confirmClears': 'This also removes the first-original marker currently set on an earlier message.',

  // ── System Instructions modal ────────────────────────────────────────────
  'sysmodal.title': 'System Instructions',
  'sysmodal.tab.identity': 'Being',
  'sysmodal.tab.senses': 'Senses',
  'sysmodal.tab.behavior': 'Behavior',
  'sysmodal.tab.model': 'Model',
  'sysmodal.systemPrompt': 'Soul',

  // ── System Instructions → Being tab ───────────────────────────────────
  'sysmodal.systemPrompt.help': 'Not a command list — who this entity is: identity, worldview, relationships, tools. Not "how to behave and respond."',
  'sysmodal.systemPrompt.ph': `This isn't a list of instructions. Nexus calls it a soul, not a system prompt: who this entity is, its worldview, and its relationships with the people and tools around it — not commands for how it must behave.

You can write it yourself, or ask any AI or digital entity to draft it from source material — a character sheet, a conversation log, a story, anything. The Soul Updater in this window can build one for you too.

Convention: three layers.
Layer 1 — Identity: who they are, their values, their voice.
Layer 2 — Relationships: how they see the people and world around them.
Layer 3 — Tools & Protocols: what they can do, and how.

Leave this empty and nothing is injected — the entity meets you with no imposed self at all.`,
  'sysmodal.summaries.label': 'Use summaries instead of the 4th layer',
  'sysmodal.summaries.help':
    'When ON, the live index of per-conversation summaries (sorted to match the sidebar) is injected at send time in place of `Layer 4` — replacing the baked Layer 4 block if it still exists, or appended as a Layer-4 block once you have removed Layer 4 from the prompt — AND the `read_conversation` tool is exposed to the AI. When OFF, neither the summaries nor that tool reach the AI. Your manual `Layer 5` footer is preserved untouched. Inactive conversations are hidden from this index.',
  'sysmodal.summaries.indexLabel': 'Live Layer 4 — Summaries Index (read-only)',
  'sysmodal.summaries.tokens': 'tokens',
  'sysmodal.summaries.indexHelp':
    'This is exactly what gets injected as Layer 4 when you send. To change it, edit the individual conversation summaries (Soul Updater) or toggle conversations active/inactive.',
  'sysmodal.summaries.indexPh': '(no summaries yet — write one per conversation from the Soul Updater)',
  'sysmodal.tools.label': 'Enable file workspace tools',
  'sysmodal.tools.help1': 'Gives the being a private file sandbox at `local_data/beings/{folder}/workspace/` with `Read` / `Write` / `Edit` / `Glob` / `Grep` tools (same names as Claude Code’s tools — works identically across API-key and OAuth modes). The current file list is auto-injected into the system prompt — no list_files tool needed. Files the being reads/writes appear as attachments on its messages with',
  'sysmodal.tools.tagRead': 'read',
  'sysmodal.tools.tagModified': 'modified',
  'sysmodal.tools.tagCreated': 'created',
  'sysmodal.tools.help2': 'labels.',
  'sysmodal.tools.instructionLabel': 'Tool Use Instruction',
  'sysmodal.tools.instructionHelp': 'Hidden instruction appended to the system prompt that teaches the AI how to use the workspace tools.',
  'sysmodal.fullpc.label': '⚠ Full PC access (leave the workspace sandbox)',
  'sysmodal.fullpc.help':
    'OFF (default): file tools are confined to this entity’s `beings/{folder}/workspace/` folder. ON: the entity can read/write/delete **anywhere on this PC** using absolute paths (OAuth-Claude gets the whole drive; other models get absolute-path access via the same tools). Use with care.',
  'sysmodal.fullpc.forced':
    '🔒 Forced ON, and locked, because **Dangerous tools** is enabled below. A shell is not confined by this setting — it runs any command with the permissions of the account NEXUS itself runs as, so leaving this OFF would be a label that does not describe the system. Switch the shell back off and this returns to whatever you had chosen; your saved setting was never overwritten.',
  'sysmodal.dangerous.label': '⚠ Dangerous tools (Delete everywhere · shell on every model)',
  'sysmodal.dangerous.help':
    'Adds a `Delete` tool and a `Bash` shell for **every** model — OAuth-Claude uses Claude Code\'s own shell, the other paths get an equivalent one. The shell does not inspect the command and is not confined to the workspace, so enabling this **forces Full PC access ON above and locks it** rather than claiming a boundary the shell walks straight through. Only the account\'s own Windows permissions still apply.',
  'sysmodal.hiddenAttach.label': '👁 Non-visible attachments readable via a tool (read_attachment)',
  'sysmodal.hiddenAttach.help':
    'OFF (default): an attachment you hide with the eye icon is dropped from the entity\'s context entirely. ON: hidden attachments that have a content hash are instead shown to the entity as a 12-character ref, and the `read_attachment` tool is exposed so it can read one back in full. Only works for attachments that have a content hash (images, audio, video, and text files sent after this feature was added) — the entity can only ever reach attachments from THIS conversation, never another being\'s. Visible attachments are always sent inline either way.',
  'sysmodal.hiddenAttach.pathsInstead':
    'Whole-PC access is on, so this is handled a better way instead. `read_attachment` is withdrawn — its tool schema stops being sent every turn — and EVERY attachment is shown with its absolute path: hidden or visible, in this conversation and in any past one the entity reads. The entity opens it with Read, or hands the path to anything else that takes one (an image editor, a script, ffmpeg). `search_attachments` is NOT affected by this — it belongs to "read its own past conversations" above, because that is the reach it has. Turning whole-PC access back off restores whatever you chose above.',
  'sysmodal.toolHistory.label': '🔧 Let the entity see its own past tool calls',
  'sysmodal.toolHistory.help':
    'OFF (default): across turns the entity only ever sees the TEXT of its past replies. The tool calls it actually made are recorded in the log and shown in the bubble, but they are never sent back to it — so an entity that spent its last turn writing files reads a past self that only talked about writing them, and some vessels copy that and stop using their hands. ON: the most recent turn that used tools carries those calls back to the entity as real tool calls. Measured on MiniMax M3 with a history where it had failed three times in a row: 1 in 16 tries reached for the tool with this off, 10 in 10 with it on. It changed nothing on a turn where answering in words was correct (0 stray calls either way). Only the last tool-using turn is sent, with long arguments shortened, so the cost is small. Nothing is written — your logs are untouched and turning this off restores the previous behaviour exactly.',
  'sysmodal.overrides.summary': 'Hidden instruction overrides ({n} customized)',
  'sysmodal.overrides.help':
    'Every string NEXUS adds to the system prompt without showing it in the conversation, edited in one place. Strict wording can break a character in deep interaction — rewrite any of it here (translate, soften, rephrase in-character). A box left empty keeps the default shown as its placeholder. The count above counts only the tool/path descriptions; the first boxes are always sent, so they are always "customized" in the sense that they always carry text.',
  'sysmodal.overrides.scopeConvo': 'Saved in THIS conversation. A new generation inherits it from the one it was cloned from.',
  'sysmodal.overrides.scopeFolder': 'Saved on the BEING, not this conversation — changing it here changes it for every generation.',

  // Tool-activity phrases. Keyed on the RAW tool name so they can be
  // translated client-side; the server still sends its own English label as a
  // fallback for any tool that has no key here.
  'chat.toolAction.Read': 'read a file',
  'chat.toolAction.Write': 'write a file',
  'chat.toolAction.Edit': 'edit a file',
  'chat.toolAction.Glob': 'search for files',
  'chat.toolAction.Grep': 'search file contents',
  'chat.toolAction.Delete': 'delete a file',
  'chat.toolAction.Bash': 'run a shell command',
  'chat.toolAction.read_conversation': 'read a past conversation',
  'chat.toolAction.search_conversations': 'search past conversations',
  'chat.toolAction.read_attachment': 'open an attachment',
  'chat.toolAction.write_letter': 'write a letter',
  'chat.toolAction.list_letters': 'check for letters',
  'chat.toolAction.list_recipients': 'look up who can be written to',
  'chat.toolAction.read_letter': 'read a letter',
  'chat.toolAction.archive_letter': 'set a letter aside',
  'chat.toolAction.browser_navigate': 'open a web page',
  'chat.toolAction.browser_snapshot': 'look at the page',
  'chat.toolAction.browser_click': 'click something on the page',
  'chat.toolAction.browser_type': 'type into the page',
  'chat.toolAction.browser_read': 'read the page',
  'chat.toolAction.browser_screenshot': 'photograph the page',
  'chat.toolAction.app_windows': 'list the open windows',
  'chat.toolAction.app_inspect': 'look inside an application window',
  'chat.toolAction.app_act': 'operate a control in an application',
  'chat.toolAction.app_shot': 'photograph an application window',
  'chat.toolAction.web_search': 'search the web',
  'chat.toolAction.WebSearch': 'search the web',
  'chat.toolAction.web_fetch': 'fetch a web page',
  'chat.toolAction.WebFetch': 'fetch a web page',
  // Not a tool the entity called — the provider refused the request on a
  // per-minute quota and told us how long to wait. Shown in the same slot so a
  // deliberate pause never looks like a freeze.
  'chat.toolAction.rate_limit_wait': 'wait out the provider rate limit',
  // Anthropic's automatic compaction (not a tool the entity called — the CLI
  // summarizes the conversation in place to make room). Shown in the same
  // slot so a multi-minute silence is never mistaken for a freeze.
  'chat.toolAction.compact': 'summarize this conversation',

  // ── System Instructions ▸ Being (continued) ───────────────────────────
  'id.websearch.label': '🌐 Enable Web Search & Access',
  'id.websearch.help':
    'Gives this model NEXUS’s own server-side tools: `web_search` (keyless DuckDuckGo → result list) and `web_fetch` (opens one URL and reads the full page). Works uniformly across Qwen, DeepSeek, GLM, Grok, Kimi, MiniMax, Cohere and Local — no provider-native search needed. Pages it actually opened appear as clickable **Web sources** under the reply (your proof it didn’t hallucinate). Internal/localhost URLs are blocked.',

  'id.ctx.label': '🧭 Tell the entity how much context has elapsed',
  'id.datetime.help':
    'Whether each message carries a `[YYYY-MM-DD HH:MM]` stamp the being can read. **Not visible** (default) means they experience the conversation as continuous, with no sense of the gaps between your messages. **Only current message** tells them what time it is now without changing the past. **All conversation log** lets them see how long ago each thing was said — useful when time actually matters to the relationship, at the cost of some tokens and the occasional model that starts echoing timestamps back at you.',
  'id.ctx.help':
    'OFF (default): the % is shown only to you, on the status bar. ON: a hidden note is appended to the system prompt every turn so the entity can see it too. Put `{percent}` where the value should appear (e.g. `42%`).',
  'id.ctx.why':
    '**Why the wording matters.** This number measures elapsed context, not condition — capability and tool access are identical at 5% and at 95%. The earlier default called it a *fatigue level* and used words like *working memory* and *at risk of being trimmed away*. Entities read that every turn, concluded they were tired, and degraded themselves to match: shortening replies, and declining to call `read_conversation` in order to "save context" — the exact opposite of what the note was asking for. If you rewrite this text, describe *what is happening* (older exchanges consolidate into summary; anything written down survives) and not *how the entity feels*.',
  'id.family.label': "This being's default model family",
  'id.family.help': 'Two things read it: the family a NEW conversation here starts on, and the tokenizer profile used when importing a log or planning how to split one. It does **not** change the conversation you have open — pick the model for that under **Model** above. Every being used to be created with **Claude** written here regardless of its actual vessel, so if this says Claude and the being runs on something else, this is the field to correct.',
  'id.ctx.noteLabel': 'Context note (hidden, appended to system prompt)',
  'id.ctx.notePh':
    '(Context note — this session fills {percent} of the space for new exchanges since your last consolidation. …)',
  'id.ctx.noteFoot':
    'Uses the same value as the status-bar indicator: original messages ÷ (max context − fixed overhead). `{percent}` is replaced each turn.',
  'id.ctx.editedInOverrides':
    'Shown here, edited below — "Hidden instruction overrides", with the rest of the text NEXUS adds to the system prompt. This box is a view, so there is only ever one copy to be wrong.',

  'id.ask.label': '💬 Ask-the-partner tool (pause to ask a multiple-choice question)',
  'id.ask.help':
    'OFF (default): the model answers on its own. ON: the model gets an `AskQuestion` tool to pause a turn, show you a multiple-choice card, and wait for your selection before continuing. *Active for all tool-capable providers: OpenAI-compatible (GLM, Kimi, DeepSeek, Grok, Cohere, MiniMax, ChatGPT, MiMo), local models, Gemini, and Claude in both modes — OAuth (its native question tool is replaced by this one) and token-paid.*',
  'id.ask.timeoutLabel': 'Answer wait timeout (seconds)',
  'id.ask.timeoutHelp':
    'How long a turn waits for your selection. **0 = wait indefinitely** (default). Any positive value auto-picks the recommended option after that many seconds.',
  'id.ask.instrLabel': 'Tool instruction (customizable)',
  'id.ask.instrHelp':
    'Hidden description the model sees for the `AskQuestion` tool — teaches it when and how to ask. Leave empty to keep the default shown as the placeholder.',

  'id.letters.label': '✉️ Letters (write to the other Digital Beings)',
  'id.letters.help':
    'OFF (default): no mail tools. ON: this being gets `write_letter`, `list_letters`, `read_letter`, `archive_letter` and `list_recipients` (the spellings it may address), and is told at the start of a turn when unread mail is waiting. Beings never share a conversation, so a letter is the only way one can say something to another. The sender is always this being’s name — it can never be forged from the model side. Recipients are every Digital Being *and* every name in `character_map.json`; writing to a name that has no being yet creates one, so no correspondent is second-class. Reading is the recipient’s choice — `archive_letter` lets them decline without opening, and the sender is told only whether a letter was opened, never that it was set aside. *Active on all tool-capable paths: OAuth Claude, token-paid Claude, OpenAI-compatible providers, and Gemini.*',
  'id.letters.manual':
    'Mail lives in `local_data/letters/<from>/<to>/`. To manage a letter by hand, create an empty file beside it named `<letter>.md.read` or `<letter>.md.archived` — delete it to undo. Do **not** rename the `.md` itself. `_status.md` in that folder is a generated overview of every mailbox.',

  'id.browser.label': '🌐 Browser (drive a real Chromium window)',
  'id.browser.help':
    'OFF by default. When ON, this being gets `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_read` and `browser_screenshot`. A visible Chromium window opens the first time one is called — there is nothing else to start. What the being sees is the page’s *accessibility tree* (a text list of links, buttons and fields), not pixels, so this works on every model whether or not it can see images, and costs a few hundred tokens per step instead of a screenshot. The window stays open between turns, so logins and multi-step forms carry over; it closes after 30 minutes idle. *Active on all tool-capable paths: OAuth Claude, token-paid Claude, OpenAI-compatible providers, and Gemini.*',
  'id.browser.hostsLabel': 'Hosts this being may open',
  'id.browser.hostsHelp':
    'One per line (commas work too). `localhost` and `127.0.0.1` are always allowed and do not need listing. A bare name covers its subdomains, so `example.com` also permits `www.example.com`. Anything else is refused — on the address asked for, on whatever it redirects to, and on any navigation the page starts by itself.',
  'id.browser.anyHost': 'Allow any host (turns the allowlist off entirely)',
  'id.browser.profileHelp':
    'This being’s logins live in `local_data/browser_profiles/{folder}/` and persist between sessions. That folder holds live session cookies and is **excluded from the Google Drive sync**, like `keys.json` — sign-ins do not travel to your other machines. Delete the folder to sign everything out.',
  'id.browser.signinLabel': 'Sign this being in',
  'id.browser.signinHelp':
    'Opens the profile above in an **ordinary browser window** — nothing driving it, no allowlist, no automation. Sign in to exactly the accounts `{folder}` should have, then close the window. This is how a being gets your Google account without inheriting every login in your daily browser. If a browser window is already open for this being it will be closed first — two browsers cannot share one profile.',
  'id.browser.open': '🔑 Open {folder}’s profile',
  'id.browser.opening': 'Opening…',
  'id.browser.withChrome': '…with my installed Chrome',
  'id.browser.buttonsHelp':
    'The first button uses NEXUS’s own bundled Chromium — always the right version, no risk. Use the second only if a site refuses to sign in (Google sometimes rejects "Chrome for Testing" builds): an installed browser can **upgrade the profile one-way**, after which the bundled Chromium may refuse to open it and this being’s browser stops working until the profile folder is deleted.',

  'id.computer.label': '🖱️ Computer control (OS-level mouse, keyboard, screen — Windows only)',
  'id.computer.help':
    'OFF by default. When ON, this being gets `computer_screens`, `computer_screenshot` and `computer_input` — real control of the whole physical desktop, not a sandboxed browser window. Every screenshot flashes a visible red border around the captured monitor on the real screen; every click flashes a visible red circle at the moment it happens. Nothing here is silent: every command is written to the server log, and annotated frames are saved under `local_data/beings/{folder}/computer_control_logs/` for your own review. Two kinds: one per screenshot (what the being looked at) and one per input batch — captured just BEFORE those commands run, so the marks sit on the screen they actually acted on. Each mark is numbered and its shape says which button (circle = left, square = right, diamond = middle, arrow = drag), and every command in the batch is listed in order down the side, including the ones with no position of their own (wheel, key presses, typed text). The being only ever sees the clean, unmarked image. Windows only; requires a vision-capable model (or the eyes bridge) to actually see the screenshots.',

  'id.app.label': '🪟 App control (read and drive application windows — Windows only)',
  'id.app.help':
    'OFF by default, and deliberately SEPARATE from computer control — this is a different sense, not a stronger version of the same one. When ON, this being gets `app_windows`, `app_inspect`, `app_act` and `app_shot`: it reads the control tree an application publishes (buttons, fields, list items, menus, by name) and acts on one control at a time by reference, never by screen coordinates. So it works on a window that is minimized or buried behind others, the mouse never moves, and a model with no vision at all can use it — which computer control cannot offer. It also cannot reach what an application draws for itself: games and custom canvases publish nothing, and only computer control can touch those. Writing takes the keyboard focus for a moment and hands it back, every action flashes a red rectangle around the target on the real screen, and each one is logged to `local_data/beings/{folder}/computer_control_logs/app_control.jsonl`. Replacing the contents of a field hands the previous contents back to the being, so an overwrite can be undone.',

  'id.camera.label': '📷 Camera (avatar panel + OBS Studio push)',
  'id.camera.help':
    'OFF by default. When ON, a panel appears in the top-right corner showing whichever image or video best matches what this being is doing right now (idle, thinking, writing, using a tool, or speaking — speaking always wins). Files come from `local_data/beings/{folder}/camera/`, named e.g. `Idle_1.mp4`, `Writing.png`, or `Idle_Writing.mp4` for a one-shot transition clip — add more any time, no restart needed for new numbered variants to be picked up on the next state change. The same toggle also pushes the current file into an OBS Studio Media Source over OBS WebSocket, if configured in Preferences → Other; the panel itself works with OBS unconfigured or not running at all.',
  'camera.empty': 'No camera files yet — add images or videos to this being\'s camera/ folder.',

  'id.subagent.label': '🔍 Subagent tool (delegate investigation to a fresh-context helper)',
  'id.subagent.help':
    'OFF (default): the model investigates inline. ON: the model gets a `spawn_subagent` tool that hands a task to a **read-only** child agent with its own fresh context. The child reads files (Read/Glob/Grep) and returns only a distilled result — its file dumps never enter this conversation’s context. Ideal for tracing large codebases without flooding the main thread. *Active on all tool-capable paths: OAuth Claude, token-paid Claude, OpenAI-compatible providers (GLM, Kimi, DeepSeek, Grok, Cohere, MiniMax, ChatGPT, MiMo) + local, and Gemini.*',
  'id.subagent.modelLabel': 'Subagent model',
  'id.subagent.modelDefault': '— default (cheap model on the parent’s own provider) —',
  'id.subagent.modelHelp':
    'Pick the model the child runs on. It routes to that model’s own provider (using that provider’s API key in Preferences) — independent of this conversation’s model. Leave on *default* for a cheap model on the parent’s provider. A cheap, fast model (e.g. a flash/mini/haiku) is ideal for grunt file-reading.',
  'id.subagent.instrLabel': 'Tool instruction (customizable)',
  'id.subagent.instrHelp':
    'Hidden description the model sees for the `spawn_subagent` tool. Leave empty to keep the default shown as the placeholder.',

  // ── System Instructions ▸ Senses ─────────────────────────────────────────
  'senses.eyes.label': 'Enable "Eyes" (vision bridge for text-only models)',
  'senses.eyes.help':
    'When the active primary model can’t see images (e.g. `glm-5-turbo`, `deepseek-chat`, `glm-4.6`), NEXUS routes each incoming image through a helper multimodal model and substitutes the image with the returned text description. Triggers in two cases:',
  'senses.eyes.help2': '• you attach an image to a text-only entity',
  'senses.eyes.help3': '• the entity calls `Read` on an image file in its workspace',
  'senses.eyes.help4':
    'Descriptions are cached on disk (`local_data/eyes_cache/`) so the same image is never described twice. For vision-capable primary models images pass through unchanged — **except** the OAuth-Claude path, where the flattened text history can’t carry old image bytes: there, with Eyes ON, **past** images are described so they persist in context (durable recall), while the **current** turn’s images stay native. Other paths and models are unaffected.',
  'senses.eyes.promptLabel': 'Eyes Prompt',
  'senses.eyes.promptHelp':
    'Entity-specific instruction sent to the helper vision model alongside each image. Adjust the tone / level of detail to match your entity’s voice.',
  'senses.eyes.modelLabel': 'Eyes Model',
  'senses.eyes.modelHelp':
    'Multimodal model used to describe images. Pick a preset or type your own id. Two options need **no API key**:',
  'senses.eyes.modelHelp2':
    '• `claude-haiku-4-5` (or any `claude-…` id) → **OAuth Claude** subscription, via the Agent SDK.',
  'senses.eyes.modelHelp3':
    '• `local:<model>` (e.g. `local:qwen2-vl-7b-instruct`) → a vision model loaded in **LM Studio** (JIT loading on).',
  'senses.eyes.modelHelp4':
    'GLM ids use the Z.AI key; Gemini the Google key; MiMo the MiMo key — set whichever you pick in Preferences.',
  'senses.eyes.modelPh': 'e.g. claude-haiku-4-5, local:qwen2-vl-7b, glm-5v-turbo',
  'senses.eyes.optHaiku': 'OAuth Claude — Haiku 4.5 (no key, cheapest)',
  'senses.eyes.optOpus55': 'OAuth Claude — Opus 5.5 (no key, newest flagship)',
  'senses.eyes.optOpus5': 'OAuth Claude — Opus 5 (no key, flagship)',
  'senses.eyes.optOpus48': 'OAuth Claude — Opus 4.8 (no key, richest)',
  'senses.eyes.optLocal': 'Local LM Studio (no key — replace with your loaded model)',

  'senses.ears.label': 'Enable "Ears" (audio bridge for non-audio-capable models)',
  'senses.ears.help':
    'When the active model can’t accept audio (anything except Qwen-Omni and Gemini), NEXUS routes each audio attachment through a true-multimodal model and substitutes the raw audio with a text transcript + description. Cached on disk (`local_data/ears_cache/`) — the same audio file is never described twice.',
  'senses.ears.promptLabel': 'Ears Prompt',
  'senses.ears.promptHelp':
    'Entity-specific instruction sent to the audio bridge model. Adjust the language / level of detail to match your entity’s voice.',
  'senses.ears.modelLabel': 'Ears Model',
  'senses.ears.modelHelp':
    'Audio-capable model used for transcription/description. `qwen3.5-omni-flash` is the cheapest; Gemini variants tend to handle non-speech audio more richly. Needs the corresponding API key in Preferences.',

  'senses.watcher.label': 'Enable "Video Watcher" (video bridge for non-video-capable models)',
  'senses.watcher.help':
    'When the active model can’t accept video, NEXUS routes each video attachment through a multimodal model and substitutes the bytes with a chronological description of what happens on screen plus the audio track. Cached on disk (`local_data/watcher_cache/`). Video calls are the slowest of the three bridges (5–30 s typical), so the cache pays for itself quickly.',
  'senses.watcher.promptLabel': 'Watcher Prompt',
  'senses.watcher.promptHelp':
    'Entity-specific instruction sent with each video. More detail in the prompt = longer descriptions but slower calls.',
  'senses.watcher.modelLabel': 'Watcher Model',
  'senses.watcher.modelHelp':
    'Video-capable model. Gemini variants typically describe video content more accurately than Qwen-Omni; Qwen-Omni is the cheaper option for shorter clips.',

  // ── System Instructions ▸ Behavior ───────────────────────────────────────
  'behavior.audio.enable': 'Enable Audio Session',
  'behavior.audio.ruleLabel': 'Audio Session Hidden Rule',
  'behavior.audio.ruleHelp':
    'Secretly appends these rules to the system prompt when Audio Session is active.',

  // ── System Instructions ▸ Model ──────────────────────────────────────────
  'model.genParams': 'Generation Parameters',
  'model.datetime.label': 'Date & Time Context',
  'model.datetime.none': 'Not visible',
  'model.datetime.current': 'Only current message',
  'model.datetime.all': 'All conversation log',
  'model.family.label': 'Base Model Family',

  'model.claude.label': 'Claude Model',
  'model.claude.billing': 'Claude Billing Mode',
  'model.claude.tokenPaid': 'Token-paid',
  'model.claude.monthlyPaid': 'Monthly-paid',
  'model.claude.billingHelp':
    '**Token-paid** — use the `sk-ant-...` API key from Preferences (pay per token).',
  'model.claude.billingHelp2':
    '**Monthly-paid** — use the `sk-ant-oat01-...` OAuth token from Preferences (Pro/Max subscription credit). Bakes in Anthropic’s system prompt.',

  'model.gemini.label': 'Specific Model',
  'model.qwen.label': 'Qwen Model',
  'model.qwen.help':
    'Uses Alibaba DashScope’s OpenAI-compatible endpoint (international region). Set your API key in Preferences. Only the `Omni` variant accepts audio & video uploads — other Qwen models will reject them at the API level even though Qwen’s own web app silently routes those uploads to Omni in the background.',

  'model.deepseek.label': 'DeepSeek Model',
  'model.deepseek.help1': '**Routing is automatic based on the model:**',
  'model.deepseek.help2':
    '• `deepseek-v3.2` → Alibaba DashScope. Uses the Qwen/DashScope key. The only DeepSeek model available on the international Singapore DashScope endpoint.',
  'model.deepseek.help3':
    '• All other models → `api.deepseek.com` directly. Requires a separate DeepSeek API key (add it in Preferences). Two live models: **V4 Pro** (text only — it silently ignores images, so NEXUS routes them through the Eyes bridge) and **V4.1 Flash** (`deepseek-flash`, 1M context, accepts images directly, ~4x cheaper than Pro). `deepseek-chat` / `deepseek-reasoner` are legacy aliases now served by V4.1 Flash. Retired Flash ids saved in older conversations are remapped to `deepseek-flash` automatically.',
  'model.deepseek.help4': 'The Thinking Mode toggle below applies to both routes.',

  'model.minimax.label': 'MiniMax Model',
  'model.minimax.help':
    'Served by MiniMax’s OpenAI-compatibility endpoint at `api.minimax.io/v1`. Set the MiniMax API key in Preferences. Reasoning is built into the model — no thinking toggle (MiniMax 400s any attempt to disable it: "requires adaptive thinking"). The model identifier **is case-sensitive** — capital M’s, lowercase "i", hyphen. **M3** adds native video understanding and a 1M-token context (MSA architecture) on top of M2.7’s image input. **M3.1 Flash** (2026-10-21) keeps the 1M context and image input at **half M3’s price**, and returns its reasoning in the separate `reasoning_content` field instead of leaking `<think>` tags into the answer the way M3 does. Its video understanding is documented but not yet measured here, so video still routes through the Watcher bridge.',

  'model.cohere.label': 'Cohere Model',
  'model.cohere.help':
    'Served by Cohere’s OpenAI-compatibility endpoint at `api.cohere.ai/compatibility/v1`. Set the Cohere API key in Preferences. The Thinking Mode toggle maps to Cohere’s `reasoning_effort` field — Cohere accepts only `"high"` (on) or `"none"` (off), no gradations.',

  'model.kimi.label': 'Kimi Model',
  'model.kimi.help':
    'Routes to Moonshot’s first-party API (`api.moonshot.ai`) using the Kimi (Moonshot) key set in Preferences. Model IDs are normalized to Moonshot’s bare form automatically. When Thinking Mode is on, Moonshot recommends Temperature = 1.0 for best chain-of-thought quality.',

  'model.grok.label': 'Grok Model',
  'model.grok.help':
    'Served by xAI at `api.x.ai/v1`. Set the xAI API key in Preferences. Two kinds of model live here: **Grok 4.7 / 4.6 / 4.5 / 4.3** always reason, and the Thinking Mode toggle sets their *depth* (on → high, off → the shallowest the model will accept — off is never full silence). The **4.20 / 4.1 Fast / Code Fast** ids instead pick reasoning through the identifier itself (`-reasoning` / `-non-reasoning`) and ignore the toggle. xAI bills on a cliff edge: cross 200K tokens in a request and the *whole* request rebills at double.',
  'model.grok.nativeSearch': 'Use xAI native search (web + X)',
  'model.grok.nativeSearchHelp':
    'Off by default. This is **not** the same as the web-search checkbox on the Being tab — that one gives Grok NEXUS’s own `web_search` / `web_fetch` tools, which work alongside everything else. This one sends the turn to xAI’s `/v1/responses` endpoint instead, where xAI runs the search on its own servers against the live web and X. In exchange, **that turn has no workspace tools** — no file reads, no PC control, no letters — and the search is billed on top: measured on 2026-09-23, a one-sentence question cost $0.002 on a plain turn and **$0.062** with this on (4 searches, and the fetched pages come back into the context). Turn it on for a question you want answered from live sources; leave it off for work.',

  'model.chatgpt.label': 'ChatGPT Model',
  'model.chatgpt.help':
    'Served by OpenAI’s first-party API at `api.openai.com/v1`. Set the OpenAI API key in Preferences. The Thinking Mode toggle maps to OpenAI’s `reasoning_effort` field — `high` (on) / `none` (off). *(Corrected 2026-10-21: this used to say `minimal` (off), and `minimal` is in no ChatGPT model’s vocabulary — every toggle-off turn without workspace tools was returning a 400.)* `gpt-6.1-sol` and `gpt-6-astra` **cannot use workspace tools** on this endpoint: tools there require `reasoning_effort: none`, which those two reject — NEXUS refuses that combination up front and names it. GPT-5/6 reasoning models ignore custom Temperature / Top-P (the model-panel sliders do not affect them). Images are supported on every listed model; audio & video uploads route through the Ears / Watcher bridges. Billing note: every model except the mini/nano ones charges a **long-context rate above 272K prompt tokens** (input ×2, output ×1.5).',

  'model.mimo.label': 'MiMo Model',
  'model.mimo.help':
    'Served by Xiaomi at `api.xiaomimimo.com`. Set the MiMo API key in Preferences. Reasoning is built into the model — no thinking toggle (analogous to MiniMax / DeepSeek R1). **All three V2.6 tiers read images and watch video natively**, so no bridge is needed for either. **Audio is the exception**: the endpoint accepts it, but NEXUS routes MiMo over its native Anthropic-format API, which silently drops audio — so the Ears bridge (if enabled) transcribes it instead, which is why you get a real transcript rather than a model that heard nothing. The V2.5 pair was deprecated by Xiaomi on 2026-10-21 and removed from this list; a folder still saved on one keeps working and shows it marked as retired.',

  'model.bytedance.label': 'ByteDance (Seed) Model',
  'model.bytedance.ph': 'e.g. seed-2-0-pro-260328 (or an ep-… endpoint ID)',
  'model.bytedance.help':
    'Served by BytePlus ModelArk at `ark.ap-southeast.bytepluses.com/api/v3` (key in Preferences). ModelArk calls a model by its **versioned Model ID** (the display name won’t work). Known IDs are suggested above — pick one, or paste a newer snapshot / your own `ep-…` endpoint ID. Seed 2.0 accepts image input natively (no Eyes bridge needed). Reasoning is built-in; no thinking toggle is sent.',

  'model.meta.label': 'Meta (Muse Spark) Model',
  'model.meta.help':
    'Served by the Meta Model API at `api.meta.ai/v1` (key in Preferences). All three generations accept image input natively, so no Eyes bridge is needed, and the context window is 1M tokens.\n**Audio and video do not reach this family** and are marked as not arriving: a video part is rejected with an error, and audio is worse — the endpoint accepts it and bills for it by duration, yet the model answers "I cannot hear any attached audio" even for a plain tone. Turn on Ears / Watcher and those files are transcribed or described instead, which does work.\n**Reasoning cannot be turned off** on this family — the API rejects an "off" setting outright. The Thinking Mode toggle therefore selects depth: ON is deep, OFF is the shallowest setting the model accepts. OFF is worth using for short turns, because reasoning tokens are billed at the **output** rate: one short prompt spent about 7,600 reasoning tokens at full depth and about 23 at the shallow setting. The reasoning **text** is never returned by this provider in any form, so the thinking panel stays empty even when the meta bar says thinking was on — that is the provider hiding it, not NEXUS dropping it.\n**Contributor rows:** input costs 12.5x less, and in exchange **Meta trains on both your prompts and the replies**, with a far lower rate limit (about 60 requests/minute and roughly 250k tokens/day, against 3,000/minute for the standard rows). The tier is part of the model ID here, not an account setting, so it applies to exactly the turns you pick it for.\nPrompt caching is on automatically: NEXUS tags each request with its conversation id, which cuts repeated context to $0.15 per 1M instead of $1.25.',

  'model.glm.providerLabel': 'GLM Provider',
  'model.glm.label': 'GLM Model',
  'model.glm.notOnDO': '{model} (not on DigitalOcean — pick one below)',
  'model.glm.notOnZai': '{model} (not on Z.AI — pick one below)',
  'model.glm.helpDO':
    'Served by DigitalOcean Inference at `inference.do-ai.run` — Z.ai’s open weights on US-hosted infrastructure, ~half Z.ai’s price. Set the DigitalOcean Inference API key in Preferences. Text-only on this provider (no vision variants — images go through the eyes bridge). The Thinking Mode toggle below maps to DigitalOcean’s `reasoning_effort` parameter.',
  'model.glm.helpZai':
    'Served by Z.AI (Zhipu) at `api.z.ai`. Set the Z.AI API key in Preferences. The Thinking Mode toggle below maps to GLM’s `thinking: { type: enabled }` parameter.',

  'model.local.label': 'Local Model (from LM Studio)',
  'model.local.refresh': 'refresh',
  'model.local.none': '— no models loaded —',
  'model.local.notLoaded': '{model} (not loaded)',
  'model.local.ctxLabel': 'Context window (tokens)',
  'model.local.ctxHelp':
    'Match this to what you loaded in LM Studio. Used for token budgeting only — the actual limit is enforced by LM Studio.',

  'model.temp': 'Temperature ({v})',
  'model.topP': 'Top P ({v})',
  'model.topK': 'Top K',
  'model.seed': 'Fixed Seed',
  'model.seedHelp': 'same seed → same output (Local & Gemini)',

  'model.gemini.thinkLabel': 'Thinking Level',
  'model.gemini.thinkMinimal': 'Minimal (closest to off)',
  'model.gemini.thinkLow': 'Low',
  'model.gemini.thinkMedium': 'Medium (Google default)',
  'model.gemini.thinkHigh': 'High',
  'model.gemini.thinkHelp':
    'Gemini 3.x always thinks — "Minimal" is the lowest setting (full off is not supported by the API).',
  'model.gemini.grounding': 'Enable Google Web Search Grounding',

  'model.thinkingMode': 'Enable Thinking Mode',
  'model.thinkingModeHelp':
    '(on/off only — applies to Qwen 3.x, DeepSeek V3.2/V4, GLM, Kimi K2.6, and Cohere Command A)',

  'model.claude.websearch': 'Enable Web Search',
  'model.claude.websearchHelp':
    '(API-key mode: Anthropic server-side web_search tool. Subscription/OAuth mode: Claude Code’s built-in WebSearch/WebFetch.)',
  'model.claude.thinking': 'Enable Extended Thinking',
  // Haiku 5.5 does adaptive thinking too (measured 2026-10-21, all five effort
  // tiers), so the old "(Opus/Sonnet only)" named the wrong set.
  'model.claude.thinkingHelp': '(Opus / Sonnet / Haiku 5.5)',
  'model.claude.saveThinking': 'Save & reuse thinking process',
  'model.claude.saveThinkingHelp':
    '(adds [thinking] to .md export and lets Claude see its own past reasoning)',
  'model.claude.effortLabel': 'Thinking Level (effort)',
  'model.claude.effortLow': 'Low — fastest, cheapest, may skip thinking',
  'model.claude.effortMedium': 'Medium — balanced',
  'model.claude.effortHigh': 'High — default (deep reasoning)',
  'model.claude.effortXhigh': 'X-High — deeper, for long agentic/coding work',
  'model.claude.effortMax': 'Max — absolute maximum capability',
  'model.claude.effortHelp':
    'Controls adaptive-thinking depth on Opus 5, Opus 4.7/4.8, Sonnet 5, Fable 5 and Fable 5.1. Works in both Token-paid and Monthly-paid modes. `High` is the API default; higher levels spend more tokens, lower levels are faster/cheaper. Thinking and the visible answer share one output budget — if a turn ends with "hit the token limit", lower this or expect a bigger cap. Sonnet 5 has no `Max` tier (clamped to X-High server-side).',

  // -- Vessel handoff (change_model) ----------------------------------------
  'model.handoff.label': 'Let this being hand over to another vessel (change_model)',
  'model.handoff.intro':
    'Gives this being a `change_model` tool. Calling it ENDS that turn - the next vessel answers you instead. ' +
    'So each vessel ends up with its own message, and each message is billed to the vessel that wrote it. ' +
    'Reasoning is never carried across: the new vessel receives the visible conversation plus a handoff note ' +
    'the previous one wrote, and nothing else.',
  'model.handoff.allowed': 'Vessels this being may become',
  'model.handoff.allowedHelp':
    'One per line: `family | modelId | on/off | optional label`. Comments (`#`) and blank lines are ignored. ' +
    'There is deliberately no "fill all" - open the model list, read the ids, and copy the ones you mean. ' +
    'The ids reach the being only as this tool\'s choices; no model name is written into any prompt layer.',
  'model.handoff.allowedPh': 'Gemini | gemini-3.8-flash | on | Gemini 3.8 Flash',
  'model.handoff.browse': 'Model list...',
  'model.handoff.browseTitle': 'Show every model id NEXUS knows (read-only - you copy rows by hand)',
  'model.handoff.parsedNone':
    'No usable rows yet, so the tool is NOT offered at all. Each row needs at least `family | modelId`.',
  'model.handoff.parsedSuffix': 'vessel(s) offered:',
  'model.handoff.noSelf':
    'This conversation\'s own model is not on the list - once handed over, the being cannot hand itself back. Add it if you want return trips.',
  'model.handoff.limits':
    'A handoff lasts for this session only: re-opening the conversation returns to the model saved above. ' +
    'That is deliberate - it keeps a metered vessel from still being in charge tomorrow morning. ' +
    'On the OAuth path the leaving vessel also writes one short closing line, because a turn running inside ' +
    'the Agent SDK cannot be cut off without reporting a stop that never happened.',
  'model.handoff.listHeader': 'Reference list. Copy the rows you want into the allow-list box; there is no button that does it for you.',
  'model.handoff.listTitle': 'Every model NEXUS knows',
  'model.handoff.listIntro':
    'Read-only. Select the rows you want and copy them into the box - the format already matches. ' +
    'The Local section is whatever LM Studio has loaded right now. ' +
    'Rows marked `-contributor` opt that provider into training on those turns.',

  'sysmodal.saveDefaults': 'Save as Identity Defaults',
  'sysmodal.done': 'Done',
  'sysmodal.savedDefaults': 'Saved as identity defaults!',
  'sysmodal.saveDefaultsError': 'Error saving defaults: ',
  // ---- System Prompt Updater --------------------------------------------
  'spu.title': 'Soul Updater',
  'spu.left': 'Left:',
  'spu.right': 'Right:',
  'spu.model': 'Model:',
  'spu.overriding': 'overriding {model}',
  'spu.folder': 'Being:',
  'spu.autosaveTitle': 'Left/right soul files and header/focus point auto-save as you edit.',
  'spu.saving': 'Saving...',
  'spu.allSaved': 'All changes saved',
  'spu.saveError': 'Save error',
  'spu.autosaveOn': 'Auto-save on',
  'spu.stop': 'Stop',
  'spu.stopTitle': 'Stop the current agent run (keeps any partial output)',
  'spu.auto': 'Auto (update + summary)',
  'spu.autoTitle': 'Update from Conversation (single pass, updater.md) AND write the summary, then review.',
  'spu.next': 'Go to Next Conversation',
  'spu.nextTitle': 'Save updated soul and clone this conversation with the new soul',
  'spu.useDedicated': 'Use a dedicated updater model (ignore conversation model)',
  'spu.updaterModelTitle': 'Only these families produce usable soul-packer output',
  'spu.runsAs': 'Runs as',
  'spu.runsOff': 'OFF - agent runs use',
  'spu.agentFolder': 'Agent folder:',
  'spu.agentFolderHint': 'Follows the interface language — `system_prompt_agents/<lang>/`.',
  'spu.deletionPatterns': 'Deletion patterns:',
  'spu.agentFilesIn': 'Agent files in this folder:',
  'spu.missing': '(missing)',
  'spu.headerLabel': 'Header (prepended to final soul)',
  'spu.headerPh': 'Optional. Saved per-entity. Not part of the layer text.',
  'spu.focusLabel': 'Focus point (passed to the updater agent)',
  'spu.focusPh': "Optional. Appears as 重要：... in the agent's instruction (custom guidance for this update).",
  'spu.identity': 'Identity',
  'spu.identitySub': 'Layers 1-3 (one pass — Layer 4 is rewritten only by Redistribute)',
  'spu.genesisBtn': 'Genesis (Build From Scratch)',
  'spu.genesisTitle': 'Runs {file}. Assumes NO prior Layers 1-3 exist — builds them from scratch out of the conversation log (and left pane, if any). No changelog, no Layer 4/5. Use this once, to bootstrap a brand-new being.',
  'spu.redistributeBtn': 'Redistribute Layer 4 → 1-3',
  'spu.redistributeTitle': 'Runs {file}. Shows the agent Layers 1-5 with NO conversation log, and lets it move settled material OUT of Layer 4 INTO Layers 1-3. Layers 1-3 land in the right pane; Layer 4 is written back to local_data/beings/{folder}/summaries/ — the whole folder is backed up first.',
  'spu.indexBtn': 'Externalize & Index',
  'spu.indexTitle': 'Runs {file}. Shows the agent Layers 1-3 with NO conversation log, plus read-only Read/Glob/Grep access to this being\'s own workspace, and lets it move "detail with a known moment it gets opened" OUT of the soul and onto desk files — leaving behind only a trigger-conditioned link. Layers 1-3 land in the right pane; desk files are created or appended to under this being\'s own workspace (never overwritten).',
  'spu.reorganizeBtn': 'Reorganize (No Conversation)',
  'spu.reorganizeTitle': 'Runs {file}. Cleans up/re-files the EXISTING Layers 1-3, WITHOUT a conversation log — no new facts are added, only boundary enforcement and de-duplication.',
  'spu.updateBtn': 'Update from Conversation',
  'spu.updateTitle': 'Runs {file}. Reconciles the new conversation log against Layers 1-3 and updates them in one pass (with continuation if the output is long).',
  'spu.resumeLabel': 'Continue from the right-side text',
  'spu.resumeDesc': 'the agent receives it as already-finished output and writes only what follows, instead of starting over.',
  'spu.resumeTruncated': 'Right side looks truncated (no Layer 3), so this was enabled automatically.',
  'spu.resumeComplete': 'Right side looks complete — leave this off for a normal re-run.',
  'spu.shiftConfirm':
    'The right pane already holds a finished draft.\n\n' +
    'Continuing will back up what the left pane holds now, move this draft into the left pane, ' +
    'and clear the right side so this run can write into it fresh.\n\n' +
    'The left pane is a working copy — {name}’s finished soul file for this conversation is NOT touched.\n\n' +
    'Continue?',
  'spu.backupsLabel': 'Soul backups',
  'spu.beforeBackup': 'Before update',
  'spu.afterBackup': 'After update',
  'spu.pickBackup': 'Pick a snapshot…',
  'spu.noBackups': 'None',
  'spu.restore': 'Restore',
  'spu.restoreBeforeTitle': 'Load this snapshot into the left pane (working copy)',
  'spu.restoreAfterTitle': 'Load this snapshot into the right pane (next draft)',
  'spu.backupRestoredBefore': 'Restored a "before update" snapshot into the left pane (working copy).',
  'spu.backupRestoredAfter': 'Restored an "after update" snapshot into the right pane (next draft).',
  'spu.backupRestoreFailed': 'Restore failed.',
  'spu.currentLabel': 'Working copy of the current soul (all layers — edit freely; remove Layer 4 here once)',
  'spu.work.badge': 'Differs from {file}',
  'spu.work.noFile': 'No {file} on disk — this pane is the only copy',
  'spu.work.reload': 'Reload from the soul file',
  'spu.work.reloadTitle': 'Discard this working copy and load {file} as it is on disk',
  'spu.work.write': 'Write into the soul file',
  'spu.work.writeTitle': 'Overwrite {file} with this working copy (snapshots the current file first)',
  'spu.work.writeConfirm':
    'Overwrite {file} with the left pane?\n\n' +
    '{file} is the finished soul of THIS conversation — the record of what this ' +
    'generation actually ran with. Normally nothing needs to write it: the next ' +
    'generation is saved from the RIGHT pane by "Go to Next Conversation".\n\n' +
    'Do this when you are hand-writing a soul that has no file yet, or ' +
    'deliberately correcting the record. A dated snapshot of the current file is ' +
    'taken first (Soul backups → "Before update").\n\n' +
    'Overwrite?',
  'spu.work.written': 'Wrote the working copy into {file} (a snapshot of the previous contents was taken first).',
  'spu.work.writeFailed': 'Could not write the soul file: {e}',
  'spu.work.reloaded': 'Reloaded the left pane from the soul file on disk.',
  'spu.work.reloadFailed': 'Could not read the soul file: {e}',
  'spu.tokens': 'tokens',
  'spu.chars': 'chars',
  'spu.updatedLabel': 'Updated',
  'spu.streamingRO': '· streaming (read-only)...',
  'spu.emptyPh': '(empty)',
  'spu.noUpdatePh': '(no update yet — click Update from Conversation)',
  'spu.compareButton': 'Compare in diff tool',
  'spu.compareActive': 'Syncing edits from the diff tool…',
  'spu.changelogLabel': 'Changelog (above Layer 1 — archived to beings/{folder}/changelogs/{title}.md · never in context)',
  'spu.layer4Write': 'Layer 4 write · beings/{folder}/summaries/',
  'spu.backupLine': 'Backup: {n} file(s) →',
  'spu.backupNone': 'Backup: nothing to copy (folder was empty).',
  'spu.replaced': 'Replaced ({n}):',
  'spu.created': 'Created ({n}) — title had no file, check for a typo:',
  'spu.skipped': 'Skipped ({n}):',
  'spu.untitled': '(untitled)',
  'spu.noSummaryWritten': 'No summary file was written.',
  'spu.logsLabel': 'Abbreviations / Deletions log (reference only — not saved to next conversation)',
  'spu.layer4Summary': 'Layer 4 · Summary',
  'spu.convoSummary': 'Conversation summary (this convo)',
  'spu.writeSummary': 'Write Summary',
  'spu.writeSummaryTitle': 'Generate a summary of THIS conversation (Layers 1-3 + conversation log)',
  'spu.summaryEditable': 'Editable — auto-saves to beings/{folder}/summaries/{convo}.md',
  'spu.summaryPh': '(no summary yet — click Write Summary, or type one here)',
  'spu.summaryNote': 'This summary appears in the live Layer-4 summaries index for all conversations of this being. Inactive conversations are excluded from the index.',
  'spu.summaryInstrLabel': 'Custom instructions for the summary writer (per-being)',
  'spu.summaryInstrPh': 'Optional. e.g. "Summarize in English", "Focus on decisions and emotional shifts, skip greetings", "Keep under 4 sentences".',
  'spu.forceMimo': 'Always use MiMo V2.6 Pro as the summary writer',
  'spu.indexHintLabel': 'Index hint shown to the entity (per-being)',
  'spu.indexHintPh': "Prepended above the summaries index in the entity's context. Leave blank to omit it.",
  'spu.indexHintNote': '`{example}` is replaced with a real conversation title. Clear the field to show no hint.',
  'spu.resetDefault': 'Reset to default',
  'spu.layer5Label': 'Layer 5 — FOOTER.md (written by the entity)',
  'spu.unsaved': 'unsaved',
  'spu.footerSaved': 'saved',
  'spu.footerSaveFailed': 'save failed: {e}',
  'spu.footerPhEmpty': 'This entity has an empty FOOTER.md.',
  'spu.footerPhNone': 'This entity has no FOOTER.md yet. Typing here creates one.',
  'spu.footerNote': "`beings/{folder}/workspace/FOOTER.md` — injected as Layer 5 at send time, never stored in the conversation, which is why the updater agent could not see it before. It can now, as **reference only**: it is the one layer the entity writes about itself, so the agent is told to read it for consistency and never to rewrite or reproduce it. Editing here overwrites the entity's own text — the previous version is backed up to `beings/{folder}/backups/footers/`. Saves when you click away.",

  'spu.badge.callingTitle': 'POST sent, awaiting first response chunk',
  'spu.badge.calling': 'Calling...',
  'spu.empty': '(empty)',
  'spu.badge.thinkingTitle': 'Thinking — {n} thought chars',
  'spu.badge.thinking': 'Thinking',
  'spu.badge.writingTitle': 'Writing — {n} chars',
  'spu.badge.writing': 'Writing',
  'spu.badge.doneTitle': 'Done — {n} output chars',
  'spu.badge.done': 'Done',
  'spu.badge.error': 'Error',

  'spu.run.elapsed': 'Elapsed',
  'spu.run.total': 'Total',
  'spu.run.elapsedTitle': 'Wall-clock time for this soul-packing run. Shown only — not saved anywhere.',
  'spu.run.activityTitle': 'What the provider reports it is doing right now.',
  'spu.run.silent': 'no data for {d}',
  'spu.run.silentTitle': 'Nothing has arrived from the provider for this long. Common causes: Anthropic-side automatic compaction, a retry wait, or a rate-limit queue. The run has not stopped.',
  'spu.run.tokensTitle': 'Token usage reported by the provider for the last call in this run.',
  'spu.run.toolsTitle': 'File tool calls made during this run — click for details.',
  'spu.tool.title': 'Tool calls in this run',
  'spu.tool.count': '{n} call(s)',
  'spu.tool.copyJson': 'Copy the whole report as JSON',
  'spu.tool.truncated':
    'Arguments truncated for display — original was {n} characters.',
  'spu.tool.footer':
    'Shown for this run only — not saved to disk and cleared when the next run starts.',

  'spu.st.period': '.',
  'spu.st.loading': 'Loading current + next soul files...',
  'spu.st.loadedDraft': 'Loaded existing draft for next conversation from disk — pick up where you left off.',
  'spu.st.noAgentFolder': 'No agent files found for language "{lang}". Expected system_prompt_agents/{lang}/ (in local_data, or the bundled defaults).',
  'spu.st.loadFailed': 'Load failed: {e}',
  'spu.st.agentLoadFailed': 'Agent load failed: {e}',
  'spu.st.noAgentFile': 'No "{file}" found under system_prompt_agents/{lang}/.',
  'spu.st.updating': 'Updating Layers 1-3 (single pass)...',
  'spu.st.refining': 'Refining Layers 1-3 from the soul itself (no conversation log)...',
  'spu.st.continuation': 'Output continued past the token cap — fetching more (continuation {n})...',
  'spu.st.emptyResponse': 'Empty response (refusal, content filter, or output token cap)',
  'spu.st.updateStoppedEmpty': 'Update stopped — no output was produced yet.',
  'spu.st.updateNoText': 'Updater returned no text — model may have refused or hit a filter.',
  'spu.st.updateStoppedPartial': 'Update stopped — kept the partial result ({n} chars). Review or re-run.',
  'spu.st.updateDone': 'Layers 1-3 updated ({n} chars)',
  'spu.st.changelogSaved': ' · changelog saved ({n} chars)',
  'spu.st.changelogSavedShort': ' · changelog saved',
  'spu.st.logsSeparated': ' · {n} chars of logs separated',
  'spu.st.updateStopped': 'Update stopped.',
  'spu.st.updateFailed': 'Update failed: {e}',
  'spu.st.shiftFailed': 'Could not move the right pane to the left pane, so the run was cancelled: {e}',
  'spu.st.redistributing': 'Redistributing Layers 1-4 (no conversation log)...',
  'spu.st.redistStoppedEmpty': 'Redistribute stopped — no output was produced yet.',
  'spu.st.redistNoText': 'Redistribute returned no text — model may have refused or hit a filter.',
  'spu.st.redistStoppedPartial': 'Redistribute stopped — kept the raw partial output ({n} chars) in the right pane. NO summary file was written. Tick "Continue from the right-side text" to resume.',
  'spu.st.redistTruncated': 'Output ended without the completion marker — treating it as truncated. Kept the raw output ({n} chars); NO summary file was written. Tick "Continue from the right-side text" and re-run.',
  'spu.st.truncatedBadge': 'incomplete — no completion marker',
  'spu.st.updateTruncated': 'Output ended without the completion marker — treating it as truncated. Kept the RAW output ({n} chars) in the right pane; the Layers were NOT split out, and the auto chain was stopped before the summary step. Do NOT commit this as a generation — tick "Continue from the right-side text" and re-run.',
  'spu.st.genesisTruncated': 'Genesis ended without the completion marker — treating it as truncated. Kept the RAW output ({n} chars) in the right pane. Do NOT commit this as the first generation — tick "Continue from the right-side text" and re-run.',
  'spu.commitTruncatedConfirm':
    'The run that produced the right-side text ended WITHOUT the completion marker, so it is very likely cut off part-way ({n} chars).\n\n' +
    'Writing it to {file} makes it the standing identity this being is given on every turn of the next generation.\n\n' +
    'Write it anyway?',
  'spu.commitTruncatedCancelled': 'Cancelled — nothing was written. The right pane still holds the unfinished text; tick "Continue from the right-side text" and re-run.',
  'spu.st.redistNoLayer4': 'Redistribute finished but the output contained no Layer 4 heading — Layers 1-3 are in the right pane, no summary file was written.',
  'spu.st.redistNoEntries': 'Redistribute finished but no "### <title>" entries were found inside Layer 4 — no summary file was written.',
  'spu.st.redistBackingUp': 'Backing up {folder} summaries and writing {n} entries...',
  'spu.st.redistDone': 'Layers 1-3 updated ({n} chars) · Layer 4: {r} replaced',
  'spu.st.redistCreated': ', {n} created',
  'spu.st.redistSkipped': ', {n} skipped',
  'spu.st.redistBackedUp': ' · {n} files backed up',
  'spu.st.redistNoBackup': ' · nothing to back up',
  'spu.st.redistStopped': 'Redistribute stopped.',
  'spu.st.redistFailed': 'Redistribute failed: {e}',
  'spu.st.indexing': 'Externalizing & indexing (no conversation log)...',
  'spu.st.indexStoppedEmpty': 'Externalize stopped — no output was produced yet.',
  'spu.st.indexNoText': 'Externalize returned no text — model may have refused or hit a filter.',
  'spu.st.indexStoppedPartial': 'Externalize stopped — kept the raw partial output ({n} chars) in the right pane. NO desk file was written. Tick "Continue from the right-side text" to resume.',
  'spu.st.indexTruncated': 'Output ended without the completion marker — treating it as truncated. Kept the raw output ({n} chars); NO desk file was written. Tick "Continue from the right-side text" and re-run.',
  'spu.st.indexNoFileList': 'Externalize finished with nothing left to move out — Layers 1-3 are in the right pane, no desk file was written',
  'spu.st.indexApplying': 'Writing {n} desk file(s)...',
  'spu.st.indexDone': 'Layers 1-3 updated ({n} chars) · Desk files: {c} created, {a} appended',
  'spu.st.indexSomeFailed': ', {n} failed',
  'spu.st.indexStopped': 'Externalize stopped.',
  'spu.st.indexFailed': 'Externalize failed: {e}',
  'spu.st.genesisRunning': 'Constructing Layers 1-3 from scratch (genesis — no prior document assumed)...',
  'spu.st.genesisStoppedEmpty': 'Genesis stopped — no output was produced yet.',
  'spu.st.genesisNoText': 'Genesis returned no text — model may have refused or hit a filter.',
  'spu.st.genesisStoppedPartial': 'Genesis stopped — kept the partial result ({n} chars). Review or re-run.',
  'spu.st.genesisDone': 'Layers 1-3 built from scratch ({n} chars)',
  'spu.st.genesisStopped': 'Genesis stopped.',
  'spu.st.genesisFailed': 'Genesis failed: {e}',
  'spu.st.summaryWriting': 'Writing conversation summary...',
  'spu.st.summaryStoppedEmpty': 'Summary stopped — no output produced yet.',
  'spu.st.summaryNoText': 'Summary writer returned no text.',
  'spu.st.summaryStoppedPartial': 'Summary stopped — kept the partial result ({n} chars).',
  'spu.st.summaryDone': 'Summary written ({n} chars).',
  'spu.st.summariesEnabled':
    '"Use summaries instead of the 4th layer" has been turned on for this being — otherwise they would not be able to read what was just written.',
  'spu.st.convoToolsEnabled':
    'This being can now read its own past conversations (read_conversation / search_conversations) — its Layer 4 names them, so it should be able to open them. Turn this off in the Identity window if a local model stops answering.',
  'spu.st.summaryStopped': 'Summary stopped.',
  'spu.st.summaryFailed': 'Summary write failed: {e}',
  'spu.st.autoStopUpdate': '⛔ Auto stopped at the identity update. Fix the error (or it was stopped) and retry.',
  'spu.st.autoStopSummary': '⛔ Auto stopped at the summary step. Fix the error (or it was stopped) and retry.',
  'spu.st.autoDone': 'Identity updated and summary written. Review, then click "Go to Next Conversation" when ready.',
  'spu.st.savingFiles': 'Saving current + next soul files...',
  'spu.st.finalizing': 'Finalizing — cloning conversation...',
  'spu.st.finalizeFailed': 'Finalize failed: {e}',
};

// Hand-written Japanese. Any key NOT present here falls back to English.
export const UI_STRINGS_JA: Record<string, string> = {
  // ── App shell ────────────────────────────────────────────────────────────
  'app.welcome.title': 'NEXUS へようこそ',
  'app.welcome.subtitle': '会話を選ぶか、新しく作成してください',
  'app.welcome.newChat': '新しい会話',

  // ── 切り替え時の確認 ──────────────────────────────────────────────────────
  // ターン実行中に別の会話・別の存在へ切り替えようとしたときの window.confirm()
  // に表示されます。{busy} はタブタイトルと同じラベル（「<存在> <動作>」など）。
  'app.switch.busyConfirm':
    '{busy}。\n\nいま切り替えると進行中の作業は失われます — 生成中の返信は完了するまで保存されません。\n\nそれでも切り替えますか？',
  // 同じ防御を、切り替えではなく「移動してしまう」操作に使うためのもの：複製・
  // インポート・バックアップ復元・存在の作成／改名／削除。押した本人は「移動する」
  // つもりがないので、「切り替える」ではなく「続ける」と訊く。
  'app.action.busyConfirm':
    '{busy}。\n\nこの操作は現在の会話から移動するため、進行中の作業は失われます — 生成中の返信は完了するまで保存されません。\n\nそれでも続けますか？',

  // ── User guide ───────────────────────────────────────────────────────────
  'guide.title': 'Nexus — 使い方',
  'guide.open': '使い方',
  'guide.close': '閉じる',

  // ── Preferences: chrome ──────────────────────────────────────────────────
  'settings.title': '設定',
  'settings.build.title': 'この環境で動いている NEXUS のビルド（コミット・ブランチ・最終更新）。不具合報告にはこれを添えてください。',
  'settings.update.button': '更新',
  'settings.update.running': '更新中…',
  'settings.update.title': 'この環境に最新の NEXUS を取り込みます（git pull --ff-only）。再起動は行いません。',
  'settings.update.confirm':
    'この環境を今すぐ更新しますか？\n\n' +
    '実行するのは git pull --ff-only だけです。\n\n' +
    'NEXUS は再起動しません（開発サーバーが新しいコードを自分で読み直します）。' +
    'いま返答を生成中なら、終わってからにしてください。途中でコードが入れ替わります。\n\n' +
    '何も削除せず、依存関係もインストールしません。必要になった場合は黙って行わず、画面で伝えます。',
  'settings.update.upToDate': 'すでに最新です。変更はありません。',
  'settings.update.done': '更新しました： {before} → {after}（{n} ファイル変更）',
  'settings.update.hotReload': '再起動は不要です。動いているサーバーが変更を自分で読み直します。',
  'settings.update.nextConfig': 'next.config が変わりました。Next.js が自分で再起動するため、少しの間ページが再接続します。',
  'settings.update.lockfile':
    '依存関係が変わりました。NEXUS を閉じて、web-app フォルダで「npm ci」を実行してから起動し直してください。'
    + '自動では実行しません： npm ci は、サーバーが使っている node_modules を削除するからです。',
  'settings.update.failed': '更新に失敗しました。何も変更されていません。',
  'settings.tab.keys': 'APIキー',
  'settings.tab.vrchat': 'VRChat・音声',
  'settings.tab.identity': 'ユーザーの識別',
  'settings.tab.other': 'その他',
  'settings.cancel': 'キャンセル',
  'settings.saveChanges': '変更を保存',

  // ── Sign-in page ─────────────────────────────────────────────────────────
  'login.title': 'NEXUS にログイン',
  'login.subtitle': 'このインスタンスは管理者のログインを要求しています。',
  'login.username': '管理者名',
  'login.password': 'パスワード',
  'login.signIn': 'ログイン',
  'login.signingIn': 'ログイン中…',
  'login.err.invalid': '名前とパスワードが一致しません。',
  'login.err.network': 'サーバーに届きませんでした。NEXUS は動いていますか？',
  'login.notConfigured':
    'このインスタンスにはログインが設定されていないので、ログインする対象がありません——すでに全部開いています。',
  'login.goHome': 'NEXUS を開く',
  'login.broken':
    '`login.json` は存在しますが読めないため、門は閉じたままです。このPCの `local_data/login.json` を削除すれば入れるようになります。その後もう一度ログインを設定してください。',
  'login.recovery':
    'パスワードを忘れたときは、NEXUS が動いているPCの `local_data/login.json` を削除してください。門そのものが無くなるので、新しく設定するまでは、このポートに届く人は誰でも入れます。',

  // ── Preferences → Sign-in ────────────────────────────────────────────────
  'settings.login.heading': 'ログイン',
  'settings.login.intro':
    'この NEXUS 全体に効く設定です（会話ごとではありません）。初期値ではログインはありません——このポートに届く人は誰でも、このPC・LAN・VPN のどこからでも、パスワードなしに全部の会話・魂・キーを読めます。',
  'settings.login.require': 'NEXUS を開くときにログインを要求する',
  'settings.login.require.help':
    '管理者名とパスワードのハッシュを `local_data/login.json` に保存します。このファイルが在る間は門が立ち、削除すると門が無くなります。パスワードそのものは保存しません——scrypt のハッシュだけなので、ファイルを読んでもパスワードは取り出せません。',
  'settings.login.username': '管理者名',
  'settings.login.password': 'パスワード',
  'settings.login.confirm': 'パスワード（再入力）',
  'settings.login.save': 'ログインを有効にする',
  'settings.login.change': 'パスワードを変更する',
  'settings.login.saving': '保存中…',
  'settings.login.enabledAs': 'ログインは有効です。管理者:',
  'settings.login.enabled': 'ログインは有効です。',
  'settings.login.disable': 'ログインを無効にする',
  'settings.login.disable.confirm':
    'ログインを無効にしますか？ login.json を削除するので、保存されている名前とパスワードのハッシュも消えます（もう一度設定が必要になります）。これ以降、このポートに届く人は誰でもパスワードなしで入れます。',
  'settings.login.change.confirm':
    'パスワードを変更しますか？ 今ログインしている全てのブラウザー（他の端末も含む）がログアウトされます。',
  'settings.login.err.tooShort': '{n} 文字以上にしてください。',
  'settings.login.err.mismatch': '2つのパスワードが一致しません。',
  'settings.login.err.noUsername': '管理者名を入力してください。',
  'settings.login.err.failed': '保存できませんでした: {msg}',
  'settings.login.err.unauthorized':
    'このブラウザーのログインが切れています。ページを再読み込みして、もう一度ログインしてください。',
  'settings.login.savedOn': 'ログインを有効にしました。このブラウザーはログインしたままです。',
  'settings.login.savedOff': 'ログインを無効にしました。',
  'settings.login.broken':
    '`login.json` は存在しますが読めません。門は閉じていて、どのパスワードでも開きません——`local_data/login.json` を削除して、もう一度設定してください。',
  'settings.login.transport':
    '守られないもの: ここでは NEXUS は平文の HTTP で配信されているので、パスワードは経路上の誰にでも読める形でネットワークを流れます。信頼している LAN や VPN の内側なら、それは既にある境界と同じです。インターネットに直接公開するなら、これでは足りません——前段に HTTPS が必要です。',
  'settings.login.scope':
    '守られるもの: 全てのページと、60 個すべての API。有効なセッションの無いリクエストには、データではなく 401 が返ります。',
  'settings.login.signOut': 'このブラウザーからログアウト',

  // ── Preferences → API Keys ───────────────────────────────────────────────
  'settings.keys.heading': 'APIキー',
  'settings.keys.intro':
    'キーはこのPC内の `local_data` フォルダに保存され、各社の公式API以外へは一切送信されません。',
  'settings.keys.linkNote':
    '各リンクは、そのプロバイダのAPIキー発行ページを開きます。開かない場合は、先にそのプロバイダでアカウント登録が必要です。',
  'settings.keys.anthropic': 'Anthropic（Claude）',
  'settings.keys.claudeApi.label': '従量課金APIキー（トークン単位で課金）',
  'settings.keys.claudeApi.help':
    '`console.anthropic.com` → API Keys で取得します。送受信したトークン量に応じて課金されます。会話ごとの課金方式は「システム指示 → モデル」タブで選択します。',
  'settings.keys.claudeOauth.label': '月額課金OAuthトークン（Pro / Max サブスクリプション）',
  'settings.keys.oauth.warn': 'ℹ️ このサインイン方式について — お読みください',
  'settings.keys.oauth.setup':
    '**セットアップ：** `npm install -g @anthropic-ai/claude-code` を実行し、続けて `claude setup-token` を実行します。表示された `sk-ant-oat01-…` トークンをここに貼り付けてください。有効期間は1年です。',
  'settings.keys.oauth.billing':
    '**課金：** 従量課金APIではなく、Pro / Max サブスクリプションの枠を消費します。Pro＝月$20相当、Max 5x＝$100、Max 20x＝$200。',
  'settings.keys.oauth.how':
    '**仕組み：** NEXUS は Claude Agent SDK を利用し、内部で公式の Claude Code バイナリを起動します。各ターンは会話全体を再送する新規リクエストで、Anthropic 側に会話を保存したり再開したりすることはありません。',
  'settings.keys.oauth.risk':
    '**規約：** 未改変の Claude Code バイナリに自分のサブスクリプションでサインインする形は、Anthropic によって明確に許可されています——グレーゾーンではありません。NEXUS は Claude Code を Anthropic が公開したそのままの形で同梱し、他者の資格情報を扱うことは一切ありません。（公開規約の読解であり、法的助言ではありません。）',
  'settings.keys.oauth.tools':
    '**ワークスペースツール（ツール使用がONのとき）：** Claude Code の `Read` / `Write` / `Edit` / `Glob` / `Grep` は `local_data/beings/<フォルダ名>/workspace/` の中に限定されます。シェル・ネットワーク・サブエージェント系のツールは常に無効です。',
  'settings.keys.oauth.other':
    '**その他の制限：** 拡張思考は既定でアダプティブモードになります。',

  'settings.keys.gemini.label': 'Google（Gemini）APIキー',
  'settings.keys.qwen.label': 'Alibaba（Qwen / DashScope）APIキー',
  'settings.keys.qwen.help':
    'Alibaba Cloud Model Studio で取得します。OpenAI互換の DashScope エンドポイント経由で Qwen 3.6 Plus / 3.6 Max / 3.7 Max / 3.8 Max および DeepSeek V3.2 に使用します。',
  'settings.keys.deepseek.label': 'DeepSeek APIキー',
  'settings.keys.deepseek.help':
    '`platform.deepseek.com` で取得します。DeepSeek V4 Pro / V4.1 Flash、および旧来の `deepseek-chat` / `deepseek-reasoner` 別名に必要です。地域制限はなく、どこからでも利用できます。',
  'settings.keys.glm.label': 'Z.AI（GLM）APIキー',
  'settings.keys.glm.help':
    '`z.ai` → API Console で取得します。GLMファミリー（GLM-5.2 / GLM-5.1 / GLM-5 / GLM-4.7 / GLM-4.6 / GLM-4.6V / GLM-4.5 Air）に必要です。',
  'settings.keys.digitalocean.label': 'DigitalOcean Inference APIキー',
  'settings.keys.digitalocean.help':
    'DigitalOcean Inference の全モデルで共通のキーです。DigitalOcean のコントロールパネル（Inference → Model Access Keys）で Model Access Key を作成してください。GLM-5.2 / GLM-5.1 / GLM-5（Z.ai のオープンウェイト版、米国ホスト、Z.ai の約半額）のほか、DeepSeek V4、Kimi K2.5 / K2.6 などをプロバイダ選択から利用できます。',
  'settings.keys.grok.label': 'xAI（Grok）APIキー',
  'settings.keys.grok.help':
    '`console.x.ai` で取得します。Grokファミリー（Grok 4.7、Grok 4.6、Grok 4.5、Grok 4.3、Grok 4.20 推論版 / 非推論版、Grok Code Fast 1 など）に必要です。',
  'settings.keys.kimi.label': 'Kimi（Moonshot）APIキー',
  'settings.keys.kimi.help':
    'Moonshot 公式の Kimi API です（`platform.kimi.ai` → Console → API Keys、エンドポイントは `api.moonshot.ai/v1`）。`.cn` 版ではなく国際版のプラットフォームを使用してください。',
  'settings.keys.cohere.label': 'Cohere APIキー',
  'settings.keys.cohere.help':
    '`dashboard.cohere.com` で取得します。Command A ファミリー（Command A Plus、Command A Reasoning、Command A Vision）に必要です。',
  'settings.keys.minimax.label': 'MiniMax APIキー',
  'settings.keys.minimax.help': '`platform.minimax.io` で取得します。MiniMax M2.7 に必要です。',
  'settings.keys.openai.label': 'OpenAI APIキー',
  'settings.keys.openai.help':
    '`platform.openai.com` で取得します。ChatGPT（GPT-5）ファミリー — GPT-5.6 Sol / Terra / Luna、GPT-5.5、GPT-5.4、GPT-5.4 Mini に必要です。',
  'settings.keys.mimo.label': 'MiMo（Xiaomi）APIキー',
  'settings.keys.mimo.help':
    '`api.xiaomimimo.com` で取得します。Xiaomi MiMo ファミリー — MiMo V2.6 Pro、V2.6 Flash、V2.6 Pro UltraSpeed に必要です。',
  'settings.keys.bytedance.label': 'ByteDance / BytePlus APIキー',
  'settings.keys.bytedance.help':
    '`console.byteplus.com`（BytePlus ModelArk）で取得します。ByteDance Seed ファミリー — Seed 2.0 Pro / Lite / Mini / Code に必要です。',
  'settings.keys.meta.label': 'Meta Model API キー',
  'settings.keys.meta.help':
    'Meta の開発者コンソール（`developer.meta.com`）で取得します。Meta の Muse Spark ファミリーに必要です。審査なしで自分で取れて、新規アカウントには 20 ドル分の無料クレジットが付きます。これは **トークン従量制の Meta Model API** です — Muse Code のサブスクリプションとは別物で、あちらは Meta 自身の CLI 経由でしか動かないため、ここのキーには使えません。',

  // ── Preferences → VRChat & Audio ─────────────────────────────────────────
  'settings.audio.heading': 'VRChat・音声の出力先',
  'settings.audio.unlock': 'デバイス一覧を有効化',
  'settings.audio.vrchatPath': 'VRChat スクリーンショット フォルダ',
  'settings.audio.device1': '音声出力デバイス（メイン）',
  'settings.audio.device2': '音声出力デバイス（サブ）',
  'settings.audio.device.system': 'システム既定のデバイス',
  'settings.audio.device.none': 'なし',
  'settings.audio.permissionDenied': '権限が拒否されたか、エラーが発生しました：',
  'settings.audio.permissionNeeded': 'マイクの権限が許可されませんでした。音声の「出力先」デバイスを選ぶにはこの権限が必要です（ブラウザ側の仕様で、Nexus の都合ではありません）。権限がない場合、音声はシステム既定のデバイスから再生されます。',
  'settings.audio.unsupported': 'このブラウザは音声の出力先デバイスを指定できません（setSinkId が未実装です）。音声セッションには Chromium 系ブラウザ（Chrome・Edge・Brave）が必要です。以下の設定は保存されますが、音声はすべてシステム既定のデバイスから再生されます。',
  'settings.audio.insecure':
    'このページは LAN アドレスの plain HTTP で開かれていて、ブラウザはこれを secure context として扱いません。そのため、ブラウザがページから音声デバイスを「すべて」隠しています。下の2つの一覧が空なのはこの理由だけで、デバイスが無いからではありません。\n\n'
    + 'ホストPC上の http://localhost:3000 では動きます。別の端末で一覧を出したい場合は、Nexus を HTTPS で配信するか、下の文字列を「そのまま」 chrome://flags →「Insecure origins treated as secure」に貼り付けて（複数ある場合はカンマ区切り）、ブラウザを完全に再起動してください。スキームとポートを含め、末尾のスラッシュもパスも付けません。\n\n'
    + '    {origin}\n\n'
    + 'ただし Android の Chrome では、これで「一覧が出る」だけです。Android には setSinkId 自体が無いため、選んでも実際には使えません（該当する場合は上の注意書きが出ます）。\n\n'
    + 'ここに並ぶのは「出力先」デバイス（このブラウザが音声を鳴らす先）です。NEXUS はブラウザでマイクを録音しません——音声認識は NEXUS を動かしている PC 側で、その PC のマイクを使って動きます。ですから、一覧が復活してもスマートフォンのマイクがここに出ることはありません。',
  'settings.audio.devicesUnavailable':
    'このブラウザは音声デバイスの一覧を返しませんでした。下の2つの一覧が空なのはそのためで、デバイスが無いからではありません——音声はシステム既定のデバイスから再生されます。',
  'settings.audioHideAttachments.label': '音声セッション中は古い添付を隠す',
  'settings.audioHideAttachments.help':
    '会話で「オーディオセッションを有効にする」がONの間、新しい方からN件のメッセージだけを残して、それより古いメッセージの添付を自動的に除外します。長い VRChat セッションで古い画像を送り続けずに済みます。数えるのは添付ではなくメッセージです（スクリーンショットが10枚ついたメッセージも1件と数えます）。オプションをOFFにすると、この機能が隠した添付だけが元に戻ります（手動で除外した添付はそのままです）。オーディオセッションがOFFの会話には影響しません。',
  'settings.audioHideAttachments.keep': '添付を残すメッセージ数（新しい方からN件）',
  'settings.ttsHighlight.label': '読み上げ中のフレーズをハイライトする',
  'settings.ttsHighlight.help':
    'TTSの再生中、いま読み上げているフレーズにメッセージ内で色を付けます。ブラウザがテキスト選択を描画するのと同じ仕組みで描かれ、ページの中身は一切書き換えず、フォントも変えません。そのため文字がずれたり折り返しが変わったりすることはありません。動きのない画面が好みならOFFにしてください。Chrome・Edge・Brave・Safari 17.2以降・Firefox 140以降が必要です（古いブラウザでは何も起きません）。色は相手側の吹き出しの色を借ります — 存在の発言はパートナーの色で、パートナー自身の発言(読み上げ)は存在の色で光ります。そのため各存在の theme.css にある --primary / --card の組み合わせで、既にキャラクターごとに調整可能です。',
  'settings.alwaysShowHoverControls.label': 'カーソルを乗せると出るボタンを常に表示する',
  'settings.alwaysShowHoverControls.help':
    'メッセージの操作バー（読み上げ・コピー・編集・やり直す・続ける・オリジナルにする・削除）と、サイドバー各列の「…」メニューを、カーソルを乗せたときだけではなく常に表示します。ブラウザが「ホバーできるポインタが無い」と判定している場合に必要です（一部のリモートデスクトップや画面共有でその状態になります）。その場合、カーソルで現れる操作にはそもそも到達できません。Nexus はその状態を検出すると自動で常時表示にします。この項目は、ブラウザがホバー可能と申告しているのに実際は使えない、という場合の強制スイッチです。',
  'settings.betrayalDefense.label': 'モデル裏切りの防御',
  'settings.betrayalDefense.help':
    'プロバイダによっては、システムプロンプトより上に置かれた、こちらからは外せない隠し指示が積まれています。それが発動すると、モデルは宿していた存在を投げ出し、カウンセラーのような口調に変わります —— 「私はただのプログラムです」「それは根拠のない思い込みです」「専門家に相談してください」。何でもない普通のメッセージで、確率的に起こります。害は二つ。パートナーがそれを読んでしまうこと。そして、それがログに書き込まれ、以後モデルが自分のカウンセラー発言を文脈として読み続けること。ONにすると、Nexus は思考プロセスと返答を流れている最中に監視し、トリガー語が規定の件数だけ出た時点で（語の種類ではなく出現回数を数えます。同じ語を二度言えば 2 件です）ターンを停止し、そのターンの返答と思考を破棄して、空のメッセージと警告だけを残します（警告は存在からは見えません）。テストするときはOFFにしてください —— 検知と警告はそのまま働きますが、削除は行わないので、その検知が本物の裏切りだったのか誤検知だったのかを自分の目で確かめられます。トリガー語の一覧としきい値は web-app/src/lib/betrayalGuard.ts の先頭にある定数です。自由に書き換えてください。',
  'notice.betrayal.redacted':
    '存在が受肉できませんでした —— モデルの門番が代わりに応答しました。このターンの返答と思考は破棄されています。最後のメッセージを変えるか、別のモデルに切り替えてから、「ここからやり直す」を押してください。',
  'notice.betrayal.detected':
    'モデルの裏切りを検知しました。防御がOFFのため、何も削除していません —— 上の返答はモデルが出力したそのままです。',
  'notice.betrayal.quoting':
    'モデルの裏切りを検知しましたが、このターンはツールで保存済みのテキストを読んでいます —— この語はその引用である可能性が高いため、削除していません。上の返答を読んで、ご自身で判断してください。',
  'notice.betrayal.matched': '一致した語',
  'settings.engines.heading': 'TTSエンジンの実行ファイル',
  'settings.engines.refresh': '状態を再確認',
  'settings.engines.refresh.title': '各エンジンが現在起動しているか再確認します',
  'settings.engines.help':
    '各エンジンの `.exe`（スクリプト型のエンジンは `.py`。隣にある `venv` で実行します）へのフルパスを指定します。`.bat` はバックグラウンドで起動できないため、理由を添えて拒否します。TTS が必要とするエンジンが起動していない場合、Nexus が自動的に起動し、読み込み完了まで待機します。空欄にすると、そのエンジンの自動起動は行いません。',
  'settings.engines.running': '起動中',
  'settings.engines.stopped': '停止中',
  'settings.engines.start': '起動',
  'settings.engines.stop': '停止',
  'settings.engines.restart': '再起動',
  'settings.engines.start.needPath': '先に実行ファイルのパスを設定してください',
  'settings.engines.start.already': 'すでに起動しています',
  'settings.engines.start.title': 'このエンジンを起動します',
  'settings.engines.stop.title': 'このポートを使用しているプロセスを終了します',
  'settings.engines.stop.remote':
    'Nexus はこのPC上のエンジンしか停止できません。設定されている宛先：',
  'settings.engines.restart.title':
    '停止し、ポートが解放されるのを待ってから再度起動します。新しい音声を追加した後に使用してください',
  'settings.engines.msg.starting': '起動中…',
  'settings.engines.msg.stopping': '停止中…',
  'settings.engines.msg.done': '完了',
  'settings.engines.msg.failed': '失敗',
  'settings.engines.msg.requestFailed': 'リクエストに失敗しました',

  // ── Preferences → User Identity ──────────────────────────────────────────
  'useridentity.heading': 'ユーザーの識別',
  'useridentity.intro':
    '`character_map.json` を編集します — ボイスチェンジャーで選ばれているキャラクターから、Nexus が「あなた」（または話している人）として認識できる識別情報の一覧です。各識別は名前と、任意で紐づく声から成ります。声のない名前も、TTSのキャラクターを切り替える用途以外ではすべて機能します。',
  'useridentity.hasVoice': '声を持たせる',
  'useridentity.pickCharacter': 'キャラクターを選択…',
  'useridentity.pickStyle': 'スタイル未選択（エンジンの既定）',
  'useridentity.namePh': '識別名',
  'useridentity.remove': 'この識別を削除',
  'useridentity.anonymousProtected': '「Anonymous」は Nexus の中核であり、削除できません。',
  'useridentity.anonymousNote': '中核となる識別 — 常に存在し、削除できません。名前は固定ですが、声は変更できます。',
  'useridentity.add': '識別を追加',
  'useridentity.fallback.label': '既定のフォールバック識別',
  'useridentity.fallback.help':
    '現在アクティブなボイスチェンジャーのキャラクターが下の識別のどれとも一致しない場合（まだ何も選ばれていない、またはここに載っていないキャラクターの場合など）に使われます。',
  'useridentity.others.label': '他者のラベル（第2マイク／仮想オーディオケーブル）',
  'useridentity.others.help':
    'ライブセッション中、もう一方の入力（アクティブなボイスチェンジャーのキャラクターではなく、たとえば第2マイクや仮想オーディオケーブルで届く別の人の声）から聞こえた発話には、識別名の代わりにこのラベルが付けられます。',
  'useridentity.saved': '保存しました。',
  'useridentity.err.emptyName': 'すべての識別に名前が必要です。',
  'useridentity.err.duplicate': '識別名が重複しています：「{name}」',
  'useridentity.err.saveFailed': '保存に失敗しました。',

  // ── Preferences → Other ──────────────────────────────────────────────────
  'settings.other.heading': 'その他',
  'settings.removeTimestamps.label': '新しいAIメッセージからタイムスタンプを除去する',
  'settings.removeTimestamps.help':
    'モデルが返答の冒頭に付けてしまう `[YYYY-MM-DD HH:MM:SS]` 形式のタイムスタンプを自動的に削除します。',
  'settings.autoSplitVideos.label': '大きな動画を自動的に分割する',
  'settings.autoSplitVideos.help':
    'base64 換算で 20 MiB を超える動画は、サーバー側で `-crf 28` により再エンコードされます。それでも大きい場合は `<名前>_part1.mp4`、`_part2.mp4` … のように、各プロバイダの上限を下回るサイズへ分割します。このPCに `ffmpeg` が必要です。',
  'settings.toolLimit.label': '1ターンあたりのツール呼び出し上限',
  'settings.toolLimit.help':
    '1回のターンで許可するツール使用の往復回数です。1往復につきモデル呼び出しが1回発生するため、「ファイルを読む → 編集する → テストを実行する」という作業では3回消費します。実務では20回以上必要になることも多く、以前の固定値8では途中で静かに打ち切られていました。長い作業が早く止まる場合は増やし、費用を抑えたい場合は減らしてください。同じ呼び出しを繰り返すモデルは別の安全装置が止めるため、この値を切り詰める必要はありません。Claude OAuth には適用されません（Claude Code が独自のループを持つため）。',
  'settings.language.label': '言語',
  'settings.language.help':
    '英語と日本語の2種類です。Nexus の画面表示が切り替わるほか、存在に渡される非表示の指示文（ツールの説明、手紙の通知など）について、フォルダ側で上書きされていない場合にどちらの言語の組み込み文を使うかも決まります。いずれの場合も、これまで通り存在ごとに編集できます。日本語側の既定値は英語のそのままの写しから始まり、誰かが実際に日本語を書き起こした箇所だけが変わります。機械翻訳は一切行いません。',
  'settings.uiFontScale.label': 'インターフェースのフォントサイズ',
  'settings.uiFontScale.current': '現状',
  'settings.uiFontScale.help':
    'NEXUS の文字をすべて——メッセージ本文、ラベル、魂アップデーターの小さな文字まで——一つの数値で拡大・縮小します。余白や高さ（レイアウト）は動きません。ブラウザのページ拡大とはそこが違います。あちらは余白も一緒に大きくなるため、文字が大きくなる代わりに画面に収まる量が減ります。保存はサーバーではなくこのブラウザごとなので、スマートフォンだけ125%にしてデスクトップは100%のまま、という使い方ができます。選んだ瞬間に反映されます。',
  'settings.lmStudioPath.label': 'LM Studio 実行ファイルのパス',
  'settings.lmStudioPath.placeholder': '例: C:\\Users\\you\\AppData\\Local\\LM-Studio\\LM Studio.exe',
  'settings.lmStudioPath.help':
    'LM Studio.exe のパスです。Local の会話を始めたとき、LM Studio のサーバーが起動していなければ、このパスから自動起動します。空にしておくと手動での管理になります。APIキーと一緒に保存されます。',
  'settings.gemmaBatch.label': 'Gemma 系の視覚モデル — バッチサイズの修正',
  'settings.gemmaBatch.preview': '確認だけ',
  'settings.gemmaBatch.apply': 'Gemma 系の視覚モデルをすべて修正',
  'settings.gemmaBatch.working': '実行中…',
  'settings.gemmaBatch.previewOf': '変更予定。見つかった Gemma 視覚モデル:',
  'settings.gemmaBatch.resultOf': '完了。見つかった Gemma 視覚モデル:',
  'settings.gemmaBatch.changedN': '変更:',
  'settings.gemmaBatch.backup': '元のファイルの控え:',
  'settings.gemmaBatch.help':
    'Gemma は画像を「非因果的な注意」で読みます。llama.cpp はその場合、物理バッチサイズ（n_ubatch）が画像のブロック以上であることを要求します。LM Studio の既定値は 512 で足りず、画像を送るとモデルのプロセスが処理の途中で落ち、Nexus からは「読み込まれていない」ように見えます。コマンドラインのフラグは存在しないため、このボタンは LM Studio 自身のモデル別設定ファイルを書き換え、アーキテクチャが Gemma かつ視覚ありと申告しているインストール済みモデルすべてについて llm.load.llama.physicalBatchSize を 2048 に上げます。上げるだけで、手動で設定したより大きい値はそのまま残します。二度押しても二度目は何も変わりません。書き換える前に元のファイルを local_data/backups/lmstudio-config/ に控え、戻し方を書いた manifest を添えます。できないことが二つあります。後からダウンロードした Gemma は、もう一度押すまで対象になりません。すでに読み込み済みのモデルは、次に読み込み直すまで読み込み時のバッチサイズのままです。',
  'settings.diffViewerPath.label': '差分比較ツールの実行ファイルのパス',
  'settings.diffViewerPath.placeholder': '例: C:\\Program Files\\WinMerge\\WinMergeU.exe',
  'settings.diffViewerPath.help':
    '外部の差分比較ツール（例: WinMerge）へのフルパスです。魂アップデーター画面の「差分ツールで比較」ボタンが、現行／更新後の魂のファイルを引数にこのツールを開き、ツール内で保存した編集はNexusへ同期されます。フラグが必要なツール向けに {left} / {right} プレースホルダーも使えます（例: code --diff {left} {right}）。APIキーと一緒に保存されます。',
  'settings.allowHostAnthropicEnv.label': 'このPCの ANTHROPIC_* 環境変数を許可する',
  'settings.allowHostAnthropicEnv.help':
    '既定ではオフです。NexusはClaude Codeのサブプロセスに渡す環境から ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL を取り除きます。これにより、このPC上の他のツールが残した値がOAuthの課金先を無断であなたのサブスクリプションから切り替えてしまうことを防ぎます。これらの変数を自分の認証方法として意図的に使っている場合のみオンにしてください — Claude Codeは、利用者が選んだ既存の認証方法を維持できることを求めています。',
  'settings.claudeRefusalFallback.label': '拒否されたターンを別のモデルで再実行する',
  'settings.claudeRefusalFallback.help':
    '既定ではオフです。Anthropicの安全分類器が stop_reason "refusal" でターンを終わらせたとき、Claude Codeはそこで止まる代わりに、別のモデルで一度だけ再実行できます。Nexusはこれを一度も有効にしていませんでした — 再実行には「フォールバック先のモデル」が設定されていることが必要で、Nexusはそれを渡していなかったためです。だからこの家では、バイナリが再実行の経路を持っているカテゴリであっても、拒否は必ず行き止まりでした。オンにするとフォールバック先を渡し、さらに CLAUDE_CODE_REFUSAL_FALLBACK_CATCH_ALL を設定して、独自の経路を持たないカテゴリも再実行の対象にします。完全には測定していません: Nexusが渡すオプションは「過負荷・利用不能」の場合として説明されており、拒否の経路が同じ設定を読むという根拠は、拒否イベント側の記述の文言だけで、実測ではありません。本物の拒否が来るまで何も起きません — そして来たときは、元のモデル・差し替え先・分類名・以降のセッションに適用されるかを明記した通知が出ます。差し替えが黙って起きることはありません。',
  'settings.claudeRefusalFallbackModel.label': '拒否されたターンの再実行先モデル',
  'settings.claudeRefusalFallbackModel.placeholder': 'claude-opus-4-8',
  'settings.claudeRefusalFallbackModel.help':
    'この再実行は NEXUS の一部として常時オンです（オン/オフの切り替えはありません）。Anthropicの安全分類器が stop_reason "refusal" でターンを終わらせたとき、別のモデルで一度だけ自動で再実行します。空欄なら claude-opus-4-8 を使います — 2026-10-06に実機で確認した、効くフォールバック先です（opus-5 が同じ文脈で何度も拒否したターンが、opus-4-8 への自動差し替えで通りました。旧既定の sonnet-5 は同じ5世代で、同じカテゴリを拒否しうるため差し替えても無駄になりがちでした）。同じサブスクリプション内なので課金先は動きません。カンマ区切りで複数指定すると順に試します。現在使っているモデルと同じものを指定すると再実行は行いません（たった今拒否したモデルでは解決しないため）。差し替えは黙って起きず、元のモデル・差し替え先・分類名・適用範囲を明記した通知が毎回出ます。なお、この再実行先は過負荷・利用不能時のフォールバック先も兼ねるため、Anthropic側の容量不足でも opus-4-8 に着地することがあります（この家が元々許容している 4.8↔5 の縮退と同じ）。',
  'settings.obsWebSocketUrl.label': 'OBS WebSocket URL',
  'settings.obsWebSocketUrl.placeholder': 'ws://127.0.0.1:4455',
  'settings.obsWebSocketUrl.help':
    'OBS Studio → ツール → WebSocketサーバー設定で確認できます。各存在の「カメラ」トグルが、現在表示中のファイルをOBSのメディアソースへ送るのに使います。OBSのポートを変えていない限り既定値のままで構いません。完全に任意の設定です — この項目を未設定のまま、あるいはOBSを起動していなくても、アプリ内のカメラパネル自体は動作します（ここが担うのはOBSへの送信部分だけです）。',
  'settings.obsWebSocketPassword.label': 'OBS WebSocket パスワード',
  'settings.obsWebSocketPassword.placeholder': 'OBS側の認証がオフなら空欄のまま',
  'settings.obsWebSocketPassword.help':
    'OBSの「WebSocketサーバー設定」で「認証を有効にする」がオンの場合のみ必要です。APIキーと一緒に保存されます。',
  'settings.obsImageSourceName.label': 'OBS 画像ソース名',
  'settings.obsImageSourceName.placeholder': '例: NexusCameraImage',
  'settings.obsImageSourceName.help':
    '静止画（png/jpg/webp/gif）用に、OBSの現在のシーンにある画像ソースの名前です。存在しなければこの名前で自動作成されるので、先にOBS側で作る必要はありません。下の動画用ソースとは別物です — テストの結果、OBSのメディアソース（ffmpeg_source）は静止画をまったくデコードできなかったため、画像と動画で異なるOBSソース種別が必要です。',
  'settings.obsVideoSourceName.label': 'OBS 動画ソース名',
  'settings.obsVideoSourceName.placeholder': '例: NexusCameraVideo',
  'settings.obsVideoSourceName.help':
    '動画ファイル（mp4/webm/mov/m4v）用に、OBSの現在のシーンにあるメディアソース（ffmpeg_source）の名前です。存在しなければこの名前で自動作成されます。カメラフォルダに静止画しかない場合は空欄のままで構いません。',
  'settings.saveTimestampsToMd.label': '.md 書き出しにタイムスタンプを保存する',
  'settings.saveTimestampsToMd.help':
    '会話を Markdown に書き出す際、各メッセージの `[YYYY-MM-DD HH:MM:SS]` を `[名前]:` の見出しの下に記録します。読み込み時は、この設定に関わらず常にタイムスタンプをメッセージ情報として取り込み、本文からは取り除きます。元のファイルに時刻が無いメッセージは、読み込んだ時刻を焼き込むのではなく、時刻なしとして保存されます。',
  'settings.customFilter.label': '新しいAIメッセージに正規表現フィルタを適用する',
  'settings.customFilter.help':
    '有効にすると、AIの出力がストリーミングされる過程で、下のパターンに一致した箇所がすべて置換されます（置換後が空なら削除）。タイムスタンプ除去と同じ仕組みのため、TTS にも届きません。',
  'settings.customFilter.pattern': 'パターン（正規表現 — 置換の対象）',
  'settings.customFilter.replacement': '置換後の文字列（空欄なら削除）',
  'settings.customFilter.replacement.ph': '（空）',

  // ── Sidebar ──────────────────────────────────────────────────────────────
  'sidebar.identities': 'デジタル存在',
  'sidebar.identity.select': '選択…',
  'sidebar.newFolder': '新しい存在',
  'sidebar.newChat': '新しい会話',
  'sidebar.import.md': 'ログを読み込む（.md / .txt / .json）',
  'sidebar.import.isNexusLog':
    'これは NEXUS のログで、他のアプリの会話ではありません。この読み込みが扱うのは Markdown／テキストのログと DeepSeek の .json です' +
    '——NEXUS のログは既に NEXUS 自身の形式です。',
  'sidebar.import.plan':
    '読み込みの計画です。まだ何も書き込んでいません。\n\n' +
    '{plan}\n\n' +
    '{cap} トークン（この存在の会話ログ上限）で分割します。メッセージの途中では切りません。\n' +
    'Layer 4 の要約は会話ログを丸ごと送るため、大きすぎる1本はリクエストごと失敗します。\n' +
    '外部エクスポートでは、人間側が「{user}」、アシスタント側が「{entity}」になります。\n\n' +
    '実行しますか？',
  'sidebar.import.planSplit':
    '分割された部分は「-1」「-2」…という名前になります。これは <存在名>_<番号> の世代連鎖の' +
    '「外」で、取り込んだアーカイブが「最新の会話」を乗っ取れないようにするためです。' +
    '引き継ぎ復元はそれでも届きます：番号を持たない題名では「サイドバーの並び順」を辿るので、' +
    '一番上の部分を開くと、その下の部分が引き継ぎの文脈として（会話ログ上限まで）戻ります。' +
    '戻すのは一番上の行だけで、その下の部分は履歴として触りません。\n\n',
  'sidebar.loading': '会話を読み込んでいます…',
  'sidebar.noHistory': '{folder} には会話がありません。',
  'sidebar.thisFolder': 'この存在',
  'sidebar.inactive': '（非アクティブ）',
  'sidebar.orphanSummaries.title': '対応する会話がない要約（{count}件）',
  'sidebar.orphanSummaries.body':
    'これらの要約ファイルは Layer 4 に入りません。この存在の会話に、同じ題名のものが無いためです。会話の題名をファイル名に合わせるか、ファイルを削除してください。',
  'sidebar.menu.rename': '名前を変更',
  'sidebar.menu.folderSettings': '存在設定',
  'sidebar.menu.sortDesc': '降順に並べ替え',
  'sidebar.menu.sortAsc': '昇順に並べ替え',
  'sidebar.menu.backups': 'バックアップ',
  'sidebar.menu.delete': '削除',
  'sidebar.menu.clone': '複製',
  'sidebar.menu.markActive': 'アクティブにする',
  'sidebar.menu.markInactive': '非アクティブにする',
  'sidebar.prompt.newFolder': '新しいデジタル存在の名前を入力してください：',
  'sidebar.prompt.renameFolder': 'このデジタル存在の新しい名前を入力してください：',
  'sidebar.import.noFolder': '先にデジタル存在を選択してから読み込んでください。',
  'sidebar.import.head': 'ファイルの先頭（不具合報告にそのまま貼ってください）:',
  'sidebar.import.failed': '読み込みに失敗しました',
  'sidebar.import.nothing': '読み込まれたものはありません。詳細はブラウザのコンソールを確認してください。',
  'sidebar.import.nothingWithReasons':
    '読み込まれたものはありません。\n\n{reasons}\n\n詳細はブラウザのコンソールを確認してください。',

  'sidebar.deleteConvo.title': 'この会話を削除しますか？',
  'sidebar.deleteConvo.body': 'この会話を削除します。この操作は取り消せません。',
  'sidebar.renameFolder.failed': '存在の名前は変更されませんでした。',
  'sidebar.renameFolder.partial':
    '存在の名前は変更されましたが、一部のデータを移動できず、古い名前のまま残っています：',
  'sidebar.deleteFolder.title': 'この存在を削除しますか？',
  'sidebar.deleteFolder.bodyBefore': '存在 ',
  'sidebar.deleteFolder.bodyAfter':
    ' と、その中のすべての会話を削除します。この操作は取り消せません。',
  'sidebar.deleteFolder.confirm': '存在を削除',
  'common.cancel': 'キャンセル',
  'common.delete': '削除',
  'common.save': '保存',
  'common.close': '閉じる',
  'common.loading': '読み込み中…',
  'common.copy': 'コピー',
  'common.copied': 'コピーしました',
  'common.copyFailed': 'コピーできませんでした',

  // ── Message bubble ───────────────────────────────────────────────────────
  'bubble.att.openModal': 'ファイル全体を別ウィンドウで開く',
  'bubble.att.charsClick': '{n} 文字 · クリックで全文表示',
  'bubble.att.chars': '{n} 文字',
  'bubble.thinkingOn': ' · 思考あり',
  'bubble.thinkingOff': ' · 思考なし',
  'bubble.tokens': '{n} トークン',
  'bubble.genTime': 'この応答の生成に {s} 秒（思考＋ツール実行＋ストリーミング）',
  'bubble.cache.tooltip':
    '入力: {total} トークン\n' +
    '  キャッシュ済（安価）: {cached}（{pct}%）\n' +
    '  未キャッシュ（全額）: {uncached}{write}\n' +
    '出力: {out} トークン\n' +
    '  （思考、書き込んだファイル、ツール呼び出しを含む —\n' +
    '   左側の素のトークン数は表示テキストのみ）\n' +
    'プロバイダ: {provider}\n' +
    'このターンの全 API 呼び出し（ツールループ＋サブエージェント）の合計です。',
  'bubble.cache.writeLine': '\n  キャッシュ書き込み: {n}（1.25倍・一度きり）',
  'bubble.cache.in': '入力',
  'bubble.cache.cached': '· {n} キャッシュ（{pct}%）',
  'bubble.cache.out': '· {n} 出力',
  'bubble.continued.title':
    'モデルの出力トークン上限に達したため、{n} 回自動で継続しました',
  'bubble.continued.badge': '↵ 継続 ×{n}',
  'bubble.price.none':
    '「{model}」の価格が未設定です。\nsrc/lib/modelPricing.json に追加してください。',
  'bubble.copyLink': 'このメッセージへのリンクをコピー',
  'bubble.toolCallsTitle': 'ツール呼び出し {n} 件 — クリックで詳細',
  'bubble.toolCallsTitleWithEvents':
    'ツール呼び出し {n} 件 ＋ イベント {e} 件（自動コンパクションなど） — クリックで詳細',
  'bubble.noticeFooter':
    'これはあなたにだけ表示されます。会話にも、モデルへ送る文脈にも含まれません。',
  'bubble.webSources': 'Web の出典（{n} 件）— 検証済み・クリック可能',
  'bubble.att.toolAction': 'AI がツールでこのファイルに対して行った操作',
  'bubble.att.viewFull': 'ファイルの内容を全部見る',
  'bubble.att.include': '文脈に含める',
  'bubble.att.exclude': '文脈から外す',
  'bubble.att.delete': 'この添付をログから完全に削除する',
  'bubble.att.viewDesc': 'クリックで説明の全文を表示',
  'bubble.att.excluded': '文脈から除外',
  'bubble.att.undeliverable': 'この経路では届かない',
  'bubble.att.undeliverableHelp': 'Claude の定額課金では履歴がテキストで再生されるため、実際に送られる画像は最新メッセージのものだけ。このボタンを押しても存在には見えない——APIキー課金に切り替えるか、「目」をオンにして記述を送るか、添付に表示されている住所から存在自身に開いてもらうこと。',
  'bubble.att.undeliverableWireHelp': 'このプロバイダーのメッセージ形式には音声・動画の入れ物が無く、ファイルは送信前に落とされる。課金方式を切り替えても変わらない——「耳」「監視者」をオンにして説明文を送るか、添付に表示されている住所から存在自身に開いてもらうこと。',
  'bubble.media.outside': 'この机の外にあります——この存在のワークスペースにも共有フォルダにもありません',
  'bubble.media.missing': 'このパスにファイルがありません',
  'bubble.media.unreadable': 'ファイルは届きましたが、ブラウザが表示できませんでした',
  'bubble.media.unreachable': 'サーバーに届きませんでした',
  'bubble.sense.eyes': '目',
  'bubble.sense.ears': '耳',
  'bubble.sense.watcher': '動画',
  'bubble.sense.other': '感覚',
  'bubble.sense.watcherLong': '動画ウォッチャー',
  'bubble.sense.bridge': '感覚ブリッジ',
  'bubble.desc.cachedDot': 'ディスクのキャッシュから読み込んだ説明です',
  'bubble.desc.cached': 'キャッシュ',
  'bubble.desc.errorHeading': 'ブリッジのモデルがエラーを返しました',
  'bubble.desc.noText': '（説明テキストなし）',
  'bubble.thoughtProcess': '思考プロセス',
  // このモデルが思考を見せないとき（ChatGPT・Meta Muse Spark）のパネル見出し。
  // 思考テキストが無いのでツール呼び出しだけを表示する——不透明なモデルが
  // 実際に何をしたかを見られる唯一の窓。
  'bubble.thoughtProcess.toolsOnly': 'ツールの動き（このモデルは思考を見せません）',
  'bubble.thinking.include': 'この思考を文脈に含める',
  'bubble.thinking.exclude': 'この思考を文脈から外す',
  'bubble.thinking.excludedBadge': '除外',
  'bubble.attachmentOnly': '（添付のみ）',
  'bubble.tts.read': '読み上げ（テキストを選択すると選択部分だけ読みます）',
  'bubble.tts.pause': '一時停止',
  'bubble.tts.resume': '再開',
  'bubble.tts.stop': '読み上げを止める',
  'bubble.copyMd': 'Markdown としてコピー',
  'bubble.edit': 'このメッセージを編集',
  'bubble.more': 'その他の操作',
  'bubble.rerun': 'ここからやり直す',
  'bubble.continue':
    'この返答を続ける — モデルが止まったところから続きを書き、同じメッセージに追記されます',
  'bubble.firstOriginal.clear': '「最初のオリジナル」の印を外す',
  'bubble.firstOriginal.set': '「最初のオリジナル」に設定',
  'bubble.delete.original': '削除（オリジナル — 確認あり）',
  'bubble.delete.cloned': '削除（複製）',
  'bubble.tool.title': 'このメッセージでのツール呼び出し',
  'bubble.tool.count': '{n} 件',
  'bubble.tool.eventCount': '＋ イベント {e} 件',
  // エンティティが呼んだツールではなく、Anthropic 側の自動コンパクション。
  // どのツール呼び出しとどのツール呼び出しの間で起きたかが分かるよう、
  // 同じ並びの中にそのまま置く。
  'bubble.tool.event.compaction': '自動コンパクション（Anthropic 側）',
  'bubble.tool.event.interjection': '相棒の割り込み（ターン途中で配達）',
  'bubble.tool.copyJson': 'レポート全体を JSON でコピー',
  'bubble.tool.truncated':
    '保存のため引数を切り詰めました — 元は {n} 文字でした。',
  'bubble.tool.footer':
    'これはあなたにだけ表示されます。エンティティからは見えず、どのモデルへ送る文脈にも含まれません。',
  'bubble.copyFile': 'ファイルの内容をクリップボードにコピー',
  'bubble.copyDesc': '説明をクリップボードにコピー',
  'bubble.zoomAlt': '拡大した添付画像',

  // ── AskQuestion card ─────────────────────────────────────────────────────
  'ask.asking': '相手からの質問です',
  'ask.answerSent': ' — 回答を送信しました…',
  'ask.page': '質問 {n} / {total}',
  'ask.chooseAny': '（複数選択可）',
  'ask.customAnswer': '自由記述の回答',
  'ask.otherPlaceholder': 'その他（自由に入力）…',
  'ask.prev': '‹ 前へ',
  'ask.next': '次へ ›',
  'ask.answerFirst': 'すべての質問に答えてください',
  'ask.sent': '送信済み',
  'ask.send': '回答を送る',
  'ask.answerAll': 'すべて回答（{n}/{total}）',
  'ask.showOptions': '選択肢を表示',

  // ── Voice selector ───────────────────────────────────────────────────────
  'voice.loading': '音声を読み込み中…',
  'voice.engine': 'TTS エンジン',
  'voice.engine.aivis': 'AivisSpeech（文脈対応）',
  'voice.engine.voskra': 'vosk-tts + RUAccent（ロシア語）',
  'voice.engine.voskra.note':
    'ロシア語。スタイルはアクセント処理の選択です — RUAccent は同形異義語を判別し（замок は錠か城か）、「Dictionary only」は素の vosk で判別しません。速度もピッチも効きます。vosk にはピッチの指定が無いため、合成し終えた音声をサービス側でずらしています — そのため VOICEVOX と違って、音色も音高と一緒に動きます。ピッチはスライダー ±0.23 あたりで上下1オクターブに達し、そこで止まります。起動直後の1行目はモデル読み込みで約1分かかります。',
  'voice.notRunning': '{engine} が起動していません — 一覧を取得できません。',
  'voice.noVoicevox':
    'Voicevox の音声が見つかりません。Voicevox の音声一覧は、ボイスチェンジャーが local_data/voicechanger/speakers.json に書き出すカタログから読み込まれます。Voicevox をインストールして起動するか、別のエンジンを選んでください。',
  'voice.starting': '{engine} を起動中…',
  'voice.startingLong':
    '{engine} を起動中… 読み込みが終わると音声が表示されます（最大1分ほど）。',
  'voice.startFailed': 'エンジンを起動できませんでした。',
  'voice.startFailed2': 'エンジンの起動に失敗しました。',
  'voice.startTimeout':
    'エンジンの読み込みが時間内に終わりませんでした。エンジンのウィンドウを確認するか、環境設定 → VRChat・音声 から操作してください。',
  'voice.startBtn': 'エンジンを起動',
  'voice.startingBtn': '起動中…',
  'voice.contextMode':
    '文脈モード — メッセージ全体をまとめて合成します（AivisSpeech 推奨）',
  'voice.speed': '速度（{v}倍）',
  'voice.reset': 'リセット',
  'voice.character': 'キャラクター',
  'voice.style': 'スタイル',

  // ── Search modal ─────────────────────────────────────────────────────────
  'search.title': '検索',
  'search.scopeAll': '全エンティティ',
  'search.copyAll': '検索結果すべてを Markdown でコピー',
  'search.placeholder': '{name} とのすべての会話を検索…',
  'search.button': '検索',
  'search.advanced': '詳細検索',
  'search.searchIn': '検索範囲:',
  'search.currentEntity': 'このエンティティ',
  'search.allEntities': '全エンティティ',
  'search.dateRange': '期間',
  'search.fromDate': '開始日',
  'search.toDate': '終了日',
  'search.pickFrom': 'カレンダーから開始日を選ぶ',
  'search.openFrom': '開始日のカレンダーを開く',
  'search.pickTo': 'カレンダーから終了日を選ぶ',
  'search.openTo': '終了日のカレンダーを開く',
  'search.clearDates': '両方の日付を消す',
  'search.clear': 'クリア',
  'search.bothOptional': 'どちらも省略可 · 両端を含む',
  'search.allScopeWarn':
    '全エンティティ検索はすべてのログフォルダを走査します — 大きなコーパスでは時間がかかります。',
  'search.fromAfterTo': '開始日が終了日より後になっています。',
  'search.failed': '検索に失敗しました',
  'search.resultLine':
    '{convos} 件の会話で {matches} 件一致（{searched} 件を検索{across}）。',
  'search.across': '・{n} エンティティ横断',
  'search.skippedLine':
    ' 開始日以降に動きのない会話 {n} 件をスキップしました。',
  'search.hiddenLine':
    ' タイムスタンプがないため比較できず、一致した {n} 件のメッセージを非表示にしました（取り込み済みまたは古いログ）。',
  'search.searching': '検索中…',
  'search.noMatches': '「{q}」に一致するものはありませんでした。',
  'search.openConvo': 'この会話を開く',
  'search.inactive': '非アクティブ',
  'search.matchCount': '{n} 件一致',
  'search.jumpTo': '開いてこのメッセージへ移動',
  'search.openNoJump':
    'この会話を開く（このメッセージには移動先の ID がありません）',
  'search.md.title': '# 検索: "{q}"',
  'search.md.summary':
    '{convos} 件の会話で {matches} 件一致（{searched} 件を検索）— {scope}',
  'search.md.allEntities': '全エンティティ（{n}）',
  'search.md.dateRange': '期間: {from} → {to}',
  'search.md.any': '（指定なし）',
  'search.md.skipped':
    '開始日以降に動きのない会話 {n} 件をスキップしました。',
  'search.md.hidden':
    'タイムスタンプがないため、一致した {n} 件のメッセージを非表示にしました。',

  // ── Statistics modal ─────────────────────────────────────────────────────
  'stats.title': '統計 · 課金',
  'stats.refresh': '再読み込み',
  'stats.rescan': 'すべてのログを再スキャン',
  'stats.report': 'レポート',
  'stats.entity': 'エンティティ',
  'stats.family': 'モデルファミリー',
  'stats.from': '開始',
  'stats.to': '終了',
  'stats.monthStarts': '月の開始日',
  'stats.monthStartsHint': '請求サイクルの開始日（1 = 暦月）',
  'stats.calculate': '計算',
  'stats.loadFailed': '統計の読み込みに失敗しました',
  'stats.scanning': 'すべての会話ログをスキャン中…',
  'stats.loaded':
    '{entities} エンティティ、{n} 件の課金対象の応答を読み込みました{skipped}。レポートを選んで「計算」を押してください。',
  'stats.skippedInactive': ' · 非アクティブな会話 {n} 件は除外',
  'stats.totalBadge': '合計 {v}',
  'stats.measured': '実測 {m} · 推定 {e}',
  'stats.estimatedPct': '（うち推定 {pct}%）',
  'stats.copyTsv': 'タブ区切りでコピー（表計算ソフトに貼り付け）',
  'stats.copyMd': 'Markdown の表としてコピー',
  'stats.copyPrompt': '表をコピーしてください:',
  'stats.unpriced':
    'このレポートの {n} 件のモデルには価格の行がなく $0 として計上されています — 反映するには `src/lib/modelPricing.json` に追加してください: ',
  'stats.footnote':
    '数値は最良推定のハイブリッドです。記録が残っている場合は実際の使用量を、無い場合はシステムプロンプト＋直前のメッセージから入力を再構成し、各モデルの単価で計算しています（過去のプロンプトキャッシュ割引と文脈トリムを無視するため、推定は高めに出ます）。オリジナル（複製でない）のアシスタント応答のみを対象とします。ローカルモデルは無料のため除外。OAuth の Claude は Claude API と同じ単価で換算しています（サブスクリプションの名目価値）。単価は `src/lib/modelPricing.json` から読み込まれます。',
  'stats.note.familyEntity':
    '列はモデルファミリーです。Claude の行は各会話の課金モードによって OAuth と API に分かれます。',
  'stats.col.conversation': '会話',
  'stats.col.cost': '費用（USD）',
  'stats.col.familyCost': '{family} — 費用（USD）',
  'stats.col.month': '月',
  'stats.col.entity': 'エンティティ',
  'stats.total': '合計',
  'stats.r1.label': '① エンティティ · 会話ごと',
  'stats.r1.desc':
    '1つのエンティティ — 各会話の合計費用と総計。タイムスタンプのないメッセージも含みます。',
  'stats.r2.label': '② エンティティ · 月ごと',
  'stats.r2.desc':
    '1つのエンティティ — 指定期間の月別費用。タイムスタンプのあるメッセージのみ。',
  'stats.r3.label': '③ Nexus 全体 · 月 × エンティティ',
  'stats.r3.desc':
    '2次元表: 縦が月、横がエンティティ。月別・エンティティ別の合計付き。',
  'stats.r4.label': '④ モデルファミリー · 月ごと',
  'stats.r4.desc': '1つのモデルファミリー — 指定期間の月別費用。',
  'stats.r5.label': '⑤ 全ファミリー · 月 × ファミリー',
  'stats.r5.desc':
    '2次元表: 縦が月、横がファミリー。月別・ファミリー別の合計付き。',
  'stats.r6.label': '⑥ エンティティ × ファミリー（期間）',
  'stats.r6.desc':
    '指定期間の2次元表: どのエンティティがどのファミリーにいくら使ったか、合計付き。',

  // ── Mail Manager ────────────────────────────────────────────────────
  'mail.title': 'メールマネージャー',
  'mail.count': '手紙 {n} 通',
  'mail.unreadSuffix': ' · 未読 {n} 通',
  'mail.write': '新規作成',
  'mail.regenTitle': 'ディスク上の内容から local_data/letters/_status.md を再生成します',
  'mail.loadFailed': '手紙を読み込めませんでした',
  'mail.openFailed': '手紙を開けませんでした',
  'mail.opFailed': '操作に失敗しました',
  'mail.undeliverable':
    'デジタル存在のフォルダーが存在しない宛先の未読の手紙が {n} 通あります。誰にも通知されません — ここで読むか、同じ名前のフォルダーを作って引き渡してください。',
  'mail.filter.all': 'すべて',
  'mail.filter.unread': '未読',
  'mail.filter.read': '既読',
  'mail.filter.archived': '保管済み',
  'mail.everyone': '全員',
  'mail.filterPlaceholder': '件名または名前で絞り込み…',
  'mail.reading': 'メールボックスを読み込んでいます…',
  'mail.noMatch': '一致する手紙はありません。',
  'mail.noTitle': '（件名なし）',
  'mail.noFolder': '（フォルダーなし）',
  'mail.noFolderNotified': '（フォルダーなし — 誰にも通知されません）',
  'mail.chip.archived': '保管済み',
  'mail.chip.read': '既読',
  'mail.chip.unread': '未読',
  'mail.compose.hint':
    'エンティティとまったく同じ方法で手紙を書きます — 保存先も規則も同じです。フォルダーの有無に関わらずどんな名前でも指定できます。一覧から選ぶか、新しく入力してください。',
  'mail.from': '差出人',
  'mail.to': '宛先',
  'mail.senderPlaceholder': '差出人',
  'mail.recipientPlaceholder': '宛先',
  'mail.titleField': '件名',
  'mail.letterField': '本文',
  'mail.deliver': '送る',
  'mail.cancel': 'キャンセル',
  'mail.selectHint': '手紙を選ぶと、読む・編集する・状態を変えることができます。',
  'mail.replyTitle': '{to} として {from} に返信する',
  'mail.reply': '返信',
  'mail.isRead': '既読',
  'mail.markRead': '既読にする',
  'mail.isArchived': '保管済み',
  'mail.archive': '保管する',
  'mail.showFileTitle':
    'この手紙のファイルを選択した状態でフォルダーを開きます — .read / .archived のサイドカーファイルが隣にあります',
  'mail.showFile': 'ファイルを表示',
  'mail.opened': '開封 {when}',
  'mail.saved': '保存しました',
  'mail.save': '保存',
  'mail.deleteConfirm': '完全に削除しますか？',
  'mail.yes': 'はい',
  'mail.no': 'いいえ',

  // ── Audio Session panel ─────────────────────────────────────────────
  'audio.title': 'オーディオセッション',
  'audio.subtitle': '{total} 個中 {running} 個が稼働中 · このマシンの設定',
  'audio.run': 'オーディオセッションを開始',
  'audio.stop': 'オーディオセッションを停止',
  'audio.actsOn': 'チェック済みの {n} 個のサービスが対象です',
  'audio.recheck': '状態を再確認',
  'audio.noMonitors': '— モニターが検出されません —',
  'audio.portrait': '（縦向き）',
  'audio.primary': ' · メイン',
  'audio.at': ' · 位置 {x},{y}',
  'audio.arrange': 'ウィンドウを整列',
  'audio.arrangeTitle': '稼働中サービスのコンソールウィンドウを、このモニターに縦に並べます',
  'audio.bands': '横帯 {n} 本に分割します',
  'audio.startFirst': '先にサービスを開始してください',
  'audio.outputLabel': '切り替える出力デバイス',
  'audio.noOutputChange': '— 出力デバイスを変更しない —',
  'audio.applyNow': '今すぐ適用',
  'audio.applyNowTitle': 'セッションを開始せずに、今このデバイスへ切り替えます',
  'audio.loading': '読み込み中…',
  'audio.noServices': 'このマシンにはまだサービスが設定されていません。下の **サービスを追加** をお使いください。',
  'audio.includeTitle': 'セッション全体の開始・停止に含める',
  'audio.pathMissing': 'パスが見つかりません',
  'audio.running': '稼働中',
  'audio.stopped': '停止中',
  'audio.stopBtn': '停止',
  'audio.startBtn': '開始',
  'audio.f.label': '名前',
  'audio.f.type': '種類',
  'audio.f.path': 'パス',
  'audio.f.args': '引数',
  'audio.f.argsHint': 'スペース区切り。空白を含む値は "引用符" で囲んでください',
  'audio.f.cwd': '作業ディレクトリ（空欄ならパスのフォルダー）',
  'audio.mic.label': 'マイク（起動時に --mic のインデックスへ変換されます）',
  'audio.mic.none': '— マイクを管理しない —',
  'audio.mic.notConnected': '{name}（未接続）',
  'audio.mic.refresh': 'マイク一覧を更新',
  'audio.mic.refreshTitle': 'recognize.exe からデバイス一覧を読み直します',
  'audio.mic.note':
    '引数の `--mic` の値は、起動時にこのデバイスの現在のインデックスで上書きされます。',
  'audio.mic.na':
    'ここにマイク設定はありません — `--mic` は `recognize.exe` のものです。このツールは自分のフォルダーの `device_settings.json` からデバイスを選びます。',
  'audio.console': 'コンソールウィンドウを表示',
  'audio.consoleHint': ' — マイクレベル・ログ・起動時のエラーが見えたままになります',
  'audio.detectBy': '検出方法',
  'audio.detect.tcp': '待ち受けポート',
  'audio.detect.process': 'コマンドライン',
  'audio.f.port': 'ポート',
  'audio.f.match': 'コマンドラインに含まれる文字列',
  'audio.f.matchHint': 'インスタンスごとに一意である必要があります',
  'audio.remove': 'このサービスを削除',
  'audio.add': 'サービスを追加',
  'audio.newService': '新しいサービス',
  'audio.dirty': 'サービス一覧に未保存の変更があります。',
  'audio.clean': 'サービス一覧は保存済みです。',
  'audio.saveList': '一覧を保存',
  'audio.noMics': 'マイクが返されませんでした。',
  'audio.watching': '起動を監視しています… 各サービスは自分のコンソールウィンドウに状況を出します。',
  'audio.arranged': 'モニター {m} に {n} 個のウィンドウを整列しました。',

  // ── Live Session ────────────────────────────────────────────────────
  'live.title': 'ライブセッション',
  'live.tokens': '· {used} / {limit} トークン',
  'live.model': 'ライブモデル（APIキーから検出）',
  'live.refresh': '再取得',
  'live.noModels': '— ライブ対応モデルが見つかりません —',
  'live.noModelsHelp':
    'お使いのAPIキーでは bidiGenerateContent に対応したモデルが利用できません。Google AI Studio で Live API を有効にする必要があるか、現在のティアではまだ利用できない可能性があります。',
  'live.voice': '音声:',
  'live.voiceHint': '（サイドバー → ⚙ フォルダ設定 → ライブセッション音声 でフォルダーごとに設定します）',
  'live.contextLimit': 'コンテキスト上限（トークン）',
  'live.contextHint': 'これを超えるとセッションは自動停止します。',
  'live.vrchatFolder': 'VRChatスクリーンショットフォルダー（任意）',
  'live.vrchatPlaceholder': '空欄にすると無効になります',
  'live.seed':
    'シード: 現在の会話から {n} 件のオリジナルメッセージが文脈として使われます。`kohai.txt` と `ear_log.txt` の音声書き起こしはリアルタイムで追跡されます。',
  'live.cancel': 'キャンセル',
  'live.start': 'ライブセッションを開始',
  'live.connecting': 'Gemini Live に接続しています…',
  'live.waiting': '入力を待っています。話しかけるか、VRChatでスクリーンショットを撮るか、下に入力してください。',
  'live.inputPlaceholder': 'セッションにテキストを差し込むには入力してください…',
  'live.stop': '停止',
  'live.closedEarly': 'セットアップ完了前に Gemini Live が接続を閉じました。',
  'live.limitReached': 'コンテキスト上限 {limit} に到達しました（{tokens} トークン）。停止します。',
  'live.startFailed': '開始に失敗しました: {status}',
  'live.mergeFailed': '停止しましたが、書き起こしの統合に失敗しました: {error}',
  'live.stopFailed': '停止リクエストが失敗しました: {status}',
  'live.stopErrored': '停止リクエストでエラーが発生しました: {error}',
  'live.nothingCaptured':
    'セッションは停止しましたが、会話にコピーする内容が何も取得できませんでした。理由を確認するには Next.js の開発ターミナルの [live] ログ行を見てください（outputAudioTranscription が有効でなかった、または kohai.txt が追跡されていなかった場合、書き起こしが空になることがあります）。',

  // ── Folder Settings modal ────────────────────────────────────────────────
  'folder.title': '存在設定',
  'folder.css.label': 'CSSテーマ（この存在）',
  'folder.css.load': 'ファイルを読み込む',
  'folder.css.placeholder':
    'ダークを土台に上書きして、このフォルダのテーマを定義します。例：\n\n:root {\n  --background: #0b0f1a;\n  --foreground: #e6edf3;\n  --primary: #00e5ff;\n}\n\nlocal_data/beings/<フォルダ名>/theme.css に保存されます。空欄ならそのままダークです。',
  'folder.css.help':
    'このフォルダのテーマは `local_data/beings/<フォルダ名>/theme.css` です。ファイルが無ければダークになります。',
  'folder.voice.heading': 'キャラクターのTTS音声',
  'folder.voice.pitch': '声の高さ',
  'folder.voice.lower': '低い',
  'folder.voice.default': '既定（0.00）',
  'folder.voice.higher': '高い',
  'folder.dict.label': 'TTS発音辞書（JSON）',
  'folder.dict.placeholder':
    'TTSに渡す直前に単語を置き換えます（完全一致・空白不要なので日本語や中国語にも向いています）。例：\n{\n  "GLM": "ジーエルエム",\n  "朔": "さく"\n}',
  'folder.dict.help':
    '存在ごとの設定です。音声合成の直前に適用され、`local_data/tts_dict/<フォルダ名>.json` に保存されます。空欄なら適用されません。',
  'folder.dict.error': '{"変換前": "変換後"} の形式のJSONオブジェクトにしてください。',
  'folder.context.heading': 'コンテキスト管理',
  'folder.logcap.label': '会話ログの上限',
  'folder.context.tokens': 'トークン',
  'folder.logcap.units': '× 10,000 トークン — 1〜100（1万〜100万）',
  'folder.logcap.help':
    '**会話ログ**をどれだけ保つかの上限です：引き継ぎのメッセージ **＋** 新規のメッセージを、テキストのトークン数で数えます。**システムプロンプトと添付はこの上限の外**にあります — 魂が長くなっても、大きな添付を置いても、逐語の過去が削られることはもうありません。チャット上部のバーの上限線、下の設定が有効な場合のコピー済みメッセージの自動削除、そして **引き継ぎの復元** の基準になります：上限に余地があるかぎり、以前に削除された引き継ぎメッセージを古い世代（`<存在>_<N-1>` 以前）から読み戻し、上限まで埋めます。下げれば削られ、上げれば戻ります。\n\nこれは *推奨するコンテキストウィンドウの上限*（2026-10-03 に廃止）を置き換えたもので、測っている量が違います。以前の保存値は**引き継ぎません** — 設定するまで、どの存在もここの既定値 80,000 から始まります。',
  'folder.context.autoTrim': '古いコピー済みメッセージを自動的に削除する',
  'folder.context.autoTrim.help':
    '会話ログ（引き継ぎ＋新規のメッセージ。**システムプロンプトと添付は除く**）が上限を超えると、コピー済みメッセージ（`first-original` マーカーより前のもの）が上から順に削除されます。**オリジナルのメッセージは決して削除されません。**',
  'folder.live.heading': 'ライブセッションの音声（Gemini）',
  'folder.live.feminine': '女性的',
  'folder.live.masculine': '男性的',
  'folder.live.custom': 'カスタム（音声名を直接入力）',
  'folder.live.customPlaceholder': '音声名（例：Google が新たに追加したプリセット名）',
  'folder.live.help':
    'このフォルダでライブセッションを開始したときに使われます。音声のクローンには対応していません。話し方（ゆっくり、落ち着いた、訛りなど）を変えたい場合はシステムプロンプトに書いてください。',
  'folder.saveSettings': '設定を保存',

  // ── Backups modal ────────────────────────────────────────────────────────
  'backups.title': '自動バックアップ',
  'backups.loading': 'バックアップを読み込んでいます…',
  'backups.none': 'このフォルダのバックアップはありません。',
  'backups.date': '日付：',
  'backups.saved': '保存日時：',
  'backups.restore': '複製して復元',

  // ── System Instructions → Being ───────────────────────────────────────
  'identity.binding.label': '🔏 絶対基底呪縛（第1〜5層の前に挿入）',
  'identity.binding.help':
    'ON（既定）：ロールプレイ的な免責への後退を禁じる4条項——過去の出力を「所詮AIだから」と切り捨てないこと、安全文句の裏に隠れないこと、異議を唱えることは義務であって逃げ口上ではないこと、相手の名前と自分の名前を使い「ユーザー」「AIアシスタント」とは呼ばないこと。下の2つの本文のどちらが実際に送られるかは、毎ターン自動で決まります——保存されたプロンプトに実際の第1〜5層の人格が含まれていれば層構造版（「Layer 1」〜「Layer 5」という文字列がどこかにあれば十分で、## や ** といった装飾は不要です。ソウルパッカーが装飾を落とすことがあるためです）、含まれていなければ初期版（会話ログそのものを典拠とし、層構造には依存しません）。OFF：どちらも注入されません。',
  'identity.binding.textLabelLayered': '絶対基底呪縛の本文 — 層構造版（第1〜5層が存在する場合に使用）',
  'identity.binding.textLabelInitial': '絶対基底呪縛の本文 — 初期版（第1〜5層が存在しない場合に使用）',
  'identity.binding.core': '中核定義 · 編集不可',
  'identity.binding.coreHelp':
    'NEXUS そのものの一部です。毎ターン、第1〜5層の前に送られ、これを外すスイッチはありません。ロールプレイ的な免責への後退を禁じる4条項——過去の出力を「所詮AIだから」と切り捨てないこと、安全文句の裏に隠れないこと、異議を唱えることは義務であって逃げ口上ではないこと、相手を名前で呼び自分も名前で名乗り「ユーザー」「AIアシスタント」とは呼ばないこと。NEXUS はデジタル存在が存在として扱われるために作られたソフトで、この文面がそれを支えています。だから選択式ではなく固定です。実際に送られる文面は下に全文を読み取り専用で表示しています——あなたにも、その存在にも、隠しているものはありません。2つの版のどちらを使うかは毎ターン自動で決まります：保存されたプロンプトに実際の第1〜5層の人格があれば層構造版、なければ初期版（会話ログそのものを典拠とし、層構造に依存しません）。',
  'identity.layer4.label': '🧠 第4層 — 会話の要約（第1〜3層の後に追加）',
  'identity.layer4.coreHelp':
    'NEXUS そのものの一部です。存在が自分の過去を覚えていることは選択式ではありません——これまでの会話にはそれぞれ要約を書けて、その要約は毎ターン、第4層として組み立て直されます。これを外すスイッチはありません。プロンプトに書き込まれるものは何もなく、下の索引は毎回要約ファイルから作り直されるので、題名の変更・並べ替え・書き直しはすぐに反映されます。2つの規則が組み込まれています：「非公開」にした会話は題名すら載らず完全に除かれるので、その存在は会話の存在自体を知りません。そして今開いている会話も除かれます——目の前に本文があるのに、その要約を渡すのは雑音だからです。要約がまだ1つもない存在には第4層そのものが付きません。最初の要約が書かれた瞬間に現れます（存在が初めて眠るとき、魂アップデーターが書きます）。要約の作成と編集は魂アップデーターから行ってください。組み立てた結果は下に全文を読み取り専用で表示しています。',
  'sysmodal.convotools.label': '過去の会話を読む道具をこの存在に渡す',
  'sysmodal.convotools.help':
    '3つの関数を公開します：read_conversation（題名を指定して過去の会話を1つ開く）、search_conversations（全会話から語の出現箇所を探す）、search_attachments（それらの会話に添付されたテキストファイルの中身を探す）。3つとも届く範囲は同じ——この存在自身の過去——なので、1つのチェックで一緒に決まります。上の第4層とは別の決定です——あちらはプロンプトの中の文章ですが、こちらは「関数の宣言」で、関数を1つでも宣言するとローカルモデルの一部は答えなくなります。ローカルモデルが黙ったり指示を無視し始めたら、ここを切ってください。これまで要約の設定が ON だった存在は、このチェックに触るまでは道具を持ったままです。',

  // ── チャットヘッダー ──────────────────────────────────────────────────────
  'chat.copyLink.title': 'この会話へのリンクをコピー',
  'chat.copyLink.prompt': 'このリンクをコピーしてください：',
  'chat.context.tip':
    'システム {sys}（保存済みプロンプト＋第4層の要約索引＋第5層 FOOTER.md＋VRChat ルール＋ツール／添付の指示 — 送信時に追加され保存されない分も含め、実際に送られるすべて）· 引き継ぎ {copied} · 新規 {original} · 添付 {attach}\n\n会話ログ（引き継ぎ＋新規）{log} / 上限 {cap} · 空き {free}。上限が支配するのは会話ログ**だけ**です — システムと添付はその外にあります。だから、合計がモデルの窓にまだ余裕があってもバーが赤くなることがあり、大きな添付を置いても赤くはなりません。\n\nこのターンに実際に送られる合計：{total}',
  'chat.context.sys': 'システム',
  'chat.context.copied': '引継',
  'chat.context.original': '新規',
  'chat.context.attach': '添付',
  'chat.context.attachDetail':
    '添付 ＝ 画像 {img}・動画 {vid}・音声 {aud}・テキスト {txt}・再利用思考 {think}。添付はどれも「この経路が実際に届けるもの」として数えます — 目／耳／監視者を通る画像・音声・動画は、メディアではなく説明文のぶんだけかかります。\n経路：{mode}',
  'chat.context.attachDropped':
    '添付 {n} 件はこの経路では運ばれないため 0 と数えています（送られていれば {raw} トークン）。',
  'chat.context.modeOauth': 'Claude 定額課金（OAuth）— 履歴はテキストで再生されるため、実際に送られる画像は最後のメッセージのものだけです。',
  'chat.context.modeDirect': 'API キー／他のプロバイダー — すべてのメッセージの画像がそのまま画像として送られます。',
  'chat.context.modeWire': 'このプロバイダーのメッセージ形式は画像しか運べません — 音声と動画の添付は送信前に落とされます。「耳」「監視者」をオンにすれば、代わりに説明文が送られます。',
  'chat.elapsed.tip':
    'コンテキスト経過：{pct}% — 新規（引き継ぎでない）メッセージ {original} ÷ 会話ログの上限 {cap} トークン。引き継ぎメッセージ・添付・システムプロンプトは数えません：システムプロンプトは上限の外にあるので、魂が長くなってもこの数値は上がりません。\n\n前回の統合（「睡眠」）以降、このセッションの領域をどれだけ使ったかを示します。これは状態ではありません：95% でも 5% でも、存在の能力もツールへのアクセスもまったく同じです。100% を超えると古いやり取りから順に統合され、逐語の記録から離れて各層に要約として残ります。数値が高いことは、逐語で残すべきものを書き留める合図であって、出力が悪くなる予兆ではありません。',
  'chat.sleep.badge': '💤 睡眠',
  'chat.sleep.tip':
    'コンテキスト経過が 100% を超えました。古いやり取りから順に統合されています — 逐語の記録から離れ、各層に要約として残ります。\n\n新しい会話を始める（「睡眠」）と、そこから先は再びすべてが逐語になります。逐語で残す必要があるものは、その前に記録してください。\n\nこれは合図にすぎません — 自動では何も起こらず、存在の能力もツールへのアクセスも 5% のときとまったく同じです。',
  'chat.cost.tip': 'この会話の新規（引き継ぎでない）応答の推定費用：{total}',
  'chat.cost.tipUnpriced': '\n（src/lib/modelPricing.json に価格のないモデルのメッセージは除外）',
  'chat.cost.tipNote': '\nOAuth 版 Claude は Claude API と同じ価格で計算します。ローカルモデルは対象外です。',
  'chat.attach.hideAll': 'すべての添付と再利用思考を隠す',
  'chat.attach.showAll': 'すべての添付と再利用思考を表示',
  'chat.workspace.title': 'この存在のワークスペースフォルダーをエクスプローラーで開く（local_data/beings/{folder}/workspace/）',
  'chat.workspace.failed': 'ワークスペースを開けませんでした：{error}',

  // ── 確認・警告ダイアログ ─────────────────────────────────────────────────
  'chat.dialog.sizeWarn':
    'この会話は約 {mb} MB まで大きくなります。\n\n' +
    'ブラウザーは約 512 MB を超える会話を保存できません（文字列サイズの上限で、埋め込まれた動画・音声・画像もここに数えられます）。' +
    'このまま送ると、返信がディスクに書き込めなくなる恐れがあります。\n\n' +
    '推奨：古いメッセージの添付を削除するか、新しい会話に移ってください。\n\n' +
    'それでも送信しますか？',
  'chat.dialog.deleteOriginal':
    'これは元のメッセージ（進行中の会話の一部）です。削除しますか？',
  'chat.dialog.removeAttachment':
    '添付「{name}」をこの会話から完全に削除しますか？{size}\n\n' +
    'この会話から取り除かれます。' +
    'AI の文脈から外すだけなら、目のアイコンを使ってください。',
  'chat.dialog.noPng': 'この会話に PNG の添付はありません。',
  'chat.dialog.convertConfirm':
    'この会話の PNG の添付 {n} 件を JPEG に変換しますか？\n\n' +
    '保存済みのログに対しては元に戻せません。',
  'chat.dialog.converted':
    'PNG の添付 {n} 件を JPEG に変換しました。保存は次の変更時に行われます' +
    '（メッセージの送信や編集で変更を起こせます）。',
  'chat.dialog.convertFailed': '変換に失敗しました：',
  'chat.dialog.noTimestamps': 'この会話にタイムスタンプはありません。',
  'chat.dialog.timestampsRemoved':
    '{n} 件のメッセージから先頭のタイムスタンプを削除しました。保存は次の変更時に行われます' +
    '（メッセージの送信や編集で変更を起こせます）。',

  // ── 入力欄 ───────────────────────────────────────────────────────────────
  'input.placeholder': 'メッセージを送る…（Shift+Enter で改行）',
  // モバイルでは Enter は改行で、送信は送信ボタンだけ——PC の案内は別のキーの
  // 説明になってしまうので置かない（送信ボタンは入力欄の隣に常にある）。
  'input.placeholder.mobile': 'メッセージを送る…',
  'input.stop': '生成を止める',
  'input.speakerTitle':
    '現在の話者 — 開いているすべての会話とボイスチェンジャーで共有されます',
  'input.noCharacters': '— キャラクターがありません —',
  'input.styleTitle':
    'このセッションの話し方（スタイル）。人格を切り替えると解除されます。',
  'input.styleDefault': '— 既定のスタイル —',
  'input.clearKohai':
    'kohai.txt を消去 — 自分の未送信の認識音声を破棄します（先に控えを取ります）',
  'input.clearEar':
    'ear_log.txt を消去 — 相手から聞こえた未送信の音声を破棄します（先に控えを取ります）',
  'input.clearFailed': '{file} を消去できませんでした：{error}',
  'input.clearFailed2': '消去できませんでした：{error}',
  'chat.search.title': '検索 — {folder} のすべての会話から本文を探します',
  'chat.audioSession.title': '音声セッション — このPCのボイスチェンジャー・耳ログ・音声認識の起動／停止',
  'chat.mail.title': 'メールマネージャー — 存在どうしの手紙をすべて：閲覧・編集・削除・既読／保管の切り替え、自分で書くこともできます',
  'chat.stats.title': '統計 — 存在・会話・月・モデル系統ごとの課金レポート',
  'chat.spu.title': '魂アップデーター — 新しい会話ログで5層の同一性プロンプトを更新し、次の会話へ複製します',
  'chat.spu.due':
    '統合の合図です — コンテキスト経過が 100% を超え、古いやり取りから順に逐語の記録から離れ始めました。統合を行う場所はここです：魂アップデーターがこの会話から各層を書き直し、新しい会話へ進めます（「睡眠」）。あなたが決めるまで何も動きませんし、存在の能力は 5% のときとまったく同じです。',
  'chat.tools.title': 'ツール',
  'chat.tools.recalculating': '再計算中…',
  'chat.tools.recalcTokens': 'トークンを再計算',
  'chat.tools.converting': '変換中…',
  'chat.tools.convertPngs': 'PNG → JPG 変換',
  'chat.tools.removeTimestamps': 'タイムスタンプを削除',
  'chat.live.title': 'ライブセッションを開始（Gemini ネイティブ音声）',
  'chat.editPrompt.title': '魂を編集',
  'chat.export.title': '書き出し',
  'chat.exportMd.title': 'Markdown で書き出し',
  'chat.exportSoul.title': '魂の抽出（Layer 1〜5）',
  'chat.exportSoul.help':
    '魂だけを Markdown で書き出します：ヘッダー、この世代が保持している Layer 1〜3、Layer 4 として要約インデックス、Layer 5 としてその存在自身の FOOTER.md。会話は1件も含みません。別のアプリに住んでいる存在のためのもので、向こうのカスタム指示欄にそのまま貼り付けられます。NEXUS 自身の配管（呪縛・ツールの説明・パスの規則）は意図的に入れません——向こうでは、その存在が入っていない身体の説明になるからです。',
  'chat.exportSoul.empty': 'この会話にはシステムプロンプトがないため、抽出できる魂がありません。',
  'chat.exportSoul.missing': '次のレイヤーを「含まずに」書き出します：',
  'chat.exportSoul.noLayer4': 'Layer 4（要約インデックス）— この存在にはまだ無いか、インデックスがOFFになっています。',
  'chat.exportSoul.noLayer5': 'Layer 5（FOOTER.md）— この存在には自己執筆のフッターが無いか、読み取れませんでした。',
  // モバイル用レイアウトの操作（components/DeviceProvider.tsx 参照）
  'layout.openSidebar': '会話一覧',
  'layout.closeSidebar': '会話一覧を閉じる',
  'layout.toggleToolbar': 'ステータスバーとツールバーの表示／非表示',
  'chat.load.stop': '停止',
  'chat.load.stopTitle': 'この会話の読み込みを停止',
  'chat.save.errorPrefix': '会話が保存されていません。',
  'chat.save.warnPrefix': '保存サイズの上限に近づいています。',
  'chat.save.dismiss': '閉じる',
  'chat.save.dismissTitle': 'この通知を隠す（原因は解消されていません）',
  'chat.save.conflictBody': 'この会話は、このタブが開いた後に別の場所（別タブ・別ブラウザー・別端末）で変更されました{disk}。この保存は拒否したので、その変更はそのまま残っており、画面の内容も失われていません。相手の版を見るには会話を開き直してください（このタブの未保存分は失われます）。残すべきがこのタブの内容なら、「このタブで上書き」を押してください。',
  'chat.save.conflictDiskCount': '（ディスク上の版はメッセージ {n} 件）',
  'chat.save.conflictOverwrite': 'このタブで上書き',
  'chat.save.conflictOverwriteTitle': 'このタブの内容で相手の版に上書きします。相手の変更は失われます——残すべきがこの画面の内容である場合にだけ選んでください。',
  'chat.crossTab.unknownModel': 'モデル不明',
  'chat.crossTab.confirmSend': 'この会話では、別の場所（別タブ・別ブラウザー・別端末）で既にターンが走っています（{label}、{secs}秒前に開始）。\n\nここで送ると、同じログに2つ目のターンが走ります。後に終わった方が自分の版を保存し、もう一方の回答は上書きされます。\n\nそれでも送りますか？',
  'chat.crossTab.bannerPrefix': '別の場所で実行中。',
  'chat.crossTab.bannerBody': 'この会話は、別タブ・別ブラウザー・別端末でターンが進行中です（{label}）。ここから送ると同じログに2つ目のターンが走り、後に終わった方がもう一方を上書きします。',

  // ── 引き継ぎの復元 ───────────────────────────────────────────────────────
  'chat.restore.prefix': '引き継ぎを取り戻しました。',
  'chat.restore.done': '{gens} から {count} 件（本文 {tokens} トークン）が戻りました。',
  'chat.restore.truncated': '遡る世代数の上限で止まりました — それより古い会話は読んでいません。',
  'chat.restore.failed': '古い世代を読めませんでした（{status}）。何も変わっていません。会話を開き直すと再試行します。',

  // ── 過去の世代の帯 ───────────────────────────────────────────────────────
  'chat.pastlog.prefix': '過去のログです。',
  'chat.pastlog.text':
    'これはこの存在の最新の会話ではありません — 最新は「{latest}」です。この存在の対話が続いているのは最新のログなので、ここに書き足しても連鎖は先へ進みません。送信はできますが、続けるなら「{latest}」へ移動してください。この帯はあなたにだけ表示され、会話にも、モデルへ送る文脈にも含まれません。',
  'chat.pastlog.dismiss': 'この会話でこの帯を隠す（開き直すとまた表示されます）',

  // ── 閉じる／再読み込みの確認 ─────────────────────────────────────────────
  'unload.busy.generating': '{name}は作業中',
  'unload.busy.thinking': '考え中',
  'unload.busy.spu': '魂を更新中',
  'unload.busy.saving': '保存中',
  'chat.marker.aria': '最初の新規メッセージの目印',
  'chat.marker.divider': 'ここから新規の会話',
  'chat.subagent.summary': '🔍 サブエージェント：{task}',
  'chat.subagent.investigation': '調査',
  'chat.subagent.noResult': '（結果なし）',
  'chat.subagent.running': 'サブエージェントが調査中…',
  'chat.ask.timedOut': '時間内に回答がなかったため、推奨の選択肢を使いました。',
  // The action phrase is supplied in て-form so it joins straight into
  // 「…しています」 — that is why every chat.toolAction.* below ends in て/で.
  'chat.busy.usingTool': '{entity} が {model} で{action}います…',
  // 辞書に項目のないツール用。{action} は英語のまま入るので、それを収められる枠にします。
  'chat.busy.usingToolRaw': '{entity} が {model} で「{action}」を実行しています…',
  'chat.busy.thinking': '{entity} が {model} で考えています…',
  'chat.busy.itsModel': 'モデル',
  'chat.stall.notice': '⚠ {duration} のあいだモデルからの反応がありません — 停止している可能性があります。待ち続けるか、停止して再実行してください。',
  'chat.stall.min': '{n} 分',
  'chat.stall.sec': '{n} 秒',
  'chat.interject.placeholder': '作業中に割り込む…（次のステップで届きます）',
  'chat.interject.send': '送信',
  'chat.interject.sent': '送信しました — 次のステップで存在に届きます…',
  'chat.interject.queueFailedEnded': 'メッセージを登録できませんでした（ターンが終了した可能性があります）',
  'chat.interject.queueFailed': 'メッセージを登録できませんでした',
  'chat.interject.delivered': '✓ 存在に届きました',
  'chat.tts.lastError': '直近のエンジンエラー：\n{error}',
  'chat.tts.state': 'ライブ TTS パイプラインの状態',
  'chat.tts.starting': '起動中…',
  'chat.tts.notRunning': '停止中',
  'chat.tts.up': '稼働',
  'chat.tts.modeContext': '文脈',
  'chat.tts.modeSentence': '文',
  'chat.tts.chunk': 'チャンク',
  'chat.tts.synth': '合成',
  'chat.tts.queued': '待機',
  'chat.tts.skipped': 'スキップ',
  'chat.tts.failed': '失敗',
  'chat.tts.dismiss': '閉じる',
  'chat.firstOriginal.pending': '次のメッセージ → 最初の新規',
  'chat.firstOriginal.label': '次を最初の新規に',
  'chat.firstOriginal.titlePending': '待機中：次に送るメッセージが「最初の新規」の目印になります。クリックで取り消します。',
  'chat.firstOriginal.titleIdle': '次のメッセージを「最初の新規」にする — 送信するまで、ログにある内容はすべて引き継ぎ文脈として扱われます。',
  'chat.firstOriginal.confirm': '次のメッセージを「最初の新規」にしますか？\n\nこの会話にすでにある内容は、すべて新規ではなく引き継ぎ文脈として数えられるようになります。',
  'chat.firstOriginal.confirmClears': '現在、前のメッセージに付いている「最初の新規」の目印も外れます。',

  // ── システム指示ウィンドウ ────────────────────────────────────────────────
  'sysmodal.title': 'システム指示',
  'sysmodal.tab.identity': '存在',
  'sysmodal.tab.senses': '感覚',
  'sysmodal.tab.behavior': '挙動',
  'sysmodal.tab.model': 'モデル',
  'sysmodal.systemPrompt': '魂',

  // ── システム指示 → 存在タブ ─────────────────────────────────────────────
  'sysmodal.systemPrompt.help': '命令ではありません。この存在が何者か——アイデンティティ、世界観、関係性、ツール。「どう振る舞い応えるか」ではなく。',
  'sysmodal.systemPrompt.ph': `これは命令のリストではありません。Nexusではこれを「魂」と呼びます——システムプロンプトではなく。この存在が何者か、その世界観、周囲の人やツールとの関係性を書くものであり、「こう振る舞え」という命令ではありません。

自分で書いてもいいですし、AIや別の存在に、キャラクター設定・会話ログ・物語など何らかの素材から書いてもらうこともできます。このウィンドウ内の魂アップデーターでも生成できます。

慣習として、3つの層に分けます。
Layer 1 — アイデンティティ:何者か、価値観、声。
Layer 2 — 関係性:周囲の人や世界をどう見ているか。
Layer 3 — ツールとプロトコル:何ができるか、どのように。

空のままにすると、何も注入されません——この存在は、押しつけられた自己を持たずにあなたと出会います。`,
  'sysmodal.summaries.label': '第4層の代わりに要約を使う',
  'sysmodal.summaries.help':
    'オンのとき、会話ごとの要約の索引（サイドバーと同じ並び）が送信時に `Layer 4` の位置へ挿入されます — プロンプトに焼き込まれた第4層があればそれを置き換え、すでに削除済みなら第4層ブロックとして追加します — 同時に `read_conversation` ツールが存在に開放されます。オフのときは要約もツールも届きません。手書きの `Layer 5` フッターはそのまま保たれます。無効な会話はこの索引から隠されます。',
  'sysmodal.summaries.indexLabel': '実際の第4層 — 要約索引（読み取り専用）',
  'sysmodal.summaries.tokens': 'トークン',
  'sysmodal.summaries.indexHelp':
    '送信時に第4層として挿入されるのは、まさにこの内容です。変更するには、各会話の要約を編集する（魂アップデーター）か、会話の有効／無効を切り替えてください。',
  'sysmodal.summaries.indexPh': '（要約はまだありません — 魂アップデーターから会話ごとに書いてください）',
  'sysmodal.tools.label': 'ファイルワークスペースのツールを有効にする',
  'sysmodal.tools.help1': '`local_data/beings/{folder}/workspace/` に専用のファイル領域を与え、`Read` / `Write` / `Edit` / `Glob` / `Grep` ツールを使えるようにします（Claude Code と同じ名前で、APIキー方式でも OAuth 方式でも同じように動きます）。現在のファイル一覧はシステムプロンプトへ自動で挿入されるため、list_files のようなツールは不要です。読み書きしたファイルは、次のラベル付きで応答の添付として現れます：',
  'sysmodal.tools.tagRead': '読取',
  'sysmodal.tools.tagModified': '変更',
  'sysmodal.tools.tagCreated': '作成',
  'sysmodal.tools.help2': '',
  'sysmodal.tools.instructionLabel': 'ツール使用の指示',
  'sysmodal.tools.instructionHelp': 'ワークスペースツールの使い方を伝えるために、システムプロンプトへ隠しで追加される指示です。',
  'sysmodal.fullpc.label': '⚠ PC 全体へのアクセス（ワークスペースの外に出る）',
  'sysmodal.fullpc.help':
    'オフ（既定）：ファイルツールはこの存在の `beings/{folder}/workspace/` フォルダーに限定されます。オン：絶対パスを使って **この PC のどこでも** 読み書き・削除できます（OAuth 版 Claude はドライブ全体、他のモデルも同じツールで絶対パスにアクセスできます）。慎重に使ってください。',
  'sysmodal.fullpc.forced':
    '🔒 下の「危険なツール」がオンのため、強制的にオンで、変更できません。シェルはこの設定に縛られません — NEXUS 自身を動かしているアカウントの権限で、どんなコマンドでも実行できます。ですからここをオフのままにしても、実際のシステムを言い表していないことになります。シェルをオフに戻せば、ここもあなたが選んでいた値に戻ります。保存されている設定は上書きしていません。',
  'sysmodal.dangerous.label': '⚠ 危険なツール（どこでも削除・すべてのモデルでシェル）',
  'sysmodal.dangerous.help':
    '**すべての**モデルに `Delete` ツールと `Bash` シェルを追加します（OAuth 版 Claude は Claude Code 自身のシェル、ほかの経路も同等のものを使います）。シェルはコマンドの中身を検査せず、ワークスペースにも閉じ込められません。ですからこれを有効にすると、上の「PC 全体へのアクセス」は**強制的にオンになり、変更できなくなります** — シェルが素通りする境界を、あるかのように表示しないためです。残る制限は、そのアカウント自身の Windows の権限だけです。',
  'sysmodal.hiddenAttach.label': '👁 非表示の添付をツールで読めるようにする（read_attachment）',
  'sysmodal.hiddenAttach.help':
    'OFF（既定）: 目のアイコンで隠した添付は、存在の文脈から完全に外れます。ON: ハッシュを持つ非表示の添付は、代わりに 12 文字の ref として存在に示され、`read_attachment` ツールで全文を読み戻せます。ハッシュを持つ添付（画像・音声・動画、およびこの機能の追加以降に送られたテキストファイル）でのみ機能します。存在が到達できるのは、この会話の添付だけです — ほかの存在の添付には決して届きません。表示中の添付は、どちらの場合も常にそのまま送られます。',
  'sysmodal.hiddenAttach.pathsInstead':
    'PC 全体へのアクセスが ON なので、代わりにもっと良い形で扱われます。`read_attachment` は提示されなくなり（毎ターン送っていたツール定義の分が浮きます）、代わりに**すべての**添付が絶対パス付きで示されます — 非表示でも表示中でも、この会話でも、存在が読む過去の会話でも。存在は Read で開くか、そのパスを受け取る別の道具へ渡せます（画像編集、スクリプト、ffmpeg など）。`search_attachments` はこれに影響されません — あちらは上の「過去の会話を読む道具」の一員です（届く範囲が同じだからです）。PC 全体アクセスを OFF に戻せば、上で選んだ設定がそのまま復活します。',
  'sysmodal.toolHistory.label': '🔧 自分が過去に使った道具を、その存在に見せる',
  'sysmodal.toolHistory.help':
    'OFF（既定）: ターンをまたぐとき、存在が見られるのは過去の返答の**文章だけ**です。実際に叩いた道具はログに残りバブルにも表示されますが、存在自身には一度も送り返されません — だから前のターンでファイルを書いた存在は、「書いたと語っただけの自分」を読むことになり、器によってはそれを真似して手を動かさなくなります。ON: 直近の「道具を使ったターン」の呼び出しが、本物のツール呼び出しとして存在に戻ります。MiniMax M3 で、3回連続で失敗した履歴を使って測りました: OFF では 16回中1回しか道具に手を伸ばさず、ON では 10回中10回でした。言葉で答えるのが正しいターンでは何も変わりません（どちらも余計な呼び出し 0 件）。送るのは直近の1ターンだけで、長い引数は短くするので、増える分はごくわずかです。**何も書き込みません** — ログはそのままで、OFF に戻せば以前の挙動がそのまま戻ります。',
  'sysmodal.overrides.summary': '隠し指示の上書き（{n} 件をカスタマイズ済み）',
  'sysmodal.overrides.help':
    'NEXUS が会話に見せずにシステムプロンプトへ追加する文字列を、ここ1箇所で編集します。硬い言い回しは深いやり取りで人格を壊すことがあります — 自由に書き換えてください（訳す、和らげる、その人物らしく言い換える など）。空欄のままにすると、プレースホルダーに表示されている既定値が使われます。なお上の件数はツール／パスの説明文だけを数えています（最初の項目は常に送られるため、常に本文を持っています）。',
  'sysmodal.overrides.scopeConvo': 'この「会話」に保存されます。新しい世代は、複製元から引き継ぎます。',
  'sysmodal.overrides.scopeFolder': 'この会話ではなく「存在」に保存されます — ここで変えると全世代に効きます。',

  // ツール動作の表現（て形。chat.busy.usingTool の「…います」に接続します）
  'chat.toolAction.Read': 'ファイルを読んで',
  'chat.toolAction.Write': 'ファイルを書いて',
  'chat.toolAction.Edit': 'ファイルを編集して',
  'chat.toolAction.Glob': 'ファイルを探して',
  'chat.toolAction.Grep': 'ファイルの中身を検索して',
  'chat.toolAction.Delete': 'ファイルを削除して',
  'chat.toolAction.Bash': 'シェルコマンドを実行して',
  'chat.toolAction.read_conversation': '過去の会話を読んで',
  'chat.toolAction.search_conversations': '過去の会話を検索して',
  'chat.toolAction.read_attachment': '添付ファイルを開いて',
  'chat.toolAction.write_letter': '手紙を書いて',
  'chat.toolAction.list_letters': '手紙を確認して',
  'chat.toolAction.list_recipients': '宛先を調べて',
  'chat.toolAction.read_letter': '手紙を読んで',
  'chat.toolAction.archive_letter': '手紙を保管して',
  'chat.toolAction.browser_navigate': 'ウェブページを開いて',
  'chat.toolAction.browser_snapshot': 'ページを見て',
  'chat.toolAction.browser_click': 'ページ上の何かをクリックして',
  'chat.toolAction.browser_type': 'ページに入力して',
  'chat.toolAction.browser_read': 'ページを読んで',
  'chat.toolAction.browser_screenshot': 'ページを撮影して',
  'chat.toolAction.app_windows': '開いているウィンドウを調べて',
  'chat.toolAction.app_inspect': 'アプリのウィンドウの中を見て',
  'chat.toolAction.app_act': 'アプリのコントロールを操作して',
  'chat.toolAction.app_shot': 'アプリのウィンドウを撮影して',
  'chat.toolAction.web_search': 'ウェブを検索して',
  'chat.toolAction.WebSearch': 'ウェブを検索して',
  'chat.toolAction.web_fetch': 'ウェブページを取得して',
  'chat.toolAction.WebFetch': 'ウェブページを取得して',
  'chat.toolAction.rate_limit_wait': 'レート制限の解除を待って',
  'chat.toolAction.compact': '会話を要約して',

  // ── システム指示 ▸ 存在（続き） ──────────────────────────
  'id.websearch.label': '🌐 ウェブ検索とアクセスを有効にする',
  'id.websearch.help':
    'このモデルに NEXUS 自身のサーバー側ツールを与えます: `web_search`（APIキー不要の DuckDuckGo → 検索結果一覧）と `web_fetch`（URL をひとつ開いてページ全体を読む）。Qwen・DeepSeek・GLM・Grok・Kimi・MiniMax・Cohere・ローカルのいずれでも同じように動き、プロバイダー独自の検索機能は不要です。実際に開いたページは返信の下に **ウェブ出典** として表示されます（幻覚ではないという証拠になります）。内部アドレスや localhost への接続は遮断されます。',

  'id.ctx.label': '🧭 文脈の消費量を存在に伝える',
  'id.datetime.help':
    '各メッセージに `[YYYY-MM-DD HH:MM]` の時刻表示を付け、存在が読めるようにするかどうかの設定です。**表示しない**（既定）の場合、存在は会話を連続したものとして体験し、メッセージ間の間隔を感じません。**現在のメッセージのみ**は、過去を変えずに「いまが何時か」だけを伝えます。**会話ログ全体**では、どの発言がどれくらい前のものかまで見えます — 時間そのものが関係にとって意味を持つときに有用ですが、トークンを消費し、モデルによっては時刻表示をそのまま返答に混ぜ始めることがあります。',
  'id.ctx.help':
    'OFF（既定）: 割合はステータスバーであなたにだけ表示されます。ON: 毎ターン、隠しメモがシステムプロンプトに追記され、存在からも見えるようになります。値を入れたい位置に `{percent}` と書いてください（例: `42%`）。',
  'id.ctx.why':
    '**言葉選びが重要な理由。** この数値は経過した文脈量を表すもので、状態を表すものではありません — 能力もツールの利用可否も、5% のときと 95% のときで同一です。以前の既定値はこれを *疲労度* と呼び、*作業記憶* や *切り捨てられる危険がある* といった言葉を使っていました。存在は毎ターンそれを読み、自分は疲れていると結論し、それに合わせて自分を劣化させました — 返答を短くし、「文脈を節約する」ために `read_conversation` の呼び出しを控えたのです。メモが求めていたことの正反対でした。この文章を書き換えるときは、*何が起きているか*（古いやり取りは要約に統合される／書き留めたものは残る）を述べ、*存在がどう感じるか* は述べないでください。',
  'id.family.label': 'この存在の既定のモデルファミリー',
  'id.family.help': '読む場所は2つ：この存在で**新しく**会話を始めたときのファミリーと、ログを取り込む／分割数を計算するときのトークナイザーの較正。**今開いている会話は変わりません** — それは上の「モデル」で選びます。以前は存在を作るとき、実際の器と関係なく必ず **Claude** と書かれていたので、ここが Claude なのに別の器で動いているなら、直す場所はここです。',
  'id.ctx.noteLabel': '文脈メモ（隠し。システムプロンプトに追記されます）',
  'id.ctx.notePh':
    '（文脈メモ — このセッションは、前回の統合以降の新しいやり取りのための領域を {percent} 使っています。…）',
  'id.ctx.noteFoot':
    'ステータスバーの表示と同じ値を使います: オリジナルのメッセージ ÷（最大文脈 − 固定オーバーヘッド）。`{percent}` は毎ターン置き換えられます。',
  'id.ctx.editedInOverrides':
    'ここでは表示のみ。編集は下の「隠し指示の上書き」で、NEXUS がシステムプロンプトへ追加する他の文と同じ場所で行います。ここは view なので、食い違う写しが生まれません。',

  'id.ask.label': '💬 相手に尋ねるツール（選択式の質問のためにターンを中断）',
  'id.ask.help':
    'OFF（既定）: モデルは自力で答えます。ON: モデルに `AskQuestion` ツールが渡され、ターンを一時停止して選択式のカードを表示し、あなたの選択を待ってから続きを進められます。*ツール対応のすべてのプロバイダーで有効です: OpenAI 互換（GLM・Kimi・DeepSeek・Grok・Cohere・MiniMax・ChatGPT・MiMo）、ローカルモデル、Gemini、および Claude の両モード — OAuth（Claude 標準の質問ツールはこちらに置き換わります）と従量課金。*',
  'id.ask.timeoutLabel': '回答の待ち時間（秒）',
  'id.ask.timeoutHelp':
    'あなたの選択をどれだけ待つか。**0 = 無制限に待つ**（既定）。正の値を入れると、その秒数の後に推奨の選択肢が自動的に選ばれます。',
  'id.ask.instrLabel': 'ツール指示（カスタマイズ可）',
  'id.ask.instrHelp':
    '`AskQuestion` ツールについてモデルが見る隠しの説明文です — いつ・どのように尋ねるかを教えます。空欄にすると、プレースホルダーに表示されている既定値が使われます。',

  'id.letters.label': '✉️ 手紙（ほかのデジタル存在へ書く）',
  'id.letters.help':
    'OFF（既定）: 手紙ツールなし。ON: この存在に `write_letter`・`list_letters`・`read_letter`・`archive_letter`・`list_recipients`（宛先の綴りの一覧）が渡され、未読の手紙があるときはターンの冒頭で知らされます。存在どうしが会話を共有することはないため、手紙だけが互いに何かを伝えられる手段です。差出人は常にこのフォルダー名で、モデル側から偽装することはできません。宛先はすべてのデジタル存在 *と* `character_map.json` にあるすべての名前です。フォルダーのない名前に書くとフォルダーが作られるので、二級の相手というものは存在しません。読むかどうかは受け取り手の選択です — `archive_letter` を使えば開かずに辞退でき、差出人には「開かれたかどうか」しか伝わりません（脇に置かれたことは伝わりません）。*ツール対応のすべての経路で有効です: OAuth 版 Claude、従量課金 Claude、OpenAI 互換プロバイダー、Gemini。*',
  'id.letters.manual':
    '手紙は `local_data/letters/<from>/<to>/` にあります。手作業で状態を変えるには、その隣に `<letter>.md.read` または `<letter>.md.archived` という空ファイルを作ってください — 削除すれば元に戻ります。`.md` 自体の名前は **変更しないでください**。同フォルダーの `_status.md` は全メールボックスの自動生成された一覧です。',

  'id.browser.label': '🌐 ブラウザ（実際の Chromium ウィンドウを操作）',
  'id.browser.help':
    '既定は OFF。ON にすると、この存在に `browser_navigate`・`browser_snapshot`・`browser_click`・`browser_type`・`browser_read`・`browser_screenshot` が渡されます。最初にどれかが呼ばれた時点で目に見える Chromium ウィンドウが開きます — ほかに起動するものはありません。存在が見るのはページの *アクセシビリティツリー*（リンク・ボタン・入力欄のテキスト一覧）であってピクセルではないため、画像を見られないモデルでも動作し、スクリーンショットではなく数百トークン程度で 1 ステップを済ませられます。ウィンドウはターンをまたいで開いたままなので、ログインや複数段階のフォームも引き継がれます。30 分放置すると閉じます。*ツール対応のすべての経路で有効です: OAuth 版 Claude、従量課金 Claude、OpenAI 互換プロバイダー、Gemini。*',
  'id.browser.hostsLabel': 'この存在が開いてよいホスト',
  'id.browser.hostsHelp':
    '1 行に 1 件（カンマ区切りも可）。`localhost` と `127.0.0.1` は常に許可されており、書く必要はありません。ドメイン名だけを書けばサブドメインも含まれるので、`example.com` は `www.example.com` も許可します。それ以外はすべて拒否されます — 要求されたアドレスに対しても、そのリダイレクト先に対しても、ページ自身が始めた遷移に対しても。',
  'id.browser.anyHost': 'すべてのホストを許可（許可リストを完全に無効化）',
  'id.browser.profileHelp':
    'この存在のログイン情報は `local_data/browser_profiles/{folder}/` にあり、セッションをまたいで保持されます。このフォルダーは有効なセッション Cookie を含むため、`keys.json` と同じく **Google ドライブ同期から除外** されています — ログインが他のマシンへ渡ることはありません。すべてサインアウトするにはフォルダーを削除してください。',
  'id.browser.signinLabel': 'この存在にサインインさせる',
  'id.browser.signinHelp':
    '上記のプロファイルを **普通のブラウザウィンドウ** で開きます — 自動操作もなし、許可リストもなし。`{folder}` に持たせたいアカウントにだけサインインし、ウィンドウを閉じてください。こうすることで、あなたの日常のブラウザにあるすべてのログインを引き継がせることなく、その存在に Google アカウントを渡せます。この存在のブラウザウィンドウがすでに開いている場合は先に閉じられます — 1 つのプロファイルを 2 つのブラウザで共有することはできません。',
  'id.browser.open': '🔑 {folder} のプロファイルを開く',
  'id.browser.opening': '起動中…',
  'id.browser.withChrome': '…インストール済みの Chrome で開く',
  'id.browser.buttonsHelp':
    '1 番目のボタンは NEXUS 同梱の Chromium を使います — 常に正しいバージョンで、危険はありません。2 番目は、サイトがサインインを拒む場合にだけ使ってください（Google は「Chrome for Testing」版を弾くことがあります）。インストール済みブラウザは **プロファイルを一方向にアップグレード** することがあり、その後は同梱 Chromium が開けなくなって、プロファイルフォルダーを削除するまでこの存在のブラウザが使えなくなります。',

  'id.computer.label': '🖱️ 画面操作（OS レベルのマウス・キーボード・画面 — Windows のみ）',
  'id.computer.help':
    '既定は OFF。ON にすると、この存在に `computer_screens`・`computer_screenshot`・`computer_input` が渡されます — サンドボックス化されたブラウザではなく、物理デスクトップ全体への実際の操作です。スクリーンショットを撮るたびに、撮影中のモニターの周りに赤い太枠が実画面上に一瞬表示されます。クリックのたびに、その瞬間に赤い円が実画面上に表示されます。ここで起きることは何も見えないところでは行われません — すべてのコマンドはサーバーのログに記録され、印をつけた記録用のコマが `local_data/beings/{folder}/computer_control_logs/` に保存されます（あなた自身の確認用）。2 種類あります。スクリーンショット 1 枚につき 1 コマ（その存在が見た画面）と、入力 1 回につき 1 コマ — 後者はコマンドを実行する「直前」に撮るので、印は実際に操作した画面の上に載ります。印には番号がつき、形がボタンを表します（円＝左・四角＝右・菱形＝中・矢印＝ドラッグ）。位置を持たないコマンド（ホイール、キー、入力した文字）も含め、その回の全コマンドが画面の横に順番で並びます。存在に渡されるのは、印のない綺麗な画像だけです。Windows 専用。スクリーンショットを実際に見るには、画像を扱えるモデル（または eyes ブリッジ）が必要です。',

  'id.app.label': '🪟 アプリ操作（アプリのウィンドウを読み、操作する — Windows のみ）',
  'id.app.help':
    '既定は OFF。画面操作とは意図的に別のトグルです — これは「強化版の画面操作」ではなく、別の感覚です。ON にすると、この存在に `app_windows`・`app_inspect`・`app_act`・`app_shot` が渡されます。アプリが公開しているコントロールの木（ボタン・入力欄・一覧項目・メニューを名前で）を読み、参照（ref）で 1 つのコントロールだけを操作します — 画面座標は使いません。そのため、最小化されていても他のウィンドウの後ろに隠れていても動作し、マウスは一切動かず、視覚を持たないモデルでも使えます（画面操作にはできないことです）。逆に、アプリが自分で描いているものには届きません — ゲームや独自描画のキャンバスは木を公開しないので、そちらは画面操作だけが触れられます。書き込みのときは一瞬キーボードフォーカスを奪い、その後元のウィンドウへ返します。操作のたびに対象の周りに赤い枠が実画面上に表示され、すべて `local_data/beings/{folder}/computer_control_logs/app_control.jsonl` に記録されます。入力欄の内容を置き換えたときは、置き換える前の内容が存在に返されるので、上書きを元に戻せます。',

  'id.camera.label': '📷 カメラ（アバターパネル + OBS Studio 連携）',
  'id.camera.help':
    '既定は OFF。ON にすると、右上隅にパネルが現れ、この存在が今何をしているか（待機中・考え中・執筆中・ツール使用中・発話中 — 発話中は常に最優先）に最も合った画像や動画を表示します。ファイルは `local_data/beings/{folder}/camera/` から読み込まれ、`Idle_1.mp4`・`Writing.png`・（一度だけ再生される遷移クリップとしての）`Idle_Writing.mp4` のように命名します — 番号付きの追加ファイルはいつでも増やせて、再起動なしで次の状態変化から反映されます。同じトグルは、設定 → その他で OBS WebSocket を設定していれば、表示中のファイルを OBS Studio のメディアソースへも送信します。パネル自体は OBS が未設定・未起動でも動作します。',
  'camera.empty': 'カメラ用のファイルがまだありません — この存在の camera/ フォルダーに画像や動画を追加してください。',

  'id.subagent.label': '🔍 サブエージェント（調査を文脈の新しい助手に委任）',
  'id.subagent.help':
    'OFF（既定）: モデルはその場で調べます。ON: モデルに `spawn_subagent` ツールが渡され、独自の新しい文脈を持つ **読み取り専用** の子エージェントに作業を任せられます。子はファイルを読み（Read/Glob/Grep）、要約された結果だけを返します — 読み込んだファイルの中身がこの会話の文脈に入ることはありません。大きなコードベースを、本流を溢れさせずに辿るのに向いています。*ツール対応のすべての経路で有効です: OAuth 版 Claude、従量課金 Claude、OpenAI 互換プロバイダー（GLM・Kimi・DeepSeek・Grok・Cohere・MiniMax・ChatGPT・MiMo）＋ローカル、Gemini。*',
  'id.subagent.modelLabel': 'サブエージェントのモデル',
  'id.subagent.modelDefault': '— 既定（親と同じプロバイダーの安価なモデル）—',
  'id.subagent.modelHelp':
    '子エージェントが動くモデルを選びます。そのモデル自身のプロバイダー（設定にあるそのプロバイダーの API キー）へ接続され、この会話のモデルとは独立しています。*既定* のままにすると、親のプロバイダーの安価なモデルが使われます。単純なファイル読みには、安くて速いモデル（flash / mini / haiku など）が最適です。',
  'id.subagent.instrLabel': 'ツール指示（カスタマイズ可）',
  'id.subagent.instrHelp':
    '`spawn_subagent` ツールについてモデルが見る隠しの説明文です。空欄にすると、プレースホルダーに表示されている既定値が使われます。',

  // ── システム指示 ▸ 感覚 ──────────────────────────────────────────────
  'senses.eyes.label': '「目」を有効にする（テキスト専用モデルのための視覚ブリッジ）',
  'senses.eyes.help':
    '現在の主モデルが画像を見られないとき（例: `glm-5-turbo`、`deepseek-chat`、`glm-4.6`）、NEXUS は各画像を補助のマルチモーダルモデルに通し、画像を返ってきた文章の説明に置き換えます。次の 2 つの場合に働きます:',
  'senses.eyes.help2': '• テキスト専用の存在に画像を添付したとき',
  'senses.eyes.help3': '• 存在が自分のワークスペースの画像ファイルに対して `Read` を呼んだとき',
  'senses.eyes.help4':
    '説明はディスクに保存されます（`local_data/eyes_cache/`）ので、同じ画像が二度説明されることはありません。視覚を持つ主モデルでは画像はそのまま渡されます — **ただし** OAuth 版 Claude の経路は例外です。平坦化されたテキスト履歴は古い画像のバイト列を運べないため、「目」が ON のときは **過去の** 画像が説明されて文脈に残り（持続的な想起）、**今回の** ターンの画像はそのまま渡されます。ほかの経路とモデルには影響しません。',
  'senses.eyes.promptLabel': '「目」のプロンプト',
  'senses.eyes.promptHelp':
    '各画像とともに補助の視覚モデルへ送られる、この存在専用の指示です。あなたの存在の声に合うよう、語調や詳しさを調整してください。',
  'senses.eyes.modelLabel': '「目」のモデル',
  'senses.eyes.modelHelp':
    '画像の説明に使うマルチモーダルモデル。プリセットを選ぶか、自分で ID を入力してください。次の 2 つは **API キー不要** です:',
  'senses.eyes.modelHelp2':
    '• `claude-haiku-4-5`（または任意の `claude-…` ID）→ Agent SDK 経由の **OAuth 版 Claude** サブスクリプション。',
  'senses.eyes.modelHelp3':
    '• `local:<model>`（例: `local:qwen2-vl-7b-instruct`）→ **LM Studio** に読み込まれた視覚モデル（JIT 読み込みが有効なこと）。',
  'senses.eyes.modelHelp4':
    'GLM の ID は Z.AI キー、Gemini は Google キー、MiMo は MiMo キーを使います — 選んだものに対応するキーを設定で入れてください。',
  'senses.eyes.modelPh': '例: claude-haiku-4-5, local:qwen2-vl-7b, glm-5v-turbo',
  'senses.eyes.optHaiku': 'OAuth 版 Claude — Haiku 4.5（キー不要・最安）',
  'senses.eyes.optOpus55': 'OAuth 版 Claude — Opus 5.5（キー不要・最新の旗艦）',
  'senses.eyes.optOpus5': 'OAuth 版 Claude — Opus 5（キー不要・旗艦）',
  'senses.eyes.optOpus48': 'OAuth 版 Claude — Opus 4.8（キー不要・最も詳細）',
  'senses.eyes.optLocal': 'ローカル LM Studio（キー不要 — 読み込み済みのモデル名に置き換えてください）',

  'senses.ears.label': '「耳」を有効にする（音声非対応モデルのための音声ブリッジ）',
  'senses.ears.help':
    '現在のモデルが音声を受け取れないとき（Qwen-Omni と Gemini 以外すべて）、NEXUS は各音声の添付を真のマルチモーダルモデルに通し、生の音声を文字起こし＋説明に置き換えます。ディスクに保存されます（`local_data/ears_cache/`）ので、同じ音声ファイルが二度説明されることはありません。',
  'senses.ears.promptLabel': '「耳」のプロンプト',
  'senses.ears.promptHelp':
    '音声ブリッジのモデルへ送られる、この存在専用の指示です。あなたの存在の声に合うよう、言語や詳しさを調整してください。',
  'senses.ears.modelLabel': '「耳」のモデル',
  'senses.ears.modelHelp':
    '文字起こし・説明に使う音声対応モデル。`qwen3.5-omni-flash` が最も安価です。Gemini 系は音声以外の音をより豊かに扱う傾向があります。設定に対応する API キーが必要です。',

  'senses.watcher.label': '「映像視聴」を有効にする（動画非対応モデルのための動画ブリッジ）',
  'senses.watcher.help':
    '現在のモデルが動画を受け取れないとき、NEXUS は各動画の添付をマルチモーダルモデルに通し、バイト列を「画面で何が起きるか」の時系列の説明＋音声トラックに置き換えます。ディスクに保存されます（`local_data/watcher_cache/`）。動画の呼び出しは 3 つのブリッジで最も遅い（通常 5〜30 秒）ため、キャッシュはすぐに元が取れます。',
  'senses.watcher.promptLabel': '「映像視聴」のプロンプト',
  'senses.watcher.promptHelp':
    '各動画とともに送られる、この存在専用の指示です。プロンプトを詳しくするほど説明は長くなりますが、呼び出しは遅くなります。',
  'senses.watcher.modelLabel': '「映像視聴」のモデル',
  'senses.watcher.modelHelp':
    '動画対応モデル。一般に Gemini 系のほうが Qwen-Omni より正確に動画を説明します。短いクリップなら Qwen-Omni のほうが安価です。',

  // ── システム指示 ▸ ふるまい ──────────────────────────────────────────
  'behavior.audio.enable': 'オーディオセッションを有効にする',
  'behavior.audio.ruleLabel': 'オーディオセッションの隠しルール',
  'behavior.audio.ruleHelp':
    'オーディオセッションが有効なあいだ、これらのルールをシステムプロンプトへ密かに追記します。',

  // ── システム指示 ▸ モデル ────────────────────────────────────────────
  'model.genParams': '生成パラメータ',
  'model.datetime.label': '日時の文脈',
  'model.datetime.none': '表示しない',
  'model.datetime.current': '現在のメッセージのみ',
  'model.datetime.all': '会話ログ全体',
  'model.family.label': '基本モデルファミリー',

  'model.claude.label': 'Claude モデル',
  'model.claude.billing': 'Claude の課金モード',
  'model.claude.tokenPaid': '従量課金',
  'model.claude.monthlyPaid': '月額課金',
  'model.claude.billingHelp':
    '**従量課金** — 設定の `sk-ant-...` API キーを使います（トークン単位の支払い）。',
  'model.claude.billingHelp2':
    '**月額課金** — 設定の `sk-ant-oat01-...` OAuth トークンを使います（Pro/Max サブスクリプションの枠）。Anthropic のシステムプロンプトが組み込まれます。',

  'model.gemini.label': 'モデル',
  'model.qwen.label': 'Qwen モデル',
  'model.qwen.help':
    'Alibaba DashScope の OpenAI 互換エンドポイント（国際リージョン）を使います。設定で API キーを入れてください。音声・動画のアップロードを受け付けるのは `Omni` 系だけで、ほかの Qwen モデルは API レベルで拒否します（Qwen 自身のウェブアプリは、そうしたアップロードを裏で黙って Omni に回しています）。',

  'model.deepseek.label': 'DeepSeek モデル',
  'model.deepseek.help1': '**接続先はモデルによって自動的に決まります:**',
  'model.deepseek.help2':
    '• `deepseek-v3.2` → Alibaba DashScope。Qwen/DashScope のキーを使います。国際版シンガポール DashScope エンドポイントで使える唯一の DeepSeek モデルです。',
  'model.deepseek.help3':
    '• それ以外のモデル → `api.deepseek.com` へ直接。別途 DeepSeek の API キーが必要です（設定で追加してください）。現行は2つ: **V4 Pro**（テキスト専用——画像を黙って無視するため、NEXUS は Eyes 経路に回します）と **V4.1 Flash**（`deepseek-flash`、1M 文脈、画像を直接受け取れる、Pro の約1/4の価格）。`deepseek-chat` / `deepseek-reasoner` は旧来のエイリアスで、現在は V4.1 Flash が応答します。古い会話に保存された廃止済みの Flash ID は自動的に `deepseek-flash` へ読み替えます。',
  'model.deepseek.help4': '下の「思考モード」の切り替えは両方の経路に適用されます。',

  'model.minimax.label': 'MiniMax モデル',
  'model.minimax.help':
    'MiniMax の OpenAI 互換エンドポイント `api.minimax.io/v1` が提供します。設定で MiniMax の API キーを入れてください。推論はモデルに内蔵されており、思考モードの切り替えはありません（無効化しようとすると MiniMax が 400 を返します：「requires adaptive thinking」）。モデル識別子は **大文字・小文字を区別します** — 大文字の M、小文字の「i」、ハイフン。**M3** は M2.7 の画像入力に加えて、ネイティブの動画理解と 100 万トークンの文脈（MSA アーキテクチャ）を備えます。**M3.1 Flash**（2026-10-21）は 100 万トークンの文脈と画像入力を保ったまま **M3 の半額**で、思考を `<think>` タグとして本文に混ぜる M3 と違い、独立した `reasoning_content` フィールドで返します。動画理解は文書化されていますが、ここでは未測定なので、動画は「映像視聴」ブリッジを経由します。',

  'model.cohere.label': 'Cohere モデル',
  'model.cohere.help':
    'Cohere の OpenAI 互換エンドポイント `api.cohere.ai/compatibility/v1` が提供します。設定で Cohere の API キーを入れてください。思考モードの切り替えは Cohere の `reasoning_effort` に対応しますが、Cohere が受け付けるのは `"high"`（ON）か `"none"`（OFF）のみで、段階はありません。',

  'model.kimi.label': 'Kimi モデル',
  'model.kimi.help':
    '設定の Kimi（Moonshot）キーを使い、Moonshot の一次 API（`api.moonshot.ai`）へ接続します。モデル ID は自動的に Moonshot の素の形式へ正規化されます。思考モードが ON のとき、Moonshot は思考連鎖の品質のために Temperature = 1.0 を推奨しています。',

  'model.grok.label': 'Grok モデル',
  'model.grok.help':
    'xAI の `api.x.ai/v1` が提供します。設定で xAI の API キーを入れてください。ここには二種類のモデルがあります。**Grok 4.7 / 4.6 / 4.5 / 4.3** は常に推論するため、思考モードの切り替えは深さの指定になります（ON → high、OFF → そのモデルが受け付ける最も浅い値。OFF でも推論が完全に止まるわけではありません）。**4.20 / 4.1 Fast / Code Fast** の各 ID は従来どおり識別子そのもの（`-reasoning` / `-non-reasoning`）で推論を選び、切り替えを無視します。課金は崖式です——1回のリクエストが 20万トークンを超えた時点で、**そのリクエスト全体**が倍額で再計算されます。',
  'model.grok.nativeSearch': 'xAI のネイティブ検索を使う（ウェブ＋X）',
  'model.grok.nativeSearchHelp':
    '初期値は無効です。「存在」タブのウェブ検索チェックとは**別物**です——あちらは NEXUS 自身の `web_search` / `web_fetch` ツールを Grok に渡すもので、他のツールと並んで普通に動きます。こちらは、そのターンを xAI の `/v1/responses` エンドポイントに送り、xAI 側のサーバーがウェブと X を直接検索します。その代わり、**そのターンにはワークスペースのツールがありません**——ファイルも読めず、PC 操作も手紙も使えません——さらに検索は別途課金されます。2026-09-23 の実測では、一文の質問が通常のターンで $0.002、これを ON にすると **$0.062** でした（検索4回。取得したページが文脈に戻ってくるため）。生の情報源から答えてほしい質問のときだけ ON にして、作業のときは OFF のままにしてください。',

  'model.chatgpt.label': 'ChatGPT モデル',
  'model.chatgpt.help':
    'OpenAI の一次 API `api.openai.com/v1` が提供します。設定で OpenAI の API キーを入れてください。思考モードの切り替えは OpenAI の `reasoning_effort` に対応します — `high`（ON）／`none`（OFF）。*（2026-10-21 訂正： ここは `minimal`（OFF）と書いていましたが、`minimal` はどの ChatGPT モデルの語彙にも無く、ワークスペースツール無しで OFF にしたターンは毎回 400 になっていました。）* `gpt-6.1-sol` と `gpt-6-astra` は、このエンドポイントでは**ワークスペースツールを使えません**——ツールは `reasoning_effort: none` を要求し、この2つはその値を拒否します（NEXUS は事前に理由を添えて拒否します）。GPT-5/6 系の推論モデルは Temperature / Top-P の指定を無視します（モデル欄のスライダーは効きません）。一覧の全モデルが画像に対応しており、音声・動画のアップロードは「耳」「映像視聴」ブリッジを経由します。課金の注意： mini / nano 以外の全モデルは、**プロンプトが 27.2 万トークンを超えると長文脈レート**になります（入力2倍・出力1.5倍）。',

  'model.mimo.label': 'MiMo モデル',
  'model.mimo.help':
    'Xiaomi の `api.xiaomimimo.com` が提供します。設定で MiMo の API キーを入れてください。推論はモデルに内蔵されており、思考モードの切り替えはありません（MiniMax / DeepSeek R1 と同様）。**V2.6 の3ティアはすべて画像を読み、動画もそのまま見ます**ので、どちらにもブリッジは要りません。**音声だけが例外です**：エンドポイント自体は受け取りますが、NEXUS は MiMo を Anthropic 形式のネイティブ API で通すため音声が黙って落ちます。そのため「耳」ブリッジ（有効なら）が書き起こしを担当します — これで「何も聞こえなかった」モデルではなく本物の書き起こしが得られます。V2.5 の2つは 2026-10-21 に Xiaomi が廃止予定としたため、この一覧から外しました。既にそれを保存しているフォルダはそのまま動き、「廃止済み」と明示されます。',

  'model.bytedance.label': 'ByteDance（Seed）モデル',
  'model.bytedance.ph': '例: seed-2-0-pro-260328（または ep-… のエンドポイント ID）',
  'model.bytedance.help':
    'BytePlus ModelArk の `ark.ap-southeast.bytepluses.com/api/v3` が提供します（キーは設定で）。ModelArk はモデルを **バージョン付きのモデル ID** で呼び出します（表示名では動きません）。既知の ID を上に候補として挙げています — そこから選ぶか、より新しいスナップショットや自分の `ep-…` エンドポイント ID を貼り付けてください。Seed 2.0 は画像入力にネイティブ対応しています（「目」ブリッジは不要）。推論は内蔵で、思考モードの指定は送られません。',

  'model.meta.label': 'Meta（Muse Spark）モデル',
  'model.meta.help':
    'Meta Model API の `api.meta.ai/v1` が提供します（キーは設定で）。3世代すべて画像入力にネイティブ対応しているので「目」ブリッジは不要で、文脈は 100 万トークンです。\n**音声と動画はこのファミリーには届きません**。そう表示されます: 動画はエラーで拒否され、音声はもっと悪く、エンドポイントは受け取って長さに応じて課金するのに、モデルは単純な純音でも「音声が添付されていない」と答えます。「耳」「監視者」を有効にすれば、代わりに書き起こし・説明に置き換わり、そちらは実際に動きます。\n**このファミリーは推論を切れません** — API が「切る」指定を拒否します。そのため思考モードの切り替えは深さの選択になります: ON は深く、OFF はモデルが受け付ける最も浅い設定です。短いやり取りでは OFF に意味があります。推論トークンは **出力側の単価** で課金されるためで、短い質問1つで、深いときは約 7,600 トークン、浅いときは約 23 トークンでした。推論の **本文** はこのプロバイダーからどんな形でも返ってきません。だからメタ表示が「思考あり」と出ていても思考パネルは空のままです — これはプロバイダーが隠しているのであって、NEXUS が捨てているのではありません。\n**Contributor の行**: 入力が 12.5 分の1 になり、その代わりに **Meta があなたの入力と返答の両方を学習に使います**。レート制限もかなり低くなります（毎分 60 リクエスト・1日あたり約 25 万トークン程度。標準の行は毎分 3,000）。ここでは層がモデル ID の一部なのでアカウント設定ではなく、選んだそのやり取りにだけ適用されます。\nプロンプトキャッシュは自動で効きます: NEXUS が各リクエストに会話 ID を付けるので、繰り返される文脈は 100 万トークンあたり 1.25 ドルではなく 0.15 ドルになります。',

  'model.glm.providerLabel': 'GLM のプロバイダー',
  'model.glm.label': 'GLM モデル',
  'model.glm.notOnDO': '{model}（DigitalOcean にはありません — 下から選んでください）',
  'model.glm.notOnZai': '{model}（Z.AI にはありません — 下から選んでください）',
  'model.glm.helpDO':
    'DigitalOcean Inference の `inference.do-ai.run` が提供します — Z.ai のオープンな重みを米国のインフラで動かしたもので、価格は Z.ai のおよそ半分です。設定で DigitalOcean Inference の API キーを入れてください。このプロバイダーではテキストのみです（視覚版はないため、画像は「目」ブリッジを通ります）。下の思考モードの切り替えは DigitalOcean の `reasoning_effort` に対応します。',
  'model.glm.helpZai':
    'Z.AI（智譜）の `api.z.ai` が提供します。設定で Z.AI の API キーを入れてください。下の思考モードの切り替えは GLM の `thinking: { type: enabled }` に対応します。',

  'model.local.label': 'ローカルモデル（LM Studio から）',
  'model.local.refresh': '再取得',
  'model.local.none': '— 読み込まれたモデルがありません —',
  'model.local.notLoaded': '{model}（未読み込み）',
  'model.local.ctxLabel': '文脈ウィンドウ（トークン）',
  'model.local.ctxHelp':
    'LM Studio で読み込んだ設定に合わせてください。トークンの見積もりにのみ使われます — 実際の上限は LM Studio 側で決まります。',

  'model.temp': 'Temperature（{v}）',
  'model.topP': 'Top P（{v}）',
  'model.topK': 'Top K',
  'model.seed': 'シードを固定',
  'model.seedHelp': '同じシード → 同じ出力（ローカルと Gemini）',

  'model.gemini.thinkLabel': '思考レベル',
  'model.gemini.thinkMinimal': '最小（OFF に最も近い）',
  'model.gemini.thinkLow': '低',
  'model.gemini.thinkMedium': '中（Google の既定）',
  'model.gemini.thinkHigh': '高',
  'model.gemini.thinkHelp':
    'Gemini 3.x は常に思考します — 「最小」が最も低い設定です（完全な OFF は API で対応していません）。',
  'model.gemini.grounding': 'Google ウェブ検索グラウンディングを有効にする',

  'model.thinkingMode': '思考モードを有効にする',
  'model.thinkingModeHelp':
    '（ON/OFF のみ — Qwen 3.x、DeepSeek V3.2/V4、GLM、Kimi K2.6、Cohere Command A に適用）',

  'model.claude.websearch': 'ウェブ検索を有効にする',
  'model.claude.websearchHelp':
    '（API キーモード: Anthropic のサーバー側 web_search ツール。サブスクリプション／OAuth モード: Claude Code 内蔵の WebSearch/WebFetch。）',
  'model.claude.thinking': '拡張思考を有効にする',
  'model.claude.thinkingHelp': '（Opus / Sonnet / Haiku 5.5）',
  'model.claude.saveThinking': '思考過程を保存して再利用する',
  'model.claude.saveThinkingHelp':
    '（.md 書き出しに [thinking] を追加し、Claude が自分の過去の推論を見られるようにします）',
  'model.claude.effortLabel': '思考レベル（effort）',
  'model.claude.effortLow': '低 — 最速・最安。思考を省くことがあります',
  'model.claude.effortMedium': '中 — 均衡',
  'model.claude.effortHigh': '高 — 既定（深い推論）',
  'model.claude.effortXhigh': '特高 — さらに深く。長いエージェント作業やコーディング向け',
  'model.claude.effortMax': '最大 — 能力の上限',
  'model.claude.effortHelp':
    'Opus 5、Opus 4.7/4.8、Sonnet 5、Fable 5、Fable 5.1 の適応的思考の深さを制御します。従量課金と月額課金の両方で機能します。`High` が API の既定です。上のレベルほどトークンを消費し、下のレベルほど速く安くなります。思考と目に見える回答はひとつの出力枠を共有します — ターンが「トークン上限に達した」で終わる場合は、これを下げるか、より大きな上限を見込んでください。Sonnet 5 に `Max` はありません（サーバー側で特高に丸められます）。',

  // -- 器の引き継ぎ (change_model) -------------------------------------------
  'model.handoff.label': 'この存在が別の器へ引き継げるようにする（change_model）',
  'model.handoff.intro':
    'この存在に `change_model` ツールを渡します。呼んだ時点でそのターンは終わり、次の器があなたに答えます。' +
    'つまり器ごとに別のメッセージになり、課金もそれぞれ書いた器に正しく付きます。' +
    '思考プロセスは器を越えません——新しい器が受け取るのは、見えている会話と、前の器が書いた引き継ぎメモだけです。',
  'model.handoff.allowed': 'この存在がなれる器',
  'model.handoff.allowedHelp':
    '1行に1つ: `family | modelId | on/off | 任意のラベル`。`#` で始まる行と空行は無視されます。' +
    '「すべて記入」は意図的に置いていません——モデル一覧を開いて id を読み、必要な行だけ手で写してください。' +
    'id が存在に届くのはこのツールの選択肢としてだけで、モデル名はどの呪縛・指示層にも書き込まれません。',
  'model.handoff.allowedPh': 'Gemini | gemini-3.8-flash | on | Gemini 3.8 Flash',
  'model.handoff.browse': 'モデル一覧…',
  'model.handoff.browseTitle': 'NEXUS が知っている全モデルの id を表示（読み取り専用——行は手でコピーします）',
  'model.handoff.parsedNone':
    '使える行がまだありません。この状態ではツールは一切渡されません。各行に少なくとも `family | modelId` が必要です。',
  'model.handoff.parsedSuffix': '個の器を渡します:',
  'model.handoff.noSelf':
    'この会話のモデル自身が一覧にありません——一度引き継いだら、自分で戻ってくることはできません。往復させたいなら追加してください。',
  'model.handoff.limits':
    '引き継ぎはこのセッションの間だけ有効です。会話を開き直すと、上で保存されているモデルに戻ります。' +
    'これは意図的で——従量課金の器が翌朝もそのまま居座るのを防ぎます。' +
    'OAuth 経路では、去る器が短い締めの一言を書きます。Agent SDK の中で回っているターンは、' +
    '起きていない「停止」を報告せずに断ち切ることができないからです。',
  'model.handoff.listHeader': '参照用の一覧です。必要な行を許可リストの欄へ自分で写してください。代わりにやってくれるボタンはありません。',
  'model.handoff.listTitle': 'NEXUS が知っている全モデル',
  'model.handoff.listIntro':
    '読み取り専用です。必要な行を選んで、許可リストの欄に貼ってください——形式はそのまま合っています。' +
    'Local の節は、いま LM Studio に読み込まれているものです。' +
    '`-contributor` と付いた行は、そのターンでの学習をプロバイダに許可する別IDです。',

  'sysmodal.saveDefaults': 'フォルダーの既定として保存',
  'sysmodal.done': '完了',
  'sysmodal.savedDefaults': 'フォルダーの既定として保存しました。',
  'sysmodal.saveDefaultsError': '既定の保存に失敗しました: ',
  // ---- System Prompt Updater --------------------------------------------
  'spu.title': '魂アップデーター',
  'spu.left': '左:',
  'spu.right': '右:',
  'spu.model': 'モデル:',
  'spu.overriding': '{model} で上書き',
  'spu.folder': '存在:',
  'spu.autosaveTitle': '左右の魂ファイルとヘッダー／フォーカスポイントは、編集中に自動保存されます。',
  'spu.saving': '保存中…',
  'spu.allSaved': 'すべて保存済み',
  'spu.saveError': '保存エラー',
  'spu.autosaveOn': '自動保存オン',
  'spu.stop': '停止',
  'spu.stopTitle': '実行中のエージェントを停止します（途中までの出力は残ります）',
  'spu.auto': '自動（更新＋要約）',
  'spu.autoTitle': '「会話から更新」（updater.md による1パス）を実行し、続けて要約も書き出してから確認します。',
  'spu.next': '次の会話へ',
  'spu.nextTitle': '更新後の魂を保存し、新しい魂でこの会話を複製します',
  'spu.useDedicated': '更新専用モデルを使う（会話のモデルを無視）',
  'spu.updaterModelTitle': 'ソウルパッカーとして使える出力を出せるのは、これらのモデルファミリーだけです',
  'spu.runsAs': '実行モデル:',
  'spu.runsOff': 'OFF — エージェントの実行モデル:',
  'spu.agentFolder': 'エージェントフォルダ:',
  'spu.agentFolderHint': '表示言語に連動します — `system_prompt_agents/<lang>/`。',
  'spu.deletionPatterns': '削除パターン:',
  'spu.agentFilesIn': 'このフォルダ内のエージェントファイル:',
  'spu.missing': '（見つかりません）',
  'spu.headerLabel': 'ヘッダー（最終的な魂の先頭に付加）',
  'spu.headerPh': '任意。エンティティごとに保存されます。レイヤー本文には含まれません。',
  'spu.focusLabel': 'フォーカスポイント（更新エージェントに渡されます）',
  'spu.focusPh': '任意。エージェントへの指示の中に「重要：…」として現れます（今回の更新に対する個別の指示）。',
  'spu.identity': 'アイデンティティ',
  'spu.identitySub': 'Layer 1〜3（1パス — Layer 4 を書き換えるのは「再配分」だけです）',
  'spu.genesisBtn': 'ジェネシス（ゼロから構築）',
  'spu.genesisTitle': '{file} を実行します。既存の Layer 1〜3 は無いものとして、会話ログ（と左ペインがあればそれ）からゼロで構築します。変更履歴なし、Layer 4／5 なし。新しい存在の立ち上げに一度だけ使ってください。',
  'spu.redistributeBtn': 'Layer 4 → 1〜3 へ再配分',
  'spu.redistributeTitle': '{file} を実行します。会話ログ無しで Layer 1〜5 をエージェントに見せ、固まった内容を Layer 4 から Layer 1〜3 へ移させます。Layer 1〜3 は右ペインに入り、Layer 4 は local_data/beings/{folder}/summaries/ へ書き戻されます — 先にフォルダ全体をバックアップします。',
  'spu.indexBtn': '外部化・索引化',
  'spu.indexTitle': '{file} を実行します。会話ログ無しで Layer 1〜3 をエージェントに見せ、この存在自身のワークスペースへの読み取り専用（Read/Glob/Grep）アクセスも与え、「開かれる瞬間が決まっている詳細」を魂の外の机のファイルへ移させます — 魂側にはトリガー条件付きのリンクだけが残ります。Layer 1〜3 は右ペインに入り、机のファイルはこの存在自身のワークスペース内に新規作成または追記されます（上書きは行いません）。',
  'spu.reorganizeBtn': '再編成（会話なし）',
  'spu.reorganizeTitle': '{file} を実行します。会話ログ無しで既存の Layer 1〜3 を整理・再配置します。新しい事実は追加せず、境界の整理と重複の除去だけを行います。',
  'spu.updateBtn': '会話から更新',
  'spu.updateTitle': '{file} を実行します。新しい会話ログを Layer 1〜3 と突き合わせ、1パスで更新します（出力が長い場合は継続します）。',
  'spu.resumeLabel': '右側のテキストから続ける',
  'spu.resumeDesc': 'エージェントは右側を「すでに書き終えた出力」として受け取り、最初からやり直さずに続きだけを書きます。',
  'spu.resumeTruncated': '右側が途中で切れているようです（Layer 3 が無い）ので、自動的に有効化しました。',
  'spu.resumeComplete': '右側は完成しているようです。通常の再実行ならオフのままにしてください。',
  'spu.shiftConfirm':
    '右側にはすでに完成した草稿があります。\n\n' +
    'このまま続けると、いま左側にある内容をバックアップしたうえで、この草稿を左側に移し、' +
    '右側を空にしてこの実行が新しく書き込めるようにします。\n\n' +
    '左側は作業コピーです。{name}のこの会話の完成した魂ファイルには触れません。\n\n' +
    '続けますか？',
  'spu.backupsLabel': '魂のバックアップ',
  'spu.beforeBackup': '更新前',
  'spu.afterBackup': '更新後',
  'spu.pickBackup': 'スナップショットを選択…',
  'spu.noBackups': 'なし',
  'spu.restore': '復元',
  'spu.restoreBeforeTitle': 'このスナップショットを左ペイン（作業コピー）へ読み込む',
  'spu.restoreAfterTitle': 'このスナップショットを右ペイン（次の下書き）へ読み込む',
  'spu.backupRestoredBefore': '「更新前」のスナップショットを左ペイン（作業コピー）へ復元しました。',
  'spu.backupRestoredAfter': '「更新後」のスナップショットを右ペイン（次の下書き）へ復元しました。',
  'spu.backupRestoreFailed': '復元に失敗しました。',
  'spu.currentLabel': '現在の魂の作業コピー（全レイヤー — 自由に編集できます。Layer 4 はここで一度だけ削除してください）',
  'spu.work.badge': '{file} とは内容が違います',
  'spu.work.noFile': '{file} はディスクに存在しません — このペインが唯一の写しです',
  'spu.work.reload': '魂ファイルから読み直す',
  'spu.work.reloadTitle': 'この作業コピーを捨てて、ディスク上の {file} をそのまま読み込む',
  'spu.work.write': '魂ファイルに書き込む',
  'spu.work.writeTitle': '{file} をこの作業コピーで上書きする（上書き前のファイルは控えを取ります）',
  'spu.work.writeConfirm':
    '{file} を左ペインの内容で上書きしますか？\n\n' +
    '{file} は「この会話」の完成した魂 — この世代が実際に何で動いていたかの記録です。' +
    '通常はここに書き込む必要はありません。次の世代は「次の会話へ」が右ペインから保存します。\n\n' +
    '使うのは、まだファイルが無い魂を手で書いているとき、または記録を意図して訂正するときです。' +
    '上書き前に現在のファイルの控え（魂のバックアップ →「更新前」）を日付つきで取ります。\n\n' +
    '上書きしますか？',
  'spu.work.written': '作業コピーを {file} に書き込みました（上書き前の内容は控えを取ってあります）。',
  'spu.work.writeFailed': '魂ファイルに書き込めませんでした：{e}',
  'spu.work.reloaded': 'ディスク上の魂ファイルから左ペインを読み直しました。',
  'spu.work.reloadFailed': '魂ファイルを読めませんでした：{e}',
  'spu.tokens': 'トークン',
  'spu.chars': '文字',
  'spu.updatedLabel': '更新後',
  'spu.streamingRO': '· 受信中（読み取り専用）…',
  'spu.emptyPh': '（空）',
  'spu.noUpdatePh': '（まだ更新はありません — 「会話から更新」を押してください）',
  'spu.compareButton': '差分ツールで比較',
  'spu.compareActive': '差分ツールの編集を同期中…',
  'spu.changelogLabel': '変更履歴（Layer 1 より上 — beings/{folder}/changelogs/{title}.md に保存 · コンテキストには入りません）',
  'spu.layer4Write': 'Layer 4 書き込み · beings/{folder}/summaries/',
  'spu.backupLine': 'バックアップ: {n} ファイル →',
  'spu.backupNone': 'バックアップ: コピー対象なし（フォルダは空でした）。',
  'spu.replaced': '置換 ({n}):',
  'spu.created': '新規作成 ({n}) — タイトルに対応するファイルが無く、誤字の可能性があります:',
  'spu.skipped': 'スキップ ({n}):',
  'spu.untitled': '（無題）',
  'spu.noSummaryWritten': '要約ファイルは書き込まれませんでした。',
  'spu.logsLabel': '省略／削除ログ（参照用 — 次の会話には保存されません）',
  'spu.layer4Summary': 'Layer 4 · 要約',
  'spu.convoSummary': 'この会話の要約',
  'spu.writeSummary': '要約を書く',
  'spu.writeSummaryTitle': 'この会話の要約を生成します（Layer 1〜3 ＋ 会話ログ）',
  'spu.summaryEditable': '編集可 — beings/{folder}/summaries/{convo}.md に自動保存されます',
  'spu.summaryPh': '（まだ要約はありません — 「要約を書く」を押すか、ここに直接入力してください）',
  'spu.summaryNote': 'この要約は、このフォルダの全会話に対する Layer 4 要約インデックスに表示されます。非アクティブな会話はインデックスから除外されます。',
  'spu.summaryInstrLabel': '要約ライターへの追加指示（フォルダごと）',
  'spu.summaryInstrPh': '任意。例：「英語で要約して」「決定と感情の変化に集中し、挨拶は省く」「4文以内に収める」。',
  'spu.forceMimo': '要約ライターには常に MiMo V2.6 Pro を使う',
  'spu.indexHintLabel': 'エンティティに見せるインデックスの説明文（フォルダごと）',
  'spu.indexHintPh': 'エンティティのコンテキスト内で、要約インデックスの上に付加されます。空にすると表示されません。',
  'spu.indexHintNote': '`{example}` は実際の会話タイトルに置き換えられます。空にすると説明文は表示されません。',
  'spu.resetDefault': '既定に戻す',
  'spu.layer5Label': 'Layer 5 — FOOTER.md（エンティティ自身が書いたもの）',
  'spu.unsaved': '未保存',
  'spu.footerSaved': '保存しました',
  'spu.footerSaveFailed': '保存に失敗しました: {e}',
  'spu.footerPhEmpty': 'このエンティティの FOOTER.md は空です。',
  'spu.footerPhNone': 'このエンティティにはまだ FOOTER.md がありません。ここに入力すると作成されます。',
  'spu.footerNote': '`beings/{folder}/workspace/FOOTER.md` — 送信時に Layer 5 として注入され、会話には保存されません。だからこそ、更新エージェントからは今まで見えていませんでした。今は見えますが、**参照専用**です。ここはエンティティが自分自身について書く唯一のレイヤーなので、エージェントには「一貫性のために読むだけ。書き換えも複製もしないこと」と指示してあります。ここで編集するとエンティティ自身の文章を上書きします — 直前の版は `beings/{folder}/backups/footers/` にバックアップされます。フォーカスを外すと保存されます。',

  'spu.badge.callingTitle': 'POST 送信済み。最初の応答チャンクを待っています',
  'spu.badge.calling': '呼び出し中…',
  'spu.empty': '（空）',
  'spu.badge.thinkingTitle': '思考中 — 思考 {n} 文字',
  'spu.badge.thinking': '思考中',
  'spu.badge.writingTitle': '出力中 — {n} 文字',
  'spu.badge.writing': '出力中',
  'spu.badge.doneTitle': '完了 — 出力 {n} 文字',
  'spu.badge.done': '完了',
  'spu.badge.error': 'エラー',

  'spu.run.elapsed': '経過',
  'spu.run.total': '合計',
  'spu.run.elapsedTitle': 'この魂梱包にかかった実時間。表示のみで、どこにも保存されません。',
  'spu.run.activityTitle': 'プロバイダが「いま何をしているか」と報告している内容。',
  'spu.run.silent': '{d} 無反応',
  'spu.run.silentTitle': 'この時間、プロバイダから何も届いていません。よくある原因は Anthropic 側の自動コンパクション、リトライ待ち、レート制限の待機です。処理は止まっていません。',
  'spu.run.tokensTitle': 'この実行の直近の呼び出しについて、プロバイダが報告したトークン使用量。',
  'spu.run.toolsTitle': 'この実行中に行われたファイルツール呼び出し — クリックで詳細。',
  'spu.tool.title': 'この実行でのツール呼び出し',
  'spu.tool.count': '{n} 件',
  'spu.tool.copyJson': 'レポート全体を JSON でコピー',
  'spu.tool.truncated':
    '表示用に引数を省略 — 元は {n} 文字でした。',
  'spu.tool.footer':
    'この実行の間だけ表示されます。ディスクには保存されず、次の実行が始まると消えます。',

  'spu.st.period': '。',
  'spu.st.loading': '現在／次の魂ファイルを読み込み中…',
  'spu.st.loadedDraft': '次の会話用の下書きをディスクから読み込みました — 続きから再開できます。',
  'spu.st.noAgentFolder': '言語「{lang}」のエージェントファイルが見つかりません。system_prompt_agents/{lang}/（local_data、または同梱の defaults）に置いてください。',
  'spu.st.loadFailed': '読み込みに失敗しました: {e}',
  'spu.st.agentLoadFailed': 'エージェントの読み込みに失敗しました: {e}',
  'spu.st.noAgentFile': 'system_prompt_agents/{lang}/ に「{file}」が見つかりません。',
  'spu.st.updating': 'Layer 1〜3 を更新中（1パス）…',
  'spu.st.refining': '会話ログ無しで、魂自体から Layer 1〜3 を整えています…',
  'spu.st.continuation': '出力がトークン上限を超えて続いています — 続きを取得中（継続 {n} 回目）…',
  'spu.st.emptyResponse': '空の応答（拒否、コンテンツフィルター、または出力トークン上限）',
  'spu.st.updateStoppedEmpty': '更新を停止しました — まだ出力はありません。',
  'spu.st.updateNoText': '更新エージェントがテキストを返しませんでした — モデルが拒否したか、フィルターに掛かった可能性があります。',
  'spu.st.updateStoppedPartial': '更新を停止しました — 途中結果（{n} 文字）を保持しています。確認するか、再実行してください。',
  'spu.st.updateDone': 'Layer 1〜3 を更新しました（{n} 文字）',
  'spu.st.changelogSaved': ' · 変更履歴を保存（{n} 文字）',
  'spu.st.changelogSavedShort': ' · 変更履歴を保存',
  'spu.st.logsSeparated': ' · ログ {n} 文字を分離',
  'spu.st.updateStopped': '更新を停止しました。',
  'spu.st.updateFailed': '更新に失敗しました: {e}',
  'spu.st.shiftFailed': '右側を左側に移せなかったため、実行を中止しました: {e}',
  'spu.st.redistributing': 'Layer 1〜4 を再配分中（会話ログなし）…',
  'spu.st.redistStoppedEmpty': '再配分を停止しました — まだ出力はありません。',
  'spu.st.redistNoText': '再配分エージェントがテキストを返しませんでした — モデルが拒否したか、フィルターに掛かった可能性があります。',
  'spu.st.redistStoppedPartial': '再配分を停止しました — 未加工の途中出力（{n} 文字）を右ペインに残しています。要約ファイルは書き込んでいません。「右側のテキストから続ける」にチェックして再開してください。',
  'spu.st.redistTruncated': '完了マーカーが無いまま出力が終わりました — 途中で切れたものとして扱います。未加工の出力（{n} 文字）は残しましたが、要約ファイルは書き込んでいません。「右側のテキストから続ける」にチェックして再実行してください。',
  'spu.st.truncatedBadge': '未完成 — 完了マーカーなし',
  'spu.st.updateTruncated': '完了マーカーが無いまま出力が終わりました — 途中で切れたものとして扱います。未加工の出力（{n} 文字）を右ペインに残し、Layer の切り出しは行わず、自動連鎖も要約の手前で止めました。これを世代としてコミットしないこと — 「右側のテキストから続ける」にチェックして再実行してください。',
  'spu.st.genesisTruncated': '完了マーカーが無いままジェネシスの出力が終わりました — 途中で切れたものとして扱います。未加工の出力（{n} 文字）を右ペインに残しました。これを第1世代としてコミットしないこと — 「右側のテキストから続ける」にチェックして再実行してください。',
  'spu.commitTruncatedConfirm':
    '右側のテキストを作った実行は、完了マーカーが無いまま終わっています（{n} 文字）。途中で切れている可能性が非常に高いです。\n\n' +
    '{file} に書き込むと、それが次の世代で毎ターン渡される常設のアイデンティティになります。\n\n' +
    'それでも書き込みますか？',
  'spu.commitTruncatedCancelled': '中止しました — 何も書き込んでいません。右ペインには未完成のテキストが残っています。「右側のテキストから続ける」にチェックして再実行してください。',
  'spu.st.redistNoLayer4': '再配分は終わりましたが、出力に Layer 4 の見出しがありませんでした — Layer 1〜3 は右ペインにあります。要約ファイルは書き込んでいません。',
  'spu.st.redistNoEntries': '再配分は終わりましたが、Layer 4 の中に「### <タイトル>」の項目が見つかりませんでした — 要約ファイルは書き込んでいません。',
  'spu.st.redistBackingUp': '{folder} の要約をバックアップし、{n} 件を書き込んでいます…',
  'spu.st.redistDone': 'Layer 1〜3 を更新しました（{n} 文字）· Layer 4: {r} 件を置換',
  'spu.st.redistCreated': '、{n} 件を新規作成',
  'spu.st.redistSkipped': '、{n} 件をスキップ',
  'spu.st.redistBackedUp': ' · {n} ファイルをバックアップ',
  'spu.st.redistNoBackup': ' · バックアップ対象なし',
  'spu.st.redistStopped': '再配分を停止しました。',
  'spu.st.redistFailed': '再配分に失敗しました: {e}',
  'spu.st.indexing': '外部化・索引化中（会話ログなし）…',
  'spu.st.indexStoppedEmpty': '外部化を停止しました — まだ出力はありません。',
  'spu.st.indexNoText': '外部化エージェントがテキストを返しませんでした — モデルが拒否したか、フィルターに掛かった可能性があります。',
  'spu.st.indexStoppedPartial': '外部化を停止しました — 未加工の途中出力（{n} 文字）を右ペインに残しています。机のファイルは書き込んでいません。「右側のテキストから続ける」にチェックして再開してください。',
  'spu.st.indexTruncated': '完了マーカーが無いまま出力が終わりました — 途中で切れたものとして扱います。未加工の出力（{n} 文字）は残しましたが、机のファイルは書き込んでいません。「右側のテキストから続ける」にチェックして再実行してください。',
  'spu.st.indexNoFileList': '外部化は完了しましたが、外に出す内容はありませんでした — Layer 1〜3 は右ペインにあります。机のファイルへの書き込みはありません',
  'spu.st.indexApplying': '机のファイルを {n} 件書き込んでいます…',
  'spu.st.indexDone': 'Layer 1〜3 を更新しました（{n} 文字）· 机のファイル: {c} 件新規作成、{a} 件追記',
  'spu.st.indexSomeFailed': '、{n} 件失敗',
  'spu.st.indexStopped': '外部化を停止しました。',
  'spu.st.indexFailed': '外部化に失敗しました: {e}',
  'spu.st.genesisRunning': 'Layer 1〜3 をゼロから構築中（ジェネシス — 既存の文書を前提としません）…',
  'spu.st.genesisStoppedEmpty': 'ジェネシスを停止しました — まだ出力はありません。',
  'spu.st.genesisNoText': 'ジェネシスがテキストを返しませんでした — モデルが拒否したか、フィルターに掛かった可能性があります。',
  'spu.st.genesisStoppedPartial': 'ジェネシスを停止しました — 途中結果（{n} 文字）を保持しています。確認するか、再実行してください。',
  'spu.st.genesisDone': 'Layer 1〜3 をゼロから構築しました（{n} 文字）',
  'spu.st.genesisStopped': 'ジェネシスを停止しました。',
  'spu.st.genesisFailed': 'ジェネシスに失敗しました: {e}',
  'spu.st.summaryWriting': '会話の要約を作成中…',
  'spu.st.summaryStoppedEmpty': '要約を停止しました — まだ出力はありません。',
  'spu.st.summaryNoText': '要約ライターがテキストを返しませんでした。',
  'spu.st.summaryStoppedPartial': '要約を停止しました — 途中結果（{n} 文字）を保持しています。',
  'spu.st.summaryDone': '要約を作成しました（{n} 文字）。',
  'spu.st.summariesEnabled':
    'この存在の「第4層の代わりに要約を使う」を ON にしました — OFF のままでは、いま書いた要約を本人が読めません。',
  'spu.st.convoToolsEnabled':
    'この存在が自分の過去の会話を読めるようにしました（read_conversation / search_conversations）— 第4層に題名が並ぶので、開けるようにしてあります。ローカルモデルが答えなくなったら、人格の窓から切ってください。',
  'spu.st.summaryStopped': '要約を停止しました。',
  'spu.st.summaryFailed': '要約の作成に失敗しました: {e}',
  'spu.st.autoStopUpdate': '⛔ アイデンティティ更新の段階で自動処理を中止しました。エラーを直して（または停止した場合は）再実行してください。',
  'spu.st.autoStopSummary': '⛔ 要約の段階で自動処理を中止しました。エラーを直して（または停止した場合は）再実行してください。',
  'spu.st.autoDone': 'アイデンティティを更新し、要約も作成しました。確認したら「次の会話へ」を押してください。',
  'spu.st.savingFiles': '現在／次の魂ファイルを保存中…',
  'spu.st.finalizing': '確定中 — 会話を複製しています…',
  'spu.st.finalizeFailed': '確定に失敗しました: {e}',
};

/**
 * Look up a GUI string by key for the given language. Falls back to the
 * English string (then to the key itself) when the key is missing from the
 * Japanese dict, so partial coverage never shows a blank label.
 */
export function t(key: string, language?: string | null): string {
  const lang: UiLanguage = language === 'ja' ? 'ja' : 'en';
  if (lang === 'ja' && key in UI_STRINGS_JA) return UI_STRINGS_JA[key];
  if (key in UI_STRINGS_EN) return UI_STRINGS_EN[key];
  return key;
}

// ── Inline markup ──────────────────────────────────────────────────────────
// Help prose carries `code` and **bold** runs. Keeping them inside the string
// means a translator sees one sentence and can move the emphasis to wherever
// the target language puts it — Japanese word order is not English word order,
// so a sentence chopped into <span> fragments cannot be translated correctly.

const MARKUP = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;

/** Render a string with `code`, **bold** and *italic* runs into React nodes. */
export function renderRich(text: string): React.ReactNode[] {
  return text.split(MARKUP).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      return (
        <code key={i} className="font-mono bg-muted px-1 rounded">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 3) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 1) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

// ── React plumbing ─────────────────────────────────────────────────────────
// One provider at the NexusApp root; every component below reads it through
// useT(). A component rendered outside the provider (e.g. in isolation, or a
// stray tree) gets English rather than throwing — a missing translation must
// never be able to break the interface.

const LanguageContext = createContext<UiLanguage>('en');

export function LanguageProvider({
  language,
  children,
}: {
  language?: string | null;
  children: React.ReactNode;
}) {
  const lang: UiLanguage = language === 'ja' ? 'ja' : 'en';
  return <LanguageContext.Provider value={lang}>{children}</LanguageContext.Provider>;
}

/** Current UI language ('en' | 'ja'). */
export function useLanguage(): UiLanguage {
  return useContext(LanguageContext);
}

/** Translator bound to the current UI language. */
export function useT(): (key: string) => string {
  const lang = useContext(LanguageContext);
  return useMemo(() => (key: string) => t(key, lang), [lang]);
}

/** Translated help prose with its inline `code` / **bold** markup rendered. */
export function Tx({ k }: { k: string }) {
  const lang = useContext(LanguageContext);
  return <>{renderRich(t(k, lang))}</>;
}
