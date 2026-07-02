"use client";

import React, { useState, useEffect, useRef } from 'react';
import { PlusCircle, MessageSquare, Settings, Trash2, Folder, MoreVertical, Copy, Pencil, FolderPlus, Edit2, Palette, Upload, Settings2, Mic, History, ArrowDown, ArrowUp, Eye, EyeOff, Hash } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import VoiceSelector from './VoiceSelector';
import { parseMarkdown } from '@/lib/markdownLogic';
import { v4 as uuidv4 } from 'uuid';

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
  onNormalizeNames?: (folderName: string) => void;
  onOpenSettings: () => void;

  folders: any[];
  setFolders?: React.Dispatch<React.SetStateAction<any[]>>;
  activeFolderId: string | null;
  setActiveFolderId: (id: string) => void;
  fetchFolders: () => void;
  fetchLogs: () => void;
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
  onNormalizeNames,
  onOpenSettings,
  folders,
  setFolders,
  activeFolderId,
  setActiveFolderId,
  fetchFolders,
  fetchLogs
}: SidebarProps) {
  const activeFolder = folders.find(f => f.id === activeFolderId);
  const convoOrder = activeFolder?.settings?.convoOrder || [];
  
  const filteredConvos = [...conversations].filter(c => c.folderName === activeFolder?.name).sort((a, b) => {
    const indexA = convoOrder.indexOf(a.id);
    const indexB = convoOrder.indexOf(b.id);
    if (indexA !== -1 && indexB !== -1) return indexA - indexB;
    if (indexA !== -1) return -1;
    if (indexB !== -1) return 1;
    return b.updatedAt - a.updatedAt;
  });

  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

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
  // characters often want bigger windows than throwaway conversations).
  const [folderMaxRecommendedContext, setFolderMaxRecommendedContext] = useState<number>(60000);
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
    try {
      const res = await fetch('/api/backups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderName: activeFolder.name, backupFile })
      });
      const data = await res.json();
      if (data.success && data.newConvoId) {
        fetchLogs();
        onSelectConvo(data.newConvoId);
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const importMdRef = useRef<HTMLInputElement>(null);
  const importJsonRef = useRef<HTMLInputElement>(null);

  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !activeFolder) return;
    const filesArray = Array.from(files);

    // Process sequentially so the convoOrder update at the end sees all new
    // IDs at once, and so the "open the first imported file" UX is
    // deterministic regardless of how slow each POST is.
    (async () => {
      const newIds: string[] = [];
      for (const file of filesArray) {
        try {
          const text = await file.text();
          const data = JSON.parse(text);
          if (!data || !Array.isArray(data.messages)) {
            alert(`"${file.name}" is not a valid Nexus log JSON.`);
            continue;
          }
          const convoId = uuidv4();
          const logData = {
            ...data,
            id: convoId,
            folderName: activeFolder.name,
            aiName: data.aiName || activeFolder.name,
            title: data.title || file.name.replace(/\.json$/i, ''),
            updatedAt: Date.now(),
          };
          await fetch('/api/logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: convoId, logData }),
          });
          newIds.push(convoId);
        } catch (err: any) {
          alert(`Failed to import "${file.name}": ${err.message}`);
        }
      }
      if (newIds.length === 0) return;

      // Pin the new conversations to the TOP of the folder's convoOrder.
      // Without this, the sidebar's sort puts un-ordered convos AFTER any
      // ordered ones — which made fresh imports appear at the bottom.
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
      // Auto-open the FIRST imported file (= the topmost after prepend).
      onSelectConvo(newIds[0]);
    })();

    if (importJsonRef.current) importJsonRef.current.value = '';
  };

  const handleImportMd = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleAutoImport(e);
    if (importMdRef.current) importMdRef.current.value = '';
  };

  const handleAutoImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !activeFolder) return;

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

    // Same sequential pattern as handleImportJson — race-free convoOrder
    // update and deterministic "open the first imported file" UX.
    (async () => {
      const newIds: string[] = [];
      // Fetch the registered speaker names from character_map.json once. Only
      // these names (plus the entity/assistant name and the built-in "User")
      // are allowed to start a new message when parsing "## X" headers — any
      // other "## ..." line is kept as body text. If the fetch fails we pass an
      // empty list, so only the entity + "User" headers are recognized.
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
      for (const file of filesArray) {
        try {
          const text = await file.text();
          const title = file.name.replace(/\.[^/.]+$/, "");
          const parsed = parseMarkdown(text, activeFolder.name, validUserNames);
          if (parsed.length === 0) continue;

          // Compute tokens for every imported message — parseMarkdown produces
          // tokens:0 since it doesn't know which model is in use. Without this
          // the imported conversation shows blank token counts until each
          // message is manually edited.
          const modelName = activeFolder.settings?.aiName || activeFolder.name || 'Claude';
          await Promise.all(parsed.map(async (m) => {
            try {
              const r = await fetch('/api/tokens', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: m.content || '', model: modelName }),
              });
              if (r.ok) {
                const d = await r.json();
                const t = d.tokens || 0;
                m.tokens = t;
                m.textTokens = t;
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
                title,
                messages: parsed,
                aiName: activeFolder.name,
                updatedAt: Date.now(),
              },
            }),
          });
          newIds.push(convoId);
        } catch (err: any) {
          alert(`Failed to import "${file.name}": ${err?.message || err}`);
        }
      }
      if (newIds.length === 0) return;

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
      onSelectConvo(newIds[0]);
    })();

    if (fileInputRef.current) fileInputRef.current.value = '';
    setFolderMenuOpen(false);
  };

  const createFolder = async () => {
    const name = prompt('Enter new folder (AI Character) name:');
    if (!name) return;
    await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, settings: { aiName: 'Claude' } })
    });
    fetchFolders();
    fetchLogs();
  };

  const handleRenameFolder = async () => {
    if (!activeFolder) return;
    const oldName = activeFolder.name;
    const newName = prompt('Enter new folder name:', oldName);
    if (!newName || newName === oldName) return;
    await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rename', oldName, newName })
    });
    fetchFolders();
    fetchLogs();
    setFolderMenuOpen(false);
  };

  const handleDeleteFolder = async () => {
    if (!deleteFolderModal) return;
    await fetch(`/api/folders?name=${encodeURIComponent(deleteFolderModal)}`, { method: 'DELETE' });
    setDeleteFolderModal(null);
    fetchFolders();
    fetchLogs();
    setActiveFolderId(folders[0]?.id || null);
  };

  return (
    <div className="w-64 sm:w-72 h-full flex flex-col bg-secondary/30 backdrop-blur-xl border-r border-border shadow-2xl z-10 transition-colors">
      <div className="p-4 flex items-center justify-between">
        <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-indigo-500 bg-clip-text text-transparent">Nexus</h1>
        <button 
          onClick={onOpenSettings}
          className="p-2 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-all"
        >
          <Settings size={20} />
        </button>
      </div>

      <div className="px-4 pb-2 space-y-3 relative">
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider block">AI Characters</label>
          <button onClick={createFolder} className="text-muted-foreground hover:text-indigo-500 transition-colors" title="New Folder">
            <FolderPlus size={16} />
          </button>
        </div>
        
        <div className="flex gap-2 items-center">
          <div className="relative flex-1">
            <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none text-muted-foreground">
              <Folder size={16} />
            </div>
            <select 
              value={activeFolderId || ''}
              onChange={(e) => setActiveFolderId(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 transition-all"
            >
              {folders.map(f => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </div>
          
          {activeFolder && (
            <div className="relative shrink-0">
              <button 
                onClick={(e) => { e.stopPropagation(); setFolderMenuOpen(!folderMenuOpen); }}
                className="p-2 bg-background border border-border rounded-lg hover:border-indigo-400 text-muted-foreground hover:text-foreground transition-all"
              >
                <MoreVertical size={16} />
              </button>

              {folderMenuOpen && (
                <div className="absolute right-0 top-full mt-1 w-36 bg-card border border-border shadow-xl rounded-lg py-1 z-50 overflow-hidden">
                  <button 
                    onClick={handleRenameFolder}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Edit2 size={14} /> Rename
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
                      setFolderMaxRecommendedContext(activeFolder.settings?.maxRecommendedContext ?? 60000);
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
                    <Settings2 size={14} /> Folder Settings
                  </button>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      fileInputRef.current?.click();
                    }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Upload size={14} /> Auto-Import .md
                  </button>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSort('desc');
                    }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ArrowDown size={14} /> Sort Descending
                  </button>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSort('asc');
                    }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ArrowUp size={14} /> Sort Ascending
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (activeFolder && onNormalizeNames) onNormalizeNames(activeFolder.name);
                      setFolderMenuOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Hash size={14} /> Normalize Names (＃→_)
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
                    <History size={14} /> Backups
                  </button>
                  <button 
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteFolderModal(activeFolder.name);
                      setFolderMenuOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-red-500/10 flex items-center gap-2 text-red-500 hover:text-red-600 transition-colors"
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="px-4 py-3 flex gap-2">
        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.98 }}
          onClick={onNewChat}
          className="flex-1 flex items-center justify-center gap-2 bg-primary text-primary-foreground py-2.5 rounded-lg shadow-md hover:shadow-lg transition-all font-medium text-sm"
        >
          <PlusCircle size={18} />
          New Chat
        </motion.button>
        <button
          onClick={() => importJsonRef.current?.click()}
          className="px-2.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors text-[10px] font-bold tracking-wider"
          title="Import JSON log(s)"
        >
          JSON
        </button>
        <button
          onClick={() => importMdRef.current?.click()}
          className="px-2.5 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors text-[10px] font-bold tracking-wider"
          title="Import Markdown log(s)"
        >
          MD
        </button>
        <input type="file" multiple accept=".json" className="hidden" ref={importJsonRef} onChange={handleImportJson} />
        <input type="file" multiple accept=".md,.markdown,.txt" className="hidden" ref={importMdRef} onChange={handleImportMd} />
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-4 space-y-1 custom-scrollbar">
        <AnimatePresence>
          {filteredConvos.map((convo) => (
            <motion.div
              key={convo.id}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className={`group flex items-center justify-between px-3 py-2.5 rounded-lg cursor-pointer transition-all ${
                currentConvoId === convo.id 
                  ? 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 font-medium' 
                  : 'hover:bg-muted/60 text-muted-foreground hover:text-foreground'
              } ${draggedId === convo.id ? 'opacity-50' : ''} ${dragOverId === convo.id ? 'border-t-2 border-indigo-500' : ''}`}
              onClick={() => onSelectConvo(convo.id)}
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
                    {convo.active === false && <span className="ml-1 text-[10px] uppercase tracking-wide">(inactive)</span>}
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
                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground transition-all"
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
                        <Pencil size={14} /> Rename
                      </button>
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          onCloneChat(convo.id);
                          setMenuOpenId(null);
                        }}
                        className="w-full text-left px-3 py-2 text-sm hover:bg-muted flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
                      >
                        <Copy size={14} /> Clone
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
                            ? <><Eye size={14} /> Mark active</>
                            : <><EyeOff size={14} /> Mark inactive</>}
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
                        <Trash2 size={14} /> Delete
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
              Loading conversations…
            </div>
          </div>
        )}
        {filteredConvos.length === 0 && !conversationsLoading && (
          <div className="text-center mt-10 text-xs text-muted-foreground italic px-4">
            No history in {activeFolder?.name || 'this folder'}.
          </div>
        )}
      </div>

      {/* Delete Modal */}
      {deleteModalId && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="bg-card border border-border shadow-2xl rounded-xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-bold mb-2 text-foreground">Delete Conversation?</h3>
            <p className="text-sm text-muted-foreground mb-6 leading-relaxed">Are you sure you want to delete this conversation? This action cannot be undone.</p>
            <div className="flex justify-end gap-3">
              <button 
                onClick={() => setDeleteModalId(null)} 
                className="px-4 py-2 text-sm font-medium hover:bg-muted text-foreground rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={() => {
                  onDeleteChat(deleteModalId);
                  setDeleteModalId(null);
                }} 
                className="px-4 py-2 text-sm font-medium bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors shadow-sm"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Folder Delete Modal */}
      {deleteFolderModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="bg-card border border-border shadow-2xl rounded-xl p-6 max-w-sm w-full mx-4">
            <h3 className="text-lg font-bold mb-2 text-foreground">Delete Folder?</h3>
            <p className="text-sm text-muted-foreground mb-6 leading-relaxed">
              Are you sure you want to delete the folder <strong>{deleteFolderModal}</strong> and ALL conversations inside it? This action cannot be undone.
            </p>
            <div className="flex justify-end gap-3">
              <button 
                onClick={() => setDeleteFolderModal(null)} 
                className="px-4 py-2 text-sm font-medium hover:bg-muted text-foreground rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleDeleteFolder} 
                className="px-4 py-2 text-sm font-medium bg-red-500 hover:bg-red-600 text-white rounded-lg transition-colors shadow-sm"
              >
                Delete Folder
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
              <Settings2 size={20} className="text-indigo-500" /> Folder Settings
            </h3>
            
            <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 space-y-4">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-sm font-semibold text-foreground">CSS Theme (this folder)</label>
                  <label className="cursor-pointer text-xs flex items-center gap-1 text-indigo-500 hover:text-indigo-400">
                    <Upload size={14} /> Load File
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
                  placeholder={`Define this folder's theme by overriding the dark base, e.g.:\n\n:root {\n  --background: #0b0f1a;\n  --foreground: #e6edf3;\n  --primary: #00e5ff;\n}\n\nSaved to local_data/themes/<folder>.css. Empty = plain Dark.`}
                  className="w-full h-48 p-3 bg-background border border-border rounded-lg font-mono text-xs focus:ring-2 focus:ring-indigo-500/50 resize-none custom-scrollbar"
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  This folder's theme is its <span className="font-mono">local_data/themes/&lt;folder&gt;.css</span> file. No file = Dark.
                </p>
              </div>
              
              <div className="pt-4 border-t border-border mt-4">
                <h4 className="text-sm font-semibold flex items-center gap-2 text-indigo-500 mb-4 block">
                  <Mic size={16} /> Character TTS Voice
                </h4>
                <VoiceSelector
                  value={folderVoice}
                  onChange={setFolderVoice}
                />
                <div className="mt-3">
                  <label className="text-xs font-medium text-muted-foreground block mb-1">
                    Voice Pitch ({folderVoicePitch >= 0 ? '+' : ''}{folderVoicePitch.toFixed(2)})
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
                    <span>Lower</span>
                    <span>Default (0.00)</span>
                    <span>Higher</span>
                  </div>
                </div>

                <div className="mt-4">
                  <label className="text-xs font-medium text-muted-foreground block mb-1">
                    TTS Pronunciation Dictionary (JSON)
                  </label>
                  <textarea
                    value={ttsDict}
                    onChange={(e) => { setTtsDict(e.target.value); if (ttsDictError) setTtsDictError(null); }}
                    placeholder={`Replace words right before TTS (literal, no spaces needed — good for CJK), e.g.:\n{\n  "GLM": "ジーエルエム",\n  "朔": "さく"\n}`}
                    className="w-full h-32 p-3 bg-background border border-border rounded-lg font-mono text-xs focus:ring-2 focus:ring-indigo-500/50 resize-none custom-scrollbar"
                  />
                  {ttsDictError
                    ? <p className="text-[10px] text-red-500 mt-1">{ttsDictError}</p>
                    : <p className="text-[10px] text-muted-foreground mt-1">Per-entity. Applied just before synthesis. Saved to <span className="font-mono">local_data/tts_dict/&lt;folder&gt;.json</span>. Empty = none.</p>}
                </div>
              </div>

              {/* Context Management — moved here from global Preferences so
                  each entity can have its own context budget, auto-trim
                  policy, and identity-layer threshold. */}
              <div className="pt-4 border-t border-border mt-4">
                <h4 className="text-sm font-semibold flex items-center gap-2 text-indigo-500 mb-4 block">
                  <Settings2 size={16} /> Context Management
                </h4>
                <div className="space-y-4">
                  <div>
                    <label className="text-xs font-medium text-muted-foreground mb-1 block">
                      Maximal recommended context window size (tokens)
                    </label>
                    <input
                      type="number"
                      min={1000}
                      step={1000}
                      value={folderMaxRecommendedContext}
                      onChange={(e) => setFolderMaxRecommendedContext(parseInt(e.target.value) || 60000)}
                      className="w-full px-3 py-2 bg-background border border-border rounded-md text-sm focus:ring-2 focus:ring-indigo-500/50 outline-none"
                    />
                    <div className="text-[10px] text-muted-foreground mt-1">
                      Drives the progress bar in the chat header and (if enabled below) auto-trimming of copied messages.
                    </div>
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer text-sm">
                    <input
                      type="checkbox"
                      checked={folderAutoTrim}
                      onChange={(e) => setFolderAutoTrim(e.target.checked)}
                      className="accent-indigo-500"
                    />
                    <span>Remove old copied messages automatically</span>
                  </label>
                  <div className="text-[10px] text-muted-foreground -mt-2 leading-relaxed">
                    When the <strong>text</strong> context (system + messages, <em>excluding attachments</em>) exceeds the limit,
                    copied messages (those before the <span className="font-mono">first-original</span> marker) are pruned from the
                    top until the limit is satisfied. <strong>Original messages are never deleted</strong>,
                    and <strong>attachment tokens never count toward the limit</strong>.
                  </div>
                </div>
              </div>

              <div className="pt-4 border-t border-border mt-4">
                <h4 className="text-sm font-semibold flex items-center gap-2 text-indigo-500 mb-4 block">
                  <Mic size={16} /> Live Session Voice (Gemini)
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
                  <optgroup label="Feminine">
                    {['Aoede','Kore','Leda','Zephyr','Achernar','Autonoe','Callirhoe','Despina','Erinome','Gacrux','Laomedeia','Pulcherrima','Sulafat','Vindemiatrix'].map(v => <option key={v} value={v}>{v}</option>)}
                  </optgroup>
                  <optgroup label="Masculine">
                    {['Puck','Charon','Fenrir','Orus','Achird','Algenib','Algieba','Alnilam','Enceladus','Iapetus','Rasalgethi','Sadachbia','Sadaltager','Schedar','Umbriel','Zubenelgenubi'].map(v => <option key={v} value={v}>{v}</option>)}
                  </optgroup>
                  <option value="__custom__">Custom (type any voice name…)</option>
                </select>
                {liveVoiceMode === 'custom' && (
                  <input
                    type="text"
                    value={liveCustomVoice}
                    onChange={(e) => setLiveCustomVoice(e.target.value)}
                    placeholder="Voice name (e.g. a new prebuilt name Google added)"
                    className="mt-2 w-full p-2 bg-background border border-border rounded-lg text-sm"
                  />
                )}
                <div className="text-[10px] text-muted-foreground mt-2 leading-relaxed">
                  Used when starting a Live Session for this folder. Voice cloning isn't supported — to shape delivery (slower, calmer, accent, etc.), describe it in the system prompt.
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6 pt-4 border-t border-border shrink-0">
              <button 
                onClick={() => setThemeModalOpen(false)} 
                className="px-4 py-2 text-sm font-medium hover:bg-muted text-foreground rounded-lg transition-colors"
              >
                Cancel
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
                        setTtsDictError('Must be a JSON object like {"from": "to"}.');
                        return;
                      }
                    }
                    setTtsDictError(null);
                    await fetch('/api/tts-dict', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ folder: activeFolder.name, content: ttsDict }),
                    }).catch(() => {});
                    await fetch('/api/folders', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        name: activeFolder.name,
                        settings: {
                          ...activeFolder.settings,
                          customCss,
                          aiVoice: folderVoice,
                          voicePitch: folderVoicePitch,
                          maxRecommendedContext: folderMaxRecommendedContext,
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
                Save Settings
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
                <History className="text-indigo-500" /> Auto-Backups
              </h2>
              <button onClick={() => setBackupsModalOpen(false)} className="text-muted-foreground hover:text-foreground p-1">✕</button>
            </div>
            <div className="p-6 overflow-y-auto custom-scrollbar flex-1">
              {fetchingBackups ? (
                <div className="text-center text-muted-foreground py-8">Loading backups...</div>
              ) : backups.length === 0 ? (
                <div className="text-center text-muted-foreground py-8">No backups found for this folder.</div>
              ) : (
                <div className="space-y-3">
                  {backups.map((b, i) => (
                    <div key={i} className="flex items-center justify-between p-3 bg-muted/30 border border-border rounded-lg hover:bg-muted/50 transition-colors">
                      <div>
                        <div className="font-medium text-foreground">{b.title}</div>
                        <div className="text-xs text-muted-foreground flex gap-3 mt-1">
                          <span>Date: {b.date}</span>
                          <span>Saved: {new Date(b.timestamp).toLocaleString()}</span>
                        </div>
                      </div>
                      <button 
                        onClick={() => handleRestoreBackup(b.backupFile)}
                        className="px-3 py-1.5 bg-indigo-500/10 text-indigo-500 hover:bg-indigo-500 hover:text-white rounded-md text-sm font-medium transition-colors border border-indigo-500/20 hover:border-indigo-500"
                      >
                        Restore Clone
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        </div>
      )}

      {/* Hidden File Input for Auto-Import */}
      <input 
        type="file" 
        multiple 
        accept=".md,.txt" 
        className="hidden" 
        ref={fileInputRef} 
        onChange={handleAutoImport} 
      />
    </div>
  );
}
