// SPDX-License-Identifier: EUPL-1.2
/*
 * Known source→packaging path transforms for the post-build dist-tree audit.
 *
 * A source at `engine/browser/base/content/foo.js` ships under
 * `chrome/browser/content/browser/foo.js`. If an unrelated patch registers a
 * different `foo.js` elsewhere (say a pref file under
 * `browser/defaults/preferences/`), the basename walker surfaces both, and
 * `scoreCandidate` awards them an identical trailing-overlap score because
 * every intermediate segment is in the generic list. The heuristic then
 * declares the winner "not structurally related" and reports the
 * correctly-packaged chrome resource as missing.
 *
 * The transforms below anchor resolution to the subtree→chrome conventions
 * upstream mozilla-central jar.mn uses. A candidate whose path ends with the
 * implied chrome suffix is a confident match: the scorer never runs and the
 * structural-relation check is bypassed.
 *
 * Scope is narrow: only subtrees whose packaging target is
 * stable across forks. A fork that reroutes a known subtree can still win by
 * adding `(source)` annotations in its own `jar.mn`, which
 * `resolveArtifactByRegistration` consults first.
 */

import { basename, sep } from 'node:path';

import { findAllByBasename } from './build-audit-resolve.js';
import { WIDGETS_DIR } from './furnace-constants.js';

/**
 * Table of `prefix → chrome-suffix` transforms. Each rule names an
 * engine-relative subtree prefix and produces the expected dist-tree
 * suffix for a file under it. Rules are evaluated in array order and
 * the first-matching prefix wins, so `toolkit/content/widgets/` must
 * precede the looser `toolkit/content/`.
 */
const KNOWN_TRANSFORMS: ReadonlyArray<{
  prefix: string;
  build: (rest: string) => string;
}> = [
  {
    prefix: 'browser/base/content/',
    build: (rest) => `chrome/browser/content/browser/${rest}`,
  },
  {
    prefix: `${WIDGETS_DIR}/`,
    build: (rest) => `chrome/toolkit/content/global/elements/${rest}`,
  },
  {
    prefix: 'toolkit/content/',
    build: (rest) => `chrome/toolkit/content/global/${rest}`,
  },
];

/**
 * Returns the expected chrome-tree suffix for an engine-relative POSIX
 * source path when the path falls under a known transform prefix.
 * Returns undefined otherwise.
 *
 * @param source Engine-relative POSIX source path.
 */
export function expectedChromeSuffix(source: string): string | undefined {
  for (const rule of KNOWN_TRANSFORMS) {
    if (source.startsWith(rule.prefix)) {
      return rule.build(source.slice(rule.prefix.length));
    }
  }
  return undefined;
}

/**
 * Probes the dist tree for the artifact implied by a known
 * source→chrome transform. Returns the first absolute candidate whose
 * POSIX path ends with the expected chrome suffix, or undefined when
 * no transform applies or no candidate matches.
 *
 * The transform check is treated as high-confidence by `build-audit.ts`
 * (callers pass `{ registered: true }` to `evaluateArtifactMtime`), so
 * a match bypasses the structural-relation check that rejects generic
 * basename collisions.
 *
 * @param source Engine-relative POSIX source path.
 * @param searchRoots Absolute roots to probe (dist/, _tests/).
 */
export async function resolveArtifactByKnownTransform(
  source: string,
  searchRoots: readonly string[]
): Promise<string | undefined> {
  const suffix = expectedChromeSuffix(source);
  if (!suffix) return undefined;

  const name = basename(source);
  const suffixWithSlash = `/${suffix}`;
  for (const root of searchRoots) {
    const candidates = await findAllByBasename(root, name);
    for (const candidate of candidates) {
      if (candidate.split(sep).join('/').endsWith(suffixWithSlash)) {
        return candidate;
      }
    }
  }
  return undefined;
}
