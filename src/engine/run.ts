// SPDX-License-Identifier: EUPL-1.2
/**
 * Launching the built browser: interactively, or as a smoke start that
 * watches the console for a fixed window and judges what it saw.
 *
 * Profiles: desktop `mach run` has no profile option of its own, so a profile
 * reaches Firefox as the program parameter `-profile <dir>`. A temporary
 * profile is created, seeded and removed here, because the one mach can mint
 * lives in the object directory and is never removed.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ExitCode, FireForgeError, toError } from '../kernel/errors.js';
import {
  appendText,
  listDir,
  makeTempDir,
  readText,
  readTextIfExists,
  remove,
  writeFile,
} from '../kernel/fs.js';
import { info, verbose, warn } from '../kernel/log.js';
import { isProcessAlive, listProcesses } from '../kernel/process/index.js';
import { onShutdown } from '../kernel/signals.js';
import { withDisplay } from './hostLocks.js';
import { runMach } from './mach.js';
import { requireBuilt } from './objdir.js';
import {
  type AllowEntry,
  compileAllowlist,
  createSmokeScan,
  parseAllowlistFile,
  smokeFailure,
  type SmokeReport,
} from './smoke.js';
import type { Workspace } from './workspace.js';

/** How the browser is launched. */
export interface RunOptions {
  /** Arguments passed to the browser after the profile ones. */
  args?: readonly string[];
  /** Launch with this profile directory, which is left in place afterwards. */
  profile?: string;
  /** Launch with a fresh profile that is removed afterwards. Always the case for a smoke start without `profile`. */
  tempProfile?: boolean;
  /** Launch without a window. */
  headless?: boolean;
  /**
   * Smoke start: watch the console for this many seconds, then terminate the
   * browser. Passes when no unallowed error appeared and the browser was
   * still running.
   */
  smokeExit?: number;
  /** Regular expressions of console lines that do not count against a smoke start. */
  consoleAllow?: readonly string[];
  /** A file of such expressions, one per line. */
  consoleAllowFile?: string;
  /** Write everything the browser prints to this file. */
  captureConsole?: string;
  /** Take a screenshot of the first window into this file and exit; implies no window. */
  screenshot?: string;
  /** How long to wait for the display, in milliseconds. */
  waitMs?: number;
}

/** How a launch ended. */
export interface RunResult {
  exitCode: number;
  /** The profile the browser ran with, when one was chosen and kept. */
  profile?: string;
  /** What a smoke start saw. */
  smoke?: SmokeReport & { elapsedMs: number; timedOut: boolean };
  /** The screenshot's path, when one was asked for. */
  screenshot?: string;
}

const PROFILE_PREFIX = 'fireforge-run-profile-';
const OWNER_MARKER = '.fireforge-run-owner';

/** The prefs mach writes into profiles it creates; one passed with `-profile` gets none of them. */
const SEEDED_PREFS =
  'user_pref("browser.shell.checkDefaultBrowser", false);\n' +
  'user_pref("browser.aboutConfig.showWarning", false);\n';

/**
 * Removes temporary profiles whose FireForge was killed before it could.
 * A browser can outlive its FireForge, so a profile some running process
 * names on its command line is still in use.
 */
async function sweepAbandonedProfiles(root: string): Promise<void> {
  const profiles = (await listDir(root).catch(() => [])).filter((entry) =>
    entry.name.startsWith(PROFILE_PREFIX)
  );
  if (profiles.length === 0) return;
  const commands = (await listProcesses(['pid', 'command'])).map((row) => row.command);
  for (const entry of profiles) {
    const dir = join(root, entry.name);
    // Without a readable marker nothing proves the directory abandoned.
    const pid = Number((await readTextIfExists(join(dir, OWNER_MARKER)).catch(() => ''))?.trim());
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || isProcessAlive(pid)) {
      continue;
    }
    if (commands.some((command) => command.includes(dir))) continue;
    await remove(dir).catch((error: unknown) => {
      verbose(`Could not remove abandoned run profile ${dir}: ${toError(error).message}`);
    });
  }
}

interface Profile {
  args: string[];
  /** The directory to report, when one was named. */
  kept?: string;
  dispose(): Promise<void>;
}

