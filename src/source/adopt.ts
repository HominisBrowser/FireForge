// SPDX-License-Identifier: EUPL-1.2
/**
 * Adopting a tree: the source half of moving a patch-mode project to source
 * mode. The caller replays the patch queue onto the pristine commit and
 * hands over the resulting tree; this writes the owned files and override
 * records that express the difference: a modified upstream file becomes
 * its postimage plus a record, a deleted one a tombstone record, a new one
 * a created file.
 */
import { join } from 'node:path';

import { changedPaths, listTree, readBlobs, type TreeEntry } from '../git/index.js';
import { defined, ExitCode, FireForgeError } from '../kernel/errors.js';
import { listDir, writeFile } from '../kernel/fs.js';
import { completedAttributes } from './merge.js';
import {
  compareText,
  COMPONENT_PATTERN,
  encodeRecord,
  type OverrideRecord,
  type Pristine,
  unownableReason,
} from './records.js';

/** Where {@link adoptTrees} writes, and who owns each upstream change. */
export interface AdoptOptions {
  /** The directory receiving the overlay, laid out as a project. */
  readonly destination: string;
  /** The source root inside it, such as `src`. */
  readonly sourceRoot: string;
  /** The metadata root inside it. */
  readonly metadataRoot: string;
  /**
   * The component of a changed upstream path, and the decision record when
   * the change is a reviewed exception.
   */
  readonly ownerOf: (path: string) => { readonly component: string; readonly adr?: string };
}

/** What {@link adoptTrees} wrote, by engine path. */
export interface Adopted {
  readonly created: readonly string[];
  readonly overridden: readonly string[];
  readonly deleted: readonly string[];
}

function regular(entry: TreeEntry | undefined, side: string): TreeEntry | undefined {
  if (entry === undefined) return undefined;
  if (entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755')) return entry;
  throw new FireForgeError(
    'adopt-unsupported-kind',
    `${entry.path} is an entry of mode ${entry.mode} in the ${side} tree; source mode owns regular files only.`,
    { exitCode: ExitCode.PATCH_ERROR }
  );
}

async function assertEmpty(directory: string): Promise<void> {
  if ((await listDir(directory)).length > 0) {
    throw new FireForgeError('adopt-destination-not-empty', `${directory} is not empty.`, {
      exitCode: ExitCode.INVALID_ARGUMENT,
      hint: 'Adopt into a new directory.',
    });
  }
}

/**
 * Writes owned files and override records for the difference between the
 * pristine commit and a result tree. Records name `pristine.commit` as
 * their base. The source and metadata roots under the destination must be
 * absent or empty; a failure leaves what was written for the caller to
 * discard.
 *
 * @param pristine - The pinned pristine repository
 * @param result - A tree and a repository holding both it and `pristine.commit`
 * @param options - See {@link AdoptOptions}
 * @throws `adopt-unsupported-kind` for a link or submodule among the changes,
 *   `adopt-unownable-path` for a change source mode cannot own (a `.gitignore`),
 *   `adopt-destination-not-empty`, `source-invalid-component`
 */
export async function adoptTrees(
  pristine: Pristine,
  result: { readonly repo: string; readonly tree: string },
  options: AdoptOptions
): Promise<Adopted> {
  const sourceRoot = join(options.destination, options.sourceRoot);
  const overrides = join(options.destination, options.metadataRoot, 'overrides');
  await assertEmpty(sourceRoot);
  await assertEmpty(join(options.destination, options.metadataRoot));
  const paths = await changedPaths(result.repo, pristine.commit, result.tree);
  const unownable = paths.flatMap((path) => {
    const reason = unownableReason(path);
    return reason === undefined ? [] : [`  ${path} ${reason}`];
  });
  if (unownable.length > 0) {
    throw new FireForgeError(
      'adopt-unownable-path',
      `Source mode cannot own these changed paths:\n${unownable.join('\n')}`,
      {
        exitCode: ExitCode.PATCH_ERROR,
        hint: 'Drop those changes from the patch queue (keep them in a file of the fork itself), then try again.',
      }
    );
  }
  const [before, after] = await Promise.all(
    [pristine.commit, result.tree].map(async (treeish) => {
      const entries = await listTree(result.repo, treeish, { paths, recursive: false });
      return new Map(entries.map((entry) => [entry.path, entry]));
    })
  );
  const wanted = [...(after?.values() ?? [])];
  const contents = await readBlobs(
    result.repo,
    wanted.map((entry) => entry.oid)
  );
  const missing = wanted.find((entry) => entry.type === 'blob' && !contents.has(entry.oid));
  if (missing !== undefined) {
    throw new FireForgeError(
      'adopt-blob-missing',
      `The result tree names ${missing.path}, but its content ${missing.oid} cannot be read from ${result.repo}.`,
      { exitCode: ExitCode.GIT_ERROR }
    );
  }
  const adopted = { created: [] as string[], overridden: [] as string[], deleted: [] as string[] };
  for (const path of [...paths].sort(compareText)) {
    const old = regular(before?.get(path), 'pristine');
    const next = regular(after?.get(path), 'result');
    if (next !== undefined) {
      await writeFile(
        join(sourceRoot, path),
        defined(contents.get(next.oid), () => `the blob of ${path} was read`),
        {
          mode: next.mode === '100755' ? 0o755 : 0o644,
          durable: false,
        }
      );
    }
    if (old === undefined) {
      adopted.created.push(path);
      continue;
    }
    const owner = options.ownerOf(path);
    if (!COMPONENT_PATTERN.test(owner.component)) {
      throw new FireForgeError(
        'source-invalid-component',
        `"${owner.component}" (the component of ${path}) is not a component name.`,
        {
          exitCode: ExitCode.INVALID_ARGUMENT,
          hint: 'Rename the patch so that its first word is a component name: lowercase letters, digits and hyphens.',
        }
      );
    }
    const record: OverrideRecord = {
      kind: next === undefined ? 'delete' : 'override',
      base: { commit: pristine.commit, blob: old.oid, mode: old.mode as '100644' | '100755' },
      component: owner.component,
      classification: owner.adr === undefined ? 'registration' : 'exception',
      ...(owner.adr === undefined ? {} : { adr: owner.adr }),
    };
    await writeFile(join(overrides, `${path}.json`), encodeRecord(record), { durable: false });
    (next === undefined ? adopted.deleted : adopted.overridden).push(path);
  }
  await writeFile(join(sourceRoot, '.gitattributes'), completedAttributes(undefined) ?? '');
  return adopted;
}
