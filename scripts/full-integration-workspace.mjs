// SPDX-License-Identifier: EUPL-1.2
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

/** NUL porcelain keeps filenames literal; rename records put the destination first. */
export function parseStatusEntries(output) {
  const records = output.split('\0');
  const entries = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    if (record.length < 4) throw new Error('Malformed Git porcelain status record');
    const code = record.slice(0, 2);
    const currentPath = record.slice(3);
    const originalPath = /[RC]/.test(code) ? records[++i] : undefined;
    if (/[RC]/.test(code) && !originalPath) throw new Error('Missing Git rename source');
    entries.push({ code, currentPath, ...(originalPath ? { originalPath } : {}) });
  }
  return entries;
}

function git(engineDir, args) {
  const result = spawnSync('git', ['-C', engineDir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Git ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}

export function readEngineStatus(engineDir) {
  return parseStatusEntries(
    git(engineDir, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  );
}

export function containedPath(root, path) {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (isAbsolute(path) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) {
    throw new Error(`Path escapes integration workspace: ${path}`);
  }
  return absolute;
}

/** Only ENOENT means absent. Read failures prevent the runner from arming mutation. */
export async function snapshotPath(path) {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'absent' };
    throw error;
  }
  if (stat.isSymbolicLink()) return { kind: 'link', target: await readlink(path) };
  if (!stat.isFile()) throw new Error(`Cannot snapshot non-file integration input: ${path}`);
  return { kind: 'file', content: await readFile(path), mode: stat.mode & 0o777 };
}

/** Replace regular files atomically; refuse to erase a directory during recovery. */
export async function restorePath(path, snapshot) {
  let current;
  try {
    current = await lstat(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (current?.isDirectory()) throw new Error(`Preserving directory at recovery path: ${path}`);
  if (snapshot.kind === 'absent') {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.fireforge-recovery-${randomUUID()}`;
  try {
    if (snapshot.kind === 'link') {
      // An untouched original link retains its identity as well as its target.
      if (current?.isSymbolicLink() && (await readlink(path)) === snapshot.target) return;
      await symlink(snapshot.target, temporary);
    } else {
      await writeFile(temporary, snapshot.content, { flag: 'wx', mode: snapshot.mode });
      await chmod(temporary, snapshot.mode);
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Capture every dirty path, both rename sides, and the index before any mutation. */
export async function snapshotEngine(engineDir) {
  const entries = readEngineStatus(engineDir);
  const tracked = new Set(git(engineDir, ['ls-files', '-z']).split('\0').filter(Boolean));
  const paths = new Map();
  for (const entry of entries) {
    for (const path of [entry.currentPath, entry.originalPath].filter(Boolean)) {
      paths.set(path, await snapshotPath(containedPath(engineDir, path)));
    }
  }
  const indexPath = resolve(engineDir, git(engineDir, ['rev-parse', '--git-path', 'index']).trim());
  const index = await snapshotPath(indexPath);
  if (index.kind !== 'file') throw new Error('Cannot snapshot a missing or linked Git index');
  return { entries, paths, tracked, indexPath, index };
}

/** Failures are recorded independently. Failed checkout never falls back to deletion. */
export async function restoreEngine(engineDir, baseline, cleanup, runGit = git) {
  let current = [];
  try {
    current = readEngineStatus(engineDir);
  } catch (error) {
    cleanup.errors.push(`Could not enumerate introduced paths; preserving them: ${error.message}`);
  }
  const introduced = new Set(
    current.flatMap((entry) => [entry.currentPath, entry.originalPath].filter(Boolean))
  );
  for (const path of baseline.paths.keys()) introduced.delete(path);
  for (const path of introduced) {
    try {
      const absolute = containedPath(engineDir, path);
      if (baseline.tracked.has(path)) runGit(engineDir, ['checkout', 'HEAD', '--', path]);
      else await restorePath(absolute, { kind: 'absent' });
      cleanup.actions.push(`Restored introduced engine path ${path}`);
    } catch (error) {
      cleanup.errors.push(`Preserved ${path}; recovery failed: ${error.message}`);
    }
  }
  for (const [path, snapshot] of baseline.paths) {
    try {
      await restorePath(containedPath(engineDir, path), snapshot);
      cleanup.actions.push(`Restored initially-dirty engine path ${path}`);
    } catch (error) {
      cleanup.errors.push(`Preserved ${path}; snapshot recovery failed: ${error.message}`);
    }
  }
  try {
    const lockPath = `${baseline.indexPath}.lock`;
    let locked = false;
    try {
      if (baseline.index.kind !== 'file') throw new Error('Original Git index is unavailable');
      await writeFile(lockPath, baseline.index.content, { flag: 'wx', mode: baseline.index.mode });
      locked = true;
      await chmod(lockPath, baseline.index.mode);
      await rename(lockPath, baseline.indexPath);
    } finally {
      if (locked) await rm(lockPath, { force: true });
    }
  } catch (error) {
    cleanup.errors.push(`Index recovery failed: ${error.message}`);
  }
}

export function recoveryFailure(errors) {
  return errors.length === 0
    ? null
    : new Error(`Integration recovery failed: ${errors.join('; ')}`);
}
