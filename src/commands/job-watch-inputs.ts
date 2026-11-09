// SPDX-License-Identifier: EUPL-1.2
/**
 * What `job watch` watches: the paths a capture selects, and nothing else, so
 * a build writing to `engine/` or an object directory never wakes it. Each
 * directory in the selection gets a recursive watch, from Watchman when it
 * answers and from Node's recursive `fs.watch` otherwise. Each selected
 * path's parent gets a plain directory watch, which sees the top-level project
 * files and a selected directory that appears later.
 */
import { spawn } from 'node:child_process';
import { type FSWatcher, watch as fsWatch } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join, posix, sep } from 'node:path';

import { sourceGitStatus, sourcePathText } from '../core/authored/git.js';
import { getNodeErrorCode, toError } from '../utils/errors.js';
import { exec, findExecutable } from '../utils/process.js';

/** Where changes go, as project-relative paths with `/` separators. */
export interface WatchTarget {
  projectRoot: string;
  /** Project-relative paths a capture selects: directories and files, present or not. */
  selection: readonly string[];
  onChange: (paths: readonly string[]) => void;
  onError: (error: Error) => void;
}

/** An armed watch. */
export interface InputWatch {
  /** What delivers the changes, for the operator. */
  backend: string;
  close: () => void;
}

/** Arms a watch over a selection. Tests pass their own, so nothing waits on the OS. */
export type InputWatcher = (target: WatchTarget) => Promise<InputWatch>;

/** A recursive watch on one selected directory. Resolves once changes are being delivered. */
type RecursiveWatch = (entry: string, target: WatchTarget) => Promise<() => void>;

const WATCHMAN_TIMEOUT_MS = 10_000;
const SUBSCRIPTION = 'fireforge-job-watch';

