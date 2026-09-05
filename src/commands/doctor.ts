// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';

import { configExists, getProjectPaths, loadConfig, loadState } from '../core/config.js';
import { furnaceConfigExists as checkFurnaceConfigExists } from '../core/furnace-config.js';
import { getCurrentBranch, getHead, isGitRepository, isMissingHeadError } from '../core/git.js';
import { ensureGit } from '../core/git-base.js';
import { ensureMach, ensurePython } from '../core/mach.js';
import { countPatches } from '../core/patch-apply.js';
import { validatePatchIntegrity } from '../core/patch-manifest.js';
import { InvalidArgumentError } from '../errors/base.js';
import { ExitCode } from '../errors/codes.js';
import type { CommandContext } from '../types/cli.js';
import type { DoctorCheck, DoctorOptions } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { error, info, intro, outro, success, warn } from '../utils/logger.js';
import { addWaitLockOption } from '../utils/options.js';
import { findExecutable } from '../utils/process.js';
import type { DoctorCheckContext, DoctorCheckDefinition } from './doctor-check-core.js';
import { failure, ok, warning } from './doctor-check-core.js';
import { EXTERNAL_TOOLCHAIN_DOCTOR_CHECK } from './doctor-external-toolchains.js';
import { FURNACE_DOCTOR_CHECKS } from './doctor-furnace.js';
import { ORPHANED_HARNESS_DOCTOR_CHECK } from './doctor-orphaned-harness.js';
import { PATCH_MANIFEST_CONSISTENCY_CHECK } from './doctor-patch-manifest.js';
import { POST_REBASE_AUDIT_CHECK } from './doctor-post-rebase-audit.js';
import { SOURCE_PIN_DOCTOR_CHECK } from './doctor-source-pin.js';
import { inspectEngineWorkingTree } from './doctor-working-tree.js';
import { clearPendingResolution } from './pending-resolution.js';
import { collectPatchQueueHealth } from './verify.js';

/**
 * Runs a single check definition, converting thrown errors into
 * DoctorCheck failure rows. Always returns an array so the caller can
 * flatten results uniformly.
 */
async function executeCheck(
  definition: DoctorCheckDefinition,
  ctx: DoctorCheckContext
): Promise<DoctorCheck[]> {
  if (definition.skipIf?.(ctx)) {
    return [];
  }

  try {
    const result = await definition.run(ctx);
    return Array.isArray(result) ? result : [result];
  } catch (err: unknown) {
    return [failure(definition.name, toError(err).message, definition.fix)];
  }
}

/**
 * Runs the subset of engine checks that depend on a healthy git repository
 * and HEAD. This group shares mutable state (currentHead, canValidateBranch),
 * so it lives as a single definition returning multiple rows.
 */
