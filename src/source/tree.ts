// SPDX-License-Identifier: EUPL-1.2
/**
 * Reading a checkout's source: the owned files and override records as they
 * are in the working tree (tracked files and untracked files git does not
 * ignore, under the source and metadata roots), judged against the pristine
 * repository. Every command that reads owned changes starts here; nothing is
 * captured or retained, so two clean checkouts of one commit read the same.
 *
 * The result is the set of owned entries plus every problem found. A
 * blocking problem leaves a path's owned content undefined (a link, a case
 * collision, an unreadable record), so its path is not an entry and
 * materialization and export refuse; the other problems (an undeclared
 * edit, a stale record) are reported by `status` and `verify` while the
 * entry still has a definite meaning.
 */
import { basename, join, relative } from 'node:path';

import { checkAttributes, listFiles, listTree, status, type TreeEntry } from '../git/index.js';
import { ExitCode, FireForgeError, toError } from '../kernel/errors.js';
import { pathInfo, toPosixPath } from '../kernel/fs.js';
import { readJsonIfExists } from '../kernel/json.js';
import { mapLimit } from '../kernel/time.js';
import type { SourceProject } from '../project/index.js';
import {
  ancestorsOf,
  compareText,
  defaultComponent,
  enginePathProblem,
  foldCase,
  type OverrideRecord,
  overrideRecordSchema,
  type Pristine,
  type RegularMode,
  unownableReason,
} from './records.js';

/** Where the source lives inside the git checkout. */
export interface Layout {
  /** The checkout's top directory. */
  readonly worktree: string;
  /** The source root, relative to the worktree. */
  readonly source: string;
  /** The metadata root, relative to the worktree. */
  readonly metadata: string;
}

/** An owned file in the working tree. */
export interface OwnedFile {
  readonly absolute: string;
  readonly mode: RegularMode;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly ino: number;
}

/** One engine path the checkout owns. */
export interface SourceEntry {
  readonly path: string;
  /** `create`: absent upstream; `modify`: an upstream file replaced; `delete`: a tombstone. */
  readonly kind: 'create' | 'modify' | 'delete';
  /** The record's component, or the path's top directory. */
  readonly component: string;
  /** Absent for a created file and for an undeclared edit. */
  readonly record?: OverrideRecord;
  /** The pristine blob at the pinned commit; present unless `create`. */
  readonly upstream?: { readonly blob: string; readonly mode: RegularMode };
  /** The owned file; present unless `delete`. */
  readonly file?: OwnedFile;
}

/** What a problem is about. */
export type SourceProblemKind =
  | 'undeclared'
  | 'stale'
  | 'orphaned'
  | 'adr-missing'
  | 'ignored'
  | 'filtered'
  | 'unmerged'
  | 'tombstone-has-file'
  | 'case-collision'
  | 'unsupported-kind'
  | 'path-conflict'
  | 'invalid-path'
  | 'invalid-record';

/** Something in the checkout's source that is not as source mode requires. */
export interface SourceProblem {
  readonly kind: SourceProblemKind;
  /** The engine path, or the project-relative file when it maps to none. */
  readonly path: string;
  readonly message: string;
  /** What to do about it. */
  readonly hint: string;
  /** The path's owned content is undefined: materialization and export refuse. */
  readonly blocking: boolean;
}

/** The checkout's source, read and judged. */
export interface SourceTree {
  readonly project: SourceProject;
  readonly pristine: Pristine;
  readonly layout: Layout;
  /** Owned entries by path. */
  readonly entries: readonly SourceEntry[];
  readonly problems: readonly SourceProblem[];
}

const BLOCKING = new Set<SourceProblemKind>([
  'unmerged',
  'tombstone-has-file',
  'case-collision',
  'unsupported-kind',
  'path-conflict',
  'invalid-path',
  'invalid-record',
]);

/** Files read at once. */
const READ_CONCURRENCY = 32;

/** Files operating systems and editors drop beside source; ignoring them loses nothing. */
const DISPOSABLE = /^(?:\.DS_Store|Thumbs\.db|desktop\.ini|\._.*|\..*\.swp|.*~)$/;

/** Attributes that make git commit other bytes than the working tree holds. */
const FILTERING_ATTRIBUTES = ['text', 'eol', 'filter', 'ident', 'working-tree-encoding'];

/** Files at the top of the source root that configure git for it, not the engine. */
const SOURCE_CONTROL_FILES = new Set(['.gitattributes', '.gitignore']);

function problem(
  kind: SourceProblemKind,
  path: string,
  message: string,
  hint: string
): SourceProblem {
  return { kind, path, message, hint, blocking: BLOCKING.has(kind) };
}

/**
 * Where the project's source lives in its git checkout.
 *
 * @param project - A source-mode project
 * @throws `source-not-in-git` (exit code 4) when the project is not in a git checkout
 */
