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
import { info, verbose, warn } from '../kernel/log.js';
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

/** A digest of every input file's path, size, mode and modification and change times. */
async function signature(project: Project): Promise<string> {
  const rows: string[] = [];
  for (const input of inputs(project)) {
    const files =
      (await pathInfo(input))?.kind === 'directory'
        ? (await walkFiles(input)).map((file) => join(input, file))
        : [input];
    for (const file of files) {
      const stat = await pathInfo(file);
      if (stat !== undefined)
        rows.push(`${file}\0${stat.size}\0${stat.mode}\0${stat.mtimeMs}\0${stat.ctimeMs}`);
    }
  }
  return hash(rows.join('\n'));
}

/** The longest a failed refresh waits before it is tried again, in milliseconds. */
const MAX_RETRY_MS = 30_000;

/** How long to wait after the `failures`-th consecutive failure of one input state. */
function retryDelay(failures: number, pollMs: number): number {
  return Math.min(pollMs * 2 ** failures, Math.max(MAX_RETRY_MS, pollMs));
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
 * reported and tried again, with growing pauses, until it goes through or the
 * inputs change again; the watch goes on. Only the first failure of an input
 * state, and a failure with another message, is reported.
 *
 * @param workspace - A workspace holding a completed build, held by the caller
 * @param options - See {@link WatchOptions}
 * @throws What the engine module's `watch` throws
 */
export async function watch(workspace: Workspace, options: WatchOptions = {}): Promise<void> {
  const { project } = workspace;
  const pollMs = options.pollMs ?? 1_000;
  const state = { stopped: false };
  const stopped = (): boolean => state.stopped;
  const follow = async (): Promise<void> => {
    // `applied` is the input state the engine was last brought to; `failed`
    // the state a refresh last failed on, with when to try it again.
    let applied = await signature(project);
    let failed:
      { signature: string; failures: number; retryAt: number; message: string } | undefined;
    for (;;) {
      await sleep(pollMs, { unref: true });
      if (stopped()) return;
      const now = await signature(project);
      if (now === applied) {
        failed = undefined;
        continue;
      }
      if (failed?.signature === now && Date.now() < failed.retryAt) continue;
      try {
        await refresh(workspace);
        applied = now;
        failed = undefined;
      } catch (error: unknown) {
        const message = toError(error).message;
        const failures = failed?.signature === now ? failed.failures + 1 : 1;
        if (failed?.signature !== now || failed.message !== message) {
          warn(`The workspace was not updated: ${message}`);
        } else {
          verbose(`The workspace is still not updated: ${message}`);
        }
        failed = {
          signature: now,
          failures,
          retryAt: Date.now() + retryDelay(failures, pollMs),
          message,
        };
      }
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