/**
 * Chooses the profile. A named or default profile is launched with
 * `-purgecaches`: a front-end build keeps the build id a profile's startup
 * cache is keyed on, so without it a reused profile runs the chrome scripts
 * an earlier build cached.
 */
async function chooseProfile(options: RunOptions): Promise<Profile> {
  const none = (): Promise<void> => Promise.resolve();
  if (options.profile !== undefined) {
    return {
      args: ['-profile', options.profile, '-purgecaches'],
      kept: options.profile,
      dispose: none,
    };
  }
  const fresh =
    options.tempProfile === true ||
    options.smokeExit !== undefined ||
    options.screenshot !== undefined;
  if (!fresh) return { args: ['-purgecaches'], dispose: none };
  await sweepAbandonedProfiles(tmpdir());
  const dir = await makeTempDir(PROFILE_PREFIX);
  // The marker goes in first, so a directory left by a killed run can be proven abandoned.
  await writeFile(join(dir, OWNER_MARKER), `${process.pid}\n`, { durable: false });
  await writeFile(join(dir, 'user.js'), SEEDED_PREFS, { durable: false });
  verbose(`Temporary run profile: ${dir}`);
  let removed: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    removed ??= remove(dir).catch((error: unknown) => {
      warn(`Could not remove the temporary run profile ${dir}: ${toError(error).message}`);
    });
    return removed;
  };
  // An interrupt ends the process before a `finally` runs.
  const disarm = onShutdown('restore', dispose);
  return {
    args: ['-profile', dir],
    async dispose() {
      disarm();
      await dispose();
    },
  };
}

async function readAllowlist(options: RunOptions): Promise<AllowEntry[]> {
  const allow = compileAllowlist(options.consoleAllow ?? []);
  if (options.consoleAllowFile === undefined) return allow;
  let body: string;
  try {
    body = await readText(options.consoleAllowFile);
  } catch (error: unknown) {
    throw new FireForgeError(
      'invalid-argument',
      `Cannot read the allowlist file ${options.consoleAllowFile}: ${toError(error).message}`,
      { exitCode: ExitCode.INVALID_ARGUMENT, cause: error }
    );
  }
  return [...allow, ...parseAllowlistFile(body, options.consoleAllowFile)];
}

/** A sink appending console lines to a file, in order, without blocking the stream. */
async function openCapture(
  path: string | undefined
): Promise<{ line: (line: string) => void; close: () => Promise<void> }> {
  if (path === undefined) return { line: () => undefined, close: () => Promise.resolve() };
  await writeFile(path, '', { durable: false });
  let buffer = '';
  let failed = false;
  let writing = Promise.resolve();
  const flush = (): void => {
    const text = buffer;
    buffer = '';
    writing = writing.then(async () => {
      if (failed || text === '') return;
      try {
        await appendText(path, text);
      } catch (error: unknown) {
        failed = true;
        warn(`Console capture to ${path} stopped: ${toError(error).message}`);
      }
    });
  };
  return {
    line(line) {
      const idle = buffer === '';
      buffer += `${line}\n`;
      // One append per burst of lines: a write is queued when the buffer starts filling.
      if (idle) queueMicrotask(flush);
    },
    async close() {
      flush();
      await writing;
    },
  };
}

function reportSmoke(smoke: NonNullable<RunResult['smoke']>, windowSeconds: number): void {
  const seconds = (smoke.elapsedMs / 1000).toFixed(1);
  info(
    `Smoke start: ${seconds}s of a ${windowSeconds}s window` +
      (smoke.timedOut ? ', browser still running and terminated' : ', browser exited by itself')
  );
  info(`  Console errors: ${smoke.errors.length} (${smoke.allowedErrors} more allowed)`);
  for (const entry of smoke.entries) {
    const cap = entry.maxHits === undefined ? '' : `/${entry.maxHits}`;
    const stale = entry.hits === 0 ? '  (never matched)' : '';
    info(`  ${entry.hits}${cap}  ${entry.origin}  ${entry.source}${stale}`);
  }
  for (const over of smoke.overCap) {
    warn(
      `Allowed pattern "${over.source}" (${over.origin}) matched ${over.hits} lines, over its cap of ${over.maxHits}.`
    );
  }
  for (const line of smoke.errors.slice(0, 10)) warn(`  ${line}`);
  if (smoke.errors.length > 10) warn(`  and ${smoke.errors.length - 10} more.`);
}