async function runEngineGitChecks(ctx: DoctorCheckContext): Promise<DoctorCheck[]> {
  const { paths, state } = ctx;
  const rows: DoctorCheck[] = [];

  let currentHead: string | undefined;
  let canValidateBranch = true;

  if (state.baseCommit) {
    try {
      currentHead = await getHead(paths.engine);
    } catch (err: unknown) {
      if (!isMissingHeadError(err)) {
        throw err;
      }

      canValidateBranch = false;
      rows.push(
        failure(
          'Engine state consistency',
          'Engine repository has no baseline commit yet. A previous "fireforge download" likely stopped after git init but before the initial Firefox commit was created.',
          'Re-run "fireforge download --force" to recreate the baseline repository cleanly.'
        )
      );
    }

    if (canValidateBranch && currentHead !== state.baseCommit) {
      rows.push(
        failure(
          'Engine state consistency',
          'HEAD differs from baseCommit. FireForge expects the engine repository to remain at the downloaded baseline commit; branch switches or commits inside engine/ can break import, resolve, and patch regeneration workflows.',
          'Reset engine/ to the baseline commit or re-run "fireforge download --force".'
        )
      );
    } else if (canValidateBranch) {
      rows.push(ok('Engine state consistency'));
    }
  }

  const workingTreeRow = await inspectEngineWorkingTree(ctx);
  if (workingTreeRow) {
    rows.push(workingTreeRow);
  }

  let branch: string | undefined;
  if (canValidateBranch) {
    try {
      branch = await getCurrentBranch(paths.engine);
    } catch (err: unknown) {
      if (!isMissingHeadError(err)) {
        throw err;
      }

      canValidateBranch = false;
      rows.push(
        failure(
          'Engine branch',
          'Engine repository has no baseline commit yet. A previous "fireforge download" likely stopped before git created the initial Firefox commit.',
          'Re-run "fireforge download --force" to recreate the baseline repository cleanly.'
        )
      );
    }
  }

  if (
    !canValidateBranch &&
    branch === undefined &&
    currentHead === undefined &&
    !state.baseCommit
  ) {
    // Unborn repository with no recorded baseline — the earlier failure row
    // explains recovery; avoid adding a second near-identical row.
  } else if (!canValidateBranch) {
    rows.push(
      warning(
        'Engine branch',
        'Skipped branch validation because the baseline commit is missing.',
        'Finish recreating the engine baseline with "fireforge download --force".'
      )
    );
  } else if (branch === 'firefox') {
    rows.push(ok('Engine branch'));
  } else if (branch === 'HEAD' && state.baseCommit && currentHead === state.baseCommit) {
    rows.push(
      warning(
        'Engine branch',
        'Engine is detached at the recorded base commit. This is acceptable for disposable worktrees and audit clones.',
        'If this is your primary workspace, checkout the "firefox" branch to match FireForge defaults.'
      )
    );
  } else {
    rows.push(failure('Engine branch', `Engine is on branch "${branch}", but expected "firefox".`));
  }

  return rows;
}

/**
 * Validates that every check's `dependsOn` entries appear earlier in the
 * registry. Called once at module load time so a broken reorder surfaces
 * immediately as a thrown error rather than producing a subtle
 * context-population bug at runtime.
 *
 * Exported so tests can exercise the forward-only invariant against
 * fixtures — the real DOCTOR_CHECKS list is also validated at import
 * time, but a targeted unit test makes the contract explicit and
 * prevents regressions if the validator is ever relaxed.
 */
export function validateCheckDependencies(checks: readonly DoctorCheckDefinition[]): void {
  const seen = new Set<string>();
  for (const check of checks) {
    if (check.dependsOn) {
      for (const dep of check.dependsOn) {
        if (!seen.has(dep)) {
          throw new Error(
            `Doctor check "${check.name}" declares dependsOn "${dep}", ` +
              `but "${dep}" does not appear earlier in the registry. ` +
              'Fix the ordering in DOCTOR_CHECKS.'
          );
        }
      }
    }
    seen.add(check.name);
  }
}

/**
 * The declarative doctor check registry. The order of entries here is the
 * order checks appear in the report. Adding a new check is a one-entry
 * edit; each check only contains its own inspection logic.
 *
 * ## Ordering dependency chain
 *
 * Later checks may read state populated by earlier ones via the shared
 * {@link DoctorCheckContext}. Dependencies are declared via the
 * `dependsOn` field and enforced by {@link validateCheckDependencies}
 * at module load time.
 *
 * {@link DOCTOR_CHECK_ORDER} is exported so tests can pin the sequence.
 */
