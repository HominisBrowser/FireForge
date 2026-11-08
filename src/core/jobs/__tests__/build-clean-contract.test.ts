// SPDX-License-Identifier: EUPL-1.2
import * as filesystem from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { writeAt } from '../../authored/__tests__/fixtures.js';
import { runMach } from '../../mach.js';
import { preparePhaseTools, sealToolIdentity } from '../admission-tools.js';
import { prepareOwnedBuildClean } from '../build-clean.js';
import { recordSuccessfulBuild } from '../build-identity.js';
import { readAdmittedSnapshot } from '../guard.js';
import { nativeToolIdentity, toolchainManifestPath } from '../native-tools.js';
import { qualityToolIdentity } from '../quality-tools.js';
import type { JobRecord } from '../schema.js';
import type { BuildToolContext, SlotRecord } from '../slot-types.js';
import { readSlot } from '../slots.js';
import { compiledSourceDigest } from '../source-build.js';
import { readJson, writeDurable } from '../store.js';
import { toolTreeDigest, treeStatSignature } from '../tool-files.js';
import {
  type NativeFixture,
  nativeFixture,
  pythonInformation,
  removeNativeFixture,
} from './native-fixture.js';

const { probe, namespace } = vi.hoisted(() => ({ probe: vi.fn(), namespace: { value: '' } }));
vi.mock('node:child_process', async (original) => {
  const module = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const execute = vi.fn();
  Object.defineProperty(execute, promisify.custom, { value: probe });
  return { ...module, execFile: execute };
});
vi.mock('../../mach.js', () => ({ runMach: vi.fn() }));
vi.mock('../guard.js', () => ({
  assertExecutorCommand: vi.fn(),
  readAdmittedSnapshot: vi.fn(),
  coordinatorNamespace: () => namespace.value,
}));
vi.mock('../../qualified-git.js', () => ({ qualifiedGitRuntime: () => undefined }));
vi.mock('../native-state.js', async (original) => ({
  ...(await original<typeof import('../native-state.js')>()),
  // Runtime qualification has its own real fixed-Mach fixtures; this suite isolates clean/build promotion.
  verifyQualifiedSites: () => Promise.resolve({}),
}));
vi.mock('../quality-tools.js', () => ({ qualityToolIdentity: vi.fn() }));
vi.mock('../git-tools.js', () => ({
  gitToolIdentity: () => ({ executable: '/fixture/git', execPath: '/fixture', digest: 'git' }),
}));

interface Fixture extends NativeFixture {
  namespace: string;
  slot: SlotRecord;
  job: JobRecord;
  buildTools: BuildToolContext;
}
const fixtures: NativeFixture[] = [];
const quality = 'a'.repeat(64);
afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(fixtures.splice(0).map(removeNativeFixture));
});

async function fixture(): Promise<Fixture> {
  vi.stubEnv('FIREFORGE_JOB_TOKEN', undefined);
  vi.stubEnv('PYTHONPATH', undefined);
  const value = await nativeFixture();
  fixtures.push(value);
  probe.mockResolvedValue(pythonInformation(value));
  vi.mocked(qualityToolIdentity).mockResolvedValue(quality);
  const ns = value.namespace;
  const digest = await nativeToolIdentity({
    namespace: ns,
    snapshot: value.snapshot,
    projectRoot: value.root,
    steps: [{ command: 'build', args: [] }],
  });
  const root = join(ns, 'slots/a/root');
  const pristine = join(ns, 'slots/a/engine.git');
  await filesystem.cp(value.root, root, { recursive: true });
  await filesystem.cp(value.pristine, pristine, { recursive: true });
  const slot: SlotRecord = {
    schemaVersion: 1,
    id: 'a',
    root,
    pristineRepository: pristine,
    pin: value.commit,
    sourceId: value.snapshot.id,
    generation: 3,
    successfulBuildGeneration: 1,
    inputs: [],
    quarantined: null,
    requiresBuild: true,
    requiresFullBuild: true,
    requiresToolchainClean: true,
  };
  namespace.value = ns;
  const tools: BuildToolContext = {
    nativeToolsDigest: digest,
    jobId: 'owned-job',
    phase: 'owned-phase',
  };
  const job: JobRecord = {
    schemaVersion: 1,
    id: tools.jobId,
    owner: 'fixture',
    state: 'running',
    epoch: 1,
    submittedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cancellationRequested: false,
    request: {
      schemaVersion: 1,
      key: 'fixture',
      slot: slot.id,
      sourceId: slot.sourceId,
      steps: [{ command: 'build', args: [] }],
      resources: { cpu: 1, memory: 1, build: 1, browser: 0, display: 0 },
      quiet: false,
    },
  };
  await writeDurable(join(ns, 'slots/a/slot.json'), slot);
  await writeDurable(join(ns, 'slots/a/snapshot.json'), value.snapshot);
  await writeDurable(join(ns, 'slots/a/materialization.json'), { fixture: 'unchanged ledger' });
  await writeAt(root, 'engine/obj-fixture/cache.o', 'old compiler object');
  vi.mocked(readAdmittedSnapshot).mockResolvedValue({
    snapshot: value.snapshot,
    slot,
    pristineRepository: pristine,
    phase: tools.phase,
    qualityToolsDigest: quality,
    nativeToolsDigest: digest,
  });
  vi.stubEnv('FIREFORGE_JOB_TOKEN', 'fixture-owned-capability');
  vi.stubEnv('FIREFORGE_JOB_ID', tools.jobId);
  vi.mocked(runMach).mockResolvedValue(0);
  return {
    ...value,
    root,
    engine: join(root, 'engine'),
    pristine,
    namespace: ns,
    slot,
    job,
    buildTools: tools,
  };
}

