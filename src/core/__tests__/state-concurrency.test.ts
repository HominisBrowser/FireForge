// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTempProject,
  readText,
  removeTempProject,
  writeFiles,
} from '../../test-utils/index.js';
import { loadState, saveState, updateState } from '../config.js';

describe('project state persistence', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('fireforge-state-test-');
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('serializes concurrent state updates so fields are not silently lost', async () => {
    await saveState(projectRoot, { baseCommit: 'abc123' });

    await Promise.all([
      updateState(projectRoot, { buildMode: 'debug' }),
      updateState(projectRoot, { downloadedVersion: '140.0esr' }),
    ]);

    await expect(loadState(projectRoot)).resolves.toEqual({
      baseCommit: 'abc123',
      buildMode: 'debug',
      downloadedVersion: '140.0esr',
    });
  });

  it('quarantines invalid state files and rewrites salvaged valid fields', async () => {
    await writeFiles(projectRoot, {
      '.fireforge/state.json': `${JSON.stringify({ baseCommit: 'base-1', buildMode: 42 }, null, 2)}\n`,
    });

    await expect(loadState(projectRoot)).resolves.toEqual({ baseCommit: 'base-1' });

    await expect(readText(projectRoot, '.fireforge/state.json')).resolves.toBe(
      '{\n  "baseCommit": "base-1"\n}\n'
    );

    const fireforgeEntries = await readdir(join(projectRoot, '.fireforge'));
    expect(fireforgeEntries.some((entry) => entry.startsWith('state.json.corrupt-'))).toBe(true);
  });
});
