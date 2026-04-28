// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';

import { configExists, getProjectPaths, loadConfig, loadState } from '../core/config.js';
import { furnaceConfigExists as checkFurnaceConfigExists } from '../core/furnace-config.js';
import { getCurrentBranch, getHead, isGitRepository, isMissingHeadError } from '../core/git.js';
import { ensureGit } from '../core/git-base.js';
import { ensureMach, ensurePython } from '../core/mach.js';
import { countPatches } from '../core/patch-apply.js';
import {
  rebuildPatchesManifest,
  validatePatchesManifestConsistency,
  validatePatchIntegrity,
} from '../core/patch-manifest.js';
import { ExitCode } from '../errors/codes.js';
import type { CommandContext } from '../types/cli.js';
import type { DoctorCheck, DoctorOptions } from '../types/commands/index.js';
import type { FireForgeConfig, FireForgeState, ProjectPaths } from '../types/config.js';
import type { FurnaceConfig } from '../types/furnace.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { error, info, intro, outro, success, warn } from '../utils/logger.js';
import { findExecutable } from '../utils/process.js';
import { FURNACE_DOCTOR_CHECKS } from './doctor-furnace.js';
import { inspectEngineWorkingTree } from './doctor-working-tree.js';

/**
 * Shared state available to every doctor check during a single run.
 *
 * The context is populated lazily by the doctor runner. Individual checks
 * can record side-observations (e.g. the parsed `fireforge.json`) into the
 * context for later checks to consume without re-parsing.
 *
 * Exported so sibling modules (e.g. `doctor-furnace.ts`) can declare
 * `DoctorCheckDefinition` entries against the same shared context.
 */
export interface DoctorCheckContext {
  projectRoot: string;
  paths: ProjectPaths;
  state: FireForgeState;
  options: DoctorOptions;
  /**
   * Whether the engine/ directory exists on disk. Populated before checks
   * run so downstream checks can skip git/mach inspections cheaply.
   */
  engineExists: boolean;
  /**
   * The loaded project config, set by the "fireforge.json is valid" check
   * when it succeeds. Undefined before that check runs and whenever loading
   * failed.
   */
  config: FireForgeConfig | undefined;
  /**
   * Whether `furnace.json` exists on disk. Populated before checks run so
   * the furnace group can skipIf cheaply when the subsystem is not in use.
   * A missing furnace.json is not an error — plenty of projects never touch
   * the subsystem — so the doctor stays silent rather than failing.
   */
  furnaceConfigExists: boolean;
  /**
   * The parsed furnace config, set by the "Furnace configuration" check
   * when it succeeds. Later furnace checks read from this so they do not
   * re-parse the file; undefined when the config could not be loaded.
   */
  furnaceConfig: FurnaceConfig | undefined;
}

/**
 * Result a check may return. A single object is the common case; an array
 * lets a single check emit multiple related rows (e.g. the engine branch
 * check which may report on branch + detached state together).
 */
export type CheckResult = DoctorCheck | DoctorCheck[];

/**
 * Declarative definition of a single doctor check.
 *
 * Every check opts into the shared execution/reporting pipeline by
 * implementing only its inspection logic in `run`. Cross-cutting concerns
 * (result aggregation, summary, exit codes) live in the runner instead of
 * being duplicated at each call site.
 *
 * Exported so sibling modules (e.g. `doctor-furnace.ts`) can declare
 * new checks without re-deriving the shape.
 */
export interface DoctorCheckDefinition {
  /**
   * Human-readable name surfaced in the check report (e.g. "Git installed").
   * Not required to be unique, but tests assert on it.
   */
  name: string;
  /**
   * When `true`, the check is silently skipped. Used for checks that only
   * apply when the engine is present, or only when specific state flags
   * are set. Skipped checks contribute nothing to the final report.
   */
  skipIf?: (ctx: DoctorCheckContext) => boolean;
  /**
   * Names of checks that must appear earlier in the registry and run before
   * this check. Enforced at startup via {@link validateCheckDependencies} so
   * accidental reorders surface immediately instead of producing subtle
   * context-population bugs at runtime.
   */
  dependsOn?: readonly string[];
  /**
   * Runs the inspection. Throwing is shorthand for "this check failed with
   * severity 'error'" — the runner converts the exception message into a
   * DoctorCheck. Returning a DoctorCheck (or array) lets the check control
   * severity, warnings, and fix hints directly.
   */
  run: (ctx: DoctorCheckContext) => CheckResult | Promise<CheckResult>;
  /**
   * Optional recovery hint attached to the auto-generated failure result
   * when `run` throws. Ignored when `run` returns a DoctorCheck explicitly.
   */
  fix?: string;
}

