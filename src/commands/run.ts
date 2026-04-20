// SPDX-License-Identifier: EUPL-1.2
import { createWriteStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Command } from 'commander';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { warnIfFurnaceStale } from '../core/furnace-staleness.js';
import {
  buildArtifactMismatchMessage,
  hasBuildArtifacts,
  hasRunnableBundle,
  run,
  runMachSmoke,
} from '../core/mach.js';
import {
  compileAllowlistFromFile,
  compileAllowlistFromStrings,
  matchesAllowlist,
  matchesSmokeError,
} from '../core/smoke-patterns.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import { AmbiguousBuildArtifactsError, BuildError } from '../errors/build.js';
import { ExitCode } from '../errors/codes.js';
import { SmokeRunError } from '../errors/run.js';
import type { CommandContext } from '../types/cli.js';
import type { RunOptions } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { pathExists, removeDir, removeFile } from '../utils/fs.js';
import { info, intro, verbose, warn } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';

/**
 * Exit code returned by smoke-run mode when the captured console stream
 * produced one or more error lines that did NOT match the operator's
 * allowlist.
 */
export const SMOKE_EXIT_FAILURE = ExitCode.SMOKE_EXIT_FAILURE;

/**
 * Exit code returned by smoke-run mode when the browser itself exited
 * with a non-clean status before the smoke window elapsed — i.e. a
 * launch-side failure we could NOT observe as a console error line
 * (crash before console wiring, missing profile, etc.).
 */
export const SMOKE_LAUNCH_FAILURE = ExitCode.SMOKE_LAUNCH_FAILURE;

/** Recommendation surfaced when the smoke window is shorter than a typical cold start. */
const SMOKE_COLD_START_THRESHOLD_MS = 30_000;

/** Maximum number of unallowed error lines to surface in the terminal summary. */
const SMOKE_UNALLOWED_PREVIEW_MAX = 10;

/**
 * Cleans the dev profile to prevent stale-state startup failures.
 *
 * Removes two things:
 * 1. **startupCache/** — Firefox caches compiled chrome JS bytecode here.
 *    When chrome scripts change between builds, the stale cache causes silent
 *    crashes on startup.
 * 2. **.parentlock** — A zero-byte lock file that persists if the previous
 *    session was killed (Ctrl-C, crash, `kill`). Firefox checks this on
 *    startup and silently exits if it exists, assuming another instance owns
 *    the profile.
 *
 * @param engineDir - Path to the engine directory
 */
async function cleanDevProfile(engineDir: string): Promise<void> {
  try {
    const entries = await readdir(engineDir);
    const objDirs = entries.filter((e) => e.startsWith('obj-'));
    if (objDirs.length === 0) {
      return;
    }

    for (const objDir of objDirs) {
      const profileDir = join(engineDir, objDir, 'tmp', 'profile-default');

      const cachePath = join(profileDir, 'startupCache');
      if (await pathExists(cachePath)) {
        await removeDir(cachePath);
      }

      const lockPath = join(profileDir, '.parentlock');
      if (await pathExists(lockPath)) {
        await removeFile(lockPath);
      }
    }
  } catch (error: unknown) {
    verbose(`Non-fatal dev profile cleanup failure: ${toError(error).message}`);
  }
}

/**
 * Runs the run command to launch the built browser.
 * @param projectRoot - Root directory of the project
 */
