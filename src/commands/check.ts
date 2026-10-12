// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge check`: the composed static gate. Runs status, verify,
 * per-patch lint, typecheck, Furnace validation and token coverage, plus
 * the project's `check.extraSteps[]`, in parallel, and ends with one
 * `FIREFORGE-VERDICT:` line over a per-step table (or one JSON document
 * under `--json`).
 *
 * Each step is the real command in a child process (see check-steps.ts for
 * why), so a step behaves exactly as it does when run on its own.
 */
import { availableParallelism } from 'node:os';

import { Command } from 'commander';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { furnaceConfigExists } from '../core/furnace-config.js';
import { loadPatchesManifest } from '../core/patch-manifest.js';
import { selectPatchSubset } from '../core/patch-subset.js';
import { GeneralError, InvalidArgumentError, LockContentionError } from '../errors/base.js';
import { ConfigError } from '../errors/config.js';
import type { CommandContext } from '../types/cli.js';
import type { FireForgeConfig } from '../types/config.js';
import { toError } from '../utils/errors.js';
import {
  info,
  intro,
  isMachineOutputMode,
  note,
  outro,
  setMachineOutputMode,
} from '../utils/logger.js';
import {
  formatCheckTable,
  judgeCheck,
  writeCheckJson,
  writeCheckVerdictLine,
} from './check-report.js';
import { runCheckSteps } from './check-run.js';
import { buildCheckPlan, type CheckStepPlan } from './check-steps.js';
import { resolveStatusCheckPolicy } from './status-check.js';

/** Options Commander forwards from `fireforge check`. */
export interface CheckCommandOptions {
  json?: boolean;
  /** Judge only these patches in status, verify and lint. */
  patches?: string[];
  /** Comma-separated step names to leave out. */
  skip?: string;
  /** Comma-separated step names to run, leaving out the rest. */
  only?: string;
  /** Raw `--jobs` value. */
  jobs?: string;
}

function parseNameList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * Applies `--only` and `--skip` to the plan. A step left out this way is
 * dropped from the table rather than shown as skipped: the caller asked
 * for a narrower gate, not a report of what it chose not to run.
 */
export function selectCheckSteps(
  plan: CheckStepPlan[],
  options: Pick<CheckCommandOptions, 'only' | 'skip'>
): CheckStepPlan[] {
  const known = plan.map((step) => step.name);
  const only = parseNameList(options.only);
  const skip = parseNameList(options.skip);
  for (const [flag, names] of [
    ['--only', only],
    ['--skip', skip],
  ] as const) {
    const unknown = (names ?? []).filter((name) => !known.includes(name));
    if (unknown.length > 0) {
      throw new InvalidArgumentError(
        `Unknown ${flag} step "${unknown.join('", "')}". Steps: ${known.join(', ')}.`,
        flag
      );
    }
  }
  return plan.filter(
    (step) => (only === undefined || only.includes(step.name)) && skip?.includes(step.name) !== true
  );
}

/** Parses `--jobs`: a positive integer. Defaults to one slot per CPU. */
export function parseCheckJobs(raw: string | undefined): number {
  if (raw === undefined) return availableParallelism();
  const jobs = Number(raw);
  if (!Number.isInteger(jobs) || jobs < 1) {
    throw new InvalidArgumentError('--jobs must be a positive integer.', '--jobs');
  }
  return jobs;
}

/**
 * Refuses a `check.status` policy the status step would refuse, before any
 * step runs, as the config error it is.
 */
function assertStatusPolicy(config: FireForgeConfig): void {
  const policy = config.check?.status;
  if (policy === undefined) return;
  try {
    resolveStatusCheckPolicy({
      check: true,
      ...(policy.failOn !== undefined ? { failOn: policy.failOn.join(',') } : {}),
      ...(policy.allow !== undefined ? { allow: policy.allow.join(',') } : {}),
      ...(policy.failOnUnknown === true ? { failOnUnknown: true } : {}),
    });
  } catch (error: unknown) {
    throw new ConfigError(`Config field "check.status" is invalid: ${toError(error).message}`);
  }
}

