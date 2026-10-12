// SPDX-License-Identifier: EUPL-1.2
/**
 * Loud guard against silently reverting unexported engine drift.
 *
 * `build-prepare` rewrites engine files from FireForge-owned sources before
 * every build: the branding tree, every Furnace-managed component, and
 * `mozconfig`. On a multi-session checkout that is a silent destructive
 * write: one session edits a file in `engine/` while another holds the
 * engine lock, the lock-holder's build rewrites it back to its patch
 * baseline, and the editing session's later `re-export --wait-lock`
 * captures a hybrid file that every gate then passes.
 *
 * This guard runs before the writes, classifies the engine's dirty files
 * with the same classifier `fireforge status` uses, and reports the ones
 * whose content is explained by neither a patch body nor the pristine
 * baseline. Advisory by default (a warning naming every file), refusing
 * under an explicit flag.
 *
 * A deployed Furnace file is checked against its component source as well
 * (`deployed-unexported`): when the engine copy equals the Furnace-composed
 * current source, differs from it only inside generated fragment
 * expansions, or is exactly Furnace's last recorded deployment, the
 * overwrite destroys nothing that is not a component source, so it is safe
 * even though no patch records it yet. Without this, peers' deployed but
 * unexported widgets refused every belted build on a shared checkout.
 */

import type { FireForgeConfig } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { verbose } from '../utils/logger.js';
import { getProjectPaths } from './config.js';
import {
  type DeployedSourceMatch,
  matchDeployedComponentFiles,
} from './furnace-composed-source.js';
import { collectFurnaceManagedPrefixes } from './furnace-config.js';
import type { GitStatusEntry } from './git-base.js';
import { expandUntrackedDirectoryEntries, getWorkingTreeStatus } from './git-status.js';
import { type ClassifiedFile, classifyFiles } from './status-classify.js';

/**
 * Classifications whose on-disk content is explained by neither a patch
 * body nor the pristine baseline, which is the content a build-prepare
 * overwrite would destroy without a record anywhere.
 *
 * `patch-backed` and `furnace` are excluded because their content is the
 * recorded state. `branding` is excluded because the branding writer
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
 * A deployed Furnace file no patch records yet whose content is its
 * component source's (see {@link DeployedSourceMatch}), so the overwrite is
 * safe. Its patch still owes a re-export.
 */
export interface DeployedUnexportedFile {
  file: string;
  classification: 'deployed-unexported';
  match: DeployedSourceMatch;
  owner?: string | undefined;
}

