// SPDX-License-Identifier: EUPL-1.2
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { GeneralError } from '../../errors/base.js';
import { getNodeErrorCode } from '../../utils/errors.js';
import { validateConfig } from '../config-validate.js';
import { canonicalJson, listSourceTree, sourceGit, sourcePathText } from './git.js';
import { assertNoSourceAliases, assertSourcePath, isReservedRootInput } from './paths.js';
import { requireAuthoredConfig, snapshotFromTree } from './provider.js';
import type {
  AuthoredSnapshot,
  AuthoredSourceConfig,
  CaptureAuthoredOptions,
  CapturedInput,
  SourceFileMode,
} from './types.js';

/** Files that operating systems and editors drop beside source; ignoring them loses nothing. */
const DISPOSABLE_NAME = /^(?:\.DS_Store|Thumbs\.db|desktop\.ini|\._.*|\..*\.swp|.*~)$/;
const ATTEMPTS = 2;

interface WorktreeInput {
  path: string;
  /** Present when the bytes on disk are what the index already holds. */
  indexed?: { blob: string; mode: SourceFileMode };
  /** Present when the bytes must be read: size, mtime and inode detect a concurrent edit. */
  stat?: { mode: SourceFileMode; signature: string };
}

interface WorktreeScan {
  inputs: WorktreeInput[];
  /** Tracked paths differing from HEAD outside the selection. */
  dirtyOutside: string[];
  /** Ignored files named individually by an explicit path. */
  includedIgnored: string[];
}

function nulList(raw: Buffer): string[] {
  return sourcePathText(raw).split('\0').filter(Boolean);
}

/** Tracked paths whose worktree or index differs from HEAD, keyed by path with their XY status. */
async function readStatus(root: string): Promise<Map<string, string>> {
  const raw = await sourceGit(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--no-renames',
    '--untracked-files=no',
    '--ignore-submodules=none',
  ]);
  return new Map(nulList(raw).map((record) => [record.slice(3), record.slice(0, 2)]));
}

async function readWorktreeFile(
  root: string,
  path: string
): Promise<WorktreeInput['stat'] | undefined> {
  await assertNoSourceAliases(root, path);
  let stat;
  try {
    stat = await lstat(join(root, path), { bigint: true });
  } catch (error: unknown) {
    if (['ENOENT', 'ENOTDIR'].includes(getNodeErrorCode(error) ?? '')) return undefined;
    throw error;
  }
  if (!stat.isFile()) throw new GeneralError(`authored-invalid-kind: ${path}`);
  return {
    mode: (stat.mode & 0o111n) !== 0n ? '100755' : '100644',
    signature: `${stat.size}:${stat.mtimeNs}:${stat.ino}`,
  };
}

/** Ignored files under the source roots would pass here and vanish from the commit: refuse them. */
async function assertNothingIgnored(
  root: string,
  sources: AuthoredSourceConfig,
  explicit: ReadonlySet<string>
): Promise<void> {
  const ignored = nulList(
    await sourceGit(root, [
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      '--exclude-standard',
      '--',
      sources.root,
      sources.metadataRoot,
    ])
  ).filter((path) => !DISPOSABLE_NAME.test(basename(path)) && !explicit.has(path));
  if (ignored.length > 0)
    throw new GeneralError(
      `authored-ignored-source: ${ignored.slice(0, 5).join(', ')}${ignored.length > 5 ? ` and ${ignored.length - 5} more` : ''} ${ignored.length === 1 ? 'is' : 'are'} ignored by Git, so a commit would lose ${ignored.length === 1 ? 'it' : 'them'}. Correct .gitignore or delete ${ignored.length === 1 ? 'it' : 'them'}.`
    );
}

