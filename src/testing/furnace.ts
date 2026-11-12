// SPDX-License-Identifier: EUPL-1.2
/**
 * A project with Furnace components beside a synthetic engine: the project
 * directory, the engine (a git repository whose `HEAD` is the synthetic
 * Firefox tree), the workspace Furnace deploys into, and a tracked-file
 * writer that stores tracked engine files in the engine, as patch mode does.
 */
import { join } from 'node:path';

import { configSchema } from '../config/index.js';
import type { FurnaceProject, FurnaceWorkspace } from '../furnace/index.js';
import { exists, readTextIfExists } from '../kernel/fs.js';
import { projectPaths, type TrackedFiles } from '../project/index.js';
import { writeSyntheticFirefox } from './firefox.js';
import { initRepo } from './git.js';
import { type FileTree, writeTree } from './temp.js';

/** The `fireforge.json` of a Furnace fixture project. */
const FURNACE_PROJECT_CONFIG = {
  name: 'Acme',
  vendor: 'Example',
  appId: 'org.example.acme',
  binaryName: 'acme',
  firefox: { version: '153.7.0esr', product: 'firefox-esr' },
} as const;

/** A Furnace fixture. */
export interface FurnaceFixture {
  root: string;
  engineDir: string;
  project: FurnaceProject;
  workspace: FurnaceWorkspace;
  tracked: TrackedFiles;
}

/** What a fixture holds besides the synthetic engine. */
export interface FurnaceFixtureOptions {
  /** The `furnace.json` document; omitted, the project has none. */
  furnace?: object;
  /** Project files, such as `components/custom/<name>/<name>.mjs`. */
  files?: FileTree;
  /** Engine files added before the engine's commit. */
  engine?: FileTree;
}

/**
 * Creates a fixture under a directory: the project at its root, the engine
 * in `engine/`.
 *
 * @param root - An empty directory
 * @param options - See {@link FurnaceFixtureOptions}
 */
export async function makeFurnaceFixture(
  root: string,
  options: FurnaceFixtureOptions = {}
): Promise<FurnaceFixture> {
  const engineDir = join(root, 'engine');
  await writeSyntheticFirefox(engineDir, options.engine);
  await initRepo(engineDir);
  await writeTree(root, {
    'fireforge.json': JSON.stringify(FURNACE_PROJECT_CONFIG, null, 2),
    ...(options.furnace === undefined
      ? {}
      : { 'furnace.json': `${JSON.stringify(options.furnace, null, 2)}\n` }),
    ...options.files,
  });
  const paths = projectPaths(root);
  return {
    root,
    engineDir,
    project: { paths, config: configSchema.parse(FURNACE_PROJECT_CONFIG) },
    workspace: { engineDir, stateDir: paths.stateDir },
    tracked: {
      read: (path) => readTextIfExists(join(engineDir, path)),
      exists: (path) => exists(join(engineDir, path)),
      write: (tx, path, content) => tx.write(join(engineDir, path), content),
      remove: (tx, path) => tx.remove(join(engineDir, path)),
      locate: (path) => join(engineDir, path),
    },
  };
}
