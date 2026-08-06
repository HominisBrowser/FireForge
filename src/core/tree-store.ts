// SPDX-License-Identifier: EUPL-1.2
/**
 * Verification-tree storage and lifecycle for `fireforge tree` (FORGE G15).
 *
 * A tree is a FULL project-root CoW snapshot under
 * `.fireforge/trees/<name>` — `getProjectRoot()` walks up from cwd, so
 * every read command (status, lint, typecheck, verify, doctor,
 * `export --dry-run`) runs inside the tree unmodified and its build /
 * engine-session locks key on the tree root automatically. Trees are
 * snapshots by design: there is no merge-back model, mutation commands
 * are refused via the tree marker (see `tree-guard.ts`), and refresh is
 * `tree remove` + `tree create`.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { pathExists, readJson, writeJson } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { withFileLock } from './file-lock.js';
import { git } from './git-base.js';
import { cloneEntry, type CowCapability } from './tree-cow.js';

const TREE_MARKER_FILENAME = 'tree.json';
const TREES_DIRNAME = 'trees';

/** `.fireforge/tree.json` — identifies a directory as a verification tree. */
export interface TreeMarker {
  schemaVersion: 1;
  name: string;
  primaryRoot: string;
  createdAt: string;
  engineHead: string | null;
  patchesFingerprint: string | null;
}

/** One row of `tree list`. */
export interface TreeListEntry {
  name: string;
  path: string;
  createdAt: string;
  staleness: 'fresh' | 'stale (engine advanced)' | 'stale (patches changed)' | 'unknown';
}

/**
 * Top-level entries never cloned into a tree: per-tree state must start
 * clean (`.fireforge/`), locks are never inherited, the destructive-
 * operation audit log stays primary-only, and dependency dirs are
 * neither needed nor cheap.
 */
function isExcludedRootEntry(name: string): boolean {
  return (
    name === '.fireforge' ||
    name === 'node_modules' ||
    name === '.fireforge-history.jsonl' ||
    name.endsWith('.lock')
  );
}

/** Absolute trees directory for a primary root. */
export function getTreesDir(primaryRoot: string): string {
  return join(primaryRoot, '.fireforge', TREES_DIRNAME);
}

/** Serialises tree create/remove against each other (primary-side sidecar lock). */
export async function withTreeLifecycleLock<T>(
  primaryRoot: string,
  operation: () => Promise<T>
): Promise<T> {
  return withFileLock(join(primaryRoot, '.fireforge', 'trees.lock'), operation, {
    timeoutMs: 30_000,
    onTimeoutMessage:
      'Another fireforge tree create/remove is in progress. Wait for it to finish, then retry.',
  });
}

/** Reads the tree marker for a project root, or undefined when not a tree. */
export async function readTreeMarker(root: string): Promise<TreeMarker | undefined> {
  const markerPath = join(root, '.fireforge', TREE_MARKER_FILENAME);
  if (!(await pathExists(markerPath))) return undefined;
  try {
    const raw = await readJson<Partial<TreeMarker>>(markerPath);
    if (raw.schemaVersion !== 1 || typeof raw.name !== 'string') return undefined;
    return raw as TreeMarker;
  } catch (error: unknown) {
    verbose(`Unreadable tree marker at ${markerPath}: ${String(error)}`);
    return undefined;
  }
}

/** Current primary-side snapshot identity (engine HEAD + patches.json hash). */
export async function computePrimaryFingerprint(
  primaryRoot: string
): Promise<{ engineHead: string | null; patchesFingerprint: string | null }> {
  let engineHead: string | null;
  try {
    engineHead = (await git(['rev-parse', 'HEAD'], join(primaryRoot, 'engine'))).trim();
  } catch {
    engineHead = null;
  }
  const patchesJson = join(primaryRoot, 'patches', 'patches.json');
  const patchesFingerprint = (await pathExists(patchesJson))
    ? createHash('sha256')
        .update(await readFile(patchesJson))
        .digest('hex')
    : null;
  return { engineHead, patchesFingerprint };
}

/** Validates a tree name: one path segment, no traversal. */
export function assertValidTreeName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
    throw new GeneralError(
      `Invalid tree name "${name}". Use a single path segment of letters, digits, ".", "_" or "-".`
    );
  }
}

/**
 * Materialises the tree at `treeRoot` from `primaryRoot` using
 * `capability` ('none' = plain copy, already gated on --force-copy by
 * the caller). The engine tree is cloned whole and its `obj-*` build
 * directories removed afterwards — CoW removal is cheap, and per-entry
 * recursion into a Firefox tree is fragile. A fresh `.fireforge/` is
 * created with only `state.json` (when present) and the tree marker.
 */
