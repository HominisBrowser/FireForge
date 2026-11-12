// SPDX-License-Identifier: EUPL-1.2
/**
 * Transactions over files: change several paths and end up, whatever happens,
 * with either all of the old state or all of the new.
 *
 * A transaction keeps an undo journal: one append-only file holding, for
 * every path about to change, what was there before, and beside it a
 * directory (`<journal>.d`) holding the before-images of files as copies
 * (copy-on-write clones where the filesystem has them), so a large file costs
 * neither memory nor a second copy of its bytes. A record and its copies
 * reach stable storage before the path is touched. Then:
 *
 *  - the body returns: every path it changed is flushed to stable storage,
 *    then the journal is deleted. That deletion is the commit.
 *  - the body throws: the before-images are put back, and the error rethrown.
 *  - SIGINT or SIGTERM: no further change starts, and the interrupt pipeline
 *    rolls back the same way, after children have stopped.
 *  - the process dies outright: the journal stays on disk, and the next
 *    transaction on the same journal path (or {@link recoverJournal}, which
 *    `fireforge doctor --recover` runs) puts the before-images back first.
 *
 * One journal path serves one transaction at a time; the caller holds
 * whatever lock makes that true. Paths are absolute.
 */
import type { FileHandle } from 'node:fs/promises';
import { chmod, mkdir, open, readlink, rm, rmdir, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import { errnoCode, FireForgeError, invariant, toError } from './errors.js';
import {
  copyFile,
  listDir,
  move,
  pathInfo,
  readTextIfExists,
  remove,
  syncToDisk,
  tempPathFor,
  walkFiles,
  writeFile,
} from './fs.js';
import { hash, hashFile } from './hash.js';
import { parseJson } from './json.js';
import { verbose, warn } from './log.js';
import { isIdentityAlive, ownIdentity } from './process/index.js';
import { type Infer, s } from './schema.js';
import { isShuttingDown, onShutdown } from './signals.js';

/** What a transaction body may do. Every method takes absolute paths. */
export interface Transaction {
  /**
   * Replaces (or creates) a file, atomically, creating parent directories.
   *
   * @param path - The file
   * @param content - Text (as UTF-8) or bytes
   * @param options - `mode` sets the permission bits; default keeps the replaced file's
   */
  write(path: string, content: string | Uint8Array, options?: { mode?: number }): Promise<void>;
  /** Removes a file, symlink or whole directory tree. Absence is not an error. */
  remove(path: string): Promise<void>;
  /**
   * Runs `mutate`, which may change exactly `paths` by any means: its own
   * writes, or a program it runs. Each path may be a file, a symlink, a
   * directory tree, or absent. A listed directory is saved whole, so list
   * the paths that change, not a large tree around them. A file `mutate`
   * adds inside a listed directory is not removed by a rollback unless it is
   * listed too.
   */
  change(paths: readonly string[], mutate: () => Promise<void>): Promise<void>;
}

/**
 * What was at a path: nothing (null), a file (its bytes in the copy named
 * `copy` in the journal's directory), a symlink, or a directory.
 */
const Image = s.union(
  s.literal(null),
  s.object({ kind: s.literal('file'), copy: s.string(), mode: s.int(), hash: s.string() }),
  s.object({ kind: s.literal('symlink'), target: s.string() }),
  s.object({ kind: s.literal('directory'), mode: s.int() })
);

/**
 * One journal line. `save` is a before-image. `mkdir` is a directory the
 * transaction created on the way to a path, removed on undo if empty.
 * `expect` is the content hash a path has once its change is complete (null
 * for removed), which lets recovery notice a later edit.
 */
const Entry = s.union(
  s.object({ op: s.literal('save'), path: s.string(), before: Image }),
  s.object({ op: s.literal('mkdir'), path: s.string() }),
  s.object({
    op: s.literal('expect'),
    path: s.string(),
    hash: s.union(s.string(), s.literal(null)),
  })
);
type Entry = Infer<typeof Entry>;

/** The first journal line: who is making the change. */
const Header = s.object({
  journal: s.literal(1),
  label: s.string(),
  pid: s.int(),
  start: s.string().optional(),
  startedAt: s.string(),
});
type Header = Infer<typeof Header>;

/**
 * Bound on the interrupt pipeline's undo. Generous on purpose: an undo cut
 * short leaves the journal for the next run, and the pipeline then keeps
 * every lock until the process is gone.
 */
const ROLLBACK_TIMEOUT_MS = 120_000;

/** The directory holding a journal's file copies. */
function copiesOf(journalPath: string): string {
  return `${journalPath}.d`;
}

/** Files and directories a transaction or an undo wrote, to flush before the journal goes. */
class Touched {
  readonly files = new Set<string>();
  readonly directories = new Set<string>();

  add(path: string): void {
    this.files.add(path);
    this.directories.add(dirname(path));
  }

  async addTree(path: string): Promise<void> {
    this.add(path);
    if ((await pathInfo(path))?.kind !== 'directory') return;
    this.directories.add(path);
    for (const file of await walkFiles(path)) this.add(join(path, file));
  }

  flush(): Promise<void> {
    return syncToDisk(this.files, this.directories);
  }
}

/** The before-image of a path, and of everything under it when it is a directory. */
async function capture(
  path: string,
  into: Entry[],
  copy: (file: string) => Promise<{ copy: string; hash: string }>
): Promise<void> {
  const found = await pathInfo(path);
  if (found === undefined) {
    into.push({ op: 'save', path, before: null });
  } else if (found.kind === 'symlink') {
    into.push({ op: 'save', path, before: { kind: 'symlink', target: await readlink(path) } });
  } else if (found.kind === 'directory') {
    into.push({ op: 'save', path, before: { kind: 'directory', mode: found.mode } });
    for (const entry of await listDir(path)) await capture(join(path, entry.name), into, copy);
  } else {
    if (found.kind !== 'file') {
      throw new FireForgeError('journal-unsupported', `${path} is not a file`);
    }
    into.push({
      op: 'save',
      path,
      before: { kind: 'file', mode: found.mode, ...(await copy(path)) },
    });
  }
}

/**
 * Removes whatever non-directory now stands where the transaction had a
 * directory above `path`, outermost first, so nothing is restored through a
 * symlink. Only ancestors the journal recorded are examined: anything above
 * them was never the transaction's to change.
 */
async function clearTheWay(path: string, recorded: ReadonlySet<string>): Promise<void> {
  const ancestors: string[] = [];
  for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent)) {
    if (recorded.has(parent)) ancestors.unshift(parent);
  }
  for (const ancestor of ancestors) {
    const kind = (await pathInfo(ancestor))?.kind;
    if (kind !== undefined && kind !== 'directory') await rm(ancestor, { force: true });
  }
}

