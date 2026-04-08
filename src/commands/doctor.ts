// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';

import { configExists, getProjectPaths, loadConfig, loadState } from '../core/config.js';
import { getCurrentBranch, getHead, isGitRepository, isMissingHeadError } from '../core/git.js';
import { ensureGit } from '../core/git-base.js';
import { expandUntrackedDirectoryEntries, getWorkingTreeStatus } from '../core/git-status.js';
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
import type { FireForgeState, ProjectPaths } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { error, info, intro, outro, success, warn } from '../utils/logger.js';

/**
 * Runs a doctor check and returns the result.
 */
async function runCheck(
  name: string,
  check: () => void | Promise<void>,
  fix?: string
): Promise<DoctorCheck> {
  try {
    await check();
    return { name, passed: true, severity: 'ok', message: 'OK' };
  } catch (error: unknown) {
    const message = toError(error).message;
    const result: DoctorCheck = { name, passed: false, severity: 'error', message };
    if (fix !== undefined) {
      result.fix = fix;
    }
    return result;
  }
}

function summarizeWorkingTreeChangeCount(changeCount: number): string {
  return `Engine working tree has ${changeCount} local change${changeCount === 1 ? '' : 's'}. Some FireForge commands assume a clean baseline and may behave differently until these are exported, discarded, or committed.`;
}

async function collectEngineChecks(
  paths: ProjectPaths,
  state: FireForgeState,
  engineExists: boolean
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  if (!engineExists) {
    return checks;
  }

  // Check 6: Engine is a git repository
  const isGitRepo = await isGitRepository(paths.engine);
  checks.push({
    name: 'Engine is git repository',
    passed: isGitRepo,
    severity: isGitRepo ? 'ok' : 'error',
    message: isGitRepo ? 'OK' : 'engine/ is not a git repository',
    ...(!isGitRepo ? { fix: 'Run "fireforge download --force" to reinitialize' } : {}),
  });

  // Only run git-dependent checks if the engine is actually a git repo
  if (isGitRepo) {
    let currentHead: string | undefined;
    let canValidateBranch = true;

    // Engine consistency checks
    if (state.baseCommit) {
      try {
        currentHead = await getHead(paths.engine);
      } catch (error: unknown) {
        if (!isMissingHeadError(error)) {
          throw error;
        }

        canValidateBranch = false;
        checks.push({
          name: 'Engine state consistency',
          passed: false,
          severity: 'error',
          message:
            'Engine repository has no baseline commit yet. A previous "fireforge download" likely stopped after git init but before the initial Firefox commit was created.',
          fix: 'Re-run "fireforge download --force" to recreate the baseline repository cleanly.',
        });
      }

      if (canValidateBranch && currentHead !== state.baseCommit) {
        checks.push({
          name: 'Engine state consistency',
          passed: false,
          severity: 'error',
          message:
            'HEAD differs from baseCommit. FireForge expects the engine repository to remain at the downloaded baseline commit; branch switches or commits inside engine/ can break import, resolve, and patch regeneration workflows.',
          fix: 'Reset engine/ to the baseline commit or re-run "fireforge download --force".',
        });
      } else if (canValidateBranch) {
        checks.push({
          name: 'Engine state consistency',
          passed: true,
          severity: 'ok',
          message: 'OK',
        });
      }
    }

    const rawStatus = await getWorkingTreeStatus(paths.engine);
    const workingTreeStatus = await expandUntrackedDirectoryEntries(paths.engine, rawStatus);
    if (workingTreeStatus.length > 0) {
      checks.push({
        name: 'Engine working tree',
        passed: true,
        severity: 'warning',
        warning: true,
        message: summarizeWorkingTreeChangeCount(workingTreeStatus.length),
        fix: 'Use "fireforge status" to review changes, then export, discard, or reset them as appropriate.',
      });
    } else {
      checks.push({
        name: 'Engine working tree',
        passed: true,
        severity: 'ok',
        message: 'OK',
      });
    }

    let branch: string | undefined;
    if (canValidateBranch) {
      try {
        branch = await getCurrentBranch(paths.engine);
      } catch (error: unknown) {
        if (!isMissingHeadError(error)) {
          throw error;
        }

        canValidateBranch = false;
        checks.push({
          name: 'Engine branch',
          passed: false,
          severity: 'error',
          message:
            'Engine repository has no baseline commit yet. A previous "fireforge download" likely stopped before git created the initial Firefox commit.',
          fix: 'Re-run "fireforge download --force" to recreate the baseline repository cleanly.',
        });
      }
    }

    if (
      !canValidateBranch &&
      branch === undefined &&
      currentHead === undefined &&
      !state.baseCommit
    ) {
      // An unborn repository can fail branch detection before state.json records baseCommit.
      // The error above already explains the recovery path, so avoid adding extra noise here.
    } else if (!canValidateBranch) {
      checks.push({
        name: 'Engine branch',
        passed: true,
        severity: 'warning',
        warning: true,
        message: 'Skipped branch validation because the baseline commit is missing.',
        fix: 'Finish recreating the engine baseline with "fireforge download --force".',
      });
    } else if (branch === 'firefox') {
      checks.push({
        name: 'Engine branch',
        passed: true,
        severity: 'ok',
        message: 'OK',
      });
    } else if (branch === 'HEAD' && state.baseCommit && currentHead === state.baseCommit) {
      checks.push({
        name: 'Engine branch',
        passed: true,
        severity: 'warning',
        warning: true,
        message:
          'Engine is detached at the recorded base commit. This is acceptable for disposable worktrees and audit clones.',
        fix: 'If this is your primary workspace, checkout the "firefox" branch to match FireForge defaults.',
      });
    } else {
      checks.push({
        name: 'Engine branch',
        passed: false,
        severity: 'error',
        message: `Engine is on branch "${branch}", but expected "firefox".`,
      });
    }
  }

  // Check 7: mach available
  checks.push(
    await runCheck(
      'mach available',
      async () => {
        await ensureMach(paths.engine);
      },
      'Firefox source may be corrupted. Re-download with "fireforge download --force"'
    )
  );

  return checks;
}

