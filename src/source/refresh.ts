// SPDX-License-Identifier: EUPL-1.2
/**
 * Moving a source-mode checkout to a new pin, the way `git rebase` moves a
 * branch: every owned path is three-way merged from the old pristine file
 * (base), the owned file (ours) and the new pristine file (theirs), and the
 * result is applied in place to the source root, the override records and
 * the pin in `fireforge.json`, in one journal transaction. The user reviews
 * it with `git diff` and undoes it with git.
 *
 * A conflict is left the way git leaves one: text conflict markers in the
 * owned file, and the three versions as unmerged entries in the checkout's
 * index, so `git status` lists it, `git checkout --ours/--theirs` and
 * `git add` resolve it, and a commit is refused until then. Records of
 * conflicted paths already name the new upstream file, so resolving is only
 * a matter of the owned file's content.
 */
import { join, relative } from 'node:path';

import type { FirefoxConfig } from '../config/index.js';
import { setConfigValue } from '../config/index.js';
import {
  git,
  gitDir,
  listTree,
  objectFormat,
  status,
  type TreeEntry,
  writeBlobs,
} from '../git/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { readBytes, toPosixPath } from '../kernel/fs.js';
import { type Transaction, transaction } from '../kernel/journal.js';
import type { SourceProject } from '../project/index.js';
import { journalOf, withSourceLock } from './edit.js';
import { mergeContent } from './merge.js';
import { readPristineBlobs } from './objects.js';
import {
  ancestorsOf,
  compareText,
  defaultComponent,
  encodeRecord,
  type OverrideRecord,
  type Pristine,
  type RegularMode,
} from './records.js';
import { readSourceTree, recordFile, type SourceEntry, type SourceTree } from './tree.js';

/** The new pin's Firefox release, written to `firefox` in `fireforge.json`. */
export type FirefoxPin = Pick<FirefoxConfig, 'version' | 'product' | 'sha256'>;

/** Why a refreshed path conflicts. */
export type RefreshConflict =
  /** Both sides changed overlapping text; markers are in the owned file. */
  | 'content'
  /** Both sides changed binary content; the owned file keeps our bytes. */
  | 'binary'
  /** Both sides changed the executable bit differently. */
  | 'mode'
  /** One side deleted the file and the other changed it. */
  | 'delete-edit'
  /** Upstream added a file where the project had created one. */
  | 'upstream-collision';

/** What happened to one owned path. */
export interface RefreshPath {
  readonly path: string;
  /**
   * `kept`: nothing to merge (upstream left it alone, or a created file is
   * still free upstream); `merged`: both sides combined cleanly; `retired`:
   * the override or tombstone is no longer needed and was removed;
   * `conflict`: see `reason`.
   */
  readonly outcome: 'kept' | 'merged' | 'retired' | 'conflict';
  readonly reason?: RefreshConflict;
}

/** What {@link refreshPin} did. */
export interface RefreshResult {
  readonly paths: readonly RefreshPath[];
  /** The conflicted paths, to resolve before committing. */
  readonly conflicts: readonly string[];
}

type Side = { readonly bytes: Buffer; readonly mode: RegularMode } | undefined;

/** One path's planned change. */
interface Plan {
  readonly path: string;
  readonly result: RefreshPath;
  /** The owned file's next content; null removes it; undefined leaves it. */
  readonly file?: { readonly bytes: Buffer; readonly mode: RegularMode } | null;
  /** The record's next content; null removes it; undefined leaves it. */
  readonly record?: OverrideRecord | null;
  /** Unmerged index stages for a conflict. */
  readonly stages?: { readonly base: Side; readonly ours: Side; readonly theirs: Side };
}

function same(a: Side, b: Side): boolean {
  return a === undefined || b === undefined
    ? a === b
    : a.mode === b.mode && a.bytes.equals(b.bytes);
}

