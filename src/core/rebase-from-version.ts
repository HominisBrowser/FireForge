// SPDX-License-Identifier: EUPL-1.2
/**
 * Resolves the "from" side of a `fireforge rebase` source move.
 *
 * The rebase target is the working `firefox.version` pin, which
 * `fireforge source set` has already moved. The tree the queue was last
 * applied to is the previous pin: the `firefox` block of `fireforge.json`
 * as committed in the project repository. Patch `sourceVersion` stamps are
 * a poor stand-in: patches untouched since an older hop keep their older
 * stamp, so the oldest stamp can trail the real previous tree by several
 * releases. The stamps are only the fallback, for a project that is not a
 * git checkout or whose committed pin already equals the target.
 */

import type { FirefoxProduct } from '../types/config.js';
import { exec } from '../utils/process.js';
import {
  compareFirefoxVersions,
  isObject,
  isValidFirefoxProduct,
  isValidFirefoxVersion,
} from '../utils/validation.js';

/** A `firefox.version` / `firefox.product` pair. */
export interface FirefoxPin {
  version: string;
  product?: FirefoxProduct;
}

/** Where the rebase's "from" label came from. */
export interface RebaseFromVersion extends FirefoxPin {
  /** `committed-pin`: the project's committed `fireforge.json`; `patch-stamps`: the oldest stamp. */
  origin: 'committed-pin' | 'patch-stamps';
}

/** Tally of the queue's `sourceVersion` stamps, oldest first. */
export interface PatchStampSpread {
  versions: string[];
  counts: Map<string, number>;
}

/**
 * Reads the `firefox` pin from `fireforge.json` as committed at the project
 * repository's HEAD. `HEAD:./fireforge.json` resolves relative to the
 * project root, so a project nested inside a larger repository works too.
 * Returns `undefined` when there is no repository, no commit, no committed
 * config, or no valid pin in it.
 */
export async function readCommittedFirefoxPin(
  projectRoot: string
): Promise<FirefoxPin | undefined> {
  const result = await exec('git', ['show', 'HEAD:./fireforge.json'], { cwd: projectRoot }).catch(
    () => undefined
  );
  if (result?.exitCode !== 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  const firefox = isObject(parsed) ? parsed['firefox'] : undefined;
  if (!isObject(firefox)) return undefined;
  const version = firefox['version'];
  if (typeof version !== 'string' || !isValidFirefoxVersion(version)) return undefined;
  const product = firefox['product'];
  return typeof product === 'string' && isValidFirefoxProduct(product)
    ? { version, product }
    : { version };
}

/** Counts the queue's stamps and orders them semantically (a lexical sort put 153.10.0esr before 153.2.0esr). */
export function tallyPatchStamps(stamps: readonly string[]): PatchStampSpread {
  const counts = new Map<string, number>();
  for (const stamp of stamps) counts.set(stamp, (counts.get(stamp) ?? 0) + 1);
  return { versions: [...counts.keys()].sort(compareFirefoxVersions), counts };
}

/** `"317 at 153.0esr, 5 at 153.3.0esr"`. */
export function formatPatchStampSpread(spread: PatchStampSpread): string {
  return spread.versions.map((v) => `${spread.counts.get(v)} at ${v}`).join(', ');
}

/**
 * Picks the rebase's "from": the committed pin when it differs from the
 * target, otherwise the oldest patch stamp (`oldestStampProduct` is that
 * stamp's recorded product, when any patch carries one).
 */
export function resolveRebaseFromVersion(
  target: string,
  committed: FirefoxPin | undefined,
  spread: PatchStampSpread,
  oldestStampProduct: FirefoxProduct | undefined
): RebaseFromVersion {
  if (committed !== undefined && committed.version !== target) {
    return { ...committed, origin: 'committed-pin' };
  }
  const oldest = spread.versions[0] ?? target;
  return {
    version: oldest,
    ...(oldestStampProduct !== undefined ? { product: oldestStampProduct } : {}),
    origin: 'patch-stamps',
  };
}