/** Outcome of {@link assessUnexportedDrift}. */
export interface UnexportedDriftAssessment {
  /** Files whose content the overwrite would destroy unrecorded. */
  atRisk: UnexportedDriftAtRisk[];
  /** Files the overwrite rewrites from their own component source. */
  deployedUnexported: DeployedUnexportedFile[];
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
 * Git reports a wholly untracked directory as a single `?? dir/` entry
 * rather than listing the files under it. A directory entry has no content
 * to compare, so `classifyFiles` matches it against neither a patch body nor
 * the pristine baseline and buckets it `unmanaged`, an at-risk
 * classification. Expanding here keeps this guard in agreement with
 * `status --unmanaged`, which also expands.
 *
 * Expansion is scoped to build-prepare-owned prefixes on both sides of the
 * walk: a collapsed directory that merely contains an owned prefix
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
 * Splits classified at-risk files into the ones whose engine content is a
 * Furnace deployment of their component source and the rest.
 *
 * Fail-closed: when the source comparison cannot run, every file stays at
 * risk, exactly as before the comparison existed.
 */
async function separateDeployedUnexported(
  projectRoot: string,
  engineDir: string,
  atRisk: UnexportedDriftAtRisk[]
): Promise<UnexportedDriftAssessment> {
  let matches: Map<string, DeployedSourceMatch>;
  try {
    matches = await matchDeployedComponentFiles(
      projectRoot,
      engineDir,
      atRisk.map((entry) => entry.file)
    );
  } catch (error: unknown) {
    verbose(
      `Unexported-drift guard could not compare component sources: ${toError(error).message}`
    );
    return { atRisk, deployedUnexported: [] };
  }
  const deployedUnexported: DeployedUnexportedFile[] = [];
  const remaining: UnexportedDriftAtRisk[] = [];
  for (const entry of atRisk) {
    const match = matches.get(entry.file);
    if (match === undefined) {
      remaining.push(entry);
    } else {
      deployedUnexported.push({
        file: entry.file,
        classification: 'deployed-unexported',
        match,
        owner: entry.owner,
      });
    }
  }
  return { atRisk: remaining, deployedUnexported };
}

/**
 * Finds engine files that build-prepare is about to overwrite and whose
 * current content is recorded nowhere.
 *
 * Fail-open: any probe failure is reported verbosely and yields an empty
 * list. A build must not fail because an advisory guard could not run.
 *
 * @internal The at-risk half of {@link assessUnexportedDrift}, kept for the
 * guard's tests; build-prepare consumes the full assessment.
 *
 * @param projectRoot - Project root
 * @param config - Loaded FireForge config (reads `binaryName`)
 * @returns At-risk files, sorted by path
 */
export async function findUnexportedDriftAtRisk(
  projectRoot: string,
  config: FireForgeConfig
): Promise<UnexportedDriftAtRisk[]> {
  return (await assessUnexportedDrift(projectRoot, config)).atRisk;
}

/**
 * Classifies the engine files build-prepare is about to overwrite into the
 * ones whose content is recorded nowhere (`atRisk`) and the deployed
 * Furnace files no patch records yet whose content is their component
 * source's (`deployedUnexported`, safe to overwrite).
 *
 * Fail-open like {@link findUnexportedDriftAtRisk}: a probe failure yields
 * an empty assessment.
 *
 * @param projectRoot - Project root
 * @param config - Loaded FireForge config (reads `binaryName`)
 * @returns Both lists, sorted by path
 */
export async function assessUnexportedDrift(
  projectRoot: string,
  config: FireForgeConfig
): Promise<UnexportedDriftAssessment> {
  const empty: UnexportedDriftAssessment = { atRisk: [], deployedUnexported: [] };
  const paths = getProjectPaths(projectRoot);
  try {
    const status = await getWorkingTreeStatus(paths.engine);
    if (status.length === 0) return empty;
    const furnacePrefixes = await collectFurnaceManagedPrefixes(projectRoot);
    const candidates = await collectOverwrittenEntries(
      paths.engine,
      status,
      config.binaryName,
      furnacePrefixes
    );
    if (candidates.length === 0) return empty;

    const classified = await classifyFiles(
      candidates,
      paths.engine,
      paths.patches,
      config.binaryName,
      furnacePrefixes
    );
    const atRisk = classified
      .filter((entry) => AT_RISK_CLASSIFICATIONS.has(entry.classification))
      .map((entry) => ({
        file: entry.file,
        classification: entry.classification,
        owner: entry.owner,
      }))
      .sort((a, b) => a.file.localeCompare(b.file));
    if (atRisk.length === 0 || furnacePrefixes.size === 0) return { ...empty, atRisk };
    return await separateDeployedUnexported(projectRoot, paths.engine, atRisk);
  } catch (error: unknown) {
    verbose(`Unexported-drift guard could not run: ${toError(error).message}`);
    return empty;
  }
}

/**
 * Renders the informational note for deployed Furnace files the overwrite
 * rewrites from their own component source: safe for this build, but their
 * patches still owe a re-export.
 */
export function formatDeployedUnexportedNote(files: readonly DeployedUnexportedFile[]): string {
  const rows = files.map((entry) => {
    const owner = entry.owner !== undefined ? ` (owned by ${entry.owner})` : '';
    return `  ${entry.file} [deployed-unexported: ${entry.match}]${owner}`;
  });
  return (
    `${files.length} deployed Furnace file(s) differ from their patch body but are a Furnace ` +
    'deployment of their component source, so this overwrite loses nothing; re-export their ' +
    `patches when the component work is done:\n${rows.join('\n')}`
  );
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
