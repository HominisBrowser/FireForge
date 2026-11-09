// SPDX-License-Identifier: EUPL-1.2
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getNodeErrorCode } from '../../utils/errors.js';
import { readSourceBlobs, sourceGit, sourceGitStatus } from './git.js';
import { exportCapturedTree } from './materialize.js';
import type { AuthoredSnapshot } from './types.js';

const VIEW_ROOT = '.fireforge/feedback';
const RETAINED_VIEWS = 4;
/** Formatter inputs at the engine root; the view has no other pristine files. */
const ENGINE_FORMAT_CONFIG =
  /^(?:\.prettierrc(?:\..*)?|\.prettierignore|prettier\.config\..*|\.editorconfig)$/;

async function writeFiles(
  engine: string,
  files: readonly { path: string; bytes: Buffer; executable: boolean }[]
): Promise<void> {
  for (const file of files) {
    const target = join(engine, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
    if (file.executable) await chmod(target, 0o755);
  }
}

/** Upstream's formatter configuration, so formatting rules judge as they would in a slot. */
async function writeEngineFormatConfig(
  engine: string,
  pristineRepository: string,
  commit: string
): Promise<void> {
  const listed = await sourceGitStatus(pristineRepository, ['ls-tree', '-z', commit]);
  if (listed.code !== 0) return;
  const blobs = new Map<string, string>();
  for (const record of listed.stdout.toString('utf8').split('\0')) {
    const match = /^\d+ blob ([a-f0-9]+)\t(.+)$/.exec(record);
    if (match?.[1] && match[2] && ENGINE_FORMAT_CONFIG.test(match[2]))
      blobs.set(match[2], match[1]);
  }
  const bytes = await readSourceBlobs(pristineRepository, [...blobs.values()]);
  await writeFiles(
    engine,
    [...blobs].map(([path, blob]) => ({
      path,
      bytes: bytes.get(blob) ?? Buffer.alloc(0),
      executable: false,
    }))
  );
}

async function pruneViews(base: string, current: string): Promise<void> {
  const names = (await readdir(base)).filter((name) => /^[a-f0-9]{64}$/.test(name));
  const dated = await Promise.all(
    names.map(async (name) => ({ name, time: (await stat(join(base, name))).mtimeMs }))
  );
  const stale = dated
    .filter(({ name }) => name !== current)
    .sort((a, b) => b.time - a.time)
    .slice(RETAINED_VIEWS - 1);
  await Promise.all(
    stale.map(({ name }) => rm(join(base, name), { recursive: true, force: true }))
  );
}

/**
 * A private directory shaped like an execution slot for one snapshot: its captured project inputs,
 * with `engine/` holding its source-owned outputs and no other pristine files. Static gates read
 * only these, so what they judge is what was captured; a view is shared by re-runs of one source.
 */
export async function prepareFeedbackView(options: {
  projectRoot: string;
  snapshot: AuthoredSnapshot;
  pristineRepository: string;
}): Promise<string> {
  const { projectRoot, snapshot, pristineRepository } = options;
  const base = join(projectRoot, VIEW_ROOT);
  const view = join(base, snapshot.id);
  try {
    await lstat(view);
    return view;
  } catch (error: unknown) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
  }
  await mkdir(base, { recursive: true });
  const staging = join(base, `staging-${randomUUID()}`);
  try {
    await exportCapturedTree(snapshot, staging);
    const engine = join(staging, 'engine');
    await mkdir(engine);
    await writeEngineFormatConfig(engine, pristineRepository, snapshot.pin.commit);
    const blobs = await readSourceBlobs(
      snapshot.repository,
      snapshot.files.flatMap((file) => (file.blob ? [file.blob] : []))
    );
    await writeFiles(
      engine,
      snapshot.files.flatMap((file) =>
        file.blob
          ? [
              {
                path: file.path,
                bytes: blobs.get(file.blob) ?? Buffer.alloc(0),
                executable: file.mode === '100755',
              },
            ]
          : []
      )
    );
    // Installed tools are not captured inputs; slots receive theirs the same way.
    if (existsSync(join(projectRoot, 'node_modules')))
      await symlink(join(projectRoot, 'node_modules'), join(staging, 'node_modules'));
    await rename(staging, view).catch((error: unknown) => {
      // Another run of the same source published first; views of one snapshot are identical.
      if (!['ENOTEMPTY', 'EEXIST'].includes(getNodeErrorCode(error) ?? '')) throw error;
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  await pruneViews(base, snapshot.id);
  return view;
}

/** The time of a ref's last update, from its reflog's last entry, or undefined without one. */
async function reflogTime(common: string, ref: string): Promise<number | undefined> {
  const raw = await readFile(join(common, 'logs', ref), 'utf8').catch(() => undefined);
  const last = raw?.trimEnd().split('\n').at(-1);
  // `<old> <new> <name> <email> <unix-seconds> <tz>\t<message>`
  const seconds = last && /> (\d+) [+-]\d{4}(?:\t|$)/u.exec(last)?.[1];
  return seconds ? Number(seconds) * 1000 : undefined;
}

/**
 * Snapshot refs this checkout holds with the time each was written: a loose ref file's mtime, else
 * the last entry of the reflog capture creates. A packed ref with no reflog has no time.
 */
async function snapshotRefs(root: string): Promise<{ id: string; time: number | undefined }[]> {
  // Absolute: a linked worktree's common directory is not under its own root.
  const common = (
    await sourceGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  )
    .toString('utf8')
    .trim();
  const refs = (
    await sourceGit(root, [
      'for-each-ref',
      '--format=%(refname:lstrip=3)',
      'refs/fireforge/snapshots',
    ])
  )
    .toString('utf8')
    .split('\n')
    .filter(Boolean);
  return Promise.all(
    refs.map(async (id) => {
      const ref = `refs/fireforge/snapshots/${id}`;
      // The loose file's mtime has sub-second precision; the reflog dates a packed ref.
      const loose = await stat(join(common, ref)).then(
        (value) => (value.isFile() ? value.mtimeMs : undefined),
        (error: unknown) => {
          if (['ENOENT', 'ENOTDIR'].includes(getNodeErrorCode(error) ?? '')) return undefined;
          throw error;
        }
      );
      const time = loose ?? (await reflogTime(common, ref));
      return { id, time };
    })
  );
}

/**
 * Release retained snapshots beyond the newest `keep`, except those `inUse` names. Git collects
 * their objects later, as for any unreachable object. A snapshot whose age is unknown is never
 * released, and is reported as `undated`; the newest `keep` are counted among the dated ones.
 */
export async function pruneSnapshotRefs(options: {
  projectRoot: string;
  keep: number;
  inUse: ReadonlySet<string>;
}): Promise<{ kept: number; removed: string[]; undated: string[] }> {
  const refs = await snapshotRefs(options.projectRoot);
  const dated = refs
    .flatMap(({ id, time }) => (time === undefined ? [] : [{ id, time }]))
    .sort((a, b) => b.time - a.time || (a.id < b.id ? -1 : 1));
  const undated = refs.filter(({ time }) => time === undefined).map(({ id }) => id);
  const removable = dated.slice(options.keep).filter(({ id }) => !options.inUse.has(id));
  if (removable.length > 0)
    await sourceGit(
      options.projectRoot,
      ['update-ref', '--stdin', '-z'],
      removable
        .flatMap(({ id }) => [
          `delete refs/fireforge/snapshots/${id}\0\0`,
          `delete refs/fireforge/generated/${id}\0\0`,
        ])
        .join('')
    );
  return {
    kept: refs.length - removable.length,
    removed: removable.map(({ id }) => id),
    undated,
  };
}
