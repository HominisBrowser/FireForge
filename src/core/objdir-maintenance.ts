// SPDX-License-Identifier: EUPL-1.2
import {
  lstat,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { getNodeErrorCode } from '../utils/errors.js';
import { writeText } from '../utils/fs.js';

/** Visits objdir entries without following directory symlinks into another tree. */
async function walk(
  dir: string,
  visit: (path: string, link: boolean) => Promise<void>
): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, visit);
    else await visit(path, entry.isSymbolicLink());
  }
}

/** Refuses an objdir that writes through a directory alias into a different checkout. */
export async function assertLocalObjdir(engineDir: string, objDir: string): Promise<void> {
  if (!/^[^/\\:]+$/.test(objDir) || objDir === '.' || objDir === '..') {
    throw new GeneralError(`Objdir ${objDir} must be a local directory name.`);
  }
  const expected = resolve(engineDir, objDir);
  if (
    (await realpath(expected)) !== resolve(await realpath(engineDir), objDir) ||
    !(await lstat(expected)).isDirectory()
  ) {
    throw new GeneralError(
      `Objdir ${expected} resolves outside its local directory. Refusing to configure or rewrite it.`
    );
  }
}

function replacePrefix(value: string, oldRoot: string, newRoot: string): string {
  return value === oldRoot || value.startsWith(oldRoot + sep)
    ? newRoot + value.slice(oldRoot.length)
    : value;
}

/** Rewrites references under oldRoot, including the forward-slash spelling mozbuild writes on Windows. */
function rewriteRootReferences(content: string, oldRoot: string, newRoot: string): string {
  const rewritten = content.replaceAll(oldRoot + sep, newRoot + sep);
  if (sep !== '\\') return rewritten;
  return rewritten
    .replaceAll(oldRoot + '/', newRoot + '/')
    .replaceAll(oldRoot.replaceAll('\\', '/') + '/', newRoot.replaceAll('\\', '/') + '/');
}

function isDependencyMetadata(path: string): boolean {
  return (
    /\.(?:pp|d)$/.test(path) ||
    /[/\\]faster[/\\]/.test(path) ||
    /[/\\]config\.statusd[/\\].*[/\\]config\.track$/.test(path) ||
    /[/\\]\.fingerprint[/\\].*\.json$/.test(path)
  );
}

/** Repairs copied links and dependency metadata BEFORE configure can consume config.track. */
export async function relocateObjdirProducts(
  engineDir: string,
  objDir: string,
  oldRoot: string
): Promise<void> {
  await assertLocalObjdir(engineDir, objDir);
  const root = resolve(engineDir, objDir);
  const newRoot = resolve(engineDir);
  const canonicalRoot = await realpath(root);
  // Configure writes these groups. Even a local objdir can contain a copied
  // directory alias into a peer, so validate each parent before touching it.
  for (const directory of ['config.statusd', 'config.statusd/substs', 'config.statusd/defines']) {
    const path = join(root, directory);
    try {
      if (
        !(await lstat(path)).isDirectory() ||
        (await realpath(path)) !== join(canonicalRoot, directory)
      )
        throw new GeneralError(
          `Partial-config directory ${path} is aliased. Refusing relocation before configure.`
        );
    } catch (error: unknown) {
      if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    }
  }
  await walk(root, async (path, link) => {
    // Remove tracking symlinks too, without following their write targets.
    if (/[/\\]config\.statusd[/\\].*[/\\]config\.track$/.test(path)) {
      await rm(path);
      return;
    }
    if (link) {
      const target = await readlink(path);
      const absolute = resolve(dirname(path), target);
      const relocated = replacePrefix(absolute, oldRoot, newRoot);
      if (relocated !== absolute) {
        const temp = `${path}.relocate-${process.pid}`;
        await symlink(relocated, temp);
        try {
          await rename(temp, path);
        } catch (error: unknown) {
          // Windows refuses to rename over a directory link; replace it in two steps.
          if (process.platform !== 'win32' || getNodeErrorCode(error) !== 'EPERM') throw error;
          await rm(path);
          await rename(temp, path);
        } finally {
          await rm(temp, { force: true });
        }
      }
    } else if (isDependencyMetadata(path)) {
      const content = await readFile(path, 'utf8');
      const rewritten = rewriteRootReferences(content, oldRoot, newRoot);
      if (content !== rewritten) await writeText(path, rewritten);
    }
  });
}

/** Finds a link still consulting the previous source tree after relocation/configure. */
export async function findStaleObjdirLink(
  engineDir: string,
  objDir: string,
  oldRoot: string
): Promise<string | undefined> {
  let violation: string | undefined;
  await walk(resolve(engineDir, objDir), async (path, link) => {
    if (!link || violation) return;
    const target = resolve(dirname(path), await readlink(path));
    const canonical = await realpath(path).catch(() => target);
    if ([target, canonical].some((value) => value === oldRoot || value.startsWith(oldRoot + sep))) {
      violation = `${path} still links to the previous engine ${oldRoot}`;
    }
  });
  return violation;
}

/** Prunes only dangling _tests symlinks; never descends through a symlink. */
export async function pruneDanglingTestLinks(engineDir: string, objDir: string): Promise<number> {
  let removed = 0;
  const root = join(engineDir, objDir, '_tests');
  try {
    if (!(await lstat(root)).isDirectory()) return 0;
    await assertLocalObjdir(engineDir, objDir);
    await walk(root, async (path, link) => {
      if (!link) return;
      try {
        await realpath(path);
      } catch (error: unknown) {
        if (getNodeErrorCode(error) !== 'ENOENT') throw error;
        await rm(path);
        removed++;
      }
    });
  } catch (error: unknown) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
  }
  return removed;
}

/** Names a partial-config group whose entire persisted value set was nulled. */
export async function assertHealthyPartialConfig(engineDir: string, objDir: string): Promise<void> {
  for (const group of ['substs', 'defines']) {
    const dir = join(engineDir, objDir, 'config.statusd', group);
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error: unknown) {
      if (getNodeErrorCode(error) === 'ENOENT') continue;
      throw error;
    }
    const files = entries.filter((entry) => entry.isFile() && entry.name !== 'config.track');
    if (files.length === 0) continue;
    const values = await Promise.all(files.map((entry) => readFile(join(dir, entry.name), 'utf8')));
    if (values.every((value) => value.trim() === 'null')) {
      throw new GeneralError(
        `All ${files.length} partial-config ${group} values in ${dir} are null. Repair with "cd engine && python3 ./mach configure", then retry the full build.`
      );
    }
  }
}
