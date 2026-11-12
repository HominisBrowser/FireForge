// SPDX-License-Identifier: EUPL-1.2
/**
 * Changing what the checkout owns: declaring the first touch of an upstream
 * file (`override`), giving one back (`restore`), and the one way helpers
 * that edit owned files (registration, wiring, tokens, components) write
 * them. Writers in one checkout take the source lock, so two FireForge
 * commands never interleave a read-check-write of the same file; editors
 * do not take it.
 */
import { join } from 'node:path';

import { listTree, objectFormat, resolveRevision } from '../git/index.js';
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { pathInfo, readBytesIfExists, readTextIfExists, writeFile } from '../kernel/fs.js';
import { type Transaction, transaction } from '../kernel/journal.js';
import { readJsonIfExists } from '../kernel/json.js';
import { withLock } from '../kernel/lock.js';
import type { Project, SourceProject } from '../project/index.js';
import { attributesFile, completedAttributes, installMergeDriver } from './merge.js';
import { blobId, readPristineBlobs } from './objects.js';
import {
  assertEnginePath,
  COMPONENT_PATTERN,
  defaultComponent,
  encodeRecord,
  type OverrideRecord,
  overrideRecordSchema,
  type Pristine,
  type RegularMode,
  unownableReason,
} from './records.js';
import { layoutOf, recordFile } from './tree.js';

/**
 * The project as a source-mode project.
 *
 * @param project - A loaded project
 * @throws `source-mode-required` (exit code 2) for a patch-mode project
 */
export function requireSourceMode(project: Project): SourceProject {
  if (project.mode === 'source') return project;
  throw new FireForgeError(
    'source-mode-required',
    'This command works on source-mode projects; this project keeps a patch queue.',
    {
      exitCode: ExitCode.CONFIG_ERROR,
      hint: 'Edit engine/ directly and capture with "fireforge export".',
    }
  );
}

/** Serialises writers of owned files and records in one checkout. */
export function withSourceLock<T>(project: SourceProject, body: () => Promise<T>): Promise<T> {
  return withLock(join(project.paths.stateDir, 'source.lock'), { label: 'source' }, body);
}

/** The journal of changes to owned files and records in one checkout. */
export function journalOf(project: SourceProject): string {
  return join(project.paths.stateDir, 'source.journal');
}

interface Located {
  /** The owned file. */
  file: string;
  /** The override record. */
  record: string;
}

function locate(project: SourceProject, path: string): Located {
  assertEnginePath(path);
  const unownable = unownableReason(path);
  if (unownable !== undefined) {
    throw new FireForgeError('source-unownable-path', `${path} ${unownable}.`, {
      exitCode: ExitCode.INVALID_ARGUMENT,
      hint: 'Keep that change out of the source root, or make it in a file of the fork itself.',
    });
  }
  const layout = layoutOf(project);
  return {
    file: join(project.paths.source, path),
    record: join(layout.worktree, recordFile(layout, path)),
  };
}

async function readRecordAt(file: string): Promise<OverrideRecord | undefined> {
  return readJsonIfExists(file, overrideRecordSchema, {
    code: 'source-record-invalid',
    exitCode: ExitCode.CONFIG_ERROR,
    hint: 'Correct the record, or remove it with "fireforge restore".',
  });
}

async function upstreamEntry(
  pristine: Pristine,
  path: string
): Promise<{ blob: string; mode: RegularMode } | 'other' | undefined> {
  const [entry] = await listTree(pristine.repo, pristine.commit, {
    paths: [path],
    recursive: false,
  });
  if (entry === undefined) return undefined;
  return entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755')
    ? { blob: entry.oid, mode: entry.mode }
    : 'other';
}

/** How {@link override} declares a touch. */
export interface OverrideOptions {
  /** Declare an upstream deletion (a tombstone) instead of an edit. */
  readonly delete?: boolean;
  /** Default: the path's top directory. */
  readonly component?: string;
  /** Default `registration`. */
  readonly classification?: 'registration' | 'exception';
  /** Project-relative decision record; required for an exception. */
  readonly adr?: string;
  /** Make the writes part of this transaction, which the caller commits. */
  readonly tx?: Transaction;
}

/** What {@link override} declared. */
export interface Declared {
  /** The record, as written or as it already was. */
  readonly record: OverrideRecord;
  /** Whether the merge driver configuration was written into the repository's git config. */
  readonly driverInstalled: boolean;
}