async function restore(
  entry: Entry,
  context: { copies: string; recorded: ReadonlySet<string>; touched: Touched }
): Promise<void> {
  if (entry.op === 'expect') return;
  if (entry.op === 'mkdir') {
    await rmdir(entry.path).catch((error: unknown) => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errnoCode(error) ?? '')) throw error;
    });
    context.touched.directories.add(dirname(entry.path));
    return;
  }
  const { path, before } = entry;
  await clearTheWay(path, context.recorded);
  context.touched.add(path);
  if (before === null) {
    await remove(path);
    return;
  }
  const now = await pathInfo(path);
  if (now !== undefined && (now.kind === 'directory') !== (before.kind === 'directory')) {
    await remove(path);
  }
  if (before.kind === 'directory') {
    await mkdir(path, { recursive: true });
    await chmod(path, before.mode);
    context.touched.directories.add(path);
  } else if (before.kind === 'symlink') {
    await mkdir(dirname(path), { recursive: true });
    const temp = tempPathFor(path);
    await symlink(before.target, temp);
    await move(temp, path);
  } else {
    await copyFile(join(context.copies, before.copy), path, { mode: before.mode });
  }
}

/**
 * Puts every before-image back, newest first, and flushes what it wrote.
 * Continues past a failure and reports them all.
 */
async function restoreAll(entries: readonly Entry[], label: string, copies: string): Promise<void> {
  const context = {
    copies,
    recorded: new Set(entries.map((entry) => entry.path)),
    touched: new Touched(),
  };
  const failures: string[] = [];
  for (const entry of [...entries].reverse()) {
    try {
      await restore(entry, context);
    } catch (error: unknown) {
      failures.push(`${entry.path}: ${toError(error).message}`);
    }
  }
  if (failures.length > 0) {
    throw new FireForgeError(
      'rollback-failed',
      `Could not undo ${label}; ${failures.length} path(s) were not restored:\n  ${failures.join('\n  ')}`,
      { hint: 'Run "fireforge doctor --recover" to retry the undo.' }
    );
  }
  await context.touched.flush();
}

