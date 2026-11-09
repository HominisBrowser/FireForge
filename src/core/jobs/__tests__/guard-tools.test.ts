// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getPackageVersion } from '../../../utils/package-root.js';
import { rpc } from '../client.js';
import {
  assertExecutorCommand,
  assertJobAdmission,
  coordinatorNamespace,
  readAdmittedSnapshot,
  trustedSlotBuild,
} from '../guard.js';
import { projectIdentity } from '../guard-project.js';
import { assertProjectToolCompatibility } from '../project-tools.js';
import { slotDirectory } from '../store.js';
import { readJson, writeDurable } from '../store.js';

vi.mock('../client.js', () => ({ rpc: vi.fn() }));
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ff-guard-fixture-'));
  vi.stubEnv('FIREFORGE_COORDINATOR', directory);
  vi.stubEnv('FIREFORGE_JOB_TOKEN', undefined);
  vi.stubEnv('FIREFORGE_JOB_ID', undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  await rm(directory, { recursive: true, force: true });
});
const hash = (bytes: string): string => createHash('sha256').update(bytes).digest('hex');
async function admitted(): Promise<string> {
  const root = join(directory, 'slots', 'a', 'root');
  await mkdir(root, { recursive: true });
  await writeDurable(join(directory, 'config.json'), {});
  await writeDurable(join(directory, 'endpoint.json'), {});
  await writeDurable(join(directory, 'slots', 'a', 'slot.json'), {
    id: 'a',
    root,
    sourceId: 'source',
    generation: 1,
    quarantined: null,
    pristineRepository: 'private-pin',
  });
  await writeDurable(join(directory, 'slots', 'a', 'snapshot.json'), { id: 'source' });
  vi.stubEnv('FIREFORGE_JOB_TOKEN', 'secret');
  vi.stubEnv('FIREFORGE_JOB_ID', 'job');
  vi.stubEnv('FIREFORGE_JOB_PHASE', 'phase');
  vi.mocked(rpc).mockResolvedValue({ root, slot: 'a' });
  return root;
}

describe('live admission and coherent build trust', () => {
  it('permits unconfigured legacy reads but never treats a token/environment as live authority', async () => {
    expect(coordinatorNamespace()).toBe(directory);
    await assertJobAdmission('authored', directory);
    await assertJobAdmission('status', directory);
    expect(await trustedSlotBuild(directory)).toBeUndefined();
    vi.stubEnv('FIREFORGE_COORDINATOR', join(directory, 'absent'));
    vi.stubEnv('FIREFORGE_JOB_TOKEN', 'forged');
    await expect(assertJobAdmission('test', directory)).rejects.toThrow();
    vi.stubEnv('FIREFORGE_COORDINATOR', undefined);
    expect(coordinatorNamespace()).toContain('.fireforge/host/jobs');
  });
  it('lets static work run in a configured checkout, and refuses only what needs host resources', async () => {
    const project = join(directory, 'project');
    await mkdir(join(project, '.git'), { recursive: true });
    await writeDurable(join(directory, 'config.json'), {
      projects: [await projectIdentity(project)],
    });
    vi.stubEnv('FIREFORGE_JOB_TOKEN', undefined);
    for (const command of ['status', 'lint', 'typecheck', 'verify', 'check'])
      await expect(assertJobAdmission(command, project)).resolves.toBeUndefined();
    for (const command of ['build', 'test', 'run', 'package', 'furnace'])
      await expect(assertJobAdmission(command, project)).rejects.toThrow(/coordinated jobs/);
  });
  it('leaves another project on the same host alone', async () => {
    const project = join(directory, 'project');
    const other = join(directory, 'other');
    await mkdir(join(project, '.git'), { recursive: true });
    await mkdir(join(other, '.git'), { recursive: true });
    await writeDurable(join(directory, 'config.json'), {
      projects: [await projectIdentity(project)],
    });
    vi.stubEnv('FIREFORGE_JOB_TOKEN', undefined);
    await expect(assertJobAdmission('build', other)).resolves.toBeUndefined();
  });
  it('treats every worktree of a configured repository as that project', async () => {
    const project = join(directory, 'project');
    const worktree = join(directory, 'worktree');
    await mkdir(join(project, '.git', 'worktrees', 'w'), { recursive: true });
    await mkdir(worktree);
    await writeFile(join(worktree, '.git'), `gitdir: ${join(project, '.git', 'worktrees', 'w')}\n`);
    await writeFile(join(project, '.git', 'worktrees', 'w', 'commondir'), '../..\n');
    expect(await projectIdentity(worktree)).toBe(await projectIdentity(project));
    await writeDurable(join(directory, 'config.json'), {
      projects: [await projectIdentity(project)],
    });
    vi.stubEnv('FIREFORGE_JOB_TOKEN', undefined);
    await expect(assertJobAdmission('test', worktree)).rejects.toThrow(/coordinated jobs/);
  });
  it('refuses direct execution inside a slot even with no project configured', async () => {
    const root = join(directory, 'slots', 'a', 'root');
    await mkdir(root, { recursive: true });
    await writeDurable(join(directory, 'config.json'), { projects: [] });
    vi.stubEnv('FIREFORGE_JOB_TOKEN', undefined);
    await expect(assertJobAdmission('build', root)).rejects.toThrow(/coordinated jobs/);
  });
  it('authenticates exact root and phase and refuses missing/foreign runtime roots', async () => {
    const root = await admitted();
    await assertJobAdmission('check', root);
    expect(vi.mocked(rpc).mock.calls[0]?.[1]).toMatchObject({
      command: 'check',
      phase: 'phase',
      token: 'secret',
    });
    vi.mocked(rpc).mockResolvedValueOnce({});
    await expect(assertExecutorCommand('check', root)).rejects.toThrow(/runtime root/);
    vi.mocked(rpc).mockResolvedValueOnce({ root: directory });
    await expect(assertExecutorCommand('check', root)).rejects.toThrow(/runtime root/);
    expect((await readAdmittedSnapshot(root)).pristineRepository).toBe('private-pin');
    await writeDurable(join(directory, 'slots', 'a', 'snapshot.json'), { id: 'foreign' });
    await expect(readAdmittedSnapshot(root)).rejects.toThrow(/source identity/);
    vi.stubEnv('FIREFORGE_COORDINATOR', join(directory, 'not-directory'));
    await writeFile(join(directory, 'not-directory'), 'file');
    await expect(assertJobAdmission('status', root)).rejects.toThrow();
  });
  it('accepts a coherent baseline only while source, generation, cleanup and both hashes remain exact', async () => {
    const root = await admitted();
    const metadata = slotDirectory(directory, 'a');
    expect(await trustedSlotBuild(root)).toBeUndefined();
    await writeFile(join(metadata, 'materialization.json'), 'ledger');
    await mkdir(join(root, '.fireforge'));
    await writeFile(join(root, '.fireforge', 'last-build.json'), 'baseline');
    const slot = await readJson<Record<string, unknown>>(join(metadata, 'slot.json'));
    const trusted = {
      sourceId: 'source',
      slotGeneration: 1,
      materializationDigest: hash('ledger'),
      baselineDigest: hash('baseline'),
      successfulBuildGeneration: 2,
    };
    const valid = { ...slot, trustedBuild: trusted, fullBuildAnchor: { digest: 'compiled' } };
    await writeDurable(join(metadata, 'slot.json'), valid);
    expect(await trustedSlotBuild(root)).toEqual(trusted);
    for (const patch of [
      { requiresFullBuild: true },
      { fullBuildAnchor: undefined },
      { quarantined: 'uncertain' },
      { trustedBuild: { ...trusted, sourceId: 'other' } },
      { trustedBuild: { ...trusted, slotGeneration: 2 } },
    ]) {
      await writeDurable(join(metadata, 'slot.json'), { ...valid, ...patch });
      expect(await trustedSlotBuild(root)).toBeUndefined();
    }
    await writeDurable(join(metadata, 'slot.json'), valid);
    await mkdir(join(root, '.fireforge', 'negative-control'));
    await writeFile(join(root, '.fireforge', 'negative-control', 'pending'), 'restore');
    expect(await trustedSlotBuild(root)).toBeUndefined();
    await rm(join(root, '.fireforge', 'negative-control'), { recursive: true });
    await writeFile(join(root, '.fireforge', 'last-build.json'), 'changed');
    expect(await trustedSlotBuild(root)).toBeUndefined();
    await writeFile(join(root, '.fireforge', 'last-build.json'), 'baseline');
    await writeFile(join(metadata, 'materialization.json'), 'changed');
    expect(await trustedSlotBuild(root)).toBeUndefined();
    await writeFile(join(root, '.fireforge', 'negative-control'), 'not a directory');
    await expect(trustedSlotBuild(root)).rejects.toThrow();
  });
});

