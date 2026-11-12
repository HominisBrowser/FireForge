// SPDX-License-Identifier: EUPL-1.2
/**
 * `furnace diff`: how the project's components differ from what they are
 * compared with. A custom component is compared with its deployed copy in
 * the engine, an override with the stock files at the engine's `HEAD`.
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
import { deployedContent, type FurnaceWorkspace, upstreamFiles } from './deploy.js';

/**
 * A unified diff of one component, or of every component: `engine/<path>`
 * (custom) or `upstream/<path>` (override) against `project/<path>`, by
 * engine path.
 *
 * @param project - The project
 * @param workspace - The engine
 * @param name - One component; all when omitted
 * @returns The diff text; empty when nothing differs
 */
export async function componentDiff(
  project: FurnaceProject,
  workspace: FurnaceWorkspace,
  name?: string
): Promise<string> {
  const config = await loadFurnaceConfig(project);
  const selected = name === undefined ? components(config) : [findComponent(config, name)];
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
    return text;
  } finally {
    await remove(scratch);
  }
}
