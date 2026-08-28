// SPDX-License-Identifier: EUPL-1.2
/**
 * The patch-manifest consistency check and its two repair paths, split out of
 * `doctor.ts` for the line budget. Exports a single `DoctorCheckDefinition`
 * consumed by the doctor registry; no registrar is exported and none is wanted.
 */

import {
  type FilesAffectedRepair,
  type PatchManifestConsistencyIssue,
  rebuildPatchesManifest,
  recommendManifestRepair,
  repairPatchesFilesAffected,
  validatePatchesManifestConsistency,
} from '../core/patch-manifest.js';
import { FireForgeError } from '../errors/base.js';
import type { DoctorCheck } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { info, warn } from '../utils/logger.js';
import { resolveWaitLockSeconds } from '../utils/options.js';
import type { DoctorCheckContext, DoctorCheckDefinition } from './doctor-check-core.js';
import { failure, ok, warning } from './doctor-check-core.js';

const CHECK_NAME = 'Patch manifest consistency';

/** Runs the narrow `filesAffected` repair over the drifted rows. */
async function runFilesAffectedRepair(
  ctx: DoctorCheckContext,
  issues: readonly PatchManifestConsistencyIssue[]
): Promise<DoctorCheck> {
  const drifted = issues.filter((issue) => issue.code === 'files-affected-mismatch');
  const otherCodes = [
    ...new Set(
      issues.filter((issue) => issue.code !== 'files-affected-mismatch').map((issue) => issue.code)
    ),
  ].sort((left, right) => left.localeCompare(right));

  if (drifted.length === 0) {
    return failure(
      CHECK_NAME,
      `--repair-files-affected has nothing to repair: no filesAffected drift, but ${issues.length} ` +
        `other issue(s) remain (${otherCodes.join(', ')}).`,
      recommendManifestRepair(issues)
    );
  }

  const dryRun = ctx.options.dryRun === true;
  const result = await repairPatchesFilesAffected(
    ctx.paths.patches,
    drifted.map((issue) => issue.filename),
    {
      waitLockSeconds: resolveWaitLockSeconds(ctx.options.waitLock),
      command: 'doctor --repair-files-affected',
      dryRun,
    }
  );

  for (const repair of result.repairs) {
    info(`  ${describeFilesAffectedRepair(repair, dryRun)}`);
  }
  for (const filename of result.skippedFilenames) {
    warn(
      `Skipped ${filename}: it has no manifest row, or no patch file on disk. ` +
        'That is a different consistency issue — re-run doctor without --repair-files-affected ' +
        'to see it reported.'
    );
  }

  if (result.written) {
    ctx.mutations.push(
      `patches/patches.json — filesAffected corrected on ${describeCount(result.repairs.length)} (--repair-files-affected)`
    );
  }

  const remaining =
    otherCodes.length > 0
      ? ` ${otherCodes.length} other issue type(s) remain: ${otherCodes.join(', ')}.`
      : '';
  if (otherCodes.length > 0) {
    return failure(
      CHECK_NAME,
      `${summarizeFilesAffected(result.repairs.length, dryRun)}${remaining}`,
      recommendManifestRepair(issues.filter((issue) => issue.code !== 'files-affected-mismatch'))
    );
  }
  return warning(CHECK_NAME, summarizeFilesAffected(result.repairs.length, dryRun));
}

function describeFilesAffectedRepair(repair: FilesAffectedRepair, dryRun: boolean): string {
  const verb = dryRun ? 'would set' : 'set';
  return `${repair.filename}: ${verb} filesAffected to ${repair.after.length} file(s) (was ${repair.before.length}).`;
}

function summarizeFilesAffected(count: number, dryRun: boolean): string {
  if (count === 0) return 'No filesAffected drift to repair.';
  return dryRun
    ? `Dry run — would correct filesAffected on ${describeCount(count)}. Nothing was written.`
    : `Corrected filesAffected on ${describeCount(count)}. No other manifest field was touched.`;
}

function describeCount(count: number): string {
  return `${count} patch${count === 1 ? '' : 'es'}`;
}

