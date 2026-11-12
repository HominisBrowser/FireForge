// SPDX-License-Identifier: EUPL-1.2
/**
 * What the xpcshell harness needs on a fork that upstream does not provide.
 *
 * Application directory: the harness reads the appdir override from the
 * manifest key `<appname>-appdir`. A rebranded build's appname is not
 * `firefox`, so the common `firefox-appdir = "browser"` is ignored, the
 * harness resolves `resource:///` one level above the real application, and
 * every `resource:///modules/...` import fails. When the manifest has only
 * the Firefox key, FireForge passes `--app-path` itself.
 *
 * Profile: the harness defaults its profile to one fixed temporary path, so
 * two invocations on one host corrupt each other's. Each gets its own.
 *
 * Stale install symlink: an interrupted install can leave a symlink under
 * the object directory's `_tests` that makes the next install fail with
 * `FileExistsError`. That one symlink is removed and the dispatch retried.
 */
import { join, posix, relative } from 'node:path';

import {
  isInside,
  listDir,
  makeTempDir,
  pathInfo,
  readTextIfExists,
  remove,
} from '../kernel/fs.js';
import { isRecord, parseJson } from '../kernel/json.js';
import { info, warn } from '../kernel/log.js';
import { defaultValue } from '../mozbuild/index.js';

/** The environment variable the xpcshell harness reads its profile directory from. */
export const PROFILE_ENV = 'XPCSHELL_TEST_PROFILE_DIR';

async function readAppname(objDir: string): Promise<string> {
  const text = await readTextIfExists(join(objDir, 'mozinfo.json'));
  if (text === undefined) return 'firefox';
  const parsed = parseJson(text, { source: join(objDir, 'mozinfo.json') });
  return isRecord(parsed) && typeof parsed['appname'] === 'string' ? parsed['appname'] : 'firefox';
}

/** The nearest `xpcshell.toml` at or above a test, engine-relative. */
async function nearestManifest(engineDir: string, test: string): Promise<string | undefined> {
  for (let dir = posix.dirname(test); dir !== '.' && dir !== ''; dir = posix.dirname(dir)) {
    const candidate = `${dir}/xpcshell.toml`;
    if ((await pathInfo(join(engineDir, candidate)))?.kind === 'file') return candidate;
  }
  return undefined;
}

/** Where an appdir lives in a build: `dist/bin/<dir>`, or inside the macOS bundle's Resources. */
async function locateAppdir(objDir: string, appdir: string): Promise<string | undefined> {
  const flat = join(objDir, 'dist', 'bin', appdir);
  const bundles = (await listDir(join(objDir, 'dist'))).filter((entry) =>
    entry.name.endsWith('.app')
  );
  const bundled = bundles.map((entry) =>
    join(objDir, 'dist', entry.name, 'Contents', 'Resources', appdir)
  );
  const order = process.platform === 'darwin' ? [...bundled, flat] : [flat, ...bundled];
  for (const candidate of order) {
    const kind = (await pathInfo(candidate))?.kind;
    if (kind === 'directory' || kind === 'symlink') return candidate;
  }
  return undefined;
}

/**
 * The `--app-path` argument a rebranded build needs for these xpcshell
 * tests, or none: when the build is Firefox, when the manifests already
 * use the build's own key, or when the caller passed `--app-path`.
 *
 * @param engineDir - The engine
 * @param objDir - The development object directory
 * @param tests - The dispatch's xpcshell tests
 * @param machArgs - The caller's mach arguments
 */
export async function appPathArguments(
  engineDir: string,
  objDir: string,
  tests: readonly string[],
  machArgs: readonly string[]
): Promise<string[]> {
  if (machArgs.some((arg) => arg.startsWith('--app-path='))) return [];
  const appname = await readAppname(objDir);
  if (appname === 'firefox') return [];
  const found = new Map<string, string>();
  for (const test of tests) {
    const manifest = await nearestManifest(engineDir, test);
    const text =
      manifest === undefined ? undefined : await readTextIfExists(join(engineDir, manifest));
    if (manifest === undefined || text === undefined) continue;
    if (defaultValue(manifest, text, `${appname}-appdir`) !== undefined) continue;
    const appdir = defaultValue(manifest, text, 'firefox-appdir')?.value;
    if (appdir === undefined) continue;
    const located = await locateAppdir(objDir, appdir);
    if (located === undefined) {
      warn(
        `${manifest} asks for appdir "${appdir}", which the build does not have under ${objDir}/dist; the build may be stale.`
      );
      return [];
    }
    found.set(located, manifest);
  }
  if (found.size > 1) {
    warn(
      `The xpcshell manifests ask for different appdirs (${[...found.keys()].join(', ')}); pass --mach-arg=--app-path=<path>.`
    );
    return [];
  }
  const [entry] = found;
  if (entry === undefined) return [];
  info(
    `Passing --app-path=${entry[0]} (${entry[1]} sets firefox-appdir; this build's appname is ${appname}).`
  );
  return [`--app-path=${entry[0]}`];
}

/**
 * Runs `body` with a fresh xpcshell profile directory in its environment,
 * removed afterwards. A profile directory the caller set is used as is.
 *
 * @param env - The harness environment
 * @param body - The dispatch
 */
export async function withProfileDir<T>(
  env: Readonly<Record<string, string>>,
  body: (env: Record<string, string>) => Promise<T>
): Promise<T> {
  if ((env[PROFILE_ENV] ?? process.env[PROFILE_ENV] ?? '') !== '') return body({ ...env });
  const dir = await makeTempDir('fireforge-xpcshell-profile-');
  try {
    return await body({ ...env, [PROFILE_ENV]: dir });
  } finally {
    await remove(dir).catch(() => undefined);
  }
}

/**
 * Removes the stale `_tests` symlink a `FileExistsError` names, when it is
 * one: a quoted destination inside the object directory's `_tests` that is
 * a symlink.
 *
 * @param objDir - The development object directory
 * @param output - The failed dispatch's output
 * @returns Whether one was removed, so the dispatch should run again
 */
export async function repairStaleInstallLink(objDir: string, output: string): Promise<boolean> {
  const match =
    /FileExistsError[^\n]*File exists:\s+(?:(?:'[^']*'|"[^"]*")\s*->\s*)?['"]([^'"]+)['"]/i.exec(
      output
    );
  const destination = match?.[1];
  if (destination === undefined || !isInside(join(objDir, '_tests'), destination)) return false;
  if ((await pathInfo(destination))?.kind !== 'symlink') return false;
  await remove(destination);
  warn(
    `Removed the stale harness symlink ${relative(objDir, destination)} under the object directory; running the dispatch again.`
  );
  return true;
}
