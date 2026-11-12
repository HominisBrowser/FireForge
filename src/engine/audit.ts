// SPDX-License-Identifier: EUPL-1.2
/**
 * The post-build packaging audit: front-end files that changed since the
 * previous build and that nothing packages. Such a file builds without
 * complaint and is simply absent from the browser. Warn-only: the audit can
 * be wrong about a file reached some other way, which is what
 * `buildAudit.unpackaged` declares.
 */
import { join, posix } from 'node:path';

import { captureWorktree, changedPaths, resolveRevision } from '../git/index.js';
import { exists, readTextIfExists } from '../kernel/fs.js';
import { matchesGlob } from '../kernel/glob.js';
import { manifestReferencesFile } from '../mozbuild/index.js';
import { deliveryOf, readInstallIndex } from './installManifests.js';
import { buildInputClass, isTestPath } from './staleness.js';
import type { Workspace } from './workspace.js';

/** Files a registered document pulls in itself, and files only a development tool reads. */
const NEVER_PACKAGED = /\.inc\.xhtml$|\.stories\.mjs$/;

/**
 * The changed front-end files that no install manifest of the finished build
 * installs and no `jar.mn` or `moz.build` in their directory or above it
 * names, leaving out those the project declares in `buildAudit.unpackaged`.
 *
 * @param workspace - The workspace, after a successful build
 * @param since - Tree-ish of the previous build's snapshot; default the engine's HEAD
 * @returns Engine-relative paths, sorted
 */
export async function unpackagedChanges(workspace: Workspace, since?: string): Promise<string[]> {
  const { engineDir, objDir, project } = workspace;
  const base =
    since !== undefined && (await resolveRevision(engineDir, since, 'commit')) !== undefined
      ? since
      : 'HEAD';
  const declared = (project.config.buildAudit?.unpackaged ?? []).map((entry) => entry.path);
  const index = await readInstallIndex(engineDir, objDir);
  const manifests = new Map<string, string | undefined>();
  const manifest = async (path: string): Promise<string | undefined> => {
    if (!manifests.has(path)) manifests.set(path, await readTextIfExists(join(engineDir, path)));
    return manifests.get(path);
  };
  const named = async (file: string): Promise<boolean> => {
    for (let directory = posix.dirname(file); ; directory = posix.dirname(directory)) {
      for (const name of ['jar.mn', 'moz.build']) {
        const path = directory === '.' ? name : `${directory}/${name}`;
        const text = await manifest(path);
        if (text !== undefined && manifestReferencesFile(path, text, file)) return true;
      }
      if (directory === '.') return false;
    }
  };
  const unpackaged: string[] = [];
  for (const path of await changedPaths(engineDir, base, await captureWorktree(engineDir))) {
    if (buildInputClass(path) !== 'ui' || isTestPath(path) || NEVER_PACKAGED.test(path)) continue;
    if (declared.some((glob) => matchesGlob(path, glob))) continue;
    if (!(await exists(join(engineDir, path)))) continue;
    if (index !== undefined && (await deliveryOf(index, engineDir, path)) !== 'unlisted') continue;
    if (!(await named(path))) unpackaged.push(path);
  }
  return unpackaged;
}
