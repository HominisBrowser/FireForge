// SPDX-License-Identifier: EUPL-1.2
/**
 * The file primitives the rest of the tree uses instead of `node:fs`. Writes
 * replace their target atomically (temp file in the same directory, then
 * rename), so a reader never sees a half-written file and a write never goes
 * through a symlink or truncates a shared hard link.
 */
import { constants as fsConstants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
  appendFile,
  chmod,
  copyFile as copyFileRaw,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  statfs,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { errnoCode, ExitCode, FireForgeError, toError } from './errors.js';
import { randomId } from './hash.js';
import { run } from './process/index.js';
import { sleep } from './time.js';

/** What a path is, without following a final symlink. */
export type PathKind = 'file' | 'directory' | 'symlink' | 'other';

/** The facts about a path that callers branch on. */
export interface PathInfo {
  kind: PathKind;
  size: number;
  /** Permission bits only (`0o755`). */
  mode: number;
  mtimeMs: number;
  /** When the inode last changed: a write, a rename onto it, a mode change. */
  ctimeMs: number;
  /** The inode number; a file replaced by another has a different one. */
  ino: number;
}

/** One directory entry. */
export interface DirEntry {
  name: string;
  kind: PathKind;
}

const ABSENT = new Set(['ENOENT', 'ENOTDIR']);

function kindOf(entry: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): PathKind {
  if (entry.isSymbolicLink()) return 'symlink';
  if (entry.isFile()) return 'file';
  return entry.isDirectory() ? 'directory' : 'other';
}

/**
 * Describes a path, or returns undefined when nothing is there. A symlink is
 * reported as a symlink, never followed.
 *
 * @param path - The path
 */
export async function pathInfo(path: string): Promise<PathInfo | undefined> {
  try {
    const stat = await lstat(path);
    return {
      kind: kindOf(stat),
      size: stat.size,
      mode: stat.mode & 0o7777,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      ino: stat.ino,
    };
  } catch (error: unknown) {
    if (ABSENT.has(errnoCode(error) ?? '')) return undefined;
    throw error;
  }
}

/**
 * Whether something exists at `path` (a dangling symlink counts). Any failure
 * other than absence is thrown, so a permission problem never reads as "no".
 *
 * @param path - The path
 */
export async function exists(path: string): Promise<boolean> {
  return (await pathInfo(path)) !== undefined;
}

/**
 * Reads a file as UTF-8.
 *
 * @param path - The file
 */
export function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

/**
 * Reads a file's bytes.
 *
 * @param path - The file
 */
export function readBytes(path: string): Promise<Buffer> {
  return readFile(path);
}

async function absentAsUndefined<T>(read: Promise<T>): Promise<T | undefined> {
  try {
    return await read;
  } catch (error: unknown) {
    if (ABSENT.has(errnoCode(error) ?? '')) return undefined;
    throw error;
  }
}

/**
 * Reads a file as UTF-8, or returns undefined when it does not exist.
 *
 * @param path - The file
 */
export function readTextIfExists(path: string): Promise<string | undefined> {
  return absentAsUndefined(readFile(path, 'utf8'));
}

/**
 * Reads a file's bytes, or returns undefined when it does not exist.
 *
 * @param path - The file
 */
export function readBytesIfExists(path: string): Promise<Buffer | undefined> {
  return absentAsUndefined(readFile(path));
}

/**
 * Creates a directory and its parents.
 *
 * @param path - The directory
 */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

const RETRIABLE = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES']);

async function withRetries<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      if (attempt >= 5 || !RETRIABLE.has(errnoCode(error) ?? '')) throw error;
      await sleep(40 * attempt);
    }
  }
}

/**
 * Removes a file or a whole directory tree. Absence is not an error.
 *
 * @param path - What to remove
 */
export async function remove(path: string): Promise<void> {
  await withRetries(() => rm(path, { recursive: true, force: true }));
}

/**
 * Renames a path, retrying the transient sharing violations some platforms
 * report while another process briefly holds the target.
 *
 * @param from - The existing path
 * @param to - The new path, replaced if it exists
 */
export async function move(from: string, to: string): Promise<void> {
  await withRetries(() => rename(from, to));
}

