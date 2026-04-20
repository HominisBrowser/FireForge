// SPDX-License-Identifier: EUPL-1.2
/**
 * Scaffolds the default tokens CSS file consumed by `fireforge token add`.
 *
 * Before 0.16.0 `fireforge furnace init` wrote `furnace.json` but not the
 * tokens CSS — every project's first `fireforge token add` hit
 * `Token CSS file not found: browser/themes/shared/<binaryName>-tokens.css`.
 * The 0.16.0 init now calls into this module to write a canonical
 * `:root { … }` shell with a seed set of category headers that
 * `assertTokenCategoryExists` recognises, and registers the tokens CSS
 * path in `patchLint.rawColorAllowlist` so the first token that's an
 * actual color value does not instantly fail `fireforge lint`.
 */

import type { ProjectLicense } from '../types/config.js';
import { getLicenseHeader } from './license-headers.js';

/**
 * The set of categories seeded by the default scaffold. `token add
 * --category <name>` accepts any of these without further setup; an
 * operator who needs another category only has to add a matching
 * `/* = My Category = *\/` header inside the `:root` block by hand.
 *
 * The names intentionally mirror the vocabulary used in Firefox's own
 * token files (Colors — Canvas, Spacing, …) so operators coming from
 * upstream don't have to relearn a fork-specific taxonomy.
 */
export const DEFAULT_TOKEN_CATEGORIES: readonly string[] = [
  'Colors — General',
  'Colors — Canvas',
  'Colors — Experiment',
  'Spacing',
];

/**
 * Generates the default tokens CSS body. Extracted from the init
 * command so tests can assert on the generated shape without running
 * the interactive scaffold flow.
 *
 * @param binaryName - `fireforge.json` `binaryName` used in the
 *   rendered file banner so operators can identify the fork on-sight.
 * @param license - Project license; piped through `getLicenseHeader`
 *   so the scaffold is SPDX-marked and survives `fireforge lint`'s
 *   license-header checks without operator intervention.
 */
export function generateDefaultTokensCss(binaryName: string, license: ProjectLicense): string {
  const header = getLicenseHeader(license, 'css');

  const categoryBlocks = DEFAULT_TOKEN_CATEGORIES.map(
    (category) =>
      `  /* = ${category} = */\n  /* (add design tokens for "${category}" here; use \`fireforge token add --category "${category}" …\`) */`
  ).join('\n\n');

  return `${header}

/*
 * Design tokens for ${binaryName}.
 *
 * Scaffolded by \`fireforge furnace init\`. Add new tokens with
 * \`fireforge token add --category '<name>' -- <token-name> <value>\`
 * — the command appends into the matching \`/* = <name> = *\\/\` block
 * below and keeps the per-category ordering stable.
 *
 * Raw color literals inside this file are expected — the whole point
 * of the tokens layer is that every other CSS file consumes \`var(…)\`
 * instead of literal colors. \`fireforge furnace init\` adds this
 * file's path to \`patchLint.rawColorAllowlist\` in fireforge.json so
 * \`fireforge lint\` stops flagging the literals here.
 */

:root {
${categoryBlocks}
}

@media (prefers-color-scheme: dark) {
  :root {
    /* Dark-mode overrides land here. Use \`fireforge token add --mode override --dark-value <v>\`
       to have a token's dark value placed inside this block. */
  }
}
`;
}
