'use client';

// The per-family model selects, as ONE component (2026-11-12).
//
// Moved verbatim out of ChatArea's Model tab so a second place that has to
// choose "a family and one of its models" — the anchor's vessel, in the
// Behaviour tab — renders the SAME option lists instead of a copy. A copy of
// these lists is how the price strings came to live in five places once.
//
// It renders the model select for `family` and, for Claude, the billing
// switch. It does NOT render the family select: the Model tab's family change
// carries per-conversation memory (familyModels) that no other caller has.
//
// `compact` hides the long per-family help paragraphs (class `model-help`).
// They describe the being's own vessel and are noise under a helper's picker.

import React from 'react';
import EditableCombo from './EditableCombo';
import ModelPriceSelect from './ModelPriceSelect';
import { tagPriceOptions } from '@/lib/modelPriceLabel';
import { retiredModelLabel } from '@/lib/retiredModels';
import { useT, renderRich } from '@/lib/i18n';

// Renders a saved-but-retired model id as a visibly-marked option, so a
// <select> never silently displays its first child in place of what the folder
// actually holds. The table and the rationale live in lib/retiredModels.ts.
function RetiredOption({ value, id }: { value: string; id?: string }) {
  const label = retiredModelLabel(id ?? value);
  if (!label) return null;
  return (
    <option value={value} style={{ backgroundColor: 'var(--background)', color: 'var(--foreground)' }}>
      ⚠ {label}
    </option>
  );
}
export { RetiredOption };

export interface FamilyModelPickerProps {
  family: string;
  model: string;
  onModel: (m: string) => void;
  authMode: 'api-key' | 'oauth';
  onAuthMode: (m: 'api-key' | 'oauth') => void;
  localModels: string[];
  localModelsMeta: Record<string, any>;
  localModelsError?: string | null;
  onRefreshLocal: () => void;
  compact?: boolean;
  /**
   * Optional filter (2026-11-14, sense seats): offer only model ids that pass.
   * For local models `localVision` is LM Studio's own vision flag. Absent =
   * the full lists, exactly as the Model tab shows them.
   */
  keep?: (id: string, localVision?: boolean) => boolean;
  /** Hide the Claude monthly/pay-as-you-go switch (a seat that has no choice). */
  hideBilling?: boolean;
}

