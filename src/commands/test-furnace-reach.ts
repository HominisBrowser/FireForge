// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge test --build --furnace-apply reached`: deploy only the Furnace
 * components a requested test reaches.
 *
 * The pre-test build's Furnace apply runs over the whole `components/`
 * tree, so on a shared engine a peer's `test --build` deployed every
 * session's undeployed component edits into the shared objdir, including
 * edits another session was holding back for a before-capture. `reached`
 * keeps the apply to the components the run can observe and names the rest.
 *
 * "Reaches" is textual, and errs towards applying: a component is reached
 * when a requested test file, a `head*.js` beside it, or any test file
 * under a requested directory names the component's tag, or when the test
 * path itself names it. A component no test names cannot change what the
 * run observes through its own code, so leaving its undeployed edit out
 * keeps the run honest about what it packaged.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { listStaleFurnaceComponents } from '../core/furnace-staleness.js';
import type { TestOptions } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { verbose } from '../utils/logger.js';

/** Files read per run, so a huge directory request cannot stall the build. */
const MAX_SCANNED_FILES = 4000;
const SCANNED_EXTENSIONS = /\.(?:m?js|html|xhtml|toml|ini)$/;

/** The effective Furnace apply mode for a pre-test build. */
export type FurnaceApplyMode = 'all' | 'reached' | 'none';

/**
 * Resolves the mode from the flag and `test.furnaceApply`. `false`
 * (`--no-furnace-apply`) is `none`.
 */
export function resolveFurnaceApplyMode(
  options: TestOptions,
  config: FireForgeConfig
): FurnaceApplyMode {
  if (options.furnaceApply === false) return 'none';
  if (typeof options.furnaceApply === 'string') return options.furnaceApply;
  return config.test?.furnaceApply ?? 'all';
}

async function collectFiles(path: string, out: string[]): Promise<void> {
  if (out.length >= MAX_SCANNED_FILES) return;
  let info;
  try {
    info = await stat(path);
  } catch {
    return;
  }
  if (info.isFile()) {
    if (SCANNED_EXTENSIONS.test(path)) out.push(path);
    return;
  }
  if (!info.isDirectory()) return;
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch {
    return;
  }
  for (const entry of entries.sort()) {
    if (out.length >= MAX_SCANNED_FILES) return;
    await collectFiles(join(path, entry), out);
  }
}

/** The files whose text decides reach: the request plus `head*.js` beside each file. */
async function reachFiles(engineDir: string, testPaths: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const path of testPaths) {
    const absolute = join(engineDir, path);
    await collectFiles(absolute, files);
    try {
      if ((await stat(absolute)).isFile()) {
        const dir = dirname(absolute);
        for (const entry of await readdir(dir)) {
          if (/^head.*\.js$/.test(entry)) files.push(join(dir, entry));
        }
      }
    } catch {
      // A missing path is refused later by the path-existence check.
    }
  }
  return [...new Set(files)];
}

/**
 * The stale components a request reaches, and the stale ones it does not.
 *
 * @param projectRoot - Project root
 * @param engineDir - Absolute engine directory
 * @param testPaths - Engine-relative requested paths
 */
export async function partitionReachedComponents(
  projectRoot: string,
  engineDir: string,
  testPaths: readonly string[]
): Promise<{ reached: string[]; skipped: string[] }> {
  let stale: string[];
  try {
    stale = await listStaleFurnaceComponents(projectRoot);
  } catch (error: unknown) {
    verbose(`Furnace pending-edit probe failed: ${toError(error).message}`);
    return { reached: [], skipped: [] };
  }
  if (stale.length === 0) return { reached: [], skipped: [] };
  const names = new Set<string>();
  for (const path of testPaths) {
    for (const name of stale) if (path.includes(name)) names.add(name);
  }
  for (const file of await reachFiles(engineDir, testPaths)) {
    if (names.size === stale.length) break;
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const name of stale) {
      if (text.includes(name) || basename(file).includes(name)) names.add(name);
    }
  }
  return {
    reached: stale.filter((name) => names.has(name)),
    skipped: stale.filter((name) => !names.has(name)),
  };
}
