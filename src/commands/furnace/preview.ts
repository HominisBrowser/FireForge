// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { getProjectPaths } from '../../core/config.js';
import { applyAllComponents, type ApplyAllComponentsResult } from '../../core/furnace-apply.js';
import {
  furnaceConfigExists,
  loadFurnaceConfig,
  updateFurnaceState,
} from '../../core/furnace-config.js';
import { runFurnaceMutation } from '../../core/furnace-operation.js';
import { restoreRollbackJournal, type RollbackJournal } from '../../core/furnace-rollback.js';
import { countEntriesWithBlockingStepErrors } from '../../core/furnace-step-errors.js';
import { cleanStories, syncStories } from '../../core/furnace-stories.js';
import { hasBuildArtifacts, runMach, runMachCapture } from '../../core/mach.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnacePreviewOptions } from '../../types/commands/index.js';
import { toError } from '../../utils/errors.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, outro, spinner, warn } from '../../utils/logger.js';

/**
 * Runs the two teardown steps — `cleanStories` and the rollback-journal
 * restore — independently, collecting whatever errors either step throws.
 * Both steps must run regardless of the other's outcome, because each
 * operates on a different part of engine state and skipping one leaves
 * the engine in a worse position than a single-step failure.
 *
 * Extracted from `furnacePreviewCommand` so the main function stays
 * under the `max-lines-per-function` threshold and so the teardown
 * contract is explicit in one place.
 *
 * @returns Collected teardown errors, or an empty array if both steps
 *          succeeded (or no journal was ever created).
 */
async function runPreviewTeardown(
  engineDir: string,
  storiesCleanupRequired: boolean,
  journal: RollbackJournal | undefined
): Promise<Error[]> {
  const errors: Error[] = [];

  if (storiesCleanupRequired) {
    try {
      await cleanStories(engineDir);
    } catch (error: unknown) {
      const wrapped = toError(error);
      errors.push(new Error(`Story cleanup: ${wrapped.message}`));
    }
  }

  if (journal) {
    try {
      await restoreRollbackJournal(journal);
    } catch (error: unknown) {
      const wrapped = toError(error);
      errors.push(new Error(`Journal restore: ${wrapped.message}`));
    }
  }

  return errors;
}

/**
 * Reports staging failures (component-level errors and per-step errors) to the
 * user and throws a single FurnaceError summarising the failure count.
 * Extracted from `furnacePreviewCommand` to keep that function under the
 * `max-lines-per-function` threshold and to colocate the failure-reporting
 * contract in one place.
 *
 * @returns The total failure count if there were any (always non-zero when
 *          this returns; the function throws after logging).
 */
function reportPreviewStagingFailures(stageResult: ApplyAllComponentsResult): never {
  for (const err of stageResult.errors) {
    warn(`Furnace: ${err.name} — ${err.error}`);
  }
  for (const applied of stageResult.applied) {
    if (applied.stepErrors && applied.stepErrors.length > 0) {
      for (const stepErr of applied.stepErrors) {
        warn(`Furnace: ${applied.name} [${stepErr.step}] ${stepErr.error}`);
      }
    }
  }
  const appliedWithStepErrorsCount = countEntriesWithBlockingStepErrors(stageResult.applied);
  const totalFailures = stageResult.errors.length + appliedWithStepErrorsCount;
  throw new FurnaceError(
    `${totalFailures} component${totalFailures === 1 ? '' : 's'} failed to stage for preview`
  );
}

/**
 * Filenames emitted by the Firefox build backend (not by Storybook's npm
 * package set) — their absence means `mach build` has not produced its
 * post-configure artifacts, which is a different failure mode from a
 * missing Storybook workspace dependency tree. The eval log for finding
 * #11 reported `FileNotFoundError: [...] chrome-map.json` *after* a
 * successful Storybook `npm install`, and the pre-0.16 heuristic
 * misdiagnosed it as a dep failure and sent the operator back to
 * `--install`. Pattern list is narrow on purpose so we only surface the
 * backend-rebuild hint when we are confident.
 */
const BACKEND_ARTIFACT_PATTERNS: readonly RegExp[] = [
  /chrome-map\.json/i,
  /config\.status/i,
  /obj-[^\s/]+\/dist\/bin\/\.lldbinit/i,
];

/**
 * Builds a targeted Storybook failure message from captured mach output.
 *
 * Exported for the test suite: the heuristic has three branches (backend
 * artifact missing, Storybook dep missing, generic) and regression
 * testing each is easier when the classifier is addressable directly.
 *
 * @param output - Combined stdout and stderr from the Storybook command
 * @param installRequested - Whether the caller requested a dependency reinstall first
 * @returns User-facing guidance for the specific failure mode
 */