export async function runCommand(projectRoot: string, options: RunOptions = {}): Promise<void> {
  intro('FireForge Run');

  const paths = getProjectPaths(projectRoot);

  // Check if engine exists
  if (!(await pathExists(paths.engine))) {
    throw new GeneralError('Firefox source not found. Run "fireforge download" first.');
  }

  const buildCheck = await hasBuildArtifacts(paths.engine);
  if (buildCheck.ambiguous && buildCheck.objDirs && buildCheck.objDirs.length > 0) {
    throw new AmbiguousBuildArtifactsError(buildCheck.objDirs);
  }
  const mismatchMessage = buildArtifactMismatchMessage(paths.engine, buildCheck, 'Run');
  if (mismatchMessage) {
    throw new GeneralError(mismatchMessage);
  }
  if (!buildCheck.exists) {
    const detail = buildCheck.objDir
      ? `Build artifacts incomplete in ${buildCheck.objDir}/`
      : 'No build artifacts found (obj-*/ directory missing)';
    throw new GeneralError(
      `Run requires a completed build. ${detail}\n\n` +
        "Run 'fireforge build' first, then rerun 'fireforge run'."
    );
  }

  // `hasBuildArtifacts` only checks for an `obj-*/dist/` directory; a
  // build that configured but hasn't yet produced the launchable binary
  // (common in a long real Firefox compile that the operator stopped
  // and restarted) passes that check, and `mach run` then fails on the
  // missing binary path. `hasRunnableBundle` narrows the probe to the
  // actual executable so `fireforge run` refuses with a targeted
  // message before handing control to mach. `fireforge watch` stays
  // permissive and instead surfaces the same information as a banner
  // suffix; watch is supposed to drive rebuilds of partially-built
  // trees, so blocking there would defeat the feature.
  if (buildCheck.objDir) {
    const config = await loadConfig(projectRoot);
    const bundleCheck = await hasRunnableBundle(paths.engine, config.binaryName, buildCheck.objDir);
    if (!bundleCheck.runnable) {
      const expected = bundleCheck.expectedPath ?? `dist/bin/${config.binaryName}`;
      throw new GeneralError(
        `Run requires a completed build that produced the launchable bundle. ` +
          `Build artifacts exist in ${buildCheck.objDir}/ but the expected binary at ${expected} is missing — ` +
          `the build may have aborted or is still in progress.\n\n` +
          "Run 'fireforge build' and wait for it to finish before retrying 'fireforge run'."
      );
    }
  }

  // Warn if Furnace components changed since the last apply
  await warnIfFurnaceStale(projectRoot);

  // Clean stale profile state to prevent silent startup failures
  await cleanDevProfile(paths.engine);

  if (options.smokeExit !== undefined) {
    await runSmokeExit(paths.engine, options);
    return;
  }

  info('Launching browser...\n');

  const exitCode = await run(paths.engine);

  // Exit-code whitelist:
  //   0   — clean shutdown
  //   130 — SIGINT (Ctrl+C), user-initiated termination
  //   143 — SIGTERM, graceful-shutdown termination
  // SIGKILL (137) and other signal-induced codes are intentionally NOT
  // whitelisted: those indicate abnormal termination the operator should
  // see surface as a build-time error.
  if (exitCode !== 0 && exitCode !== 130 && exitCode !== 143) {
    throw new BuildError(`Browser exited with code ${exitCode}`, 'mach run');
  }
}

/** A single unallowed error line observed during a smoke run. */
interface SmokeFinding {
  stream: 'stdout' | 'stderr';
  line: string;
}

/**
 * Drives the `--smoke-exit` launch path. Runs the browser under
 * {@link runMachSmoke}, scans the merged console stream for error-class
 * lines against the operator-supplied allowlist, and applies the smoke
 * exit contract. The deadline-fires-SIGTERM path is treated as a clean
 * window iff no unallowed errors were observed.
 */
