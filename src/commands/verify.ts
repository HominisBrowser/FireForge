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

import { getProjectPaths } from '../core/config.js';
import { buildPatchQueueContext, lintPatchQueue } from '../core/patch-lint.js';
import { loadPatchesManifest, validatePatchesManifestConsistency } from '../core/patch-manifest.js';
import { collectPatchRegistrationReferences } from '../core/patch-registration-refs.js';
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

/**
 * Runs the `verify` command: manifest consistency + cross-patch lint.
 * Read-only; exits non-zero on any error-severity finding.
 *
 * @param projectRoot - Project root directory
 */
export async function verifyCommand(projectRoot: string): Promise<void> {
  intro('FireForge Verify');

  const paths = getProjectPaths(projectRoot);
  if (!(await pathExists(paths.patches))) {
    info('No patches directory. Nothing to verify.');
    outro('Verify clean');
    return;
  }

  let errorCount = 0;
  let warningCount = 0;

  // 1. Manifest consistency: orphan patch files, missing entries,
  // files-affected mismatch, duplicate entries, unparseable manifest.
  const consistencyIssues = await validatePatchesManifestConsistency(paths.patches);
  if (consistencyIssues.length > 0) {
    warn(`Manifest consistency issues (${consistencyIssues.length}):`);
    for (const issue of consistencyIssues) {
      warn(`  [${issue.code}] ${issue.message}`);
      errorCount += 1;
    }
  }

  // 2. Cross-patch file claims: two or more manifest entries listing the
  // same path in filesAffected. Not caught by per-patch consistency.
  const manifest = await loadPatchesManifest(paths.patches);
  if (manifest) {
    const crossClaims = detectCrossPatchFileClaims(manifest.patches);
    if (crossClaims.length > 0) {
      warn(`Cross-patch filesAffected conflicts (${crossClaims.length}):`);
      for (const claim of crossClaims) {
        warn(`  ${claim.path}  claimed by: ${claim.filenames.join(', ')}`);
        errorCount += 1;
      }
    }
  }

  // 3. Cross-patch lint: duplicate /dev/null creation + forward imports.
  const ctx = await buildPatchQueueContext(paths.patches);
  const lintIssues = lintPatchQueue(ctx);
  if (lintIssues.length > 0) {
    warn(`Cross-patch lint issues (${lintIssues.length}):`);
    for (const issue of lintIssues) {
      const label =
        issue.severity === 'error' ? 'ERROR' : issue.severity === 'warning' ? 'WARN' : 'NOTICE';
      warn(`  ${label} [${issue.check}] ${issue.file}: ${issue.message}`);
      if (issue.severity === 'error') errorCount += 1;
      else if (issue.severity === 'warning') warningCount += 1;
    }
  }

  // 4. Registration-consequence consistency: walk each patch body and
  // confirm that every widget / locale registration it adds has a
  // corresponding file body covered by the patch queue OR present in
  // the engine working tree. 2026-04-24 eval Finding 1: a patch
  // produced by `export-all --exclude-furnace` referenced
  // `toolkit/content/widgets/moz-qa-panel/*.mjs` via jar.mn /
  // customElements.js edits, but the source files themselves were
  // excluded from the patch. `verify` used to report "clean"; it now
  // flags each dangling reference as a `dangling-registration` error
  // naming the specific patch and target path.
  if (manifest) {
    const registrationIssues = await detectDanglingRegistrations(
      paths.patches,
      paths.engine,
      manifest.patches
    );
    if (registrationIssues.length > 0) {
      warn(`Dangling registration references (${registrationIssues.length}):`);
      for (const issue of registrationIssues) {
        warn(
          `  ${issue.patchFilename}: registers ${issue.targetPath} via ${issue.source}, but no patch body or engine file supplies it`
        );
        errorCount += 1;
      }
    }
  }

  if (errorCount === 0 && warningCount === 0) {
    success('Patch queue is consistent.');
    outro('Verify clean');
    return;
  }

  info(`\nVerify: ${errorCount} error(s), ${warningCount} warning(s)`);
  if (errorCount > 0) {
    outro('Verify failed');
    throw new GeneralError(
      `fireforge verify found ${errorCount} error(s). Fix these before running export/import/rebase.`
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
