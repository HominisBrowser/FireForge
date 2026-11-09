// SPDX-License-Identifier: EUPL-1.2
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { GeneralError } from '../../errors/base.js';
import { getNodeErrorCode } from '../../utils/errors.js';
import { isObject } from '../../utils/validation.js';
import { withFileLock } from '../file-lock.js';
import { type ExportEntry, exportGitTree } from './export-tree.js';
import {
  canonicalJson,
  isObjectId,
  listSourceTree,
  parseSourceTreeRecords,
  pristineRepositoryFor,
  readSourceBlobs,
  sourceGit,
  sourceRecord,
} from './git.js';
import {
  assertNoSourceAliases,
  assertOutputBoundary,
  assertPristinePath,
  assertSourcePath,
  isReservedRootInput,
} from './paths.js';
import { authenticateAuthoredSnapshot, readPristineEntry } from './provider.js';
import type {
  AuthoredSnapshot,
  MaterializationResult,
  MaterializeAuthoredOptions,
  SourceFileMode,
} from './types.js';

interface FileImage {
  bytes: Buffer;
  mode: SourceFileMode;
}
interface LedgerFile {
  sha256: string | null;
  mode: SourceFileMode;
  kind: 'created' | 'override' | 'delete' | 'generated';
}
interface Ledger {
  schemaVersion: 1;
  snapshotId: string;
  pinCommit: string;
  files: Record<string, LedgerFile>;
}
interface Change {
  path: string;
  before: FileImage | null;
  after: FileImage | null;
}
interface Journal {
  ledger: Ledger;
  previousLedger: string | null;
  changes: Change[];
}

function imageHash(image: FileImage): string {
  return createHash('sha256').update(image.bytes).digest('hex');
}

