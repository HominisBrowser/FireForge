// SPDX-License-Identifier: EUPL-1.2
import { execFile, spawn } from 'node:child_process';
import { access, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { signalDirectChild } from '../../utils/child-process.js';
import { getNodeErrorCode } from '../../utils/errors.js';
import { authenticateAuthoredSnapshot } from '../authored/index.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { slotGitEnvironment } from './git-tools.js';
import { physicalBytes } from './host-disk.js';
import {
  ARTIFACTS_KEPT_PER_OWNER,
  type CoordinatorConfig,
  DEFAULT_ARTIFACT_MAX_AGE_DAYS,
  DEFAULT_ARTIFACT_MAX_GIB,
  type JobRecord,
  terminal,
} from './schema.js';
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

/** How old a directory no job names must be before it counts as left over. */
const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
const GIB = 1024 ** 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What bounds job artifacts. */
export interface ArtifactBounds {
  /** Most bytes artifacts may occupy before the oldest of finished jobs go. */
  maxBytes: number;
  /** Age past which a finished job's artifacts go. */
  maxAgeMs: number;
  /** The newest finished jobs of each owner that are never pruned. */
  keepPerOwner: number;
}

/** The bounds a configuration states, or the defaults. */
export function artifactBounds(
  config: Pick<CoordinatorConfig, 'artifactMaxGib' | 'artifactMaxAgeDays'>
): ArtifactBounds {
  return {
    maxBytes: (config.artifactMaxGib ?? DEFAULT_ARTIFACT_MAX_GIB) * GIB,
    maxAgeMs: (config.artifactMaxAgeDays ?? DEFAULT_ARTIFACT_MAX_AGE_DAYS) * DAY_MS,
    keepPerOwner: ARTIFACTS_KEPT_PER_OWNER,
  };
}

/** What a prune removed, or would remove. */
export interface ArtifactPrune {
  removed: Array<{ id: string; bytes: number; reason: 'age' | 'size' | 'orphan' }>;
  freedBytes: number;
  /** What artifacts occupy once the removals are done. */
  remainingBytes: number;
}

/**
 * Bounds job artifacts by age and by total size. Only a finished job's artifacts
 * ever go: never a job still queued or running, and never the newest few of
 * each owner. A finished job past the age bound goes first; then, while the
 * total is over the size bound, the oldest of what is left. A directory no
 * job names goes once it is a day old. `jobs` is the journal's replay.
 */
export async function pruneArtifacts(
  namespace: string,
  jobs: ReadonlyMap<string, JobRecord>,
  bounds: ArtifactBounds,
  options: { now?: number; dryRun?: boolean } = {}
): Promise<ArtifactPrune> {
  const now = options.now ?? Date.now();
  const root = join(namespace, 'artifacts');
  const names = await readdir(root).catch(() => [] as string[]);
  const kept = new Set<string>();
  const byOwner = new Map<string, JobRecord[]>();
  for (const job of jobs.values()) {
    if (!terminal(job.state)) continue;
    byOwner.set(job.owner, [...(byOwner.get(job.owner) ?? []), job]);
  }
  for (const finished of byOwner.values())
    for (const job of finished
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, bounds.keepPerOwner))
      kept.add(job.id);
  const entries: Array<{ id: string; bytes: number; at: number; orphan: boolean }> = [];
  let total = 0;
  for (const id of names) {
    const bytes = await physicalBytes(join(root, id));
    total += bytes;
    const job = jobs.get(id);
    if (job === undefined) {
      const modified = await stat(join(root, id)).then(
        (info) => info.mtimeMs,
        () => now
      );
      if (now - modified > ORPHAN_GRACE_MS) entries.push({ id, bytes, at: modified, orphan: true });
    } else if (terminal(job.state) && !kept.has(id))
      entries.push({ id, bytes, at: Date.parse(job.updatedAt), orphan: false });
  }
  entries.sort((a, b) => a.at - b.at);
  const result: ArtifactPrune = { removed: [], freedBytes: 0, remainingBytes: total };
  const remove = async (
    entry: (typeof entries)[number],
    reason: ArtifactPrune['removed'][number]['reason']
  ): Promise<void> => {
    if (options.dryRun !== true) await rm(join(root, entry.id), { recursive: true, force: true });
    result.removed.push({ id: entry.id, bytes: entry.bytes, reason });
    result.freedBytes += entry.bytes;
    result.remainingBytes -= entry.bytes;
  };
  const gone = new Set<string>();
  for (const entry of entries)
    if (entry.orphan || now - entry.at > bounds.maxAgeMs) {
      await remove(entry, entry.orphan ? 'orphan' : 'age');
      gone.add(entry.id);
    }
  for (const entry of entries) {
    if (result.remainingBytes <= bounds.maxBytes) break;
    if (gone.has(entry.id)) continue;
    await remove(entry, 'size');
  }
  return result;
}

/** Bounds artifacts by the configuration, reporting a failure instead of throwing it. */
export async function pruneJobArtifacts(
  namespace: string,
  jobs: ReadonlyMap<string, JobRecord>,
  config: Pick<CoordinatorConfig, 'artifactMaxGib' | 'artifactMaxAgeDays'>,
  fault: (error: unknown) => void
): Promise<void> {
  try {
    await pruneArtifacts(namespace, jobs, artifactBounds(config));
  } catch (error) {
    fault(error);
  }
}