const DOCTOR_CHECKS: DoctorCheckDefinition[] = [
  {
    name: 'Git installed',
    run: async () => {
      await ensureGit();
      return ok('Git installed');
    },
    fix: 'Install git from https://git-scm.com/',
  },
  {
    name: 'Python supported by mach',
    run: async (ctx) => {
      await ensurePython(ctx.paths.engine);
      return ok('Python supported by mach');
    },
    fix: 'Install a Python version supported by engine/mach, then re-run "fireforge doctor".',
  },
  {
    name: 'fireforge.json exists',
    run: async (ctx) => {
      if (!(await configExists(ctx.projectRoot))) {
        throw new Error('fireforge.json not found');
      }
      return ok('fireforge.json exists');
    },
    fix: 'Run "fireforge setup" to create a project',
  },
  {
    name: 'fireforge.json is valid',
    run: async (ctx) => {
      ctx.config = await loadConfig(ctx.projectRoot);
      return ok('fireforge.json is valid');
    },
    fix: 'Check fireforge.json for syntax errors or missing fields',
  },
  EXTERNAL_TOOLCHAIN_DOCTOR_CHECK,
  {
    name: 'Engine directory exists',
    run: (ctx) => {
      if (!ctx.engineExists) {
        throw new Error('engine/ directory not found');
      }
      return ok('Engine directory exists');
    },
    fix: 'Run "fireforge download" to download Firefox source',
  },
  {
    name: 'Pending Resolution',
    skipIf: (ctx) => !ctx.state.pendingResolution,
    run: async (ctx) => {
      const patchFilename = ctx.state.pendingResolution?.patchFilename ?? 'unknown';
      if (ctx.options.clearResolution) {
        const health = await collectPatchQueueHealth(ctx.projectRoot);
        if (health.errorCount > 0) {
          return failure(
            'Pending Resolution',
            `Refusing to clear pending resolution for ${patchFilename}: patch queue health check found ${health.errorCount} error(s).`,
            'Run "fireforge verify" for details, fix the queue, then retry "fireforge doctor --clear-resolution".'
          );
        }

        await clearPendingResolution(ctx.projectRoot);
        return ok('Pending Resolution');
      }

      return failure(
        'Pending Resolution',
        `You are currently resolving a conflict for patch ${patchFilename}.`,
        'Build and Export commands may behave unexpectedly until "fireforge resolve" is completed. If the queue now verifies cleanly, run "fireforge doctor --clear-resolution" to discard the stale marker.'
      );
    },
  },
  SOURCE_PIN_DOCTOR_CHECK,
  {
    name: 'Engine is git repository',
    skipIf: (ctx) => !ctx.engineExists,
    // runEngineGitChecks consults ctx.config for ownership-aware
    // working-tree classification; declare the dependency so a future
    // reorder doesn't silently regress the doctor back to the
    // count-only fallback.
    dependsOn: ['fireforge.json is valid'],
    run: async (ctx) => {
      const isRepo = await isGitRepository(ctx.paths.engine);
      if (!isRepo) {
        return failure(
          'Engine is git repository',
          'engine/ is not a git repository',
          'Run "fireforge download --force" to reinitialize'
        );
      }

      // Git-dependent follow-up checks share mutable currentHead/branch
      // state, so they live in a helper that returns all rows at once.
      return [ok('Engine is git repository'), ...(await runEngineGitChecks(ctx))];
    },
  },
  {
    name: 'mach available',
    skipIf: (ctx) => !ctx.engineExists,
    run: async (ctx) => {
      await ensureMach(ctx.paths.engine);
      return ok('mach available');
    },
    fix: 'Firefox source may be corrupted. Re-download with "fireforge download --force"',
  },
  {
    // `fireforge watch` has an undeclared hard dependency on watchman, and
    // without a doctor row operators only discover the gap when they try to
    // start watch mode. Warning severity is the right shape: most projects
    // never run watch, so a missing watchman should not fail `doctor`
    // outright, but the information needs to be visible ahead of time.
    name: 'Watchman available',
    run: async () => {
      // Resolve the absolute path so the OK row names what doctor actually
      // found. A PATH-export discrepancy between the operator's interactive
      // shell and the spawned subprocess otherwise reads as doctor printing
      // "OK" for a binary `which watchman` cannot find; surfacing the
      // resolved path makes the discrepancy visible without a verbose flag.
      const path = await findExecutable('watchman');
      if (path) {
        return ok('Watchman available', `OK (${path})`);
      }
      return warning(
        'Watchman available',
        'watchman is not installed or not on PATH. "fireforge watch" requires it.',
        'Install watchman (brew install watchman / dnf install watchman / https://facebook.github.io/watchman/), then re-run doctor.'
      );
    },
  },
  ORPHANED_HARNESS_DOCTOR_CHECK,
  {
    name: 'Patches directory exists',
    run: async (ctx) => {
      const patchesExist = await pathExists(ctx.paths.patches);
      return ok(
        'Patches directory exists',
        patchesExist ? 'OK' : 'No patches/ directory (optional)'
      );
    },
  },
  {
    name: 'Patches found',
    run: async (ctx) => {
      if (!(await pathExists(ctx.paths.patches))) {
        return [];
      }
      const patchCount = await countPatches(ctx.paths.patches);
      return ok('Patches found', `${patchCount} patch${patchCount === 1 ? '' : 'es'} found`);
    },
  },
  PATCH_MANIFEST_CONSISTENCY_CHECK,
  {
    name: 'Patch integrity',
    skipIf: (ctx) => !ctx.engineExists,
    run: async (ctx) => {
      if (!(await pathExists(ctx.paths.patches))) {
        return [];
      }
      const issues = await validatePatchIntegrity(ctx.paths.patches, ctx.paths.engine);
      if (issues.length === 0) {
        return ok('Patch integrity');
      }
      const fileList = issues.map((issue) => issue.targetFile).filter(Boolean);
      throw new Error(
        `${issues.length} patch(es) are modification patches for non-existent files: ${fileList.join(', ')}`
      );
    },
    fix: 'Re-export affected files with "fireforge export <paths...>" to create full-file patches',
  },
  POST_REBASE_AUDIT_CHECK,
  // Furnace checks live in a sibling module so this file stays under the
  // max-lines threshold. Splicing them in as an array preserves the
  // declarative registry contract — each entry remains a single
  // `DoctorCheckDefinition` with its own skipIf/run/fix, and the order
  // here is the order they appear in the report.
  ...FURNACE_DOCTOR_CHECKS,
  {
    name: 'Configs directory exists',
    run: async (ctx) => {
      if (!(await pathExists(ctx.paths.configs))) {
        throw new Error('configs/ directory not found');
      }
      return ok('Configs directory exists');
    },
    fix: 'Run "fireforge setup" to create configs',
  },
];

