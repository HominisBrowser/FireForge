// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn(() => Promise.resolve({ binaryName: 'mybrowser' })),
}));

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { loadConfig } from '../../core/config.js';
import { createRollbackJournal } from '../../core/furnace-rollback.js';
import { pathExists } from '../../utils/fs.js';
import { info, warn } from '../../utils/logger.js';
import { renameXpcshellTestFiles } from '../furnace/rename-xpcshell.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadConfig).mockResolvedValue({ binaryName: 'mybrowser' } as never);
});

async function makeEngineWithScaffold(): Promise<{ root: string; engineDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'fireforge-xpcshell-'));
  cleanupPaths.push(root);
  const engineDir = join(root, 'engine');
  const scaffoldDir = join(
    engineDir,
    'browser/base/content/test/mybrowser-xpcshell/moz-old-widget'
  );
  await mkdir(scaffoldDir, { recursive: true });
  await writeFile(
    join(scaffoldDir, 'xpcshell.toml'),
    '["test_moz_old_widget_packaged.js"]\nhead = "head.js"\n'
  );
  await writeFile(
    join(scaffoldDir, 'test_moz_old_widget_packaged.js'),
    'const tag = "moz-old-widget";\nconst id = "moz_old_widget";\nconst longer = "moz-old-widget-extra moz_old_widget_extra";\n'
  );
  await writeFile(join(scaffoldDir, 'head.js'), '// helper mentions moz-old-widget\n');
  return { root, engineDir };
}

describe('renameXpcshellTestFiles', () => {
  it('renames the scaffold directory, manifest header, test filename, and test body', async () => {
    const { root, engineDir } = await makeEngineWithScaffold();

    await renameXpcshellTestFiles(
      engineDir,
      root,
      'moz-old-widget',
      'moz-new-widget',
      createRollbackJournal()
    );

    const newDir = join(engineDir, 'browser/base/content/test/mybrowser-xpcshell/moz-new-widget');
    expect(await pathExists(newDir)).toBe(true);
    expect(
      await pathExists(
        join(engineDir, 'browser/base/content/test/mybrowser-xpcshell/moz-old-widget')
      )
    ).toBe(false);

    await expect(readFile(join(newDir, 'xpcshell.toml'), 'utf8')).resolves.toContain(
      '["test_moz_new_widget_packaged.js"]'
    );
    const body = await readFile(join(newDir, 'test_moz_new_widget_packaged.js'), 'utf8');
    expect(body).toContain('"moz-new-widget"');
    expect(body).toContain('"moz_new_widget"');
    expect(body).toContain('moz-old-widget-extra');
    expect(body).toContain('moz_old_widget_extra');
    await expect(readFile(join(newDir, 'head.js'), 'utf8')).resolves.toContain('moz-old-widget');
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('Renamed xpcshell scaffold directory')
    );
  });

  it('returns without warning when project config cannot be loaded', async () => {
    const { root, engineDir } = await makeEngineWithScaffold();
    vi.mocked(loadConfig).mockRejectedValueOnce(new Error('missing config'));

    await renameXpcshellTestFiles(
      engineDir,
      root,
      'moz-old-widget',
      'moz-new-widget',
      createRollbackJournal()
    );

    expect(warn).not.toHaveBeenCalled();
    expect(
      await pathExists(
        join(engineDir, 'browser/base/content/test/mybrowser-xpcshell/moz-old-widget')
      )
    ).toBe(true);
  });

  it('returns without warning when the xpcshell parent directory is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fireforge-xpcshell-missing-'));
    cleanupPaths.push(root);

    await renameXpcshellTestFiles(
      join(root, 'engine'),
      root,
      'moz-old-widget',
      'moz-new-widget',
      createRollbackJournal()
    );

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and leaves the original scaffold when the target path is blocked', async () => {
    const { root, engineDir } = await makeEngineWithScaffold();
    const blockedTarget = join(
      engineDir,
      'browser/base/content/test/mybrowser-xpcshell/moz-new-widget'
    );
    await writeFile(blockedTarget, 'not a directory');

    await renameXpcshellTestFiles(
      engineDir,
      root,
      'moz-old-widget',
      'moz-new-widget',
      createRollbackJournal()
    );

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not rename xpcshell scaffold')
    );
    expect(
      await pathExists(
        join(engineDir, 'browser/base/content/test/mybrowser-xpcshell/moz-old-widget')
      )
    ).toBe(true);
  });
});