/**
 * Builds a DoctorCheck object representing a successful "OK" check.
 * Exported for sibling check modules that declare `DoctorCheckDefinition`
 * entries out-of-file (e.g. `doctor-furnace.ts`).
 */
export function ok(name: string): DoctorCheck {
  return { name, passed: true, severity: 'ok', message: 'OK' };
}

/**
 * Builds a DoctorCheck object representing a warning result.
 * Exported for sibling check modules — see {@link ok}.
 */
export function warning(name: string, message: string, fix?: string): DoctorCheck {
  return {
    name,
    passed: true,
    severity: 'warning',
    warning: true,
    message,
    ...(fix ? { fix } : {}),
  };
}

/**
 * Builds a DoctorCheck object representing a failure result.
 * Exported for sibling check modules — see {@link ok}.
 */
export function failure(name: string, message: string, fix?: string): DoctorCheck {
  return { name, passed: false, severity: 'error', message, ...(fix ? { fix } : {}) };
}

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
    run: (ctx) => {
      const patchFilename = ctx.state.pendingResolution?.patchFilename ?? 'unknown';
      return failure(
        'Pending Resolution',
        `You are currently resolving a conflict for patch ${patchFilename}.`,
        'Build and Export commands may behave unexpectedly until "fireforge resolve" is completed.'
      );
    },
  },
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
    // `fireforge watch` has an undeclared hard dependency on watchman —
    // neither `bootstrap` nor `doctor` used to surface it, so operators
    // got through setup → download → build → and only discovered the gap
    // when they tried to start watch mode. A warning-severity doctor row
    // is the right shape: most projects never run watch, so a missing
    // watchman should not fail `doctor` outright, but the information
    // needs to be visible ahead of time rather than at the watch-mode
    // failure site.
    name: 'Watchman available',
    run: async () => {
      // Resolve the absolute path so the OK row names what doctor actually
      // found. The 2026-04-25 eval flagged a confusing case where the
      // operator's interactive shell returned no result for `which
      // watchman` but doctor still printed "OK" — the cause was a
      // PATH-export discrepancy between the shell and the spawned
      // subprocess, and surfacing the resolved path makes the discrepancy
      // visible without users having to re-run with a verbose flag.
      const path = await findExecutable('watchman');
      if (path) {
        return {
          name: 'Watchman available',
          passed: true,
          severity: 'ok',
          message: `OK (${path})`,
        };
      }
      return warning(
        'Watchman available',
        'watchman is not installed or not on PATH. "fireforge watch" requires it.',
        'Install watchman (brew install watchman / dnf install watchman / https://facebook.github.io/watchman/), then re-run doctor.'
      );
    },
  },
  {
    name: 'Patches directory exists',
    run: async (ctx) => {
      const patchesExist = await pathExists(ctx.paths.patches);
      return {
        name: 'Patches directory exists',
        passed: true,
        severity: 'ok',
        message: patchesExist ? 'OK' : 'No patches/ directory (optional)',
      };
    },
  },
  {
    name: 'Patches found',
    run: async (ctx) => {
      if (!(await pathExists(ctx.paths.patches))) {
        return [];
      }
      const patchCount = await countPatches(ctx.paths.patches);
      return {
        name: 'Patches found',
        passed: true,
        severity: 'ok',
        message: `${patchCount} patch${patchCount === 1 ? '' : 'es'} found`,
      };
    },
  },
  {
    name: 'Patch manifest consistency',
    dependsOn: ['fireforge.json is valid'],
    run: async (ctx) => {
      if (!(await pathExists(ctx.paths.patches))) {
        return [];
      }

      const manifestConsistencyIssues = await validatePatchesManifestConsistency(ctx.paths.patches);
      if (manifestConsistencyIssues.length === 0) {
        return ok('Patch manifest consistency');
      }

      if (!ctx.options.repairPatchesManifest) {
        return failure(
          'Patch manifest consistency',
          manifestConsistencyIssues.map((issue) => issue.message).join(' '),
          'Run "fireforge doctor --repair-patches-manifest" to rebuild patches.json from patch files.'
        );
      }

      // Repair stamps sourceEsrVersion into every recovered entry. If the
      // earlier "fireforge.json is valid" check failed, ctx.config is
      // undefined and we must refuse rather than fabricate a fallback —
      // persisting 'unknown' into manifest metadata is hard to reverse
      // and would mislead every later command that reads it.
      if (!ctx.config) {
        return failure(
          'Patch manifest consistency',
          'Cannot repair patches.json: fireforge.json could not be loaded, so the Firefox version to stamp into recovered manifest entries is unknown.',
          'Fix the fireforge.json errors reported above and re-run "fireforge doctor --repair-patches-manifest".'
        );
      }

      try {
        const repaired = await rebuildPatchesManifest(
          ctx.paths.patches,
          ctx.config.firefox.version
        );
        // 2026-04-21 eval (Finding #17): the repair path silently
        // overwrote useful human-written descriptions on recovered
        // entries, leaving the queue less trustworthy as an audit
        // trail. The rebuilder now returns the list of filenames
        // whose metadata was entirely invented, and we name them
        // explicitly here so the operator knows exactly which
        // patches to review. Names that DID have a preserved entry
        // (only `filesAffected` / ordering drifted) are not flagged.
        if (repaired.recoveredFilenames.length > 0) {
          for (const filename of repaired.recoveredFilenames) {
            // 2026-04-24 eval Finding 6: the repair path used to tell the
            // operator to hand-edit patches.json, which contradicts the
            // README + Hominis docs that treat the manifest as
            // FireForge-owned. Point at the existing `re-export` /
            // `export` workflow instead so the fix stays inside the tool:
            // re-exporting the same files with an explicit `--description`
            // overwrites the recovered entry with operator-supplied
            // metadata and supersedes the mtime-based createdAt stamp.
            warn(
              `Recovered manifest entry for ${filename} with generic description and mtime-based createdAt. ` +
                'Re-export the affected files with `fireforge re-export <filename> --description "<your description>"` ' +
                '(or `fireforge export <paths...> --name <name> --category <category> --description "<your description>"`) ' +
                'to overwrite the reconstructed metadata, or accept the generic description if the original text is not recoverable. ' +
                'Avoid hand-editing patches.json — FireForge owns that file and will regenerate it on the next manifest consistency pass.'
            );
          }
        }
        return warning(
          'Patch manifest consistency',
          `Rebuilt patches.json from ${repaired.manifest.patches.length} patch${repaired.manifest.patches.length === 1 ? '' : 'es'}${repaired.recoveredFilenames.length > 0 ? ` (${repaired.recoveredFilenames.length} with reconstructed metadata — see warnings above)` : ''}. Review recovered metadata before release.`
        );
      } catch (err: unknown) {
        return failure(
          'Patch manifest consistency',
          toError(err).message,
          'Repair failed. Fix the underlying patch metadata issue and retry the doctor command.'
        );
      }
    },
  },
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
 */
