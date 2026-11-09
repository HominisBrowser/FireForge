// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { getNodeErrorCode } from '../../utils/errors.js';

/** How a process holds a path under a slot. */
export interface SlotHolder {
  /** Whether one of its open files there is open for writing. */
  writes: boolean;
  /** The first path under the slot it was seen holding, for the refusal that names it. */
  held?: string;
}

const inside = (path: string, roots: readonly string[]): boolean =>
  roots.some((root) => path === root || path.startsWith(`${root}/`));

/**
 * Reads `lsof -F` output (fields `p`, `a`, `n`, as `-Fpan` or `-Fpn` asks for)
 * into the processes holding anything under `roots`. An access of `w` or `u`
 * is a write.
 */
export function parseLsofHolders(
  output: string,
  roots: readonly string[]
): Map<number, SlotHolder> {
  let pid = 0;
  let access = '';
  const holders = new Map<number, SlotHolder>();
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('f')) access = '';
    else if (line.startsWith('a')) access = line.slice(1);
    else if (line.startsWith('n') && inside(line.slice(1), roots)) {
      const previous = holders.get(pid);
      const writes = previous?.writes === true || access === 'w' || access === 'u';
      holders.set(pid, { writes, held: previous?.held ?? line.slice(1) });
    }
  }
  return holders;
}

/** procfs reports a removed file's link with this suffix; the path still counts. */
const DELETED = ' (deleted)';

/** The access mode bits of an open file's `fdinfo` flags: 1 is write-only, 2 read-write. */
function opensForWriting(fdinfo: string): boolean {
  const flags = /^flags:\s*([0-7]+)$/m.exec(fdinfo)?.[1];
  return flags !== undefined && (Number.parseInt(flags, 8) & 3) !== 0;
}

/** A link's target, or undefined when the process or the entry has gone or is not ours to read. */
async function target(path: string): Promise<string | undefined> {
  try {
    const value = await readlink(path);
    return value.endsWith(DELETED) ? value.slice(0, -DELETED.length) : value;
  } catch (error) {
    if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(getNodeErrorCode(error) ?? '')) return;
    throw error;
  }
}

/** Entries of a procfs directory: none once the process has gone, undefined when not ours to read. */
async function entries(path: string): Promise<string[] | undefined> {
  try {
    return await readdir(path);
  } catch (error) {
    const code = getNodeErrorCode(error) ?? '';
    if (['ENOENT', 'ESRCH'].includes(code)) return [];
    if (['EACCES', 'EPERM'].includes(code)) return undefined;
    throw error;
  }
}

/**
 * How one process holds anything under `roots`: its working directory, root,
 * executable, a mapped file or an open file. Undefined when it holds nothing
 * there or has gone; `unreadable` when its open files are not ours to list,
 * as for a process that made itself non-dumpable.
 */
