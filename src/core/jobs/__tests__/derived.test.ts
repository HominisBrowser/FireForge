// SPDX-License-Identifier: EUPL-1.2
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { sourceFixture, writeAt } from '../../authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../../authored/index.js';
import { readDerivedOutputs, recordDerivedOutput } from '../derived.js';
import { readAdmittedSnapshot } from '../guard.js';
import { phaseRuntimeIdentity } from '../phase-identity.js';
import { createSlot } from '../slot-lifecycle.js';
import { slotDirectory, writeDurable } from '../store.js';

vi.mock('../guard.js', async (original) => ({
  ...(await original<typeof import('../guard.js')>()),
  readAdmittedSnapshot: vi.fn(),
}));
const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function fixture(
  destination = 'tools/jsconfig.json',
  value: unknown = { compilerOptions: { checkJs: true, paths: { 'ordinary/*': ['base/*'] } } }
): Promise<
  Awaited<ReturnType<typeof sourceFixture>> & {
    namespace: string;
    snapshot: Awaited<ReturnType<typeof captureAuthoredSnapshot>>;
    slot: Awaited<ReturnType<typeof createSlot>>;
  }
> {
  const f = await sourceFixture();
  directories.push(dirname(f.root));
  const config = {
    version: 1,
    componentPrefix: 'moz-',
    stock: [],
    overrides: {},
    custom: {},
    typecheckJsconfig: destination,
    typecheckTagMap: 'tools/tags.d.ts',
  };
  await writeAt(f.root, 'furnace.json', JSON.stringify(config));
  await writeAt(
    f.root,
    destination.startsWith('engine/') ? `src/${destination.slice(7)}` : destination,
    JSON.stringify(value)
  );
  await writeAt(f.root, 'tools/tags.d.ts', '// generated types\n');
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: f.root,
    intendedPaths: ['src', 'tools', 'furnace.json'],
    pristineRepository: f.pristine,
  });
  const namespace = join(dirname(f.root), 'coordinator');
  const slot = await createSlot({ namespace, id: 'a', snapshot, pristineRepository: f.pristine });
  vi.stubEnv('FIREFORGE_COORDINATOR', namespace);
  vi.stubEnv('FIREFORGE_ADAPTER_COMMAND', 'typecheck');
  vi.mocked(readAdmittedSnapshot).mockResolvedValue({
    snapshot,
    slot,
    pristineRepository: slot.pristineRepository,
    phase: 'phase',
  });
  return { ...f, namespace, snapshot, slot };
}
it('stays the same digest across repeated generators, and moves only with what they declare', async () => {
  const f = await fixture();
  const ledgerPath = join(slotDirectory(f.namespace, f.slot.id), 'derived.json');
  await recordDerivedOutput(f.slot.root, 'tools/tags.d.ts', { generatorVersion: 'fixture-v1' });
  const first = await phaseRuntimeIdentity(f.namespace, f.slot);
  const firstLedger = await readFile(ledgerPath, 'utf8');
  // A second check's typecheck runs under a new phase nonce and finds the same bytes.
  vi.mocked(readAdmittedSnapshot).mockResolvedValue({
    snapshot: f.snapshot,
    slot: f.slot,
    pristineRepository: f.slot.pristineRepository,
    phase: 'a-later-phase',
  });
  await recordDerivedOutput(f.slot.root, 'tools/tags.d.ts', { generatorVersion: 'fixture-v1' });
  expect(await readFile(ledgerPath, 'utf8')).toBe(firstLedger);
  expect((await phaseRuntimeIdentity(f.namespace, f.slot)).derivedDigest).toBe(first.derivedDigest);
  // A ledger that differs only in who wrote it, as one from another slot or job does, is the same content.
  const parsed = JSON.parse(firstLedger) as Record<string, { phase: string }>;
  const entry = parsed['tools/tags.d.ts'];
  if (entry === undefined) throw new Error('fixture ledger has its output');
  entry.phase = 'another-job';
  await writeFile(ledgerPath, JSON.stringify(parsed));
  expect((await phaseRuntimeIdentity(f.namespace, f.slot)).derivedDigest).toBe(first.derivedDigest);
  // Different bytes are a different digest.
  await writeFile(join(f.slot.root, 'tools/tags.d.ts'), '// other generated types\n');
  await recordDerivedOutput(f.slot.root, 'tools/tags.d.ts', { generatorVersion: 'fixture-v1' });
  expect((await phaseRuntimeIdentity(f.namespace, f.slot)).derivedDigest).not.toBe(
    first.derivedDigest
  );
});

