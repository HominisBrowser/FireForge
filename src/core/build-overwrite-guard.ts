// SPDX-License-Identifier: EUPL-1.2
/**
 * Loud guard against silently reverting UNEXPORTED engine drift.
 *
 * `build-prepare` rewrites engine files from FireForge-owned sources before
 * every build: the branding tree, every Furnace-managed component, and
 * `mozconfig`. On a multi-session checkout that is a silent destructive
 * write — one session edits a file in `engine/` while another holds the
 * engine lock, the lock-holder's build rewrites it back to its patch
 * baseline, and the editing session's later `re-export --wait-lock`
 * captures a HYBRID file that every gate then passes.
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
import type { GitStatusEntry } from './git-base.js';
import { expandUntrackedDirectoryEntries, getWorkingTreeStatus } from './git-status.js';
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
 * Every path prefix build-prepare rewrites from a FireForge-owned source:
 * the branding tree plus every Furnace-managed prefix. (`mozconfig` is a
 * single file, not a prefix, and is tested separately.)
 */
function buildPrepareOwnedPrefixes(
  binaryName: string,
  furnacePrefixes: ReadonlySet<string>
): string[] {
  return [`browser/branding/${binaryName}/`, ...furnacePrefixes];
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
  for (const prefix of buildPrepareOwnedPrefixes(binaryName, furnacePrefixes)) {
    if (file === prefix || file.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Narrows the status entries to the ones build-prepare can overwrite,
 * expanding collapsed untracked directories on the way.
 *
 * Git reports a WHOLLY untracked directory as a single `?? dir/` entry
 * rather than listing the files under it. A directory entry has no content
 * to compare, so `classifyFiles` matches it against neither a patch body nor
 * the pristine baseline and buckets it `unmanaged` — an at-risk
 * classification. Expanding here is what keeps this guard and
 * `status --unmanaged`, which expands, agreeing by construction.
 *
 * Expansion is scoped to build-prepare-owned prefixes on both sides of the
 * walk: a collapsed directory that merely CONTAINS an owned prefix
 * (`components/` when `components/custom/` is Furnace-managed) is rewritten
 * to the owned prefixes beneath it, so the enumeration never walks an
 * unrelated subtree and never trips the per-directory expansion cap.
 */
async function collectOverwrittenEntries(
  engineDir: string,
  status: readonly GitStatusEntry[],
  binaryName: string,
  furnacePrefixes: ReadonlySet<string>
): Promise<GitStatusEntry[]> {
  const ownedPrefixes = buildPrepareOwnedPrefixes(binaryName, furnacePrefixes);
  const candidates: GitStatusEntry[] = [];

  for (const entry of status) {
    if (isOverwrittenByBuildPrepare(entry.file, binaryName, furnacePrefixes)) {
      candidates.push(entry);
      continue;
    }
    if (!entry.isUntracked || !entry.file.endsWith('/')) continue;
    // A collapsed untracked ancestor of an owned prefix: walk only the
    // owned subtrees under it, never the whole directory.
    for (const prefix of ownedPrefixes) {
      if (prefix.startsWith(entry.file)) {
        candidates.push({ ...entry, file: prefix });
      }
    }
  }

  if (candidates.length === 0) return [];

  const expanded = await expandUntrackedDirectoryEntries(engineDir, candidates);
  // Re-test after expansion: an ancestor rewrite can only widen, and a
  // directory that survived expansion (nothing untracked under it any
  // more) carries no content to classify.
  return expanded.filter(
    (entry) =>
      !entry.file.endsWith('/') &&
      isOverwrittenByBuildPrepare(entry.file, binaryName, furnacePrefixes)
  );
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
    const candidates = await collectOverwrittenEntries(
      paths.engine,
      status,
      config.binaryName,
      furnacePrefixes
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
    `This build is about to rewrite ${files.length} engine file(s) from FireForge-owned ` +
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
