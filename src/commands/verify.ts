// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge verify` — read-only fsck for the patch queue.
 *
 * Combines the manifest consistency check (orphan files, missing entries,
 * files-affected mismatch, duplicate entries) with the cross-patch lint
 * rules (duplicate /dev/null creation, forward imports). Does not run
 * `planExport` per patch — that is intentionally out of scope because it
 * would couple verify to engine state and make the command too slow to be
 * useful as a pre-flight gate. Engine-level patch application issues are
 * still covered by the existing `fireforge doctor` and `fireforge import`
 * paths.
 *
 * Exits non-zero when any error-severity finding is reported so CI can
 * treat the output as pass/fail.
 */

import { join } from 'node:path';

import { Command } from 'commander';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { collectFurnaceManagedPrefixes } from '../core/furnace-config.js';
import { isGitRepository } from '../core/git.js';
import { expandUntrackedDirectoryEntries, getWorkingTreeStatus } from '../core/git-status.js';
import { buildPatchQueueContext, lintPatchQueue } from '../core/patch-lint.js';
import { loadPatchesManifest, validatePatchesManifestConsistency } from '../core/patch-manifest.js';
import { evaluatePatchPolicy } from '../core/patch-policy.js';
import { collectPatchRegistrationReferences } from '../core/patch-registration-refs.js';
import { classifyFiles } from '../core/status-classify.js';
import { GeneralError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import { pathExists, readText } from '../utils/fs.js';
import { info, intro, outro, success, warn } from '../utils/logger.js';

/**
 * Reports duplicate `filesAffected` entries across patches — the manifest
 * consistency check only flags per-patch duplicates and orphan files, not
 * the case where two different patches claim the same path. `verify`
 * surfaces that here so it can be caught before `export`, `re-export`, or
 * `rebase` hit it.
 */
interface DanglingRegistrationIssue {
  patchFilename: string;
  targetPath: string;
  source: string;
}

interface VerifyIssueGroup {
  title: string;
  issues: string[];
  errorCount: number;
  warningCount: number;
}

export interface PatchQueueHealth {
  hasPatchesDirectory: boolean;
  groups: VerifyIssueGroup[];
  errorCount: number;
  warningCount: number;
}

/**
 * Walks each patch body in the manifest, extracts the set of
 * component-shaped registration references it adds (widget paths
 * implied by jar.mn + customElements.js; FTL paths implied by locale
 * jar.mn), and confirms every reference is either created by some
 * patch in the queue OR present as a tracked file in engine/. Any
 * unreachable reference is a dangling-registration error — the patch
 * registers a file that nothing in the world supplies, which fails at
 * install time.
 */
async function detectDanglingRegistrations(
  patchesDir: string,
  engineDir: string,
  patches: ReadonlyArray<{ filename: string; filesAffected: string[] }>
): Promise<DanglingRegistrationIssue[]> {
  // Aggregate the set of all paths that any patch in the queue is
  // responsible for (per `filesAffected`). We deliberately do NOT parse
  // individual patch bodies for new-file creations here: `filesAffected`
  // is already the contract manifest callers rely on, and
  // `validatePatchesManifestConsistency` has already ensured the two
  // are in sync. Using that list keeps this validator fast.
  const coveredByPatches = new Set<string>();
  for (const patch of patches) {
    for (const file of patch.filesAffected) {
      coveredByPatches.add(file);
    }
  }

  const issues: DanglingRegistrationIssue[] = [];
  for (const patch of patches) {
    const patchPath = join(patchesDir, patch.filename);
    if (!(await pathExists(patchPath))) continue;

    let body: string;
    try {
      body = await readText(patchPath);
    } catch {
      // Bad file read is surfaced by the manifest consistency check
      // already — skipping here avoids double-reporting the same issue.
      continue;
    }

    const refs = collectPatchRegistrationReferences(body);
    if (refs.length === 0) continue;

    for (const ref of refs) {
      if (coveredByPatches.has(ref.targetPath)) continue;
      // Engine existence check: if the target file is already present
      // in engine/ (e.g. upstream Firefox ships it, or a separate
      // baseline branch has it), the registration is not dangling.
      // We cannot sanely probe "is this tracked by git" without a git
      // round-trip; existence on disk is a close-enough proxy for
      // verify's read-only context.
      if (await pathExists(join(engineDir, ref.targetPath))) continue;
      issues.push({
        patchFilename: patch.filename,
        targetPath: ref.targetPath,
        source: ref.source,
      });
    }
  }

  return issues;
}

function detectCrossPatchFileClaims(
  manifestPatches: ReadonlyArray<{ filename: string; filesAffected: string[] }>
): Array<{ path: string; filenames: string[] }> {
  const claims = new Map<string, string[]>();
  for (const patch of manifestPatches) {
    for (const file of patch.filesAffected) {
      const existing = claims.get(file) ?? [];
      existing.push(patch.filename);
      claims.set(file, existing);
    }
  }
  const results: Array<{ path: string; filenames: string[] }> = [];
  for (const [path, filenames] of claims) {
    if (filenames.length > 1) {
      results.push({ path, filenames });
    }
  }
  return results;
}

async function detectWorktreeOwnershipDrift(
  projectRoot: string,
  engineDir: string,
  patchesDir: string,
  binaryName: string
): Promise<{ unowned: string[]; patchOwnedDrift: string[] }> {
  if (!(await pathExists(engineDir)) || !(await isGitRepository(engineDir))) {
    return { unowned: [], patchOwnedDrift: [] };
  }

  const entries = await expandUntrackedDirectoryEntries(
    engineDir,
    await getWorkingTreeStatus(engineDir)
  );
  const furnacePrefixes = await collectFurnaceManagedPrefixes(projectRoot);
  const classified = await classifyFiles(
    entries,
    engineDir,
    patchesDir,
    binaryName,
    furnacePrefixes
  );
  return {
    unowned: [
      ...new Set(
        classified
          .filter((entry) => entry.classification === 'unmanaged')
          .map((entry) => entry.file)
      ),
    ].sort(),
    patchOwnedDrift: [
      ...new Set(
        classified
          .filter((entry) => entry.classification === 'patch-owned-drift')
          .map((entry) => entry.file)
      ),
    ].sort(),
  };
}

/**
 * Collects the same queue-health findings reported by `fireforge verify`
 * without printing. Used by doctor recovery paths that need a read-only
 * "is this queue healthy?" decision before clearing stale state.
 */
export async function collectPatchQueueHealth(projectRoot: string): Promise<PatchQueueHealth> {
  const paths = getProjectPaths(projectRoot);
  const config = await loadConfig(projectRoot);
  if (!(await pathExists(paths.patches))) {
    return {
      hasPatchesDirectory: false,
      groups: [],
      errorCount: 0,
      warningCount: 0,
    };
  }

  const groups: VerifyIssueGroup[] = [];
  let errorCount = 0;
  let warningCount = 0;

  const consistencyIssues = await validatePatchesManifestConsistency(paths.patches);
  if (consistencyIssues.length > 0) {
    const issues = consistencyIssues.map((issue) => `[${issue.code}] ${issue.message}`);
    groups.push({
      title: `Manifest consistency issues (${consistencyIssues.length})`,
      issues,
      errorCount: consistencyIssues.length,
      warningCount: 0,
    });
    errorCount += consistencyIssues.length;
  }

  const manifest = await loadPatchesManifest(paths.patches);
  if (manifest) {
    const policyIssues = evaluatePatchPolicy(config, manifest);
    if (policyIssues.length > 0) {
      const policyErrors = policyIssues.filter((issue) => issue.severity === 'error').length;
      const policyWarnings = policyIssues.length - policyErrors;
      groups.push({
        title: `Patch policy issues (${policyIssues.length})`,
        issues: policyIssues.map((issue) => {
          const label = issue.severity === 'error' ? 'ERROR' : 'WARN';
          return `${label} [${issue.code}] ${issue.filename}: ${issue.message}`;
        }),
        errorCount: policyErrors,
        warningCount: policyWarnings,
      });
      errorCount += policyErrors;
      warningCount += policyWarnings;
    }

    const crossClaims = detectCrossPatchFileClaims(manifest.patches);
    if (crossClaims.length > 0) {
      groups.push({
        title: `Cross-patch filesAffected conflicts (${crossClaims.length})`,
        issues: crossClaims.map(
          (claim) => `${claim.path}  claimed by: ${claim.filenames.join(', ')}`
        ),
        errorCount: crossClaims.length,
        warningCount: 0,
      });
      errorCount += crossClaims.length;
    }
  }

  const ctx = await buildPatchQueueContext(paths.patches);
  const lintIssues = lintPatchQueue(ctx);
  if (lintIssues.length > 0) {
    const lintErrors = lintIssues.filter((issue) => issue.severity === 'error').length;
    const lintWarnings = lintIssues.filter((issue) => issue.severity === 'warning').length;
    groups.push({
      title: `Cross-patch lint issues (${lintIssues.length})`,
      issues: lintIssues.map((issue) => {
        const label =
          issue.severity === 'error' ? 'ERROR' : issue.severity === 'warning' ? 'WARN' : 'NOTICE';
        return `${label} [${issue.check}] ${issue.file}: ${issue.message}`;
      }),
      errorCount: lintErrors,
      warningCount: lintWarnings,
    });
    errorCount += lintErrors;
    warningCount += lintWarnings;
  }

  if (manifest) {
    const worktreeDrift = await detectWorktreeOwnershipDrift(
      projectRoot,
      paths.engine,
      paths.patches,
      config.binaryName
    );
    if (worktreeDrift.unowned.length > 0) {
      groups.push({
        title: `Unowned worktree changes (${worktreeDrift.unowned.length})`,
        issues: worktreeDrift.unowned.map(
          (file) =>
            `${file} is changed in engine/ but is not listed in any patch filesAffected entry`
        ),
        errorCount: 0,
        warningCount: worktreeDrift.unowned.length,
      });
      warningCount += worktreeDrift.unowned.length;
    }

    if (worktreeDrift.patchOwnedDrift.length > 0) {
      groups.push({
        title: `Patch-owned worktree drift (${worktreeDrift.patchOwnedDrift.length})`,
        issues: worktreeDrift.patchOwnedDrift.map(
          (file) =>
            `${file} is claimed by exactly one patch, but engine/ no longer matches that patch output`
        ),
        errorCount: 0,
        warningCount: worktreeDrift.patchOwnedDrift.length,
      });
      warningCount += worktreeDrift.patchOwnedDrift.length;
    }

    const registrationIssues = await detectDanglingRegistrations(
      paths.patches,
      paths.engine,
      manifest.patches
    );
    if (registrationIssues.length > 0) {
      groups.push({
        title: `Dangling registration references (${registrationIssues.length})`,
        issues: registrationIssues.map(
          (issue) =>
            `${issue.patchFilename}: registers ${issue.targetPath} via ${issue.source}, but no patch body or engine file supplies it`
        ),
        errorCount: registrationIssues.length,
        warningCount: 0,
      });
      errorCount += registrationIssues.length;
    }
  }

  return {
    hasPatchesDirectory: true,
    groups,
    errorCount,
    warningCount,
  };
}

/**
 * Runs the `verify` command: manifest consistency + cross-patch lint.
 * Read-only; exits non-zero on any error-severity finding.
 *
 * @param projectRoot - Project root directory
 */
export async function verifyCommand(projectRoot: string): Promise<void> {
  intro('FireForge Verify');

  const health = await collectPatchQueueHealth(projectRoot);
  if (!health.hasPatchesDirectory) {
    info('No patches directory. Nothing to verify.');
    outro('Verify clean');
    return;
  }

  for (const group of health.groups) {
    warn(`${group.title}:`);
    for (const issue of group.issues) {
      warn(`  ${issue}`);
    }
  }

  if (health.errorCount === 0 && health.warningCount === 0) {
    success('Patch queue is consistent.');
    outro('Verify clean');
    return;
  }

  info(`\nVerify: ${health.errorCount} error(s), ${health.warningCount} warning(s)`);
  if (health.errorCount > 0) {
    outro('Verify failed');
    throw new GeneralError(
      `fireforge verify found ${health.errorCount} error(s). Fix these before running export/import/rebase. Use "patch staged-dependency" for intentional staged imports, or preview "patch move-files" / "patch reorder --dry-run" / "re-export --files --dry-run" for ownership repairs.`
    );
  }
  outro('Verify passed with warnings');
}

/**
 * Registers the `verify` command on the CLI program.
 *
 * @param program - Commander root program
 * @param context - Shared CLI registration context
 */
export function registerVerify(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('verify')
    .description('Read-only fsck for the patch queue (manifest + cross-patch lint)')
    .action(
      withErrorHandling(async () => {
        await verifyCommand(getProjectRoot());
      })
    );
}
