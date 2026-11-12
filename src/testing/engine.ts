// SPDX-License-Identifier: EUPL-1.2
/**
 * Projects, pristine repositories and workspaces over the synthetic Firefox
 * tree, for tests that build, run or lease an engine with the stand-in `mach`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, vi } from 'vitest';

import { type Workspace, workspaceAt } from '../engine/workspace.js';
import { exists } from '../kernel/fs.js';
import { configureLog, type LogConfig } from '../kernel/log.js';
import {
  type HostPaths,
  hostPaths,
  loadProject,
  type Project,
  type SourceProject,
} from '../project/index.js';
import { MINIMAL_CONFIG, TEST_PIN, TEST_PIN_KEY } from './config.js';
import { writeSyntheticFirefox } from './firefox.js';
import { git, initRepo } from './git.js';
import { type FileTree, makeTempDir, removeTempDir, writeTree } from './temp.js';

/**
 * Keeps the stand-in `mach` of the enclosing tests away from the host: its
 * state directory is a temporary one instead of `~/.mozbuild`, and what it
 * prints is collected instead of written to the test run's stderr.
 *
 * @returns A getter for the diagnostics logged during the current test
 */
export function useMachSandbox(): () => string {
  let state = '';
  let logged = '';
  let previous: LogConfig = {};
  beforeEach(async () => {
    state = await makeTempDir('fireforge-mozbuild-');
    vi.stubEnv('MOZBUILD_STATE_PATH', state);
    logged = '';
    previous = configureLog({ write: (text) => (logged += text) });
  });
  afterEach(async () => {
    configureLog(previous);
    vi.unstubAllEnvs();
    await removeTempDir(state);
  });
  return () => logged;
}

/** What {@link makeEngineProject} writes besides the defaults. */
export interface EngineProjectOptions {
  /** Source mode instead of patch mode. */
  source?: boolean;
  /** Keys merged into `fireforge.json`. */
  config?: Readonly<Record<string, unknown>>;
  /** Project files to add or replace. */
  files?: FileTree;
}

/**
 * Writes a project with `configs/` templates for this platform and loads it.
 * Host state goes under `<directory>/home`.
 *
 * @param directory - The test's temporary directory
 * @param options - See {@link EngineProjectOptions}
 * @param name - The project's directory name, for a test with several checkouts
 */
export async function makeEngineProject(
  directory: string,
  options: EngineProjectOptions = {},
  name = 'project'
): Promise<Project> {
  const root = join(directory, name);
  await writeTree(root, {
    'fireforge.json': JSON.stringify({
      ...MINIMAL_CONFIG,
      name: 'Test Browser',
      binaryName: 'testbrowser',
      ...(options.source === true
        ? {
            mode: 'source',
            source: { root: 'src', metadataRoot: 'upstream', pristineCommit: '0'.repeat(40) },
          }
        : {}),
      ...options.config,
    }),
    'configs/common.mozconfig': 'ac_add_options --enable-application=browser\n',
    [`configs/${process.platform}.mozconfig`]: '# platform options\n',
    ...options.files,
  });
  return loadProject(root, { FIREFORGE_HOME: join(directory, 'home') });
}

/**
 * Creates the pristine repository of {@link TEST_PIN} on a host, the way an
 * import leaves it: a bare repository with the synthetic tree as one commit
 * on `main`, and the pin record.
 *
 * @param host - The host locations
 * @param extra - Files to add to the synthetic tree
 * @param pin - The pin to seed, for a test that moves a project to another one
 * @returns The commit
 */
export async function seedPristine(
  host: HostPaths,
  extra: FileTree = {},
  pin: { version: string; product: string } = TEST_PIN
): Promise<string> {
  const repo = join(host.pristine, `${pin.product}-${pin.version}`);
  const tree = `${repo}.tree`;
  await writeSyntheticFirefox(tree, { '.mach-state/binary-name': 'testbrowser', ...extra });
  // The stand-in's state is part of the checkout here, so every workspace's mach has its binary name.
  await writeFile(join(tree, '.gitignore'), 'obj-*/\nmozconfig\n.mach-state/commands.jsonl\n');
  const commit = await initRepo(tree);
  await storePristine(host, pin, tree, commit);
  await removeTempDir(tree);
  return commit;
}

/**
 * Puts a repository into a host's pristine store the way an import leaves a
 * downloaded pin: a bare repository under the pin's key, and the pin record.
 *
 * @param host - The host locations
 * @param pin - The pin the repository is the source of
 * @param source - A repository holding the commit
 * @param commit - The pristine commit
 */
export async function storePristine(
  host: HostPaths,
  pin: { version: string; product: string },
  source: string,
  commit: string
): Promise<void> {
  const repo = join(host.pristine, `${pin.product}-${pin.version}`);
  if (await exists(repo)) return;
  await mkdir(dirname(repo), { recursive: true });
  await git(dirname(repo), ['clone', '--quiet', '--bare', source, repo]);
  await writeFile(join(repo, 'fireforge-pin.json'), JSON.stringify({ firefox: pin, commit }));
}

/**
 * A source-mode project committed in its own git repository and pinned to
 * the seeded pristine repository of {@link TEST_PIN}, which is created on
 * the host first when it is not there. Its source root is `src/`.
 *
 * @param directory - The test's temporary directory
 * @param options - See {@link EngineProjectOptions}; `source` is implied
 * @param name - The project's directory name, for a test with several checkouts
 */
export async function makeSourceProject(
  directory: string,
  options: Omit<EngineProjectOptions, 'source'> = {},
  name = 'project'
): Promise<SourceProject> {
  const host = hostPaths({ FIREFORGE_HOME: join(directory, 'home') });
  const pinFile = join(host.pristine, TEST_PIN_KEY, 'fireforge-pin.json');
  const commit = (await exists(pinFile))
    ? (JSON.parse(await readFile(pinFile, 'utf8')) as { commit: string }).commit
    : await seedPristine(host);
  const created = await makeEngineProject(
    directory,
    {
      source: true,
      config: {
        source: { root: 'src', metadataRoot: 'upstream', pristineCommit: commit },
        ...options.config,
      },
      files: {
        '.gitignore': '.fireforge/\n',
        'src/.gitattributes': '* -text\n* merge=fireforge\n',
        ...options.files,
      },
    },
    name
  );
  await initRepo(created.root);
  const project = await loadProject(created.root, { FIREFORGE_HOME: host.root });
  if (project.mode !== 'source') throw new Error('the fixture is a source-mode project');
  return project;
}

/**
 * Gives a patch-mode project its `engine/`: the synthetic tree as a git
 * repository with one commit, and the workspace value for it.
 *
 * @param project - A project from {@link makeEngineProject}
 * @param extra - Files to add to the synthetic tree
 */
export async function makeProjectEngine(
  project: Project,
  extra: FileTree = {}
): Promise<Workspace> {
  const engineDir = join(project.root, 'engine');
  await writeSyntheticFirefox(engineDir, { '.mach-state/binary-name': 'testbrowser', ...extra });
  await initRepo(engineDir);
  return workspaceAt(project, {
    name: 'engine',
    kind: 'project',
    engineDir,
    stateDir: project.paths.stateDir,
    stateFile: project.paths.state,
  });
}