export function layoutOf(project: SourceProject): Layout {
  const worktree = project.checkout.worktree;
  if (worktree === undefined) {
    throw new FireForgeError(
      'source-not-in-git',
      `${project.root} is not in a git checkout; source mode keeps owned files as tracked files.`,
      { exitCode: ExitCode.GIT_ERROR, hint: 'Run "git init" in the project.' }
    );
  }
  const prefix = toPosixPath(relative(worktree, project.root));
  const inside = (directory: string): string =>
    prefix === '' ? directory : `${prefix}/${directory}`;
  return {
    worktree,
    source: inside(project.config.source.root),
    metadata: inside(project.config.source.metadataRoot),
  };
}

/** The worktree-relative file of an override record. */
export function recordFile(layout: Layout, path: string): string {
  return `${layout.metadata}/overrides/${path}.json`;
}

function isUnmerged(entry: { index: string; worktree: string }): boolean {
  const pair = `${entry.index}${entry.worktree}`;
  return pair.includes('U') || pair === 'AA' || pair === 'DD';
}

interface Listing {
  /** Owned files by engine path, worktree-relative. */
  sources: Map<string, string>;
  /** Record files by engine path, worktree-relative. */
  records: Map<string, string>;
  problems: SourceProblem[];
}

/** Lists the source and metadata roots: tracked and untracked files, ignored ones reported. */
async function listRoots(
  layout: Layout,
  projectPrefix: (path: string) => string
): Promise<Listing> {
  const scope = [layout.source, layout.metadata];
  const [tracked, changes, ignored] = await Promise.all([
    listFiles(layout.worktree, { paths: scope }),
    status(layout.worktree, { paths: scope }),
    listFiles(layout.worktree, { which: 'ignored', paths: scope }),
  ]);
  const problems: SourceProblem[] = [];
  for (const path of ignored) {
    if (DISPOSABLE.test(basename(path))) continue;
    problems.push(
      problem(
        'ignored',
        projectPrefix(path),
        'is ignored by git, so it is not owned and a commit would not hold it',
        'Correct .gitignore, or delete the file.'
      )
    );
  }
  const files = new Set(tracked);
  const sources = new Map<string, string>();
  const records = new Map<string, string>();
  const sourcePrefix = `${layout.source}/`;
  const overridesPrefix = `${layout.metadata}/overrides/`;
  // The engine path of an owned file or record, so a problem with it removes that path's entry.
  const enginePathOf = (file: string): string =>
    file.startsWith(sourcePrefix)
      ? file.slice(sourcePrefix.length)
      : file.startsWith(overridesPrefix) && file.endsWith('.json')
        ? file.slice(overridesPrefix.length, -'.json'.length)
        : projectPrefix(file);
  for (const entry of changes) {
    if (entry.index === '?') files.add(entry.path);
    if (isUnmerged(entry)) {
      problems.push(
        problem(
          'unmerged',
          enginePathOf(entry.path),
          'has an unresolved merge conflict',
          'Resolve it and "git add" the file.'
        )
      );
    }
  }
  for (const file of [...files].sort(compareText)) {
    if (file.startsWith(sourcePrefix)) {
      const path = file.slice(sourcePrefix.length);
      if (!SOURCE_CONTROL_FILES.has(path)) sources.set(path, file);
    } else if (file.startsWith(overridesPrefix)) {
      const name = file.slice(overridesPrefix.length);
      if (name.endsWith('.json')) records.set(name.slice(0, -'.json'.length), file);
      else {
        problems.push(
          problem(
            'invalid-record',
            projectPrefix(file),
            'is not an override record (records end in .json)',
            'Move it out of the overrides directory.'
          )
        );
      }
    }
  }
  return { sources, records, problems };
}

async function readRecord(
  layout: Layout,
  file: string
): Promise<OverrideRecord | { error: string } | undefined> {
  try {
    return await readJsonIfExists(join(layout.worktree, file), overrideRecordSchema);
  } catch (error: unknown) {
    return { error: toError(error).message };
  }
}

interface Inventory {
  files: Map<string, OwnedFile>;
  records: Map<string, OverrideRecord>;
  blocked: Set<string>;
}

