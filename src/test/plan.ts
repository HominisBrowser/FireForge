// SPDX-License-Identifier: EUPL-1.2
/**
 * What a test run will do: the requested paths resolved to the test files
 * their manifests list, each with the harness that runs it, cut into the mach
 * invocations the dispatch mode asks for.
 *
 * A request names test files, test directories, test manifests or globs.
 * Every test file handed to mach is named explicitly, so a directory never
 * sweeps in a sibling that shares its prefix (mach resolves paths by string
 * prefix). A named file that is not a test is refused before anything runs,
 * naming the tests that read it when a manifest lists it as support: a
 * harness handed a support file finds nothing, and xpcshell exits without
 * stopping the servers it started.
 */
import { join, posix } from 'node:path';

import { usageError } from '../cli/command.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { listDir, pathInfo, readTextIfExists, walkFiles } from '../kernel/fs.js';
import { globToRegExp } from '../kernel/glob.js';
import { escapeRegExp } from '../kernel/text.js';
import {
  listTests,
  mozBuildTestManifests,
  supportUsers,
  type TestFlavor,
  testManifestFlavor,
} from '../mozbuild/index.js';

/** The harness family a test belongs to, and the mach command that runs it. */
export type Suite = 'mochitest' | 'xpcshell' | 'generic';

/**
 * How mochitest files share browsers: one browser per file, one browser for
 * all, or one invocation that restarts the browser between files. xpcshell
 * runs every file in a process of its own, so its files always go to one
 * invocation.
 */
export type DispatchMode = 'shards' | 'one-browser' | 'standalone';

/** One mach invocation. */
export interface PlannedDispatch {
  suite: Suite;
  /** Engine-relative paths handed to mach, in order. */
  paths: string[];
  /** Pass mochitest's `--restart-between-tests`. */
  restart: boolean;
}

/** A command a lane runs after a clean harness exit to judge what the harness produced. */
export interface Validator {
  /** Argument vector, placeholders already expanded. */
  command: readonly string[];
  /** Working directory, usually the project root. */
  cwd: string;
}

/** What a caller asks of a test run. */
export interface TestRequest {
  /** Engine-relative test files, directories, manifests or globs. */
  paths: readonly string[];
  /** Engine-relative paths or globs left out of what `paths` selects. */
  exclude?: readonly string[];
  /** Default `shards`. */
  dispatch?: DispatchMode;
  /** Run with a visible window, holding the host's display lock. Default headless. */
  headed?: boolean;
  /** Run the whole plan this many times; every repetition must pass. */
  repeat?: number;
  /** Seed that permutes the order of mochitest invocations; mochitest also shuffles inside one. */
  shuffle?: number;
  /** Further mach arguments, from the allowlist {@link checkMachArgument} enforces. */
  machArgs?: readonly string[];
  /** Environment of the harness. */
  env?: Readonly<Record<string, string>>;
  /** Directory the harness writes its artifacts to (`MOZ_UPLOAD_DIR`). */
  uploadDir?: string;
  /** Directory for the harnesses' per-test JavaScript coverage (`--jscov-dir-prefix`). */
  coverageDir?: string;
  /** Run after every repetition exited clean; a nonzero exit is red. */
  validate?: Validator;
}

/** A resolved, validated test run. */
export interface TestPlan extends TestRequest {
  /** Every test file the run covers, sorted, with its suite. */
  tests: { path: string; suite: Suite }[];
  /** The invocations of one repetition, in order. */
  dispatches: PlannedDispatch[];
  repeat: number;
  headed: boolean;
}

/** A refusal before anything ran: exit code 1, its code a stable class. */
export function refusal(code: string, message: string, hint?: string): FireForgeError {
  return new FireForgeError(code, message, {
    exitCode: ExitCode.GENERAL_ERROR,
    ...(hint === undefined ? {} : { hint }),
  });
}

/** How far above a file its manifest may sit, as `fixtures/` sits below one. */
const MANIFEST_DEPTH = 4;
/** A reftest or crashtest manifest, which `mach test` runs by path. */
const REFTEST_LIST = /(?:^|\/)(?:reftest|crashtests)[\w.-]*\.list$/;
const GLOB = /[*?]/;

/** Skips object directories and VCS metadata in an engine walk. */
const skipBuildOutput = (path: string, kind: string): boolean =>
  kind === 'directory' && /(?:^|\/)(?:obj-[^/]*|\.git|\.hg|node_modules)$/.test(path);

