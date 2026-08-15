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
import { existsSync } from 'node:fs';
import { lstat, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { getNodeErrorCode, isProcessAlive, toError } from '../utils/errors.js';
import { pathExists, readJson, writeJson } from '../utils/fs.js';
import { verbose, warn } from '../utils/logger.js';
import { isObject } from '../utils/validation.js';
import { getBuildBaselinePath } from './build-baseline.js';
import { LOCK_PID_FILE, withFileLock } from './file-lock.js';
import { git } from './git-base.js';
import { getAllDiff } from './git-diff.js';
import { attemptMozinfoRewrite } from './mach-build-artifacts.js';
import { cloneEntry, type CowCapability } from './tree-cow.js';

const TREE_MARKER_FILENAME = 'tree.json';
const TREES_DIRNAME = 'trees';
const TREE_CLONE_CONCURRENCY = 8;

/** `.fireforge/tree.json` — identifies a directory as a verification tree. */
export interface TreeMarker {
  schemaVersion: 1;
  name: string;
  primaryRoot: string;
  createdAt: string;
  engineHead: string | null;
  /** Hash of the primary engine's tracked + untracked working-tree diff. */
  engineFingerprint?: string | null;
  patchesFingerprint: string | null;
  /**
   * Name of the obj-* directory cloned into this tree, written only after
   * its mozinfo.json was successfully rewritten to the tree's paths AND the
   * caller's in-tree reconfigure regenerated the remaining configure output.
   * Its presence is what lets the guard admit build-less `test` in-tree
   * (`tree-guard.ts`); absent on trees created without `--with-objdir`.
   */
  clonedObjdir?: string;
}

/** One row of `tree list`. */
export interface TreeListEntry {
  name: string;
  path: string;
  createdAt: string;
  staleness:
    | 'fresh'
    | 'stale (engine advanced)'
    | 'stale (engine worktree changed)'
    | 'stale (patches changed)'
    | 'unknown';
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

/**
 * Validates every field of a tree marker.
 *
 * The read below checked only `schemaVersion` and `name` and asserted the
 * rest, but the unvalidated fields are consumed unguarded: `primaryRoot`
 * reaches a user-facing refusal message (`tree-guard.ts:105`), and
 * `engineHead`/`patchesFingerprint` feed the staleness compare, where an
 * `undefined` from a truncated marker reports every tree as stale.
 */
function isTreeMarker(value: unknown): value is TreeMarker {
  if (!isObject(value)) return false;
  return (
    value['schemaVersion'] === 1 &&
    typeof value['name'] === 'string' &&
    typeof value['primaryRoot'] === 'string' &&
    typeof value['createdAt'] === 'string' &&
    (typeof value['engineHead'] === 'string' || value['engineHead'] === null) &&
    (value['engineFingerprint'] === undefined ||
      typeof value['engineFingerprint'] === 'string' ||
      value['engineFingerprint'] === null) &&
    (typeof value['patchesFingerprint'] === 'string' || value['patchesFingerprint'] === null) &&
    (value['clonedObjdir'] === undefined || typeof value['clonedObjdir'] === 'string')
  );
}

/**
 * Outcome of reading a tree marker.
 *
 * The three states must stay distinct because they carry opposite safety
 * meanings. `absent` means "this directory is not a tree", which is what lets
 * every mutating command run. `corrupt` means "this directory claims to be a
 * tree but we cannot read the claim" — collapsing it into `absent` (as a bare
 * `undefined` return does) hands a snapshot the full mutating command set on
 * the strength of a file we failed to parse, inverting `tree-guard.ts`'s
 * default-deny design. Deleting one field from a marker was enough to run
 * `reset` inside a clone.
 */
export type TreeMarkerRead =
  { kind: 'absent' } | { kind: 'valid'; marker: TreeMarker } | { kind: 'corrupt'; reason: string };

/** Absolute path of a root's tree marker. */
export function getTreeMarkerPath(root: string): string {
  return join(root, '.fireforge', TREE_MARKER_FILENAME);
}

/**
 * Reads the tree marker for a project root, distinguishing "not a tree" from
 * "a tree whose marker we could not read". Callers that make a safety decision
 * (the guard hook, the no-nesting refusal) must use this rather than
 * {@link readTreeMarker}.
 *
 * Only ENOENT/ENOTDIR mean `absent`: any other probe failure (EACCES on the
 * `.fireforge` directory, EIO, …) reports `corrupt`, because "we cannot read
 * the marker" is not evidence that there is no marker — a `pathExists`
 * pre-check here classified a tree with an unreadable `.fireforge` as
 * `absent` and handed it the full mutating command set.
 */
export async function readTreeMarkerState(root: string): Promise<TreeMarkerRead> {
  const markerPath = getTreeMarkerPath(root);
  try {
    const raw = await readJson<unknown>(markerPath);
    if (!isTreeMarker(raw)) {
      verbose(`Malformed tree marker at ${markerPath}`);
      return { kind: 'corrupt', reason: 'the marker is missing or mistypes a required field' };
    }
    return { kind: 'valid', marker: raw };
  } catch (error: unknown) {
    const code = getNodeErrorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    verbose(`Unreadable tree marker at ${markerPath}: ${String(error)}`);
    return { kind: 'corrupt', reason: `the marker could not be read (${toError(error).message})` };
  }
}

/**
 * Reads the tree marker for a project root, or undefined when it is absent
 * OR unreadable.
 *
 * For display and best-effort paths only (`tree list` renders an unreadable
 * marker as staleness 'unknown'). Anything that decides whether a mutation may
 * proceed must call {@link readTreeMarkerState} and handle `corrupt`.
 */
export async function readTreeMarker(root: string): Promise<TreeMarker | undefined> {
  const state = await readTreeMarkerState(root);
  return state.kind === 'valid' ? state.marker : undefined;
}

/**
 * Refuses a build-less in-tree `test` when the objdir preflight found is not
 * the one this tree's marker vouched for as rewritten-and-reconfigured. A
 * mismatch means an objdir appeared in the tree through some path other than
 * `tree create --with-objdir` (manual copy, partial restore), so nothing
 * proves it was relocated — running against it could consult primary paths.
 * No-op outside a tree; a corrupt marker is already refused by the guard.
 */
export async function assertObjdirMatchesTreeMarker(
  projectRoot: string,
  objDir: string | undefined
): Promise<void> {
  const state = await readTreeMarkerState(projectRoot);
  if (state.kind !== 'valid' || state.marker.clonedObjdir === undefined) return;
  if (objDir !== state.marker.clonedObjdir) {
    throw new GeneralError(
      `This verification tree's marker records "${state.marker.clonedObjdir}" as its cloned build, ` +
        `but the preflight found ${objDir === undefined ? 'no objdir' : `"${objDir}"`}. ` +
        'Only the objdir cloned by tree create --with-objdir is proven to be relocated to this tree. ' +
        'Remove and re-create the tree (fireforge tree remove/create).'
    );
  }
}

/** Current primary-side snapshot identity, including dirty source and patch bodies. */
export async function computePrimaryFingerprint(primaryRoot: string): Promise<{
  engineHead: string | null;
  engineFingerprint?: string | null;
  patchesFingerprint: string | null;
}> {
  const engineDir = join(primaryRoot, 'engine');
  let engineHead: string | null;
  try {
    engineHead = (await git(['rev-parse', 'HEAD'], engineDir)).trim();
  } catch {
    // An engine that is missing, unborn, or not a git checkout has no HEAD to
    // fingerprint. `null` is a legal marker value and reads as 'unknown', which
    // `listTrees` renders as staleness 'unknown' rather than a false 'fresh'.
    engineHead = null;
  }
  let engineFingerprint: string | null;
  try {
    engineFingerprint = createHash('sha256')
      .update(await getAllDiff(engineDir))
      .digest('hex');
  } catch {
    engineFingerprint = null;
  }

  const patchesDir = join(primaryRoot, 'patches');
  let patchesFingerprint: string | null = null;
  try {
    if (await pathExists(patchesDir)) {
      const hash = createHash('sha256');
      for (const name of (await readdir(patchesDir))
        .filter((entry) => entry.endsWith('.patch') || entry === 'patches.json')
        .sort()) {
        hash
          .update(name)
          .update('\0')
          .update(await readFile(join(patchesDir, name)))
          .update('\0');
      }
      patchesFingerprint = hash.digest('hex');
    }
  } catch {
    patchesFingerprint = null;
  }
  return { engineHead, engineFingerprint, patchesFingerprint };
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
 * Refuses an objdir that is not a plain directory physically inside
 * `engineDir` — every `cp` mode `cloneEntry` uses preserves symlinks, so
 * a symlinked `engine/obj-*` would be cloned as a symlink pointing back
 * at the original (primary or fully external) build, and the clone's
 * mozinfo rewrite and `_virtualenvs` removal would then mutate that
 * original through the link. Checks lstat (the entry itself must be a
 * real directory) AND realpath containment (a real directory reached
 * through a symlinked parent resolves elsewhere) — the rewriter's
 * lexical `resolve()` paths cannot detect either. Also validates the
 * name as a single `obj-*` path segment. Role `'primary'` guards before
 * any copying starts; `'cloned'` re-checks the tree's copy before any
 * write goes through it (defense in depth).
 */
async function assertCloneSafeObjdir(
  engineDir: string,
  objDir: string,
  role: 'primary' | 'cloned'
): Promise<void> {
  const where = role === 'primary' ? 'engine/' : "the tree's engine/";
  if (!/^obj-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(objDir) || objDir.includes('..')) {
    throw new GeneralError(
      `Invalid objdir name "${objDir}". Expected a single obj-* path segment of letters, digits, ".", "_" or "-".`
    );
  }
  const objDirPath = join(engineDir, objDir);
  let stats;
  try {
    stats = await lstat(objDirPath);
  } catch (error: unknown) {
    throw new GeneralError(
      `tree create --with-objdir cannot stat ${where}${objDir}: ${toError(error).message}`
    );
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new GeneralError(
      `tree create --with-objdir refuses ${where}${objDir}: it is ${
        stats.isSymbolicLink() ? 'a symlink' : 'not a directory'
      }. A cloned symlinked objdir would be rewritten through the link, mutating the ` +
        'original build it points at. Replace it with a real directory or create the tree ' +
        'without --with-objdir.'
    );
  }
  const [realObjDir, realEngineDir] = await Promise.all([
    realpath(objDirPath),
    realpath(engineDir),
  ]);
  if (realObjDir !== join(realEngineDir, objDir)) {
    throw new GeneralError(
      `tree create --with-objdir refuses ${where}${objDir}: it resolves to ${realObjDir}, ` +
        `outside ${realEngineDir}. An objdir reached through a symlink would be rewritten ` +
        'in place, mutating the original build. Replace it with a real directory or create ' +
        'the tree without --with-objdir.'
    );
  }
}

/**
 * Materialises the tree at `treeRoot` from `primaryRoot` using
 * `capability` ('none' = plain copy, already gated on --force-copy by
 * the caller). The engine is cloned one TOP-LEVEL entry at a time so unwanted
 * `obj-*` directories are never traversed or materialised. That distinction
 * is substantial on Firefox trees: even CoW-cloning and deleting an objdir
 * touches metadata for millions of build outputs. With `withObjdir` exactly
 * that objdir is included — after {@link assertCloneSafeObjdir}
 * refuses symlinked or engine-escaping objdirs before any copying —
 * rewritten to the tree (see below), and
 * reconfigured in-tree via the caller-supplied `reconfigure` hook. A
 * fresh `.fireforge/` is created with only `state.json` (when present),
 * the last-build baseline (withObjdir only), and the tree marker.
 */
export async function cloneTree(args: {
  primaryRoot: string;
  treeRoot: string;
  name: string;
  capability: CowCapability;
  createdAt: string;
  withObjdir?: { objDir: string; reconfigure: (treeEngineDir: string) => Promise<void> };
}): Promise<TreeMarker> {
  const { primaryRoot, treeRoot, name, capability, createdAt, withObjdir } = args;
  const { mkdir, cp } = await import('node:fs/promises');
  if (withObjdir) {
    // Refuse a symlinked/escaping primary objdir BEFORE any copying: the
    // clone would carry the symlink and every later write would land in
    // the original build (see assertCloneSafeObjdir).
    await assertCloneSafeObjdir(join(primaryRoot, 'engine'), withObjdir.objDir, 'primary');
  }
  await mkdir(treeRoot, { recursive: true });

  const rootEntries = (await readdir(primaryRoot)).filter((entry) => !isExcludedRootEntry(entry));
  const engineDir = join(treeRoot, 'engine');
  await mapWithConcurrency(rootEntries, TREE_CLONE_CONCURRENCY, async (entry) => {
    if (entry !== 'engine') {
      await cloneEntry(capability, join(primaryRoot, entry), join(treeRoot, entry));
      return;
    }

    const primaryEngineDir = join(primaryRoot, 'engine');
    await mkdir(engineDir, { recursive: true });
    const engineEntries = (await readdir(primaryEngineDir)).filter(
      (engineEntry) => !engineEntry.startsWith('obj-') || engineEntry === withObjdir?.objDir
    );
    await mapWithConcurrency(engineEntries, TREE_CLONE_CONCURRENCY, async (engineEntry) => {
      await cloneEntry(
        capability,
        join(primaryEngineDir, engineEntry),
        join(engineDir, engineEntry)
      );
    });
  });

  // A selected objdir embeds absolute topsrcdir/topobjdir paths back into
  // the PRIMARY tree. It is rewritten below before the marker records it as
  // usable; no other objdir ever enters the snapshot.
  if (await pathExists(engineDir)) {
    // Defensive: never inherit a mid-operation git index lock.
    await rm(join(engineDir, '.git', 'index.lock'), { force: true });
  }

  if (withObjdir) {
    await rewriteClonedObjdir(engineDir, withObjdir.objDir);
    // Regenerate configure output (config.status, backend.mk, Makefile,
    // config/autoconf.mk) against the tree's paths — the mozinfo rewrite
    // alone leaves those naming the primary. A failed reconfigure throws
    // before the marker below records the objdir as usable (fail-closed).
    await withObjdir.reconfigure(engineDir);
  }

  await mkdir(join(treeRoot, '.fireforge'), { recursive: true });
  const stateJson = join(primaryRoot, '.fireforge', 'state.json');
  if (await pathExists(stateJson)) {
    await cp(stateJson, join(treeRoot, '.fireforge', 'state.json'));
  }
  if (withObjdir) {
    // The in-tree stale-build and static-components gates anchor on the
    // last-build baseline; without the copy they would read `undefined`
    // and degrade to first-build semantics inside a fully built tree.
    const baseline = getBuildBaselinePath(primaryRoot);
    if (await pathExists(baseline)) {
      await cp(baseline, getBuildBaselinePath(treeRoot));
    }
  }

  const { engineHead, engineFingerprint, patchesFingerprint } =
    await computePrimaryFingerprint(primaryRoot);
  const marker: TreeMarker = {
    schemaVersion: 1,
    name,
    primaryRoot,
    createdAt,
    engineHead,
    engineFingerprint: engineFingerprint ?? null,
    patchesFingerprint,
    ...(withObjdir ? { clonedObjdir: withObjdir.objDir } : {}),
  };
  await writeJson(join(treeRoot, '.fireforge', TREE_MARKER_FILENAME), marker);
  return marker;
}

/**
 * Points the cloned objdir at the tree: rewrites mozinfo.json's
 * topsrcdir/topobjdir (and an in-tree mozconfig) via the same
 * safe-relocation rewriter `build --rewrite-mozinfo` uses, refusing
 * fail-closed when its safety rules cannot prove the rewrite correct —
 * a tree must never hold an objdir that still names the primary. Before
 * any write, the cloned objdir is re-checked as a real directory inside
 * the tree ({@link assertCloneSafeObjdir}) so no write ever goes through
 * a symlink into the original build. The cloned `_virtualenvs` are
 * removed outright: their scripts carry primary-tree shebang paths, and
 * mach rebuilds venvs in-tree on first use. The configure-generated root
 * files (config.status, backend.mk, Makefile, config/autoconf.mk) still
 * name the primary after this rewrite; they are regenerated by the
 * in-tree `mach configure` the caller supplies to {@link cloneTree},
 * which runs before the marker is written.
 */
async function rewriteClonedObjdir(engineDir: string, objDir: string): Promise<void> {
  await assertCloneSafeObjdir(engineDir, objDir, 'cloned');
  const rewrite = await attemptMozinfoRewrite(engineDir, objDir);
  if (!rewrite.rewritten) {
    throw new GeneralError(
      `Cannot keep the cloned build: ${rewrite.reason ?? 'mozinfo.json rewrite refused'}. ` +
        'The objdir would still operate against the primary tree. ' +
        'Re-run tree create without --with-objdir, or rebuild the primary objdir with "fireforge build" and retry.'
    );
  }
  await rm(join(engineDir, objDir, '_virtualenvs'), { recursive: true, force: true });
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
        : marker.engineFingerprint !== undefined &&
            marker.engineFingerprint !== current.engineFingerprint
          ? ('stale (engine worktree changed)' as const)
          : marker.patchesFingerprint !== current.patchesFingerprint
            ? ('stale (patches changed)' as const)
            : ('fresh' as const);
    entries.push({ name, path, createdAt: marker.createdAt, staleness });
  }
  return entries;
}

/** Whether a tree's mkdir-style lock directory is held, free, or unreadable. */
type TreeLockState =
  { kind: 'free' } | { kind: 'held'; pid: number } | { kind: 'unknown'; reason: string };

/**
 * Classifies a mkdir-style lock directory. Reads the lock's owner file
 * directly (line 1 = PID — the format `file-lock.ts` documents as stable,
 * whose name it shares via {@link LOCK_PID_FILE}) instead of exporting
 * file-lock internals.
 *
 * Liveness comes from the shared {@link isProcessAlive}, which treats EPERM
 * as alive. The local copy this replaced returned `false` for EPERM, so a
 * tree whose build lock was held by a live process running under a different
 * uid passed the guard below and was `rm -rf`'d mid-build.
 *
 * The `unknown` state is not a theoretical case. `withFileLock` takes the lock
 * by creating the directory and only *then* writes the owner file, treating a
 * write failure as non-fatal — so every acquisition passes through a window in
 * which the lock is genuinely held and has no readable PID, and a read-only or
 * full filesystem leaves it that way for the lock's whole life. Reporting that
 * as `free` let `removeTree` recursively delete a tree out from under a live
 * build. `file-lock.ts` reaches the same conclusion for its own stale
 * recovery, where an unreadable PID falls back to an age-only heuristic rather
 * than assuming the lock is abandoned.
 */
async function inspectTreeLock(lockPath: string): Promise<TreeLockState> {
  if (!existsSync(lockPath)) return { kind: 'free' };
  let pidLine: string;
  try {
    pidLine = (await readFile(join(lockPath, LOCK_PID_FILE), 'utf-8')).split('\n')[0] ?? '';
  } catch (error: unknown) {
    // A lock cleanly released between the existence probe above and this read
    // leaves no directory behind — that is a release, not an unreadable owner,
    // and demanding --force for it would be a spurious refusal.
    if (!existsSync(lockPath)) return { kind: 'free' };
    return {
      kind: 'unknown',
      reason: `its owner record is missing or unreadable (${toError(error).message})`,
    };
  }
  const pid = parseInt(pidLine.trim(), 10);
  if (!Number.isFinite(pid)) {
    return { kind: 'unknown', reason: 'its owner record does not name a process id' };
  }
  return isProcessAlive(pid) ? { kind: 'held', pid } : { kind: 'free' };
}

/**
 * Removes one tree. Refuses when a live process holds the tree's build
 * or engine-session lock — or when a lock directory exists whose ownership
 * cannot be established, which `--force` overrides — and never deletes a path
 * outside the trees directory (containment check before `rm -rf`).
 */
export async function removeTree(
  primaryRoot: string,
  name: string,
  options: { force?: boolean } = {}
): Promise<void> {
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
    const state = await inspectTreeLock(lockPath);
    if (state.kind === 'held') {
      throw new GeneralError(
        `Refusing to remove tree "${name}": a live process (pid ${String(state.pid)}) holds ${lockPath}. ` +
          'Wait for it to finish, then retry.'
      );
    }
    if (state.kind === 'unknown' && options.force !== true) {
      throw new GeneralError(
        `Refusing to remove tree "${name}": ${lockPath} exists but ${state.reason}, so it may be ` +
          'held by a live process. Wait for any in-flight build or test to finish; if none is ' +
          'running, re-run with --force to delete the tree and the stale lock.'
      );
    }
    if (state.kind === 'unknown') {
      warn(`Removing tree "${name}" through ${lockPath}, whose ownership is unknown (--force).`);
    }
  }

  await rm(treeRoot, { recursive: true, force: true });
}