export const DOCTOR_CHECK_ORDER: readonly string[] = DOCTOR_CHECKS.map((check) => check.name);

/**
 * Renders a list of doctor checks to the console and returns the
 * appropriate exit code (success when no errors, general error otherwise).
 * @param checks - The check results to display
 * @returns The exit code reflecting the overall result
 */
export function reportDoctorResults(checks: DoctorCheck[]): ExitCode {
  info('');

  let passedCount = 0;
  let warningCount = 0;
  let failedCount = 0;

  for (const check of checks) {
    const severity =
      check.severity ?? (check.passed ? (check.warning ? 'warning' : 'ok') : 'error');

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
 * Runs the doctor command to diagnose issues.
 * @param projectRoot - Root directory of the project
 */
export async function doctorCommand(
  projectRoot: string,
  options: DoctorOptions = {}
): Promise<DoctorResult> {
  intro('FireForge Doctor');

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
  };

  const checks: DoctorCheck[] = [];
  for (const definition of DOCTOR_CHECKS) {
    checks.push(...(await executeCheck(definition, ctx)));
  }

  const exitCode = reportDoctorResults(checks);
  return { checks, exitCode };
}

/** Registers the doctor command on the CLI program. */
export function registerDoctor(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('doctor')
    .description('Diagnose project issues')
    .option(
      '--repair-patches-manifest',
      'Rebuild patches/patches.json from the current patch files before reporting results'
    )
    .option(
      '--repair-furnace',
      'Reconcile furnace state: clear stale furnace-state.json entries, re-run furnace apply to fix engine drift, and clear the pending-repair marker set by a failed preview teardown'
    )
    .action(
      withErrorHandling(async (options: DoctorOptions) => {
        const result = await doctorCommand(getProjectRoot(), options);
        if (result.exitCode !== 0) {
          process.exitCode = result.exitCode;
        }
      })
    );
}
