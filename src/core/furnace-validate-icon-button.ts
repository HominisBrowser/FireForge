// SPDX-License-Identifier: EUPL-1.2
/**
 * The opt-in `icon-button-label` check (`furnace.json#optInChecks`): an
 * icon-only `<moz-button>` has no visible text, so its accessible name has
 * to come from `data-l10n-id` (whose FTL message carries the label or
 * `.aria-label`) or from `aria-label`. Without one, screen readers announce
 * just "button".
 *
 * Scans the Lit `html` templates of the component module only. A button
 * built with `document.createElement` is not seen.
 */
import { collectLitTemplateRegions, parseTemplateAttributes } from './lit-template-regions.js';

/**
 * Attributes (and their Lit property-binding spellings) that give the
 * button an accessible name. `parseTemplateAttributes` lowercases names,
 * so `.ariaLabel=${…}` arrives as `.arialabel`.
 */
const NAMING_ATTRIBUTES = ['data-l10n-id', 'aria-label', '.arialabel'];

/** Attributes that give the button a visible label, so it is not icon-only. */
const LABEL_ATTRIBUTES = ['label', '.label'];

function isIconOnly(attrs: Map<string, string | undefined>, innerText: string): boolean {
  if (LABEL_ATTRIBUTES.some((name) => attrs.has(name))) return false;
  if (innerText.replace(/<[^>]*>/g, '').trim().length > 0) return false;
  const type = attrs.get('type') ?? '';
  return attrs.has('iconsrc') || attrs.has('.iconsrc') || /(^|\s)icon(\s|$)/.test(type);
}

/**
 * Counts icon-only `<moz-button>` elements in the module's Lit templates
 * that carry neither `data-l10n-id` nor `aria-label`.
 *
 * @param content - The component module's source
 */
export function countUnlabelledIconButtons(content: string): number {
  let count = 0;
  for (const region of collectLitTemplateRegions(content)) {
    const pattern = /<moz-button\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/moz-button>/gi;
    for (const match of region.matchAll(pattern)) {
      const attrs = parseTemplateAttributes(match[1] ?? '');
      if (!isIconOnly(attrs, match[2] ?? '')) continue;
      if (NAMING_ATTRIBUTES.some((name) => attrs.has(name))) continue;
      count++;
    }
  }
  return count;
}