async function baseline(f: Fixture, kind: 'full' | 'faster'): Promise<void> {
  await writeAt(
    f.root,
    '.fireforge/last-build.json',
    JSON.stringify({
      engineHeadSha: f.slot.pin,
      binaryName: f.snapshot.config.binaryName,
      builtAt: new Date().toISOString(),
      buildKind: kind,
    })
  );
}
const proofPath = (f: Fixture): string =>
  join(f.namespace, 'artifacts', f.buildTools.jobId, `clean-${f.buildTools.phase}.json`);
const promote = (f: Fixture): Promise<void> =>
  recordSuccessfulBuild(
    f.namespace,
    'a',
    { command: 'build', args: [] },
    false,
    undefined,
    f.buildTools
  );

/** A new compiler, recorded as the host's toolchain, as `host init` would. */
async function deriveAgain(f: Fixture, bytes: string): Promise<void> {
  const compiler = f.manifest.native.executables['CC'] ?? '';
  await filesystem.chmod(dirname(compiler), 0o755);
  await filesystem.chmod(compiler, 0o644);
  await filesystem.writeFile(compiler, bytes);
  await filesystem.chmod(compiler, 0o444);
  await filesystem.chmod(dirname(compiler), 0o555);
  await writeDurable(toolchainManifestPath(f.namespace), {
    ...f.manifest,
    digest: 'toolchain-after-a-new-compiler',
    signature: await treeStatSignature([f.tools]),
    rootDigests: { [f.tools]: await toolTreeDigest(f.tools) },
  });
}

