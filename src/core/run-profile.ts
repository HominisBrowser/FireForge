// SPDX-License-Identifier: EUPL-1.2
/**
 * Profile selection for `fireforge run`.
 *
 * `mach run` on desktop has no `--profile` option of its own: its parser's
 * `--profile/-P` belongs to the Android run parser. On desktop a profile
 * reaches Firefox as a program parameter (`-profile <dir>`), and mach skips
 * creating the objdir's `tmp/profile-default` when it sees one among the
 * params.
 * Mach's `--temp-profile` does mint a fresh directory, but inside the objdir
 * and never removes it, so FireForge owns the temporary profile instead:
 * it creates the directory, seeds the two prefs mach would have written,
 * passes it as `-profile`, and deletes it when the run ends.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { InvalidArgumentError } from '../errors/base.js';
import { isProcessAlive, toError } from '../utils/errors.js';
import { verbose, warn } from '../utils/logger.js';

/** Directory-name prefix of every FireForge-owned temporary run profile. */
export const RUN_PROFILE_PREFIX = 'fireforge-run-profile-';

/** Marker file naming the pid of the FireForge process that owns the profile. */
const OWNER_MARKER = '.fireforge-run-owner';

/**
 * The prefs `mach run` writes into the profiles it creates itself. A profile
 * passed with `-profile` gets none of them, and a first-run default-browser
 * prompt would sit in a headed smoke window.
 */
const SEEDED_USER_JS =
  'user_pref("browser.shell.checkDefaultBrowser", false);\n' +
  'user_pref("browser.aboutConfig.showWarning", false);\n';

/** The profile a run launches with, and how to release it afterwards. */
export interface RunProfile {
  /** Program parameters to append to `mach run` (empty for mach's default). */
  args: string[];
  /** Absolute profile directory, when one was chosen. */
  dir?: string;
  /** Whether FireForge created the directory and will delete it. */
  temporary: boolean;
  /** Removes a temporary profile. A no-op otherwise. Never throws. */
  dispose: () => Promise<void>;
}

/** Inputs to {@link resolveRunProfile}. */
export interface RunProfileRequest {
  /** `--profile <path>`: launch with this directory, left in place. */
  profile?: string | undefined;
  /** `--temp-profile`: launch with a fresh directory removed afterwards. */
  tempProfile?: boolean | undefined;
  /**
   * Whether this is a `--smoke-exit` run. A smoke run with neither flag gets
   * a temporary profile: the step exists to prove what the build does on a
   * clean start, and the developer's profile-default carries whatever state
   * the last session left.
   */
  smoke: boolean;
  /** Base directory for temporary profiles (defaults to the OS tmpdir). */
  tempRoot?: string | undefined;
}

/**
 * Temporary profiles this process created and has not yet removed. The
 * command's own `finally` loses the race to the entry point's signal
 * handler, whose `process.exit` never lets it run, so the handler removes
 * these itself once the browser tree has shut down.
 */
const activeTemporaryProfiles = new Set<string>();

async function removeTemporaryProfile(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
    activeTemporaryProfiles.delete(dir);
  } catch (error: unknown) {
    warn(`Could not remove temporary run profile ${dir}: ${toError(error).message}`);
  }
}

/**
 * Removes every temporary run profile this process still holds. Called by
 * the CLI entry point's signal handler after child shutdown. Never throws.
 */
export async function removeActiveRunProfiles(): Promise<void> {
  await Promise.all([...activeTemporaryProfiles].map((dir) => removeTemporaryProfile(dir)));
}

const NO_PROFILE: RunProfile = {
  args: [],
  temporary: false,
  dispose: () => Promise.resolve(),
};

/**
 * Chooses the profile for a run.
 * @param request - The run's profile flags
 * @returns The profile arguments and their release handle
 */
export async function resolveRunProfile(request: RunProfileRequest): Promise<RunProfile> {
  if (request.profile !== undefined && request.tempProfile === true) {
    throw new InvalidArgumentError(
      '--profile and --temp-profile are mutually exclusive: name a profile or ask for a fresh one.',
      'profile'
    );
  }

  if (request.profile !== undefined) {
    const dir = resolve(request.profile);
    return { args: ['-profile', dir], dir, temporary: false, dispose: NO_PROFILE.dispose };
  }

  if (request.tempProfile !== true && !request.smoke) {
    return NO_PROFILE;
  }

  const dir = await mkdtemp(join(request.tempRoot ?? tmpdir(), RUN_PROFILE_PREFIX));
  activeTemporaryProfiles.add(dir);
  // The owner marker goes in first, so a FireForge killed past this point
  // leaves a directory the next run can prove abandoned.
  await writeFile(join(dir, OWNER_MARKER), `${process.pid}\n`);
  await writeFile(join(dir, 'user.js'), SEEDED_USER_JS);
  verbose(`Temporary run profile: ${dir}`);
  return {
    args: ['-profile', dir],
    dir,
    temporary: true,
    dispose: () => removeTemporaryProfile(dir),
  };
}

/**
 * Removes temporary run profiles whose owning FireForge process is gone.
 * The `finally` that releases a profile covers a clean exit, a failed run
 * and a forwarded SIGINT/SIGTERM, but not a SIGKILL of FireForge itself;
 * this sweep is the backstop for that case. A directory whose marker is
 * missing or unreadable is left alone: nothing proves it is abandoned.
 * @param tempRoot - Base directory to sweep (defaults to the OS tmpdir)
 * @returns The number of directories removed
 */
export async function sweepAbandonedRunProfiles(tempRoot: string = tmpdir()): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(tempRoot);
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith(RUN_PROFILE_PREFIX)) continue;
    const dir = join(tempRoot, entry);
    let pid: number;
    try {
      pid = Number.parseInt((await readFile(join(dir, OWNER_MARKER), 'utf8')).trim(), 10);
    } catch {
      continue;
    }
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || isProcessAlive(pid)) {
      continue;
    }
    try {
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch (error: unknown) {
      verbose(`Could not remove abandoned run profile ${dir}: ${toError(error).message}`);
    }
  }
  return removed;
}
