// SPDX-License-Identifier: EUPL-1.2
/**
 * Patch-mode `rebase --to`: the preview, and what guards the engine while the
 * new source is prepared.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ExitCode } from '../kernel/errors.js';
import { exists } from '../kernel/fs.js';
import { hostPaths, loadProject, type PatchProject } from '../project/index.js';
import { requirePatchMode } from '../queue/index.js';
import { seedPristine, useMachSandbox } from '../testing/engine.js';
import { createPatchProject, type PatchFixture } from '../testing/patch-project.js';
import { useTempDir } from '../testing/temp.js';
import { rebase } from './rebase.js';

const hooks = vi.hoisted(() => ({
  afterPristine: undefined as (() => Promise<void>) | undefined,
}));

vi.mock('../engine/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../engine/index.js')>();
  return {
    ...original,
    ensurePristine: async (...args: Parameters<typeof original.ensurePristine>) => {
      const pristine = await original.ensurePristine(...args);
      await hooks.afterPristine?.();
      return pristine;
    },
  };
});

const dir = useTempDir();
useMachSandbox();

const MULTI = 'browser/base/content/multi.js';
const LOOSE = 'browser/base/content/loose.mjs';
const LINES = 'one\ntwo\nthree\nfour\nfive\n';
const NEXT = { version: '140.10.0esr', product: 'firefox-esr' } as const;

const home = (): string => join(dir(), 'home');

async function setup(
  upstream: string
): Promise<{ fixture: PatchFixture; project: () => Promise<PatchProject> }> {
  const host = hostPaths({ FIREFORGE_HOME: home() });
  await seedPristine(host, { [MULTI]: LINES });
  await seedPristine(host, { [MULTI]: upstream }, NEXT);
  const fixture = await createPatchProject(join(dir(), 'project'), { files: { [MULTI]: LINES } });
  await fixture.addPatch('ui-multi', { [MULTI]: LINES.replace('three', 'THREE') });
  return {
    fixture,
    project: async () =>
      requirePatchMode(await loadProject(fixture.root, { FIREFORGE_HOME: home() })),
  };
}

describe('rebase --to --dry-run', () => {
  it('applies the queue with reduced context like the rebase does, and says which patches need it', async () => {
    const { project } = await setup(LINES.replace('one', 'ONE').replace('five', 'FIVE'));
    const preview = await rebase(await project(), { to: NEXT.version, dryRun: true });
    expect(preview).toMatchObject({
      status: 'dry-run',
      pin: NEXT,
      entries: [{ subject: '001-ui-multi.patch', outcome: 'applied-fuzz' }],
      conflicts: [],
    });
    const real = await rebase(await project(), { to: NEXT.version });
    expect(real.status).toBe('complete');
  });

  it('reports the patch that does not apply under that policy', async () => {
    const { fixture, project } = await setup(LINES.replace('three', 'drifted'));
    const preview = await rebase(await project(), { to: NEXT.version, dryRun: true });
    expect(preview.status).toBe('dry-run');
    expect(preview.entries).toEqual([{ subject: '001-ui-multi.patch', outcome: 'failed' }]);
    expect(preview.conflicts).toHaveLength(1);
    expect(preview.conflicts[0]).toContain('001-ui-multi.patch does not apply');
    expect(await fixture.read(MULTI)).toContain('THREE');
  });
});

describe('rebase --to over edits no patch has', () => {
  it('counts a deleted queue-owned file as an edit', async () => {
    const { fixture, project } = await setup(LINES.replace('one', 'ONE'));
    await rm(join(fixture.engine, MULTI));
    await expect(rebase(await project(), { to: NEXT.version })).rejects.toMatchObject({
      code: 'engine-unexported-edits',
      exitCode: ExitCode.PATCH_ERROR,
      message: expect.stringContaining(MULTI) as unknown,
    });
    expect(await exists(join(fixture.engine, MULTI))).toBe(false);
  });

  it('sees an edit made while the new source was being prepared, and leaves the engine and the pin', async () => {
    const { fixture, project } = await setup(LINES.replace('one', 'ONE'));
    hooks.afterPristine = () => fixture.edit({ [LOOSE]: 'export const kept = 1;\n' });
    try {
      await expect(rebase(await project(), { to: NEXT.version })).rejects.toMatchObject({
        code: 'engine-unexported-edits',
        message: expect.stringContaining(LOOSE) as unknown,
      });
    } finally {
      hooks.afterPristine = undefined;
    }
    expect(await fixture.read(LOOSE)).toBe('export const kept = 1;\n');
    expect((await project()).config.firefox.version).not.toBe(NEXT.version);

    // Nothing is left half-started: once the edit is dealt with, the rebase goes through.
    await fixture.edit({ [LOOSE]: null });
    expect((await rebase(await project(), { to: NEXT.version })).status).toBe('complete');
  });
});
