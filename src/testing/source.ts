// SPDX-License-Identifier: EUPL-1.2
/**
 * A source-mode project in a real git repository beside a real pristine
 * repository: what source-mode tests start from. The pristine repository
 * holds a few upstream files (text, executable, binary); the project's
 * `fireforge.json` pins its commit.
 */
import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { hostPaths, loadProject, type SourceProject } from '../project/index.js';
import { MINIMAL_CONFIG } from './config.js';
import { storePristine } from './engine.js';
import { commitAll, git, initRepo } from './git.js';
import { type FileTree, writeTree } from './temp.js';

/** The upstream files of the pristine repository. */
const PRISTINE_FILES: FileTree = {
  'browser/manifest.txt': 'first\nsecond\nthird\nfourth\nfifth\n',
  'browser/run.sh': '#!/bin/sh\nexit 0\n',
  'browser/blob.dat': Buffer.from([0, 1, 2, 3]),
  'browser/base/jar.mn': 'browser.jar:\n  content/browser/browser.js (content/browser.js)\n',
  'toolkit/modules/Service.sys.mjs': 'export const version = 1;\n',
};

/** Upstream files that are executable. */
const EXECUTABLE = ['browser/run.sh'];

/** The pristine repository and pinned commit, as source-mode functions take them. */
export interface FixturePristine {
  readonly repo: string;
  readonly commit: string;
}

/** A source-mode project and its pristine repository. */
export interface SourceFixture {
  /** The project directory, a git repository's top level. */
  readonly root: string;
  /** The pristine repository at the pinned commit. */
  readonly pristine: FixturePristine;
  /** Loads the project as commands do. */
  load(): Promise<SourceProject>;
  /** Writes project files (relative to the project root); `executable` sets the x bits. */
  write(files: FileTree, options?: { executable?: readonly string[] }): Promise<void>;
  /** Removes project files or directories. */
  remove(...paths: string[]): Promise<void>;
  /** Commits everything in the project and returns the commit. */
  commit(message?: string): Promise<string>;
  /**
   * Commits a new upstream version in the pristine repository: `files`
   * written over the current ones, `removed` deleted. The pin is unchanged.
   */
  advance(files: FileTree, removed?: readonly string[]): Promise<FixturePristine>;
  /** A git checkout of a pristine commit (default: the pinned one), as an engine to materialize. */
  engine(directory: string, commit?: string): Promise<string>;
  /**
   * An environment whose `FIREFORGE_HOME` holds the pristine repository as
   * the host pristine store keeps a downloaded pin.
   */
  hostEnv(): Promise<Record<string, string>>;
}

async function chmodAll(root: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) await chmod(join(root, path), 0o755);
}

/**
 * Creates a source-mode project and its pristine repository under `directory`.
 *
 * @param directory - An empty temporary directory
 * @param options - `config` merges into `fireforge.json`; `pristine` replaces the upstream files
 */
export async function createSourceFixture(
  directory: string,
  options: { config?: Record<string, unknown>; pristine?: FileTree } = {}
): Promise<SourceFixture> {
  const repo = join(directory, 'pristine');
  await writeTree(repo, options.pristine ?? PRISTINE_FILES);
  await chmodAll(
    repo,
    EXECUTABLE.filter((path) => (options.pristine ?? PRISTINE_FILES)[path] !== undefined)
  );
  const commit = await initRepo(repo);
  const pristine = { repo, commit };
  const root = join(directory, 'project');
  const config = {
    ...MINIMAL_CONFIG,
    mode: 'source',
    source: { root: 'src', metadataRoot: '.fireforge-sources', pristineCommit: commit },
    ...options.config,
  };
  await initRepo(root, {
    'fireforge.json': `${JSON.stringify(config, null, 2)}\n`,
    '.gitignore': '.fireforge/\nengine/\n',
    'src/.gitattributes': '* -text\n* merge=fireforge\n',
  });
  return {
    root,
    pristine,
    load: async () => {
      const project = await loadProject(root, { FIREFORGE_HOME: join(directory, 'home') });
      if (project.mode !== 'source') throw new Error('the fixture is a source-mode project');
      return project;
    },
    write: async (files, writeOptions = {}) => {
      await writeTree(root, files);
      await chmodAll(root, writeOptions.executable ?? []);
    },
    remove: async (...paths) => {
      for (const path of paths) await rm(join(root, path), { recursive: true, force: true });
    },
    commit: (message = 'change') => commitAll(root, message),
    advance: async (files, removed = []) => {
      await writeTree(repo, files);
      for (const path of removed) await rm(join(repo, path), { recursive: true, force: true });
      return { repo, commit: await commitAll(repo, 'upstream') };
    },
    engine: async (target, at = commit) => {
      await mkdir(dirname(target), { recursive: true });
      await git(dirname(target), ['clone', '--quiet', '--no-checkout', repo, target]);
      await git(target, ['checkout', '--quiet', '--detach', at]);
      return target;
    },
    hostEnv: async () => {
      const home = join(directory, 'home');
      await storePristine(hostPaths({ FIREFORGE_HOME: home }), config.firefox, repo, commit);
      return { FIREFORGE_HOME: home };
    },
  };
}