/** A file name a test manifest can have. */
const MANIFEST_FILE = /\.(?:toml|ini)$/;

/**
 * Reads manifests once per plan, and knows which files are test manifests:
 * a name that says so, or a manifest a moz.build in its directory or above
 * lists in a test-manifest variable (`eval.toml` under
 * `BROWSER_CHROME_MANIFESTS`).
 */
class Manifests {
  private readonly texts = new Map<string, string | undefined>();
  private readonly listed = new Map<string, Promise<Map<string, TestFlavor>>>();

  constructor(private readonly engineDir: string) {}

  async read(path: string): Promise<string | undefined> {
    if (!this.texts.has(path)) {
      this.texts.set(path, await readTextIfExists(join(this.engineDir, path)));
    }
    return this.texts.get(path);
  }

  /** The test manifests the moz.build of one directory lists, by path. */
  private listedIn(dir: string): Promise<Map<string, TestFlavor>> {
    let listed = this.listed.get(dir);
    if (listed === undefined) {
      const mozBuild = dir === '' ? 'moz.build' : `${dir}/moz.build`;
      listed = this.read(mozBuild).then(
        (text) =>
          new Map(
            text === undefined
              ? []
              : mozBuildTestManifests(mozBuild, text).map((entry) => [entry.path, entry.flavor])
          )
      );
      this.listed.set(dir, listed);
    }
    return listed;
  }

  /** The flavour of a test manifest, or undefined when the path is not one. */
  async flavor(path: string): Promise<TestFlavor | undefined> {
    const named = testManifestFlavor(path);
    if (named !== undefined || !MANIFEST_FILE.test(path)) return named;
    for (let dir = posix.dirname(path); ; dir = posix.dirname(dir)) {
      const top = dir === '.' || dir === '';
      const flavor = (await this.listedIn(top ? '' : dir)).get(path);
      if (flavor !== undefined || top) return flavor;
    }
  }

  /** Whether a path is a manifest `mach test` runs: a test manifest or a reftest list. */
  async isManifest(path: string): Promise<boolean> {
    return REFTEST_LIST.test(path) || (await this.flavor(path)) !== undefined;
  }

  /** The suite that runs the tests a manifest lists. */
  async suite(manifest: string): Promise<Suite> {
    if (REFTEST_LIST.test(manifest)) return 'generic';
    return (await this.flavor(manifest)) === 'xpcshell' ? 'xpcshell' : 'mochitest';
  }

  /** The test manifests in a file's directory and the few above it. */
  async near(path: string): Promise<{ path: string; text: string }[]> {
    const found: { path: string; text: string }[] = [];
    let dir = posix.dirname(path);
    for (let depth = 0; depth < MANIFEST_DEPTH && dir !== '.' && dir !== ''; depth += 1) {
      const entries = await listDir(join(this.engineDir, dir));
      for (const { name } of entries.filter((entry) => entry.kind === 'file')) {
        const manifest = `${dir}/${name}`;
        if ((await this.flavor(manifest)) === undefined) continue;
        const text = await this.read(manifest);
        if (text !== undefined) found.push({ path: manifest, text });
      }
      dir = posix.dirname(dir);
    }
    return found;
  }
}

/** The tests a manifest lists, with its suite. */
async function manifestTests(
  manifests: Manifests,
  manifest: string
): Promise<{ path: string; suite: Suite }[]> {
  if (REFTEST_LIST.test(manifest)) return [{ path: manifest, suite: 'generic' }];
  const text = await manifests.read(manifest);
  if (text === undefined) return [];
  const suite = await manifests.suite(manifest);
  return listTests(manifest, text).map((path) => ({ path, suite }));
}

/** A named file: a test some nearby manifest lists, or a refusal saying what it is. */
async function resolveFile(
  manifests: Manifests,
  path: string
): Promise<{ path: string; suite: Suite } | FireForgeError> {
  const near = await manifests.near(path);
  for (const manifest of near) {
    if (listTests(manifest.path, manifest.text).includes(path)) {
      return { path, suite: await manifests.suite(manifest.path) };
    }
  }
  const users = supportUsers(path, near);
  if (users.length > 0) {
    const shown = users.slice(0, 5).join(', ');
    const more = users.length > 5 ? ` and ${users.length - 5} more` : '';
    return refusal(
      'not-a-test',
      `${path} is a support file, not a test: its manifest lists it for ${shown}${more}.`,
      'Name those tests instead.'
    );
  }
  return refusal(
    'not-a-test',
    `${path} is not a test: no test manifest beside it lists it.`,
    'Name a test file a manifest lists, a test directory or a test manifest; ' +
      '"fireforge register <path>" adds a new test to its manifest.'
  );
}

