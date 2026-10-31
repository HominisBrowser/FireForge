// SPDX-License-Identifier: EUPL-1.2
/**
 * How a per-patch checkJs program resolves a URL import, as pure functions
 * shared by the compiler host in `patch-lint-checkjs.ts` and by
 * `typecheck --explain`, which reports the same resolution without
 * building a program.
 */

import { basename } from 'node:path';

/**
 * Builds the owned-module matcher: a specifier resolves to the owned file
 * whose basename uniquely equals the specifier's final segment. URL
 * specifiers (chrome://browser/content/Foo.sys.mjs,
 * resource:///modules/Foo.sys.mjs) are matched by basename, with a
 * `.mjs` → `.sys.mjs` fallback for deployed widget URLs. Ambiguous or
 * unknown basenames stay unresolved (loose wildcard typing beats guessing
 * the wrong module), and relative specifiers are left to fail resolution
 * (the relative-import lint rule bans them).
 *
 * @param owned - The program's resolvable files, in any path form
 * @returns The matching owned path, or undefined
 */
export function createOwnedPathMatcher(
  owned: Iterable<string>
): (specifier: string) => string | undefined {
  const ownedByBasename = new Map<string, string[]>();
  for (const file of owned) {
    const base = basename(file);
    const list = ownedByBasename.get(base) ?? [];
    list.push(file);
    ownedByBasename.set(base, list);
  }

  return (specifier) => {
    if (specifier.startsWith('.')) return undefined;
    const cleaned = specifier.split(/[?#]/)[0] ?? specifier;
    const segment = cleaned.slice(cleaned.lastIndexOf('/') + 1);
    if (!segment) return undefined;
    const candidates = [...(ownedByBasename.get(segment) ?? [])];
    if (segment.endsWith('.mjs') && !segment.endsWith('.sys.mjs')) {
      candidates.push(...(ownedByBasename.get(segment.replace(/\.mjs$/, '.sys.mjs')) ?? []));
    }
    return candidates.length === 1 ? candidates[0] : undefined;
  };
}

/**
 * The targets a reviewed `paths` mapping offers for `specifier`, in the
 * order they are tried: patterns in declaration order, each pattern's
 * targets in order. A pattern may contain a single `*`, and the captured
 * text replaces the one `*` of a target.
 *
 * @param paths - `checkJsCompilerOptions.paths`
 * @param specifier - The import specifier
 * @returns Engine-relative candidate paths; the first that exists wins
 */
export function pathsTargetCandidates(
  paths: Record<string, string[]>,
  specifier: string
): string[] {
  const candidates: string[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    const star = pattern.indexOf('*');
    let captured: string;
    if (star === -1) {
      if (specifier !== pattern) continue;
      captured = '';
    } else {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (specifier.length < prefix.length + suffix.length) continue;
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      captured = specifier.slice(prefix.length, specifier.length - suffix.length);
    }
    for (const target of targets) {
      // A `paths` target carries at most one `*`, and TypeScript substitutes
      // that one wildcard. It is spelled as index arithmetic (mirroring the
      // prefix/suffix split on the pattern side above) rather than
      // `replace('*', …)`, whose first-occurrence-only behaviour reads as an
      // incomplete rewrite (CodeQL `js/incomplete-sanitization`).
      const targetStar = target.indexOf('*');
      candidates.push(
        targetStar === -1
          ? target
          : target.slice(0, targetStar) + captured + target.slice(targetStar + 1)
      );
    }
  }
  return candidates;
}