/** Deletes a journal (the commit point, or the end of an undo) and then its copies. */
async function discardJournal(journalPath: string): Promise<void> {
  await rm(journalPath, { force: true });
  await syncToDisk([], [dirname(journalPath)]);
  await remove(copiesOf(journalPath));
}

const active = new Set<Journal>();
let hooked = false;

class Journal implements Transaction {
  private readonly entries: Entry[] = [];
  /** Paths whose before-image is recorded. */
  private readonly saved = new Set<string>();
  /** Directories recorded as created, which therefore did not exist before. */
  private readonly created = new Set<string>();
  private readonly touched = new Touched();
  private copies = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private state: 'open' | 'committing' | 'closing' | 'closed' = 'open';
  private undone: Promise<void> | undefined;

  constructor(
    private readonly file: string,
    private readonly label: string,
    private readonly handle: FileHandle
  ) {}

  write(
    path: string,
    content: string | Uint8Array,
    options: { mode?: number } = {}
  ): Promise<void> {
    return this.step([path], hash(content), async () => {
      await writeFile(path, content, { ...options, durable: false });
      this.touched.add(path);
    });
  }

  remove(path: string): Promise<void> {
    return this.step([path], null, async () => {
      await remove(path);
      this.touched.directories.add(dirname(path));
    });
  }

  change(paths: readonly string[], mutate: () => Promise<void>): Promise<void> {
    return this.step(paths, undefined, async () => {
      await mutate();
      for (const path of paths) await this.touched.addTree(path);
    });
  }

  isAt(file: string): boolean {
    return this.file === file;
  }

  /** Flushes every change, then deletes the journal: from here the new state is the state. */
  commit(): Promise<void> {
    return this.enqueue(async () => {
      this.state = 'committing';
      try {
        for (const directory of this.created) this.touched.directories.add(dirname(directory));
        await this.touched.flush();
        await rm(this.file, { force: true });
      } catch (error: unknown) {
        this.state = 'open';
        throw error;
      }
      this.state = 'closed';
      active.delete(this);
      await this.handle.close().catch(() => undefined);
      await syncToDisk([], [dirname(this.file)]).catch(() => undefined);
      await remove(copiesOf(this.file)).catch(() => undefined);
    });
  }

  /**
   * Puts the before-images back. An error path and the interrupt path can
   * both get here, so the claim is made synchronously and the second caller
   * joins the first. A transaction that committed, or whose commit is under
   * way and succeeds, is left alone.
   */
  rollback(): Promise<void> {
    this.undone ??= (async (): Promise<void> => {
      if (this.state === 'open') this.state = 'closing';
      await this.tail; // An operation already running finishes before its effect is undone.
      if (this.state === 'closed') return;
      this.state = 'closing';
      try {
        await this.handle.close().catch(() => undefined);
        await restoreAll(this.entries, this.label, copiesOf(this.file));
        await discardJournal(this.file);
        this.state = 'closed';
      } finally {
        active.delete(this);
      }
    })();
    return this.undone;
  }