/** Reads the owned files' kinds and modes and parses every record. */
async function readInventory(
  layout: Layout,
  listing: Listing,
  problems: SourceProblem[]
): Promise<Inventory> {
  const files = new Map<string, OwnedFile>();
  const records = new Map<string, OverrideRecord>();
  const blocked = new Set<string>();
  const block = (entry: SourceProblem): void => {
    problems.push(entry);
    blocked.add(entry.path);
  };
  await mapLimit([...listing.sources], READ_CONCURRENCY, async ([path, file]) => {
    const pathError = enginePathProblem(path) ?? unownableReason(path);
    if (pathError !== undefined) {
      block(problem('invalid-path', path, pathError, 'Rename or remove the file.'));
      return;
    }
    const absolute = join(layout.worktree, file);
    const info = await pathInfo(absolute);
    if (info === undefined) return;
    if (info.kind !== 'file') {
      block(
        problem(
          'unsupported-kind',
          path,
          `is a ${info.kind === 'directory' ? 'submodule or directory' : info.kind}; only regular files can be owned`,
          'Replace it with a regular file, or remove it.'
        )
      );
      return;
    }
    const mode = (info.mode & 0o111) !== 0 ? '100755' : '100644';
    files.set(path, {
      absolute,
      mode,
      size: info.size,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
      ino: info.ino,
    });
  });
  await mapLimit([...listing.records], READ_CONCURRENCY, async ([path, file]) => {
    const pathError = enginePathProblem(path) ?? unownableReason(path);
    const record =
      pathError === undefined
        ? await readRecord(layout, file)
        : { error: `names an engine path that ${pathError}` };
    if (record === undefined) return;
    if ('error' in record) {
      block(problem('invalid-record', path, record.error, `Correct or remove ${file}.`));
      return;
    }
    records.set(path, record);
  });
  const folded = new Map<string, string>();
  for (const path of [...new Set([...files.keys(), ...records.keys()])].sort(compareText)) {
    const key = foldCase(path);
    const other = folded.get(key);
    if (other !== undefined && other !== path) {
      for (const each of [other, path]) {
        block(
          problem(
            'case-collision',
            each,
            `collides with ${each === path ? other : path} on a case-insensitive file system`,
            'Rename one of them.'
          )
        );
      }
    } else folded.set(key, path);
  }
  return { files, records, blocked };
}

/** The pristine entries of the given paths and their ancestors. */
async function pristineEntries(
  pristine: Pristine,
  paths: readonly string[]
): Promise<Map<string, TreeEntry>> {
  const wanted = new Set(paths);
  for (const path of paths) for (const ancestor of ancestorsOf(path)) wanted.add(ancestor);
  if (wanted.size === 0) return new Map();
  const entries = await listTree(pristine.repo, pristine.commit, {
    paths: [...wanted],
    recursive: false,
  });
  return new Map(entries.map((entry) => [entry.path, entry]));
}

function regularMode(entry: TreeEntry | undefined): RegularMode | undefined {
  return entry?.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755')
    ? entry.mode
    : undefined;
}

interface Judged {
  entry?: SourceEntry;
  problems: SourceProblem[];
}

/** One path's entry and problems, from its owned file, its record and its pristine entry. */
function judgePath(
  path: string,
  inventory: Inventory,
  upstreamOf: (path: string) => TreeEntry | undefined,
  pristine: Pristine
): Judged {
  const file = inventory.files.get(path);
  const record = inventory.records.get(path);
  const found = upstreamOf(path);
  const mode = regularMode(found);
  const upstream =
    found !== undefined && mode !== undefined ? { blob: found.oid, mode } : undefined;
  const component = record?.component ?? defaultComponent(path);
  if (found !== undefined && upstream === undefined) {
    const what = found.type === 'tree' ? 'a directory' : `an entry of mode ${found.mode}`;
    return {
      problems: [
        problem(
          found.type === 'tree' ? 'path-conflict' : 'unsupported-kind',
          path,
          `is ${what} upstream; only regular upstream files can be overridden`,
          'Move the owned file or record elsewhere.'
        ),
      ],
    };
  }
  if (record === undefined) {
    if (file === undefined) return { problems: [] };
    if (upstream !== undefined) {
      return {
        entry: { path, kind: 'modify', component, upstream, file },
        problems: [
          problem(
            'undeclared',
            path,
            'exists upstream but has no override record',
            `Move the file aside, run "fireforge override ${path}", then reapply the edit.`
          ),
        ],
      };
    }
    const blocker = ancestorsOf(path).find(
      (ancestor) =>
        upstreamOf(ancestor)?.type === 'blob' && inventory.records.get(ancestor)?.kind !== 'delete'
    );
    if (blocker !== undefined) {
      return {
        problems: [
          problem(
            'path-conflict',
            path,
            `cannot be created: upstream has a file at ${blocker}`,
            `Move the file, or delete ${blocker} with "fireforge override --delete ${blocker}".`
          ),
        ],
      };
    }
    return { entry: { path, kind: 'create', component, file }, problems: [] };
  }
  const problems: SourceProblem[] = [];
  if (upstream === undefined) {
    problems.push(
      problem(
        'stale',
        path,
        'has an override record but is no longer upstream',
        file === undefined
          ? `Remove the record with "fireforge restore ${path}".`
          : `Delete its override record to keep the owned file as a created file, or drop both with "fireforge restore ${path}".`
      )
    );
    return file === undefined
      ? { problems }
      : { entry: { path, kind: 'create', component, file }, problems };
  }
  if (
    record.base.commit !== pristine.commit ||
    record.base.blob !== upstream.blob ||
    record.base.mode !== upstream.mode
  ) {
    problems.push(
      problem(
        'stale',
        path,
        'has an override record whose base is not the pinned upstream file',
        'Move the project to its pin with "fireforge rebase", which merges and updates records.'
      )
    );
  }
  if (record.kind === 'delete') {
    if (file !== undefined) {
      return {
        problems: [
          ...problems,
          problem(
            'tombstone-has-file',
            path,
            'is deleted by its record but has an owned file',
            'Delete the owned file to keep the deletion, or set the record\'s "kind" to "override".'
          ),
        ],
      };
    }
    return { entry: { path, kind: 'delete', component, record, upstream }, problems };
  }
  if (file === undefined) {
    problems.push(
      problem(
        'orphaned',
        path,
        'has an override record but no owned file',
        `Restore the file, or remove the record with "fireforge restore ${path}".`
      )
    );
    return { problems };
  }
  return { entry: { path, kind: 'modify', component, record, upstream, file }, problems };
}

