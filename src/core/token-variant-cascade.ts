// SPDX-License-Identifier: EUPL-1.2
import { collectTokenBlockValues } from './token-inventory.js';
import {
  findVariantBlockDeclaration,
  insertVariantDeclaration,
  variantBlockHasToken,
} from './token-variant.js';

interface RootRule {
  specificity: number;
  attributes: Map<string, string | undefined>;
}

/** The root/attribute selector subset that token authoring accepts, without inventing arbitrary CSS specificity. */
function rootRule(selector: string): RootRule | undefined {
  const root = /^:root((?:\[[^\]]+\])*)(.*)$/.exec(selector.trim());
  if (!root) return undefined;
  const attributes = new Map<string, string | undefined>();
  const groups = (root[1] ?? '').match(/\[[^\]]+\]/g) ?? [];
  for (const group of groups) {
    const match = /^\[([\w-]+)(?:\s*=\s*["']?([\w-]+)["']?)?\]$/.exec(group);
    if (!match?.[1]) return undefined;
    const previous = attributes.get(match[1]);
    if (previous !== undefined && match[2] !== undefined && previous !== match[2]) return undefined;
    attributes.set(match[1], match[2] ?? previous);
  }
  const tail = root[2] ?? '';
  const qualifiers = tail.match(/:not\(\[[^\]]+\]\)|:[a-zA-Z][\w-]*/g) ?? [];
  if (qualifiers.join('') !== tail) return undefined;
  return { specificity: 1 + groups.length + qualifiers.length, attributes };
}

function canCoMatch(a: RootRule, b: RootRule): boolean {
  for (const [name, value] of a.attributes) {
    const other = b.attributes.get(name);
    if (value !== undefined && other !== undefined && value !== other) return false;
  }
  return true;
}

/** Preview later equal-specificity declarations; this is a warning, not a cascade rewrite or complete CSS proof. */
export function variantCascadeWarnings(
  lines: string[],
  variant: string,
  tokenName: string,
  cssPath: string
): string[] {
  if (variantBlockHasToken(lines, variant, tokenName)) return [];
  const preview = [...lines];
  insertVariantDeclaration(preview, variant, `  ${tokenName}: initial;`);
  const inserted = findVariantBlockDeclaration(preview, variant, tokenName);
  if (!inserted) return [];
  const declarations = collectTokenBlockValues(preview, tokenName);
  const target = declarations.find((entry) => entry.line === inserted.line);
  const targetSelector = target?.block.split(' > ').at(-1);
  const requested = targetSelector === undefined ? undefined : rootRule(targetSelector);
  if (!requested) return [];
  const delta = preview.length - lines.length;
  const warnings: string[] = [];
  for (const entry of declarations) {
    if (entry.line <= inserted.line) continue;
    const selectors = entry.block.split(' > ').at(-1)?.split(',') ?? [];
    if (
      !selectors.some((selector) => {
        const later = rootRule(selector);
        return (
          later !== undefined &&
          later.specificity === requested.specificity &&
          canCoMatch(requested, later)
        );
      })
    )
      continue;
    warnings.push(
      `Variant cascade warning: ${tokenName} in ${targetSelector} is inserted before a later equal-specificity declaration at ${cssPath}:${entry.line - delta} (${entry.block}). ` +
        'When both selectors and their surrounding conditions match, the later value can override the new variant. Review the skin/theme context and placement; FireForge preserves the existing CSS order.'
    );
  }
  return warnings;
}