function sameImage(a: FileImage | null, b: FileImage | null): boolean {
  return a === null || b === null ? a === b : a.mode === b.mode && a.bytes.equals(b.bytes);
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error: unknown) {
    if (getNodeErrorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * The file at a path. A directory reads as absent when every file under it is in `owned`: a path
 * turning between one file and a directory of files the same transaction writes or removes. The
 * forward pass passes the files leaving; recovery passes every path its journal changes, as a
 * directory can be half-built in either direction.
 */
async function imageAt(
  root: string,
  path: string,
  owned: ReadonlySet<string> = new Set()
): Promise<FileImage | null> {
  await assertNoSourceAliases(root, path);
  const target = join(root, path);
  let stat;
  try {
    stat = await lstat(target);
  } catch (error: unknown) {
    if (['ENOENT', 'ENOTDIR'].includes(getNodeErrorCode(error) ?? '')) return null;
    throw error;
  }
  if (stat.isFile())
    return {
      bytes: await readFile(target),
      mode: (stat.mode & 0o111) !== 0 ? '100755' : '100644',
    };
  if (stat.isDirectory()) {
    const entries = await readdir(target, { recursive: true, withFileTypes: true });
    const held = entries
      .filter((entry) => !entry.isDirectory())
      .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'));
    if (held.every((file) => owned.has(file))) return null;
  }
  throw new GeneralError(`authored-invalid-output-kind: ${path}`);
}

/** Durable writes are for the journal and ledger; engine outputs are re-creatable from them. */
async function atomicWrite(
  path: string,
  bytes: Buffer,
  { mode = 0o600, durable = true }: { mode?: number; durable?: boolean } = {}
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.authored-${randomUUID()}`;
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(bytes);
    if (durable) await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Remove directories a removal emptied, so a later file can take their place. */
async function pruneEmptyParents(root: string, path: string): Promise<void> {
  for (let directory = dirname(path); directory !== root; directory = dirname(directory)) {
    try {
      await rmdir(directory);
    } catch {
      return;
    }
  }
}

async function putImage(root: string, path: string, image: FileImage | null): Promise<void> {
  assertSourcePath(path);
  await assertNoSourceAliases(root, path);
  const target = join(root, path);
  await assertOutputBoundary(root, target);
  if (!image) {
    await rm(target, { force: true });
    await pruneEmptyParents(root, target);
    return;
  }
  await rmdir(target).catch(() => undefined);
  await atomicWrite(target, image.bytes, {
    mode: image.mode === '100755' ? 0o755 : 0o644,
    durable: false,
  });
}

function parseLedger(raw: string): Ledger {
  const value: unknown = JSON.parse(raw);
  if (
    !isObject(value) ||
    value['schemaVersion'] !== 1 ||
    !isObject(value['files']) ||
    typeof value['pinCommit'] !== 'string' ||
    typeof value['snapshotId'] !== 'string'
  )
    throw new GeneralError('authored-ledger-invalid');
  const files = sourceRecord<LedgerFile>();
  for (const [path, file] of Object.entries(value['files'])) {
    assertSourcePath(path);
    if (!isObject(file)) throw new GeneralError('authored-ledger-invalid');
    const mode = file['mode'];
    const kind = file['kind'];
    const sha256 = file['sha256'];
    if (
      (mode !== '100644' && mode !== '100755') ||
      (kind !== 'created' && kind !== 'override' && kind !== 'delete' && kind !== 'generated') ||
      (sha256 !== null && (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)))
    )
      throw new GeneralError('authored-ledger-invalid');
    files[path] = { mode, kind, sha256 };
  }
  return {
    schemaVersion: 1,
    snapshotId: value['snapshotId'],
    pinCommit: value['pinCommit'],
    files,
  };
}

function encodeImage(image: FileImage | null): unknown {
  return image && { bytes: image.bytes.toString('base64'), mode: image.mode };
}

function encodeJournal(journal: Journal): Buffer {
  return Buffer.from(
    canonicalJson({
      schemaVersion: 1,
      ledger: journal.ledger,
      previousLedger: journal.previousLedger,
      changes: journal.changes.map((change) => ({
        path: change.path,
        before: encodeImage(change.before),
        after: encodeImage(change.after),
      })),
    })
  );
}

function parseImage(value: unknown): FileImage | null {
  if (value === null) return null;
  if (
    !isObject(value) ||
    typeof value['bytes'] !== 'string' ||
    (value['mode'] !== '100644' && value['mode'] !== '100755')
  )
    throw new GeneralError('authored-journal-invalid');
  return { bytes: Buffer.from(value['bytes'], 'base64'), mode: value['mode'] };
}

function parseJournal(raw: string): Journal {
  const value: unknown = JSON.parse(raw);
  if (
    !isObject(value) ||
    value['schemaVersion'] !== 1 ||
    !Array.isArray(value['changes']) ||
    (value['previousLedger'] !== null && typeof value['previousLedger'] !== 'string')
  )
    throw new GeneralError('authored-journal-invalid');
  const ledger = parseLedger(canonicalJson(value['ledger']));
  const changes: Change[] = [];
  for (const change of value['changes'] as unknown[]) {
    if (!isObject(change) || typeof change['path'] !== 'string')
      throw new GeneralError('authored-journal-invalid');
    assertSourcePath(change['path']);
    changes.push({
      path: change['path'],
      before: parseImage(change['before']),
      after: parseImage(change['after']),
    });
  }
  return { previousLedger: value['previousLedger'], ledger, changes };
}

function desiredImages(
  snapshot: AuthoredSnapshot,
  blobs: ReadonlyMap<string, Buffer>
): { desired: Map<string, FileImage | null>; ledger: Ledger } {
  const desired = new Map<string, FileImage | null>();
  const ledger: Ledger = {
    schemaVersion: 1,
    snapshotId: snapshot.id,
    pinCommit: snapshot.pin.commit,
    files: sourceRecord<LedgerFile>(),
  };
  for (const file of snapshot.files) {
    const bytes = file.blob ? blobs.get(file.blob) : undefined;
    if (file.blob && !bytes) throw new GeneralError(`authored-object-unavailable: ${file.path}`);
    const image: FileImage | null = bytes ? { bytes, mode: file.mode } : null;
    desired.set(file.path, image);
    ledger.files[file.path] = {
      sha256: image ? imageHash(image) : null,
      mode: file.mode,
      kind: file.kind,
    };
  }
  return { desired, ledger };
}

async function recover(root: string, ledgerPath: string): Promise<void> {
  const journalPath = `${ledgerPath}.journal`;
  const raw = await readOptional(journalPath);
  if (!raw) return;
  const journal = parseJournal(raw);
  const applied = await readOptional(ledgerPath);
  const committed =
    applied !== undefined && canonicalJson(parseLedger(applied)) === canonicalJson(journal.ledger);
  // Each journaled path is checked on its own below, so a directory holding only journaled paths
  // is the file-or-directory transition caught partway, whichever way it was going.
  const transitional = new Set(journal.changes.map((change) => change.path));
  for (const change of journal.changes) {
    assertSourcePath(change.path);
    const actual = await imageAt(root, change.path, transitional);
    if (!sameImage(actual, change.before) && !sameImage(actual, change.after)) {
      throw new GeneralError(
        `authored-recovery-drift: ${change.path}; preserve the journal and resolve external edits`
      );
    }
    if (committed && !sameImage(actual, change.after))
      throw new GeneralError(`authored-recovery-drift: committed output ${change.path}`);
  }
  if (!committed) {
    for (const change of [...journal.changes].reverse())
      await putImage(root, change.path, change.before);
    if (journal.previousLedger === null) await rm(ledgerPath, { force: true });
    else await atomicWrite(ledgerPath, Buffer.from(journal.previousLedger));
  }
  await rm(journalPath, { force: true });
}

/** Ledger-owned paths must still hold what was recorded; dropped ones go back to pristine or away. */
async function planRemovals(options: {
  root: string;
  previous: Ledger;
  desired: Map<string, FileImage | null>;
  pristineRepository: string;
  commit: string;
  restored: string[];
}): Promise<void> {
  const { root, previous, desired, pristineRepository, commit, restored } = options;
  for (const [path, old] of Object.entries(previous.files)) {
    const actual = await imageAt(root, path);
    if ((actual ? imageHash(actual) : null) !== old.sha256 || (actual && actual.mode !== old.mode))
      throw new GeneralError(`authored-engine-drift: ${path}`);
    if (desired.has(path)) continue;
    const pristine = await readPristineEntry(pristineRepository, commit, path);
    if (old.kind !== 'created' && pristine) {
      const bytes = (await readSourceBlobs(pristineRepository, [pristine.blob])).get(pristine.blob);
      if (!bytes) throw new GeneralError(`authored-object-unavailable: ${path}`);
      desired.set(path, { bytes, mode: pristine.mode });
      restored.push(path);
    } else desired.set(path, null);
  }
}

/** Removals run first and deepest first, so a path can turn from a directory into a file or back. */
function writeOrder(a: Change, b: Change): number {
  if ((a.after === null) !== (b.after === null)) return a.after === null ? -1 : 1;
  const depth = b.path.split('/').length - a.path.split('/').length;
  if (a.after === null && depth !== 0) return depth;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/** Transactional compare-before-write update of only source-owned engine paths. */
export async function materializeAuthoredSnapshot(
  options: MaterializeAuthoredOptions
): Promise<MaterializationResult> {
  const snapshot = await authenticateAuthoredSnapshot(options.snapshot, options.pristineRepository);
  const root = resolve(options.engineDir);
  const ledgerPath = resolve(options.ledgerPath);
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink())
    throw new GeneralError('authored-output-alias: engine root is a symlink');
  if (ledgerPath === join(root, '.git') || ledgerPath.startsWith(join(root, '.git') + '/'))
    throw new GeneralError('authored-ledger-in-git');
  await mkdir(dirname(ledgerPath), { recursive: true });
  return withFileLock(`${ledgerPath}.lock`, async () => {
    await recover(root, ledgerPath);
    const previousRaw = await readOptional(ledgerPath);
    const previous = previousRaw === undefined ? undefined : parseLedger(previousRaw);
    if (previous && previous.pinCommit !== snapshot.pin.commit)
      throw new GeneralError(
        'authored-source-refresh-required: materialization cannot change the pristine pin'
      );
    const pristineRepository = pristineRepositoryFor(
      snapshot.repository,
      options.pristineRepository
    );
    const blobs = await readSourceBlobs(
      snapshot.repository,
      snapshot.files.flatMap((file) => (file.blob ? [file.blob] : []))
    );
    const upstream = await readSourceBlobs(
      pristineRepository,
      snapshot.files.flatMap((file) => (file.declaration ? [file.declaration.base.blob] : []))
    );
    const { desired, ledger } = desiredImages(snapshot, blobs);
    const result: MaterializationResult = {
      snapshotId: snapshot.id,
      changed: [],
      removed: [],
      restored: [],
    };
    if (previous)
      await planRemovals({
        root,
        previous,
        desired,
        pristineRepository,
        commit: snapshot.pin.commit,
        restored: result.restored,
      });
    const declarations = new Map(snapshot.files.map((file) => [file.path, file.declaration]));
    const leaving = new Set(
      [...desired].flatMap(([path, image]) => (image === null ? [path] : []))
    );
    const changes: Change[] = [];
    for (const [path, after] of [...desired].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const before = await imageAt(root, path, leaving);
      if (!previous?.files[path]) {
        const declaration = declarations.get(path);
        const base = declaration ? upstream.get(declaration.base.blob) : undefined;
        if (declaration && !base) throw new GeneralError(`authored-object-unavailable: ${path}`);
        const pristine: FileImage | null =
          declaration && base ? { bytes: base, mode: declaration.base.mode } : null;
        if (!sameImage(before, pristine) && !sameImage(before, after))
          throw new GeneralError(`authored-engine-drift: unowned output ${path}`);
      }
      if (!sameImage(before, after)) changes.push({ path, before, after });
    }
    changes.sort(writeOrder);
    const journal: Journal = { ledger, previousLedger: previousRaw ?? null, changes };
    await atomicWrite(`${ledgerPath}.journal`, encodeJournal(journal));
    try {
      for (const change of changes) {
        if (!sameImage(await imageAt(root, change.path, leaving), change.before))
          throw new GeneralError(`authored-engine-moved: ${change.path}`);
        await putImage(root, change.path, change.after);
        (change.after ? result.changed : result.removed).push(change.path);
      }
      await atomicWrite(ledgerPath, Buffer.from(canonicalJson(ledger)));
      await rm(`${ledgerPath}.journal`, { force: true });
      return result;
    } catch (error: unknown) {
      await recover(root, ledgerPath);
      throw error;
    }
  });
}

async function assertEmptyDestination(destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  if ((await lstat(destination)).isSymbolicLink()) throw new GeneralError('authored-output-alias');
  if ((await readdir(destination)).length)
    throw new GeneralError('authored-export-destination-not-empty');
}

/** Export captured root inputs into an empty directory; reserved runtime names never occur there. */
export async function exportCapturedTree(
  snapshot: AuthoredSnapshot,
  destination: string
): Promise<void> {
  const inputs = await listSourceTree(snapshot.repository, snapshot.tree);
  for (const entry of inputs) {
    assertSourcePath(entry.path);
    if (isReservedRootInput(entry.path))
      throw new GeneralError(`authored-reserved-input: ${entry.path}`);
  }
  await assertEmptyDestination(destination);
  await exportGitTree(snapshot.repository, snapshot.tree, inputs, destination);
}

/** Refuse a pristine link pointing outside the destination before anything is extracted. */
async function assertPristineLinks(
  repository: string,
  entries: readonly ExportEntry[],
  destination: string
): Promise<void> {
  const links = entries.filter((entry) => entry.mode === '120000');
  const blobs = await readSourceBlobs(
    repository,
    links.map((entry) => entry.blob)
  );
  const root = resolve(destination);
  for (const entry of links) {
    const target = new TextDecoder('utf8', { fatal: true }).decode(blobs.get(entry.blob));
    const resolved = resolve(dirname(join(root, entry.path)), target);
    if (!resolved.startsWith(root + sep))
      throw new GeneralError(`authored-pristine-link-escape: ${entry.path}`);
    assertPristinePath(relative(root, resolved).split(sep).join('/'));
  }
}

/** Seed a pristine tree from immutable objects, without Git writes in an engine. */
export async function exportPristineTree(
  repository: string,
  commit: string,
  destination: string
): Promise<void> {
  if (!isObjectId(commit)) throw new GeneralError('authored-invalid-pristine-commit');
  const raw = await sourceGit(repository, ['ls-tree', '-r', '-z', '--full-tree', commit]);
  const entries = parseSourceTreeRecords(raw).map((record): ExportEntry => {
    if (record.type !== 'blob' || !['100644', '100755', '120000'].includes(record.mode))
      throw new GeneralError(`authored-invalid-pristine-kind: ${record.path}`);
    assertPristinePath(record.path);
    return { path: record.path, mode: record.mode, blob: record.oid };
  });
  await assertEmptyDestination(destination);
  await assertPristineLinks(repository, entries, destination);
  const tree = (await sourceGit(repository, ['rev-parse', '--verify', `${commit}^{tree}`]))
    .toString('utf8')
    .trim();
  await exportGitTree(repository, tree, entries, destination);
}

/** Reconcile explicitly authorized derived outputs after their caller validates the closed generator contract. */
export async function recordAuthoredDerivedOutputs(options: {
  engineDir: string;
  ledgerPath: string;
  snapshotId: string;
  paths: readonly string[];
}): Promise<Record<string, { sha256: string; mode: SourceFileMode }>> {
  const root = resolve(options.engineDir);
  const ledgerPath = resolve(options.ledgerPath);
  return withFileLock(`${ledgerPath}.lock`, async () => {
    await recover(root, ledgerPath);
    const raw = await readOptional(ledgerPath);
    if (!raw) throw new GeneralError('authored-ledger-missing');
    const ledger = parseLedger(raw);
    if (ledger.snapshotId !== options.snapshotId)
      throw new GeneralError('authored-derived-generation-mismatch');
    const recorded = sourceRecord<{ sha256: string; mode: SourceFileMode }>();
    for (const path of [...new Set(options.paths)].sort()) {
      assertSourcePath(path);
      const previous = ledger.files[path];
      if (!previous || previous.kind === 'delete')
        throw new GeneralError(`authored-derived-unmanaged: ${path}`);
      const image = await imageAt(root, path);
      if (!image) throw new GeneralError(`authored-derived-missing: ${path}`);
      const sha256 = imageHash(image);
      ledger.files[path] = { ...previous, sha256, mode: image.mode };
      recorded[path] = { sha256, mode: image.mode };
    }
    await atomicWrite(ledgerPath, Buffer.from(canonicalJson(ledger)));
    return recorded;
  });
}
