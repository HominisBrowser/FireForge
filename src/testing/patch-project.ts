// SPDX-License-Identifier: EUPL-1.2
/**
 * A patch-mode project in a temporary directory: `fireforge.json`, an
 * `engine/` git checkout of the synthetic Firefox tree at a baseline commit,
 * and helpers that record patches into `patches/` the way `export` would.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { captureWorktree } from '../git/index.js';
import { readTextIfExists } from '../kernel/fs.js';
import { loadProject, type PatchProject } from '../project/index.js';
import {
  mutateQueue,
  type PatchEntry,
  type QueuePatch,
  readQueue,
  regeneratePatchBody,
  requirePatchMode,
} from '../queue/index.js';
import { MINIMAL_CONFIG } from './config.js';
import { writeSyntheticFirefox } from './firefox.js';
import { commitAll, git, initRepo } from './git.js';
import { type FileTree, writeTree } from './temp.js';

/** File edits by engine path: new content, or null to delete. */
export type FileChanges = Readonly<Record<string, string | Uint8Array | null>>;

/** A temporary patch-mode project. */
export interface PatchFixture {
  readonly root: string;
  readonly engine: string;
  readonly patches: string;
  /** The engine's baseline commit. */
  readonly base: string;
  /** Loads the project as commands do. */
  project(): Promise<PatchProject>;
  /** Writes (or, for null, deletes) engine files. */
  edit(changes: FileChanges): Promise<void>;
  /** An engine file's content, or undefined when it is absent. */
  read(path: string): Promise<string | undefined>;
  /**
   * Records a patch as `export` would: applies `changes` on top of what the
   * engine holds, and stores their diff as a new patch at the end of the
   * queue (or at `order`). The change stays in the engine.
   */
  addPatch(
    name: string,
    changes: FileChanges,
    options?: Partial<Omit<PatchEntry, 'name'>>
  ): Promise<QueuePatch>;
  /** Puts the engine back to its HEAD: tracked files restored, untracked removed. */
  resetEngine(): Promise<void>;
  /** Commits changes on top of the engine's HEAD, as an upstream release would, and returns the commit. */
  upstream(changes: FileChanges): Promise<string>;
  /** Rewrites `firefox.version` in `fireforge.json`. */
  pin(version: string): Promise<void>;
}

async function applyChanges(engine: string, changes: FileChanges): Promise<void> {
  const writes: Record<string, string | Uint8Array> = {};
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) await rm(join(engine, path), { force: true });
    else writes[path] = content;
  }
  await writeTree(engine, writes);
}

/**
 * Creates a patch-mode project in `root`.
 *
 * @param root - An empty directory
 * @param options - `files` adds to (or replaces in) the synthetic Firefox tree
 */
export async function createPatchProject(
  root: string,
  options: { files?: FileTree } = {}
): Promise<PatchFixture> {
  const engine = join(root, 'engine');
  let config: Record<string, unknown> = { ...MINIMAL_CONFIG };
  const writeConfig = (): Promise<void> =>
    writeTree(root, { 'fireforge.json': `${JSON.stringify(config, null, 2)}\n` });
  await writeConfig();
  await writeSyntheticFirefox(engine, options.files ?? {});
  const base = await initRepo(engine);
  const project = async (): Promise<PatchProject> => requirePatchMode(await loadProject(root, {}));
  const fixture: PatchFixture = {
    root,
    engine,
    patches: join(root, 'patches'),
    base,
    project,
    edit: (changes) => applyChanges(engine, changes),
    read: (path) => readTextIfExists(join(engine, path)),
    async addPatch(name, changes, entry = {}) {
      const paths = Object.keys(changes);
      const before = await captureWorktree(engine, { paths });
      await applyChanges(engine, changes);
      const { body } = await regeneratePatchBody(engine, { before, paths });
      const loaded = await project();
      const { product, version } = loaded.config.firefox;
      await mutateQueue(loaded, `the export of ${name}`, (draft) => {
        const order = entry.order ?? Math.max(0, ...draft.patches.map((patch) => patch.order)) + 1;
        draft.patches.push({
          description: '',
          firefox: { product, version },
          ...entry,
          order,
          name,
          body,
        });
      });
      const queue = await readQueue(loaded.paths.patches);
      const patch = queue.patches.find((candidate) => candidate.name === name);
      if (patch === undefined) throw new Error(`patch ${name} was not recorded`);
      return patch;
    },
    async resetEngine() {
      await git(engine, ['reset', '--quiet', '--hard', 'HEAD']);
      await git(engine, ['clean', '-f', '-d', '-q']);
    },
    async upstream(changes) {
      await fixture.resetEngine();
      await applyChanges(engine, changes);
      return commitAll(engine, 'upstream release');
    },
    async pin(version) {
      config = { ...config, firefox: { ...MINIMAL_CONFIG.firefox, version } };
      await writeConfig();
    },
  };
  return fixture;
}
