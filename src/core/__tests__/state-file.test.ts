// SPDX-License-Identifier: EUPL-1.2
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import { pathExists } from '../../utils/fs.js';
import { quarantineStateFile, withStateFileLock } from '../state-file.js';

let root: string;
let statePath: string;

beforeEach(async () => {
  root = await createTempProject('fireforge-state-file-');
  statePath = join(root, '.fireforge', 'state.json');
  await mkdir(dirname(statePath), { recursive: true });
});

afterEach(async () => {
  await removeTempProject(root);
});

describe('withStateFileLock', () => {
  it('holds a sidecar lock beside the state file while the operation runs and releases it after', async () => {
    let lockedDuringOperation: string[] = [];

    const result = await withStateFileLock(statePath, async () => {
      lockedDuringOperation = (await readdir(dirname(statePath))).filter((entry) =>
        entry.includes('.fireforge-state.lock')
      );
      return 'done';
    });

    expect(result).toBe('done');
    expect(lockedDuringOperation).toHaveLength(1);
    // The lock is a sidecar of the state file, not the state file itself.
    expect(await pathExists(statePath)).toBe(false);
    // Released once the operation resolves, so the next writer is not blocked.
    const afterRelease = (await readdir(dirname(statePath))).filter((entry) =>
      entry.includes('.fireforge-state.lock')
    );
    expect(afterRelease).toEqual([]);
  });
});

describe('quarantineStateFile', () => {
  it('returns undefined when file does not exist', async () => {
    await expect(quarantineStateFile(statePath)).resolves.toBeUndefined();
  });

  it('renames file with corrupt-timestamp suffix and returns basename', async () => {
    await writeFile(statePath, '{ broken');

    const result = await quarantineStateFile(statePath);

    expect(result).toMatch(/^state\.json\.corrupt-\d{4}-\d{2}-\d{2}T/);
    expect(await pathExists(statePath)).toBe(false);
    expect(await readFile(join(dirname(statePath), result ?? ''), 'utf8')).toBe('{ broken');
  });

  it('uses custom reason in quarantined filename', async () => {
    await writeFile(statePath, '{}');

    const result = await quarantineStateFile(statePath, 'migration-failed');

    expect(result).toContain('migration-failed');
  });
});