async function runSmokeExit(engineDir: string, options: RunOptions): Promise<void> {
  // Windows lacks the POSIX process-group primitives --smoke-exit leans on to
  // SIGTERM the whole mach → python → firefox tree. Running through anyway
  // would only kill the top-level wrapper and orphan Firefox content
  // processes, so reject the flag up front to match the documented contract
  // in CHANGELOG.md / README.md.
  if (process.platform === 'win32') {
    throw new InvalidArgumentError(
      '--smoke-exit is POSIX-only; process-group semantics do not map cleanly onto Windows.',
      'smokeExit'
    );
  }

  const smokeExit = options.smokeExit;
  // The runCommand caller has already gated on `options.smokeExit !== undefined`,
  // but commander can hand us `0` or negative values through the action
  // layer if the parser in `registerRun` was bypassed (e.g. programmatic
  // use in a test that skips the parser). Guard explicitly so the deadline
  // timer cannot be scheduled at 0 ms and immediately kill the process.
  if (smokeExit === undefined || smokeExit < 1 || !Number.isFinite(smokeExit)) {
    throw new InvalidArgumentError(
      '--smoke-exit expects a positive integer number of seconds.',
      'smokeExit'
    );
  }

  const smokeTimeoutMs = smokeExit * 1000;
  if (smokeTimeoutMs < SMOKE_COLD_START_THRESHOLD_MS) {
    // Not an error — cold starts just tend to exceed the window. Surfacing
    // the hint here instead of failing lets agents run shorter windows
    // intentionally (e.g. warm-cache smoke checks).
    verbose(
      `Smoke window is ${String(smokeExit)}s; cold starts on slow machines often exceed 30s.`
    );
  }

  const allowlist = await buildAllowlist(options);
  const captureStream = options.captureConsole
    ? createWriteStream(options.captureConsole)
    : undefined;
  // createWriteStream opens the fd asynchronously, so ENOENT / EACCES /
  // EISDIR / EROFS surface as an 'error' event *after* the constructor
  // returns. Without a listener Node re-throws as uncaughtException and
  // kills the CLI mid-smoke-run — orphaning the mach → python → firefox
  // tree because the deadline timer never fires. Swallow the event into a
  // warning so the smoke run still terminates cleanly; subsequent mirror
  // writes on the errored stream are silent no-ops.
  captureStream?.on('error', (err: Error) => {
    warn(`--capture-console stream error: ${err.message}`);
  });

  const findings: SmokeFinding[] = [];
  let allowlistedHits = 0;

  const handleLine = (stream: 'stdout' | 'stderr', line: string): void => {
    // Mirror raw output to the terminal so operators watching the smoke
    // run still see what the browser is printing. Stream selection on the
    // mirror preserves stdout/stderr separation for downstream piping.
    const sink = stream === 'stdout' ? process.stdout : process.stderr;
    sink.write(`${line}\n`);
    if (!matchesSmokeError(line)) return;
    if (matchesAllowlist(line, allowlist)) {
      allowlistedHits += 1;
      return;
    }
    findings.push({ stream, line });
  };

  info(`Launching browser (smoke-exit after ${String(smokeExit)}s)...\n`);

  const startedAt = Date.now();
  let result;
  try {
    result = await runMachSmoke(['run'], engineDir, {
      smokeTimeoutMs,
      onStdoutLine: (line) => {
        handleLine('stdout', line);
      },
      onStderrLine: (line) => {
        handleLine('stderr', line);
      },
      ...(captureStream ? { mirror: { stdout: captureStream, stderr: captureStream } } : {}),
    });
  } finally {
    captureStream?.end();
  }

  const elapsedMs = Date.now() - startedAt;
  reportSmokeSummary({
    smokeTimeoutMs,
    elapsedMs,
    timedOut: result.timedOut,
    allowlistedHits,
    findings,
    exitCode: result.exitCode,
  });

  // Exit contract (precedence: unallowed errors dominate timed-out).
  if (findings.length > 0) {
    throw new SmokeRunError(
      `Smoke run observed ${String(findings.length)} unallowed console error(s).`,
      SMOKE_EXIT_FAILURE
    );
  }

  if (result.timedOut) {
    // Clean window — SIGTERM from us. Treat as success.
    return;
  }

  if (result.exitCode === 0 || result.exitCode === 130 || result.exitCode === 143) {
    return;
  }

  throw new SmokeRunError(
    `Browser exited with code ${String(result.exitCode)} before smoke-exit window elapsed.`,
    SMOKE_LAUNCH_FAILURE
  );
}

/**
 * Compiles the active allowlist from `--console-allow` CLI values and
 * the optional `--console-allow-file`. Fails fast on a bad regex —
 * better to surface the typo at parse time than to silently let it
 * match nothing and turn every allowed hit into a smoke failure.
 */