function rebased(record: OverrideRecord, commit: string, upstream: TreeEntry): OverrideRecord {
  return {
    ...record,
    base: { commit, blob: upstream.oid, mode: upstream.mode as RegularMode },
  };
}

function refused(code: string, message: string, hint: string): FireForgeError {
  return new FireForgeError(code, message, { exitCode: ExitCode.CONFIG_ERROR, hint });
}

/** Refuses a refresh that would start from anything but a clean, valid checkout at the old pin. */
async function assertReady(
  tree: SourceTree,
  oldPristine: Pristine,
  newPristine: Pristine
): Promise<void> {
  const { project, layout } = tree;
  if (project.config.source.pristineCommit !== oldPristine.commit) {
    throw refused(
      'refresh-pin-mismatch',
      `The project is pinned to ${project.config.source.pristineCommit}, not ${oldPristine.commit}.`,
      'Pass the pristine repository of the current pin as the old one.'
    );
  }
  if (newPristine.commit === oldPristine.commit) {
    throw refused('refresh-pin-unchanged', 'The new pin is the current pin.', 'Name another pin.');
  }
  if (tree.problems.length > 0) {
    throw refused(
      'source-invalid',
      `The owned files must be valid before a rebase:\n${tree.problems
        .map((problem) => `  ${problem.path}: ${problem.message}`)
        .join('\n')}`,
      'Run "fireforge verify" and fix what it reports.'
    );
  }
  const configFile = toPosixPath(relative(layout.worktree, project.paths.config));
  const dirty = await status(layout.worktree, {
    paths: [layout.source, layout.metadata, configFile],
  });
  if (dirty.length > 0) {
    throw refused(
      'refresh-dirty',
      `The source has uncommitted changes:\n${dirty
        .slice(0, 20)
        .map((entry) => `  ${entry.path}`)
        .join('\n')}`,
      'Commit or stash them first, so the rebase can be reviewed and undone with git.'
    );
  }
}

/** New pristine entries of the owned paths, refusing paths the new tree makes impossible. */
async function newUpstream(
  tree: SourceTree,
  newPristine: Pristine
): Promise<Map<string, TreeEntry>> {
  const paths = tree.entries.map((entry) => entry.path);
  const wanted = new Set(paths.flatMap((path) => [path, ...ancestorsOf(path)]));
  const entries = new Map(
    (
      await listTree(newPristine.repo, newPristine.commit, { paths: [...wanted], recursive: false })
    ).map((entry) => [entry.path, entry])
  );
  const blocked: string[] = [];
  for (const path of paths) {
    const entry = entries.get(path);
    const fileAbove = ancestorsOf(path).find((ancestor) => entries.get(ancestor)?.type === 'blob');
    if (fileAbove !== undefined) blocked.push(`${path}: upstream now has a file at ${fileAbove}`);
    else if (entry !== undefined && entry.type !== 'blob') {
      blocked.push(`${path}: upstream now has a directory here`);
    } else if (entry !== undefined && entry.mode !== '100644' && entry.mode !== '100755') {
      blocked.push(`${path}: upstream now has an entry of mode ${entry.mode} here`);
    }
  }
  if (blocked.length > 0) {
    throw refused(
      'refresh-blocked',
      `The new pin leaves no place for these owned paths:\n${blocked.map((line) => `  ${line}`).join('\n')}`,
      'Move or remove them, commit, and rebase again.'
    );
  }
  return entries;
}

interface Sides {
  readonly base: Side;
  readonly ours: Side;
  readonly theirs: Side;
}