/** Every test the manifests under a directory list inside it. */
async function resolveDirectory(
  engineDir: string,
  manifests: Manifests,
  dir: string
): Promise<{ path: string; suite: Suite }[]> {
  const files = await walkFiles(join(engineDir, dir), skipBuildOutput);
  const found: { path: string; suite: Suite }[] = [];
  for (const file of files) {
    const manifest = `${dir}/${file}`;
    if (!(await manifests.isManifest(manifest))) continue;
    for (const test of await manifestTests(manifests, manifest)) {
      if (test.path.startsWith(`${dir}/`)) found.push(test);
    }
  }
  return found;
}

/** The engine files a glob matches, walking only below its fixed prefix. */
async function expandGlob(engineDir: string, glob: string): Promise<string[]> {
  const segments = glob.split('/');
  const fixed = segments.slice(
    0,
    segments.findIndex((segment) => GLOB.test(segment))
  );
  const base = fixed.join('/');
  const pattern = globToRegExp(glob);
  const files = await walkFiles(join(engineDir, base), skipBuildOutput);
  return files
    .map((file) => (base === '' ? file : `${base}/${file}`))
    .filter((file) => pattern.test(file));
}

function normalizeRequest(path: string): string {
  const clean = posix
    .normalize(path.replaceAll('\\', '/').replace(/^engine\//, ''))
    .replace(/\/+$/, '');
  if (
    clean === '' ||
    clean === '.' ||
    clean === '..' ||
    clean.startsWith('../') ||
    clean.startsWith('/')
  ) {
    throw usageError(`${path} is not an engine-relative path`);
  }
  return clean;
}

/**
 * Resolves requested paths to the test files they select.
 *
 * @param engineDir - The workspace's engine
 * @param paths - Engine-relative files, directories, manifests or globs
 * @param exclude - Paths or globs left out
 * @throws `not-a-test` for a named file no manifest lists as a test, `test-path-missing` for a
 *   path that does not exist, `no-tests` when a path selects nothing
 */
export async function resolveTests(
  engineDir: string,
  paths: readonly string[],
  exclude: readonly string[] = []
): Promise<{ path: string; suite: Suite }[]> {
  const manifests = new Manifests(engineDir);
  const selected = new Map<string, Suite>();
  for (const raw of paths) {
    const path = normalizeRequest(raw);
    let tests: { path: string; suite: Suite }[];
    if (GLOB.test(path)) {
      tests = [];
      for (const file of await expandGlob(engineDir, path)) {
        const resolved = await resolveFile(manifests, file);
        if (!(resolved instanceof FireForgeError)) tests.push(resolved);
      }
    } else {
      const info = await pathInfo(join(engineDir, path));
      if (info === undefined) {
        throw refusal(
          'test-path-missing',
          `${path} does not exist in the engine`,
          'A test that comes from the owned changes appears once they are applied to the workspace.'
        );
      }
      if (info.kind === 'directory') tests = await resolveDirectory(engineDir, manifests, path);
      else if (await manifests.isManifest(path)) {
        tests = await manifestTests(manifests, path);
      } else {
        const resolved = await resolveFile(manifests, path);
        if (resolved instanceof FireForgeError) throw resolved;
        tests = [resolved];
      }
    }
    if (tests.length === 0) {
      throw refusal('no-tests', `${path} selects no test that a test manifest lists.`);
    }
    for (const test of tests) selected.set(test.path, test.suite);
  }
  const excluded = exclude
    .map(normalizeRequest)
    .map((entry) =>
      GLOB.test(entry) ? globToRegExp(entry) : new RegExp(`^${escapeRegExp(entry)}(?:/|$)`)
    );
  const tests = [...selected]
    .filter(([path]) => !excluded.some((pattern) => pattern.test(path)))
    .map(([path, suite]) => ({ path, suite }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (tests.length === 0) throw refusal('no-tests', 'The exclusions leave no test to run.');
  return tests;
}

/**
 * Cuts resolved tests into the invocations of one repetition: xpcshell files
 * in one, generic manifests in one, and mochitest files as the mode asks.
 *
 * @param tests - Resolved tests, sorted
 * @param mode - The dispatch mode
 */
export function planDispatches(
  tests: readonly { path: string; suite: Suite }[],
  mode: DispatchMode
): PlannedDispatch[] {
  const of = (suite: Suite): string[] =>
    tests.filter((test) => test.suite === suite).map((test) => test.path);
  const mochitest = of('mochitest');
  const dispatches: PlannedDispatch[] = [];
  if (mode === 'shards') {
    for (const path of mochitest)
      dispatches.push({ suite: 'mochitest', paths: [path], restart: false });
  } else if (mochitest.length > 0) {
    dispatches.push({ suite: 'mochitest', paths: mochitest, restart: mode === 'standalone' });
  }
  for (const suite of ['xpcshell', 'generic'] as const) {
    const paths = of(suite);
    if (paths.length > 0) dispatches.push({ suite, paths, restart: false });
  }
  return dispatches;
}

/**
 * Permutes a list deterministically by a seed, without changing it.
 *
 * @param items - What to permute
 * @param seed - The seed
 */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = 2166136261;
  for (const character of String(seed))
    state = Math.imul(state ^ character.charCodeAt(0), 16777619);
  state = state >>> 0 || 1;
  for (let index = result.length - 1; index > 0; index--) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const other = Math.floor(((state >>> 0) / 2 ** 32) * (index + 1));
    [result[index], result[other]] = [result[other] as T, result[index] as T];
  }
  return result;
}

/**
 * The mach arguments a caller may add. FireForge owns the log, the profile,
 * the browser's control port, the test list and the run shape; a pref whose
 * value names no path, the per-test timeout and the xpcshell application
 * directory are the caller's.
 *
 * @param arg - One argument
 * @throws `invalid-argument` for anything else
 */
export function checkMachArgument(arg: string): void {
  const pref = /^--setpref=([A-Za-z][A-Za-z0-9_.-]*)=[A-Za-z0-9_.:+,@%-]*$/.exec(arg)?.[1];
  if (pref !== undefined && !pref.startsWith('marionette.')) return;
  if (/^--timeout=\d+$/.test(arg) || /^--app-path=\/\S+$/.test(arg)) return;
  throw usageError(
    `--mach-arg ${arg} is not accepted`,
    'Pass --setpref=<name>=<value> (outside marionette.*), --timeout=<seconds> or --app-path=<absolute path>.'
  );
}

/** Environment names a caller never sets: FireForge marks its harness processes with these. */
const OWNED_ENV = /^FIREFORGE_/;

function checkEnvName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || OWNED_ENV.test(name)) {
    throw usageError(
      `--env cannot set ${name}`,
      'Names are letters, digits and _; FIREFORGE_* is reserved.'
    );
  }
}