async function buildAllowlist(options: RunOptions): Promise<RegExp[]> {
  const allow: RegExp[] = [];
  if (options.consoleAllow && options.consoleAllow.length > 0) {
    try {
      allow.push(...compileAllowlistFromStrings(options.consoleAllow));
    } catch (error: unknown) {
      throw new InvalidArgumentError(toError(error).message, 'consoleAllow');
    }
  }
  if (options.consoleAllowFile) {
    try {
      const body = await readFile(options.consoleAllowFile, 'utf8');
      allow.push(...compileAllowlistFromFile(body, options.consoleAllowFile));
    } catch (error: unknown) {
      throw new InvalidArgumentError(
        `Failed to read --console-allow-file: ${toError(error).message}`,
        'consoleAllowFile'
      );
    }
  }
  return allow;
}

/**
 * Prints the human-readable summary block that follows every smoke run.
 * Called once, right before the exit-code decision. Keeps the reporting
 * path separate from exit-contract logic so a test can render summaries
 * without mocking the BuildError construction.
 */
function reportSmokeSummary(args: {
  smokeTimeoutMs: number;
  elapsedMs: number;
  timedOut: boolean;
  allowlistedHits: number;
  findings: SmokeFinding[];
  exitCode: number;
}): void {
  const seconds = (args.elapsedMs / 1000).toFixed(1);
  const windowSeconds = (args.smokeTimeoutMs / 1000).toFixed(0);
  const suffix = args.timedOut ? ' (deadline fired — SIGTERM sent to process group)' : '';
  info('');
  info(`Smoke run complete: ${seconds}s elapsed of ${windowSeconds}s window${suffix}`);
  info(`  Unallowed errors: ${String(args.findings.length)}`);
  info(`  Allowlisted hits: ${String(args.allowlistedHits)}`);
  info(`  Child exit code:  ${String(args.exitCode)}`);

  if (args.findings.length === 0) return;

  warn('');
  warn(`Unallowed console errors (first ${String(SMOKE_UNALLOWED_PREVIEW_MAX)}):`);
  args.findings.slice(0, SMOKE_UNALLOWED_PREVIEW_MAX).forEach((finding, index) => {
    warn(`  ${String(index + 1)}. [${finding.stream}] ${finding.line}`);
  });
  if (args.findings.length > SMOKE_UNALLOWED_PREVIEW_MAX) {
    const remaining = args.findings.length - SMOKE_UNALLOWED_PREVIEW_MAX;
    warn(`  …and ${String(remaining)} more.`);
  }
}

/** Registers the run command on the CLI program. */
export function registerRun(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('run')
    .description('Launch the built browser')
    .option(
      '--smoke-exit <seconds>',
      'Smoke-run mode (POSIX only): launch, capture console, SIGTERM the process group after <seconds>. Exit 0 on a clean window, 12 on unallowed errors, 13 on launch failure.',
      (value: string) => {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== value.trim()) {
          throw new Error(
            `--smoke-exit expects a positive integer number of seconds (got "${value}").`
          );
        }
        return parsed;
      }
    )
    .option(
      '--console-allow <regex>',
      'Allowlist regex (repeatable). Lines that match any entry do not count toward the smoke exit code.',
      (value: string, acc: string[]) => {
        acc.push(value);
        return acc;
      },
      [] as string[]
    )
    .option(
      '--console-allow-file <path>',
      'Newline-delimited allowlist regex file. Blank lines and # comments are ignored.'
    )
    .option(
      '--capture-console <file>',
      'Mirror captured console output to <file> for post-exit inspection.'
    )
    .action(
      withErrorHandling(
        async (options: {
          smokeExit?: number;
          consoleAllow?: string[];
          consoleAllowFile?: string;
          captureConsole?: string;
        }) => {
          await runCommand(getProjectRoot(), pickDefined(options));
        }
      )
    );
}