describe('owned native clean/full promotion', () => {
  it('requires successful clobber before full promotion and clears requirements only after the build', async () => {
    const f = await fixture();
    await baseline(f, 'full');
    await expect(promote(f)).rejects.toMatchObject({ code: 'ENOENT', path: proofPath(f) });
    expect((await readSlot(f.namespace, 'a')).requiresToolchainClean).toBe(true);
    const order: string[] = [];
    vi.mocked(runMach).mockImplementation(async (args, engine) => {
      expect(args).toEqual(['clobber', 'objdir', '--full']);
      expect(engine).toBe(f.engine);
      order.push('clobber');
      await filesystem.rm(join(f.engine, 'obj-fixture'), { recursive: true });
      return 0;
    });
    await prepareOwnedBuildClean(f.root, f.engine, false);
    expect(await readJson(proofPath(f))).toEqual({
      sourceId: f.snapshot.id,
      generation: 3,
      ...f.buildTools,
    });
    expect((await readSlot(f.namespace, 'a')).requiresToolchainClean).toBe(true);
    await baseline(f, 'full');
    order.push('full');
    await promote(f);
    expect(order).toEqual(['clobber', 'full']);
    const promoted = await readSlot(f.namespace, 'a');
    expect(promoted.requiresToolchainClean).toBe(false);
    expect(promoted.requiresFullBuild).toBe(false);
    expect(promoted.successfulBuildGeneration).toBe(2);
    expect(promoted.fullBuildAnchor?.nativeToolsDigest).toBe(f.buildTools.nativeToolsDigest);
  });

  it('retains clean/full requirements and creates no proof after clobber failure', async () => {
    const f = await fixture();
    vi.mocked(runMach).mockResolvedValue(7);
    await expect(prepareOwnedBuildClean(f.root, f.engine, false)).rejects.toThrow(
      'clobber failed (7)'
    );
    await expect(filesystem.readFile(proofPath(f))).rejects.toThrow();
    await baseline(f, 'full');
    await expect(promote(f)).rejects.toMatchObject({ code: 'ENOENT', path: proofPath(f) });
    expect((await readSlot(f.namespace, 'a')).requiresToolchainClean).toBe(true);
    expect((await readSlot(f.namespace, 'a')).successfulBuildGeneration).toBe(1);
  });

  it('refuses a successful clean receipt belonging to another generation, phase or tool identity', async () => {
    const f = await fixture();
    await prepareOwnedBuildClean(f.root, f.engine, false);
    const proof = await readJson<Record<string, unknown>>(proofPath(f));
    await baseline(f, 'full');
    for (const substitution of [
      { sourceId: 'another-source' },
      { generation: 4 },
      { jobId: 'another-job' },
      { phase: 'another-phase' },
      { nativeToolsDigest: 'b'.repeat(64) },
    ]) {
      await writeDurable(proofPath(f), { ...proof, ...substitution });
      await expect(promote(f)).rejects.toThrow('No matching successful clobber proof');
      expect((await readSlot(f.namespace, 'a')).requiresToolchainClean).toBe(true);
      expect((await readSlot(f.namespace, 'a')).successfulBuildGeneration).toBe(1);
    }
    await writeDurable(proofPath(f), proof);
    await promote(f);
    expect((await readSlot(f.namespace, 'a')).requiresToolchainClean).toBe(false);
  });

  it('refuses UI, unauthenticated identities, missing ownership and clobbering immutable roots', async () => {
    const f = await fixture();
    await expect(prepareOwnedBuildClean(f.root, f.engine, true)).rejects.toThrow('never --ui');
    const admitted = await readAdmittedSnapshot(f.root);
    const missing = { ...admitted };
    delete missing.nativeToolsDigest;
    vi.mocked(readAdmittedSnapshot).mockResolvedValue(missing);
    await expect(prepareOwnedBuildClean(f.root, f.engine, false)).rejects.toThrow(
      'no authenticated'
    );
    vi.mocked(readAdmittedSnapshot).mockResolvedValue(admitted);
    await writeDurable(toolchainManifestPath(f.namespace), {
      ...f.manifest,
      native: { ...f.manifest.native, roots: [join(f.engine, 'obj-fixture')] },
    });
    await expect(prepareOwnedBuildClean(f.root, f.engine, false)).rejects.toThrow(
      'overlap clobber targets'
    );
    expect(runMach).not.toHaveBeenCalled();
    await writeDurable(toolchainManifestPath(f.namespace), f.manifest);
    vi.stubEnv('FIREFORGE_JOB_ID', undefined);
    await expect(prepareOwnedBuildClean(f.root, f.engine, false)).rejects.toThrow(
      'Missing owned build job'
    );
    await expect(filesystem.readFile(proofPath(f))).rejects.toThrow();
  });

  it('skips cleaning without ownership or an outstanding clean requirement', async () => {
    const f = await fixture();
    vi.stubEnv('FIREFORGE_JOB_TOKEN', undefined);
    await prepareOwnedBuildClean(f.root, f.engine, false);
    vi.stubEnv('FIREFORGE_JOB_TOKEN', 'fixture');
    f.slot.requiresToolchainClean = false;
    await prepareOwnedBuildClean(f.root, f.engine, false);
    expect(runMach).not.toHaveBeenCalled();
  });

  it('refuses an object-directory symlink before clobber and preserves the target and clean requirement', async () => {
    const f = await fixture();
    const target = join(f.directory, 'peer-object-directory');
    await writeAt(target, 'peer.o', 'peer object must survive');
    await filesystem.symlink(target, join(f.engine, 'obj-aliased'), 'dir');
    await expect(prepareOwnedBuildClean(f.root, f.engine, false)).rejects.toThrow(
      'symbolic-link object directory'
    );
    expect(runMach).not.toHaveBeenCalled();
    expect(await filesystem.readFile(join(target, 'peer.o'), 'utf8')).toBe(
      'peer object must survive'
    );
    await expect(filesystem.readFile(proofPath(f))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readSlot(f.namespace, 'a')).requiresToolchainClean).toBe(true);
    expect((await readSlot(f.namespace, 'a')).successfulBuildGeneration).toBe(1);
  });

  it('detects same-manifest compiler A→B, invalidates trust and refuses faster reuse of old objects', async () => {
    const f = await fixture();
    f.slot.requiresBuild = false;
    f.slot.requiresFullBuild = false;
    f.slot.requiresToolchainClean = false;
    f.slot.fullBuildAnchor = {
      digest: compiledSourceDigest(f.snapshot),
      baselineDigest: 'old',
      sourceId: f.snapshot.id,
      buildGeneration: 1,
      nativeToolsDigest: f.buildTools.nativeToolsDigest,
    };
    f.slot.trustedBuild = {
      sourceId: f.snapshot.id,
      slotGeneration: 3,
      materializationDigest: 'old',
      successfulBuildGeneration: 1,
      baselineDigest: 'old',
    };
    await deriveAgain(f, 'compiler B, same manifest and version');
    await preparePhaseTools(f.namespace, f.job, f.slot, f.job.request.steps[0]);
    expect(f.slot.trustedBuild).toBeUndefined();
    expect(f.slot.requiresToolchainClean).toBe(true);
    expect(f.slot.requiresFullBuild).toBe(true);
    expect(f.job.toolIdentityTimings?.['nativeInitialMs']).toBeGreaterThanOrEqual(0);
    f.buildTools.nativeToolsDigest = f.job.nativeToolsDigest ?? '';
    await baseline(f, 'faster');
    await expect(promote(f)).rejects.toThrow('different actual toolchain');
    expect(await filesystem.readFile(join(f.engine, 'obj-fixture/cache.o'), 'utf8')).toBe(
      'old compiler object'
    );
    const admitted = await readAdmittedSnapshot(f.root);
    vi.mocked(readAdmittedSnapshot).mockResolvedValue({
      ...admitted,
      nativeToolsDigest: f.buildTools.nativeToolsDigest,
    });
    await prepareOwnedBuildClean(f.root, f.engine, false);
    await baseline(f, 'full');
    await promote(f);
    expect((await readSlot(f.namespace, 'a')).requiresToolchainClean).toBe(false);
    expect((await readSlot(f.namespace, 'a')).fullBuildAnchor?.nativeToolsDigest).toBe(
      f.buildTools.nativeToolsDigest
    );
  });

  it('hashes once during admission, refuses stale runtime and rehashes actual bytes at sealing', async () => {
    const f = await fixture();
    await preparePhaseTools(f.namespace, f.job, f.slot, { command: 'status', args: [] });
    await preparePhaseTools(f.namespace, f.job, f.slot, undefined);
    expect(qualityToolIdentity).toHaveBeenCalledTimes(1);
    expect(f.job.nativeToolsDigest).toBeUndefined();
    await expect(
      preparePhaseTools(f.namespace, f.job, f.slot, { command: 'test', args: [] })
    ).rejects.toThrow('fresh admitted build');
    await preparePhaseTools(f.namespace, f.job, f.slot, { command: 'build', args: [] });
    expect(await sealToolIdentity(f.namespace, f.slot, f.job, f.snapshot)).toEqual({
      qualityToolsDigest: quality,
      nativeToolsDigest: f.job.nativeToolsDigest,
    });
    const compiler = f.manifest.native.executables['CC'] ?? '';
    await filesystem.chmod(dirname(compiler), 0o755);
    await filesystem.chmod(compiler, 0o644);
    await filesystem.writeFile(compiler, 'changed during campaign');
    await filesystem.chmod(compiler, 0o444);
    await filesystem.chmod(dirname(compiler), 0o555);
    await expect(sealToolIdentity(f.namespace, f.slot, f.job, f.snapshot)).rejects.toThrow(
      'Native tool bytes changed'
    );
    vi.mocked(qualityToolIdentity).mockResolvedValue('b'.repeat(64));
    await expect(sealToolIdentity(f.namespace, f.slot, f.job, f.snapshot)).rejects.toThrow(
      'quality tools/config/assets changed'
    );
  });
});