async function holderOf(
  directory: string,
  roots: readonly string[]
): Promise<SlotHolder | 'unreadable' | undefined> {
  let held: string | undefined;
  for (const name of ['cwd', 'root', 'exe']) {
    const path = await target(join(directory, name));
    if (path !== undefined && inside(path, roots)) held ??= path;
  }
  const maps = await readFile(join(directory, 'maps'), 'utf8').catch((error: unknown) => {
    if (['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(getNodeErrorCode(error) ?? '')) return '';
    throw error;
  });
  for (const line of maps.split('\n')) {
    const slash = line.indexOf('/');
    if (slash < 0) continue;
    const path = line.slice(slash);
    const mapped = path.endsWith(DELETED) ? path.slice(0, -DELETED.length) : path;
    if (inside(mapped, roots)) held ??= mapped;
  }
  let writes = false;
  const fds = await entries(join(directory, 'fd'));
  if (fds === undefined) return held === undefined ? 'unreadable' : { writes: false, held };
  for (const fd of fds) {
    const path = await target(join(directory, 'fd', fd));
    if (path === undefined || !inside(path, roots)) continue;
    held ??= path;
    const info = await readFile(join(directory, 'fdinfo', fd), 'utf8').catch(() => '');
    if (opensForWriting(info)) writes = true;
  }
  return held === undefined ? undefined : { writes, held };
}

/**
 * The processes holding anything under `roots`, read from procfs: what `lsof`
 * reports, with nothing to install. Without `pids`, every process of this user
 * is read, as `lsof -u` would, and one whose open files are not readable is
 * passed over as `lsof` passes it over. With `pids`, only those are read, and
 * one that exists but cannot be read counts as a holder, since only a positive
 * reading clears it.
 *
 * @param roots - Directories held, each as given and canonical
 * @param options - `pids` to limit the reading; `procRoot` for a fixture
 * @returns Holders by pid, or undefined when this host has no readable procfs
 */
export async function procfsSlotHolders(
  roots: readonly string[],
  options: { pids?: readonly number[]; procRoot?: string } = {}
): Promise<Map<number, SlotHolder> | undefined> {
  const procRoot = options.procRoot ?? '/proc';
  if (options.procRoot === undefined && process.platform !== 'linux') return undefined;
  let listed: string[];
  try {
    listed = await readdir(procRoot);
  } catch {
    return undefined;
  }
  const uid = process.getuid?.();
  const pids = options.pids ?? listed.filter((name) => /^\d+$/.test(name)).map(Number);
  const holders = new Map<number, SlotHolder>();
  await Promise.all(
    pids.map(async (pid) => {
      const directory = join(procRoot, String(pid));
      let owner: number;
      try {
        owner = (await stat(directory)).uid;
      } catch (error) {
        if (['ENOENT', 'ESRCH'].includes(getNodeErrorCode(error) ?? '')) return;
        throw error;
      }
      const named = options.pids !== undefined;
      if (!named && owner !== uid) return;
      const holder = await holderOf(directory, roots);
      // A named process that is not ours to read cannot be cleared.
      if (holder === 'unreadable' || (named && owner !== uid && holder === undefined)) {
        if (named) holders.set(pid, { writes: false });
        return;
      }
      if (holder !== undefined) holders.set(pid, holder);
    })
  );
  return holders;
}

const LSOF = process.platform === 'darwin' ? '/usr/sbin/lsof' : 'lsof';

/**
 * Every process of this user holding anything under `roots`: from procfs where
 * the host has it, from `lsof` otherwise.
 *
 * @param roots - Directories held, each as given and canonical
 * @throws When neither can be read
 */
export async function slotUsers(roots: readonly string[]): Promise<Map<number, SlotHolder>> {
  const holders = await procfsSlotHolders(roots);
  if (holders !== undefined) return holders;
  const { stdout } = await promisify(execFile)(
    LSOF,
    ['-n', '-P', '-Fpan', '-u', String(process.getuid?.())],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }
  );
  return parseLsofHolders(stdout, roots);
}

/**
 * The processes among `pids` holding anything under `roots`. Whatever cannot
 * be established counts as a foothold: only a positive reading lets a process
 * be reported instead of vetoing the phase.
 *
 * @param pids - Processes to read
 * @param roots - Directories held, each as given and canonical
 */
export async function slotFootholds(
  pids: readonly number[],
  roots: readonly string[]
): Promise<Set<number>> {
  return new Set((await slotFootholdHolders(pids, roots)).keys());
}

/**
 * {@link slotFootholds} with how each process holds the slot. One whose
 * reading failed holds it with no path named.
 *
 * @param pids - Processes to read
 * @param roots - Directories held, each as given and canonical
 */
export async function slotFootholdHolders(
  pids: readonly number[],
  roots: readonly string[]
): Promise<Map<number, SlotHolder>> {
  const unknown = (): Map<number, SlotHolder> =>
    new Map(pids.map((pid) => [pid, { writes: false }]));
  let holders: Map<number, SlotHolder> | undefined;
  try {
    holders = await procfsSlotHolders(roots, { pids });
  } catch {
    return unknown();
  }
  if (holders !== undefined) return holders;
  return new Promise((resolve) => {
    execFile(
      LSOF,
      ['-n', '-P', '-Fpn', '-p', pids.join(',')],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        // lsof exits 1 when a listed process has gone, with the rest still printed.
        if (error !== null && (stdout === '' || error.code !== 1)) {
          resolve(error.code === 1 ? new Map() : unknown());
          return;
        }
        resolve(parseLsofHolders(stdout, roots));
      }
    );
  });
}