  /**
   * Operations and the rollback run one at a time, so an undo never
   * interleaves with a write. Once an interrupt has arrived nothing new starts.
   */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => {
      if (this.state !== 'open' || isShuttingDown()) {
        throw new FireForgeError('interrupted', `${this.label} was interrupted and rolled back.`);
      }
      return operation();
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Copies a file's current bytes into the journal's directory: the copy's name and hash. */
  private async copy(path: string): Promise<{ copy: string; hash: string }> {
    const directory = copiesOf(this.file);
    if (this.copies === 0) {
      await mkdir(directory, { recursive: true });
      await syncToDisk([], [dirname(directory)]);
    }
    const name = String(this.copies++);
    await copyFile(path, join(directory, name));
    return { copy: name, hash: await hashFile(join(directory, name)) };
  }

  private step(
    paths: readonly string[],
    result: string | null | undefined,
    mutate: () => Promise<void>
  ): Promise<void> {
    return this.enqueue(async () => {
      const fresh: Entry[] = [];
      const reclaimed: string[] = [];
      for (const path of paths) {
        invariant(isAbsolute(path), () => `journaled path is absolute (got "${path}")`);
        if (this.created.has(path)) {
          reclaimed.push(path);
          fresh.push({ op: 'save', path, before: null });
        } else if (!this.saved.has(path) && !fresh.some((entry) => entry.path === path)) {
          await this.missingParents(path, fresh);
          await capture(path, fresh, (file) => this.copy(file));
        }
        if (result !== undefined) fresh.push({ op: 'expect', path, hash: result });
      }
      if (fresh.length > 0) await this.record(fresh);
      for (const path of reclaimed) this.created.delete(path);
      await mutate();
    });
  }

  /** Makes the records (and the copies they name) durable, then adopts them. */
  private async record(fresh: Entry[]): Promise<void> {
    const copies = copiesOf(this.file);
    const named = fresh.flatMap((entry) =>
      entry.op === 'save' && entry.before?.kind === 'file' ? [join(copies, entry.before.copy)] : []
    );
    await syncToDisk(named, named.length > 0 ? [copies] : []);
    await this.handle.appendFile(fresh.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
    await this.handle.sync();
    for (const entry of fresh) {
      if (entry.op === 'mkdir') this.created.add(entry.path);
      else if (entry.op === 'save') this.saved.add(entry.path);
    }
    this.entries.push(...fresh);
  }

  /** Records the directories that do not exist yet above `path`, outermost first. */
  private async missingParents(path: string, into: Entry[]): Promise<void> {
    const missing: string[] = [];
    const known = (parent: string): boolean =>
      this.saved.has(parent) ||
      this.created.has(parent) ||
      into.some((entry) => entry.path === parent);
    for (let parent = dirname(path); !known(parent); parent = dirname(parent)) {
      if ((await pathInfo(parent)) !== undefined || parent === dirname(parent)) break;
      missing.unshift(parent);
    }
    for (const directory of missing) into.push({ op: 'mkdir', path: directory });
  }
}

/** A journal a previous run left behind. */
export interface PendingJournal {
  /** What the interrupted transaction was doing. */
  label: string;
  pid: number;
  startedAt: string;
  /** Whether the process that wrote it is still running. */
  ownerAlive: boolean;
  /** The paths it had recorded before-images for. */
  paths: string[];
}

interface Parsed {
  header: Header;
  entries: Entry[];
}

/** Reads a journal. A torn final line is the write the crash interrupted, made before its change. */
async function parse(journalPath: string): Promise<Parsed | undefined> {
  const text = await readTextIfExists(journalPath);
  if (text === undefined) return undefined;
  const lines = text.split('\n').filter((line) => line.length > 0);
  const damaged = (index: number, cause?: unknown): FireForgeError =>
    new FireForgeError('journal-corrupt', `${journalPath} is damaged at line ${index + 1}`, {
      hint: 'Inspect that file and the paths it names, then delete it to continue.',
      cause,
    });
  let header: Header | undefined;
  const entries: Entry[] = [];
  for (const [index, line] of lines.entries()) {
    let record: unknown;
    try {
      record = parseJson(line, { source: journalPath });
    } catch (error: unknown) {
      if (index === lines.length - 1) break;
      throw damaged(index, error);
    }
    if (index === 0) {
      const checked = Header.validate(record);
      if (!checked.ok) throw damaged(index);
      header = checked.value;
    } else {
      const checked = Entry.validate(record);
      if (!checked.ok) throw damaged(index);
      entries.push(checked.value);
    }
  }
  // No header means the crash came before anything was recorded, so nothing changed.
  return {
    header: header ?? { journal: 1, label: 'an unrecorded change', pid: 0, startedAt: '' },
    entries,
  };
}

function ownerAlive(header: Header): boolean {
  return header.pid > 0 && isIdentityAlive({ pid: header.pid, start: header.start });
}

/**
 * Describes the journal an interrupted transaction left behind, without
 * changing anything.
 *
 * @param journalPath - The journal file
 * @returns The pending journal, or undefined when there is none
 */
export async function inspectJournal(journalPath: string): Promise<PendingJournal | undefined> {
  const parsed = await parse(journalPath);
  if (parsed === undefined) return undefined;
  const { header, entries } = parsed;
  return {
    label: header.label,
    pid: header.pid,
    startedAt: header.startedAt,
    ownerAlive: ownerAlive(header),
    paths: entries.flatMap((entry) => (entry.op === 'save' ? [entry.path] : [])),
  };
}

async function currentHash(path: string): Promise<string | null> {
  const kind = (await pathInfo(path))?.kind;
  if (kind === undefined) return null;
  return kind === 'file' ? hashFile(path) : 'not-a-file';
}

/** Paths whose content is neither what the transaction found nor what it wrote. */
async function driftedPaths(entries: readonly Entry[]): Promise<string[]> {
  const before = new Map<string, string | null>();
  const after = new Map<string, string | null>();
  for (const entry of entries) {
    if (entry.op === 'expect') after.set(entry.path, entry.hash);
    else if (entry.op === 'save' && !before.has(entry.path)) {
      before.set(
        entry.path,
        entry.before?.kind === 'file' ? entry.before.hash : entry.before && 'not-a-file'
      );
    }
  }
  const drifted: string[] = [];
  for (const [path, expected] of after) {
    const current = await currentHash(path);
    if (current !== expected && current !== before.get(path)) drifted.push(path);
  }
  return drifted;
}

/**
 * Undoes the transaction an earlier process left unfinished, restoring every
 * path it had recorded.
 *
 * A path the transaction wrote itself is checked first: if it now holds
 * neither the old content nor the new, someone edited it after the crash, and
 * recovery refuses rather than overwrite that edit.
 *
 * @param journalPath - The journal file
 * @returns Whether there was a journal to recover
 * @throws `journal-busy` when its writer is still running, `journal-conflict` on an edit
 */
export async function recoverJournal(journalPath: string): Promise<boolean> {
  const parsed = await parse(journalPath);
  if (parsed === undefined) {
    // A commit deletes the journal before its copies; finish that.
    await remove(copiesOf(journalPath));
    return false;
  }
  const { header, entries } = parsed;
  invariant(
    ![...active].some((journal) => journal.isAt(journalPath)),
    () => `one transaction at a time uses ${journalPath}`
  );
  if (header.pid !== process.pid && ownerAlive(header)) {
    throw new FireForgeError(
      'journal-busy',
      `PID ${header.pid} is still running ${header.label}; its changes are not complete.`,
      { hint: 'Wait for that command to finish and retry.' }
    );
  }
  const drifted = await driftedPaths(entries);
  if (drifted.length > 0) {
    throw new FireForgeError(
      'journal-conflict',
      `An interrupted run of ${header.label} left changes to undo, but ${drifted.length} of its ` +
        `file(s) were edited since:\n  ${drifted.join('\n  ')}`,
      {
        hint:
          `To keep every file as it is now, delete ${journalPath}. To undo the run instead, ` +
          'save those edits elsewhere, put the listed files back as the run left them, and run ' +
          '"fireforge doctor --recover".',
      }
    );
  }
  await restoreAll(entries, header.label, copiesOf(journalPath));
  await discardJournal(journalPath);
  const restored = entries.filter((entry) => entry.op === 'save').length;
  if (restored > 0) {
    warn(`Undid an interrupted run of ${header.label}: restored ${restored} path(s).`);
  }
  return true;
}

/**
 * Runs `body` as one transaction.
 *
 * @param journalPath - Where the undo journal lives while the transaction
 *   runs: an absolute path in state the project owns, not inside any
 *   directory the body changes
 * @param label - What is being done, for messages: "the patch queue update"
 * @param body - Makes its changes through the {@link Transaction} it is given
 * @returns What `body` returned, once its changes are committed
 */
export async function transaction<T>(
  journalPath: string,
  label: string,
  body: (tx: Transaction) => Promise<T>
): Promise<T> {
  await recoverJournal(journalPath);
  if (!hooked) {
    hooked = true;
    onShutdown(
      'rollback',
      async () => {
        await Promise.all([...active].map((journal) => journal.rollback()));
      },
      { timeoutMs: ROLLBACK_TIMEOUT_MS }
    );
  }
  const identity = await ownIdentity();
  const header: Header = {
    journal: 1,
    label,
    pid: process.pid,
    ...(identity === undefined ? {} : { start: identity.start }),
    startedAt: new Date().toISOString(),
  };
  await mkdir(dirname(journalPath), { recursive: true });
  const handle = await open(journalPath, 'wx');
  await handle.appendFile(`${JSON.stringify(header)}\n`);
  await handle.sync();
  await syncToDisk([], [dirname(journalPath)]);
  const journal = new Journal(journalPath, label, handle);
  active.add(journal);
  try {
    const result = await body(journal);
    await journal.commit();
    return result;
  } catch (error: unknown) {
    try {
      await journal.rollback();
      verbose(`Rolled back ${label} after a failure.`);
    } catch (rollbackError: unknown) {
      // The body's error is what the operator needs to see. The journal stays
      // on disk, so the next run retries the undo.
      warn(`${toError(rollbackError).message}\nThe journal is kept at ${journalPath}.`);
    }
    throw error;
  }
}
