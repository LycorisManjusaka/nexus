"use client";

import React, { useState, useEffect, useRef } from 'react';
import Sidebar from '@/components/Sidebar';
import ChatArea from '@/components/ChatArea';
import SettingsModal from '@/components/SettingsModal';
import { UserGuidePane, UserGuideModal } from '@/components/UserGuide';
import { v4 as uuidv4 } from 'uuid';
import { DeepLink, orderFolderConversations, buildDeepLink } from '@/lib/deepLink';
import { nextConversationTitle } from '@/lib/convoNaming';
// NexusApp itself renders the provider, so it sits ABOVE the context and must
// use the plain t(key, language) form. Every component below it uses useT().
import { LanguageProvider, t as translate } from '@/lib/i18n';

// ── Per-tab navigation state ────────────────────────────────────────────────
// Which folder/conversation a tab is viewing must be PER-TAB, not shared. Using
// localStorage made every tab fight over one value: opening entity Y in a second
// tab overwrote the shared "last folder", so when the first tab (e.g. with the
// System Prompt Updater open) reloaded, it jumped to entity Y and lost its work.
//
// sessionStorage is isolated per browser tab and survives reloads within that
// tab — exactly what we want. We still mirror to localStorage so a brand-new tab
// or a fresh browser launch (empty sessionStorage) lands on the last-used entity
// instead of the very first folder. Read prefers sessionStorage (this tab's own
// view) and only falls back to localStorage when this tab has no value yet.
function navGet(key: string): string | null {
  try {
    const s = sessionStorage.getItem(key);
    if (s !== null) return s;
    return localStorage.getItem(key);
  } catch { return null; }
}
function navSet(key: string, value: string) {
  try { sessionStorage.setItem(key, value); localStorage.setItem(key, value); } catch {}
}

// First-run language default: a fresh install has never saved a language
// choice anywhere, so there's nothing to respect yet — read the browser/OS
// locale once and pick the closer default. Any machine whose language tag
// (or any of its ranked alternates) starts with "ja" gets Japanese; every
// other locale gets English, since English is the language the rest of the
// project's content (agents, docs) is authored in first. This only ever
// runs when no saved settings exist yet — an explicit prior choice, even a
// blank/unset one that was still saved, is never overridden by this.
function detectSystemLanguage(): 'en' | 'ja' {
  try {
    const candidates = (typeof navigator !== 'undefined' && navigator.languages && navigator.languages.length)
      ? navigator.languages
      : [typeof navigator !== 'undefined' ? navigator.language : ''];
    return candidates.some((l) => (l || '').toLowerCase().startsWith('ja')) ? 'ja' : 'en';
  } catch {
    return 'en';
  }
}

