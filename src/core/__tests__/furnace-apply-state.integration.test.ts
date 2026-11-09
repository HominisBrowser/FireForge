// SPDX-License-Identifier: EUPL-1.2
/**
 * Scoped applies against a real project: each persists only its own
 * component's checksums, a committed unit is durable, `listStale` reports
 * every component whose engine copy is behind, and the source guard blames a
 * mid-walk edit only on components the run applied. Real git, real files.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { captureComponentSources, componentSourceChanges } from '../component-source-guard.js';
import { applyAllComponents, type ApplyAllComponentsResult } from '../furnace-apply.js';
import { persistAppliedComponentChecksums } from '../furnace-apply-state.js';
import { getFurnacePaths, loadFurnaceConfig, loadFurnaceState } from '../furnace-config.js';
import { runFurnaceMutation } from '../furnace-operation.js';
import {
  describeStaleFurnaceComponents,
  listStaleFurnaceComponents,
} from '../furnace-staleness.js';

const override = (name: string): Record<string, unknown> => ({
  type: 'css-only',
  description: `Recolour ${name}`,
  basePath: `toolkit/content/widgets/${name}`,
  baseVersion: '140.9.0esr',
});

describe('scoped furnace applies (integration)', () => {
  let root: string;

  const engineCss = (name: string): string =>
    join(root, 'engine', `toolkit/content/widgets/${name}/${name}.css`);
  const sourceCss = (name: string): string =>
    join(root, 'components/overrides', name, `${name}.css`);

  beforeEach(async () => {
    root = await createTempProject('ff-furnace-state-');
    await writeFireForgeConfig(root);
    await writeFiles(root, {
      'furnace.json': JSON.stringify({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: { 'moz-a': override('moz-a'), 'moz-b': override('moz-b') },
        custom: {},
      }),
      'components/overrides/moz-a/moz-a.css': ':host { color: a1; }\n',
      'components/overrides/moz-a/override.json': JSON.stringify(override('moz-a')),
      'components/overrides/moz-b/moz-b.css': ':host { color: b1; }\n',
      'components/overrides/moz-b/override.json': JSON.stringify(override('moz-b')),
    });
    await initCommittedRepo(join(root, 'engine'), {
      'toolkit/content/widgets/moz-a/moz-a.css': ':host { color: pristine-a; }\n',
      'toolkit/content/widgets/moz-b/moz-b.css': ':host { color: pristine-b; }\n',
    });
  });

  afterEach(async () => {
    await removeTempProject(root);
  });

  const applyScoped = (componentName: string): Promise<ApplyAllComponentsResult> =>
    runFurnaceMutation(root, 'apply-rollback', (ctx) =>
      applyAllComponents(root, false, { operationContext: ctx, componentName })
    );

  it('two scoped applies leave both components recorded', async () => {
    await applyScoped('moz-a');
    await applyScoped('moz-b');

    const state = await loadFurnaceState(root);
    expect(Object.keys(state.appliedChecksums ?? {}).sort()).toEqual([
      'override/moz-a/moz-a.css',
      'override/moz-b/moz-b.css',
    ]);
    expect(Object.keys(state.engineChecksums ?? {}).sort()).toEqual([
      'override/moz-a/moz-a.css',
      'override/moz-b/moz-b.css',
    ]);
    expect(await readFile(engineCss('moz-a'), 'utf8')).toContain('a1');
    expect(await readFile(engineCss('moz-b'), 'utf8')).toContain('b1');
  });

  it('a scoped apply replaces its own checksums and keeps its peer', async () => {
    await applyScoped('moz-a');
    await applyScoped('moz-b');
    const before = await loadFurnaceState(root);

    await writeFile(sourceCss('moz-a'), ':host { color: a2; }\n');
    await applyScoped('moz-a');

    const after = await loadFurnaceState(root);
    expect(after.appliedChecksums?.['override/moz-a/moz-a.css']).not.toBe(
      before.appliedChecksums?.['override/moz-a/moz-a.css']
    );
    expect(after.appliedChecksums?.['override/moz-b/moz-b.css']).toBe(
      before.appliedChecksums?.['override/moz-b/moz-b.css']
    );
    expect(await readFile(engineCss('moz-a'), 'utf8')).toContain('a2');
  });

  it('a full apply replaces the whole record', async () => {
    await persistAppliedComponentChecksums(
      root,
      new Map([['override/gone/gone.css', 'deadbeef']]),
      undefined
    );
    await persistAppliedComponentChecksums(
      root,
      new Map([['override/moz-a/moz-a.css', 'cafe']]),
      undefined
    );
    expect((await loadFurnaceState(root)).appliedChecksums).toEqual({
      'override/moz-a/moz-a.css': 'cafe',
    });
  });

  it('a named run replaces only its component keys, not a peer whose name prefixes it', async () => {
    await persistAppliedComponentChecksums(
      root,
      new Map([
        ['override/moz-a/moz-a.css', '1'],
        ['override/moz-a-wide/moz-a-wide.css', '2'],
      ]),
      undefined
    );
    await persistAppliedComponentChecksums(
      root,
      new Map([['override/moz-a/moz-a.css', '3']]),
      'moz-a'
    );
    expect((await loadFurnaceState(root)).appliedChecksums).toEqual({
      'override/moz-a/moz-a.css': '3',
      'override/moz-a-wide/moz-a-wide.css': '2',
    });
  });

  it('commits a persisted unit, so a later failure in the same mutation keeps it', async () => {
    await expect(
      runFurnaceMutation(root, 'deploy-rollback', async (ctx) => {
        await applyAllComponents(root, false, { operationContext: ctx, componentName: 'moz-a' });
        throw new Error('second unit refused');
      })
    ).rejects.toThrow('second unit refused');

    // The unit's files and its record agree after the failure.
    expect(await readFile(engineCss('moz-a'), 'utf8')).toContain('a1');
    expect((await loadFurnaceState(root)).appliedChecksums).toHaveProperty(
      'override/moz-a/moz-a.css'
    );
  });

  describe('listStaleFurnaceComponents', () => {
    it('names components never deployed, then none once applied', async () => {
      expect(await describeStaleFurnaceComponents(root)).toEqual([
        { name: 'moz-a', reason: 'never-deployed' },
        { name: 'moz-b', reason: 'never-deployed' },
      ]);
      await runFurnaceMutation(root, 'apply-rollback', (ctx) =>
        applyAllComponents(root, false, { operationContext: ctx })
      );
      expect(await listStaleFurnaceComponents(root)).toEqual([]);
    });

    it('names an edited source and an engine copy erased behind the record', async () => {
      await runFurnaceMutation(root, 'apply-rollback', (ctx) =>
        applyAllComponents(root, false, { operationContext: ctx })
      );
      await writeFile(sourceCss('moz-a'), ':host { color: a2; }\n');
      await rm(engineCss('moz-b'));

      expect(await describeStaleFurnaceComponents(root)).toEqual([
        { name: 'moz-a', reason: 'source-edited' },
        { name: 'moz-b', reason: 'engine-differs' },
      ]);
    });

    it('still lists a component after the record is cleared and the sources are unchanged', async () => {
      await runFurnaceMutation(root, 'apply-rollback', (ctx) =>
        applyAllComponents(root, false, { operationContext: ctx })
      );
      await writeFile(getFurnacePaths(root).furnaceState, '{}\n');
      expect(await listStaleFurnaceComponents(root)).toEqual(['moz-a', 'moz-b']);
    });
  });

  describe('component source guard', () => {
    async function snapshot(): ReturnType<typeof captureComponentSources> {
      const config = await loadFurnaceConfig(root);
      return captureComponentSources(getFurnacePaths(root), config, false);
    }

    it('blames a mid-walk edit of an applied component', async () => {
      const captured = await snapshot();
      await writeFile(sourceCss('moz-a'), ':host { color: torn; }\n');
      const { errors, foreign } = await componentSourceChanges(captured, new Set(['moz-a']));
      expect(errors).toHaveLength(1);
      expect(errors[0]?.error).toContain('moz-a.css');
      expect(foreign).toEqual([]);
    });

    it('only names a peer component the run did not apply, without failing the run', async () => {
      const captured = await snapshot();
      await writeFile(sourceCss('moz-b'), ':host { color: peer-edit; }\n');
      const { errors, foreign } = await componentSourceChanges(captured, new Set(['moz-a']));
      expect(errors).toEqual([]);
      expect(foreign).toEqual(['moz-b']);
    });

    it('treats a shared fragment edit as blocking only when something was applied', async () => {
      const shared = getFurnacePaths(root).sharedDir;
      await mkdir(shared, { recursive: true });
      const captured = await snapshot();
      await writeFile(join(shared, 'fragment.css'), '.x { color: red; }\n');
      expect((await componentSourceChanges(captured, new Set(['moz-a']))).errors).toHaveLength(1);
      expect((await componentSourceChanges(captured, new Set())).errors).toEqual([]);
    });

    it('reports nothing for a dry run snapshot', async () => {
      await expect(componentSourceChanges(undefined, new Set(['moz-a']))).resolves.toEqual({
        errors: [],
        foreign: [],
      });
    });

    it('does not fail an apply whose own components were untouched by a peer edit', async () => {
      // moz-b is skipped as already current; a peer edit to it after the run
      // captured sources must leave the run green. The guard sees it as foreign.
      await runFurnaceMutation(root, 'apply-rollback', (ctx) =>
        applyAllComponents(root, false, { operationContext: ctx })
      );
      const captured = await snapshot();
      await writeFile(sourceCss('moz-b'), ':host { color: b-edited-by-peer; }\n');
      const changes = await componentSourceChanges(captured, new Set());
      expect(changes.errors).toEqual([]);
      expect(changes.foreign).toEqual(['moz-b']);
    });
  });
});