async function checkedOptions(
  project: SourceProject,
  path: string,
  options: OverrideOptions
): Promise<Pick<OverrideRecord, 'component' | 'classification' | 'adr'>> {
  const component = options.component ?? defaultComponent(path);
  if (!COMPONENT_PATTERN.test(component)) {
    throw new FireForgeError(
      'source-invalid-component',
      `"${component}" is not a component name.`,
      {
        exitCode: ExitCode.INVALID_ARGUMENT,
        hint: 'Name one with --component, using letters, digits, ".", "_" and "-", starting with a letter or digit.',
      }
    );
  }
  const classification = options.classification ?? 'registration';
  if (classification === 'exception' && options.adr === undefined) {
    throw new FireForgeError('source-adr-required', 'An exception needs its decision record.', {
      exitCode: ExitCode.INVALID_ARGUMENT,
      hint: 'Pass --adr <path> naming the approved decision record.',
    });
  }
  if (
    options.adr !== undefined &&
    (await pathInfo(join(project.root, options.adr)))?.kind !== 'file'
  ) {
    throw new FireForgeError(
      'source-adr-missing',
      `The decision record ${options.adr} does not exist.`,
      {
        exitCode: ExitCode.INVALID_ARGUMENT,
        hint: 'Write the record first, or name an existing one with --adr.',
      }
    );
  }
  return { component, classification, ...(options.adr === undefined ? {} : { adr: options.adr }) };
}

/**
 * Declares the first touch of an upstream file: writes its override record
 * and, for an edit, seeds the owned file with the pristine bytes to edit.
 * An existing owned file is refused unless it already holds the pristine
 * bytes, so no edit escapes its record. Also installs the merge driver.
 *
 * @param project - A source-mode project
 * @param pristine - The pinned pristine repository
 * @param path - The engine path
 * @param options - See {@link OverrideOptions}
 * @throws `source-not-upstream`, `source-override-exists`, `source-undeclared-edit`,
 *   `source-unownable-path`, `source-invalid-component`, `source-adr-required`,
 *   `source-adr-missing`
 */
export async function override(
  project: SourceProject,
  pristine: Pristine,
  path: string,
  options: OverrideOptions = {}
): Promise<Declared> {
  const located = locate(project, path);
  const declared = await checkedOptions(project, path, options);
  const upstream = await upstreamEntry(pristine, path);
  if (upstream === undefined || upstream === 'other') {
    throw new FireForgeError(
      'source-not-upstream',
      upstream === undefined
        ? `${path} is not an upstream file at the pinned commit.`
        : `${path} is not a regular file upstream, so it cannot be overridden.`,
      {
        exitCode: ExitCode.INVALID_ARGUMENT,
        ...(upstream === undefined
          ? { hint: `To add it, create ${project.config.source.root}/${path} directly.` }
          : {}),
      }
    );
  }
  const record: OverrideRecord = {
    kind: options.delete === true ? 'delete' : 'override',
    base: { commit: pristine.commit, blob: upstream.blob, mode: upstream.mode },
    ...declared,
  };
  const [bytes] = (await readPristineBlobs(pristine, [upstream.blob])).values();
  const pristineBytes = bytes ?? Buffer.alloc(0);
  await withSourceLock(project, async () => {
    const existing = await readRecordAt(located.record);
    if (existing !== undefined) {
      if (encodeRecord(existing) === encodeRecord(record)) return;
      throw new FireForgeError(
        'source-override-exists',
        `${path} already has an override record.`,
        {
          exitCode: ExitCode.INVALID_ARGUMENT,
          hint: 'Edit the record to change it, or remove it with "fireforge restore" first.',
        }
      );
    }
    const current = await readBytesIfExists(located.file);
    const untouched =
      current !== undefined &&
      options.delete !== true &&
      blobId(current, upstream.blob.length === 64 ? 'sha256' : 'sha1') === upstream.blob;
    if (current !== undefined && !untouched) {
      throw new FireForgeError(
        'source-undeclared-edit',
        `${project.config.source.root}/${path} already exists without an override record.`,
        {
          exitCode: ExitCode.INVALID_ARGUMENT,
          hint:
            options.delete === true
              ? 'Delete the owned file first.'
              : `Move it aside, run "fireforge override ${path}", then reapply the edit.`,
        }
      );
    }
    const attributes = completedAttributes(await readTextIfExists(attributesFile(project)));
    const declare = async (tx: Transaction): Promise<void> => {
      await tx.write(located.record, encodeRecord(record));
      if (record.kind === 'override' && current === undefined) {
        await tx.write(located.file, pristineBytes, {
          mode: upstream.mode === '100755' ? 0o755 : 0o644,
        });
      }
      if (attributes !== undefined) await tx.write(attributesFile(project), attributes);
    };
    if (options.tx !== undefined) await declare(options.tx);
    else await transaction(journalOf(project), `the override of ${path}`, declare);
  });
  const driver = await installMergeDriver(project);
  return { record, driverInstalled: driver.changed };
}

/** What {@link restore} removed. */
export interface Restored {
  readonly path: string;
  /** The record was a deletion; the upstream file comes back. */
  readonly wasDeletion: boolean;
  /** An owned file was removed. */
  readonly removedFile: boolean;
}