export default function NexusApp({ deepLink = null }: { deepLink?: DeepLink | null }) {
  // A deep link must beat this tab's remembered folder/conversation, but only
  // for the first selection after load — afterwards the tab navigates normally.
  // Held in a ref (not state) so consuming it can't trigger a re-render race
  // with the selection effect that reads it.
  const pendingLinkRef = useRef<DeepLink | null>(deepLink);
  const [pendingScrollMessageId, setPendingScrollMessageId] = useState<string | null>(
    deepLink?.messageId || null
  );
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);

  const [conversations, setConversations] = useState<any[]>([]);
  // Tracks the initial /api/logs fetch so the sidebar can show a skeleton
  // placeholder instead of the "No history" empty-state during cold-start.
  // Flips to false on the first response (success or failure).
  const [conversationsLoading, setConversationsLoading] = useState(true);
  const [currentConvoId, setCurrentConvoId] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isGuideOpen, setIsGuideOpen] = useState(false);
  // NOTE: maxRecommendedContext, autoTrimCopiedMessages, and
  // maxTokensPerLayer were moved out of globalSettings into per-folder
  // settings (Folder Settings → Context Management). Old user_settings.json
  // files that still have those keys are loaded harmlessly — nothing reads
  // them from here anymore.
  const [globalSettings, setGlobalSettings] = useState<any>({
    userName: 'Anonymous',
    theme: 'dark',
  });

  const [folders, setFolders] = useState<any[]>([]);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);

  // Load basic data
  useEffect(() => {
    const savedGlobal = localStorage.getItem('nexus_globalSettings');
    if (savedGlobal) {
      try {
        const parsed = JSON.parse(savedGlobal);
        // 'language' key genuinely absent (older save, or a save from before
        // this field existed) — same first-run treatment as no save at all.
        if (!parsed.language) parsed.language = detectSystemLanguage();
        setGlobalSettings(parsed);
      } catch (e) { }
    } else {
      // Nothing saved on this machine yet — detect once from the browser/OS.
      setGlobalSettings((prev: any) => ({ ...prev, language: detectSystemLanguage() }));
    }
    fetchFolders();
    fetchLogs();
  }, []);

  useEffect(() => {
    localStorage.setItem('nexus_globalSettings', JSON.stringify(globalSettings));
  }, [globalSettings]);

  const fetchFolders = async () => {
    try {
      const res = await fetch('/api/folders');
      if (res.ok) {
        const data = await res.json();
        setFolders(data);
        // A deep link names its folder, and that wins over this tab's saved one.
        const linked = pendingLinkRef.current
          ? data.find((f: any) => f.name === pendingLinkRef.current!.folderName)
          : null;
        if (pendingLinkRef.current && !linked) {
          setDeepLinkError(`No entity named "${pendingLinkRef.current.folderName}".`);
          pendingLinkRef.current = null;
          setPendingScrollMessageId(null);
        }
        const savedFolder = navGet('nexus_lastFolderId');
        if (linked) {
          setActiveFolderId(linked.id);
        } else if (savedFolder && data.find((f: any) => f.id === savedFolder)) {
          setActiveFolderId(savedFolder);
        } else if (data.length > 0) {
          setActiveFolderId(data[0].id);
        }
      }
    } catch (e) { }
  };

  const fetchLogs = async () => {
    try {
      const res = await fetch('/api/logs');
      if (res.ok) {
        const data = await res.json();
        setConversations(data);
      }
    } catch (e) { }
    finally {
      // Flip the skeleton off in both success and failure paths so the
      // sidebar lands on either real data or the "No history" empty state.
      setConversationsLoading(false);
    }
  };

  useEffect(() => {
    if (activeFolderId) {
      navSet('nexus_lastFolderId', activeFolderId);

      const activeFolder = folders.find(f => f.id === activeFolderId);
      if (activeFolder) {
        // ── Deep link, consumed once ──────────────────────────────────────
        // Runs BEFORE the normal restore below, otherwise the saved
        // conversation would be selected first and the link would appear to
        // do nothing. Waits for the conversation list: on a cold load this
        // effect fires with `conversations` still empty.
        const link = pendingLinkRef.current;
        if (link && link.folderName === activeFolder.name) {
          if (conversationsLoading) return;      // list not in yet — try again on the next run
          const folderConvos = conversations.filter(c => c.folderName === activeFolder.name);
          if (link.convoId) {
            const target = folderConvos.find(c => c.id === link.convoId);
            if (target) {
              setCurrentConvoId(target.id);
            } else {
              setDeepLinkError(`That conversation is not in "${activeFolder.name}" (it may have been deleted or moved).`);
              setPendingScrollMessageId(null);
            }
          } else {
            // `/c/<folder>` with no id → the row sitting at the top of the
            // sidebar, using the sidebar's own ordering.
            const top = orderFolderConversations(folderConvos, activeFolder?.settings?.convoOrder || [])[0];
            if (top) setCurrentConvoId(top.id);
            else setDeepLinkError(`"${activeFolder.name}" has no conversations yet.`);
          }
          pendingLinkRef.current = null;
          return;
        }

        const current = conversations.find(c => c.id === currentConvoId);
        // Only auto-reselect a conversation when (a) nothing is selected, or
        // (b) the selected one belongs to a DIFFERENT folder than the active
        // one. Crucially we do NOT reselect when `currentConvoId` is set but
        // momentarily absent from `conversations` (a transient refetch, or a
        // brand-new unsaved chat) — clobbering it there would remount ChatArea
        // and throw away whatever the user is doing (e.g. the open System
        // Prompt Updater).
        const needsReselect =
          currentConvoId === null ||
          (!!current && current.folderName !== activeFolder.name);
        if (needsReselect) {
          const folderConvos = conversations.filter(c => c.folderName === activeFolder.name);
          // On reload, restore THIS tab's exact conversation if it's still in
          // the active folder (sessionStorage is per-tab); otherwise fall back
          // to the most-recently-updated conversation.
          const savedConvoId = navGet('nexus_lastConvoId');
          const saved = savedConvoId ? folderConvos.find(c => c.id === savedConvoId) : undefined;
          if (saved) {
            setCurrentConvoId(saved.id);
          } else if (folderConvos.length > 0) {
            const latest = folderConvos.sort((a, b) => b.updatedAt - a.updatedAt)[0];
            setCurrentConvoId(latest.id);
          } else {
            setCurrentConvoId(null);
          }
        }
      }
    }
  }, [activeFolderId, folders, conversations, currentConvoId, conversationsLoading]);

  useEffect(() => {
    if (currentConvoId) {
      navSet('nexus_lastConvoId', currentConvoId);
    }
  }, [currentConvoId]);

  const activeFolder = folders.find(f => f.id === activeFolderId);

  // ── Keep the address bar on the visible conversation ─────────────────────
  // history.replaceState, deliberately, for two reasons:
  //
  //  1. It adds NO history entry. pushState would mean that after clicking
  //     through twenty conversations the Back button has to be pressed twenty
  //     times to leave Nexus — sidebar clicks are not "navigation" in the sense
  //     the Back button is about.
  //  2. It does not notify the Next.js router. Using router.push/replace here
  //     would re-run the /c/[...parts] server route, hand NexusApp a fresh
  //     `deepLink` prop, and re-trigger the selection logic against state that
  //     is already correct — a loop fighting itself.
  //
  // The URL stays copy-paste-able and reload-able at all times.
  const urlSyncSkipRef = useRef<boolean>(!!deepLink);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!currentConvoId || !activeFolder) return;
    // The first selection after arriving via a link IS that link — the URL is
    // already right, and rewriting it here would strip a /m/<messageId> anchor
    // before the user could copy or re-share it.
    if (urlSyncSkipRef.current) { urlSyncSkipRef.current = false; return; }
    const next = buildDeepLink(activeFolder.name, currentConvoId);
    if (window.location.pathname !== next) {
      window.history.replaceState(null, '', next);
    }
  }, [currentConvoId, activeFolder]);

  const createNewChat = () => {
    if (!activeFolder) return;
    const newId = uuidv4();
    // `<identity>_<n>` — n is one past the highest number already in use here.
    const title = nextConversationTitle(
      activeFolder.name,
      conversations.filter(c => c.folderName === activeFolder.name).map(c => c.title)
    );
    setCurrentConvoId(newId);
    setConversations([{
      id: newId,
      title,
      updatedAt: Date.now(),
      folderName: activeFolder.name,
      aiName: activeFolder.settings?.aiName || 'Claude',
      specificModel: activeFolder.settings?.specificModel
    }, ...conversations]);

    // Pin to top of the sidebar ordering. Without this, `orderFolderConversations`
    // keeps every previously-ordered conversation ahead of the new one (it has
    // no index in convoOrder), so a freshly created chat lands at the BOTTOM.
    const existingOrder: string[] = activeFolder.settings?.convoOrder ||
      conversations.filter(c => c.folderName === activeFolder.name).map(c => c.id);
    const newOrder = [newId, ...existingOrder.filter(oid => oid !== newId)];
    fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: activeFolder.name, settings: { ...activeFolder.settings, convoOrder: newOrder } }),
    }).then(() => fetchFolders()).catch(() => {});
  };

  const deleteChat = async (id: string) => {
    try {
      await fetch(`/api/logs/${id}`, { method: 'DELETE' });
      const newConvos = conversations.filter(c => c.id !== id);
      setConversations(newConvos);
      if (currentConvoId === id) {
        setCurrentConvoId(newConvos.length > 0 ? newConvos[0].id : null);
      }
    } catch (e) { }
  };

  // Build a clone title using the " copy(<N>)" suffix convention.
  //   - "Hello"           → "Hello copy(1)"
  //   - "Hello copy(1)"   → "Hello copy(2)"   (recognizes its own suffix)
  //   - "Hello copy(2)"   → "Hello copy(3)"   ...etc
  //   - On collision with another title in the same folder, advance until
  //     we find a free number.
  //
  // Previously this used a CJK "＃<full-width number>" suffix that was
  // intended for character-conversation continuations (managed now by the
  // System Prompt Updater); the user asked the sidebar's Clone action to
  // use a plain English copy-suffix instead.
  const buildCloneTitle = (sourceTitle: string, folderName: string): string => {
    const folderTitles = new Set(
      conversations.filter(c => c.folderName === folderName).map(c => c.title)
    );
    // If the title already ends with " copy(N)", strip it and resume from
    // N+1 — avoids accumulating " copy(1) copy(1) copy(1)" chains.
    const m = sourceTitle.match(/^(.*?)\s+copy\((\d+)\)\s*$/);
    const base = m
      ? m[1].replace(/\s+$/, '')
      : sourceTitle.replace(/\s+$/, '');
    let n = m ? parseInt(m[2], 10) + 1 : 1;
    let candidate = `${base} copy(${n})`;
    while (folderTitles.has(candidate)) {
      n++;
      candidate = `${base} copy(${n})`;
    }
    return candidate;
  };

  const renameChat = async (id: string, newTitle: string) => {
    // Optimistic — update sidebar list immediately. The user shouldn't have
    // to wait for the disk write to see their new title.
    setConversations(prev => prev.map(c => c.id === id ? { ...c, title: newTitle } : c));
    try {
      const res = await fetch(`/api/logs/${id}`);
      if (!res.ok) return;
      const data = await res.json();
      data.title = newTitle;
      await fetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, logData: data }),
      });
      // Reconcile in the background (in case the server normalized anything)
      fetchLogs();
    } catch (e) {
      console.error('rename failed:', e);
      fetchLogs(); // roll back to whatever the server actually has
    }
  };

  // Toggle a conversation's "active" flag. Inactive conversations are hidden
  // from the summaries Layer-4 index AND refused by the read_conversation tool
  // (the user designates these "non-public" — the AI must not see them).
  // Missing flag means active; we persist the explicit boolean either way.
  const toggleChatActive = async (id: string) => {
    const current = conversations.find(c => c.id === id);
    const next = !(current?.active !== false); // currently-active → false; inactive → true
    // Optimistic sidebar update.
    setConversations(prev => prev.map(c => c.id === id ? { ...c, active: next } : c));
    try {
      const res = await fetch(`/api/logs/${id}`);
      if (!res.ok) { fetchLogs(); return; }
      const data = await res.json();
      data.active = next;
      await fetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, logData: data }),
      });
      fetchLogs();
    } catch (e) {
      console.error('toggle active failed:', e);
      fetchLogs();
    }
  };

  // One-time migration: normalize every conversation title in a folder from
  // the legacy "<base>＃<full-width index>" form to the canonical
  // "<base>_<index>" (half-width) used by the System Prompt Updater, layer
  // files and summary files. Invoked from the folder "…" menu.
  const normalizeFolderNames = async (folderName: string) => {
    const fwToHw = (s: string) =>
      s.replace(/[０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
    const toRename = conversations
      .filter(c => c.folderName === folderName)
      .map(c => {
        const m = String(c.title || '').match(/^(.*?)\s*[_#＃]([0-9０-９]+)\s*$/);
        if (!m) return null;
        const base = m[1].replace(/\s+$/, '');
        const idx = parseInt(fwToHw(m[2]), 10);
        if (isNaN(idx)) return null;
        const next = `${base}_${idx}`;
        return next === c.title ? null : { id: c.id as string, next };
      })
      .filter(Boolean) as Array<{ id: string; next: string }>;
    if (toRename.length === 0) return;
    // Optimistic sidebar update.
    const map = new Map(toRename.map(t => [t.id, t.next]));
    setConversations(prev => prev.map(c => map.has(c.id) ? { ...c, title: map.get(c.id)! } : c));
    // Persist sequentially — each rename loads + rewrites the full log file.
    for (const t of toRename) {
      try {
        const res = await fetch(`/api/logs/${t.id}`);
        if (!res.ok) continue;
        const data = await res.json();
        data.title = t.next;
        await fetch('/api/logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: t.id, logData: data }),
        });
      } catch (e) {
        console.error('normalize rename failed for', t.id, e);
      }
    }
    fetchLogs();
  };

  // Like cloneChat but installs a brand-new system prompt on the clone and
  // bumps the title's "＃<N>" suffix to a caller-specified index (so it
  // matches the layers file we just wrote at <folder>/<folder>_<N>.md).
  // Used by the System Prompt Updater modal — see SystemPromptUpdater.tsx.
  const cloneChatWithSystemPrompt = async ({
    sourceId, newSystemPrompt, newIndex,
  }: { sourceId: string; newSystemPrompt: string; newIndex: number }) => {
    const res = await fetch(`/api/logs/${sourceId}`);
    if (!res.ok) return;
    const data = await res.json();

    const newId = uuidv4();
    data.id = newId;
    data.systemPrompt = newSystemPrompt;

    // Force the title to "<base>_<newIndex>" (half-width), matching the layer
    // file naming "<base>_<newIndex>.md". We strip any existing trailing index
    // suffix (legacy "＃<full-width>" or "#"/"_" + digits) first, then append.
    const oldTitle: string = data.title || 'Untitled';
    const base = oldTitle.replace(/\s*[_#＃][0-9０-９]+\s*$/, '');
    data.title = `${base}_${newIndex}`;

    // Treat the entire cloned history as carry-over context. The new
    // "firstOriginalIsNext" flag is consumed by ChatArea.handleSend when
    // the user types their next message — that new message becomes the
    // actual first-original marker. This replaces the older approach of
    // marking the LAST source-conversation message as the boundary, which
    // wrongly classified the last assistant turn as 'original' even though
    // it came straight from the previous conversation.
    data.firstOriginalMessageId = null;
    data.firstOriginalIsNext = true;

    // Persist FIRST, switch SECOND. The optimistic-then-POST pattern from the
    // regular cloneChat races: ChatArea's load-by-convoId useEffect fires the
    // moment currentConvoId changes, and if the log file isn't on disk yet it
    // 404s and renders "New Conversation" with empty state. The user has to
    // reload the page to see their cloned conversation populate. Awaiting the
    // POST before the switch closes that window.
    try {
      await fetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: newId, logData: data }),
      });
    } catch (e) {
      console.error('clone-with-system-prompt POST failed:', e);
      return;
    }

    const optimistic = {
      id: newId,
      folderName: data.folderName,
      title: data.title,
      aiName: data.aiName,
      updatedAt: Date.now(),
    };
    setConversations(prev => [optimistic, ...prev]);
    setCurrentConvoId(newId);

    // Background reconcile — fetchLogs gets the canonical log list from disk,
    // fetchFolders refreshes the convoOrder we set below.
    try {
      const folder = folders.find(f => f.name === data.folderName);
      if (folder) {
        const existingOrder: string[] = folder.settings?.convoOrder ||
          conversations.filter(c => c.folderName === folder.name).map((c: any) => c.id);
        const newOrder = [newId, ...existingOrder.filter(oid => oid !== newId)];
        await fetch('/api/folders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: folder.name, settings: { ...folder.settings, convoOrder: newOrder } }),
        });
        fetchFolders();
      }
      fetchLogs();
    } catch (e) {
      console.error('clone-with-system-prompt reconcile failed:', e);
      fetchLogs();
    }
  };

  const cloneChat = async (id: string) => {
    const res = await fetch(`/api/logs/${id}`);
    if (!res.ok) return;
    const data = await res.json();

    const newId = uuidv4();
    data.id = newId;
    data.title = buildCloneTitle(data.title || 'Untitled', data.folderName || 'Default');

    // A plain clone is a copy, not a fresh start: the first-original marker is
    // carried over unchanged along with everything else. Only the System Prompt
    // Updater's "go to next conversation" path (cloneChatWithSystemPrompt)
    // re-arms the marker, because there the history really is carry-over.

    // Optimistic — insert the new entry at the top of the sidebar immediately.
    const optimistic = {
      id: newId,
      folderName: data.folderName,
      title: data.title,
      aiName: data.aiName,
      updatedAt: Date.now(),
    };
    setConversations(prev => [optimistic, ...prev]);
    setCurrentConvoId(newId);

    try {
      await fetch('/api/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: newId, logData: data }),
      });

      // Pin to top of folder ordering
      const folder = folders.find(f => f.name === data.folderName);
      if (folder) {
        const existingOrder: string[] = folder.settings?.convoOrder ||
          conversations.filter(c => c.folderName === folder.name).map((c: any) => c.id);
        const newOrder = [newId, ...existingOrder.filter(oid => oid !== newId)];
        fetch('/api/folders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: folder.name, settings: { ...folder.settings, convoOrder: newOrder } }),
        }).then(() => fetchFolders()).catch(() => {});
      }
      // Background reconcile
      fetchLogs();
    } catch (e) {
      console.error('clone failed:', e);
      fetchLogs();
    }
  };

  // Apply the active folder's theme.
  //
  // A folder's theme is ENTIRELY its local_data/themes/<name>.css file (loaded
  // into settings.customCss by the API). There is no named-theme list anymore:
  //   • if the folder has a CSS file → inject it (it sets :root variables that
  //     override the dark base), and
  //   • if it has none → the plain `dark` base IS the theme.
  // The dark base is always applied so any variables a theme file doesn't set
  // fall back to sensible dark values.
  useEffect(() => {
    document.documentElement.className = 'dark';

    let styleTag = document.getElementById('folder-custom-css');
    if (!styleTag) {
      styleTag = document.createElement('style');
      styleTag.id = 'folder-custom-css';
      document.head.appendChild(styleTag);
    }
    styleTag.innerHTML = activeFolder?.settings?.customCss || '';
  }, [activeFolder]);

  return (
    <LanguageProvider language={globalSettings.language}>
    <div className="flex h-screen bg-background text-foreground overflow-hidden font-sans">
      {/* A link that couldn't be followed says so instead of silently landing
          on some other conversation. Dismissible; never auto-clears. */}
      {deepLinkError && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[200] px-4 py-2 rounded-lg border border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300 text-xs flex items-center gap-3 shadow-lg">
          <span>{deepLinkError}</span>
          <button
            onClick={() => setDeepLinkError(null)}
            className="opacity-60 hover:opacity-100 font-semibold"
            aria-label="Dismiss"
          >✕</button>
        </div>
      )}
      <Sidebar
        conversations={conversations}
        conversationsLoading={conversationsLoading}
        currentConvoId={currentConvoId}
        onSelectConvo={setCurrentConvoId}
        onNewChat={createNewChat}
        onDeleteChat={deleteChat}
        onRenameChat={renameChat}
        onCloneChat={cloneChat}
        onToggleActive={toggleChatActive}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenGuide={() => setIsGuideOpen(true)}
        folders={folders}
        setFolders={setFolders}
        activeFolderId={activeFolderId}
        setActiveFolderId={setActiveFolderId}
        fetchFolders={fetchFolders}
        fetchLogs={fetchLogs}
        setConversations={setConversations}
      />

      <main className="flex-1 flex flex-col relative min-w-0">
        {currentConvoId && activeFolder && (!conversations.find(c => c.id === currentConvoId) || conversations.find(c => c.id === currentConvoId)?.folderName === activeFolder.name) ? (
          <ChatArea
            key={currentConvoId}
            convoId={currentConvoId}
            // Consumed once by ChatArea after its messages render, then cleared
            // so a later manual scroll isn't yanked back.
            scrollToMessageId={pendingScrollMessageId}
            onScrolledToMessage={(found: boolean) => {
              if (!found) setDeepLinkError('That message is not in this conversation — it may have been deleted.');
              setPendingScrollMessageId(null);
            }}
            folderName={activeFolder.name}
            aiName={activeFolder.settings?.aiName || 'Claude'}
            userName={globalSettings.userName}
            defaultSystemPrompt={activeFolder.settings?.systemPrompt !== undefined ? activeFolder.settings.systemPrompt : ''}
            defaultAttachmentInstruction={activeFolder.settings?.attachmentInstruction !== undefined ? activeFolder.settings.attachmentInstruction : "Note: your partner's chat client automatically injects the contents of attached text files into their messages using <attached_file name=\"filename\">...</attached_file> XML tags. When you see these tags, treat the contents as the actual attached file."}
            defaultModelParams={activeFolder.settings?.modelParams || { temperature: 0.7, topP: 0.95, topK: 40, thinkingLevel: 'medium' }}
            defaultSpecificModel={activeFolder.settings?.specificModel}
            defaultCustomAiName={activeFolder.settings?.customAiName || ''}
            defaultDateTimeVisibility={activeFolder.settings?.dateTimeVisibility || 'all'}
            defaultVrchatMode={activeFolder.settings?.vrchatMode || false}
            defaultVrchatRule={activeFolder.settings?.vrchatRule || "[RULE: 添付した画像を文脈に、単純な画像解説は禁止/あなたはバーチャル世界の存在として隣で振る舞う事/英字禁止(外来語はカタカナ)／出力の長さは入力に合わせること／長文禁止]"}
            defaultAiVoice={activeFolder.settings?.aiVoice}
            defaultLiveSessionVoice={activeFolder.settings?.liveSessionVoice || 'Aoede'}
            globalSettings={globalSettings}
            folders={folders}
            onUpdateTitle={fetchLogs}
            // The name this conversation was created with. It only matters
            // before the first save: with no log on disk, ChatArea would
            // otherwise fall back to "New Conversation" and the title the
            // sidebar is showing would not be the one that gets written.
            plannedTitle={conversations.find(c => c.id === currentConvoId)?.title}
            fetchFolders={fetchFolders}
            onCloneWithSystemPrompt={cloneChatWithSystemPrompt}
          />
        ) : (
          // Empty state. The old "Welcome to NEXUS + New Chat" panel was a dead
          // end for a first-time reader: with no identity yet, New Chat has
          // nothing to attach a conversation to. The guide is what someone
          // standing here actually needs, so it IS the empty state.
          //
          // The New Chat button is kept only when an identity already exists —
          // then this is a returning user who just has nothing selected.
          <div className="flex-1 min-h-0 flex flex-col">
            {activeFolder && (
              <div className="shrink-0 px-8 pt-6 flex justify-end">
                <button
                  onClick={createNewChat}
                  className="px-6 py-2 bg-primary text-primary-foreground rounded-full font-medium hover:opacity-90 transition-opacity"
                >
                  {translate('app.welcome.newChat', globalSettings.language)}
                </button>
              </div>
            )}
            <UserGuidePane language={globalSettings.language} />
          </div>
        )}
      </main>

      {isSettingsOpen && (
        <SettingsModal
          onClose={() => setIsSettingsOpen(false)}
          globalSettings={globalSettings}
          setGlobalSettings={setGlobalSettings}
        />
      )}

      {isGuideOpen && (
        <UserGuideModal
          language={globalSettings.language}
          onClose={() => setIsGuideOpen(false)}
        />
      )}
    </div>
    </LanguageProvider>
  );
}