/** ADR files records name that do not exist. */
async function missingAdrs(
  project: SourceProject,
  records: ReadonlyMap<string, OverrideRecord>
): Promise<SourceProblem[]> {
  const found: SourceProblem[] = [];
  for (const [path, record] of records) {
    if (record.adr === undefined) continue;
    if ((await pathInfo(join(project.root, record.adr)))?.kind === 'file') continue;
    found.push(
      problem(
        'adr-missing',
        path,
        `names the decision record ${record.adr}, which does not exist`,
        'Add the decision record, or correct "adr" in the override record.'
      )
    );
  }
  return found;
}

/** Owned files whose committed bytes git attributes could change. */
async function filteredFiles(
  layout: Layout,
  entries: readonly SourceEntry[]
): Promise<SourceProblem[]> {
  const byFile = new Map<string, string>(
    entries.flatMap((entry) =>
      entry.file === undefined ? [] : [[`${layout.source}/${entry.path}`, entry.path] as const]
    )
  );
  const attributes = await checkAttributes(
    layout.worktree,
    [...byFile.keys()],
    FILTERING_ATTRIBUTES
  );
  const specified = (value: string | undefined): boolean =>
    value !== undefined && value !== 'unspecified' && value !== 'unset';
  const found: SourceProblem[] = [];
  for (const [file, row] of attributes) {
    const text = row['text'];
    const filtered =
      text === 'set' ||
      text === 'auto' ||
      (text === 'unspecified' && specified(row['eol'])) ||
      ['filter', 'ident', 'working-tree-encoding'].some((name) => specified(row[name]));
    if (!filtered) continue;
    found.push(
      problem(
        'filtered',
        byFile.get(file) ?? file,
        'has git attributes that could change its bytes when committed',
        `Add "* -text" to ${layout.source}/.gitattributes.`
      )
    );
  }
  return found;
}

/**
 * Reads the checkout's owned files and override records and judges them
 * against the pristine repository.
 *
 * @param project - A source-mode project
 * @param pristine - The pinned pristine repository
 */
export async function readSourceTree(
  project: SourceProject,
  pristine: Pristine
): Promise<SourceTree> {
  const layout = layoutOf(project);
  const rootPrefix = toPosixPath(relative(layout.worktree, project.root));
  const projectPath = (path: string): string =>
    rootPrefix === '' ? path : path.slice(rootPrefix.length + 1);
  const listing = await listRoots(layout, projectPath);
  const problems = [...listing.problems];
  const inventory = await readInventory(layout, listing, problems);
  for (const each of listing.problems) if (each.blocking) inventory.blocked.add(each.path);
  const paths = [...new Set([...inventory.files.keys(), ...inventory.records.keys()])]
    .filter((path) => !inventory.blocked.has(path))
    .sort(compareText);
  const upstream = await pristineEntries(pristine, paths);
  const entries: SourceEntry[] = [];
  for (const path of paths) {
    const judged = judgePath(path, inventory, (each) => upstream.get(each), pristine);
    problems.push(...judged.problems);
    if (judged.entry !== undefined && !judged.problems.some((each) => each.blocking)) {
      entries.push(judged.entry);
    }
  }
  problems.push(...(await missingAdrs(project, inventory.records)));
  problems.push(...(await filteredFiles(layout, entries)));
  problems.sort((a, b) => compareText(a.path, b.path) || compareText(a.kind, b.kind));
  return { project, pristine, layout, entries, problems };
}
