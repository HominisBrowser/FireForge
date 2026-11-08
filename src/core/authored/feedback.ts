// SPDX-License-Identifier: EUPL-1.2
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
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

/** Snapshot refs this checkout holds, newest first by the time the ref was written. */
async function snapshotRefs(root: string): Promise<{ id: string; time: number }[]> {
  const common = (await sourceGit(root, ['rev-parse', '--git-common-dir'])).toString('utf8').trim();
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
  const stamped = await Promise.all(
    refs.map(async (id) => {
      const file = join(root, common, 'refs/fireforge/snapshots', id);
      const time = await stat(file).then(
        (value) => value.mtimeMs,
        // A packed ref has no file of its own, and it is at least as old as the last pack.
        () => 0
      );
      return { id, time };
    })
  );
  return stamped.sort((a, b) => b.time - a.time);
}

/**
 * Release retained snapshots beyond the newest `keep`, except those `inUse` names. Git collects
 * their objects later, as for any unreachable object.
 */
export async function pruneSnapshotRefs(options: {
  projectRoot: string;
  keep: number;
  inUse: ReadonlySet<string>;
}): Promise<{ kept: number; removed: string[] }> {
  const refs = await snapshotRefs(options.projectRoot);
  const removable = refs.slice(options.keep).filter(({ id }) => !options.inUse.has(id));
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
  return { kept: refs.length - removable.length, removed: removable.map(({ id }) => id) };
}