export function buildStorybookFailureMessage(output: string, installRequested: boolean): string {
  const installHint = installRequested
    ? 'Try running "python3 ./mach storybook upgrade" manually in the engine directory.'
    : 'Run "fireforge furnace preview --install" to bootstrap Storybook dependencies, or run "python3 ./mach storybook upgrade" manually in engine/.';

  const hasFileNotFoundSignal = /(ENOENT|No such file or directory|FileNotFoundError)/i.test(
    output
  );

  // Check backend-artifact signal first — a missing chrome-map.json looks
  // like any other "No such file" error to a naïve regex, but the fix is
  // to rerun `fireforge build`, not to reinstall Storybook dependencies.
  if (hasFileNotFoundSignal && BACKEND_ARTIFACT_PATTERNS.some((p) => p.test(output))) {
    return (
      'Storybook failed because the Firefox build backend artifacts are missing or stale ' +
      '(chrome-map.json / config.status / obj-*/dist/bin/.lldbinit). ' +
      'This is a Firefox-build completeness issue, not a Storybook dependency issue.\n\n' +
      'Rerun "fireforge build" and let it finish, then retry "fireforge furnace preview". ' +
      'A full rebuild regenerates the backend artifacts Storybook reads.'
    );
  }

  if (hasFileNotFoundSignal && /storybook|backend/i.test(output)) {
    return (
      'Storybook failed because the Firefox checkout appears to be missing Storybook workspace files or backend dependencies.\n\n' +
      installHint
    );
  }

  return (
    'Storybook failed to start. Check the output above for the specific Firefox-side error.\n\n' +
    installHint
  );
}

/**
 * Preflights the Firefox build + toolchain prerequisites `mach storybook`
 * quietly assumes. Pre-0.16.0 the preview staged components and launched
 * a ~1000-package `mach storybook upgrade` npm install before the
 * backend surfaced a "missing chrome-map.json" / Cargo-config failure;
 * the preflight below refuses fast and leaves the workspace untouched.
 *
 * Extracted from `furnacePreviewCommand` so the main function stays
 * under the per-function LOC budget as the preflight list grows.
 *
 * @param engineDir - Resolved engine directory
 * @throws FurnaceError when the Firefox build hasn't produced dist/, or
 *         when `.cargo/config.toml` is absent
 */
async function assertPreviewPrerequisites(engineDir: string): Promise<void> {
  const buildCheck = await hasBuildArtifacts(engineDir);
  if (!buildCheck.exists) {
    throw new FurnaceError(
      'Furnace preview requires a completed Firefox build. ' +
        '`mach storybook` consumes `obj-*/dist/chrome-map.json` and the packaged chrome resources under `dist/`, neither of which is present before `fireforge build` completes.\n\n' +
        'Run "fireforge build" and wait for it to finish, then rerun "fireforge furnace preview". ' +
        'This preflight avoids a multi-minute `mach storybook upgrade` npm install on an engine that cannot start Storybook anyway.'
    );
  }

  // Accept either `.cargo/config.toml` (post-configure) or
  // `.cargo/config.toml.in` (post-bootstrap template, consumed at
  // `mach configure` time). Pre-0.16.0 the preflight insisted on the
  // plain file, but `fireforge bootstrap` alone produces only `.in` —
  // operators who followed the remediation instruction ("run bootstrap
  // then rerun preview") hit the same refusal on the retry. Either name
  // is sufficient to prove the Rust toolchain is registered; the stronger
  // `hasBuildArtifacts` check above already guards against a completely
  // un-configured tree, so relaxing this to an OR-check does not weaken
  // the signal we care about.
  const cargoConfigPath = join(engineDir, '.cargo', 'config.toml');
  const cargoConfigInPath = join(engineDir, '.cargo', 'config.toml.in');
  const cargoConfigPresent =
    (await pathExists(cargoConfigPath)) || (await pathExists(cargoConfigInPath));
  if (!cargoConfigPresent) {
    throw new FurnaceError(
      "Furnace preview requires the engine's Rust toolchain to be bootstrapped. " +
        'Neither `.cargo/config.toml` nor `.cargo/config.toml.in` exists under the engine directory — ' +
        '`mach storybook` fails deep inside the Storybook backend compile without either of them.\n\n' +
        'Run "fireforge bootstrap" (or the underlying `mach bootstrap` in the engine) to populate the toolchain config, then rerun "fireforge furnace preview".'
    );
  }
}

/**
 * Emits a framing banner when the Storybook workspace has not yet had
 * its npm dependencies installed. `mach storybook` will drive the
 * install internally and print ELSPROBLEMS / UNMET DEPENDENCY lines
 * verbatim; without this banner operators reliably read the npm output
 * as a failure (2026-04-24 eval Finding 13).
 *
 * Skipped when `--install` was explicitly requested — that path already
 * runs `mach storybook upgrade` before the preview launches, so the npm
 * output for the subsequent `mach storybook` invocation is a no-op.
 */