// Validate dependency ordering at module load time so broken reorders
// fail immediately instead of producing subtle runtime bugs.
validateCheckDependencies(DOCTOR_CHECKS);

/**
 * Ordered list of the doctor check names, exported for tests. Pinning
 * the order here is intentional: any reorder that breaks the
 * context-population dependency chain (see {@link DOCTOR_CHECKS}) must
 * also update this list, which gives us a single place to notice and
 * think through the consequences.
 *
 * @internal Exported only so tests can reach it; not part of the public surface.
 */
export const DOCTOR_CHECK_ORDER: readonly string[] = DOCTOR_CHECKS.map((check) => check.name);

/**
 * Renders a list of doctor checks to the console and returns the
 * appropriate exit code (success when no errors, general error otherwise).
 * @param checks - The check results to display
 * @returns The exit code reflecting the overall result
 */
export function reportDoctorResults(
  checks: DoctorCheck[],
  mutations: readonly string[] = []
): ExitCode {
  info('');

  let passedCount = 0;
  let warningCount = 0;
  let failedCount = 0;

  for (const check of checks) {
    const severity = check.severity;

    if (severity === 'warning') {
      warn(`! ${check.name}: ${check.message}`);
      if (check.fix) {
        warn(`  Fix: ${check.fix}`);
      }
      warningCount++;
    } else if (severity === 'ok') {
      success(`✓ ${check.name}: ${check.message}`);
      passedCount++;
    } else {
      error(`✗ ${check.name}: ${check.message}`);
      if (check.fix) {
        warn(`  Fix: ${check.fix}`);
      }
      failedCount++;
    }
  }

  info('');

  // Printed in every branch, including the failing one: a repair that wrote
  // and then met an unrelated failing check must not be reported as a run
  // where nothing happened.
  if (mutations.length > 0) {
    warn('Repairs applied this run:');
    for (const mutation of mutations) {
      warn(`  ${mutation}`);
    }
    info('');
  }

  if (failedCount === 0 && warningCount === 0) {
    outro(`All ${passedCount} checks passed!`);
  } else if (failedCount === 0) {
    outro(`${passedCount} passed, ${warningCount} warning${warningCount === 1 ? '' : 's'}`);
  } else {
    outro(
      `${passedCount} passed, ${warningCount} warning${warningCount === 1 ? '' : 's'}, ${failedCount} failed`
    );
    return ExitCode.GENERAL_ERROR;
  }

  return ExitCode.SUCCESS;
}