async function launch(
  workspace: Workspace,
  options: RunOptions,
  profile: Profile
): Promise<RunResult> {
  const headless = options.headless === true || options.screenshot !== undefined;
  const machArgs = [
    'run',
    ...(headless ? ['--headless'] : []),
    ...profile.args,
    ...(options.screenshot === undefined ? [] : ['--screenshot', options.screenshot]),
    ...(options.args ?? []),
  ];
  const kept = profile.kept === undefined ? {} : { profile: profile.kept };
  const shot = options.screenshot === undefined ? {} : { screenshot: options.screenshot };

  if (options.smokeExit === undefined) {
    // The browser's output is shown on stderr: stdout carries the command's result.
    const capture = await openCapture(options.captureConsole);
    let exitCode: number;
    try {
      ({ exitCode } = await runMach(workspace, machArgs, { onLine: capture.line, hints: false }));
    } finally {
      await capture.close();
    }
    // 130 and 143: the operator closed it with Ctrl+C, or it was asked to stop.
    if (exitCode !== 0 && exitCode !== 130 && exitCode !== 143) {
      throw new FireForgeError('browser-exited', `The browser exited ${exitCode}`, {
        exitCode: ExitCode.BUILD_ERROR,
        hint: 'Its output above names the cause; --capture-console <file> keeps a copy of it.',
      });
    }
    return { exitCode, ...kept, ...shot };
  }

  const scan = createSmokeScan(await readAllowlist(options));
  const capture = await openCapture(options.captureConsole);
  const startedAt = Date.now();
  let exit: { exitCode: number; timedOut: boolean };
  try {
    exit = await runMach(workspace, machArgs, {
      timeoutMs: options.smokeExit * 1000,
      hints: false,
      onLine: (line) => {
        scan.line(line);
        capture.line(line);
      },
    });
  } finally {
    await capture.close();
  }
  const smoke = { ...scan.report(), elapsedMs: Date.now() - startedAt, timedOut: exit.timedOut };
  reportSmoke(smoke, options.smokeExit);
  const failure = smokeFailure(smoke, exit);
  if (failure !== undefined) throw failure;
  return { exitCode: exit.exitCode, smoke, ...kept, ...shot };
}

/**
 * Launches the workspace's built browser.
 *
 * Without `smokeExit` the browser runs until it is closed. With it the run is
 * a smoke start: the console is scanned for `smokeExit` seconds, then the
 * browser's process tree is terminated.
 *
 * A launch with a window holds the host's display lock, so two sessions
 * never put a browser on screen at once.
 *
 * @param workspace - The workspace holding the build
 * @param options - See {@link RunOptions}
 * @throws `build-missing` when nothing is built; `smoke-console-errors` (exit
 *   code 12) when a smoke start saw unallowed errors; `smoke-launch-failed`
 *   (exit code 13) when its browser left before the window elapsed;
 *   `browser-exited` (exit code 5) when a plain launch ended abnormally
 */
export async function runBrowser(
  workspace: Workspace,
  options: RunOptions = {}
): Promise<RunResult> {
  if (options.profile !== undefined && options.tempProfile === true) {
    throw new FireForgeError(
      'invalid-argument',
      'A named profile and a temporary profile cannot both be asked for',
      { exitCode: ExitCode.INVALID_ARGUMENT }
    );
  }
  if (options.smokeExit !== undefined) {
    if (process.platform === 'win32') {
      throw new FireForgeError(
        'invalid-argument',
        'A smoke start needs process groups to end the browser, which Windows does not have',
        { exitCode: ExitCode.INVALID_ARGUMENT }
      );
    }
    if (!Number.isFinite(options.smokeExit) || options.smokeExit <= 0) {
      throw new FireForgeError(
        'invalid-argument',
        'The smoke window must be a positive number of seconds',
        {
          exitCode: ExitCode.INVALID_ARGUMENT,
        }
      );
    }
  }
  await requireBuilt(workspace);
  const profile = await chooseProfile(options);
  try {
    const body = (): Promise<RunResult> => launch(workspace, options, profile);
    const headless = options.headless === true || options.screenshot !== undefined;
    return headless
      ? await body()
      : await withDisplay(workspace.project.host, options.waitMs, body);
  } finally {
    await profile.dispose();
  }
}
