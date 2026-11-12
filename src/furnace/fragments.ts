// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared CSS fragments. Shadow DOM makes every widget stylesheet carry its
 * own copy of genuinely shared rules, so a component stylesheet names a
 * fragment of `components/shared/` with an include directive on its own
 * line (`src/syntax` reads the markers). The deployed copy has the fragment
 * inlined after the directive and fenced by its end marker; the project's
 * source keeps only the directive. Editing a fragment therefore changes the
 * deployed content of every includer, which is what makes them stale.
 */
import { join } from 'node:path';

import { readTextIfExists } from '../kernel/fs.js';
import {
  fragmentEnd,
  fragmentExpansions,
  fragmentInclude,
  fragmentIncludes,
} from '../syntax/index.js';
import { furnaceError } from './config.js';

/** Drops fenced expansions, leaving the bare directives, so expansion is idempotent. */
function stripExpansions(css: string): string[] {
  const lines = css.split('\n');
  const dropped = new Set<number>();
  for (const [start, end] of fragmentExpansions(lines)) {
    for (let at = start + 1; at <= end; at++) dropped.add(at);
  }
  return lines.filter((_, at) => !dropped.has(at));
}

/**
 * The deployed form of a stylesheet: every directive followed by the
 * fragment's current text and its end marker.
 *
 * @param css - Stylesheet text (a source, or an earlier expansion)
 * @param sharedDir - The fragments directory
 * @throws `furnace-fragment-missing` for a fragment that does not exist, or one that includes another
 */
export async function expandFragments(css: string, sharedDir: string): Promise<string> {
  const lines = stripExpansions(css);
  if (!lines.some((line) => fragmentInclude(line) !== undefined)) return css;
  const out: string[] = [];
  for (const line of lines) {
    out.push(line);
    const name = fragmentInclude(line);
    if (name === undefined) continue;
    const text = await readTextIfExists(join(sharedDir, name));
    if (text === undefined) {
      throw furnaceError(
        'furnace-fragment-missing',
        `CSS fragment "${name}" does not exist in components/shared/.`,
        { hint: 'Create the fragment or remove the @fireforge-include directive.' }
      );
    }
    if (fragmentIncludes(text).length > 0) {
      throw furnaceError(
        'furnace-fragment-missing',
        `CSS fragment "${name}" includes another fragment; fragments do not nest.`
      );
    }
    out.push(text.replace(/\n$/, ''), fragmentEnd(name));
  }
  return out.join('\n');
}
