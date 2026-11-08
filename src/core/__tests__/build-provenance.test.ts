// SPDX-License-Identifier: EUPL-1.2
/**
 * Whether the objdir is the tree's, against a real git checkout, real mtimes and
 * a real build record: what `fireforge package` and `fireforge run` go by.
 */
import { utimes } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  writeFiles,
} from '../../test-utils/index.js';
import { writeBuildBaseline } from '../build-baseline.js';
import { assessBuildProvenance } from '../build-provenance.js';

vi.mock('../../utils/logger.js', async () =>
  (await import('../../test-utils/module-mocks.js')).createLoggerMock()
);

const OBJ = 'obj-test';
const BINARY = `${OBJ}/dist/bin/mybrowser`;
const CPP = 'gfx/layers/Thing.cpp';
const JS = 'browser/base/content/thing.js';

let root: string;
let engine: string;

async function age(path: string, seconds: number): Promise<void> {
  await utimes(join(engine, path), seconds, seconds);
}

async function record(
  overrides: Parameters<typeof writeBuildBaseline>[0] | object = {}
): Promise<void> {
  await writeBuildBaseline({
    projectRoot: root,
    engineDir: engine,
    binaryName: 'mybrowser',
    ...overrides,
  });
}

beforeEach(async () => {
  root = await createTempProject('ff-build-provenance-');
  engine = join(root, 'engine');
  await initCommittedRepo(engine, {
    '.gitignore': `${OBJ}/\n`,
    [CPP]: 'int x;\n',
    [JS]: 'const x = 1;\n',
  });
  await writeFiles(engine, { [BINARY]: 'binary', [`${OBJ}/dist/bin/libxul.dylib`]: 'lib' });
  await age(CPP, 1_000);
  await age(BINARY, 2_000);
  await age(`${OBJ}/dist/bin/libxul.dylib`, 2_000);
});

afterEach(async () => {
  await removeTempProject(root);
});

describe('assessBuildProvenance', () => {
  it('finds nothing wrong with the build the tree just got', async () => {
    await record();
    await expect(assessBuildProvenance(root, engine, BINARY)).resolves.toEqual({});
  });

  it('says so when no build is recorded', async () => {
    const found = await assessBuildProvenance(root, engine, BINARY);
    expect(found.noBaseline).toContain('No successful fireforge build');
  });

  it('names a binary that still carries a negative control', async () => {
    await record({
      controlBuild: { diffFile: 'c.diff', targets: [CPP], appliedAt: '2026-10-22T10:00:00.000Z' },
    });
    const found = await assessBuildProvenance(root, engine, BINARY);
    expect(found.controlBuilt).toContain('c.diff');
    expect(found.controlBuilt).toContain(`engine/${CPP}`);
  });

  it('names a compiled source edited after the last link', async () => {
    await record();
    await writeFiles(engine, { [CPP]: 'int y;\n' });
    await age(CPP, 3_000);
    const found = await assessBuildProvenance(root, engine, BINARY);
    expect(found.stale?.join('\n')).toContain(`engine/${CPP}`);
  });

  it('names a packaged file edited since the build', async () => {
    await record();
    await writeFiles(engine, { [JS]: 'const x = 2;\n' });
    const found = await assessBuildProvenance(root, engine, BINARY);
    expect(found.stale?.join('\n')).toContain(JS);
  });
});
