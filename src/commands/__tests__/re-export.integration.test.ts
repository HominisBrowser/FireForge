// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  git,
  initCommittedRepo,
  readText,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { reExportCommand } from '../re-export.js';

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  spinner: vi.fn(() => ({
    message: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
  })),
}));

function makeManifest(): string {
  return `${JSON.stringify(
    {
      version: 1,
      patches: [
        {
          filename: '001-ui-test.patch',
          order: 1,
          category: 'ui',
          name: 'test',
          description: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          sourceEsrVersion: '140.0esr',
          filesAffected: ['tracked.txt'],
        },
      ],
    },
    null,
    2
  )}\n`;
}

describe('reExportCommand integration', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject();
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'tracked.txt': 'original\n',
    });
    await writeFiles(projectRoot, {
      'patches/patches.json': makeManifest(),
      'patches/001-ui-test.patch': 'diff --git a/tracked.txt b/tracked.txt\n',
    });
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('preserves preexisting staged state while re-exporting', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      'tracked.txt': 'changed\n',
    });
    await git(join(projectRoot, 'engine'), ['add', 'tracked.txt']);

    await expect(git(join(projectRoot, 'engine'), ['status', '--short'])).resolves.toBe(
      'M  tracked.txt\n'
    );

    await reExportCommand(projectRoot, ['001'], {});

    await expect(git(join(projectRoot, 'engine'), ['status', '--short'])).resolves.toBe(
      'M  tracked.txt\n'
    );
    await expect(readText(projectRoot, 'patches/001-ui-test.patch')).resolves.toContain('+changed');
  });

  it('keeps dry-run side effect free for both git state and patch files', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      'tracked.txt': 'changed\n',
    });
    await git(join(projectRoot, 'engine'), ['add', 'tracked.txt']);

    const beforePatch = await readText(projectRoot, 'patches/001-ui-test.patch');

    await reExportCommand(projectRoot, ['001'], { dryRun: true });

    await expect(git(join(projectRoot, 'engine'), ['status', '--short'])).resolves.toBe(
      'M  tracked.txt\n'
    );
    await expect(readText(projectRoot, 'patches/001-ui-test.patch')).resolves.toBe(beforePatch);
    await expect(readText(projectRoot, 'patches/patches.json')).resolves.toBe(makeManifest());
  });
});