export default function FamilyModelPicker({
  family, model, onModel, authMode, onAuthMode,
  localModels, localModelsMeta, localModelsError, onRefreshLocal, compact,
  keep, hideBilling,
}: FamilyModelPickerProps) {
  const t = useT();
  const ks = keep ? (v: string) => keep(v) : undefined;
  const ksLocal = keep ? (v: string) => keep(v, !!localModelsMeta[v]?.vision) : undefined;
  return (
    <div className={compact ? '[&_.model-help]:hidden' : undefined}>
    {family === 'Claude' && (
      <>
      <div className="mb-4">
        <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.claude.label')}</label>
        <ModelPriceSelect
          value={model}
          onChange={(e) => onModel(e.target.value)} keep={ks}
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
        >
          <option value="claude-fable-5-2">Claude Fable 5.2 (adaptive thinking, newest flagship)</option>
          <option value="claude-fable-5-1">Claude Fable 5.1 (adaptive thinking, flagship)</option>
          <option value="claude-fable-5">Claude Fable 5 (adaptive thinking, legacy)</option>
          <option value="claude-opus-5-5">Claude Opus 5.5 (adaptive thinking, newest)</option>
          <option value="claude-opus-5">Claude Opus 5 (adaptive thinking)</option>
          <option value="claude-opus-4-8">Claude Opus 4.8 (thinking)</option>
          <option value="claude-opus-4-7">Claude Opus 4.7 (thinking)</option>
          <option value="claude-sonnet-5-5">Claude Sonnet 5.5 (adaptive thinking, 1M ctx, newest)</option>
          <option value="claude-sonnet-5">Claude Sonnet 5 (adaptive thinking, 1M ctx)</option>
          <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (thinking)</option>
          <option value="claude-haiku-5-5">Claude Haiku 5.5 (adaptive thinking, 1M ctx, cheapest)</option>
          <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5</option>
        </ModelPriceSelect>
      </div>
      {!hideBilling && (
      <div className="mb-4">
        <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.claude.billing')}</label>
        <div className="flex gap-2">
          {(['api-key', 'oauth'] as const).map(mode => (
            <button
              key={mode}
              type="button"
              onClick={() => onAuthMode(mode)}
              className={`flex-1 py-1.5 px-2 text-xs font-medium rounded border transition-colors ${
                authMode === mode
                  ? 'border-indigo-500 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
                  : 'border-border text-muted-foreground hover:border-indigo-400 hover:text-foreground'
              }`}
            >
              {mode === 'api-key' ? t('model.claude.tokenPaid') : t('model.claude.monthlyPaid')}
            </button>
          ))}
        </div>
        <div className="model-help text-[10px] text-muted-foreground mt-1 leading-relaxed">
          {renderRich(t('model.claude.billingHelp'))}
          <span className="block mt-0.5">{renderRich(t('model.claude.billingHelp2'))}</span>
        </div>
      </div>
      )}
      </>
    )}

    {family === 'Gemini' && (
      <div className="mb-4">
        <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.gemini.label')}</label>
        <ModelPriceSelect
          value={model}
          onChange={(e) => onModel(e.target.value)} keep={ks}
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
        >
          <option value="gemini-4-argon">Gemini 4 Argon</option>
          <option value="gemini-4-hydrogen">Gemini 4 Hydrogen</option>
          <option value="gemini-4-carbon">Gemini 4 Carbon</option>
          <option value="gemini-3.8-flash">Gemini 3.8 Flash</option>
          <option value="gemini-3.7-flash">Gemini 3.7 Flash</option>
          <option value="gemini-3.6-flash">Gemini 3.6 Flash</option>
          <option value="gemini-3.5-flash">Gemini 3.5 Flash</option>
          <option value="gemini-3.5-flash-lite">Gemini 3.5 Flash Lite</option>
          <option value="gemini-3.1-flash-lite">Gemini 3.1 Flash Lite</option>
          <option value="gemini-3.1-pro-preview">Gemini 3.1 Pro Preview</option>
        </ModelPriceSelect>
      </div>
    )}

    {family === 'Qwen' && (
      <div className="mb-4">
        <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.qwen.label')}</label>
        <ModelPriceSelect
          value={model}
          onChange={(e) => onModel(e.target.value)} keep={ks}
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
        >
          <option value="qwen3.8-max">Qwen 3.8 Max (reasoning, text + vision)</option>
          <option value="qwen3.7-max">Qwen 3.7 Max (reasoning, text)</option>
          <option value="qwen3.6-max-preview">Qwen 3.6 Max (text + vision)</option>
          <option value="qwen3.6-plus">Qwen 3.6 Plus (text + vision)</option>
          <option value="qwen3.5-omni-flash">Qwen 3.5 Omni Flash (text + vision + audio + video)</option>
          <option value="qwen3.5-omni-plus">Qwen 3.5 Omni Plus (text + vision + audio + video — higher quality)</option>
        </ModelPriceSelect>
        <div className="model-help text-[10px] text-muted-foreground mt-1 leading-relaxed">
          {renderRich(t('model.qwen.help'))}
        </div>
      </div>
    )}

    {family === 'DeepSeek' && (
      <div className="mb-4">
        <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.deepseek.label')}</label>
        <ModelPriceSelect
          value={model}
          onChange={(e) => onModel(e.target.value)} keep={ks}
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
        >
          <optgroup label="DeepSeek first-party API (api.deepseek.com)">
            <option value="deepseek-v4-pro">DeepSeek V4 Pro (text only)</option>
            <option value="deepseek-flash">DeepSeek V4.1 Flash (1M context, vision)</option>
            <option value="deepseek-reasoner">DeepSeek Reasoner (legacy alias → V4.1 Flash)</option>
            <option value="deepseek-chat">DeepSeek Chat (legacy alias → V4.1 Flash)</option>
          </optgroup>
          <optgroup label="Alibaba DashScope (Qwen billing)">
            <option value="deepseek-v3.2">DeepSeek V3.2 (hybrid reasoning)</option>
          </optgroup>
        </ModelPriceSelect>
        <div className="model-help text-[10px] text-muted-foreground mt-1 leading-relaxed">
          {renderRich(t('model.deepseek.help1'))}
          <br />
          {renderRich(t('model.deepseek.help2'))}
          <br />
          {renderRich(t('model.deepseek.help3'))}
          <br />
          {renderRich(t('model.deepseek.help4'))}
        </div>
      </div>
    )}

    {family === 'Minimax' && (
      <div className="mb-4">
        <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.minimax.label')}</label>
        <ModelPriceSelect
          value={model}
          onChange={(e) => onModel(e.target.value)} keep={ks}
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
        >
          <option value="MiniMax-M3.1-Flash">MiniMax M3.1 Flash (newest — multimodal, 1M context)</option>
          <option value="MiniMax-M3">MiniMax M3 (flagship — multimodal, 1M context, agentic coding)</option>
          <option value="MiniMax-M2.7">MiniMax M2.7 (coding + reasoning, 200K context)</option>
        </ModelPriceSelect>
        <div className="model-help text-[10px] text-muted-foreground mt-1 leading-relaxed">
          {renderRich(t('model.minimax.help'))}
        </div>
      </div>
    )}

    {family === 'Cohere' && (
      <div className="mb-4">
        <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.cohere.label')}</label>
        <ModelPriceSelect
          value={model}
          onChange={(e) => onModel(e.target.value)} keep={ks}
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
        >
          <option value="command-a-plus-05-2026">Command A Plus (May 2026 — flagship)</option>
          <option value="command-a-reasoning-08-2025">Command A Reasoning (Aug 2025)</option>
          <option value="command-a-vision-07-2025">Command A Vision (Jul 2025 — multimodal)</option>
        </ModelPriceSelect>
        <div className="model-help text-[10px] text-muted-foreground mt-1 leading-relaxed">
          {renderRich(t('model.cohere.help'))}
        </div>
      </div>
    )}

    {family === 'Kimi' && (
      <div className="mb-4">
        <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.kimi.label')}</label>
        <ModelPriceSelect
          value={model}
          onChange={(e) => onModel(e.target.value)} keep={ks}
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
        >
          <option value="moonshotai/Kimi-K3">Kimi K3 (1M context, always-on reasoning, native vision)</option>
          <option value="moonshotai/Kimi-K3.1-Pro">Kimi K3.1 Pro (post-trained K3 — 1M context, vision, tools)</option>
          <option value="moonshotai/Kimi-K3.1-Pro-Highspeed">Kimi K3.1 Pro Highspeed (same model, 2× price, 2–3× faster)</option>
          <option value="moonshotai/Kimi-K2.7-Code">Kimi K2.7 Code (256K, coding line, thinking-only)</option>
          <option value="moonshotai/Kimi-K2.7-Code-Highspeed">Kimi K2.7 Code Highspeed (same model, 2× price, faster)</option>
          <option value="moonshotai/Kimi-K2.6">Kimi K2.6 (256K context, multimodal)</option>
        </ModelPriceSelect>
        <div className="model-help text-[10px] text-muted-foreground mt-1 leading-relaxed">
          {renderRich(t('model.kimi.help'))}
        </div>
      </div>
    )}

    {family === 'Grok' && (
      <div className="mb-4">
        <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.grok.label')}</label>
        <ModelPriceSelect
          value={model}
          onChange={(e) => onModel(e.target.value)} keep={ks}
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
        >
          <option value="grok-4.7">Grok 4.7 (flagship)</option>
          <option value="grok-4.6">Grok 4.6</option>
          <option value="grok-4.5">Grok 4.5</option>
          <option value="grok-4.3">Grok 4.3</option>
          <option value="grok-4.20-0309-reasoning">Grok 4.20 — Reasoning</option>
          <option value="grok-4.20-0309-non-reasoning">Grok 4.20 — Non-reasoning (fast)</option>
          <option value="grok-4-1-fast-non-reasoning">Grok 4.1 Fast (legacy)</option>
          <option value="grok-code-fast-1">Grok Code Fast 1 (coding)</option>
        </ModelPriceSelect>
        <div className="model-help text-[10px] text-muted-foreground mt-1 leading-relaxed">
          {renderRich(t('model.grok.help'))}
        </div>
      </div>
    )}

    {family === 'ChatGPT' && (
      <div className="mb-4">
        <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.chatgpt.label')}</label>
        <ModelPriceSelect
          value={model}
          onChange={(e) => onModel(e.target.value)} keep={ks}
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
        >
          {/* sol/astra reject reasoning_effort 'none' (the value tools need on
              /v1/chat/completions), so NEXUS sends their tool turns through
              /v1/responses instead, where tools work at any effort. See
              lib/openaiResponses.ts and lib/openaiEffort.ts. */}
          <option value="gpt-6.1-sol">GPT-6.1 Sol (newest, tools OK)</option>
          <option value="gpt-6.1-terra">GPT-6.1 Terra (tools OK)</option>
          <option value="gpt-6-sol">GPT-6 Sol (tools OK)</option>
          <option value="gpt-6-astra">GPT-6 Astra (most capable, tools OK)</option>
          <option value="gpt-6-luna">GPT-6 Luna (cheapest, tools OK)</option>
          <option value="gpt-5.6-sol">GPT-5.6 Sol (flagship, deepest reasoning)</option>
          <option value="gpt-5.6-terra">GPT-5.6 Terra (balanced)</option>
          <option value="gpt-5.6-luna">GPT-5.6 Luna (fast, budget)</option>
          <option value="gpt-5.5">GPT-5.5</option>
          <option value="gpt-5.4">GPT-5.4</option>
          <option value="gpt-5.4-mini">GPT-5.4 Mini (fast)</option>
        </ModelPriceSelect>
        <div className="model-help text-[10px] text-muted-foreground mt-1 leading-relaxed">
          {renderRich(t('model.chatgpt.help'))}
        </div>
      </div>
    )}

    {family === 'MiMo' && (
      <div className="mb-4">
        <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.mimo.label')}</label>
        <ModelPriceSelect
          value={model}
          onChange={(e) => onModel(e.target.value)} keep={ks}
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
        >
          <option value="mimo-v2.6-pro">MiMo V2.6 Pro (flagship — text + image + video + audio)</option>
          <option value="mimo-v2.6-flash">MiMo V2.6 Flash (fast + cheap — same modalities)</option>
          <option value="mimo-v2.6-pro-ultraspeed">MiMo V2.6 Pro UltraSpeed (up to 20x faster, 10x the price)</option>
          <RetiredOption value={model} />
        </ModelPriceSelect>
        <div className="model-help text-[10px] text-muted-foreground mt-1 leading-relaxed">
          {renderRich(t('model.mimo.help'))}
        </div>
      </div>
    )}

    {family === 'ByteDance' && (
      <div className="mb-4">
        <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.bytedance.label')}</label>
        <EditableCombo
          value={model}
          onChange={onModel}
          mono
          placeholder={t('model.bytedance.ph')}
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm font-mono hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
          options={tagPriceOptions([
            { value: 'dola-seed-2-1-turbo-260628', label: 'Seed 2.1 Turbo (image + video)' },
            { value: 'seed-2-0-pro-260328', label: 'Seed 2.0 Pro (text + image)' },
            { value: 'seed-2-0-lite-260428', label: 'Seed 2.0 Lite (omnimodal — image, audio, video)' },
            { value: 'seed-2-0-mini-260428', label: 'Seed 2.0 Mini' },
            { value: 'seed-2-0-code-preview-260328', label: 'Seed 2.0 Code (preview)' },
          ].filter((o) => !ks || ks(o.value)))}
        />
        <div className="model-help text-[10px] text-muted-foreground mt-1 leading-relaxed">
          {renderRich(t('model.bytedance.help'))}
        </div>
      </div>
    )}

    {family === 'Meta' && (
      <div className="mb-4">
        <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.meta.label')}</label>
        <ModelPriceSelect
          value={model}
          onChange={(e) => onModel(e.target.value)} keep={ks}
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
        >
          {/* The tier is part of the MODEL ID on this API, not an
              account switch — so the choice is made here, once per
              turn, and the label has to say what it costs you. The
              non-money cost is in the option text on purpose: a
              footnote under the dropdown is not consent. */}
          <option value="muse-spark-1.3">Muse Spark 1.3 (vision, 1M context)</option>
          <option value="muse-spark-1.2">Muse Spark 1.2 (vision, 1M context)</option>
          <option value="muse-spark-1.1">Muse Spark 1.1 (vision, 1M context)</option>
          <option value="muse-spark-1.3-contributor">Muse Spark 1.3 — Contributor: Meta trains on your prompts AND replies</option>
          <option value="muse-spark-1.2-contributor">Muse Spark 1.2 — Contributor: Meta trains on your prompts AND replies</option>
        </ModelPriceSelect>
        <div className="model-help text-[10px] text-muted-foreground mt-1 leading-relaxed">
          {renderRich(t('model.meta.help'))}
        </div>
      </div>
    )}

    {family === 'GLM' && (
      <div className="mb-4">
        <label className="text-xs font-medium text-muted-foreground block mb-1">{t('model.glm.providerLabel')}</label>
        <select
          value={(model || '').startsWith('digitalocean/') ? 'digitalocean' : 'zai'}
          onChange={(e) => {
            // Provider is derived from the model id prefix — one
            // field, no second state to drift out of sync.
            onModel(e.target.value === 'digitalocean' ? 'digitalocean/glm-5.2' : 'glm-5.2');
          }}
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
        >
          <option value="zai">Z.AI (Zhipu) — api.z.ai</option>
          {(!ks || ks('digitalocean/glm-5.2')) && (
            <option value="digitalocean">DigitalOcean Inference — inference.do-ai.run (US-hosted, ~half Z.ai price)</option>
          )}
        </select>
        <label className="text-xs font-medium text-muted-foreground block mb-1 mt-3">{t('model.glm.label')}</label>
        <ModelPriceSelect
          value={(() => {
            // Guard: a saved model that doesn't exist on the current
            // provider (e.g. glm-4.7 after switching to DigitalOcean)
            // renders as a disabled placeholder instead of a blank box.
            const isDO = (model || '').startsWith('digitalocean/');
            const valid = isDO
              ? ['digitalocean/glm-5.2', 'digitalocean/glm-5.1', 'digitalocean/glm-5']
              : ['glm-5.3','glm-5.3-flash','glm-5.2','glm-5.1','glm-5','glm-5-turbo','glm-5v-turbo','glm-4.7','glm-4.6','glm-4.6v','glm-4.6v-flash','glm-4.5-air'];
            return valid.includes(model || '') ? model : '';
          })()}
          onChange={(e) => onModel(e.target.value)} keep={ks}
          className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
        >
          {(model || '').startsWith('digitalocean/') ? (
            <>
              {(!['digitalocean/glm-5.2','digitalocean/glm-5.1','digitalocean/glm-5'].includes(model || '')) && (
                <option value="" disabled>{t('model.glm.notOnDO').replace('{model}', model || '')}</option>
              )}
              <option value="digitalocean/glm-5.2">GLM-5.2 (262K context)</option>
              <option value="digitalocean/glm-5.1">GLM-5.1</option>
              <option value="digitalocean/glm-5">GLM-5</option>
            </>
          ) : (
            <>
              {(model && !['glm-5.3','glm-5.3-flash','glm-5.2','glm-5.1','glm-5','glm-5-turbo','glm-5v-turbo','glm-4.7','glm-4.6','glm-4.6v','glm-4.6v-flash','glm-4.5-air'].includes(model)) && (
                <option value="" disabled>{t('model.glm.notOnZai').replace('{model}', model || '')}</option>
              )}
              <option value="glm-5.3">GLM-5.3 (latest, 1M context, reasoning always on)</option>
              <option value="glm-5.3-flash">GLM-5.3 Flash (multimodal, 1M context, reasoning always on)</option>
              <option value="glm-5.2">GLM-5.2</option>
              <option value="glm-5.1">GLM-5.1</option>
              <option value="glm-5">GLM-5</option>
              <option value="glm-5-turbo">GLM-5 Turbo (fast)</option>
              <option value="glm-5v-turbo">GLM-5V Turbo (fast multimodal)</option>
              <option value="glm-4.7">GLM-4.7</option>
              <option value="glm-4.6">GLM-4.6 (200K context)</option>
              <option value="glm-4.6v">GLM-4.6V (multimodal)</option>
              <option value="glm-4.6v-flash">GLM-4.6V Flash (fast multimodal)</option>
              <option value="glm-4.5-air">GLM-4.5 Air (cheap)</option>
            </>
          )}
        </ModelPriceSelect>
        <div className="model-help text-[10px] text-muted-foreground mt-1 leading-relaxed">
          {(model || '').startsWith('digitalocean/')
            ? renderRich(t('model.glm.helpDO'))
            : renderRich(t('model.glm.helpZai'))}
        </div>
      </div>
    )}
    {family === 'Local' && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs font-medium text-muted-foreground">{t('model.local.label')}</label>
            <button onClick={onRefreshLocal} className="text-[10px] text-indigo-500 hover:underline" type="button">{t('model.local.refresh')}</button>
          </div>
          <ModelPriceSelect
            value={model}
            onChange={(e) => onModel(e.target.value)} keep={ksLocal}
            className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm appearance-none cursor-pointer hover:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
          >
            {localModels.length === 0 && <option value="">{t('model.local.none')}</option>}
            {/* Keep current value selectable even if not in list */}
            {model && !localModels.includes(model) && (
              <option value={model}>{t('model.local.notLoaded').replace('{model}', model)}</option>
            )}
            {localModels.map(m => {
              const meta = localModelsMeta[m];
              const flags = meta
                ? [meta.vision ? '👁' : '', meta.tools ? '🔨' : ''].filter(Boolean).join('')
                : '';
              const detail = meta
                ? [meta.params, meta.quant, meta.arch, meta.sizeGB].filter(Boolean).join(' · ')
                : '';
              return (
                <option key={m} value={m}>
                  {meta?.publisher ? `${meta.publisher} · ` : ''}
                  {meta && meta.displayName ? meta.displayName : m}
                  {detail ? ` — ${detail}` : ''}
                  {flags ? ` ${flags}` : ''}
                  {meta && meta.loaded ? ' ⚡' : ''}
                </option>
              );
            })}
          </ModelPriceSelect>
          {localModelsError && (
            <div className="text-[10px] text-red-500 mt-1">{localModelsError}</div>
          )}
        </div>
    )}
    </div>
  );
}