it('records only managed jsconfig projection and generation-bound type outputs', async () => {
  const f = await fixture();
  const file = join(f.slot.root, 'tools/jsconfig.json');
  expect(await readDerivedOutputs(f.namespace, f.slot)).toEqual({});
  await writeFile(
    file,
    JSON.stringify({
      compilerOptions: {
        checkJs: true,
        paths: {
          'ordinary/*': ['base/*'],
          'chrome://global/content/elements/x.js': ['generated/x.js'],
        },
      },
    })
  );
  await recordDerivedOutput(f.slot.root, 'tools/jsconfig.json', {
    generatorVersion: 'fixture-v1',
    sourceId: f.snapshot.id,
    phase: 'phase',
  });
  await writeFile(join(f.slot.root, 'tools/tags.d.ts'), '// actual generated type body\n');
  await recordDerivedOutput(f.slot.root, 'tools/tags.d.ts', { generatorVersion: 'fixture-v1' });
  const ledger = await readDerivedOutputs(f.namespace, f.slot);
  expect(Object.keys(ledger)).toEqual(['tools/jsconfig.json', 'tools/tags.d.ts']);
  expect(ledger['tools/jsconfig.json']).toMatchObject({
    phase: 'phase',
    generation: f.slot.generation,
    sourceId: f.snapshot.id,
  });
  await writeFile(file, JSON.stringify({ compilerOptions: { checkJs: false } }));
  await expect(
    recordDerivedOutput(f.slot.root, 'tools/jsconfig.json', { generatorVersion: 'fixture-v1' })
  ).rejects.toThrow(/authoritative/);
  await writeDurable(join(slotDirectory(f.namespace, 'a'), 'derived.json'), {
    other: { sourceId: 'foreign', generation: 1, sha256: 'invalid' },
  });
  await expect(readDerivedOutputs(f.namespace, f.slot)).rejects.toThrow(/different source/);
});
it('refuses unauthorized phases, provenance, undeclared outputs, aliases and invalid source projections', async () => {
  const f = await fixture();
  const record = (): Promise<void> =>
    recordDerivedOutput(f.slot.root, 'tools/jsconfig.json', { generatorVersion: 'v1' });
  vi.stubEnv('FIREFORGE_ADAPTER_COMMAND', 'build');
  await expect(record()).rejects.toThrow(/phase/);
  vi.stubEnv('FIREFORGE_ADAPTER_COMMAND', 'check');
  for (const provenance of [
    { generatorVersion: '' },
    { generatorVersion: 'v1', sourceId: 'other' },
    { generatorVersion: 'v1', phase: 'other' },
  ])
    await expect(
      recordDerivedOutput(f.slot.root, 'tools/jsconfig.json', provenance)
    ).rejects.toThrow(/provenance/);
  await expect(
    recordDerivedOutput(f.slot.root, '../foreign', { generatorVersion: 'v1' })
  ).rejects.toThrow(/escapes/);
  await expect(
    recordDerivedOutput(f.slot.root, 'tools/undeclared.json', { generatorVersion: 'v1' })
  ).rejects.toThrow(/destination/);
  await rm(join(f.slot.root, 'tools/jsconfig.json'));
  await symlink('tags.d.ts', join(f.slot.root, 'tools/jsconfig.json'));
  await expect(record()).rejects.toThrow(/regular/);
  await rm(join(f.slot.root, 'tools/jsconfig.json'));
  await writeFile(join(f.slot.root, 'tools/jsconfig.json'), 'null');
  await expect(record()).rejects.toThrow(/Invalid generated/);
  const noConfig = {
    ...f.snapshot,
    inputs: f.snapshot.inputs.filter((input) => input.path !== 'furnace.json'),
  };
  vi.mocked(readAdmittedSnapshot).mockResolvedValue({
    ...(await readAdmittedSnapshot(f.slot.root)),
    snapshot: noConfig,
  });
  await expect(record()).rejects.toThrow(/No captured Furnace/);
  expect(await readFile(join(f.root, 'tools/jsconfig.json'), 'utf8')).toContain('checkJs');
});

it('reconciles a declared engine jsconfig without changing its authoritative compiler settings', async () => {
  const f = await fixture('engine/browser/jsconfig.json', {});
  await writeFile(
    join(f.slot.root, 'engine/browser/jsconfig.json'),
    JSON.stringify({
      compilerOptions: { paths: { 'chrome://global/content/elements/x.js': ['../generated.js'] } },
    })
  );
  await recordDerivedOutput(f.slot.root, 'engine/browser/jsconfig.json', {
    generatorVersion: 'v1',
  });
  expect(
    (await readDerivedOutputs(f.namespace, f.slot))['engine/browser/jsconfig.json']?.sourceId
  ).toBe(f.snapshot.id);
});
