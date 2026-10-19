// SPDX-License-Identifier: EUPL-1.2
/**
 * The step plan of `fireforge check`: which commands run, with which
 * arguments, in which order constraints, and how each one's output is
 * condensed into its table row.
 *
 * Every built-in step is the real command run as a child `fireforge`
 * process, not an in-process call. That is what keeps the gate's output
 * sane (each command owns its stdout, its machine mode and its error
 * boundary) and what avoids double locking: `check` itself takes no lock,
 * so each child takes exactly the locks its command takes standalone.
 * None of the built-in steps takes the engine session lock, which is why
 * they can run side by side.
 */
import { join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import type { CheckBuiltinStep, CheckConfig, FireForgeConfig } from '../types/config.js';

/** One planned step. */
export interface CheckStepPlan {
  name: string;
  kind: 'builtin' | 'extra';
  /** Executable to spawn. */
  command: string;
  /** Its arguments. */
  args: string[];
  /** The command line as the table prints it. */
  display: string;
  cwd: string;
  timeoutMs?: number | undefined;
  /** Steps that must finish before this one starts (ordering only). */
  after: string[];
  /** Set when the step is planned but not run, with the reason. */
  skipReason?: string | undefined;
  /**
   * Why it is skipped: `config` when `check.skip` names it (a decision),
   * `unavailable` when the project has nothing for it to run (a gap,
   * which `check.failOnSkipped` fails).
   */
  skipKind?: 'config' | 'unavailable' | undefined;
  /** Extra environment for the child. */
  env?: Record<string, string> | undefined;
  /** Condenses a finished run into the table's detail cell. */
  summarize: (output: { stdout: string; combined: string; exitCode: number }) => string;
}

/** The project facts the plan depends on. */
export interface CheckPlanInput {
  projectRoot: string;
  config: FireForgeConfig;
  furnaceConfigured: boolean;
  /** Resolved `--patches` filenames, forwarded to status, verify and lint. */
  patches?: string[] | undefined;
}

/**
 * How to re-run this CLI as a child: the same Node, the same loader flags
 * (minus debugger flags, whose port the parent already holds), the same
 * entry script.
 */
function fireforgeInvocation(): { command: string; prefix: string[] } {
  const entry = process.argv[1];
  if (entry === undefined) {
    throw new GeneralError('Cannot resolve the fireforge CLI entry point for check steps.');
  }
  const loaderFlags = process.execArgv.filter((flag) => !flag.startsWith('--inspect'));
  return { command: process.execPath, prefix: [...loaderFlags, entry] };
}

/** Strips clack's gutter glyphs so a captured line reads as plain text. */
function plainLine(line: string): string {
  return line.replace(/^[\s│■●◆◇▲└┌|]+/u, '').trim();
}

/**
 * The generic detail: nothing on success, and on failure the last line
 * the step printed (its refusal, usually), cut to fit a table cell.
 */
export function lastOutputLine(combined: string, exitCode: number): string {
  if (exitCode === 0) return '';
  const lines = combined
    .split(/\r?\n/)
    .map(plainLine)
    .filter((line) => line.length > 0);
  const last = lines.at(-1) ?? '';
  return last.length > 120 ? `${last.slice(0, 117)}...` : last;
}

function parseJsonDocument(stdout: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Status detail from its `--json --summary` document: the failing classes. */
export function summarizeStatus(output: {
  stdout: string;
  combined: string;
  exitCode: number;
}): string {
  const doc = parseJsonDocument(output.stdout) as
    | {
        summary?: { total?: number };
        check?: { offenders?: { classification: string; count: number }[] };
      }
    | undefined;
  if (doc?.summary === undefined) return lastOutputLine(output.combined, output.exitCode);
  const offenders = doc.check?.offenders ?? [];
  if (offenders.length > 0) {
    return offenders.map((entry) => `${entry.count} ${entry.classification}`).join(', ');
  }
  return `${doc.summary.total ?? 0} changed file(s), none failing`;
}

/** Furnace detail from its `--json` document: counts after exceptions. */
export function summarizeFurnace(output: {
  stdout: string;
  combined: string;
  exitCode: number;
}): string {
  const doc = parseJsonDocument(output.stdout) as
    | {
        summary?: {
          errors: number;
          warnings: number;
          excepted: number;
          staleExceptions: number;
        };
      }
    | undefined;
  if (doc?.summary === undefined) return lastOutputLine(output.combined, output.exitCode);
  const { errors, warnings, excepted, staleExceptions } = doc.summary;
  const extra = [
    excepted > 0 ? `${excepted} excepted` : '',
    staleExceptions > 0 ? `${staleExceptions} stale exception(s)` : '',
  ].filter((part) => part.length > 0);
  return [`${errors} error(s), ${warnings} warning(s)`, ...extra].join(', ');
}

/** Token-coverage detail: the coverage percentage it reports. */
export function summarizeTokenCoverage(output: {
  stdout: string;
  combined: string;
  exitCode: number;
}): string {
  const match = /Token coverage: (\d+)%/.exec(output.combined);
  if (match?.[1] !== undefined) return `coverage ${match[1]}%`;
  if (output.combined.includes('No modified CSS files')) return 'no modified CSS';
  return lastOutputLine(output.combined, output.exitCode);
}

function generic(output: { combined: string; exitCode: number }): string {
  return lastOutputLine(output.combined, output.exitCode);
}

/** The status step's `--check` flags from `check.status`. */
export function statusPolicyArgs(policy: CheckConfig['status']): string[] {
  const args: string[] = [];
  if (policy?.failOn !== undefined) args.push('--fail-on', policy.failOn.join(','));
  if (policy?.allow !== undefined) args.push('--allow', policy.allow.join(','));
  if (policy?.failOnUnknown === true) args.push('--fail-on-unknown');
  return args;
}

function builtinStep(
  invocation: { command: string; prefix: string[] },
  projectRoot: string,
  name: CheckBuiltinStep,
  args: string[],
  summarize: CheckStepPlan['summarize'],
  extra: Partial<Pick<CheckStepPlan, 'after' | 'skipReason' | 'timeoutMs'>> = {}
): CheckStepPlan {
  return {
    name,
    kind: 'builtin',
    command: invocation.command,
    args: [...invocation.prefix, ...args],
    display: `fireforge ${args.join(' ')}`,
    cwd: projectRoot,
    timeoutMs: extra.timeoutMs,
    after: extra.after ?? [],
    skipReason: extra.skipReason,
    skipKind: extra.skipReason !== undefined ? 'unavailable' : undefined,
    summarize,
  };
}

/** A built-in step's budget: `check.timeouts.<step>`, else `check.timeout`. */
function builtinTimeoutMs(check: CheckConfig, name: CheckBuiltinStep): number | undefined {
  const seconds = check.timeouts?.[name] ?? check.timeout;
  return seconds !== undefined ? seconds * 1000 : undefined;
}

/** Runs a project command line through the platform shell. */
function shellInvocation(commandLine: string): { command: string; args: string[] } {
  return process.platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', commandLine] }
    : { command: '/bin/sh', args: ['-c', commandLine] };
}

/**
 * Builds the full plan: the six built-in steps (with the ones this project
 * cannot run marked skipped) followed by `check.extraSteps[]`.
 *
 * `furnace-validate` waits for `typecheck`, the one built-in step that
 * writes: it regenerates a stale Furnace jsconfig, whose drift
 * `furnace validate` reports. Run side by side, the two would race on that
 * file and the verdict would depend on which won.
 */
export function buildCheckPlan(input: CheckPlanInput): CheckStepPlan[] {
  const { projectRoot, config } = input;
  const invocation = fireforgeInvocation();
  const check = config.check ?? {};
  const patchArgs = input.patches !== undefined ? ['--patches', input.patches.join(',')] : [];
  const lintWarnings =
    check.maxWarnings?.lint !== undefined ? ['--max-warnings', String(check.maxWarnings.lint)] : [];
  const furnaceWarnings =
    check.maxWarnings?.furnace !== undefined
      ? ['--max-warnings', String(check.maxWarnings.furnace)]
      : [];

  const lintReport =
    check.lintReport !== undefined ? join(projectRoot, check.lintReport) : undefined;
  const lintReportArgs = lintReport !== undefined ? ['--report', lintReport] : [];
  const timeoutMs = (name: CheckBuiltinStep): number | undefined => builtinTimeoutMs(check, name);

  const plan: CheckStepPlan[] = [
    builtinStep(
      invocation,
      projectRoot,
      'status',
      ['status', '--json', '--summary', '--check', ...statusPolicyArgs(check.status), ...patchArgs],
      summarizeStatus,
      { timeoutMs: timeoutMs('status') }
    ),
    builtinStep(invocation, projectRoot, 'verify', ['verify', ...patchArgs], generic, {
      timeoutMs: timeoutMs('verify'),
    }),
    builtinStep(
      invocation,
      projectRoot,
      'lint',
      [
        'lint',
        '--per-patch',
        '--notices',
        'summary',
        ...lintWarnings,
        ...lintReportArgs,
        ...patchArgs,
      ],
      generic,
      { timeoutMs: timeoutMs('lint') }
    ),
    builtinStep(invocation, projectRoot, 'typecheck', ['typecheck'], generic, {
      skipReason:
        config.typecheck === undefined ? 'no "typecheck" block in fireforge.json' : undefined,
      timeoutMs: timeoutMs('typecheck'),
    }),
    builtinStep(
      invocation,
      projectRoot,
      'furnace-validate',
      ['furnace', 'validate', '--json', ...furnaceWarnings],
      summarizeFurnace,
      {
        after: ['typecheck'],
        skipReason: input.furnaceConfigured ? undefined : 'no furnace.json',
        timeoutMs: timeoutMs('furnace-validate'),
      }
    ),
    builtinStep(
      invocation,
      projectRoot,
      'token-coverage',
      ['token', 'coverage'],
      summarizeTokenCoverage,
      { timeoutMs: timeoutMs('token-coverage') }
    ),
  ];

  for (const step of check.extraSteps ?? []) {
    const shell = shellInvocation(step.command);
    plan.push({
      name: step.name,
      kind: 'extra',
      command: shell.command,
      args: shell.args,
      display: step.command,
      cwd: step.cwd !== undefined ? join(projectRoot, step.cwd) : projectRoot,
      timeoutMs: step.timeout !== undefined ? step.timeout * 1000 : undefined,
      after: step.after ?? [],
      env: lintReport !== undefined ? { FIREFORGE_CHECK_LINT_REPORT: lintReport } : undefined,
      summarize: generic,
    });
  }

  for (const name of check.skip ?? []) {
    const step = plan.find((entry) => entry.name === name);
    if (step !== undefined) {
      step.skipReason = 'skipped by check.skip in fireforge.json';
      step.skipKind = 'config';
    }
  }
  return plan;
}
