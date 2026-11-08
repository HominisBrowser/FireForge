// SPDX-License-Identifier: EUPL-1.2
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

import { GeneralError } from '../../errors/base.js';
import { signalDirectChild } from '../../utils/child-process.js';
import { getNodeErrorCode, toError } from '../../utils/errors.js';
import { hermeticGitEnvironment } from '../git-hermetic.js';
import { qualifiedGitRuntime } from '../qualified-git.js';
import { assertSourceMode } from './paths.js';
import type { CapturedInput, SourceObjectFormat } from './types.js';

const OUTPUT_LIMIT = 512 * 1024 * 1024;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** Full lowercase SHA-1 or SHA-256 object name. */
export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && OBJECT_ID.test(value);
}

const READ_ONLY_COMMANDS = new Set([
  '--version',
  'rev-parse',
  'ls-tree',
  'cat-file',
  'check-attr',
  'diff',
  'diff-tree',
  'for-each-ref',
  'ls-files',
  'show',
  'status',
]);

/** Start Git with caller/global configuration isolated; every source Git call goes through here. */
export async function spawnSourceGit(
  repository: string,
  args: readonly string[],
  extraEnv: Record<string, string> = {}
): Promise<ChildProcessWithoutNullStreams> {
  let commandIndex = 0;
  while (args[commandIndex] === '-c') commandIndex += 2;
  if (
    !READ_ONLY_COMMANDS.has(args[commandIndex] ?? '') &&
    (await realpath(repository).catch(() => repository))
      .split(sep)
      .some((part) => part.toLowerCase() === 'engine')
  ) {
    throw new GeneralError(
      'authored-engine-git-write: Git mutations belong to the root object store or disposable fixtures'
    );
  }
  const qualified = await qualifiedGitRuntime();
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  Object.assign(
    environment,
    hermeticGitEnvironment(),
    { GIT_LITERAL_PATHSPECS: '1' },
    qualified?.environment ?? {},
    extraEnv
  );
  return spawn(
    qualified?.executable ?? 'git',
    [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.safecrlf=false',
      '-c',
      'core.quotePath=false',
      '-c',
      'core.attributesFile=/dev/null',
      ...args,
    ],
    { cwd: repository, env: environment, stdio: ['pipe', 'pipe', 'pipe'] }
  );
}

/** Translate a failed spawn: a missing working directory is what Node reports as "spawn git ENOENT". */
async function sourceGitSpawnError(repository: string, error: unknown): Promise<Error> {
  if (
    getNodeErrorCode(error) === 'ENOENT' &&
    (await stat(repository).then(
      () => false,
      () => true
    ))
  )
    return new GeneralError(`authored-repository-missing: ${repository} does not exist`);
  return toError(error);
}

/** Run Git and report its exit status, for commands whose nonzero status is an answer. */
export async function sourceGitStatus(
  repository: string,
  args: readonly string[],
  input?: Buffer | string,
  extraEnv: Record<string, string> = {}
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  const child = await spawnSourceGit(repository, args, extraEnv);
  return new Promise((accept, reject) => {
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let exceeded = false;
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > OUTPUT_LIMIT) {
        exceeded = true;
        signalDirectChild(child);
      } else output.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errors.reduce((sum, part) => sum + part.length, 0) < 1024 * 1024) errors.push(chunk);
    });
    child.on('error', (error) => {
      void sourceGitSpawnError(repository, error).then(reject);
    });
    child.stdin.on('error', () => {
      /* Exit handling carries Git's diagnostic. */
    });
    child.on('close', (code) => {
      if (exceeded)
        reject(new GeneralError('authored-git-output-limit: incomplete object output refused'));
      else
        accept({
          code: code ?? 255,
          stdout: Buffer.concat(output),
          stderr: Buffer.concat(errors).toString('utf8').trim(),
        });
    });
    child.stdin.end(input);
  });
}

/** Binary-safe Git transport; a nonzero exit is an error. */
export async function sourceGit(
  repository: string,
  args: readonly string[],
  input?: Buffer | string,
  extraEnv: Record<string, string> = {}
): Promise<Buffer> {
  const result = await sourceGitStatus(repository, args, input, extraEnv);
  if (result.code !== 0)
    throw new GeneralError(`authored-git-failed: git ${args[0] ?? ''}: ${result.stderr}`);
  return result.stdout;
}

/** Reject non-UTF-8 path streams rather than silently changing a filename. */
export function sourcePathText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new GeneralError('authored-invalid-path-encoding');
  }
}

/** Construct path-keyed data without inherited names or prototype setters. */
export function sourceRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** Serialize JSON deterministically with keys sorted independently of host locale. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

/** Hash a canonical source description using SHA-256. */
export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** Compute the exact Git blob identity without filters or text conversion. */
export function sourceBlobId(bytes: Buffer, format: SourceObjectFormat): string {
  return createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** One record of a NUL-delimited `git ls-tree -z`. */
export interface SourceTreeRecord {
  mode: string;
  type: string;
  oid: string;
  path: string;
}

/** Parse `git ls-tree -z` output, whatever kinds of entry it holds. */
export function parseSourceTreeRecords(raw: Uint8Array): SourceTreeRecord[] {
  return sourcePathText(raw)
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
      if (!match) throw new GeneralError('authored-invalid-tree: unreadable tree record');
      return {
        mode: match[1] ?? '',
        type: match[2] ?? '',
        oid: match[3] ?? '',
        path: match[4] ?? '',
      };
    });
}

