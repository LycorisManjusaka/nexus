"use client";

import React, { useState, useRef } from 'react';
import { Send, Paperclip, X, FileText, Image as ImageIcon, Music, Video, File, Square } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { uploadAttachment, dataUrlToBlob } from '@/lib/attachmentUrl';
import { SNIFF_BYTES, TEXT_MAX_BYTES, MEDIA_EXT, looksLikeText } from '@/lib/textSniff';
import { useT } from '@/lib/i18n';

const InputArea = React.forwardRef(function InputArea({ onSend, onStop, isGenerating, disabled, aiName, vrchatMode, globalSettings, convoId }: any, ref: any) {
  const t = useT();
  const [text, setText] = useState('');
  const [userName, setUserName] = useState('');
  // Which VRChat transcript file is being cleared right now ('kohai' | 'ear').
  const [clearing, setClearing] = useState<string | null>(null);

  /**
   * Discard the pending transcript for ONE side.
   *
   * The server backs the file up before truncating, so a mis-click is
   * recoverable from voicechanger/{kohai,ear}_backup/. Also clears the poll
   * baseline so the input box doesn't immediately re-fill from the text that
   * was just discarded.
   */
  const clearVrchatLog = async (which: 'kohai' | 'ear') => {
    setClearing(which);
    try {
      const r = await fetch('/api/vrchat/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(which === 'kohai' ? { clearKohai: true } : { clearEar: true }),
      });
      const d = await r.json();
      if (!d.ok) {
        alert(
          t('input.clearFailed')
            .replace('{file}', which === 'kohai' ? 'kohai.txt' : 'ear_log.txt')
            .replace('{error}', d.error || 'unknown error')
        );
      } else {
        // Refresh the visible transcript NOW rather than waiting for the next
        // poll. The poll deliberately ignores an EMPTY transcript (so it can't
        // wipe something typed by hand while the files are empty) — which meant
        // clearing the last remaining text left it stuck on screen until the
        // next utterance arrived.
        try {
          const g = await fetch('/api/vrchat/logs');
          if (g.ok) setText(((await g.json())?.text || '').trim());
        } catch { /* the next poll will catch up */ }
      }
    } catch (e: any) {
      alert(t('input.clearFailed2').replace('{error}', e.message));
    }
    setClearing(null);
  };
  // Characters from local_data/character_map.json, for the speaker dropdown.
  const [charaList, setCharaList] = useState<{ name: string; engine: string; charId: string }[]>([]);
  const [attachments, setAttachments] = useState<any[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Expose imperative setText/getText so the parent (ChatArea) can drive the
  // input from the live VRChat transcript poll and read it back when sending.
  React.useImperativeHandle(ref, () => ({
    setText: (t: string) => setText(t ?? ''),
    getText: () => text,
  }), [text]);

  // Auto-grow the textarea whenever text changes. Resets to 'auto' first so
  // the element can also shrink (e.g. after send clears the input).
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, [text]);

  React.useEffect(() => {
    // User name comes from the active TTS character (voicechanger/chara_settings.json
    // resolved through local_data/character_map.json). Refresh on mount, every 30s
    // (catches changes made by voice_changer.py externally), and immediately when
    // The selector below dispatches an nx-chara-changed event after a pick, so
    // any other mounted copy of this component resyncs immediately rather than
    // waiting for its next poll. (Preferences used to host a duplicate of this
    // dropdown and fire the same event; that control has been removed.)
    const fetchName = () => {
      fetch('/api/chara/current').then(r => r.json()).then(data => {
        if (data?.name) setUserName(data.name);
      }).catch(() => {});
    };
    fetchName();
    // Populate the speaker dropdown from character_map.json.
    fetch('/api/chara/list').then(r => r.json()).then(d => {
      setCharaList(d?.characters || []);
    }).catch(() => {});
    const id = setInterval(fetchName, 30000);
    const onCharaChanged = (e: any) => {
      // The custom event optionally carries the new name in detail; trust the
      // server response anyway in case multiple sources change the file.
      if (e?.detail?.name) setUserName(e.detail.name);
      fetchName();
    };
    window.addEventListener('nx-chara-changed', onCharaChanged as EventListener);
    return () => {
      clearInterval(id);
      window.removeEventListener('nx-chara-changed', onCharaChanged as EventListener);
    };
  }, []);

  // ── Draft autosave / restore ──────────────────────────────────────────────
  // Persist the in-progress message so a page reload (or crash) doesn't lose it.
  // localStorage only — one small string per conversation, no server/disk cost.
  // Debounced (write 800 ms after typing stops) so we don't thrash on every
  // keystroke; a beforeunload/unmount flush guarantees a draft survives an
  // immediate reload or a conversation switch. Attachments are intentionally NOT
  // saved (base64 blobs would blow the ~5 MB localStorage quota). Disabled in
  // VRChat mode, where the input is a live transcript, not a user draft.
  const draftKey = convoId ? `nexus_draft_${convoId}` : null;
  const draftStateRef = useRef({ text, draftKey, vrchatMode });
  draftStateRef.current = { text, draftKey, vrchatMode };
  const prevDraftKeyRef = useRef<string | null>(null);

  // Write a draft. `allowRemove` clears an emptied draft — used ONLY on the
  // timer-based debounce path. The reload/unmount flush passes allowRemove=false
  // (save-only): React StrictMode does mount→cleanup→mount, and the cleanup runs
  // while `text` is still '' (the restored value hasn't committed), so a
  // remove-on-empty there would wipe the freshly restored draft.
  const writeDraft = (key: string | null, value: string, vr: boolean, allowRemove: boolean) => {
    if (vr || !key) return;
    try {
      if (value.trim()) { localStorage.setItem(key, value); console.debug('[draft] save', key, `${value.length} chars`); }
      else if (allowRemove) { localStorage.removeItem(key); console.debug('[draft] clear', key); }
    } catch (e) { console.debug('[draft] write failed', e); }
  };

  // Restore this conversation's draft when the conversation changes; flush the
  // outgoing one first so nothing typed in the last debounce window is lost.
  React.useEffect(() => {
    const prevKey = prevDraftKeyRef.current;
    if (prevKey && prevKey !== draftKey) {
      // `text` state still holds the OUTGOING conversation's draft at this point
      // (the setText below hasn't run yet this tick). Save-only.
      writeDraft(prevKey, draftStateRef.current.text, draftStateRef.current.vrchatMode, false);
    }
    prevDraftKeyRef.current = draftKey;
    if (vrchatMode) return;
    let saved = '';
    try { if (draftKey) saved = localStorage.getItem(draftKey) || ''; } catch { /* ignore */ }
    console.debug('[draft] restore', { convoId, draftKey, foundChars: saved.length });
    setText(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convoId]);

  // Debounced save 800 ms after typing stops (this path may clear an emptied draft).
  React.useEffect(() => {
    if (vrchatMode || !draftKey) return;
    const t = setTimeout(() => writeDraft(draftKey, text, vrchatMode, true), 800);
    return () => clearTimeout(t);
  }, [text, draftKey, vrchatMode]);

  // Flush on reload/close AND on unmount (covers a conversation switch that
  // remounts this component). SAVE-ONLY — never removes (see writeDraft note).
  React.useEffect(() => {
    const saveOnly = () => {
      const s = draftStateRef.current;
      writeDraft(s.draftKey, s.text, s.vrchatMode, false);
    };
    window.addEventListener('beforeunload', saveOnly);
    return () => {
      window.removeEventListener('beforeunload', saveOnly);
      saveOnly();
    };
  }, []);

  // Switch the active speaker — SAME logic as Preferences → User Identity:
  // writes voicechanger/chara_settings.json via /api/chara/select, then tells
  // the rest of the app to refresh (so this label + Preferences stay in sync).
  const handleCharaSelect = async (newName: string) => {
    if (!newName) return;
    setUserName(newName); // optimistic
    try {
      await fetch('/api/chara/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      window.dispatchEvent(new CustomEvent('nx-chara-changed', { detail: { name: newName } }));
    } catch { /* the 30s poll will reconcile if this fails */ }
  };

  const [isDragging, setIsDragging] = useState(false);

  // Convert PNG to JPEG client-side to stay under Anthropic's 5MB-per-image cap.
  // Also downscales to maxDim so the result reflects what Claude/Gemini actually
  // see (both downsample large images server-side anyway).
  const convertPngToJpeg = async (
    file: File,
    maxDim: number,
    quality = 0.9
  ): Promise<{ dataUrl: string; width: number; height: number; size: number } | null> => {
    if (file.type !== 'image/png') return null;
    const objectUrl = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = objectUrl;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('image load failed'));
        setTimeout(() => reject(new Error('image load timeout')), 5000);
      });

      let w = img.naturalWidth || 1024;
      let h = img.naturalHeight || 1024;
      if (w > maxDim || h > maxDim) {
        const scale = maxDim / Math.max(w, h);
        w = Math.round(w * scale);
        h = Math.round(h * scale);
      }

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      // White background since JPEG has no alpha channel
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);

      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      const b64 = dataUrl.split(',')[1] || '';
      const size = Math.ceil((b64.length * 3) / 4);
      return { dataUrl, width: w, height: h, size };
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  };

  const processFiles = async (files: File[]) => {
    const newAttachments = await Promise.all(files.map(async (file) => {
      // Media detection first — these three have a native modality and must NOT
      // be turned into text. `file.type` is unreliable on Windows for anything
      // uncommon (it is frequently empty), so the extension is a fallback.
      const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
      const isImage = file.type.startsWith('image/') || MEDIA_EXT.image.has(ext);
      const isAudio = file.type.startsWith('audio/') || MEDIA_EXT.audio.has(ext);
      const isVideo = file.type.startsWith('video/') || MEDIA_EXT.video.has(ext);

      // SVG is an image MIME but no provider accepts it as an image, so sending
      // it down the media path guarantees it is dropped. It is markup — read it.
      const isSvg = /^image\/svg/i.test(file.type) || ext === 'svg';

      // ANY non-media file is a text candidate. The old rule was an extension
      // allowlist (txt|md|csv|json|py|js|ts|jsx|tsx|css|html), so a .srt, .log,
      // .yaml, .sql, .ini, .rs, .go — anything not on the list — was classified
      // as binary, pushed to the provider as a media block with a mime it does
      // not accept, and silently dropped. The entity correctly reported that it
      // could not see the file. Sniffing the bytes is the right test: what makes
      // a file readable is its contents, not its name.
      const textCandidate = isSvg || !(isImage || isAudio || isVideo);

      let isText = false;
      let textData = null;
      let dataUrl: string | null = null;
      let tokens = 0;
      let finalName = file.name;
      let finalType = file.type;
      let finalSize = file.size;

      if (textCandidate) {
        // Sniff a prefix rather than reading the whole file: a 500 MB blob must
        // never be decoded just to discover it is binary.
        const probe = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
        if (looksLikeText(probe)) {
          isText = true;
          if (file.size > TEXT_MAX_BYTES) {
            // Injected verbatim into the prompt on EVERY turn, so an unbounded
            // read is a context-window accident waiting to happen. Truncate
            // loudly — a silent cut would look like the model ignoring content.
            const head = await file.slice(0, TEXT_MAX_BYTES).text();
            textData = `${head}\n\n[… truncated by NEXUS: file is ${(file.size / 1048576).toFixed(1)} MB, ` +
              `only the first ${(TEXT_MAX_BYTES / 1048576).toFixed(0)} MB is attached …]`;
          } else {
            textData = await file.text();
          }
        }
        // Genuinely binary: fall through to the payload path. The server turns
        // any non-media payload into an honest one-line descriptor rather than
        // dumping mojibake, so the handling lives in one place and old
        // conversations with an already-attached file get it too.
      }

      if (isText) {
        if (aiName) {
          try {
            const res = await fetch('/api/tokens', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: textData, model: aiName })
            });
            if (res.ok) {
              const data = await res.json();
              tokens = data.tokens || 0;
            }
          } catch(e) {}
        }
      } else {
        const isClaude = aiName?.toLowerCase().includes('claude');

        let imgW = 0, imgH = 0;

        if (isImage) {
          // Try to convert PNG → JPEG. Skip non-PNG (already efficient) and on conversion failure.
          const targetMaxDim = isClaude ? 1568 : 3072;
          const converted = await convertPngToJpeg(file, targetMaxDim, 0.9);
          if (converted) {
            dataUrl = converted.dataUrl;
            imgW = converted.width;
            imgH = converted.height;
            finalName = file.name.replace(/\.png$/i, '.jpg');
            finalType = 'image/jpeg';
            finalSize = converted.size;
          }
        }

        // NOTE: a FileReader used to read EVERY non-converted file into a base64
        // `data:` URL right here. It's gone. Payloads now upload as raw bytes to
        // the content-addressed store, so a 500 MB video no longer becomes a
        // ~680 MB string in the page just to be attached. `dataUrl` is now set
        // only when the canvas conversion above produced one — and that payload
        // is already downscaled, so converting it back to bytes is cheap.

        const objectUrl = URL.createObjectURL(file);

        if (isImage) {
           if (!imgW || !imgH) {
             const img = new Image();
             img.src = objectUrl;
             await new Promise((r) => {
               img.onload = r as any;
               setTimeout(r, 500); // fallback timeout
             });
             imgW = img.width || 1024;
             imgH = img.height || 1024;
           }

           let w = imgW, h = imgH;

           if (isClaude) {
             const maxDim = 1568;
             if (w > maxDim || h > maxDim) {
                 const scale = maxDim / Math.max(w, h);
                 w = w * scale;
                 h = h * scale;
             }
             tokens = Math.ceil((w * h) / 750);
           } else {
             const maxDim = 3072;
             if (w > maxDim || h > maxDim) {
                 const scale = maxDim / Math.max(w, h);
                 w = w * scale;
                 h = h * scale;
             }
             if (w <= 384 && h <= 384) {
                 tokens = 258;
             } else {
                 tokens = Math.ceil(w / 768) * Math.ceil(h / 768) * 258;
             }
           }
        } else if (isAudio || isVideo) {
           const media = document.createElement(isAudio ? 'audio' : 'video');
           media.src = objectUrl;
           await new Promise((r) => {
             media.onloadedmetadata = r;
             setTimeout(r, 500); // fallback timeout
           });
           const duration = media.duration || 0;
           if (isClaude) {
             tokens = Math.ceil(duration * 100) || 1000;
           } else {
             tokens = Math.ceil(duration * (isAudio ? 32 : 263)) || 1000;
           }
        }
        URL.revokeObjectURL(objectUrl);
      }

      // Auto-split oversize videos. OpenAI-compatible providers reject any single
      // inline `data:` URI over 20 MiB; when this common setting is on (default),
      // re-encode at CRF 28 server-side and, if still too big, split into
      // <name>_part1.mp4, … each under the cap. Falls back to the original file
      // on any failure (the send-time preflight will then surface the size error).
      // Threshold is expressed in RAW bytes now that we no longer build a base64
      // string to measure. 15 MiB raw encodes to just over the 20 MiB base64 cap
      // (base64 length = ceil(n/3)*4), so this is the same trigger point as the
      // old `dataUrl.length > 20 MiB` check — just without materializing the
      // string to find out.
      const autoSplit = globalSettings?.autoSplitVideos !== false;
      if (isVideo && autoSplit && file.size > 15 * 1024 * 1024) {
        try {
          const fd = new FormData();
          fd.append('file', file, file.name);
          const res = await fetch('/api/attachments/split-video', { method: 'POST', body: fd });
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.parts) && data.parts.length > 0) {
              const perPartTokens = Math.max(1, Math.ceil((tokens || 1000) / data.parts.length));
              // The split route already wrote each part into the store, so the
              // parts arrive as refs — no payload crosses back to the browser.
              return data.parts.map((p: any) => ({
                id: uuidv4(),
                name: p.name,
                type: p.mimeType || 'video/mp4',
                size: p.size || 0,
                isText: false, isImage: false, isAudio: false, isVideo: true,
                textData: null,
                ref: p.ref,
                tokens: perPartTokens,
                fileObj: null,
              }));
            }
          }
        } catch { /* fall through and return the original, unsplit video */ }
      }

      // Externalize the payload. Text attachments are deliberately excluded:
      // `textData` is small, is injected into the prompt verbatim every turn,
      // and externalizing it would buy a disk read per turn and a fetch per
      // preview in exchange for nothing.
      //
      // Uploading the original File streams the bytes with no conversion at
      // all. The one exception is a canvas-converted PNG→JPEG, which exists
      // only as a data URL — but it's already downscaled, so turning it back
      // into bytes is cheap.
      let ref: string | null = null;
      if (!isText) {
        const payload: Blob | null = dataUrl ? dataUrlToBlob(dataUrl) : file;
        if (payload) {
          const stored = await uploadAttachment(payload, finalType);
          if (stored) {
            ref = stored.ref;
            if (stored.size) finalSize = stored.size;
          }
        }
        // Safety net: the upload failed AND there's no in-page copy (no canvas
        // conversion happened), so read the file inline the way this always
        // used to. Without this, a storage failure would produce an attachment
        // carrying no payload at all.
        if (!ref && !dataUrl) {
          const reader = new FileReader();
          dataUrl = await new Promise((resolve) => {
            reader.onload = (e) => resolve(e.target?.result as string);
            reader.readAsDataURL(file);
          });
        }
      }

      return {
        id: uuidv4(),
        name: finalName,
        type: finalType,
        size: finalSize,
        isText, isImage, isAudio, isVideo,
        textData,
        // Exactly one of these carries the payload. `ref` is the normal case;
        // `dataUrl` is the fallback when the upload failed, so a storage problem
        // degrades to the old inline behavior instead of losing the attachment.
        ...(ref ? { ref } : dataUrl ? { dataUrl } : {}),
        tokens,
        fileObj: file
      };
    }));

    // A video may expand into several parts, so flatten before appending.
    setAttachments(prev => [...prev, ...newAttachments.flat()]);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    await processFiles(Array.from(e.target.files));
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!disabled) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (disabled || !e.dataTransfer.files) return;
    await processFiles(Array.from(e.dataTransfer.files));
  };

  const removeAttachment = (id: string) => {
    setAttachments(attachments.filter(a => a.id !== id));
  };

  const handleSend = () => {
    if (!text.trim() && attachments.length === 0) return;
    let finalText = text;
    const trimmedName = userName.trim();
    // Skip the prefix when the name is empty OR the literal fallback
    // "Anonymous" (or legacy "User") — anonymous/default messages don't need
    // a meaningless tag burning tokens. In VRChat mode the text is already a
    // "[Name] ..." transcript, so don't wrap it in another [userName] tag.
    if (!vrchatMode && trimmedName !== '' && trimmedName !== 'User' && trimmedName !== 'Anonymous') {
      finalText = `[${trimmedName}]\n${text}`.trim();
    }
    onSend(finalText, attachments);
    setText('');
    setAttachments([]);
    // Sent — drop the saved draft so a reload doesn't restore an already-sent message.
    try { if (draftKey) localStorage.removeItem(draftKey); } catch { /* ignore */ }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handlePaste = async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const fileItems = items.filter(item => item.kind === 'file');
    if (fileItems.length === 0) return; // let normal text paste through
    e.preventDefault();
    const files = fileItems
      .map(item => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length > 0) await processFiles(files);
  };

  const getIcon = (att: any) => {
    if (att.isText) return <FileText size={14} className="text-blue-500" />;
    if (att.isImage) return <ImageIcon size={14} className="text-green-500" />;
    if (att.isAudio) return <Music size={14} className="text-yellow-500" />;
    if (att.isVideo) return <Video size={14} className="text-purple-500" />;
    return <File size={14} className="text-gray-500" />;
  };

  return (
    <div 
      className={`bg-card border shadow-xl rounded-2xl overflow-hidden transition-all ${
        isDragging ? 'border-indigo-500 bg-indigo-500/5 ring-4 ring-indigo-500/20 scale-[1.02]' : 'border-border focus-within:ring-2 focus-within:ring-indigo-500/50'
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 p-3 border-b border-border bg-muted/30">
          {attachments.map(att => (
            <div key={att.id} className="flex items-center gap-2 bg-background border border-border rounded-lg px-2 py-1.5 text-xs font-medium shadow-sm">
              {getIcon(att)}
              <span className="max-w-[120px] truncate">{att.name}</span>
              {att.tokens > 0 && <span className="text-muted-foreground bg-muted px-1.5 py-0.5 rounded text-[10px]">{att.tokens} t</span>}
              <button onClick={() => removeAttachment(att.id)} className="ml-1 text-muted-foreground hover:text-red-500">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 p-2">
        <div className="flex flex-col items-center gap-1">
          {/* VRChat-only: drop the pending transcript for one side without
              touching the other. `{clear:true}` (used on send) always truncates
              BOTH files, which is wrong when you only want to discard, say,
              mis-recognized speech of your own. Equivalent to the
              clear_kohai.bat / clear_ear.bat pair, and backed up the same way. */}
          {vrchatMode && (
            <div className="flex flex-col gap-1">
              <button
                onClick={() => clearVrchatLog('kohai')}
                disabled={disabled || !!clearing}
                className="px-2 py-1 text-sm rounded bg-amber-500/15 hover:bg-amber-500/25 disabled:opacity-40 transition-colors leading-none"
                title={t('input.clearKohai')}
              >
                {clearing === 'kohai' ? '…' : '🗣️🗑️'}
              </button>
              <button
                onClick={() => clearVrchatLog('ear')}
                disabled={disabled || !!clearing}
                className="px-2 py-1 text-sm rounded bg-sky-500/15 hover:bg-sky-500/25 disabled:opacity-40 transition-colors leading-none"
                title={t('input.clearEar')}
              >
                {clearing === 'ear' ? '…' : '👂🗑️'}
              </button>
            </div>
          )}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-3 text-muted-foreground hover:text-foreground hover:bg-muted rounded-xl transition-colors"
            disabled={disabled}
          >
            <Paperclip size={20} />
          </button>
        </div>
        <input 
          type="file" 
          multiple 
          className="hidden" 
          ref={fileInputRef} 
          onChange={handleFileChange} 
        />
        <div className="flex-1 flex flex-col">
          <select
            value={userName}
            onChange={(e) => handleCharaSelect(e.target.value)}
            title={t('input.speakerTitle')}
            className="px-2 pt-2 text-xs text-muted-foreground bg-transparent outline-none font-medium cursor-pointer hover:text-foreground"
          >
            {/* The native option list ignores Tailwind utilities and falls back
                to the OS default (white-on-white under dark themes). Force the
                theme colors explicitly via CSS variables so it's always legible. */}
            {charaList.length === 0 && (
              <option value="" style={{ backgroundColor: 'var(--background)', color: 'var(--foreground)' }}>{t('input.noCharacters')}</option>
            )}
            {/* Keep the current name visible even if it's not in the map. */}
            {userName && !charaList.some(c => c.name === userName) && (
              <option value={userName} style={{ backgroundColor: 'var(--background)', color: 'var(--foreground)' }}>{userName}</option>
            )}
            {charaList.map(c => (
              <option key={c.name} value={c.name} style={{ backgroundColor: 'var(--background)', color: 'var(--foreground)' }}>{c.name}</option>
            ))}
          </select>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            disabled={disabled || isGenerating}
            placeholder={t('input.placeholder')}
            className="w-full max-h-48 min-h-[44px] bg-transparent resize-none pb-3 pt-1 px-2 outline-none text-sm overflow-y-auto"
            rows={1}
          />
        </div>
        {isGenerating ? (
          <button 
            onClick={onStop}
            className="p-3 bg-red-500 text-white rounded-xl hover:bg-red-600 transition-colors shadow-sm"
            title={t('input.stop')}
          >
            <Square size={18} className="fill-current" />
          </button>
        ) : (
          <button 
            onClick={handleSend}
            disabled={disabled || (!text.trim() && attachments.length === 0)}
            className="p-3 bg-primary text-primary-foreground rounded-xl disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 transition-opacity shadow-sm"
          >
            <Send size={18} />
          </button>
        )}
      </div>
    </div>
  );
});

export default InputArea;
