// SPDX-License-Identifier: EUPL-1.2
import { createWriteStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Command } from 'commander';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { assertEngineExists } from '../core/engine-precondition.js';
import { warnIfFurnaceStale } from '../core/furnace-staleness.js';
import { hasBuildArtifacts, hasRunnableBundle, run, runMachSmoke } from '../core/mach.js';
import { assertBuildArtifacts } from '../core/mach-build-artifacts.js';
import {
  compileAllowlistFromFile,
  compileAllowlistFromStrings,
  type CompiledAllowlistEntry,
  matchAllowlist,
  matchesSmokeError,
} from '../core/smoke-patterns.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import { BuildError } from '../errors/build.js';
import { ExitCode } from '../errors/codes.js';
import { SmokeRunError } from '../errors/run.js';
import type { CommandContext } from '../types/cli.js';
import type { RunOptions } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { pathExists, removeDir, removeFile } from '../utils/fs.js';
import { info, intro, verbose, warn } from '../utils/logger.js';
import { commanderArgParser, pickDefined, stringListOption } from '../utils/options.js';

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
  await assertEngineExists(paths.engine);

  const buildCheck = await hasBuildArtifacts(paths.engine);
  assertBuildArtifacts(paths.engine, buildCheck, {
    label: 'Run',
    requirement: 'Run requires a completed build.',
    remediation: "Run 'fireforge build' first, then rerun 'fireforge run'.",
    requireExisting: true,
  });

  // `hasBuildArtifacts` only checks for an `obj-*/dist/` directory; a build
  // that configured but has not yet produced the launchable binary passes
  // that check, and `mach run` then fails on the missing binary path.
  // `hasRunnableBundle` narrows the probe to the actual executable so
  // `fireforge run` refuses with a targeted message before handing control
  // to mach. `fireforge watch` stays permissive and surfaces the same
  // information as a banner suffix; watch exists to drive rebuilds of
  // partially-built trees, so blocking there would defeat it.
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

  const exitCode = await run(paths.engine, options.headless ? ['--headless'] : []);

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
  // in the README.
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
    verbose(`Smoke window is ${smokeExit}s; cold starts on slow machines often exceed 30s.`);
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
  let allowlistedErrorHits = 0;
  let allowlistedTotalHits = 0;
  const allowlistHits = new Array<number>(allowlist.length).fill(0);

  const handleLine = (stream: 'stdout' | 'stderr', line: string): void => {
    // Mirror raw output to the terminal so operators watching the smoke
    // run still see what the browser is printing. Stream selection on the
    // mirror preserves stdout/stderr separation for downstream piping.
    const sink = stream === 'stdout' ? process.stdout : process.stderr;
    sink.write(`${line}\n`);

    // Count allowlist hits up-front, regardless of error-pattern match.
    // Incrementing only when the line ALSO matches an error pattern makes an
    // allowlist regex that visibly matches `console.warn: RSLoader:` report 0
    // hits, because `console.warn:` is not a smoke error class — confusing
    // for operators tuning their allowlist. Two numbers are surfaced: the
    // total set of allowlisted lines (what the operator sees in the console)
    // and the subset that were error-class (what the smoke exit contract
    // cares about). The exit contract itself is unchanged.
    const matchIndex = allowlist.length > 0 ? matchAllowlist(line, allowlist) : -1;
    const isAllowlisted = matchIndex !== -1;
    if (isAllowlisted) {
      allowlistedTotalHits += 1;
      allowlistHits[matchIndex] = (allowlistHits[matchIndex] ?? 0) + 1;
    }
    if (!matchesSmokeError(line)) return;
    if (isAllowlisted) {
      allowlistedErrorHits += 1;
      return;
    }
    findings.push({ stream, line });
  };

  // A headed smoke window on a developer desktop absorbs live input: a human
  // interacting with the window mid-run can trigger console errors — a
  // password-manager import scan probing an unreadable profile dir, say —
  // that fail the smoke run looking like a product regression. CI hosts (CI
  // env var set) are assumed display-free and unattended, so the notice
  // stays quiet there.
  if (!options.headless && !process.env['CI']) {
    warn(
      'Headed smoke window: keyboard/mouse input during the window will contaminate the ' +
        'console capture and can fail the run. Pass --headless (or run on an unattended host) ' +
        'for reliable smoke checks.'
    );
  }

  info(`Launching browser (smoke-exit after ${smokeExit}s)...\n`);

  const startedAt = Date.now();
  let result;
  try {
    result = await runMachSmoke(options.headless ? ['run', '--headless'] : ['run'], engineDir, {
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
    allowlistedErrorHits,
    allowlistedTotalHits,
    allowlist,
    allowlistHits,
    findings,
    exitCode: result.exitCode,
  });

  // Exit contract (precedence: unallowed errors dominate timed-out).
  if (findings.length > 0) {
    throw new SmokeRunError(
      `Smoke run observed ${findings.length} unallowed console error(s).`,
      ExitCode.SMOKE_EXIT_FAILURE
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
    `Browser exited with code ${result.exitCode} before smoke-exit window elapsed.`,
    ExitCode.SMOKE_LAUNCH_FAILURE
  );
}

/**
 * Compiles the active allowlist from `--console-allow` CLI values and
 * the optional `--console-allow-file`. Fails fast on a bad regex —
 * better to surface the typo at parse time than to silently let it
 * match nothing and turn every allowed hit into a smoke failure.
 */
async function buildAllowlist(options: RunOptions): Promise<CompiledAllowlistEntry[]> {
  const allow: CompiledAllowlistEntry[] = [];
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
  allowlistedErrorHits: number;
  allowlistedTotalHits: number;
  allowlist: readonly CompiledAllowlistEntry[];
  allowlistHits: readonly number[];
  findings: SmokeFinding[];
  exitCode: number;
}): void {
  const seconds = (args.elapsedMs / 1000).toFixed(1);
  const windowSeconds = (args.smokeTimeoutMs / 1000).toFixed(0);
  const suffix = args.timedOut ? ' (deadline fired — SIGTERM sent to process group)' : '';
  info('');
  info(`Smoke run complete: ${seconds}s elapsed of ${windowSeconds}s window${suffix}`);
  info(`  Unallowed errors: ${args.findings.length}`);
  // The "suppressed errors" count is what the exit contract cares about — the
  // subset of allowlisted hits that would otherwise have been tallied as
  // findings. The "all allowlisted lines" count answers the operator's mental
  // model ("my --console-allow pattern matched N console lines"), without
  // which a visibly matching regex reports 0 hits.
  info(`  Allowlisted error hits (suppressed): ${args.allowlistedErrorHits}`);
  info(`  Allowlisted lines total: ${args.allowlistedTotalHits}`);
  info(`  Child exit code:  ${args.exitCode}`);

  // Per-entry attribution: first-match credit per line, with
  // zero-hit entries always visible — an allowlist entry whose suppressed
  // shape changed upstream is only detectable as a 0× row.
  if (args.allowlist.length > 0) {
    info('  Allowlist attribution (first matching entry per line):');
    args.allowlist.forEach((entry, index) => {
      const hits = args.allowlistHits[index] ?? 0;
      const zeroSuffix = hits === 0 ? '  (never matched — candidate for removal)' : '';
      info(`    ${hits}×  ${entry.origin}  ${entry.source}${zeroSuffix}`);
    });
  }

  if (args.findings.length === 0) return;

  warn('');
  warn(`Unallowed console errors (first ${SMOKE_UNALLOWED_PREVIEW_MAX}):`);
  args.findings.slice(0, SMOKE_UNALLOWED_PREVIEW_MAX).forEach((finding, index) => {
    warn(`  ${index + 1}. [${finding.stream}] ${finding.line}`);
  });
  if (args.findings.length > SMOKE_UNALLOWED_PREVIEW_MAX) {
    const remaining = args.findings.length - SMOKE_UNALLOWED_PREVIEW_MAX;
    warn(`  …and ${remaining} more.`);
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
      commanderArgParser((value: string) => {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== value.trim()) {
          throw new Error(
            `--smoke-exit expects a positive integer number of seconds (got "${value}").`
          );
        }
        return parsed;
      })
    )
    .option(
      '--console-allow <regex>',
      'Allowlist regex (repeatable). Lines that match any entry do not count toward the smoke exit code.',
      ...stringListOption()
    )
    .option(
      '--console-allow-file <path>',
      'Newline-delimited allowlist regex file. Blank lines and # comments are ignored.'
    )
    .option(
      '--capture-console <file>',
      'Mirror captured console output to <file> for post-exit inspection.'
    )
    .option(
      '--headless',
      'Launch the browser with --headless. Recommended for --smoke-exit on a shared desktop: input into a headed smoke window contaminates the console capture.'
    )
    .action(
      withErrorHandling(
        // `args` is the variadic positional, not a Commander flag, so it
        // never appears in this object.
        async (options: Omit<RunOptions, 'args'>) => {
          await runCommand(getProjectRoot(), pickDefined(options));
        }
      )
    );
}
