// SPDX-License-Identifier: EUPL-1.2
/**
 * `furnace diff`: how the project's components differ from what they are
 * compared with. A custom component is compared with its deployed copy in
 * the engine, an override with the stock files at the engine's `HEAD`.
 * What a deployment would take away (a file a component dropped, a whole
 * component no longer configured, an override file going back to upstream)
 * is shown as the engine's copy against what the engine will hold.
 */
import { join } from 'node:path';

import { gitResult } from '../git/index.js';
import { ensureDir, makeTempDir, readBytesIfExists, remove, writeFile } from '../kernel/fs.js';
import {
  components,
  findComponent,
  furnaceError,
  type FurnaceProject,
  loadFurnaceConfig,
} from './config.js';
import {
  deployedContent,
  type FurnaceWorkspace,
  pendingRemovals,
  upstreamFiles,
} from './deploy.js';

/**
 * A unified diff of one component, or of every component: `engine/<path>`
 * (custom) or `upstream/<path>` (override) against `project/<path>`, by
 * engine path.
 *
 * @param project - The project
 * @param workspace - The engine
 * @param name - One component (including one removed from `furnace.json` whose deployed files are still pending removal); all when omitted
 * @returns The diff text; empty when nothing differs
 */
export async function componentDiff(
  project: FurnaceProject,
  workspace: FurnaceWorkspace,
  name?: string
): Promise<string> {
  const config = await loadFurnaceConfig(project);
  const removals = await pendingRemovals(project, workspace);
  const known = name !== undefined && removals.some((removal) => removal.component === name);
  const selected =
    name === undefined
      ? components(config)
      : known && !components(config).some((component) => component.name === name)
        ? []
        : [findComponent(config, name)];
  const scratch = await makeTempDir('fireforge-furnace-diff-');
  try {
    let text = '';
    for (const [kind, side] of [
      ['custom', 'engine'],
      ['override', 'upstream'],
    ] as const) {
      const dir = join(scratch, kind);
      await ensureDir(join(dir, side));
      await ensureDir(join(dir, 'project'));
      for (const component of selected.filter((candidate) => candidate.kind === kind)) {
        const wanted = await deployedContent(project, config, component.name);
        const before =
          kind === 'override' ? await upstreamFiles(workspace, [...wanted.keys()]) : undefined;
        for (const [path, content] of wanted) {
          await writeFile(join(dir, 'project', path), content, { durable: false });
          const old =
            before === undefined
              ? await readBytesIfExists(join(workspace.engineDir, path))
              : before.get(path);
          if (old !== undefined) await writeFile(join(dir, side, path), old, { durable: false });
        }
      }
      const args = ['diff', '--no-index', '--no-color', '--no-prefix', '--', side, 'project'];
      const result = await gitResult(args, { cwd: dir });
      if (result.exitCode > 1) {
        throw furnaceError('furnace-diff-failed', `git diff failed: ${result.stderr.trim()}`);
      }
      text += result.stdout.toString('utf8');
    }
    const dir = join(scratch, 'removal');
    await ensureDir(join(dir, 'engine'));
    await ensureDir(join(dir, 'project'));
    for (const removal of removals.filter(
      (candidate) => name === undefined || candidate.component === name
    )) {
      const held = await readBytesIfExists(join(workspace.engineDir, removal.path));
      // A file the engine lost that upstream has comes back: an addition.
      if (held === undefined ? removal.after === null : removal.after?.equals(held) === true) {
        continue;
      }
      if (held !== undefined) {
        await writeFile(join(dir, 'engine', removal.path), held, { durable: false });
      }
      if (removal.after !== null) {
        await writeFile(join(dir, 'project', removal.path), removal.after, { durable: false });
      }
    }
    const result = await gitResult(
      ['diff', '--no-index', '--no-color', '--no-prefix', '--', 'engine', 'project'],
      { cwd: dir }
    );
    if (result.exitCode > 1) {
      throw furnaceError('furnace-diff-failed', `git diff failed: ${result.stderr.trim()}`);
    }
    return text + result.stdout.toString('utf8');
  } finally {
    await remove(scratch);
  }
}
