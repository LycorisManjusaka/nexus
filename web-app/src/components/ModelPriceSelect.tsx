'use client';

import React from 'react';
import { shortPriceTag } from '@/lib/modelPriceLabel';

/**
 * A <select> that appends each option's real `$in/$cacheRead/$out` rates to
 * its label.
 *
 * WHY A WRAPPER INSTEAD OF EDITING THE OPTIONS (2026-11-09):
 * There are 127 <option> rows across 14 model selects. Writing the price into
 * each label by hand would put the same fact in two places — the label and
 * modelPricing.json — and the label copy is the one nothing checks. That is
 * exactly how the "cheaper" wording this replaces went stale. Reading the
 * price at render time means:
 *   - a price change in the JSON shows up everywhere, with no edit;
 *   - an option added later gets its tag for free, including by someone who
 *     has never read this file.
 *
 * WHAT IT REFUSES TO TOUCH:
 *   - options whose value has no pricing row (14 of them today: glm-4.6,
 *     glm-5, grok-code-fast-1, qwen3.5-omni-flash, deepseek-v3.2,
 *     command-a-*). No tag beats an invented one.
 *   - options whose label is not a plain string (`{t('…')}` ones in the
 *     effort/date selects). Those aren't model rows at all, and rewriting a
 *     translated node would be guessing at its shape.
 * So it is safe to wrap a select that holds no models: it just does nothing.
 *
 * ⚠ It cannot make a row TALLER or wrap it. The OS draws a native dropdown
 * list; there is no HTML inside an <option>. Everything that doesn't fit in
 * one line belongs in a panel under the select — see `priceTiers()`.
 */
export default function ModelPriceSelect(
  // `ComponentProps<'select'>` rather than `SelectHTMLAttributes`: the former
  // is exactly what a native <select> accepts, so an inline
  // `onChange={(e) => …}` at a call site keeps inferring `e` instead of
  // silently degrading to `any`.
  props: React.ComponentProps<'select'>,
) {
  const { children, ...rest } = props;
  return <select {...rest}>{withPriceTags(children)}</select>;
}

/** Recursively tag <option> labels, descending through <optgroup>. */
function withPriceTags(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child) => {
    if (!React.isValidElement(child)) return child;

    // Fragments must be descended into, not passed through. Several selects
    // branch on provider and wrap their options in `<>…</>` (GLM's Z.AI vs
    // DigitalOcean lists, Grok, Qwen) — skipping fragments would silently tag
    // some families and not others, which is worse than tagging none.
    if (child.type === React.Fragment) {
      const props = child.props as { children?: React.ReactNode };
      return React.cloneElement(
        child as React.ReactElement<{ children?: React.ReactNode }>,
        {},
        withPriceTags(props.children),
      );
    }

    if (child.type === 'optgroup') {
      const props = child.props as { children?: React.ReactNode };
      return React.cloneElement(
        child as React.ReactElement<{ children?: React.ReactNode }>,
        {},
        withPriceTags(props.children),
      );
    }

    if (child.type === 'option') {
      const props = child.props as { value?: unknown; children?: React.ReactNode };
      // Only plain-string labels. A translated node or a fragment is left as
      // it is rather than reconstructed.
      if (typeof props.children !== 'string') return child;
      const value = typeof props.value === 'string' ? props.value : '';
      const tag = shortPriceTag(value);
      if (!tag) return child;
      // Already tagged (defensive — e.g. if a select ends up double-wrapped).
      if (props.children.includes(tag)) return child;
      return React.cloneElement(
        child as React.ReactElement<{ children?: React.ReactNode }>,
        {},
        `${props.children} · ${tag}`,
      );
    }

    return child;
  });
}