function reportDoctorResults(checks: DoctorCheck[]): ExitCode {
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

async function collectProjectChecks(
  paths: ProjectPaths,
  engineExists: boolean,
  firefoxVersion: string | undefined,
  options: DoctorOptions
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  const patchesExist = await pathExists(paths.patches);
  checks.push({
    name: 'Patches directory exists',
    passed: true,
    severity: 'ok',
    message: patchesExist ? 'OK' : 'No patches/ directory (optional)',
  });

  if (patchesExist) {
    const patchCount = await countPatches(paths.patches);
    checks.push({
      name: 'Patches found',
      passed: true,
      severity: 'ok',
      message: `${patchCount} patch${patchCount === 1 ? '' : 'es'} found`,
    });

    const manifestConsistencyIssues = await validatePatchesManifestConsistency(paths.patches);
    if (manifestConsistencyIssues.length > 0) {
      if (options.repairPatchesManifest) {
        try {
          const repairedManifest = await rebuildPatchesManifest(
            paths.patches,
            firefoxVersion ?? 'unknown'
          );
          checks.push({
            name: 'Patch manifest consistency',
            passed: true,
            severity: 'warning',
            warning: true,
            message:
              `Rebuilt patches.json from ${repairedManifest.patches.length} patch` +
              `${repairedManifest.patches.length === 1 ? '' : 'es'}. Review recovered metadata before release.`,
          });
        } catch (error: unknown) {
          checks.push({
            name: 'Patch manifest consistency',
            passed: false,
            severity: 'error',
            message: toError(error).message,
            fix: 'Repair failed. Fix the underlying patch metadata issue and retry the doctor command.',
          });
        }
      } else {
        checks.push({
          name: 'Patch manifest consistency',
          passed: false,
          severity: 'error',
          message: manifestConsistencyIssues.map((issue) => issue.message).join(' '),
          fix: 'Run "fireforge doctor --repair-patches-manifest" to rebuild patches.json from patch files.',
        });
      }
    } else {
      checks.push({
        name: 'Patch manifest consistency',
        passed: true,
        severity: 'ok',
        message: 'OK',
      });
    }

    if (engineExists) {
      checks.push(
        await runCheck(
          'Patch integrity',
          async () => {
            const issues = await validatePatchIntegrity(paths.patches, paths.engine);
            if (issues.length > 0) {
              const fileList = issues.map((issue) => issue.targetFile).filter(Boolean);
              throw new Error(
                `${issues.length} patch(es) are modification patches for non-existent files: ${fileList.join(', ')}`
              );
            }
          },
          'Re-export affected files with "fireforge export <paths...>" to create full-file patches'
        )
      );
    }
  }

  const configsExist = await pathExists(paths.configs);
  checks.push(
    await runCheck(
      'Configs directory exists',
      () => {
        if (!configsExist) {
          throw new Error('configs/ directory not found');
        }
      },
      'Run "fireforge setup" to create configs'
    )
  );

  return checks;
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

  const checks: DoctorCheck[] = [];
  const paths = getProjectPaths(projectRoot);
  const state = await loadState(projectRoot);
  let config: Awaited<ReturnType<typeof loadConfig>> | undefined;

  // Check 1: Git installed
  checks.push(
    await runCheck(
      'Git installed',
      async () => {
        await ensureGit();
      },
      'Install git from https://git-scm.com/'
    )
  );

  // Check 2: Python supported by mach
  checks.push(
    await runCheck(
      'Python supported by mach',
      async () => {
        await ensurePython(paths.engine);
      },
      'Install a Python version supported by engine/mach, then re-run "fireforge doctor".'
    )
  );

  // Check 3: fireforge.json exists
  checks.push(
    await runCheck(
      'fireforge.json exists',
      async () => {
        if (!(await configExists(projectRoot))) {
          throw new Error('fireforge.json not found');
        }
      },
      'Run "fireforge setup" to create a project'
    )
  );

  // Check 4: fireforge.json is valid
  checks.push(
    await runCheck(
      'fireforge.json is valid',
      async () => {
        config = await loadConfig(projectRoot);
      },
      'Check fireforge.json for syntax errors or missing fields'
    )
  );

  // Check 5: Engine directory exists
  const engineExists = await pathExists(paths.engine);
  checks.push(
    await runCheck(
      'Engine directory exists',
      () => {
        if (!engineExists) {
          throw new Error('engine/ directory not found');
        }
      },
      'Run "fireforge download" to download Firefox source'
    )
  );

  // Check: Pending Resolution
  if (state.pendingResolution) {
    checks.push({
      name: 'Pending Resolution',
      passed: false,
      severity: 'error',
      message: `You are currently resolving a conflict for patch ${state.pendingResolution.patchFilename}.`,
      fix: 'Build and Export commands may behave unexpectedly until "fireforge resolve" is completed.',
    });
  }

  // Engine checks (git repo, state consistency, working tree, branch, mach)
  checks.push(...(await collectEngineChecks(paths, state, engineExists)));
  checks.push(
    ...(await collectProjectChecks(paths, engineExists, config?.firefox.version, options))
  );

  // Display results and return
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
    .action(
      withErrorHandling(async (options: DoctorOptions) => {
        const result = await doctorCommand(getProjectRoot(), options);
        if (result.exitCode !== 0) {
          process.exitCode = result.exitCode;
        }
      })
    );
}
