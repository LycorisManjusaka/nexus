"use client";

import React, { useState, useEffect, useRef } from 'react';
import { PlusCircle, MessageSquare, Settings, Trash2, MoreVertical, Copy, Pencil, UserRoundPlus, Edit2, Palette, Upload, Settings2, Mic, History, ArrowDown, ArrowUp, Eye, EyeOff, HelpCircle, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import VoiceSelector from './VoiceSelector';
import {
  parseMarkdown,
  diagnoseMarkdown,
  detectDialect,
  planSplitByTokens,
  splitPartTitle,
  type DialectInfo,
} from '@/lib/markdownLogic';
import { deepSeekJsonToMarkdown, isDeepSeekJson } from '@/lib/deepseekJson';
import IdentityDropdown from './IdentityDropdown';
import { v4 as uuidv4 } from 'uuid';
import { orderFolderConversations } from '@/lib/deepLink';
import { nextConversationTitle } from '@/lib/convoNaming';
import {
  DEFAULT_MAX_CONVERSATION_LOG,
  LOG_CAP_UNIT,
  LOG_CAP_MIN_UNITS,
  LOG_CAP_MAX_UNITS,
  clampLogCapUnits,
  messageTextTokens,
} from '@/lib/handoverRestore';
import { useT, Tx } from '@/lib/i18n';
import { useDevice } from './DeviceProvider';
import { confirmIfBusy, markBusyConfirmAnswered } from '@/lib/unloadGuard';
import { withBuildTag } from '@/lib/buildVersion';

interface SidebarProps {
  conversations: any[];
  // True while the initial /api/logs fetch is in flight. When true we show
  // a skeleton placeholder instead of the "No history" empty state so the
  // user knows the list is loading rather than genuinely empty.
  conversationsLoading?: boolean;
  setConversations?: React.Dispatch<React.SetStateAction<any[]>>;
  currentConvoId: string | null;
  onSelectConvo: (id: string) => void;
  onNewChat: () => void;
  onDeleteChat: (id: string) => void;
  onRenameChat: (id: string, newTitle: string) => void;
  onCloneChat: (id: string) => void;
  onToggleActive?: (id: string) => void;
  onOpenSettings: () => void;
  // The user guide is not about the current conversation or identity, so its
  // entry point lives up here next to Preferences, not in the chat tool row.
  onOpenGuide?: () => void;

  // Global (per-machine) preferences. Read here only for
  // `alwaysShowHoverControls`, which decides whether a row's "..." menu is
  // hover-revealed or permanent.
  globalSettings?: any;

  folders: any[];
  setFolders?: React.Dispatch<React.SetStateAction<any[]>>;
  activeFolderId: string | null;
  setActiveFolderId: (id: string) => void;
  // Both resolve when the refetch has landed in state. Declared this way so
  // callers can await them (createFolder has to, or fetchLogs would wipe the
  // conversation it just opened).
  fetchFolders: () => void | Promise<void>;
  fetchLogs: () => void | Promise<void>;
}

export default function Sidebar({
  conversations,
  conversationsLoading = false,
  setConversations,
  currentConvoId,
  onSelectConvo,
  onNewChat,
  onDeleteChat,
  onRenameChat,
  onCloneChat,
  onToggleActive,
  onOpenSettings,
  onOpenGuide,
  folders,
  setFolders,
  activeFolderId,
  setActiveFolderId,
  fetchFolders,
  fetchLogs,
  globalSettings
}: SidebarProps) {
  const t = useT();
  const { isMobile, sidebarOpen, setSidebarOpen, setCameraSlot } = useDevice();

  // Every path that lands on a conversation goes through here. On mobile the
  // list is a modal drawer, and choosing something from it means the person is
  // done with the list — leaving it open would hide the thing they just asked
  // for. On desktop `setSidebarOpen(false)` is a no-op: nothing reads it.
  const selectConvo = (id: string) => {
    setSidebarOpen(false);
    onSelectConvo(id);
  };

  // ── Busy guard for the actions below ──────────────────────────────────────
  // `onSelectConvo` / `setActiveFolderId` arrive here ALREADY guarded, which is
  // enough for a plain click on a row. It is not enough for the actions in this
  // file that do their work FIRST and navigate at the end (import, restore,
  // create/rename/delete identity): by the time the guarded setter asks, the
  // files are already written, so "no" would leave a half-done job. Those ask
  // up front instead, then call markBusyConfirmAnswered() just before
  // navigating so the same intent is not questioned twice.
  //
  // See src/lib/unloadGuard.ts for why the gate and its de-dupe window are
  // shared module state rather than props.
  const confirmActionIfBusy = () =>
    confirmIfBusy(busy => t('app.action.busyConfirm').replace('{busy}', busy));

  const activeFolder = folders.find(f => f.id === activeFolderId);
  const convoOrder = activeFolder?.settings?.convoOrder || [];
  
  // Shared with the deep-link router: `/c/<folder>` opens "the top conversation",
  // which must mean the row the user actually sees first. Two copies of this
  // comparator would drift apart silently.
  const filteredConvos = orderFolderConversations(
    conversations.filter(c => c.folderName === activeFolder?.name),
    convoOrder,
  );

  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // ── Conversation summary hover preview ─────────────────────────────────────
  // Every summary in the active folder, fetched ONCE per folder and keyed by
  // summaryKey(title) — the same filename stem the server files them under.
  // One request per folder, not one per row; the map is small (plain markdown)
  // and is dropped as soon as the folder changes.
  const [folderSummaries, setFolderSummaries] = useState<Record<string, string>>({});
  // The popup is position:FIXED, not absolute. The conversation list is an
  // overflow-y-auto scroll container, and per spec `overflow-y:auto` with
  // `overflow-x:visible` computes x to auto as well — an absolutely-positioned
  // popup sticking out to the right of a row would simply be clipped off. So
  // the row's viewport rect is captured on hover and the popup is placed
  // against the viewport instead.
  const [hoveredConvo, setHoveredConvo] = useState<{ id: string; top: number; left: number } | null>(null);

  useEffect(() => {
    const name = activeFolder?.name;
    if (!name) { setFolderSummaries({}); return; }
    let cancelled = false;
    // Clear first so a slow fetch can never show the PREVIOUS folder's
    // summaries against this folder's titles.
    setFolderSummaries({});
    (async () => {
      try {
        const res = await fetch(`/api/summaries?folder=${encodeURIComponent(name)}&mode=all`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data?.summaries) setFolderSummaries(data.summaries);
      } catch { /* preview is optional — a failed fetch just means no tooltip */ }
    })();
    return () => { cancelled = true; };
  }, [activeFolder?.name]);

  // Must stay identical to summaryKey() in lib/summaryStorage.ts. That module
  // can't be imported here (it pulls in fs/path) so the rule is duplicated;
  // if it changes there, change it here or every preview silently misses.
  const summaryKeyForTitle = (title: string) =>
    String(title || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\.\.+/g, '_').trim();

  // ── Orphaned summaries ────────────────────────────────────────────────────
  // Layer 4 is assembled by walking CONVERSATIONS and looking up each one's
  // summary by title (see assembleSummaryIndex / summaryKey). A summary file
  // that matches no conversation title is therefore never read — and says
  // nothing about it. Everything else keeps working, so the loss is invisible:
  // the being simply never receives that part of its memory.
  //
  // That is a defect, not a feature, and the fix is that the file announces
  // itself. Measured against all existing data before adding this: 212 summary
  // files, 0 orphans — so this row is silent in normal operation and only
  // appears when something really is stranded. Inactive conversations are NOT
  // orphans (they exist; the index filters them deliberately), which is why
  // this compares against every conversation in the folder rather than the
  // visible ones.
  const orphanSummaries = Object.keys(folderSummaries)
    .filter((key) => key && !filteredConvos.some((c: any) => summaryKeyForTitle(c.title) === key))
    .sort();

  const previewForConvo = (title: string): string | null => {
    const raw = folderSummaries[summaryKeyForTitle(title)];
    if (!raw) return null;
    const text = raw.trim();
    if (!text) return null;
    return text.length > 600 ? `${text.slice(0, 600)}…` : text;
  };

  const handleDragStart = (id: string) => {
    setDraggedId(id);
  };

  const handleDragOver = (e: React.DragEvent, id: string) => {
    e.preventDefault();
    if (id !== dragOverId) setDragOverId(id);
  };

  const handleDragEnd = () => {
    setDraggedId(null);
    setDragOverId(null);
  };

  const handleDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    if (!draggedId || draggedId === targetId || !activeFolder) {
      handleDragEnd();
      return;
    }

    const currentOrder = filteredConvos.map(c => c.id);
    const oldIndex = currentOrder.indexOf(draggedId);
    const newIndex = currentOrder.indexOf(targetId);

    const newOrder = [...currentOrder];
    newOrder.splice(oldIndex, 1);
    newOrder.splice(newIndex, 0, draggedId);

    // Optimistic — update the local folders state so the sidebar reorders
    // immediately. The POST + fetchFolders reconcile in the background; the
    // user doesn't have to wait 5-10s for the disk write to feel responsive.
    const newSettings = { ...activeFolder.settings, convoOrder: newOrder };
    if (setFolders) {
      setFolders(prev => prev.map(f => f.id === activeFolder.id ? { ...f, settings: newSettings } : f));
    }
    handleDragEnd();

    fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: activeFolder.name, settings: newSettings }),
    }).then(() => fetchFolders()).catch(() => fetchFolders());
  };

  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [deleteModalId, setDeleteModalId] = useState<string | null>(null);
  const [deleteFolderModal, setDeleteFolderModal] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  
  const [folderMenuOpen, setFolderMenuOpen] = useState(false);
  
  const [themeModalOpen, setThemeModalOpen] = useState(false);
  const [customCss, setCustomCss] = useState('');
  const [ttsDict, setTtsDict] = useState('');
  const [ttsDictError, setTtsDictError] = useState<string | null>(null);
  const [folderVoice, setFolderVoice] = useState({ engine: 0, char_idx: 0, style_idx: 0 });
  const [folderVoicePitch, setFolderVoicePitch] = useState(0.0);
  // Per-folder context-management settings. Moved here from global Preferences
  // so each AI entity / persona can have its own token budget, auto-trim
  // policy, and identity-layer compression threshold (since longer-lived
  // characters often want to keep more log than throwaway conversations).
  const [folderMaxConversationLog, setFolderMaxConversationLog] = useState<number>(DEFAULT_MAX_CONVERSATION_LOG);
  const [folderAutoTrim, setFolderAutoTrim] = useState<boolean>(true);
  const [folderMaxTokensPerLayer, setFolderMaxTokensPerLayer] = useState<number>(8000);
  const [liveSessionVoice, setLiveSessionVoice] = useState('Aoede');
  const [liveVoiceMode, setLiveVoiceMode] = useState<'preset' | 'custom'>('preset');
  const [liveCustomVoice, setLiveCustomVoice] = useState('');

  const [backupsModalOpen, setBackupsModalOpen] = useState(false);
  const [backups, setBackups] = useState<any[]>([]);
  const [fetchingBackups, setFetchingBackups] = useState(false);

  const fetchBackups = async () => {
    if (!activeFolder) return;
    setFetchingBackups(true);
    try {
      const res = await fetch(`/api/backups?folder=${encodeURIComponent(activeFolder.name)}`);
      const data = await res.json();
      setBackups(data);
    } catch(e) {}
    setFetchingBackups(false);
  };

  const handleRestoreBackup = async (backupFile: string) => {
    if (!activeFolder) return;
    // Restoring writes a conversation and then opens it — ask before the write.
    if (!confirmActionIfBusy()) return;
    try {
      const res = await fetch('/api/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderName: activeFolder.name, backupFile })
      });
      const data = await res.json();
      if (data.success && data.newConvoId) {
        fetchLogs();
        markBusyConfirmAnswered();
        selectConvo(data.newConvoId);
        setBackupsModalOpen(false);
      }
    } catch(e) {}
  };

  // Close menu if clicked outside
  useEffect(() => {
    if (!menuOpenId) return;
    const closeMenu = () => setMenuOpenId(null);
    // Slight delay so the click opening it doesn't immediately close it
    setTimeout(() => {
      document.addEventListener('click', closeMenu);
    }, 10);
    return () => document.removeEventListener('click', closeMenu);
  }, [menuOpenId]);


  const handleSort = async (order: 'asc' | 'desc') => {
    if (!activeFolder) return;
    const extractNum = (str: string) => {
      const normalized = str.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
      const match = normalized.match(/\d+/);
      return match ? parseInt(match[0], 10) : 0;
    };

    const folderConvos = conversations.filter(c => c.folderName === activeFolder.name);
    
    folderConvos.sort((a, b) => {
      const numA = extractNum(a.title || '');
      const numB = extractNum(b.title || '');
      return order === 'asc' ? numA - numB : numB - numA;
    });

    const newOrder = folderConvos.map(c => c.id);
    const newSettings = { ...activeFolder.settings, convoOrder: newOrder };
    await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: activeFolder.name, settings: newSettings })
    });
    fetchFolders();
    setFolderMenuOpen(false);
  };

  const importMdRef = useRef<HTMLInputElement>(null);

  // ── Unrecognized-format diagnostics ───────────────────────────────────────
  // When a file cannot be read as a format NEXUS knows, the only thing that
  // makes a parser writable for it is the bytes themselves. So the head of the
  // file is shown VERBATIM (no trimming, no whitespace collapsing, BOM and all)
  // for the reader to copy into a report. "Import failed" describes nothing;
  // these 200 characters describe the format.
  const IMPORT_HEAD_CHARS = 200;
  const fileHead = (text: string) =>
    text.slice(0, IMPORT_HEAD_CHARS) + (text.length > IMPORT_HEAD_CHARS ? ' …' : '');

  const handleImportMd = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleAutoImport(e);
    if (importMdRef.current) importMdRef.current.value = '';
  };

  const handleAutoImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    if (!activeFolder) {
      console.warn('[md-import] Refused: no active folder selected. Open/select a Digital Being first, then import.');
      alert(t('sidebar.import.noFolder'));
      return;
    }
    // This ends on onSelectConvo, so ask up front.
    // Clear the input on the way out too — leaving the old value in place means
    // picking the same file again fires no change event, and the reader would
    // read that silence as the import being broken rather than declined.
    if (!confirmActionIfBusy()) {
      if (importMdRef.current) importMdRef.current.value = '';
      return;
    }

    const extractNum = (str: string) => {
      const normalized = str.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
      const match = normalized.match(/\d+/);
      return match ? parseInt(match[0], 10) : 0;
    };

    // Descending by extracted number — for batches like "convo1.md ... convo10.md",
    // the highest-numbered file ends up FIRST after this sort, and after we
    // prepend the resulting IDs as a block below, it lands at the very top
    // of the sidebar (which matches user expectation that the newest/highest
    // number is the "current" conversation to open).
    const filesArray = Array.from(files).sort((a, b) => extractNum(b.name) - extractNum(a.name));

    // Sequential on purpose: a race-free convoOrder update and a
    // deterministic "open the first imported file" UX.
    (async () => {
      const newIds: string[] = [];
      const importErrors: string[] = [];
      // Fetch the registered speaker names from character_map.json once. Only
      // these names (plus the entity/assistant name and the built-in
      // "Anonymous" — "User" from pre-rename exports is still recognized too)
      // are allowed to start a new message when parsing "## X" headers — any
      // other "## ..." line is kept as body text. If the fetch fails we pass an
      // empty list, so only the entity + "Anonymous"/"User" headers are recognized.
      let validUserNames: string[] = [];
      try {
        const cr = await fetch('/api/chara/list');
        if (cr.ok) {
          const cd = await cr.json();
          validUserNames = (cd.characters || [])
            .map((c: any) => c?.name)
            .filter((n: any): n is string => typeof n === 'string' && n.trim().length > 0);
        }
      } catch {}

      // Who the human side of a FOREIGN-dialect log becomes. A DeepSeek export
      // says "You:", which is a pronoun, not a name — the house's answer to
      // "who is speaking right now" is the selected user identity, the same
      // file the input area and the voice pipeline read. Native .md files are
      // unaffected: they carry real speaker names already.
      let importUserName = 'Anonymous';
      try {
        const ur = await fetch('/api/chara/current');
        if (ur.ok) {
          const ud = await ur.json();
          if (typeof ud?.name === 'string' && ud.name.trim()) importUserName = ud.name.trim();
        }
      } catch {}

      // The tokenizer profile is the folder's aiName, not its display name
      // (the folder NAME is what matches speaker headers). Same value feeds
      // the split planner and /api/tokens so one screen never shows two scales.
      const tokenModel = activeFolder.settings?.aiName || activeFolder.name || 'Claude';
      const logCap = activeFolder.settings?.maxConversationLog || DEFAULT_MAX_CONVERSATION_LOG;

      // ── Phase 1: parse and PLAN. Nothing is written in this pass. ─────────
      // Splitting and dialect detection both change what the import produces,
      // and both are invisible once it has happened. So the plan is computed
      // first, stated once, and only then carried out.
      type ImportPlan = {
        fileName: string;
        title: string;
        dialect: DialectInfo;
        parts: any[][];
        messages: number;
        tokens: number;
        /** Things the converter had to decide — shown, never swallowed. */
        notes: string[];
      };
      const plans: ImportPlan[] = [];

      for (const file of filesArray) {
        try {
          let text = await file.text();
          let title = file.name.replace(/\.[^/.]+$/, "");
          const extraNotes: string[] = [];
          // A DeepSeek conversation JSON is rendered to the dialect this
          // importer already reads, then follows the identical path. It does
          // NOT build messages of its own: the `[username]` tag rule, the
          // timestamp rule, `[thinking]`, splitting, the first-original marker
          // and the sidebar order then have exactly one implementation — the
          // tested one. Byte-equality with ds_to_md.py (round-trip verified
          // 44/44) is what holds the renderer to that verification.
          //
          // The TITLE comes from the JSON, not from the download's file name,
          // which is `deepseek_history_<uuid>.json` and says nothing. That is
          // also what makes `<being>_<n>` naming possible without renaming a
          // file by hand.
          if (/\.json$/i.test(file.name)) {
            const data = JSON.parse(text);
            // The guard stays after the NEXUS-log importer was removed
            // (2026-10-27): without it, a NEXUS log falls into
            // deepSeekJsonToMarkdown, yields zero messages and surfaces as "no
            // speaker headers found" — true of the rendered text, and wrong
            // about the file. Only the WORDING changed: it no longer names a
            // menu item that no longer exists.
            if (!isDeepSeekJson(data) && Array.isArray(data?.messages)) {
              throw new Error(t('sidebar.import.isNexusLog'));
            }
            const conv = deepSeekJsonToMarkdown(data);
            text = conv.markdown;
            if (conv.title) title = conv.title;
            extraNotes.push(...conv.notes);
          }
          const dialect = detectDialect(text, activeFolder.name, validUserNames);
          // 4th arg picks the tokenizer profile for thinking-token estimates
          // only; it is the folder's aiName, not its display name (which the
          // 2nd arg already carries for speaker-header matching).
          const parsed = parseMarkdown(text, activeFolder.name, validUserNames,
            tokenModel, { dialect, userName: importUserName });
          if (parsed.length === 0) {
            // Explain the refusal instead of silently skipping. The usual cause:
            // the file's speaker headers don't match a recognized name (the
            // target folder's entity name, "Anonymous"/"User", or a character_map speaker).
            const diag = diagnoseMarkdown(text, activeFolder.name, validUserNames);
            const unrecognized = diag.headersFound.filter(h => !h.recognized).map(h => h.text);
            let reason: string;
            if (!diag.nonEmpty) {
              reason = 'file is empty / whitespace only';
            } else if (diag.headersFound.length === 0) {
              reason = 'no speaker headers found in any supported dialect — expected "[Name]:" on its own line, ' +
                       'or "You:" / "<Assistant>:" (DeepSeek Chat Exporter), ' +
                       'or "# you asked" / "# <family> response" (older multi-vendor plugin)';
            } else {
              reason = `no header matched a recognized speaker (unrecognized: ${unrecognized.map(n => `"${n}"`).join(', ')})`;
            }
            console.warn(
              `[md-import] "${file.name}" → 0 messages, SKIPPED. Reason: ${reason}.\n` +
              `  Headers in file: ${diag.headersFound.length ? diag.headersFound.map(h => `${h.recognized ? '✓' : '✗'} "${h.text}"`).join(', ') : '(none)'}\n` +
              `  Recognized names (folder being + "Anonymous"/"User" + character_map): ${diag.recognizedNames.map(n => `"${n}"`).join(', ')}\n` +
              `  Fix: rename the header to "${activeFolder.name}", add the speaker to character_map.json, or use "Anonymous".`
            );
            // Carry the head along with the reason: "no header matched" tells
            // the reader the rule, the bytes tell whoever writes the parser
            // what the file actually is.
            importErrors.push(`${file.name}: ${reason}\n  ${t('sidebar.import.head')} ${fileHead(text)}`);
            continue;
          }

          // Size the plan with the SAME function the conversation-log cap uses
          // (`messageTextTokens`), not with /api/tokens. Two counters on one
          // screen is the 2026-10-12 bug: the cap read stored numbers while
          // the bar recomputed, and the two disagreed. The exact counter still
          // runs below for the per-message display values.
          const parts = planSplitByTokens(parsed, logCap, (m) => messageTextTokens(m, tokenModel));
          plans.push({
            fileName: file.name,
            title,
            dialect,
            parts,
            messages: parsed.length,
            tokens: parsed.reduce((a, m) => a + messageTextTokens(m, tokenModel), 0),
            notes: extraNotes,
          });
        } catch (err: any) {
          console.error(`[md-import] "${file.name}" threw while parsing:`, err);
          importErrors.push(`${file.name}: ${err?.message || err}`);
          alert(withBuildTag(`${t('sidebar.import.failed')} "${file.name}": ${err?.message || err}`));
        }
      }

      // Order by the TITLE, not the file name. For .md the two are the same
      // string, so this changes nothing there. For a DeepSeek JSON the file is
      // called `deepseek_history_<uuid>.json` and the number in it is random —
      // which the pre-sort above would read as the generation, scrambling the
      // chain. Order is what handover restore follows for split parts
      // (`resolveHandoverChain`), so a wrong order here is not cosmetic: it
      // decides which conversation is the newest and what gets restored into
      // it. Descending, matching the file pre-sort and "newest at top".
      plans.sort((a, b) => extractNum(b.title) - extractNum(a.title));

      // ── State the plan, but only when it is not the plain case ───────────
      // A one-file, one-part, native import behaves exactly as it always has,
      // with no extra click. The dialog appears only when the import will do
      // something the file name does not already say: split, or read a
      // foreign export.
      const willSplit = plans.some(p => p.parts.length > 1);
      const foreign = plans.some(p => p.dialect.dialect !== 'nexus');
      if (plans.length > 0 && (willSplit || foreign)) {
        const dialectName = (d: DialectInfo) =>
          d.dialect === 'deepseek-exporter'
            ? `${d.userLabel ?? 'You'}/${d.assistantLabel ?? '?'}`
            : d.dialect === 'generic-plugin' ? '# … response'
            : 'NEXUS';
        const lines = plans.map(p =>
          `• ${p.fileName}  [${dialectName(p.dialect)}]  ${p.messages} msg / ~${p.tokens.toLocaleString()} tok` +
          (p.parts.length > 1
            ? `\n    → ${p.parts.length} × ${splitPartTitle(p.title, 0, p.parts.length)} … ${splitPartTitle(p.title, p.parts.length - 1, p.parts.length)}`
            : `\n    → ${p.title}`) +
          // A decision the converter had to make (a renamed speaker label, an
          // abandoned regeneration branch left out) belongs next to the file it
          // was made about. Silent truncation reads as "covered everything".
          p.notes.map(n => `\n    ⚠ ${n}`).join('')
        ).join('\n');
        // The split note rides inside {plan} so it sits next to the part names
        // it is about, and only when the import will actually split — saying it
        // on a one-part foreign import would be a true sentence about something
        // that is not happening. `trimEnd` so the template's own blank line is
        // the only spacing.
        const planBody = lines + (willSplit ? '\n\n' + t('sidebar.import.planSplit').trimEnd() : '');
        const msg = t('sidebar.import.plan')
          .replace('{cap}', logCap.toLocaleString())
          .replace('{user}', importUserName)
          .replace('{entity}', activeFolder.name)
          .replace('{plan}', planBody);
        if (!window.confirm(msg)) {
          console.warn('[md-import] cancelled by user at the plan dialog.');
          return;
        }
      }

      // ── Phase 2: write ───────────────────────────────────────────────────
      for (const p of plans) {
        // Parts go in DESCENDING order for the same reason the file list is
        // sorted descending: the block is prepended, so whatever is pushed
        // first ends up on top, and "newest at top" is this sidebar's rule
        // everywhere else. It also means selectConvo(newIds[0]) opens the
        // part the archive ENDS on, which is where the thread continues.
        for (let i = p.parts.length - 1; i >= 0; i--) {
          const slice = p.parts[i];
          try {
            // Compute tokens for every imported message — parseMarkdown produces
            // tokens:0 since it doesn't know which model is in use. Without this
            // the imported conversation shows blank token counts until each
            // message is manually edited.
            await Promise.all(slice.map(async (m) => {
              try {
                const r = await fetch('/api/tokens', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ text: m.content || '', model: tokenModel }),
                });
                if (r.ok) {
                  const d = await r.json();
                  const tok = d.tokens || 0;
                  m.tokens = tok;
                  m.textTokens = tok;
                }
              } catch {}
            }));

            const convoId = uuidv4();
            await fetch('/api/logs', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                id: convoId,
                logData: {
                  id: convoId,
                  folderName: activeFolder.name,
                  title: splitPartTitle(p.title, i, p.parts.length),
                  messages: slice,
                  aiName: activeFolder.name,
                  // Every imported message is ORIGINAL: nothing here was carried
                  // over from a previous generation of this installation. The
                  // marker on the first message says exactly that, and it is
                  // what lets handover restore run (its gate asks for a marker,
                  // and an absence is not an answer). Nothing else changes —
                  // with the marker at index 0 the auto-trimmer returns early
                  // (`markerIdx <= 0`) and the token buckets read copied = 0,
                  // which is what an unmarked log already defaulted to.
                  firstOriginalMessageId: slice[0]?.id || null,
                  updatedAt: Date.now(),
                },
              }),
            });
            newIds.push(convoId);
          } catch (err: any) {
            console.error(`[md-import] "${p.fileName}" part ${i + 1}/${p.parts.length} threw during import:`, err);
            importErrors.push(`${p.fileName} (${i + 1}/${p.parts.length}): ${err?.message || err}`);
            alert(withBuildTag(`${t('sidebar.import.failed')} "${p.fileName}": ${err?.message || err}`));
          }
        }
      }
      if (newIds.length === 0) {
        console.warn(`[md-import] Nothing imported (${filesArray.length} file(s) tried).${importErrors.length ? ' Reasons:\n  - ' + importErrors.join('\n  - ') : ''}`);
        alert(withBuildTag(
          importErrors.length
            ? t('sidebar.import.nothingWithReasons').replace('{reasons}', importErrors.join('\n'))
            : t('sidebar.import.nothing')
        ));
        return;
      }

      // Pin all imports to the TOP of the convoOrder, in sorted order
      // (highest-numbered first since we sorted descending above).
      const existingOrder: string[] = activeFolder.settings?.convoOrder ||
        conversations.filter(c => c.folderName === activeFolder.name).map(c => c.id);
      const newOrder = [
        ...newIds,
        ...existingOrder.filter(id => !newIds.includes(id)),
      ];
      await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: activeFolder.name,
          settings: { ...activeFolder.settings, convoOrder: newOrder },
        }),
      });

      fetchLogs();
      fetchFolders();
      // Auto-open the first imported file (= the topmost after prepend).
      markBusyConfirmAnswered();
      selectConvo(newIds[0]);
    })();

    setFolderMenuOpen(false);
  };

  const createFolder = async () => {
    const name = prompt(t('sidebar.prompt.newFolder'))?.trim();
    if (!name) return;
    // Asked after the name prompt, not before it: two dialogs in a row before
    // the reader has said what they want is noise. Still before the POST, so
    // declining creates no being.
    if (!confirmActionIfBusy()) return;
    await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // A starting value, not a claim about the being. Some family has to be
      // written here — four readers fall back to 'Claude' anyway, so leaving
      // it out would only move the same guess somewhere nobody can see it.
      // What was missing until 2026-10-27 is that NOTHING else ever wrote this
      // field and no screen could change it, so a being on DeepSeek read
      // `"aiName": "Claude"` in its own settings.json forever. It is now
      // editable under the Entity tab ("this being's default model family"),
      // which also fixes the invisible half: this value is the tokenizer
      // profile the log importer and split planner use.
      body: JSON.stringify({ name, settings: { aiName: 'Claude' } })
    });
    // Wait for both refreshes before opening the first conversation: fetchLogs
    // replaces the whole conversation list, so an entry added ahead of it would
    // be wiped out a moment later.
    await Promise.all([fetchFolders(), fetchLogs()]);

    // A folder's id is its filename stem, which is its name — see listFolders.
    // The onSelectConvo below rides the same 500ms window as this setter.
    markBusyConfirmAnswered();
    setActiveFolderId(name);

    // A brand-new identity opens on its own first conversation rather than an
    // empty pane. Same shape as New Chat: held in memory until the first
    // message is sent, at which point it is written to disk.
    if (setConversations) {
      const newId = uuidv4();
      setConversations(prev => [{
        id: newId,
        title: nextConversationTitle(name, prev.filter(c => c.folderName === name).map(c => c.title)),
        updatedAt: Date.now(),
        folderName: name,
        aiName: 'Claude',
      }, ...prev]);
      selectConvo(newId);
    }
  };

  const handleRenameFolder = async () => {
    if (!activeFolder) return;
    const oldName = activeFolder.name;
    const newName = prompt(t('sidebar.prompt.renameFolder'), oldName)?.trim();
    if (!newName || newName === oldName) return;
    // A rename moves nine things on disk under a being that may be mid-turn —
    // the in-flight save would land under the old name. Ask before touching any
    // of it, and after the name prompt for the same reason as createFolder.
    if (!confirmActionIfBusy()) return;
    const res = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rename', oldName, newName })
    });
    // A rename moves nine things on disk. If any of them didn't move, say so —
    // a partly-renamed identity that looks fine in the sidebar is worse than
    // one that told you what it left behind.
    let result: any = null;
    try { result = await res.json(); } catch {}
    if (!res.ok) {
      alert(`${t('sidebar.renameFolder.failed')}\n\n${result?.error || res.statusText}`);
    } else if (result?.report?.failed?.length) {
      alert(
        `${t('sidebar.renameFolder.partial')}\n\n` +
        result.report.failed.map((f: any) => `• ${f.what}: ${f.error}`).join('\n')
      );
    }
    await Promise.all([fetchFolders(), fetchLogs()]);
    if (res.ok) { markBusyConfirmAnswered(); setActiveFolderId(newName); }
    setFolderMenuOpen(false);
  };

  const handleDeleteFolder = async () => {
    if (!deleteFolderModal) return;
    // The modal only ever targets the ACTIVE being (see where it is opened), so
    // this always lands the reader somewhere else. Its own confirm modal is
    // about losing the being's files; this one is about losing the current turn.
    if (!confirmActionIfBusy()) return;
    await fetch(`/api/folders?name=${encodeURIComponent(deleteFolderModal)}`, { method: 'DELETE' });
    setDeleteFolderModal(null);
    fetchFolders();
    fetchLogs();
    markBusyConfirmAnswered();
    setActiveFolderId(folders[0]?.id || null);
  };

  return (
    <>
    {/* Mobile only: the drawer's backdrop. Also the primary way to dismiss —
        a tap anywhere on the conversation closes the list. */}
    {isMobile && (
      <div
        aria-hidden
        onClick={() => setSidebarOpen(false)}
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity duration-200 ${
          sidebarOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      />
    )}
    {/* On mobile this panel is a drawer: taken out of the flex row entirely
        (position:fixed), so the conversation gets the whole screen and the
        list is summoned instead of permanently renting 70% of a phone's
        width. Desktop is unchanged — same column, same width. */}
    <div
      className={
        isMobile
          ? `fixed inset-y-0 left-0 z-50 w-[86%] max-w-[340px] flex flex-col bg-background border-r border-border shadow-2xl transition-transform duration-200 will-change-transform ${
              sidebarOpen ? 'translate-x-0' : '-translate-x-full'
            }`
          : 'w-64 sm:w-72 h-full flex flex-col bg-secondary/30 backdrop-blur-xl border-r border-border shadow-2xl z-10 transition-colors'
      }
    >
      <div className="p-4 flex items-center justify-between">
        <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent">Nexus</h1>
        <div className="flex items-center">
          {isMobile && (
            <button
              onClick={() => setSidebarOpen(false)}
              title={t('layout.closeSidebar')}
              aria-label={t('layout.closeSidebar')}
              className="p-2 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-all"
            >
              <X size={20} />
            </button>
          )}
          {onOpenGuide && (
            <button
              onClick={onOpenGuide}
              title={t('guide.open')}
              aria-label={t('guide.open')}
              className="p-2 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-all"
            >
              <HelpCircle size={20} />
            </button>
          )}
          <button
            onClick={onOpenSettings}
            title={t('settings.title')}
            aria-label={t('settings.title')}
            className="p-2 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-all"
          >
            <Settings size={20} />
          </button>
        </div>
      </div>

      <div className="px-4 pb-2 space-y-3 relative">
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block">{t('sidebar.identities')}</label>
          <button onClick={createFolder} className="text-muted-foreground hover:text-indigo-500 transition-colors" title={t('sidebar.newFolder')}>
            <UserRoundPlus size={16} />
          </button>
        </div>
        
        <div className="flex gap-2 items-center">
          <IdentityDropdown
            folders={folders}
            activeFolderId={activeFolderId}
            onSelect={setActiveFolderId}
          />
          
          {activeFolder && (
            <div className="relative shrink-0">
              <button 
                onClick={(e) => { e.stopPropagation(); setFolderMenuOpen(!folderMenuOpen); }}
                className="p-2 bg-background border border-border rounded-lg hover:border-indigo-400 text-muted-foreground hover:text-foreground transition-all"
              >
                <MoreVertical size={16} />
              </button>

              {folderMenuOpen && (
                <div className="absolute right-0 top-full mt-1 w-56 max-w-[calc(100vw-2rem)] bg-card border border-border shadow-xl rounded-lg py-1 z-50 overflow-hidden">
                  <button 
                    onClick={handleRenameFolder}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Edit2 size={14} /> {t('sidebar.menu.rename')}
                  </button>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      setCustomCss(activeFolder.settings?.customCss || '');
                      // Load this entity's TTS pronunciation dictionary file.
                      setTtsDict(''); setTtsDictError(null);
                      fetch(`/api/tts-dict?folder=${encodeURIComponent(activeFolder.name)}`)
                        .then(r => r.json()).then(d => setTtsDict(d.content || '')).catch(() => {});
                      setFolderVoice(activeFolder.settings?.aiVoice || { engine: 0, char_idx: 0, style_idx: 0 });
                      setFolderVoicePitch(activeFolder.settings?.voicePitch ?? 0.0);
                      // Load context-management settings with the same
                      // defaults the old global Preferences screen used —
                      // folders that pre-date this move just see those
                      // defaults until the user touches the inputs.
                      //
                      // `maxConversationLog` deliberately does NOT fall back to
                      // the retired `maxRecommendedContext`. That key capped a
                      // different quantity (system prompt + messages) against a
                      // different reference (an assumed context window), so its
                      // stored numbers were chosen for a question nobody is
                      // asking here. Inheriting them would hand every being a
                      // cap it was never given — quietly, and looking exactly
                      // like a value someone picked.
                      setFolderMaxConversationLog(activeFolder.settings?.maxConversationLog ?? DEFAULT_MAX_CONVERSATION_LOG);
                      setFolderAutoTrim(activeFolder.settings?.autoTrimCopiedMessages !== false);
                      setFolderMaxTokensPerLayer(activeFolder.settings?.maxTokensPerLayer ?? 8000);
                      // Live Session voice — known prebuilt names use preset mode; anything else is custom
                      const lv = activeFolder.settings?.liveSessionVoice || 'Aoede';
                      const knownPresets = [
                        'Aoede','Kore','Leda','Zephyr','Achernar','Autonoe','Callirhoe','Despina','Erinome','Gacrux','Laomedeia','Pulcherrima','Sulafat','Vindemiatrix',
                        'Puck','Charon','Fenrir','Orus','Achird','Algenib','Algieba','Alnilam','Enceladus','Iapetus','Rasalgethi','Sadachbia','Sadaltager','Schedar','Umbriel','Zubenelgenubi',
                      ];
                      if (knownPresets.includes(lv)) {
                        setLiveVoiceMode('preset'); setLiveSessionVoice(lv); setLiveCustomVoice('');
                      } else {
                        setLiveVoiceMode('custom'); setLiveCustomVoice(lv); setLiveSessionVoice('Aoede');
                      }
                      setThemeModalOpen(true);
                      setFolderMenuOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Settings2 size={14} /> {t('sidebar.menu.folderSettings')}
                  </button>
                  {/* "Auto-Import .md" used to be here. It called the SAME
                      function as "Import Markdown log(s)" below — its handler
                      was literally `handleAutoImport(e)` with one extra line —
                      and only differed in accepting ".md,.txt" instead of
                      ".md,.markdown,.txt". Two entries, one behaviour, and the
                      narrower one on top: removed 2026-10-23. */}
                  {/* "Import NEXUS log(s) — .json" used to sit above the item
                      below. It read NEXUS's OWN log format, which existed to
                      carry conversations between the original JSX artifact and
                      NEXUS; OAuth removed that round-trip. Removed 2026-10-27
                      together with "Export as JSON", its other half. */}
                  {/* Moved here from the row under "New conversation", where it
                      was an always-visible button eating sidebar width. Same
                      ref, same handler — only the entry point changed. */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setFolderMenuOpen(false);
                      importMdRef.current?.click();
                    }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Upload size={14} /> {t('sidebar.import.md')}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSort('desc');
                    }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ArrowDown size={14} /> {t('sidebar.menu.sortDesc')}
                  </button>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSort('asc');
                    }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ArrowUp size={14} /> {t('sidebar.menu.sortAsc')}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      fetchBackups();
                      setBackupsModalOpen(true);
                      setFolderMenuOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <History size={14} /> {t('sidebar.menu.backups')}
                  </button>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteFolderModal(activeFolder.name);
                      setFolderMenuOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-red-500/10 flex items-center gap-2 text-red-500 hover:text-red-600 transition-colors"
                  >
                    <Trash2 size={14} /> {t('sidebar.menu.delete')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* The two import buttons that used to sit here (JSON / MD) moved into
          the being's "…" menu above. They were costing a permanent slice of
          this panel's width on every screen to expose two rarely-used actions;
          the menu already holds the other once-in-a-while folder operations.
          The hidden file inputs stay here — the menu items click them. */}
      <div className="px-4 py-3 flex gap-2">
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={onNewChat}
          className="flex-1 flex items-center justify-center gap-2 bg-primary text-primary-foreground py-2.5 rounded-lg shadow-md hover:shadow-lg transition-all font-medium text-sm"
        >
          <PlusCircle size={18} />
          {t('sidebar.newChat')}
        </motion.button>
        {/* `.json` is accepted here for DeepSeek conversations, which need the
            dialect, the split planner and the first-original marker. A NEXUS
            log is refused by name rather than by a silent failure — see the
            guard in handleAutoImport. */}
        <input type="file" multiple accept=".md,.markdown,.txt,.json" className="hidden" ref={importMdRef} onChange={handleImportMd} />
      </div>

      {orphanSummaries.length > 0 && (
        <div className="mx-4 mb-2 px-3 py-2 rounded-lg border border-amber-500/40 bg-amber-500/10 text-[11px] leading-snug">
          <div className="font-semibold text-amber-600 dark:text-amber-400">
            {t('sidebar.orphanSummaries.title').replace('{count}', String(orphanSummaries.length))}
          </div>
          <div className="mt-1 font-mono break-all text-muted-foreground">
            {orphanSummaries.slice(0, 5).join(', ')}
            {orphanSummaries.length > 5 && ` +${orphanSummaries.length - 5}`}
          </div>
          <div className="mt-1 text-muted-foreground">{t('sidebar.orphanSummaries.body')}</div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 pb-4 space-y-1 custom-scrollbar">
        <AnimatePresence>
          {filteredConvos.map((convo) => (
            <motion.div
              key={convo.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className={`group relative flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer transition-all ${
                currentConvoId === convo.id
                  ? 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 font-medium'
                  : 'hover:bg-muted/60 text-muted-foreground hover:text-foreground'
              } ${draggedId === convo.id ? 'opacity-50' : ''} ${dragOverId === convo.id ? 'border-t-2 border-indigo-500' : ''}`}
              onClick={() => selectConvo(convo.id)}
              onMouseEnter={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                // Clamp so a row near the bottom of a tall window doesn't push
                // the popup off-screen.
                const top = Math.min(r.top, Math.max(8, window.innerHeight - 280));
                setHoveredConvo({ id: convo.id, top, left: r.right + 8 });
              }}
              onMouseLeave={() => setHoveredConvo((cur) => (cur?.id === convo.id ? null : cur))}
              // Drag is disabled while this row is in rename mode — otherwise
              // selecting text inside the input would start a drag-and-drop
              // operation and make it impossible to highlight characters.
              draggable={renamingId !== convo.id}
              onDragStart={() => handleDragStart(convo.id)}
              onDragOver={(e) => handleDragOver(e, convo.id)}
              onDragEnd={handleDragEnd}
              onDrop={(e) => handleDrop(e, convo.id)}
            >
              <div className="flex items-center gap-3 overflow-hidden w-full">
                <MessageSquare size={16} className={`shrink-0 ${currentConvoId === convo.id ? 'text-indigo-500' : ''}`} />
                {renamingId === convo.id ? (
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        onRenameChat(convo.id, renameValue);
                        setRenamingId(null);
                      } else if (e.key === 'Escape') {
                        setRenamingId(null);
                      }
                    }}
                    autoFocus
                    onBlur={() => {
                      onRenameChat(convo.id, renameValue);
                      setRenamingId(null);
                    }}
                    className="bg-background border border-indigo-500 rounded px-1.5 py-0.5 text-sm w-full outline-none text-foreground"
                  />
                ) : (
                  <span className={`truncate text-sm ${convo.active === false ? 'opacity-40 italic' : ''}`}>
                    {convo.title}
                    {convo.active === false && <span className="ml-1 text-[10px] uppercase tracking-wide">{t('sidebar.inactive')}</span>}
                  </span>
                )}
              </div>

              {!renamingId && (
                <div className="relative shrink-0">
                  <button 
                    onClick={(e) => { 
                      e.stopPropagation(); 
                      setMenuOpenId(menuOpenId === convo.id ? null : convo.id); 
                    }}
                    className={`p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground transition-all ${
                      globalSettings?.alwaysShowHoverControls === true
                        ? 'opacity-100'
                        : 'opacity-0 group-hover:opacity-100 no-hover:opacity-100'
                    }`}
                  >
                    <MoreVertical size={14} />
                  </button>

                  {menuOpenId === convo.id && (
                    <div className="absolute right-0 top-full mt-1 w-36 bg-card border border-border shadow-xl rounded-lg py-1 z-50 overflow-hidden">
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          setRenameValue(convo.title);
                          setRenamingId(convo.id);
                          setMenuOpenId(null);
                        }}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <Pencil size={14} /> {t('sidebar.menu.rename')}
                      </button>
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          onCloneChat(convo.id);
                          setMenuOpenId(null);
                        }}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <Copy size={14} /> {t('sidebar.menu.clone')}
                      </button>
                      {onToggleActive && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onToggleActive(convo.id);
                            setMenuOpenId(null);
                          }}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                        >
                          {convo.active === false
                            ? <><Eye size={14} /> {t('sidebar.menu.markActive')}</>
                            : <><EyeOff size={14} /> {t('sidebar.menu.markInactive')}</>}
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteModalId(convo.id);
                          setMenuOpenId(null);
                        }}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-red-500/10 flex items-center gap-2 text-red-500 hover:text-red-600 transition-colors"
                      >
                        <Trash2 size={14} /> {t('sidebar.menu.delete')}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>
        {filteredConvos.length === 0 && conversationsLoading && (
          // Skeleton placeholders during the initial /api/logs fetch. A few
          // pulsing bars at varying widths so the sidebar visibly indicates
          // work in progress without committing to a real spinner.
          <div className="mt-2 px-2 space-y-2">
            {[88, 72, 92, 64, 80].map((w, i) => (
              <div
                key={i}
                className="h-9 rounded-lg bg-muted/40 animate-pulse"
                style={{ width: `${w}%` }}
              />
            ))}
            <div className="text-center pt-2 text-[11px] text-muted-foreground italic">
              {t('sidebar.loading')}
            </div>
          </div>
        )}
        {/* "No conversations in X" needs an X. With no entity selected — the
            bare-root landing, see lib/rootLanding.ts — the fallback rendered
            "this being has no conversations", which states something about a
            being nobody picked. The main pane already says what to do here, so
            this says nothing. */}
        {filteredConvos.length === 0 && !conversationsLoading && activeFolder && (
          <div className="text-center mt-10 text-xs text-muted-foreground italic px-4">
            {t('sidebar.noHistory').replace('{folder}', activeFolder.name)}
          </div>
        )}
      </div>

      {/* Mobile only: where ChatArea portals the being-camera. On a phone the
          camera cannot have its own column — there is no width to give it —
          so it rides below the conversation list instead, where it competes
          with nothing. Height follows the asset; width is this panel's width.
          Renders nothing at all when the camera is off (ChatArea portals
          nothing), so an empty strip never appears. */}
      {isMobile && (
        <div
          ref={setCameraSlot}
          className="shrink-0 w-full max-h-[45%] overflow-hidden flex items-center justify-center empty:hidden"
        />
      )}

      {/* Conversation summary preview, hover-only.
          Rendered here — OUTSIDE the animated rows and outside the scroll
          container — for two reasons. The list is overflow-y-auto, which
          computes overflow-x to auto as well, so anything sticking out to the
          right of a row would be clipped. And each row is a framer-motion
          div: a transformed ancestor becomes the containing block for
          position:fixed, so a popup nested inside one would be anchored to
          the row instead of the viewport the moment an animation ran.
          pointer-events-none keeps it from stealing hover from the row. */}
      {(() => {
        if (!hoveredConvo || renamingId || draggedId) return null;
        const convo = filteredConvos.find((c: any) => c.id === hoveredConvo.id);
        if (!convo) return null;
        const preview = previewForConvo(convo.title);
        if (!preview) return null;
        return (
          <div
            style={{ position: 'fixed', top: hoveredConvo.top, left: hoveredConvo.left }}
            className="z-[90] w-80 max-h-64 overflow-hidden pointer-events-none rounded-lg border border-border bg-card shadow-2xl p-3"
          >
            <div className="text-[10px] uppercase tracking-wider text-indigo-500 font-semibold mb-1 truncate">
              {convo.title}
            </div>
            <div className="text-xs leading-relaxed text-foreground whitespace-pre-wrap break-words">
              {preview}
            </div>
          </div>
        );
      })()}

      {/* Delete Modal */}
      {deleteModalId && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="bg-card border border-border shadow-2xl rounded-xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-bold mb-2 text-foreground">{t('sidebar.deleteConvo.title')}</h3>
            <p className="text-sm text-muted-foreground mb-6 leading-relaxed">{t('sidebar.deleteConvo.body')}</p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteModalId(null)}
                className="px-4 py-2 text-sm font-medium hover:bg-muted text-foreground rounded-lg transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => {
                  onDeleteChat(deleteModalId);
                  setDeleteModalId(null);
                }}
                className="px-4 py-2 text-sm font-medium bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors shadow-sm"
              >
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Folder Delete Modal */}
      {deleteFolderModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="bg-card border border-border shadow-2xl rounded-xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-bold mb-2 text-foreground">{t('sidebar.deleteFolder.title')}</h3>
            <p className="text-sm text-muted-foreground mb-6 leading-relaxed">
              {t('sidebar.deleteFolder.bodyBefore')}<strong>{deleteFolderModal}</strong>{t('sidebar.deleteFolder.bodyAfter')}
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteFolderModal(null)}
                className="px-4 py-2 text-sm font-medium hover:bg-muted text-foreground rounded-lg transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleDeleteFolder}
                className="px-4 py-2 text-sm font-medium bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors shadow-sm"
              >
                {t('sidebar.deleteFolder.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Folder Theme Modal */}
      {themeModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="bg-card border border-border shadow-2xl rounded-xl p-6 max-w-lg w-full mx-4 flex flex-col max-h-[80vh]">
            <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
              <Settings2 size={20} className="text-indigo-500" /> {t('folder.title')}
            </h3>
            
            <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 space-y-4">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-semibold text-foreground">{t('folder.css.label')}</label>
                  <label className="cursor-pointer text-xs flex items-center gap-1 text-indigo-500 hover:text-indigo-400">
                    <Upload size={14} /> {t('folder.css.load')}
                    <input
                      type="file"
                      accept=".css"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        const reader = new FileReader();
                        reader.onload = (event) => setCustomCss(event.target?.result as string);
                        reader.readAsText(file);
                        e.target.value = '';
                      }}
                    />
                  </label>
                </div>
                <textarea
                  value={customCss}
                  onChange={(e) => setCustomCss(e.target.value)}
                  placeholder={t('folder.css.placeholder')}
                  className="w-full h-48 p-3 bg-background border border-border rounded-lg font-mono text-xs focus:ring-2 focus:ring-indigo-500/50 resize-none custom-scrollbar"
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  <Tx k="folder.css.help" />
                </p>
              </div>
              
              <div className="pt-4 border-t border-border mt-4">
                <h4 className="text-sm font-semibold flex items-center gap-2 text-indigo-500 mb-4 block">
                  <Mic size={16} /> {t('folder.voice.heading')}
                </h4>
                <VoiceSelector
                  value={folderVoice}
                  onChange={setFolderVoice}
                />
                <div className="mt-3">
                  <label className="text-xs font-medium text-muted-foreground block mb-1">
                    {t('folder.voice.pitch')} ({folderVoicePitch >= 0 ? '+' : ''}{folderVoicePitch.toFixed(2)})
                  </label>
                  <input
                    type="range"
                    min="-0.5"
                    max="0.5"
                    step="0.01"
                    value={folderVoicePitch}
                    onChange={(e) => setFolderVoicePitch(parseFloat(e.target.value))}
                    className="w-full"
                  />
                  <div className="flex justify-between text-[10px] text-muted-foreground mt-0.5">
                    <span>{t('folder.voice.lower')}</span>
                    <span>{t('folder.voice.default')}</span>
                    <span>{t('folder.voice.higher')}</span>
                  </div>
                </div>

                <div className="mt-4">
                  <label className="text-xs font-medium text-muted-foreground block mb-1">
                    {t('folder.dict.label')}
                  </label>
                  <textarea
                    value={ttsDict}
                    onChange={(e) => { setTtsDict(e.target.value); if (ttsDictError) setTtsDictError(null); }}
                    placeholder={t('folder.dict.placeholder')}
                    className="w-full h-32 p-3 bg-background border border-border rounded-lg font-mono text-xs focus:ring-2 focus:ring-indigo-500/50 resize-none custom-scrollbar"
                  />
                  {ttsDictError
                    ? <p className="text-[10px] text-red-500 mt-1">{ttsDictError}</p>
                    : <p className="text-[10px] text-muted-foreground mt-1"><Tx k="folder.dict.help" /></p>}
                </div>
              </div>

              {/* Context Management — moved here from global Preferences so
                  each entity can have its own context budget, auto-trim
                  policy, and identity-layer threshold. */}
              <div className="pt-4 border-t border-border mt-4">
                <h4 className="text-sm font-semibold flex items-center gap-2 text-indigo-500 mb-4 block">
                  <Settings2 size={16} /> {t('folder.context.heading')}
                </h4>
                <div className="space-y-4">
                  <div>
                    <div className="flex items-baseline justify-between mb-1">
                      <label className="text-xs font-medium text-muted-foreground">
                        {t('folder.logcap.label')}
                      </label>
                      <span className="text-xs font-mono text-indigo-500">
                        {(folderMaxConversationLog || 0).toLocaleString()} {t('folder.context.tokens')}
                      </span>
                    </div>
                    {/* Edited in units of 10k tokens: 1 → 10k, 100 → 1M. A number
                        field replaced the slider because the useful range now spans
                        two orders of magnitude (the 1M window measured 2026-09-21),
                        and dragging cannot land on a specific value inside it.
                        `Math.round` here is DISPLAY only — a stored value that isn't
                        a multiple of 10k keeps its exact bytes until this field is
                        actually edited, so merely opening the panel never rewrites it. */}
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        min={LOG_CAP_MIN_UNITS}
                        max={LOG_CAP_MAX_UNITS}
                        step={1}
                        value={Math.round((folderMaxConversationLog || DEFAULT_MAX_CONVERSATION_LOG) / LOG_CAP_UNIT)}
                        onChange={(e) => setFolderMaxConversationLog(clampLogCapUnits(parseInt(e.target.value, 10)) * LOG_CAP_UNIT)}
                        className="w-24 p-2 bg-background border border-border rounded-lg text-sm font-mono"
                      />
                      <span className="text-[10px] text-muted-foreground">{t('folder.logcap.units')}</span>
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1">
                      <Tx k="folder.logcap.help" />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer text-sm">
                    <input
                      type="checkbox"
                      checked={folderAutoTrim}
                      onChange={(e) => setFolderAutoTrim(e.target.checked)}
                      className="accent-indigo-500"
                    />
                    <span>{t('folder.context.autoTrim')}</span>
                  </label>
                  <div className="text-[10px] text-muted-foreground -mt-2 leading-relaxed">
                    <Tx k="folder.context.autoTrim.help" />
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t border-border mt-4">
                <h4 className="text-sm font-semibold flex items-center gap-2 text-indigo-500 mb-4 block">
                  <Mic size={16} /> {t('folder.live.heading')}
                </h4>
                <select
                  value={liveVoiceMode === 'custom' ? '__custom__' : liveSessionVoice}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === '__custom__') setLiveVoiceMode('custom');
                    else { setLiveVoiceMode('preset'); setLiveSessionVoice(v); }
                  }}
                  className="w-full p-2 bg-background border border-border rounded-lg text-sm"
                >
                  <optgroup label={t('folder.live.feminine')}>
                    {['Aoede','Kore','Leda','Zephyr','Achernar','Autonoe','Callirhoe','Despina','Erinome','Gacrux','Laomedeia','Pulcherrima','Sulafat','Vindemiatrix'].map(v => <option key={v} value={v}>{v}</option>)}
                  </optgroup>
                  <optgroup label={t('folder.live.masculine')}>
                    {['Puck','Charon','Fenrir','Orus','Achird','Algenib','Algieba','Alnilam','Enceladus','Iapetus','Rasalgethi','Sadachbia','Sadaltager','Schedar','Umbriel','Zubenelgenubi'].map(v => <option key={v} value={v}>{v}</option>)}
                  </optgroup>
                  <option value="__custom__">{t('folder.live.custom')}</option>
                </select>
                {liveVoiceMode === 'custom' && (
                  <input
                    type="text"
                    value={liveCustomVoice}
                    onChange={(e) => setLiveCustomVoice(e.target.value)}
                    placeholder={t('folder.live.customPlaceholder')}
                    className="mt-2 w-full p-2 bg-background border border-border rounded-lg text-sm"
                  />
                )}
                <div className="text-[10px] text-muted-foreground mt-2 leading-relaxed">
                  {t('folder.live.help')}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-border shrink-0">
              <button 
                onClick={() => setThemeModalOpen(false)}
                className="px-4 py-2 text-sm font-medium hover:bg-muted text-foreground rounded-lg transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button 
                onClick={async () => {
                  if (activeFolder) {
                    // Validate + persist the per-entity TTS pronunciation dict
                    // first. A malformed dict blocks the save (and keeps the
                    // modal open) so it can't silently fail.
                    const dictText = ttsDict.trim();
                    if (dictText) {
                      try {
                        const o = JSON.parse(dictText);
                        if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error();
                      } catch {
                        setTtsDictError(t('folder.dict.error'));
                        return;
                      }
                    }
                    setTtsDictError(null);
                    await fetch('/api/tts-dict', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ folder: activeFolder.name, content: ttsDict }),
                    }).catch(() => {});
                    // Drop the retired `maxRecommendedContext` on the way out.
                    // `saveFolder` writes the settings object WHOLE (no deep
                    // merge), so omitting the key here is what actually removes
                    // it from beings/<name>/settings.json — and only when the
                    // person pressed Save on this folder, never as a sweep
                    // across other beings' data.
                    const { maxRecommendedContext: _retiredContextCap, ...keptFolderSettings } =
                      (activeFolder.settings || {}) as Record<string, any>;
                    void _retiredContextCap;
                    await fetch('/api/folders', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        name: activeFolder.name,
                        settings: {
                          ...keptFolderSettings,
                          customCss,
                          aiVoice: folderVoice,
                          voicePitch: folderVoicePitch,
                          maxConversationLog: folderMaxConversationLog,
                          autoTrimCopiedMessages: folderAutoTrim,
                          maxTokensPerLayer: folderMaxTokensPerLayer,
                          liveSessionVoice: liveVoiceMode === 'custom' ? liveCustomVoice.trim() : liveSessionVoice,
                        }
                      })
                    });
                    fetchFolders();
                  }
                  setThemeModalOpen(false);
                }} 
                className="px-6 py-2 text-sm font-medium bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg transition-colors shadow-sm"
              >
                {t('folder.saveSettings')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Backups Modal */}
      {backupsModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-card w-full max-w-2xl rounded-2xl shadow-2xl overflow-hidden border border-border flex flex-col max-h-[80vh]"
          >
            <div className="px-6 py-4 border-b border-border flex justify-between items-center bg-secondary/30">
              <h2 className="text-xl font-semibold flex items-center gap-2">
                <History className="text-indigo-500" /> {t('backups.title')}
              </h2>
              <button onClick={() => setBackupsModalOpen(false)} className="text-muted-foreground hover:text-foreground p-1">✕</button>
            </div>
            <div className="p-6 overflow-y-auto custom-scrollbar flex-1">
              {fetchingBackups ? (
                <div className="text-center text-muted-foreground py-8">{t('backups.loading')}</div>
              ) : backups.length === 0 ? (
                <div className="text-center text-muted-foreground py-8">{t('backups.none')}</div>
              ) : (
                <div className="space-y-3">
                  {backups.map((b, i) => (
                    <div key={i} className="flex items-center justify-between p-3 bg-muted/30 border border-border rounded-lg hover:bg-muted/50 transition-colors">
                      <div>
                        <div className="font-medium text-foreground">{b.title}</div>
                        <div className="text-xs text-muted-foreground flex gap-3 mt-1">
                          <span>{t('backups.date')} {b.date}</span>
                          <span>{t('backups.saved')} {new Date(b.timestamp).toLocaleString()}</span>
                        </div>
                      </div>
                      <button 
                        onClick={() => handleRestoreBackup(b.backupFile)}
                        className="px-3 py-1.5 bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500 hover:text-white rounded-md text-sm font-medium transition-colors border border-indigo-500/20 hover:border-indigo-500"
                      >
                        {t('backups.restore')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}

    </div>
    </>
  );
}