/** Resolves `--patches` once, so a typo fails here rather than in three steps. */
async function resolvePatchScope(
  patchesDir: string,
  requested: string[] | undefined
): Promise<string[] | undefined> {
  if (requested === undefined || requested.length === 0) return undefined;
  const manifest = await loadPatchesManifest(patchesDir);
  if (!manifest || manifest.patches.length === 0) {
    throw new GeneralError('--patches needs a patch queue, but patches.json lists no patches.');
  }
  return selectPatchSubset(
    manifest,
    requested,
    '--patches selects patches (filename, stem, order number, manifest name, or slug).'
  ).map((patch) => patch.filename);
}

/**
 * Runs the composed gate.
 *
 * @param projectRoot - Project root directory
 * @param options - See {@link CheckCommandOptions}
 */
export async function checkCommand(
  projectRoot: string,
  options: CheckCommandOptions = {}
): Promise<void> {
  const previousMachineOutputMode = isMachineOutputMode();
  // `--json` owns stdout from the first byte. On a throw the mode stays
  // engaged and withErrorHandling resets it after routing the refusal.
  if (options.json === true) setMachineOutputMode(true);
  await runCheck(projectRoot, options);
  if (isMachineOutputMode() !== previousMachineOutputMode) {
    setMachineOutputMode(previousMachineOutputMode);
  }
}

async function runCheck(projectRoot: string, options: CheckCommandOptions): Promise<void> {
  intro('FireForge Check');
  const jobs = parseCheckJobs(options.jobs);
  const config = await loadConfig(projectRoot);
  assertStatusPolicy(config);
  const patches = await resolvePatchScope(getProjectPaths(projectRoot).patches, options.patches);

  const plan = selectCheckSteps(
    buildCheckPlan({
      projectRoot,
      config,
      furnaceConfigured: await furnaceConfigExists(projectRoot),
      patches,
    }),
    options
  );
  const runnable = plan.filter((step) => step.skipReason === undefined).length;
  info(
    `Running ${runnable} step(s), up to ${Math.min(jobs, Math.max(1, runnable))} at once${patches ? `, judging ${patches.join(', ')}` : ''}.`
  );

  const results = await runCheckSteps(plan, jobs);
  const verdict = judgeCheck(results);

  if (options.json === true) {
    writeCheckJson(results, verdict);
  } else {
    note(formatCheckTable(results), 'Steps');
    for (const result of results) {
      if (result.status === 'fail' && result.outputTail) {
        note(result.outputTail, `${result.name}: ${result.command}`);
      }
    }
    outro(verdict.passed ? 'Check passed' : `Check failed: ${verdict.failed.join(', ')}`);
    writeCheckVerdictLine(verdict);
  }

  if (verdict.reason === 'lock-timeout') {
    throw new LockContentionError(
      `fireforge check: ${verdict.failed.join(', ')} could not take their locks in time. Re-run when the holder is done.`
    );
  }
  if (!verdict.passed) {
    throw new GeneralError(
      `fireforge check failed: ${verdict.failed.join(', ')}. Run a failing step on its own for its full output.`
    );
  }
}

/** Registers the `check` command on the CLI program. */
export function registerCheck(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('check')
    .description(
      'Composed static gate: status, verify, per-patch lint, typecheck, Furnace validation, token coverage and fireforge.json check.extraSteps in parallel, with one FIREFORGE-VERDICT line'
    )
    .option(
      '--json',
      'Write one JSON document (verdict plus a result per step) instead of the table'
    )
    .option(
      '--patches <names...>',
      'Judge only these patches in the status, verify and lint steps (filename, stem, order number, manifest name, or slug)'
    )
    .option('--only <steps>', 'Comma-separated steps to run, leaving out the rest')
    .option('--skip <steps>', 'Comma-separated steps to leave out')
    .option('--jobs <n>', 'Steps to run at once (default: one per CPU)')
    .action(
      withErrorHandling(async (options: CheckCommandOptions) => {
        await checkCommand(getProjectRoot(), options);
      })
    );
}
