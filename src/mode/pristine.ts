// SPDX-License-Identifier: EUPL-1.2
import {
  type EngineInstall,
  ensurePristine,
  findPristine,
  installProjectEngine,
  pinKey,
  type Pristine,
} from '../engine/index.js';
import { isRepository } from '../git/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import type { PatchProject, Project } from '../project/index.js';

/**
 * The pristine repository of the project's pin, from the host store. A
 * source-mode project also pins the commit, and a store that imported the
 * archive as another commit is refused.
 *
 * @param project - The project
 * @throws `pristine-missing` (exit code 3) when the host never downloaded the pin,
 *   `pristine-commit-mismatch` (exit code 2)
 */
export async function pinnedPristine(project: Project): Promise<Pristine> {
  const pristine = await findPristine(project.host, project.config.firefox);
  if (pristine === undefined) {
    throw new FireForgeError(
      'pristine-missing',
      `This host has no pristine source for ${pinKey(project.config.firefox)}.`,
      { exitCode: ExitCode.DOWNLOAD_ERROR, hint: 'Run "fireforge download".' }
    );
  }
  const pinned = project.config.source?.pristineCommit;
  if (pinned !== undefined && pinned !== pristine.commit) {
    throw new FireForgeError(
      'pristine-commit-mismatch',
      `The pristine source of ${pinKey(project.config.firefox)} is commit ${pristine.commit}, not the pinned ${pinned}.`,
      {
        exitCode: ExitCode.CONFIG_ERROR,
        hint: 'The pin and the archive disagree: check firefox.version and source.pristineCommit.',
      }
    );
  }
  return pristine;
}

/**
 * Refuses a patch-mode project whose `engine/` has not been downloaded yet.
 *
 * @param project - A patch-mode project
 * @throws `engine-missing` (exit code 1)
 */
export async function requireEngine(project: PatchProject): Promise<void> {
  if (await isRepository(project.paths.engine)) return;
  throw new FireForgeError(
    'engine-missing',
    `There is no Firefox source at ${project.paths.engine}`,
    { exitCode: ExitCode.GENERAL_ERROR, hint: 'Run "fireforge download" first.' }
  );
}

/**
 * Fetches the pinned Firefox: imports it into the host pristine store when
 * the host lacks it and, in patch mode, makes `engine/` a checkout of it.
 * A source-mode project needs no engine of its own; its workspaces are
 * checked out of the store when leased.
 *
 * @param project - The project
 * @param options - `force` replaces an existing `engine/`; `waitMs` is for the engine lock
 * @returns The pristine repository, and the engine install in patch mode
 */
export async function download(
  project: Project,
  options: {
    force?: boolean | undefined;
    waitMs?: number | undefined;
    onProgress?: (message: string) => void;
  } = {}
): Promise<{ pristine: Pristine; engine?: EngineInstall }> {
  const pristine = await ensurePristine(project.host, project.config.firefox, {
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    expectCommit: project.config.source?.pristineCommit,
  });
  if (project.mode === 'source') return { pristine };
  const engine = await installProjectEngine(project, pristine, {
    force: options.force === true,
    waitMs: options.waitMs,
  });
  return { pristine, engine };
}
