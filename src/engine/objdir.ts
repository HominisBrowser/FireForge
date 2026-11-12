// SPDX-License-Identifier: EUPL-1.2
/**
 * What an object directory holds: the launchable browser, and where it was
 * configured.
 *
 * An object directory belongs to the absolute path it was configured at and
 * is never moved to another. `mach configure` regenerates only its own
 * output (`config.status`, the make backend, the install manifests). What the
 * build generated keeps naming the old source, and the build system has no
 * reason to regenerate any of it:
 *
 *  - `.cargo/config.toml` names the vendored crates of the old source, and
 *    build-script output names the old object directory as a link search
 *    path, so cargo reads and links from the other workspace;
 *  - cargo's dependency records are binary and length-prefixed, and some hold
 *    absolute source paths;
 *  - generated sources embed the paths, some in an escaped spelling a search
 *    for the path does not find (`build/rust/mozbuild/buildconfig.rs` writes
 *    `.` as `\u{2e}`);
 *  - make's dependency files and the install tracking files list old
 *    absolute paths, so staleness is judged by the other workspace's files
 *    for as long as it exists.
 *
 * Rewriting what can be found leaves a build that silently depends on
 * another workspace for the rest, so an object directory found at another
 * path is discarded ({@link discardMovedObjdir}) and the build starts from
 * nothing.
 */
import { join, resolve } from 'node:path';

import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { exists, listDir, readTextIfExists, remove } from '../kernel/fs.js';
import { isRecord, parseJson } from '../kernel/json.js';
import type { Workspace } from './workspace.js';

/**
 * The launchable browser binary of an object directory: on macOS inside
 * whichever `dist/*.app` holds it (the bundle's display name need not match
 * the binary's), elsewhere `dist/bin/<binaryName>`.
 *
 * @param objDir - The object directory
 * @param binaryName - The executable name from the project's configuration
 * @returns Its absolute path, or undefined when the build has not produced it
 */
export async function findBrowserBinary(
  objDir: string,
  binaryName: string
): Promise<string | undefined> {
  const dist = join(objDir, 'dist');
  const candidates =
    process.platform === 'darwin'
      ? (await listDir(dist))
          .filter((entry) => entry.kind === 'directory' && entry.name.endsWith('.app'))
          .map((entry) => join(dist, entry.name, 'Contents', 'MacOS', binaryName))
      : [join(dist, 'bin', process.platform === 'win32' ? `${binaryName}.exe` : binaryName)];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The launchable browser of a workspace's development build.
 *
 * @param workspace - The workspace
 * @returns The binary's absolute path
 * @throws `build-missing` (exit code 5) when the workspace has no completed build
 */
export async function requireBuilt(
  workspace: Pick<Workspace, 'objDir' | 'project'>
): Promise<string> {
  const binary = await findBrowserBinary(workspace.objDir, workspace.project.config.binaryName);
  if (binary !== undefined) return binary;
  const partial = await exists(workspace.objDir);
  throw new FireForgeError(
    'build-missing',
    partial
      ? `The build in ${workspace.objDir} has no launchable browser: it did not finish`
      : `Nothing is built yet: ${workspace.objDir} does not exist`,
    { exitCode: ExitCode.BUILD_ERROR, hint: 'Run "fireforge build".' }
  );
}

/** The absolute paths an object directory was configured with. */
export interface ObjdirOrigin {
  /** The source directory, `topsrcdir` in `mozinfo.json`. */
  topsrcdir: string;
  /** The object directory itself as configure saw it, `topobjdir`. */
  topobjdir: string;
  /** The mozconfig it was configured from, when recorded. */
  mozconfig?: string;
}

/**
 * Where an object directory was configured, from its `mozinfo.json`.
 *
 * @param objDir - The object directory
 * @returns Undefined when it was never configured, or records no paths
 */
async function readObjdirOrigin(objDir: string): Promise<ObjdirOrigin | undefined> {
  const text = await readTextIfExists(join(objDir, 'mozinfo.json'));
  if (text === undefined) return undefined;
  let mozinfo: unknown;
  try {
    mozinfo = parseJson(text);
  } catch {
    return undefined;
  }
  if (!isRecord(mozinfo)) return undefined;
  const { topsrcdir, topobjdir, mozconfig } = mozinfo;
  if (typeof topsrcdir !== 'string' || typeof topobjdir !== 'string') return undefined;
  return { topsrcdir, topobjdir, ...(typeof mozconfig === 'string' ? { mozconfig } : {}) };
}

/**
 * The origin of a workspace's object directory when it was configured for
 * another location: the workspace was cloned or moved since.
 *
 * @param workspace - The workspace
 * @returns Undefined when the object directory is absent or belongs here
 */
export async function movedFrom(
  workspace: Pick<Workspace, 'engineDir' | 'objDir'>
): Promise<ObjdirOrigin | undefined> {
  const origin = await readObjdirOrigin(workspace.objDir);
  if (origin === undefined) return undefined;
  const here =
    resolve(origin.topsrcdir) === resolve(workspace.engineDir) &&
    resolve(origin.topobjdir) === resolve(workspace.objDir);
  return here ? undefined : origin;
}

/**
 * Removes a workspace's object directory when it was configured for another
 * location, so the next build configures and builds from nothing.
 *
 * @param workspace - The workspace
 * @returns The source directory it was configured for, or undefined when the
 *   object directory is absent or belongs here
 */
export async function discardMovedObjdir(
  workspace: Pick<Workspace, 'engineDir' | 'objDir'>
): Promise<string | undefined> {
  const origin = await movedFrom(workspace);
  if (origin === undefined) return undefined;
  await remove(workspace.objDir);
  return resolve(origin.topsrcdir);
}
