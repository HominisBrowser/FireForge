// SPDX-License-Identifier: EUPL-1.2
/**
 * Edits the stale-build preflight must not count. A test file the build
 * never packages is restaged by `mach test` at dispatch, and a file whose
 * every objdir copy is a symlink back to the edited source is already what
 * the runtime reads. Refusing on either made every iteration on a test (or
 * on symlinked chrome) pay a packaging pass or reach for
 * `--allow-stale-build`, the flag whose refusal text says not to.
 */

import { readdir } from 'node:fs/promises';

import { isTestPath } from './build-audit-resolve.js';
import {
  classifyRuntimeDelivery,
  type InstallManifestIndex,
  loadInstallManifestIndex,
} from './objdir-install-manifests.js';

/** A changed path the preflight does not count as stale, and why. */
export interface StaleExemption {
  path: string;
  /**
   * `symlinked`: every objdir copy is a symlink to the edited source.
   * `test-only`: a test file the build does not package, restaged at dispatch.
   */
  why: 'symlinked' | 'test-only';
}

/** The single `obj-*` directory under the engine, or undefined when zero or several exist. */
export async function findSingleObjDir(engineDir: string): Promise<string | undefined> {
  try {
    const entries = await readdir(engineDir, { withFileTypes: true });
    const objDirs = entries.filter((entry) => entry.isDirectory() && entry.name.startsWith('obj-'));
    return objDirs.length === 1 ? objDirs[0]?.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The objdir's install-manifest index, or undefined when there is no single
 * objdir or nothing in it is readable.
 * @param engineDir - Absolute engine directory
 */
export async function loadEngineInstallIndex(
  engineDir: string
): Promise<InstallManifestIndex | undefined> {
  const objDir = await findSingleObjDir(engineDir);
  return objDir === undefined ? undefined : loadInstallManifestIndex(engineDir, objDir);
}

/**
 * Splits changed packageable paths into the ones that make the packaged
 * runtime stale and the ones it already serves. Without a readable objdir
 * index every path stays stale, the behaviour before the exemption existed.
 *
 * @param engineDir - Absolute engine directory
 * @param paths - Changed engine-relative paths, already fingerprint-filtered
 */
export async function partitionStaleCandidates(
  engineDir: string,
  paths: readonly string[]
): Promise<{ stale: string[]; exempt: StaleExemption[] }> {
  if (paths.length === 0) return { stale: [], exempt: [] };
  const index = await loadEngineInstallIndex(engineDir);
  if (index === undefined) return { stale: [...paths], exempt: [] };
  const stale: string[] = [];
  const exempt: StaleExemption[] = [];
  for (const path of paths) {
    const delivery = await classifyRuntimeDelivery(index, engineDir, path);
    if (delivery === 'live') exempt.push({ path, why: 'symlinked' });
    else if (delivery === 'at-dispatch' || (delivery === 'unlisted' && isTestPath(path))) {
      exempt.push({ path, why: 'test-only' });
    } else stale.push(path);
  }
  return { stale, exempt };
}

/** Renders exemptions for a notice or refusal: `a (symlinked), b (test file)`. */
export function formatStaleExemptions(exempt: readonly StaleExemption[], limit = 10): string {
  const head = exempt
    .slice(0, limit)
    .map(({ path, why }) =>
      why === 'symlinked'
        ? `${path} (objdir symlink to the source)`
        : `${path} (test file, restaged at dispatch)`
    );
  const extra = exempt.length - head.length;
  return head.join(', ') + (extra > 0 ? `, … (+${extra} more)` : '');
}
