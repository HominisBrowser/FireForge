// SPDX-License-Identifier: EUPL-1.2
/** Rebuilding on change: `mach watch`, which needs watchman to be installed and reachable. */
import { delimiter, dirname, join } from 'node:path';

import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { exists } from '../kernel/fs.js';
import { info } from '../kernel/log.js';
import { findExecutable, run } from '../kernel/process/index.js';
import { machFailure, runMach } from './mach.js';
import { writeMozconfig } from './mozconfig.js';
import { requireBuilt } from './objdir.js';
import type { Workspace } from './workspace.js';

/** Where package managers install watchman when the inherited PATH leaves their directory out. */
const WATCHMAN_DIRECTORIES = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/home/linuxbrew/.linuxbrew/bin',
];

function unusable(message: string, hint: string): FireForgeError {
  return new FireForgeError('watchman-unusable', message, {
    exitCode: ExitCode.MISSING_DEPENDENCY,
    hint,
  });
}

/**
 * The watchman executable: the one on PATH, else one in a directory package
 * managers install into. It is probed, since an installed watchman whose
 * server cannot start would otherwise fail in the middle of the watch.
 *
 * @param env - The environment whose PATH is searched
 * @throws `watchman-unusable` (exit code 7) when it is absent or does not answer
 */
export async function findWatchman(
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<string> {
  let path = env === process.env ? await findExecutable('watchman') : undefined;
  const searched = [
    ...(env === process.env ? [] : (env['PATH'] ?? '').split(delimiter).filter(Boolean)),
    ...WATCHMAN_DIRECTORIES,
  ];
  for (const directory of searched) {
    if (path !== undefined) break;
    if (await exists(join(directory, 'watchman'))) path = join(directory, 'watchman');
  }
  if (path === undefined) {
    throw unusable(
      'Watching needs watchman, and it is not installed',
      'Install watchman, then retry.'
    );
  }
  const probe = await run(path, ['--version'], { timeoutMs: 5_000, timeoutIsResult: true });
  if (probe.exitCode !== 0 || probe.timedOut || probe.stdout.trim() === '') {
    throw unusable(
      `watchman at ${path} did not answer "--version"`,
      'Restart it with "watchman shutdown-server", or reinstall it.'
    );
  }
  return path;
}

/** How a watch runs. */
export interface WatchOptions {
  /** The environment watchman is looked up in. Default: this process's. */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Watches the engine and rebuilds front-end files as they change, until
 * interrupted. The directory of the watchman found is put first on mach's
 * PATH: a shell finds a package manager's watchman that the PATH a child
 * process inherits often lacks.
 *
 * @param workspace - A workspace holding a completed build
 * @param options - See {@link WatchOptions}
 * @throws `build-missing` when nothing is built, `watchman-unusable` (exit
 *   code 7), `mach-failed` (exit code 5) when the watch ends by itself
 */
export async function watch(workspace: Workspace, options: WatchOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const watchman = await findWatchman(env);
  await requireBuilt(workspace);
  await writeMozconfig(workspace);
  const directories = (env['PATH'] ?? '').split(delimiter).filter(Boolean);
  const path = [dirname(watchman), ...directories.filter((entry) => entry !== dirname(watchman))];
  info('Watching for changes. Press Ctrl+C to stop.');
  const result = await runMach(workspace, ['watch'], { env: { PATH: path.join(delimiter) } });
  // 130 and 143: the operator stopped it.
  if (result.exitCode === 0 || result.exitCode === 130 || result.exitCode === 143) return;
  const output = `${result.stdout}\n${result.stderr}`;
  const configuredWithout =
    /watchman/i.test(output) && /configure time|configured|configuration time/i.test(output);
  throw machFailure(
    'mach watch',
    result,
    configuredWithout
      ? 'The object directory was configured before watchman was installed. Run "fireforge build" so configure sees it, then retry.'
      : /Operation not permitted|EPERM|EACCES/i.test(output)
        ? 'watchman may not be allowed to read the engine directory. Grant it and your terminal file access, then run "watchman shutdown-server".'
        : `watchman was found at ${watchman}. If mach timed out subscribing, restart it with "watchman shutdown-server".`
  );
}