/** The merge of an owned upstream path whose three sides are all present and differ. */
async function mergeThree(
  cwd: string,
  entry: SourceEntry,
  sides: Required<{ [K in keyof Sides]: NonNullable<Sides[K]> }>,
  record: OverrideRecord
): Promise<Plan> {
  const { base, ours, theirs } = sides;
  const mode =
    ours.mode === theirs.mode
      ? ours.mode
      : ours.mode === base.mode
        ? theirs.mode
        : theirs.mode === base.mode
          ? ours.mode
          : undefined;
  const merged = await mergeContent(
    cwd,
    { base: base.bytes, ours: ours.bytes, theirs: theirs.bytes },
    { ours: 'local', base: 'old pristine', theirs: 'new pristine' }
  );
  const conflict = (reason: RefreshConflict, bytes: Buffer): Plan => ({
    path: entry.path,
    result: { path: entry.path, outcome: 'conflict', reason },
    file: { bytes, mode: mode ?? ours.mode },
    record,
    stages: sides,
  });
  if (!merged.clean) return conflict(merged.reason, merged.markers ?? ours.bytes);
  if (mode === undefined) return conflict('mode', merged.content);
  if (same({ bytes: merged.content, mode }, theirs)) {
    return {
      path: entry.path,
      result: { path: entry.path, outcome: 'retired' },
      file: null,
      record: null,
    };
  }
  return {
    path: entry.path,
    result: { path: entry.path, outcome: 'merged' },
    file: { bytes: merged.content, mode },
    record,
  };
}

/** Plans one owned path. */
async function planEntry(
  tree: SourceTree,
  entry: SourceEntry,
  sides: Sides,
  upstream: TreeEntry | undefined,
  commit: string
): Promise<Plan> {
  const { path } = entry;
  const { base, ours, theirs } = sides;
  const retired: Plan = { path, result: { path, outcome: 'retired' }, file: null, record: null };
  if (entry.record === undefined || base === undefined) {
    if (upstream === undefined || theirs === undefined) {
      return { path, result: { path, outcome: 'kept' } };
    }
    return {
      path,
      result: { path, outcome: 'conflict', reason: 'upstream-collision' },
      record: {
        kind: 'override',
        base: { commit, blob: upstream.oid, mode: theirs.mode },
        component: defaultComponent(path),
        classification: 'registration',
      },
      stages: { base: undefined, ours, theirs },
    };
  }
  const record = upstream === undefined ? null : rebased(entry.record, commit, upstream);
  if (same(base, theirs)) return { path, result: { path, outcome: 'kept' }, record };
  // Upstream now holds our side, or our side left upstream alone: nothing is left to own.
  if (same(ours, theirs) || same(base, ours)) return retired;
  if (ours === undefined || theirs === undefined || record === null) {
    return {
      path,
      result: { path, outcome: 'conflict', reason: 'delete-edit' },
      record,
      stages: sides,
    };
  }
  return mergeThree(tree.layout.worktree, entry, { base, ours, theirs }, record);
}

/** Writes the unmerged index entries of the conflicts. */
async function writeStages(tree: SourceTree, plans: readonly Plan[]): Promise<void> {
  const { worktree, source } = tree.layout;
  const conflicted = plans.filter((plan) => plan.stages !== undefined);
  if (conflicted.length === 0) return;
  const zero = '0'.repeat((await objectFormat(worktree)) === 'sha256' ? 64 : 40);
  const lines: string[] = [];
  for (const plan of conflicted) {
    const file = `${source}/${plan.path}`;
    const stages = plan.stages ?? { base: undefined, ours: undefined, theirs: undefined };
    const present = ([stages.base, stages.ours, stages.theirs] as const).flatMap((side, index) =>
      side === undefined ? [] : [{ side, stage: index + 1 }]
    );
    const oids = await writeBlobs(
      worktree,
      present.map((each) => each.side.bytes)
    );
    lines.push(`0 ${zero}\t${file}\0`);
    present.forEach((each, index) => {
      lines.push(`${each.side.mode} ${oids[index] ?? ''} ${each.stage}\t${file}\0`);
    });
  }
  await git(['update-index', '-z', '--index-info'], { cwd: worktree, input: lines.join('') });
}