/** Files editors and operating systems write beside a save, which never change what a capture means. */
const EDITOR_TEMPORARY =
  /^(?:\.DS_Store|Thumbs\.db|desktop\.ini|4913|\._.*|\..*\.sw[a-p]x?|.*~|\.#.*|#.*#|.*\.(?:tmp|crswap|kate-swp)|.*___jb_(?:tmp|old)___|\.goutputstream-.*)$/;

const toPosix = (path: string): string => path.split(sep).join('/');

/** Node's recursive watch: FSEvents on darwin, ReadDirectoryChangesW on win32, one inotify watch per directory on linux. */
const fsRecursive: RecursiveWatch = (entry, target) => {
  const watcher = fsWatch(join(target.projectRoot, entry), { recursive: true }, (_event, name) => {
    target.onChange([name === null ? entry : `${entry}/${toPosix(name)}`]);
  });
  watcher.on('error', (error) => {
    target.onError(error);
  });
  return Promise.resolve(() => {
    watcher.close();
  });
};

interface WatchmanReply {
  error?: string;
  watch?: string;
  relative_path?: string;
  subscribe?: string;
  subscription?: string;
  is_fresh_instance?: boolean;
  files?: unknown[];
}

/** A Watchman subscription on one directory, through its persistent JSON command line. */
function watchmanRecursive(binary: string): RecursiveWatch {
  return async (entry, target) => {
    const absolute = join(target.projectRoot, entry);
    const result = await exec(binary, ['--no-pretty', 'watch', absolute], {
      timeout: WATCHMAN_TIMEOUT_MS,
    });
    let watched: WatchmanReply = {};
    try {
      watched = JSON.parse(result.stdout) as WatchmanReply;
    } catch {
      // The exit code and stderr say what went wrong.
    }
    if (result.exitCode !== 0 || watched.watch === undefined)
      throw new Error(
        watched.error ?? (result.stderr.trim() || `watchman watch exited ${result.exitCode}`)
      );
    const child = spawn(binary, ['--no-pretty', '-j', '-p'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let closing = false;
    let held = '';
    return new Promise((accept, reject) => {
      let subscribed = false;
      const fail = (error: Error): void => {
        if (closing) return;
        if (subscribed) target.onError(error);
        else {
          closing = true;
          child.kill();
          reject(error);
        }
      };
      const timer = setTimeout(() => {
        fail(new Error(`watchman did not subscribe within ${WATCHMAN_TIMEOUT_MS}ms`));
      }, WATCHMAN_TIMEOUT_MS);
      const pdu = (line: string): void => {
        let reply: WatchmanReply;
        try {
          reply = JSON.parse(line) as WatchmanReply;
        } catch {
          return;
        }
        if (reply.error !== undefined) fail(new Error(`watchman: ${reply.error}`));
        else if (reply.subscribe === SUBSCRIPTION && !subscribed) {
          subscribed = true;
          clearTimeout(timer);
          accept(() => {
            closing = true;
            child.kill();
          });
        } else if (reply.subscription === SUBSCRIPTION && reply.is_fresh_instance !== true)
          target.onChange(
            (reply.files ?? [])
              .filter((name): name is string => typeof name === 'string')
              .map((name) => `${entry}/${name}`)
          );
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (text: string) => {
        const lines = (held + text).split('\n');
        held = lines.pop() ?? '';
        lines.forEach(pdu);
      });
      child.on('error', fail);
      child.on('exit', (code) => {
        clearTimeout(timer);
        fail(new Error(`watchman exited ${String(code)}`));
      });
      child.stdin.end(
        JSON.stringify([
          'subscribe',
          watched.watch,
          SUBSCRIPTION,
          {
            fields: ['name'],
            empty_on_fresh_instance: true,
            ...(watched.relative_path === undefined
              ? {}
              : { relative_root: watched.relative_path }),
          },
        ])
      );
    });
  };
}

/** Arms every watch a selection needs. On a failure, what was armed is closed again. */
async function armSelection(target: WatchTarget, recursive: RecursiveWatch): Promise<() => void> {
  const closers: Array<() => void> = [];
  let closed = false;
  const close = (): void => {
    closed = true;
    for (const closer of closers.splice(0)) closer();
  };
  const armed = new Set<string>();
  const armDirectory = async (entry: string): Promise<void> => {
    if (armed.has(entry)) return;
    armed.add(entry);
    const closer = await recursive(entry, target);
    if (closed) closer();
    else closers.push(closer);
  };
  const parents = new Map<string, Set<string>>();
  try {
    for (const entry of target.selection) {
      const stat = await lstat(join(target.projectRoot, entry)).catch(() => undefined);
      if (stat?.isDirectory() === true) await armDirectory(entry);
      const parent = posix.dirname(entry);
      parents.set(parent, (parents.get(parent) ?? new Set<string>()).add(entry));
    }
    for (const [parent, entries] of parents) {
      let watcher: FSWatcher;
      try {
        watcher = fsWatch(join(target.projectRoot, parent), (_event, name) => {
          if (name === null) return;
          const entry = parent === '.' ? toPosix(name) : `${parent}/${toPosix(name)}`;
          if (!entries.has(entry)) return;
          target.onChange([entry]);
          // A selected directory that did not exist when the watch began.
          if (!armed.has(entry))
            void lstat(join(target.projectRoot, entry))
              .then(async (stat) => {
                if (stat.isDirectory() && !closed) await armDirectory(entry);
              })
              .catch((error: unknown) => {
                const code = getNodeErrorCode(error);
                if (code !== 'ENOENT' && code !== 'ENOTDIR') target.onError(toError(error));
              });
        });
      } catch {
        // A parent that does not exist holds nothing a capture would select.
        continue;
      }
      watcher.on('error', (error) => {
        target.onError(error);
      });
      closers.push(() => {
        watcher.close();
      });
    }
  } catch (error) {
    close();
    throw error;
  }
  return close;
}

/** Watchman when it is installed and answers, Node's recursive `fs.watch` otherwise. */
export const defaultInputWatcher: InputWatcher = async (target) => {
  const binary = await findExecutable('watchman');
  let fallback = 'fs.watch (no watchman on PATH)';
  if (binary !== undefined) {
    try {
      return {
        backend: `watchman (${binary})`,
        close: await armSelection(target, watchmanRecursive(binary)),
      };
    } catch (error) {
      fallback = `fs.watch (watchman did not answer: ${toError(error).message})`;
    }
  }
  return { backend: fallback, close: await armSelection(target, fsRecursive) };
};

/** Whether a project-relative path is inside the selection. */
const selected = (selection: readonly string[], path: string): boolean =>
  selection.some((entry) => path === entry || path.startsWith(`${entry}/`));

/**
 * The changed paths a capture would read: inside the selection, not an editor's
 * temporary file and not ignored by Git, unless `--path` names the file
 * itself, which a capture then includes. When Git cannot say, every candidate
 * stays, and the capture decides.
 *
 * @returns The paths that warrant a capture
 */
export async function capturedChanges(
  projectRoot: string,
  selection: readonly string[],
  explicit: readonly string[],
  paths: Iterable<string>
): Promise<string[]> {
  const candidates = [...new Set(paths)].filter(
    (path) =>
      selected(selection, path) &&
      !path.split('/').includes('.git') &&
      !EDITOR_TEMPORARY.test(posix.basename(path))
  );
  if (candidates.length === 0) return [];
  const result = await sourceGitStatus(
    projectRoot,
    ['check-ignore', '-z', '--stdin'],
    `${candidates.join('\0')}\0`,
    // check-ignore refuses literal pathspecs, which source Git otherwise sets.
    { GIT_LITERAL_PATHSPECS: '0' }
  ).catch(() => undefined);
  if (result === undefined || (result.code !== 0 && result.code !== 1)) return candidates;
  const ignored = new Set(sourcePathText(result.stdout).split('\0').filter(Boolean));
  return candidates.filter((path) => !ignored.has(path) || explicit.includes(path));
}