/** Listing stays binary-safe for file content; Git's path stream is NUL delimited. */
export async function listSourceTree(repository: string, tree: string): Promise<CapturedInput[]> {
  if (!isObjectId(tree)) throw new GeneralError('authored-invalid-tree: full object id required');
  const raw = await sourceGit(repository, ['ls-tree', '-r', '-z', '--full-tree', tree]);
  return parseSourceTreeRecords(raw).map(({ mode, type, oid, path }) => {
    if (type !== 'blob') throw new GeneralError(`authored-invalid-tree: non-blob entry ${path}`);
    try {
      assertSourceMode(mode);
    } catch {
      throw new GeneralError(`authored-invalid-mode: ${path} has mode ${mode}`);
    }
    return { path, blob: oid, mode };
  });
}

/** Read and authenticate one immutable Git blob. */
export async function readSourceBlob(repository: string, blob: string): Promise<Buffer> {
  if (!isObjectId(blob)) throw new GeneralError('authored-invalid-object: expected full object id');
  const bytes = await sourceGit(repository, ['cat-file', 'blob', blob]);
  if (sourceBlobId(bytes, blob.length === 40 ? 'sha1' : 'sha256') !== blob)
    throw new GeneralError('authored-object-corrupt: blob hash mismatch');
  return bytes;
}

/** Read binary objects in bounded batches and verify their content identities. */
export async function readSourceBlobs(
  repository: string,
  blobs: readonly string[]
): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  const unique = [...new Set(blobs)];
  for (let start = 0; start < unique.length; start += 256) {
    const batch = unique.slice(start, start + 256);
    if (!batch.every(isObjectId)) throw new GeneralError('authored-invalid-object');
    const raw = await sourceGit(repository, ['cat-file', '--batch'], batch.join('\n') + '\n');
    let cursor = 0;
    for (const blob of batch) {
      const end = raw.indexOf(10, cursor);
      if (end < 0) throw new GeneralError('authored-object-incomplete');
      const header = raw.subarray(cursor, end).toString('ascii').split(' ');
      const size = Number(header[2]);
      if (
        header[0] !== blob ||
        header[1] !== 'blob' ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        end + 1 + size >= raw.length
      ) {
        throw new GeneralError(`authored-object-unavailable: ${blob}`);
      }
      const bytes = raw.subarray(end + 1, end + 1 + size);
      if (sourceBlobId(bytes, blob.length === 40 ? 'sha1' : 'sha256') !== blob)
        throw new GeneralError(`authored-object-corrupt: ${blob}`);
      result.set(blob, bytes);
      cursor = end + size + 2;
    }
    if (cursor !== raw.length) throw new GeneralError('authored-object-incomplete');
  }
  return result;
}

/** Check the whole captured blob closure without rereading every payload on each authentication. */
export async function assertSourceObjectsAvailable(
  repository: string,
  blobs: readonly string[]
): Promise<void> {
  const unique = [...new Set(blobs)];
  if (!unique.every(isObjectId)) throw new GeneralError('authored-invalid-object');
  if (unique.length === 0) return;
  const rows = (
    await sourceGit(
      repository,
      ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      unique.join('\n') + '\n'
    )
  )
    .toString('ascii')
    .trimEnd()
    .split('\n');
  if (
    rows.length !== unique.length ||
    rows.some((row, index) => row !== `${unique[index] ?? ''} blob`)
  )
    throw new GeneralError('authored-object-unavailable: captured blob closure is incomplete');
}

/** Text that Git can merge and diff: no NUL bytes, valid UTF-8. */
export function isSourceText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Store exact bytes as blobs, unfiltered, returning their ids in input order. */
export async function storeSourceBlobs(
  repository: string,
  contents: readonly Buffer[]
): Promise<string[]> {
  if (contents.length === 0) return [];
  const temporary = await mkdtemp(join(tmpdir(), 'fireforge-blobs-'));
  try {
    const paths = contents.map((_, index) => join(temporary, String(index)));
    for (const [index, path] of paths.entries())
      await writeFile(path, contents[index] ?? Buffer.alloc(0));
    const output = await sourceGit(
      repository,
      ['hash-object', '-w', '--stdin-paths', '--no-filters'],
      paths.map((path) => JSON.stringify(path)).join('\n') + '\n'
    );
    return output.toString('utf8').trim().split('\n');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function isRepository(path: string): boolean {
  return (
    existsSync(join(path, '.git')) ||
    (existsSync(join(path, 'HEAD')) && existsSync(join(path, 'objects')))
  );
}

/** The checkout owning a linked worktree, found from its `.git` file; otherwise the root itself. */
function mainCheckoutOf(projectRoot: string): string {
  try {
    const pointer = /^gitdir: (.+)$/m.exec(readFileSync(join(projectRoot, '.git'), 'utf8'))?.[1];
    if (!pointer) return projectRoot;
    const gitDirectory = resolve(projectRoot, pointer);
    const common = readFileSync(join(gitDirectory, 'commondir'), 'utf8').trim();
    return dirname(resolve(gitDirectory, common));
  } catch {
    return projectRoot;
  }
}

/**
 * The pristine object donor: an explicit path, then `FIREFORGE_PRISTINE_REPOSITORY`, then this
 * checkout's `engine/`, then the main checkout's `engine/` when this is a linked worktree. A path
 * that is not itself a repository is refused, so Git discovery cannot climb into the project repo.
 */
export function pristineRepositoryFor(projectRoot: string, explicit?: string): string {
  const configured = explicit ?? process.env['FIREFORGE_PRISTINE_REPOSITORY'];
  const local = join(projectRoot, 'engine');
  const donor =
    configured ?? (isRepository(local) ? local : join(mainCheckoutOf(projectRoot), 'engine'));
  if (!isRepository(donor))
    throw new GeneralError(
      `authored-repository-missing: ${donor} is not a Git repository; set --pristine-repository or FIREFORGE_PRISTINE_REPOSITORY, or create a donor with "fireforge authored pristine fetch"`
    );
  return donor;
}
