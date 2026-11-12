// SPDX-License-Identifier: EUPL-1.2
/**
 * `watch` for either mode. `mach watch` rebuilds front-end files as the
 * engine changes; what the engine is built from outside itself (a
 * source-mode project's owned files and override records, and the
 * components of either mode) is followed here and brought into the engine
 * when it changes, which `mach watch` then picks up.
 */
import { join } from 'node:path';

import { watch as watchEngine, type Workspace } from '../engine/index.js';
import { toError } from '../kernel/errors.js';
import { pathInfo, walkFiles } from '../kernel/fs.js';
import { hash } from '../kernel/hash.js';
import { info, warn } from '../kernel/log.js';
import { sleep } from '../kernel/time.js';
import type { Project } from '../project/index.js';
import { deployComponents, materializeIn } from './workspace.js';

/** How a watch runs. */
export interface WatchOptions {
  /** The environment watchman is looked up in. Default: this process's. */
  env?: Readonly<Record<string, string | undefined>>;
  /** How often the project's inputs are compared, in milliseconds (default 1 000). */
  pollMs?: number;
}

/** The directories and files outside the engine that the workspace's engine is made from. */
function inputs(project: Project): string[] {
  return [
    ...(project.mode === 'source' ? [project.paths.source, project.paths.sourceMetadata] : []),
    project.paths.components,
    project.paths.furnace,
  ];
}

/** A digest of every input file's path, size and modification time. */
async function signature(project: Project): Promise<string> {
  const rows: string[] = [];
  for (const input of inputs(project)) {
    const files =
      (await pathInfo(input))?.kind === 'directory'
        ? (await walkFiles(input)).map((file) => join(input, file))
        : [input];
    for (const file of files) {
      const stat = await pathInfo(file);
      if (stat !== undefined) rows.push(`${file}\0${stat.size}\0${stat.mtimeMs}`);
    }
  }
  return hash(rows.join('\n'));
}

/** Brings the workspace's engine to the project's inputs as they are now. */
async function refresh(workspace: Workspace): Promise<void> {
  const changed = await materializeIn(workspace);
  if (changed > 0) info(`Brought ${changed} changed file(s) into workspace "${workspace.name}".`);
  await deployComponents(workspace);
}

/**
 * Watches the workspace and rebuilds front-end files as the project changes,
 * until interrupted. A change that cannot be brought into the engine is
 * reported and tried again at the next change; the watch goes on.
 *
 * @param workspace - A workspace holding a completed build, held by the caller
 * @param options - See {@link WatchOptions}
 * @throws What the engine module's `watch` throws
 */
export async function watch(workspace: Workspace, options: WatchOptions = {}): Promise<void> {
  const { project } = workspace;
  const state = { stopped: false };
  const stopped = (): boolean => state.stopped;
  const follow = async (): Promise<void> => {
    let seen = await signature(project);
    for (;;) {
      await sleep(options.pollMs ?? 1_000, { unref: true });
      if (stopped()) return;
      const now = await signature(project);
      if (now === seen) continue;
      seen = now;
      await refresh(workspace).catch((error: unknown) => {
        warn(`The workspace was not updated: ${toError(error).message}`);
      });
    }
  };
  const following = follow();
  try {
    await watchEngine(workspace, options.env === undefined ? {} : { env: options.env });
  } finally {
    state.stopped = true;
    await following.catch(() => undefined);
  }
}