/** Enumerate exactly what Git would commit under the selection, without touching the index. */
async function scanWorktree(
  root: string,
  selection: readonly string[],
  sources: AuthoredSourceConfig,
  explicitFiles: readonly string[]
): Promise<WorktreeScan> {
  const status = await readStatus(root);
  const selected = (path: string): boolean =>
    selection.some((entry) => path === entry || path.startsWith(`${entry}/`));
  const dirtyOutside = [...status.keys()].filter((path) => !selected(path)).sort();
  const staged = nulList(
    await sourceGit(root, ['ls-files', '-z', '-v', '--stage', '--', ...selection])
  );
  const untracked = nulList(
    await sourceGit(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...selection])
  );
  const includedIgnored = explicitFiles.length
    ? nulList(
        await sourceGit(root, [
          'ls-files',
          '-z',
          '--others',
          '--ignored',
          '--exclude-standard',
          '--',
          ...explicitFiles,
        ])
      )
    : [];
  await assertNothingIgnored(root, sources, new Set(includedIgnored));
  const inputs = new Map<string, WorktreeInput>();
  for (const record of staged) {
    const match = /^(\S) (\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(record);
    if (!match) throw new GeneralError('authored-invalid-index: unreadable index record');
    const [, tag, mode, blob, stage, path = ''] = match;
    if (stage !== '0') throw new GeneralError(`authored-capture-unmerged: ${path}`);
    if (mode !== '100644' && mode !== '100755')
      throw new GeneralError(`authored-invalid-kind: ${path} has mode ${mode ?? ''}`);
    const worktreeClean = (status.get(path)?.[1] ?? ' ') === ' ';
    if (tag === 'H' && worktreeClean && blob) inputs.set(path, { path, indexed: { blob, mode } });
    else {
      const stat = await readWorktreeFile(root, path);
      inputs.set(path, stat ? { path, stat } : { path });
    }
  }
  for (const path of [...untracked, ...includedIgnored]) {
    const stat = await readWorktreeFile(root, path);
    inputs.set(path, stat ? { path, stat } : { path });
  }
  return {
    inputs: [...inputs.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    dirtyOutside,
    includedIgnored,
  };
}

/** Refuse a source path that committing would rewrite: captured bytes must equal committed bytes. */
async function assertNoTextFilters(
  root: string,
  sources: AuthoredSourceConfig,
  inputs: readonly WorktreeInput[]
): Promise<void> {
  const prefix = `${sources.root}/`;
  const paths = inputs.map((input) => input.path).filter((path) => path.startsWith(prefix));
  if (paths.length === 0) return;
  const attributes = ['text', 'eol', 'filter', 'ident', 'working-tree-encoding'];
  const fields = nulList(
    await sourceGit(
      root,
      ['check-attr', '-z', '--stdin', ...attributes],
      paths.map((path) => `${path}\0`).join('')
    )
  );
  const values = new Map<string, Map<string, string>>();
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const path = fields[index] ?? '';
    const row = values.get(path) ?? new Map<string, string>();
    row.set(fields[index + 1] ?? '', fields[index + 2] ?? '');
    values.set(path, row);
  }
  const specified = (value: string | undefined): boolean =>
    value !== undefined && value !== 'unspecified' && value !== 'unset';
  for (const [path, row] of values) {
    const text = row.get('text');
    if (
      text === 'set' ||
      text === 'auto' ||
      (text === 'unspecified' && specified(row.get('eol'))) ||
      specified(row.get('filter')) ||
      specified(row.get('ident')) ||
      specified(row.get('working-tree-encoding'))
    )
      throw new GeneralError(
        `authored-source-filtered: ${path} has Git text or filter attributes, so committing it could change its bytes. Add "* -text" to ${sources.root}/.gitattributes.`
      );
  }
}

/** Resolve scanned inputs to blobs, hashing only what the index cannot vouch for. */
async function resolveInputs(root: string, scan: WorktreeScan): Promise<CapturedInput[]> {
  const pending = scan.inputs.filter((input) => input.stat);
  const hashes = pending.length
    ? (
        await sourceGit(
          root,
          ['hash-object', '-w', '--stdin-paths'],
          pending.map((input) => JSON.stringify(input.path)).join('\n') + '\n'
        )
      )
        .toString('utf8')
        .trim()
        .split('\n')
    : [];
  const blobs = new Map(pending.map((input, index) => [input.path, hashes[index] ?? '']));
  return scan.inputs.flatMap((input) => {
    if (input.indexed) return [{ path: input.path, ...input.indexed }];
    return input.stat
      ? [{ path: input.path, mode: input.stat.mode, blob: blobs.get(input.path) ?? '' }]
      : [];
  });
}

