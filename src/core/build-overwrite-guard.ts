// SPDX-License-Identifier: EUPL-1.2
/**
 * Loud guard against silently reverting UNEXPORTED engine drift.
 *
 * `build-prepare` rewrites engine files from FireForge-owned sources
 * before every build: the branding tree, every Furnace-managed component,
 * and `mozconfig`. On a multi-session checkout that is a silent
 * destructive write. The recorded incident: one session edited a file in
 * `engine/` while another held the engine lock; the lock-holder's build
 * rewrote the file back to its patch baseline; the editing session's later
 * `re-export --wait-lock` then captured a HYBRID file — and every gate
 * passed on the hybrid capture. Only a hand-run grep of the patch body
 * caught it.
 *
 * The `setupBranding` half of this class was closed in `31fdf744` (the
 * branding writer preserves unmanaged lines). The general shape — any
 * build-prepare overwrite destroying local drift that no patch records —
 * stayed silent, and silence is what made the hybrid capture possible.
 *
 * This guard runs BEFORE the writes, classifies the engine's dirty files
 * with the same classifier `fireforge status` uses, and reports the ones
 * whose content is explained by neither a patch body nor the pristine
 * baseline. Advisory by default (a warning naming every file), refusing
 * under an explicit flag.
 */

import type { FireForgeConfig } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { verbose } from '../utils/logger.js';
import { getProjectPaths } from './config.js';
import { collectFurnaceManagedPrefixes } from './furnace-config.js';
import { getWorkingTreeStatus } from './git-status.js';
import { type ClassifiedFile, classifyFiles } from './status-classify.js';

/**
 * Classifications whose on-disk content is explained by NEITHER a patch
 * body nor the pristine baseline — exactly the content a build-prepare
 * overwrite would destroy without a record anywhere.
 *
 * `patch-backed` and `furnace` are excluded because their content IS the
 * recorded state; `branding` is excluded because the branding writer
 * preserves unmanaged lines rather than overwriting them.
 */
const AT_RISK_CLASSIFICATIONS = new Set(['unmanaged', 'patch-owned-drift', 'conflict']);

/** One file whose unexported content a build-prepare overwrite would destroy. */
export interface UnexportedDriftAtRisk {
  file: string;
  classification: ClassifiedFile['classification'];
  owner?: string | undefined;
}

/**
 * True when `file` sits under a path build-prepare rewrites from a
 * FireForge-owned source: the branding tree, a Furnace-managed prefix, or
 * the generated `mozconfig`.
 */
function isOverwrittenByBuildPrepare(
  file: string,
  binaryName: string,
  furnacePrefixes: ReadonlySet<string>
): boolean {
  if (file === 'mozconfig') return true;
  if (file.startsWith(`browser/branding/${binaryName}/`)) return true;
  for (const prefix of furnacePrefixes) {
    if (file === prefix || file.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Finds engine files that build-prepare is about to overwrite and whose
 * current content is recorded nowhere.
 *
 * Fail-open: any probe failure is reported verbosely and yields an empty
 * list. A build must not fail because an advisory guard could not run.
 *
 * @param projectRoot - Project root
 * @param config - Loaded FireForge config (reads `binaryName`)
 * @returns At-risk files, sorted by path
 */
export async function findUnexportedDriftAtRisk(
  projectRoot: string,
  config: FireForgeConfig
): Promise<UnexportedDriftAtRisk[]> {
  const paths = getProjectPaths(projectRoot);
  try {
    const status = await getWorkingTreeStatus(paths.engine);
    if (status.length === 0) return [];
    const furnacePrefixes = await collectFurnaceManagedPrefixes(projectRoot);
    const candidates = status.filter((entry) =>
      isOverwrittenByBuildPrepare(entry.file, config.binaryName, furnacePrefixes)
    );
    if (candidates.length === 0) return [];

    const classified = await classifyFiles(
      candidates,
      paths.engine,
      paths.patches,
      config.binaryName,
      furnacePrefixes
    );
    return classified
      .filter((entry) => AT_RISK_CLASSIFICATIONS.has(entry.classification))
      .map((entry) => ({
        file: entry.file,
        classification: entry.classification,
        owner: entry.owner,
      }))
      .sort((a, b) => a.file.localeCompare(b.file));
  } catch (error: unknown) {
    verbose(`Unexported-drift guard could not run: ${toError(error).message}`);
    return [];
  }
}

/**
 * Renders the operator-facing warning (or refusal body) naming every file
 * whose unexported content the build is about to overwrite.
 */
export function formatUnexportedDriftWarning(files: readonly UnexportedDriftAtRisk[]): string {
  const rows = files.map((entry) => {
    const owner = entry.owner !== undefined ? ` (owned by ${entry.owner})` : '';
    return `  ${entry.file} [${entry.classification}]${owner}`;
  });
  return (
    `This build is about to rewrite ${String(files.length)} engine file(s) from FireForge-owned ` +
    'sources, and their current content matches NEITHER a patch body NOR the pristine ' +
    'baseline — so the edits below are recorded nowhere and the build will destroy them:\n' +
    `${rows.join('\n')}\n\n` +
    'On a multi-session checkout this is how a hybrid capture happens: the overwrite lands, ' +
    "the editing session's later re-export captures a half-reverted file, and every gate " +
    'passes on it.\n\n' +
    'Export the edits first (`fireforge re-export <patch>`, or `fireforge export` for new ' +
    'work), or pass --refuse-unexported-drift to make this a hard stop in scripted runs.'
  );
}