async function applyPlans(
  tx: Transaction,
  tree: SourceTree,
  plans: readonly Plan[]
): Promise<void> {
  const { layout, project } = tree;
  for (const plan of plans) {
    const file = join(project.paths.source, plan.path);
    const record = join(layout.worktree, recordFile(layout, plan.path));
    if (plan.file === null) await tx.remove(file);
    else if (plan.file !== undefined) {
      await tx.write(file, plan.file.bytes, { mode: plan.file.mode === '100755' ? 0o755 : 0o644 });
    }
    if (plan.record === null) await tx.remove(record);
    else if (plan.record !== undefined) await tx.write(record, encodeRecord(plan.record));
  }
}

/**
 * Moves a clean source-mode checkout from the old pin to a new one: merges
 * every owned path three ways, applies the result to the owned files and
 * records, and updates `source.pristineCommit` and `firefox` in
 * `fireforge.json`, all in one transaction. Conflicts are left as git
 * leaves them (see the module comment).
 *
 * @param project - A source-mode project at the old pin with no uncommitted source changes
 * @param oldPristine - The pristine repository of the current pin
 * @param newPristine - The pristine repository of the new pin
 * @param firefox - The new pin's release
 * @throws `refresh-pin-mismatch`, `refresh-pin-unchanged`, `refresh-dirty`,
 *   `refresh-blocked`, `source-invalid`
 */
export function refreshPin(
  project: SourceProject,
  oldPristine: Pristine,
  newPristine: Pristine,
  firefox: FirefoxPin
): Promise<RefreshResult> {
  // Under the source lock, so no other FireForge writer changes an owned file between the read and the merge.
  return withSourceLock(project, async () => {
    const tree = await readSourceTree(project, oldPristine);
    await assertReady(tree, oldPristine, newPristine);
    const plans = await planRefresh(tree, oldPristine, newPristine);
    const index = join(await gitDir(tree.layout.worktree), 'index');
    await transaction(journalOf(project), 'the rebase', async (tx) => {
      await applyPlans(tx, tree, plans);
      await tx.change([index], () => writeStages(tree, plans));
      await tx.change([project.paths.config], async () => {
        await setConfigValue(project.root, 'source.pristineCommit', newPristine.commit);
        await setConfigValue(project.root, 'firefox', JSON.stringify(firefox));
      });
    });
    const paths = plans.map((plan) => plan.result);
    return {
      paths,
      conflicts: paths.filter((path) => path.outcome === 'conflict').map((path) => path.path),
    };
  });
}

/** Plans every owned path of the tree against the new pin. */
async function planRefresh(
  tree: SourceTree,
  oldPristine: Pristine,
  newPristine: Pristine
): Promise<Plan[]> {
  const upstream = await newUpstream(tree, newPristine);
  const oldBlobs = await readPristineBlobs(
    oldPristine,
    tree.entries.flatMap((entry) => (entry.upstream === undefined ? [] : [entry.upstream.blob]))
  );
  const newBlobs = await readPristineBlobs(
    newPristine,
    tree.entries.flatMap((entry) => {
      const found = upstream.get(entry.path);
      return found === undefined ? [] : [found.oid];
    })
  );
  const plans: Plan[] = [];
  for (const entry of [...tree.entries].sort((a, b) => compareText(a.path, b.path))) {
    const found = upstream.get(entry.path);
    const sides: Sides = {
      base:
        entry.upstream === undefined
          ? undefined
          : {
              bytes: oldBlobs.get(entry.upstream.blob) ?? Buffer.alloc(0),
              mode: entry.upstream.mode,
            },
      ours:
        entry.file === undefined
          ? undefined
          : { bytes: await readBytes(entry.file.absolute), mode: entry.file.mode },
      theirs:
        found === undefined
          ? undefined
          : { bytes: newBlobs.get(found.oid) ?? Buffer.alloc(0), mode: found.mode as RegularMode },
    };
    plans.push(await planEntry(tree, entry, sides, found, newPristine.commit));
  }
  return plans;
}