/**
 * Gives an upstream file back: removes its override record and owned file,
 * so the next materialization restores the upstream bytes. Uncommitted
 * edits of the owned file are refused unless `discard`.
 *
 * @param project - A source-mode project
 * @param path - The engine path
 * @param options - `discard` drops uncommitted edits
 * @throws `source-not-overridden`, `source-uncommitted-edit`
 */
export async function restore(
  project: SourceProject,
  path: string,
  options: { discard?: boolean } = {}
): Promise<Restored> {
  const located = locate(project, path);
  const layout = layoutOf(project);
  return withSourceLock(project, async () => {
    const record = await readRecordAt(located.record);
    if (record === undefined) {
      throw new FireForgeError('source-not-overridden', `${path} has no override record.`, {
        exitCode: ExitCode.INVALID_ARGUMENT,
      });
    }
    const current = await readBytesIfExists(located.file);
    if (current !== undefined && options.discard !== true) {
      const pristineFormat = record.base.blob.length === 64 ? 'sha256' : 'sha1';
      const committed = await resolveRevision(layout.worktree, `HEAD:${layout.source}/${path}`);
      const expendable =
        blobId(current, pristineFormat) === record.base.blob ||
        (committed !== undefined &&
          blobId(current, await objectFormat(layout.worktree)) === committed);
      if (!expendable) {
        throw new FireForgeError(
          'source-uncommitted-edit',
          `${project.config.source.root}/${path} has uncommitted edits a restore would lose.`,
          { exitCode: ExitCode.INVALID_ARGUMENT, hint: 'Commit them, or pass --discard.' }
        );
      }
    }
    await transaction(journalOf(project), `the restore of ${path}`, async (tx) => {
      await tx.remove(located.file);
      await tx.remove(located.record);
    });
    return { path, wasDeletion: record.kind === 'delete', removedFile: current !== undefined };
  });
}

/**
 * Reads an engine path as the checkout would build it: the owned file, or
 * the pristine bytes when the path is not owned.
 *
 * @param project - A source-mode project
 * @param pristine - The pinned pristine repository
 * @param path - The engine path
 * @returns The bytes, or undefined when the path is absent or deleted by a record
 */
export async function readSourceFile(
  project: SourceProject,
  pristine: Pristine,
  path: string
): Promise<Buffer | undefined> {
  const located = locate(project, path);
  const owned = await readBytesIfExists(located.file);
  if (owned !== undefined) return owned;
  if ((await readRecordAt(located.record))?.kind === 'delete') return undefined;
  const upstream = await upstreamEntry(pristine, path);
  if (upstream === undefined || upstream === 'other') return undefined;
  return (await readPristineBlobs(pristine, [upstream.blob])).get(upstream.blob);
}

/**
 * Writes an owned file for a helper that edits engine paths. An upstream
 * path must have a current override record first. With `expected`, the
 * write happens only if the file still holds those bytes (null: only if it
 * does not exist), so a helper never overwrites an edit made after it read.
 *
 * @param project - A source-mode project
 * @param pristine - The pinned pristine repository
 * @param path - The engine path
 * @param content - The new bytes
 * @param options - `expected`; `mode` (default: the current mode, else upstream's, else
 *   regular); `tx` makes the write part of the caller's transaction
 * @throws `source-override-required`, `source-file-moved`
 */
export async function writeSourceFile(
  project: SourceProject,
  pristine: Pristine,
  path: string,
  content: Uint8Array,
  options: { expected?: Uint8Array | null; mode?: RegularMode; tx?: Transaction } = {}
): Promise<void> {
  const located = locate(project, path);
  const upstream = await upstreamEntry(pristine, path);
  const upstreamMode = upstream === undefined || upstream === 'other' ? undefined : upstream.mode;
  await withSourceLock(project, async () => {
    if (upstream !== undefined) {
      const record = await readRecordAt(located.record);
      const current =
        upstream !== 'other' &&
        record?.kind === 'override' &&
        record.base.commit === pristine.commit &&
        record.base.blob === upstream.blob;
      if (!current) {
        throw new FireForgeError(
          'source-override-required',
          `${path} is an upstream file without a current override record.`,
          { exitCode: ExitCode.GENERAL_ERROR, hint: `Run "fireforge override ${path}" first.` }
        );
      }
    }
    const existing = await readBytesIfExists(located.file);
    const { expected } = options;
    const matches =
      expected === undefined ||
      (expected === null ? existing === undefined : existing?.equals(expected) === true);
    if (!matches) {
      throw new FireForgeError(
        'source-file-moved',
        `${project.config.source.root}/${path} changed since it was read.`,
        { hint: 'Run the command again.' }
      );
    }
    const mode = options.mode ?? (existing === undefined ? (upstreamMode ?? '100644') : undefined);
    const permissions = mode === undefined ? {} : { mode: mode === '100755' ? 0o755 : 0o644 };
    if (options.tx === undefined) await writeFile(located.file, content, permissions);
    else await options.tx.write(located.file, content, permissions);
  });
}