describe('actual project FireForge bytes', () => {
  it('refuses unsupported children and binds same-version code and resolved transitive assets', async () => {
    expect(await assertProjectToolCompatibility(directory)).toBe('no-project-fireforge');
    const pkg = join(directory, 'node_modules', '@hominis', 'fireforge');
    await mkdir(pkg, { recursive: true });
    for (const manifest of [null, {}, { version: '0.1.0' }]) {
      await writeDurable(join(pkg, 'package.json'), manifest);
      await expect(assertProjectToolCompatibility(directory)).rejects.toThrow(/lacks coordinated/);
    }
    await writeDurable(join(pkg, 'package.json'), {
      name: '@hominis/fireforge',
      version: getPackageVersion(),
      dependencies: { child: '1' },
    });
    await expect(assertProjectToolCompatibility(directory)).rejects.toThrow(/lacks coordinated/);
    const guard = join(pkg, 'dist', 'src', 'core', 'jobs', 'guard.js');
    await mkdir(join(pkg, 'dist', 'src', 'core', 'jobs'), { recursive: true });
    await writeFile(guard, 'original guard');
    const child = join(pkg, 'node_modules', 'child');
    await mkdir(child, { recursive: true });
    await writeDurable(join(child, 'package.json'), { name: 'child', version: '1' });
    await writeFile(join(child, 'runtime.bin'), 'actual bytes');
    const first = await assertProjectToolCompatibility(directory);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    await writeFile(join(pkg, 'extra.js'), 'same-version changed code');
    expect(await assertProjectToolCompatibility(directory)).not.toBe(first);
    await rm(join(pkg, 'extra.js'));
    await writeFile(join(child, 'runtime.bin'), 'different bytes');
    expect(await assertProjectToolCompatibility(directory)).not.toBe(first);
    expect(await readFile(guard, 'utf8')).toBe('original guard');
  });
  it('refuses an unreadable installed manifest rather than treating it as absent', async () => {
    await mkdir(join(directory, 'node_modules', '@hominis', 'fireforge', 'package.json'), {
      recursive: true,
    });
    await expect(assertProjectToolCompatibility(directory)).rejects.toThrow();
  });
  it('rejects traversal slot names before any filesystem operation', () => {
    for (const name of ['', '..', 'a/b', 'a.b'])
      expect(() => slotDirectory(directory, name)).toThrow(/Invalid slot/);
  });
});
