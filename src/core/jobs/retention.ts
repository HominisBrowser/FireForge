// SPDX-License-Identifier: EUPL-1.2
import { execFile, spawn } from 'node:child_process';
import { access, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { signalDirectChild } from '../../utils/child-process.js';
import { getNodeErrorCode } from '../../utils/errors.js';
import { authenticateAuthoredSnapshot } from '../authored/index.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { slotGitEnvironment } from './git-tools.js';
import { type JobRecord, terminal } from './schema.js';
import type { SlotRecord } from './slot-types.js';
import { compactJournal, readJson } from './store.js';

const runFile = promisify(execFile);

/** Retain the object closure before acknowledgement; deleting an editor worktree cannot lose a queued job. */
export async function retainSnapshot(
  namespace: string,
  snapshot: AuthoredSnapshot,
  pristineRepository: string
): Promise<AuthoredSnapshot> {
  const repository = join(namespace, `sources-${snapshot.objectFormat}.git`);
  const env = slotGitEnvironment();
  const options = { cwd: namespace, env };
  try {
    await access(join(repository, 'HEAD'));
  } catch (error) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    await runFile(
      'git',
      ['init', '--bare', '--template=', `--object-format=${snapshot.objectFormat}`, repository],
      options
    );
  }
  const pack = spawn('git', ['-C', snapshot.repository, 'pack-objects', '--stdout', '--revs'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const unpack = spawn('git', ['--git-dir', repository, 'index-pack', '--stdin'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  pack.stdin.on('error', () => undefined);
  unpack.stdin.on('error', () => undefined);
  pack.stdout.pipe(unpack.stdin);
  unpack.stdout.resume();
  let diagnostic = '';
  const collect = (chunk: Buffer): void => {
    diagnostic = (diagnostic + chunk.toString()).slice(-4096);
  };
  pack.stderr.on('data', collect);
  unpack.stderr.on('data', collect);
  const completed = (child: typeof pack): Promise<void> =>
    new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Source retention failed: ${diagnostic}`));
      });
    });
  const finished = Promise.all([completed(pack), completed(unpack)]);
  pack.stdin.end(
    `${snapshot.tree}\n${snapshot.generatedTree ? `${snapshot.generatedTree}\n` : ''}`
  );
  try {
    await finished;
  } catch (error) {
    signalDirectChild(pack);
    signalDirectChild(unpack);
    throw error;
  }
  for (const [kind, tree] of [
    ['root', snapshot.tree],
    ['generated', snapshot.generatedTree],
  ] as const)
    if (tree)
      await runFile(
        'git',
        [
          '--git-dir',
          repository,
          'update-ref',
          `refs/fireforge/snapshots/${snapshot.id}/${kind}`,
          tree,
        ],
        options
      );
  return authenticateAuthoredSnapshot({ ...snapshot, repository }, pristineRepository);
}

/** Terminal jobs older than this leave the journal, with their logs and artifacts. */
const JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Compacts the journal to one row per job and forgets terminal jobs past
 * retention, so replay and listing cost follow recent history. A sealed job's
 * receipt file outlives its record. `jobs` is the replayed journal, which loses
 * the forgotten jobs.
 */
export async function compactJobHistory(
  namespace: string,
  jobs: Map<string, JobRecord>,
  now = Date.now()
): Promise<void> {
  for (const [id, job] of jobs) {
    const age = now - Date.parse(job.updatedAt);
    if (!terminal(job.state) || !(age > JOB_RETENTION_MS)) continue;
    jobs.delete(id);
    await rm(join(namespace, 'logs', `${id}.log`), { force: true });
    await rm(join(namespace, 'artifacts', id), { recursive: true, force: true });
  }
  await compactJournal(namespace, jobs.values());
  await pruneSnapshots(namespace, jobs);
}

/** The source ids still needed: every remembered job's, and whatever each slot holds. */
async function sourcesInUse(
  namespace: string,
  jobs: ReadonlyMap<string, JobRecord>
): Promise<Set<string>> {
  const inUse = new Set([...jobs.values()].map((job) => job.request.sourceId));
  for (const name of await readdir(join(namespace, 'slots')).catch(() => [] as string[])) {
    const slot = await readJson<Partial<SlotRecord>>(
      join(namespace, 'slots', name, 'slot.json')
    ).catch(() => undefined);
    if (slot === undefined) return new Set(['*']);
    if (slot.sourceId) inUse.add(slot.sourceId);
  }
  return inUse;
}

/**
 * Releases retained snapshots no job or slot needs, and lets Git collect their
 * objects in the background. A slot whose metadata cannot be read keeps them all.
 */
async function pruneSnapshots(
  namespace: string,
  jobs: ReadonlyMap<string, JobRecord>
): Promise<void> {
  const inUse = await sourcesInUse(namespace, jobs);
  if (inUse.has('*')) return;
  const retained = await readdir(join(namespace, 'snapshots')).catch(() => [] as string[]);
  const released = retained
    .map((name) => name.replace(/\.json$/, ''))
    .filter((id) => !inUse.has(id));
  if (released.length === 0) return;
  const repositories = (await readdir(namespace)).filter((name) => /^sources-.*\.git$/.test(name));
  for (const id of released) {
    await rm(join(namespace, 'snapshots', `${id}.json`), { force: true });
    for (const repository of repositories)
      for (const kind of ['root', 'generated'])
        await runFile('git', [
          '--git-dir',
          join(namespace, repository),
          'update-ref',
          '-d',
          `refs/fireforge/snapshots/${id}/${kind}`,
        ]).catch(() => undefined);
  }
  for (const repository of repositories) {
    const collector = spawn(
      'git',
      ['--git-dir', join(namespace, repository), 'gc', '--auto', '-q'],
      {
        stdio: 'ignore',
        detached: true,
      }
    );
    collector.on('error', () => undefined);
    collector.unref();
  }
}