export async function cloneTree(args: {
  primaryRoot: string;
  treeRoot: string;
  name: string;
  capability: CowCapability;
  createdAt: string;
}): Promise<TreeMarker> {
  const { primaryRoot, treeRoot, name, capability, createdAt } = args;
  const { mkdir, cp } = await import('node:fs/promises');
  await mkdir(treeRoot, { recursive: true });

  for (const entry of await readdir(primaryRoot)) {
    if (isExcludedRootEntry(entry)) continue;
    await cloneEntry(capability, join(primaryRoot, entry), join(treeRoot, entry));
  }

  // A cloned objdir embeds absolute topsrcdir/topobjdir paths back into
  // the PRIMARY tree (mach-build-artifacts.ts parses exactly those), so
  // in-tree builds/tests would silently operate against the primary —
  // remove the clones; `tree` is read-verification only in 0.40.0.
  const engineDir = join(treeRoot, 'engine');
  if (await pathExists(engineDir)) {
    for (const entry of await readdir(engineDir)) {
      if (entry.startsWith('obj-')) {
        await rm(join(engineDir, entry), { recursive: true, force: true });
      }
    }
    // Defensive: never inherit a mid-operation git index lock.
    await rm(join(engineDir, '.git', 'index.lock'), { force: true });
  }

  await mkdir(join(treeRoot, '.fireforge'), { recursive: true });
  const stateJson = join(primaryRoot, '.fireforge', 'state.json');
  if (await pathExists(stateJson)) {
    await cp(stateJson, join(treeRoot, '.fireforge', 'state.json'));
  }

  const { engineHead, patchesFingerprint } = await computePrimaryFingerprint(primaryRoot);
  const marker: TreeMarker = {
    schemaVersion: 1,
    name,
    primaryRoot,
    createdAt,
    engineHead,
    patchesFingerprint,
  };
  await writeJson(join(treeRoot, '.fireforge', TREE_MARKER_FILENAME), marker);
  return marker;
}

/** Lists trees with staleness against the current primary state. */
export async function listTrees(primaryRoot: string): Promise<TreeListEntry[]> {
  const treesDir = getTreesDir(primaryRoot);
  if (!(await pathExists(treesDir))) return [];
  const current = await computePrimaryFingerprint(primaryRoot);
  const entries: TreeListEntry[] = [];
  for (const name of (await readdir(treesDir)).sort((a, b) => a.localeCompare(b))) {
    if (name.endsWith('.lock')) continue;
    const path = join(treesDir, name);
    const marker = await readTreeMarker(path);
    if (!marker) {
      entries.push({ name, path, createdAt: '(no marker)', staleness: 'unknown' });
      continue;
    }
    const staleness =
      marker.engineHead !== current.engineHead
        ? ('stale (engine advanced)' as const)
        : marker.patchesFingerprint !== current.patchesFingerprint
          ? ('stale (patches changed)' as const)
          : ('fresh' as const);
    entries.push({ name, path, createdAt: marker.createdAt, staleness });
  }
  return entries;
}

/** Uses `kill(pid, 0)` — no signal sent, just an existence check. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the live holder PID of a mkdir-style lock directory, if any.
 * Reads the lock's `pid` file directly (line 1 = PID — the format
 * `file-lock.ts` documents as stable) instead of exporting file-lock
 * internals.
 */
async function liveLockHolder(lockPath: string): Promise<number | undefined> {
  try {
    const pidLine = (await readFile(join(lockPath, 'pid'), 'utf-8')).split('\n')[0] ?? '';
    const pid = parseInt(pidLine.trim(), 10);
    if (Number.isFinite(pid) && isProcessAlive(pid)) return pid;
  } catch {
    // No lock / unreadable pid file — treat as not held.
  }
  return undefined;
}

/**
 * Removes one tree. Refuses when a live process holds the tree's build
 * or engine-session lock, and never deletes a path outside the trees
 * directory (containment check before `rm -rf`).
 */
export async function removeTree(primaryRoot: string, name: string): Promise<void> {
  assertValidTreeName(name);
  const treesDir = getTreesDir(primaryRoot);
  const treeRoot = resolve(treesDir, name);
  if (!treeRoot.startsWith(treesDir + sep) || basename(treeRoot) !== name) {
    throw new GeneralError(
      `Refusing to remove "${name}": resolved path escapes the trees directory.`
    );
  }
  if (!(await pathExists(treeRoot))) {
    throw new GeneralError(`No verification tree named "${name}" exists under ${treesDir}.`);
  }

  for (const lockPath of [
    join(treeRoot, '.fireforge-build.lock'),
    join(treeRoot, '.fireforge', 'engine-session.lock'),
  ]) {
    const holder = await liveLockHolder(lockPath);
    if (holder !== undefined) {
      throw new GeneralError(
        `Refusing to remove tree "${name}": a live process (pid ${String(holder)}) holds ${lockPath}. ` +
          'Wait for it to finish, then retry.'
      );
    }
  }

  await rm(treeRoot, { recursive: true, force: true });
}