const TEMP_MARKER = '.fireforge-tmp-';

/**
 * Matches the temp files atomic writes create, anywhere in a forward-slash
 * path, so a listing can leave out a write that is mid-flight.
 */
export const TEMP_PATH_PATTERN = /(^|\/)\.[^/]+\.fireforge-tmp-\d+-[0-9a-f-]{36}$/i;

/**
 * A unique sibling path for staging a replacement of `target`. The same
 * directory keeps the final rename atomic.
 *
 * @param target - The path that will be replaced
 */
export function tempPathFor(target: string): string {
  return join(dirname(target), `.${basename(target)}${TEMP_MARKER}${process.pid}-${randomId()}`);
}

/**
 * Creates a fresh temporary directory.
 *
 * @param prefix - Name prefix
 * @param parent - Where to create it; the system temp directory by default
 */
export async function makeTempDir(prefix: string, parent: string = tmpdir()): Promise<string> {
  await ensureDir(parent);
  return mkdtemp(join(parent, prefix));
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch {
    // Not every filesystem can open or sync a directory. The write stands.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Flushes paths to stable storage: each existing file's content, and each
 * directory's entries (so a rename or removal inside it survives a power
 * loss). Absent paths are skipped. A file that cannot be flushed is an error;
 * a directory the filesystem cannot sync is not.
 *
 * @param files - Files whose content must be durable
 * @param directories - Directories whose entries must be durable
 */
export async function syncToDisk(
  files: Iterable<string>,
  directories: Iterable<string>
): Promise<void> {
  for (const path of new Set(files)) {
    if ((await pathInfo(path))?.kind !== 'file') continue;
    // Windows flushes only through a handle that may write.
    const handle = await open(path, process.platform === 'win32' ? 'r+' : 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  for (const path of new Set(directories)) await syncDirectory(path);
}

/** How {@link writeFile} publishes its content. */
export interface WriteOptions {
  /** Permission bits. Default: the replaced file's, or the process default for a new file. */
  mode?: number;
  /**
   * Flush to stable storage before the rename (default true). Pass false for
   * bulk output that can be regenerated, where a sync per file only costs time.
   */
  durable?: boolean;
}

async function publish(
  target: string,
  fill: (temp: string) => Promise<void>,
  options: WriteOptions
): Promise<void> {
  await ensureDir(dirname(target));
  const mode = options.mode ?? (await pathInfo(target))?.mode;
  const temp = tempPathFor(target);
  try {
    await fill(temp);
    if (mode !== undefined) await chmod(temp, mode);
    await move(temp, target);
  } catch (error: unknown) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  if (options.durable !== false) await syncDirectory(dirname(target));
}

/**
 * Writes a file atomically, creating its parent directories.
 *
 * @param path - The file
 * @param content - Text (as UTF-8) or bytes
 * @param options - See {@link WriteOptions}
 */
export async function writeFile(
  path: string,
  content: string | Uint8Array,
  options: WriteOptions = {}
): Promise<void> {
  await publish(
    path,
    async (temp) => {
      const handle = await open(temp, 'wx');
      try {
        await handle.writeFile(content);
        if (options.durable !== false) await handle.sync();
      } finally {
        await handle.close();
      }
    },
    options
  );
}

/**
 * Writes a file only when its content would change, so an unchanged output
 * keeps its mtime and triggers no rebuild.
 *
 * @param path - The file
 * @param content - Text (as UTF-8) or bytes
 * @param options - See {@link WriteOptions}
 * @returns Whether the file was written
 */
export async function writeFileIfChanged(
  path: string,
  content: string | Uint8Array,
  options: WriteOptions = {}
): Promise<boolean> {
  const current = await readBytesIfExists(path);
  if (current?.equals(typeof content === 'string' ? Buffer.from(content) : content) === true) {
    return false;
  }
  await writeFile(path, content, options);
  return true;
}

/**
 * Writes a stream of chunks to a file atomically: the target appears only
 * once the stream has ended without error.
 *
 * @param path - The file
 * @param chunks - The content
 * @returns The number of bytes written
 */
export async function writeFileFromStream(
  path: string,
  chunks: AsyncIterable<Uint8Array>
): Promise<number> {
  let bytes = 0;
  await publish(
    path,
    async (temp) => {
      const handle = await open(temp, 'wx');
      try {
        for await (const chunk of chunks) {
          await handle.write(chunk);
          bytes += chunk.byteLength;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    {}
  );
  return bytes;
}

/**
 * Appends text to a file, creating it and its parent directories.
 *
 * @param path - The file
 * @param text - What to append
 */
export async function appendText(path: string, text: string): Promise<void> {
  await ensureDir(dirname(path));
  await appendFile(path, text, 'utf8');
}

/**
 * Sets a path's permission bits.
 *
 * @param path - The path
 * @param mode - Permission bits
 */
export async function setMode(path: string, mode: number): Promise<void> {
  await chmod(path, mode);
}

/**
 * Copies one file atomically, as a copy-on-write clone where the filesystem
 * offers one.
 *
 * @param source - The file to copy
 * @param target - Where the copy goes
 * @param options - `mode` sets the copy's permission bits (default: the
 *   source's); `durable` as for {@link writeFile}, default false
 */
export async function copyFile(
  source: string,
  target: string,
  options: WriteOptions = {}
): Promise<void> {
  const mode = options.mode ?? (await lstat(source)).mode & 0o7777;
  await publish(
    target,
    async (temp) => {
      await copyFileRaw(source, temp, fsConstants.COPYFILE_FICLONE);
      if (options.durable === true) await syncToDisk([temp], []);
    },
    { mode, durable: options.durable === true }
  );
}

/**
 * The target of a symlink, exactly as stored (it may be relative).
 *
 * @param path - The symlink
 */
export function readLink(path: string): Promise<string> {
  return readlink(path);
}

/**
 * Creates a symlink, replacing whatever file or link is at `path` atomically.
 *
 * @param path - Where the link goes
 * @param target - What it points at, stored as given
 */
export async function writeLink(path: string, target: string): Promise<void> {
  await ensureDir(dirname(path));
  const temp = tempPathFor(path);
  try {
    await symlink(target, temp);
    await move(temp, path);
  } catch (error: unknown) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Lists a directory, sorted by name. A missing directory lists as empty.
 *
 * @param path - The directory
 */
export async function listDir(path: string): Promise<DirEntry[]> {
  const entries = await absentAsUndefined(readdir(path, { withFileTypes: true }));
  return (entries ?? [])
    .map((entry) => ({ name: entry.name, kind: kindOf(entry) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Lists every file under a directory as sorted forward-slash relative paths.
 * Symlinks are listed, never followed, so the walk cannot leave the tree.
 *
 * @param root - The directory; a missing one lists as empty
 * @param skip - Returns true for a relative path (file or directory) to leave out
 */
export async function walkFiles(
  root: string,
  skip: (relativePath: string, kind: PathKind) => boolean = () => false
): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await listDir(directory)) {
      const path = `${prefix}${entry.name}`;
      if (skip(path, entry.kind)) continue;
      if (entry.kind === 'directory') await visit(join(directory, entry.name), `${path}/`);
      else found.push(path);
    }
  };
  await visit(root, '');
  return found;
}

/**
 * Clones a file or directory tree with the filesystem's copy-on-write support
 * (APFS clones, reflinks), so a multi-gigabyte tree costs neither time nor
 * space until it diverges. Symlinks and permissions are preserved.
 *
 * @param source - What to clone
 * @param target - Where the clone goes; must not exist
 * @param options - `allowCopy` falls back to a full physical copy where the
 *   filesystem cannot clone. Without it that case is refused.
 * @returns How the tree was produced
 */
export async function cloneTree(
  source: string,
  target: string,
  options: { allowCopy?: boolean } = {}
): Promise<'clone' | 'copy'> {
  if (await exists(target)) {
    throw new FireForgeError('clone-target-exists', `Cannot clone onto existing path ${target}`);
  }
  await ensureDir(dirname(target));
  const cloneArgs =
    process.platform === 'darwin'
      ? ['-c', '-R', '-p']
      : process.platform === 'linux'
        ? ['--reflink=always', '-a']
        : undefined;
  let refusal = 'this platform has no copy-on-write clone';
  if (cloneArgs !== undefined) {
    const cloned = await run('cp', [...cloneArgs, source, target]);
    if (cloned.exitCode === 0) return 'clone';
    refusal = cloned.stderr.trim().split('\n').at(-1) ?? `cp exited ${cloned.exitCode}`;
    await remove(target);
  }
  if (options.allowCopy !== true) {
    throw new FireForgeError(
      'clone-unsupported',
      `Cannot clone ${source} copy-on-write: ${refusal}`,
      { hint: 'Use a filesystem with clone support (APFS, Btrfs, XFS), or allow a full copy.' }
    );
  }
  // Windows has no `cp`. Elsewhere `cp` is kept: it carries ownership, times
  // and special files the way a clone would.
  const failure =
    process.platform === 'win32'
      ? await cp(source, target, {
          recursive: true,
          preserveTimestamps: true,
          verbatimSymlinks: true,
          errorOnExist: true,
          force: false,
        }).then(
          () => undefined,
          (error: unknown) => toError(error).message
        )
      : await run('cp', [
          ...(process.platform === 'darwin' ? ['-R', '-p'] : ['-a']),
          source,
          target,
        ]).then((copied) => (copied.exitCode === 0 ? undefined : copied.stderr.trim()));
  if (failure !== undefined) {
    await remove(target);
    throw new FireForgeError('copy-failed', `Copying ${source} failed: ${failure}`);
  }
  return 'copy';
}

/**
 * Bytes available to an unprivileged process on the filesystem holding
 * `path`, or undefined when the platform cannot say.
 *
 * @param path - Any existing path on the filesystem
 */
export async function freeDiskSpace(path: string): Promise<number | undefined> {
  try {
    const stats = await statfs(path);
    return stats.bavail * stats.bsize;
  } catch {
    return undefined;
  }
}

/**
 * Resolves every symlink in a path.
 *
 * @param path - An existing path
 */
export function realPath(path: string): Promise<string> {
  return realpath(path);
}

/**
 * Converts a platform path to forward slashes.
 *
 * @param path - The path
 */
export function toPosixPath(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

/**
 * Whether `candidate` (absolute, or relative to `root`) lies at or under
 * `root`. Lexical: it resolves `..` but reads nothing from disk.
 *
 * @param root - The containing directory
 * @param candidate - The path to test
 */
export function isInside(root: string, candidate: string): boolean {
  if (candidate.includes('\0')) return false;
  const base = resolve(root);
  const offset = relative(base, resolve(base, candidate));
  return (
    offset === '' || (offset !== '..' && !offset.startsWith(`..${sep}`) && !isAbsolute(offset))
  );
}

function escapeError(root: string, candidate: string, why: string): FireForgeError {
  return new FireForgeError('path-escape', `Path "${candidate}" ${why} ${root}`, {
    exitCode: ExitCode.INVALID_ARGUMENT,
  });
}

/**
 * Resolves `candidate` against `root`, refusing a path that leaves it.
 * Lexical only; use {@link resolveContained} before writing through a path
 * that came from outside.
 *
 * @param root - The containing directory
 * @param candidate - Absolute, or relative to `root`
 * @returns The absolute path
 */
export function resolveInside(root: string, candidate: string): string {
  if (!isInside(root, candidate)) throw escapeError(root, candidate, 'is outside');
  return resolve(root, candidate);
}

/**
 * {@link resolveInside}, and additionally refuses a path any existing
 * component of which, below `root`, is a symlink. A link could point outside
 * the root or alias another path inside it, and either makes a write land
 * somewhere other than the path names.
 *
 * @param root - The containing directory
 * @param candidate - Absolute, or relative to `root`
 * @returns The absolute path, which need not exist
 */
export async function resolveContained(root: string, candidate: string): Promise<string> {
  const target = resolveInside(root, candidate);
  let current = resolve(root);
  for (const segment of relative(current, target).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const info = await pathInfo(current);
    if (info === undefined) break;
    if (info.kind === 'symlink') throw escapeError(root, candidate, 'passes through a symlink in');
  }
  return target;
}