/**
 * The harness environment `NAME=VALUE` assignments give, later ones winning.
 *
 * @param assignments - Each `NAME=VALUE`
 * @throws `invalid-argument` for an assignment without a name or a name the caller may not set
 */
export function envAssignments(assignments: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const assignment of assignments) {
    const at = assignment.indexOf('=');
    if (at <= 0) throw usageError(`--env ${assignment} is not NAME=VALUE`);
    const name = assignment.slice(0, at);
    checkEnvName(name);
    env[name] = assignment.slice(at + 1);
  }
  return env;
}

/**
 * Resolves and validates a request into a plan.
 *
 * @param engineDir - The workspace's engine
 * @param request - See {@link TestRequest}
 * @throws `invalid-argument` for an unusable option, and the refusals of {@link resolveTests}
 */
export async function planTests(engineDir: string, request: TestRequest): Promise<TestPlan> {
  if (request.paths.length === 0) throw usageError('Name at least one test path');
  for (const arg of request.machArgs ?? []) checkMachArgument(arg);
  for (const name of Object.keys(request.env ?? {})) checkEnvName(name);
  const repeat = request.repeat ?? 1;
  if (!Number.isSafeInteger(repeat) || repeat < 1) throw usageError('--repeat must be at least 1');
  const tests = await resolveTests(engineDir, request.paths, request.exclude);
  const dispatches = planDispatches(tests, request.dispatch ?? 'shards');
  if (request.shuffle !== undefined && !dispatches.some((entry) => entry.suite === 'mochitest')) {
    throw usageError('--shuffle permutes mochitest files; the request selects none');
  }
  if (request.coverageDir !== undefined && dispatches.some((entry) => entry.suite === 'generic')) {
    throw usageError(
      '--coverage needs mochitest or xpcshell tests; reftest manifests have no coverage'
    );
  }
  return { ...request, tests, dispatches, repeat, headed: request.headed === true };
}
