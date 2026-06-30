"use client";

import React, { useState, useRef } from 'react';
import { Send, Paperclip, X, FileText, Image as ImageIcon, Music, Video, File, Square } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';

const InputArea = React.forwardRef(function InputArea({ onSend, onStop, isGenerating, disabled, aiName, vrchatMode }: any, ref: any) {
  const [text, setText] = useState('');
  const [userName, setUserName] = useState('');
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
    // SettingsModal dispatches an nx-chara-changed event after the user picks a
    // new character in the User Identity dropdown.
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
      const isText = file.type.startsWith('text/') || /\.(txt|md|csv|json|py|js|ts|jsx|tsx|css|html)$/i.test(file.name);
      const isImage = file.type.startsWith('image/');
      const isAudio = file.type.startsWith('audio/');
      const isVideo = file.type.startsWith('video/');

      let textData = null;
      let dataUrl: string | null = null;
      let tokens = 0;
      let finalName = file.name;
      let finalType = file.type;
      let finalSize = file.size;

      if (isText) {
        textData = await file.text();
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

        // Fallback path (non-image media OR conversion skipped/failed): read original
        if (!dataUrl) {
          const reader = new FileReader();
          dataUrl = await new Promise((resolve) => {
            reader.onload = (e) => resolve(e.target?.result as string);
            reader.readAsDataURL(file);
          });
        }

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

      return {
        id: uuidv4(),
        name: finalName,
        type: finalType,
        size: finalSize,
        isText, isImage, isAudio, isVideo,
        textData, dataUrl,
        tokens,
        fileObj: file
      };
    }));

    setAttachments(prev => [...prev, ...newAttachments]);
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
    // Skip the prefix when the name is empty OR the literal fallback "User" —
    // anonymous/default messages don't need a meaningless tag burning tokens.
    // In VRChat mode the text is already a "[Name] ..." transcript, so don't
    // wrap it in another [userName] tag.
    if (!vrchatMode && trimmedName !== '' && trimmedName !== 'User') {
      finalText = `[${trimmedName}]\n${text}`.trim();
    }
    onSend(finalText, attachments);
    setText('');
    setAttachments([]);
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
        <button 
          onClick={() => fileInputRef.current?.click()}
          className="p-3 text-muted-foreground hover:text-foreground hover:bg-muted rounded-xl transition-colors"
          disabled={disabled}
        >
          <Paperclip size={20} />
        </button>
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
            title="Active speaker — same as Preferences → User Identity (writes chara_settings.json)"
            className="px-2 pt-2 text-xs text-muted-foreground bg-transparent outline-none font-medium cursor-pointer hover:text-foreground"
          >
            {/* The native option list ignores Tailwind utilities and falls back
                to the OS default (white-on-white under dark themes). Force the
                theme colors explicitly via CSS variables so it's always legible. */}
            {charaList.length === 0 && (
              <option value="" style={{ backgroundColor: 'var(--background)', color: 'var(--foreground)' }}>— no characters —</option>
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
            placeholder="Send a message... (Shift+Enter for newline)"
            className="w-full max-h-48 min-h-[44px] bg-transparent resize-none pb-3 pt-1 px-2 outline-none text-sm overflow-y-auto"
            rows={1}
          />
        </div>
        {isGenerating ? (
          <button 
            onClick={onStop}
            className="p-3 bg-red-500 text-white rounded-xl hover:bg-red-600 transition-colors shadow-sm"
            title="Stop Generating"
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