/** Runs the whole-manifest rebuild. */
async function runManifestRebuild(ctx: DoctorCheckContext): Promise<DoctorCheck> {
  // Repair stamps sourceEsrVersion into every recovered entry. If the
  // earlier "fireforge.json is valid" check failed, ctx.config is
  // undefined and we must refuse rather than fabricate a fallback —
  // persisting 'unknown' into manifest metadata is hard to reverse
  // and would mislead every later command that reads it.
  if (!ctx.config) {
    return failure(
      CHECK_NAME,
      'Cannot repair patches.json: fireforge.json could not be loaded, so the Firefox version to stamp into recovered manifest entries is unknown.',
      'Fix the fireforge.json errors reported above and re-run "fireforge doctor --repair-patches-manifest". ' +
        'If the drift is only in filesAffected, "fireforge doctor --repair-files-affected" needs no config.'
    );
  }

  const dryRun = ctx.options.dryRun === true;
  const repaired = await rebuildPatchesManifest(ctx.paths.patches, ctx.config.firefox.version, {
    waitLockSeconds: resolveWaitLockSeconds(ctx.options.waitLock),
    command: 'doctor --repair-patches-manifest',
    dryRun,
    ...(ctx.options.allowMetadataLoss === true ? { allowMetadataLoss: true } : {}),
  });

  // The repair path must not silently overwrite human-written
  // descriptions on recovered entries, which leaves the queue less
  // trustworthy as an audit trail. The rebuilder returns the list of
  // filenames whose metadata was entirely invented, named explicitly
  // here so the operator knows which patches to review. Entries that
  // WERE preserved (only `filesAffected` / ordering drifted) are not
  // flagged.
  for (const filename of repaired.recoveredFilenames) {
    // Telling the operator to hand-edit patches.json contradicts the
    // README and downstream docs, which treat the manifest as
    // FireForge-owned. Point at the existing `re-export` / `export`
    // workflow so the fix stays inside the tool: re-exporting the
    // same files with an explicit `--description` overwrites the
    // recovered entry with operator-supplied metadata and supersedes
    // the mtime-based createdAt stamp.
    warn(
      `Recovered manifest entry for ${filename} with generic description and mtime-based createdAt. ` +
        'Re-export the affected files with `fireforge re-export <filename> --description "<your description>"` ' +
        '(or `fireforge export <paths...> --name <name> --category <category> --description "<your description>"`) ' +
        'to overwrite the reconstructed metadata, or accept the generic description if the original text is not recoverable. ' +
        'Avoid hand-editing patches.json — FireForge owns that file and will regenerate it on the next manifest consistency pass.'
    );
  }
  // A row whose patch file is gone is dropped by the rebuild. That is
  // correct — the patch file is the source of truth — but a manifest that
  // quietly loses rows is exactly what makes a repair hard to audit
  // afterwards, so each one is named.
  for (const filename of repaired.droppedFilenames) {
    warn(
      `Dropped the manifest entry for ${filename}: no such patch file on disk. ` +
        'Restore the .patch file and re-run the repair if the entry should have survived.'
    );
  }

  if (repaired.written) {
    ctx.mutations.push(
      'patches/patches.json — rebuilt from the on-disk patch files (--repair-patches-manifest)'
    );
  }

  const patchCount = repaired.manifest.patches.length;
  const recovered =
    repaired.recoveredFilenames.length > 0
      ? ` (${repaired.recoveredFilenames.length} with reconstructed metadata — see warnings above)`
      : '';
  return warning(
    CHECK_NAME,
    dryRun
      ? `Dry run — would rebuild patches.json from ${describeCount(patchCount)}${recovered}. Nothing was written.`
      : `Rebuilt patches.json from ${describeCount(patchCount)}${recovered}. Review recovered metadata before release.`
  );
}

/** Patch manifest consistency check, with its opt-in repair paths. */
export const PATCH_MANIFEST_CONSISTENCY_CHECK: DoctorCheckDefinition = {
  name: CHECK_NAME,
  dependsOn: ['fireforge.json is valid'],
  run: async (ctx) => {
    if (!(await pathExists(ctx.paths.patches))) {
      return [];
    }

    const issues = await validatePatchesManifestConsistency(ctx.paths.patches);
    if (issues.length === 0) {
      return ok(CHECK_NAME);
    }

    const wantsFilesAffected = ctx.options.repairFilesAffected === true;
    const wantsRebuild = ctx.options.repairPatchesManifest === true;
    if (!wantsFilesAffected && !wantsRebuild) {
      return failure(
        CHECK_NAME,
        issues.map((issue) => issue.message).join(' '),
        recommendManifestRepair(issues)
      );
    }

    try {
      return wantsFilesAffected
        ? await runFilesAffectedRepair(ctx, issues)
        : await runManifestRebuild(ctx);
    } catch (err: unknown) {
      const error = toError(err);
      // A refusal from the repair itself already carries the remedy that
      // fits it (which flag, which file to fix). Appending the generic hint
      // under it buries the specific one and reads as a second, vaguer
      // instruction. Only an unexpected throw gets the generic hint.
      return error instanceof FireForgeError
        ? failure(CHECK_NAME, error.message)
        : failure(
            CHECK_NAME,
            error.message,
            'Repair failed. Fix the underlying patch metadata issue and retry the doctor command.'
          );
    }
  },
};