async function writeCapturedTree(
  root: string,
  head: string,
  baseline: readonly CapturedInput[],
  selection: readonly string[],
  inputs: readonly CapturedInput[],
  objectIdLength: number
): Promise<string> {
  const known = new Map(baseline.map((entry) => [entry.path, entry]));
  const wanted = new Set(inputs.map((input) => input.path));
  const selected = (path: string): boolean =>
    selection.some((entry) => path === entry || path.startsWith(`${entry}/`));
  const records = [
    ...baseline
      .filter((entry) => selected(entry.path) && !wanted.has(entry.path))
      .map((entry) => `0 ${'0'.repeat(objectIdLength)}\t${entry.path}\0`),
    ...inputs
      .filter((input) => {
        const old = known.get(input.path);
        return old?.blob !== input.blob || old.mode !== input.mode;
      })
      .map((input) => `${input.mode} ${input.blob}\t${input.path}\0`),
  ];
  if (records.length === 0) return head;
  const temporary = await mkdtemp(join(tmpdir(), 'fireforge-capture-'));
  try {
    const environment = { GIT_INDEX_FILE: join(temporary, 'index') };
    await sourceGit(root, ['read-tree', head], undefined, environment);
    await sourceGit(root, ['update-index', '-z', '--index-info'], records.join(''), environment);
    return (await sourceGit(root, ['write-tree'], undefined, environment)).toString('utf8').trim();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function explicitFileNotices(scan: WorktreeScan, notice: (message: string) => void): void {
  for (const path of scan.includedIgnored)
    notice(`Including ${path} although Git ignores it, because --path names it.`);
}

/** What every capture selects beside the paths a caller names: the source and metadata roots and the project inputs. */
export function capturedRoots(
  sources: Pick<AuthoredSourceConfig, 'root' | 'metadataRoot'>
): string[] {
  return [
    sources.root,
    sources.metadataRoot,
    'fireforge.json',
    'package.json',
    'package-lock.json',
    'furnace.json',
    'components',
    'configs',
  ];
}

/**
 * Capture the source a commit of this worktree would hold, without moving HEAD, the caller's index
 * or any engine state. The source and metadata roots and the project inputs are always selected;
 * `intendedPaths` adds to them. Paths Git ignores are not inputs, unless named individually.
 */
export async function captureAuthoredSnapshot(
  options: CaptureAuthoredOptions
): Promise<AuthoredSnapshot> {
  const root = resolve(options.projectRoot);
  const config = validateConfig(
    JSON.parse(await readFile(join(root, 'fireforge.json'), 'utf8')) as unknown
  );
  const sources = requireAuthoredConfig(config);
  const intended = options.intendedPaths ?? [];
  const fixedRoots = capturedRoots(sources);
  const selection = [...new Set([...intended, ...fixedRoots])].sort();
  for (const path of selection) {
    assertSourcePath(path);
    if (isReservedRootInput(path)) throw new GeneralError(`authored-reserved-input: ${path}`);
  }
  const explicitFiles: string[] = [];
  for (const path of intended) {
    if (fixedRoots.includes(path)) continue;
    const stat = await lstat(join(root, path)).catch(() => undefined);
    if (stat?.isFile()) explicitFiles.push(path);
  }
  const notice = options.onNotice ?? ((): void => undefined);
  const objectFormat = (await sourceGit(root, ['rev-parse', '--show-object-format']))
    .toString('utf8')
    .trim();
  if (objectFormat !== 'sha1' && objectFormat !== 'sha256')
    throw new GeneralError('authored-invalid-object-format');
  const head = (await sourceGit(root, ['rev-parse', '--verify', 'HEAD^{tree}']))
    .toString('utf8')
    .trim();
  const baseline = await listSourceTree(root, head);
  for (const entry of baseline)
    if (isReservedRootInput(entry.path))
      throw new GeneralError(
        `authored-reserved-input: ${entry.path} is tracked in a directory reserved for runtime state`
      );
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const scan = await scanWorktree(root, selection, sources, explicitFiles);
    if (scan.dirtyOutside.length > 0) {
      const listed = `${scan.dirtyOutside.slice(0, 5).join(', ')}${scan.dirtyOutside.length > 5 ? ` and ${scan.dirtyOutside.length - 5} more` : ''}`;
      if (!options.allowDirtyRoot)
        throw new GeneralError(
          `authored-dirty-input: ${listed} changed but would not be captured. Commit them, name them with --path, or pass --allow-dirty-root to use their committed bytes.`
        );
      notice(`Using committed bytes for changed files outside the selection: ${listed}.`);
    }
    for (const input of scan.inputs) assertSourcePath(input.path);
    await assertNoTextFilters(root, sources, scan.inputs);
    const inputs = await resolveInputs(root, scan);
    const tree = await writeCapturedTree(
      root,
      head,
      baseline,
      selection,
      inputs,
      objectFormat === 'sha1' ? 40 : 64
    );
    const snapshot = await snapshotFromTree(root, tree, {
      ...(options.pristineRepository ? { pristineRepository: options.pristineRepository } : {}),
    });
    const after = await scanWorktree(root, selection, sources, explicitFiles);
    // The captured source root must agree with the configuration which selected it.
    if (
      canonicalJson(after) !== canonicalJson(scan) ||
      canonicalJson(snapshot.config.sources) !== canonicalJson(sources)
    )
      continue;
    explicitFileNotices(scan, notice);
    if (options.retain !== false) {
      // The reflog dates the snapshot for retention, and outlives `git pack-refs`.
      await sourceGit(root, [
        'update-ref',
        '--create-reflog',
        `refs/fireforge/snapshots/${snapshot.id}`,
        snapshot.tree,
      ]);
      if (snapshot.generatedTree)
        await sourceGit(root, [
          'update-ref',
          `refs/fireforge/generated/${snapshot.id}`,
          snapshot.generatedTree,
        ]);
    }
    return snapshot;
  }
  throw new GeneralError(
    'authored-capture-moved: input bytes, modes or configuration changed during capture'
  );
}