/**
 * Result of the doctor command, carrying the exit code so the caller
 * (or test) can inspect it without relying on process.exitCode.
 */
export interface DoctorResult {
  checks: DoctorCheck[];
  exitCode: number;
}

/**
 * Rejects repair-flag combinations that cannot mean what they say.
 *
 * The two manifest repairs are different operations on the same file, and
 * `--dry-run` with nothing to project is a flag that silently does nothing —
 * the shape most likely to be mistaken for a preview that reported "no
 * changes".
 */
function assertRepairOptions(options: DoctorOptions): void {
  if (options.repairPatchesManifest === true && options.repairFilesAffected === true) {
    throw new InvalidArgumentError(
      '--repair-patches-manifest and --repair-files-affected are mutually exclusive. ' +
        'Use --repair-files-affected for filesAffected drift; use --repair-patches-manifest ' +
        'when rows are missing, untracked or duplicated.',
      '--repair-files-affected'
    );
  }
  if (options.allowMetadataLoss === true && options.repairPatchesManifest !== true) {
    throw new InvalidArgumentError(
      '--allow-metadata-loss only applies to --repair-patches-manifest.',
      '--allow-metadata-loss'
    );
  }
  if (
    options.dryRun === true &&
    options.repairPatchesManifest !== true &&
    options.repairFilesAffected !== true
  ) {
    throw new InvalidArgumentError(
      '--dry-run needs a manifest repair to project. Pass it with ' +
        '--repair-patches-manifest or --repair-files-affected. ' +
        '(--repair-furnace has no dry-run: it reconciles engine state, not a manifest.)',
      '--dry-run'
    );
  }
}

/**
 * Runs the doctor command to diagnose issues.
 * @param projectRoot - Root directory of the project
 */
export async function doctorCommand(
  projectRoot: string,
  options: DoctorOptions = {}
): Promise<DoctorResult> {
  intro('FireForge Doctor');

  assertRepairOptions(options);

  const paths = getProjectPaths(projectRoot);
  const state = await loadState(projectRoot);
  const engineExists = await pathExists(paths.engine);
  const furnaceConfigExistsFlag = await checkFurnaceConfigExists(projectRoot);

  const ctx: DoctorCheckContext = {
    projectRoot,
    paths,
    state,
    options,
    engineExists,
    config: undefined,
    furnaceConfigExists: furnaceConfigExistsFlag,
    furnaceConfig: undefined,
    mutations: [],
  };

  const checks: DoctorCheck[] = [];
  for (const definition of DOCTOR_CHECKS) {
    checks.push(...(await executeCheck(definition, ctx)));
  }

  const exitCode = reportDoctorResults(checks, ctx.mutations);
  return { checks, exitCode };
}

/** Registers the doctor command on the CLI program. */
export function registerDoctor(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  const command = program
    .command('doctor')
    .description('Diagnose project issues')
    .option(
      '--repair-patches-manifest',
      'Rebuild patches/patches.json from the current patch files before reporting results. Only filesAffected and order are recomputed; every other field on an existing entry is preserved'
    )
    .option(
      '--repair-files-affected',
      'Repair only the filesAffected lists that disagree with their patch body, leaving every other manifest field untouched'
    )
    .option(
      '--allow-metadata-loss',
      'With --repair-patches-manifest, rebuild even when patches.json cannot be parsed — every descriptive field on every entry is then reinvented'
    )
    .option('--dry-run', 'Show what a requested repair would change without writing anything')
    .option(
      '--repair-furnace',
      'Reconcile furnace state: clear stale furnace-state.json entries, re-run furnace apply to fix engine drift, and clear the pending-repair marker set by a failed preview teardown'
    )
    .option(
      '--clear-resolution',
      'Clear stale pendingResolution state after the patch queue health check reports no errors'
    )
    .option(
      '--post-rebase-audit',
      'Check common registration surfaces after a Firefox source rebase'
    );
  addWaitLockOption(command).action(
    withErrorHandling(async (options: DoctorOptions) => {
      const result = await doctorCommand(getProjectRoot(), options);
      if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
      }
    })
  );
}
