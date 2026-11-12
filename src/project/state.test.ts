// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ExitCode, type FireForgeError } from '../kernel/errors.js';
import { s } from '../kernel/schema.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { defineStateSection, projectPaths, readState, updateState } from './index.js';

const dir = useTempDir();

const build = defineStateSection(
  'build',
  s.object({ mode: s.enum(['dev', 'debug', 'release']), count: s.int({ min: 0 }) }),
  'fireforge build'
);
const download = defineStateSection(
  'download',
  s.object({ version: s.string() }),
  'fireforge download'
);

const project = (): { paths: ReturnType<typeof projectPaths> } => ({ paths: projectPaths(dir()) });

async function document(): Promise<unknown> {
  return JSON.parse(await readFile(join(dir(), '.fireforge', 'state.json'), 'utf8'));
}

describe('project state', () => {
  it('reads an absent document or section as undefined', async () => {
    expect(await readState(project(), build)).toBeUndefined();
    await updateState(project(), download, () => ({ version: '153.0' }));
    expect(await readState(project(), build)).toBeUndefined();
  });

  it('updates one section and carries the others through untouched', async () => {
    await writeTree(dir(), { '.fireforge/state.json': '{"other":{"kept":[1,2]}}' });
    await updateState(project(), build, () => ({ mode: 'dev', count: 1 }));
    await updateState(project(), build, (current) => ({
      mode: 'debug' as const,
      count: (current?.count ?? 0) + 1,
    }));
    expect(await readState(project(), build)).toEqual({ mode: 'debug', count: 2 });
    expect(await document()).toEqual({
      other: { kept: [1, 2] },
      build: { mode: 'debug', count: 2 },
    });
  });

  it('removes a section when the update returns undefined', async () => {
    await updateState(project(), build, () => ({ mode: 'dev', count: 0 }));
    await updateState(project(), download, () => ({ version: '153.0' }));
    await updateState(project(), build, () => undefined);
    expect(await document()).toEqual({ download: { version: '153.0' } });
  });

  it('reports an invalid section by key path with the command that repairs it', async () => {
    await writeTree(dir(), { '.fireforge/state.json': '{"build":{"mode":"fast","count":1}}' });
    const error = await readState(project(), build).catch(
      (caught: unknown) => caught as FireForgeError
    );
    expect(error).toMatchObject({ code: 'state-invalid', exitCode: ExitCode.CONFIG_ERROR });
    expect((error as FireForgeError).message).toContain(
      '"build.mode" must be one of: dev, debug, release'
    );
    expect((error as FireForgeError).hint).toBe('Run "fireforge build" to repair it.');
    await expect(updateState(project(), build, () => undefined)).rejects.toMatchObject({
      code: 'state-invalid',
    });
  });

  it('reports a document that is not JSON instead of resetting it', async () => {
    await writeTree(dir(), { '.fireforge/state.json': '{ broken' });
    await expect(readState(project(), download)).rejects.toMatchObject({
      code: 'json-invalid',
      exitCode: ExitCode.CONFIG_ERROR,
    });
  });

  it('refuses to write a section that does not match its own schema', async () => {
    const bad = (): { mode: 'dev'; count: number } => ({ mode: 'dev', count: -1 });
    await expect(updateState(project(), build, bad)).rejects.toMatchObject({ code: 'internal' });
  });

  it('loses no update when several run at once', async () => {
    await Promise.all(
      Array.from({ length: 8 }, () =>
        updateState(project(), build, (current) => ({
          mode: 'dev' as const,
          count: (current?.count ?? 0) + 1,
        }))
      )
    );
    expect(await readState(project(), build)).toEqual({ mode: 'dev', count: 8 });
  });
});