async function announceStorybookFirstRunIfNeeded(
  engineDir: string,
  installRequested: boolean
): Promise<void> {
  if (installRequested) return;
  const storybookNodeModules = join(
    engineDir,
    'browser',
    'components',
    'storybook',
    'node_modules'
  );
  const storybookDepsMissing = !(await pathExists(storybookNodeModules));
  if (!storybookDepsMissing) return;
  info(
    'Storybook workspace dependencies are not yet installed. The next step will install ~1000 npm packages via `mach storybook`; expect npm error-style output below. This is a one-time first-run cost — Storybook will start once the install finishes.'
  );
}

/**
 * Surfaces an explicit success banner after a clean mach-storybook
 * exit so the operator's scrollback visually terminates the npm noise
 * from the first-run install. Only fires on expected exit codes — non-
 * zero cases fall through to the existing
 * `buildStorybookFailureMessage` classification.
 */
function announceStorybookCleanExitIfApplicable(exitCode: number): void {
  if (exitCode === 0 || exitCode === 130 || exitCode === 143) {
    info('Storybook stopped cleanly.');
  }
}

/**
 * Runs the furnace preview command to start Storybook for component preview.
 * @param projectRoot - Root directory of the project
 * @param options - Command options
 */
export async function furnacePreviewCommand(
  projectRoot: string,
  options: FurnacePreviewOptions = {}
): Promise<void> {
  intro('Furnace Preview (Storybook)');

  // Verify engine exists
  const paths = getProjectPaths(projectRoot);
  if (!(await pathExists(paths.engine))) {
    throw new FurnaceError('Engine directory not found. Run "fireforge download" first.');
  }

  // Load furnace config
  if (!(await furnaceConfigExists(projectRoot))) {
    throw new FurnaceError(
      'No furnace.json found. Run "fireforge furnace create" or "fireforge furnace override" to get started.'
    );
  }

  const config = await loadFurnaceConfig(projectRoot);

  const stockCount = config.stock.length;
  const overrideCount = Object.keys(config.overrides).length;
  const customCount = Object.keys(config.custom).length;
  const totalCount = stockCount + overrideCount + customCount;

  if (totalCount === 0) {
    info('No components to preview.');
    outro('Done');
    return;
  }

  const storybookRoot = join(paths.engine, 'browser', 'components', 'storybook');
  if (!(await pathExists(storybookRoot))) {
    throw new FurnaceError(
      'This Firefox checkout does not contain browser/components/storybook. Furnace preview requires the upstream Storybook workspace to exist before stories can be synced.'
    );
  }

  // Build + toolchain preflight (Finding #9). Extracted into a helper so
  // the function below stays under the per-function LOC budget.
  await assertPreviewPrerequisites(paths.engine);

  let previewResult:
    | {
        stdout: string;
        stderr: string;
        exitCode: number;
      }
    | undefined;
  // True once we are about to (or have) written to engine/.../stories/furnace.
  // Intentionally set BEFORE `syncStories` is awaited so a mid-sync failure
  // still triggers `cleanStories` during teardown. `cleanStories` is a
  // full-directory wipe, so it is correct to run against partial state —
  // including state with zero files, where it is a cheap no-op.
  let storiesCleanupRequired = false;
  let previewJournal: RollbackJournal | undefined;
  let primaryError: unknown;

  // The preview command runs under runFurnaceMutation so a SIGINT during
  // Storybook still triggers cleanStories + journal restore via the CLI
  // entrypoint's global signal handlers consulting the lifecycle registry.
  // The body's own try/catch + teardown path handles the normal exit case
  // (mach storybook returns or throws).
  await runFurnaceMutation(projectRoot, 'preview-teardown', async (ctx) => {
    // Register the stories cleanup as an extra teardown hook so the signal
    // handler can wipe the staged stories directory in addition to the
    // journal restore.
    ctx.registerCleanup(async () => {
      if (storiesCleanupRequired) {
        await cleanStories(paths.engine);
      }
    });

    try {
      // Stage workspace override/custom files into engine/ so Storybook can
      // resolve freshly edited chrome:// imports. Stock-only projects skip
      // this step because stock components are never written from workspace
      // sources.
      if (overrideCount + customCount > 0) {
        const stageSpinner = spinner('Staging components for preview...');
        let stageResult: ApplyAllComponentsResult;
        try {
          stageResult = await applyAllComponents(projectRoot, false, {
            persistState: false,
            operationContext: ctx,
          });
        } catch (error: unknown) {
          stageSpinner.error('Failed to stage components');
          throw error;
        }
        previewJournal = stageResult.rollbackJournal;
        if (previewJournal) {
          ctx.registerJournal(previewJournal);
        }

        const appliedWithStepErrorsCount = countEntriesWithBlockingStepErrors(stageResult.applied);
        const totalFailures = stageResult.errors.length + appliedWithStepErrorsCount;
        if (totalFailures > 0) {
          stageSpinner.error('Failed to stage components');
          reportPreviewStagingFailures(stageResult);
        }

        stageSpinner.stop(
          `Staged ${stageResult.applied.length} component${stageResult.applied.length === 1 ? '' : 's'} for preview`
        );
      }

      // Sync story files. Set the cleanup flag before the await so a partial
      // write failure still triggers the teardown wipe — `syncStories` writes
      // files incrementally with no internal cleanup of its own.
      const syncSpinner = spinner('Syncing component stories...');
      storiesCleanupRequired = true;
      const result = await syncStories(projectRoot);
      const created = result.created.length;
      const updated = result.updated.length;
      const total = created + updated;
      syncSpinner.stop(`Synced ${total} stories (${created} new, ${updated} updated)`);

      // Force-reinstall Storybook dependencies if requested
      if (options.install) {
        const installSpinner = spinner('Reinstalling Storybook dependencies...');
        const installCode = await runMach(['storybook', 'upgrade'], paths.engine);
        if (installCode !== 0) {
          installSpinner.stop('Failed to reinstall Storybook dependencies');
          throw new FurnaceError(
            'Storybook dependency reinstallation failed. Try running "python3 ./mach storybook upgrade" manually in the engine directory.'
          );
        }
        installSpinner.stop('Storybook dependencies reinstalled');
      }

      // 2026-04-24 eval Finding 13: frame the npm noise that `mach
      // storybook` emits on first-run as expected progress rather than a
      // failure. The banner-before / banner-after helpers are extracted
      // so the command body stays under the per-function LOC budget.
      await announceStorybookFirstRunIfNeeded(paths.engine, options.install ?? false);

      // Start Storybook
      info('Starting Storybook...');
      info('Press Ctrl+C to stop\n');

      previewResult = await runMachCapture(['storybook'], paths.engine);

      announceStorybookCleanExitIfApplicable(previewResult.exitCode);
    } catch (error: unknown) {
      primaryError = error;
    }

    // Teardown runs unconditionally and never short-circuits: a failure in
    // cleanStories must not prevent the journal restore, and vice versa. The
    // previous implementation ran teardown in a `finally` block that called
    // `restoreRollbackJournalOrThrow`, which threw synchronously — that throw
    // bypassed the primary error and, worse, skipped downstream handling so
    // the engine was left with staged files and the user got a teardown
    // message with no guidance. We now collect both failures and, if anything
    // went wrong, persist a `pendingRepair` marker that `fireforge doctor`
    // consumes to finish the reconciliation.
    const teardownErrors = await runPreviewTeardown(
      paths.engine,
      storiesCleanupRequired,
      previewJournal
    );

    if (teardownErrors.length > 0) {
      const teardownSummary = teardownErrors.map((err) => err.message).join('; ');
      try {
        await updateFurnaceState(projectRoot, (state) => ({
          ...state,
          pendingRepair: {
            operation: 'preview-teardown',
            timestamp: new Date().toISOString(),
            reason: teardownSummary,
          },
        }));
      } catch (markError: unknown) {
        warn(
          `Could not record pending-repair marker in .fireforge/furnace-state.json — ${toError(markError).message}. Engine may still be in a staged state; run "fireforge furnace apply" manually to reconcile.`
        );
      }

      const primarySuffix = primaryError
        ? ` (original error: ${toError(primaryError).message})`
        : '';
      throw new FurnaceError(
        `Preview teardown could not restore the engine cleanly: ${teardownSummary}. The engine may contain staged workspace files. Run "fireforge doctor --repair-furnace" to reconcile, or run "fireforge furnace apply" manually.${primarySuffix}`
      );
    }

    if (primaryError) {
      // Re-throwing the captured error preserves its original shape. The
      // `toError` wrap normalises non-Error throws (strings, plain objects)
      // into real Error instances so the eslint `only-throw-error` rule
      // holds and downstream formatters always see a message/stack pair.
      throw toError(primaryError);
    }
  });

  if (
    previewResult &&
    previewResult.exitCode !== 0 &&
    previewResult.exitCode !== 130 &&
    previewResult.exitCode !== 143
  ) {
    const combinedOutput = `${previewResult.stdout}\n${previewResult.stderr}`;
    throw new FurnaceError(buildStorybookFailureMessage(combinedOutput, options.install ?? false));
  }

  outro('Storybook stopped');
}
