// SPDX-License-Identifier: EUPL-1.2
import { execFileSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { commitFixture, sourceFixture, writeAt } from '../../core/authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../../core/authored/capture.js';
import { declareAuthoredOverride } from '../../core/authored/writer.js';
import { createDefaultFurnaceConfig } from '../../core/furnace-config.js';
import { readAdmittedSnapshot } from '../../core/jobs/guard.js';
import { setMachineOutputMode } from '../../utils/logger.js';
import { isObject } from '../../utils/validation.js';
import { statusAuthored } from '../status-authored.js';

vi.mock('../../core/jobs/guard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/jobs/guard.js')>()),
  readAdmittedSnapshot: vi.fn(),
}));
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  setMachineOutputMode(false);
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function admitted(): Promise<
  Awaited<ReturnType<typeof sourceFixture>> & {
    snapshot: Awaited<ReturnType<typeof captureAuthoredSnapshot>>;
  }
> {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  const furnace = createDefaultFurnaceConfig({ binaryName: 'fixture' });
  furnace.custom['moz-status-fixture'] = {
    description: 'Status fixture',
    targetPath: 'toolkit/content/widgets/moz-status-fixture',
    register: false,
    localized: false,
  };
  await writeAt(value.root, 'furnace.json', JSON.stringify(furnace));
  await writeAt(
    value.root,
    'components/custom/moz-status-fixture/moz-status-fixture.mjs',
    'export const generated = true;\n'
  );
  await writeAt(value.root, 'docs/removal.md', 'Reviewed fixture tombstone.\n');
  await declareAuthoredOverride(value.root, 'browser/manifest.txt', {
    component: 'fixture',
    classification: 'exception',
    adr: 'docs/removal.md',
    delete: true,
    pristineRepository: value.pristine,
  });
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: value.root,
    intendedPaths: ['src', 'docs'],
    pristineRepository: value.pristine,
  });
  vi.stubEnv('FIREFORGE_JOB_ID', 'owned-status-job');
  vi.mocked(readAdmittedSnapshot).mockResolvedValue({
    snapshot,
    pristineRepository: value.pristine,
    phase: 'owned-status-phase',
    slot: {
      schemaVersion: 1,
      id: 'status',
      root: value.root,
      pristineRepository: value.pristine,
      pin: value.commit,
      sourceId: snapshot.id,
      generation: 1,
      successfulBuildGeneration: 0,
      inputs: snapshot.inputs.map((entry) => entry.path),
      quarantined: null,
    },
  });
  return { ...value, snapshot };
}

async function output(
  root: string,
  options: Parameters<typeof statusAuthored>[1]
): Promise<string> {
  const chunks: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    await statusAuthored(root, options);
    return chunks.join('');
  } finally {
    stdout.mockRestore();
  }
}

describe('captured source status', () => {
  it('reports frozen generated/authored origins and provisional verification in structured formats', async () => {
    const value = await admitted();
    await writeAt(value.root, 'src/browser/new.js', 'Later editor change is not this job.\n');
    const document: unknown = JSON.parse(await output(value.root, { json: true }));
    if (!isObject(document)) throw new Error('Expected source status document');
    expect(document).toMatchObject({
      schemaVersion: 1,
      source: value.snapshot.id,
      tree: value.snapshot.tree,
      authority: 'authored',
      verification: 'provisional-until-job-sealed',
      summary: { total: 3 },
    });
    expect(document).not.toHaveProperty('check');
    expect(document['files']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'browser/new.js',
          classification: 'authored',
          origin: 'created',
        }),
        expect.objectContaining({
          file: 'browser/manifest.txt',
          classification: 'authored',
          origin: 'delete',
        }),
        expect.objectContaining({ classification: 'generated', origin: 'generated' }),
      ])
    );
    expect(await output(value.root, { raw: true })).toBe(
      value.snapshot.files.map((file) => file.path).join('\n') + '\n'
    );
    const summary: unknown = JSON.parse(await output(value.root, { json: true, summary: true }));
    expect(summary).toMatchObject({
      summary: { total: 3 },
      verification: 'provisional-until-job-sealed',
    });
    expect(summary).not.toHaveProperty('files');
  });

  it('keeps human status explicit about the sealed receipt still required', async () => {
    const value = await admitted();
    const text = await output(value.root, {});
    expect(text).toContain(value.snapshot.id);
    expect(text).toContain('3 paths');
    expect(text).toContain('final verification requires a sealed job receipt');
  });

  it.each([
    [{ ownership: true }, '--ownership'],
    [{ includeOwnership: true, json: true }, '--include-ownership'],
    [{ unmanaged: true }, '--unmanaged'],
  ])('refuses %j, which has nothing to classify in source mode', async (options, flag) => {
    const value = await admitted();
    await expect(output(value.root, options)).rejects.toThrow(flag);
  });

  it('refuses patch aliases', async () => {
    const value = await admitted();
    await expect(output(value.root, { patches: ['001-legacy.patch'] })).rejects.toThrow(
      'source paths, not patch aliases'
    );
  });

  it('prints nothing for an empty raw listing', async () => {
    const value = await sourceFixture();
    directories.push(dirname(value.root));
    vi.stubEnv('FIREFORGE_PRISTINE_REPOSITORY', value.pristine);
    await rm(join(value.root, 'src/browser/new.js'));
    await commitFixture(value.root);
    expect(await output(value.root, { raw: true })).toBe('');
  });

  it('reports status from a private view in an editing checkout, and refuses --check there', async () => {
    const value = await admitted();
    vi.unstubAllEnvs();
    vi.stubEnv('FIREFORGE_PRISTINE_REPOSITORY', value.pristine);
    await commitFixture(value.root);
    await expect(output(value.root, { check: true, json: true })).rejects.toThrow(
      'judges an execution slot'
    );
    await expect(output(value.root, { failOn: 'unmanaged', json: true })).rejects.toThrow(
      'judges an execution slot'
    );
    const document: unknown = JSON.parse(await output(value.root, { json: true }));
    expect(document).toMatchObject({ verification: 'provisional-no-job', authority: 'authored' });
  });

  it('fails --check on real engine drift in the slot and passes once it is gone', async () => {
    const value = await admitted();
    const engine = join(value.root, 'engine');
    await mkdir(engine, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: engine });
    await writeAt(engine, 'browser/foreign.js', 'not captured\n');
    const namespace = join(dirname(value.root), 'namespace');
    vi.stubEnv('FIREFORGE_COORDINATOR', namespace);
    const failing = output(value.root, { check: true, json: true, summary: true });
    await expect(failing).rejects.toThrow('status --check failed: 1 unmanaged');
    await rm(join(engine, 'browser/foreign.js'));
    const passing: unknown = JSON.parse(
      await output(value.root, { check: true, json: true, summary: true })
    );
    expect(passing).toMatchObject({
      check: { enabled: true, failed: false, offenders: [] },
      summary: { total: 3 },
    });
    expect(passing).toHaveProperty('check.failOn');
  });

  it('authenticates admitted snapshot metadata instead of trusting a forged status identity', async () => {
    const value = await admitted();
    const context = await readAdmittedSnapshot(value.root);
    vi.mocked(readAdmittedSnapshot).mockResolvedValue({
      ...context,
      snapshot: { ...value.snapshot, id: 'f'.repeat(64) },
    });
    await expect(output(value.root, { json: true })).rejects.toThrow('authored-snapshot-mismatch');
  });
});
