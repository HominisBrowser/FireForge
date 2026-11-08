// SPDX-License-Identifier: EUPL-1.2
import { InvalidArgumentError } from '../errors/base.js';

/**
 * Expands scope entries (a file path or a directory prefix) over the source
 * universe's paths. An entry that matches nothing is an error: a typo or a
 * path outside the captured source would otherwise select an empty scope,
 * which checks nothing and passes.
 *
 * @param known - Every path in the captured source universe
 * @param entries - File paths or directory prefixes chosen by the operator
 * @param flag - The option the entries came from, for the error message
 * @returns The universe paths the entries select
 */
export function resolveSourceScope(
  known: readonly string[],
  entries: readonly string[],
  flag: string
): Set<string> {
  const scope = new Set<string>();
  for (const entry of entries) {
    const prefix = entry.replace(/\/+$/, '');
    const matched = known.filter((path) => path === prefix || path.startsWith(`${prefix}/`));
    if (matched.length === 0) {
      throw new InvalidArgumentError(
        `${flag} entry "${entry}" matches no file in the captured source; nothing would be checked.`,
        flag
      );
    }
    for (const path of matched) scope.add(path);
  }
  return scope;
}
