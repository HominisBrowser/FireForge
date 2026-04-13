// SPDX-License-Identifier: EUPL-1.2
import { chmod, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import * as fsUtils from '../../utils/fs.js';
import { furnaceApplyCommand } from '../furnace/apply.js';

const logger = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  note: vi.fn(),
  spinner: vi.fn(() => ({
    stop: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  })),
}));

vi.mock('../../utils/logger.js', () => logger);

// Spy on the real copyFile so we can inject a fault after the first call.
vi.mock('../../utils/fs.js', async () => {
  const actual = await vi.importActual<typeof import('../../utils/fs.js')>('../../utils/fs.js');
  return {
    ...actual,
    copyFile: vi.fn(actual.copyFile),
  };
});

const FURNACE_CONFIG = {
  version: 1,
  componentPrefix: 'moz-',
  stock: [],
  overrides: {
    'moz-button': {
      type: 'css-only',
      description: 'Recolour moz-button',
      basePath: 'toolkit/content/widgets/moz-button',
      baseVersion: '146.0esr',
    },
    'moz-toggle': {
      type: 'css-only',
      description: 'Restyle moz-toggle',
      basePath: 'toolkit/content/widgets/moz-toggle',
      baseVersion: '146.0esr',
    },
  },
  custom: {},
} as const;

describe('Furnace fault injection (integration)', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject('fireforge-fault-');

    await writeFireForgeConfig(projectRoot);
    await writeFiles(projectRoot, {
      'furnace.json': `${JSON.stringify(FURNACE_CONFIG, null, 2)}\n`,
      'components/overrides/moz-button/moz-button.css': ':host { background: black; }\n',
      'components/overrides/moz-button/override.json': JSON.stringify({
        type: 'css-only',
        description: 'Recolour moz-button',
        basePath: 'toolkit/content/widgets/moz-button',
        baseVersion: '146.0esr',
      }),
      'components/overrides/moz-toggle/moz-toggle.css': ':host { opacity: 0.5; }\n',
      'components/overrides/moz-toggle/override.json': JSON.stringify({
        type: 'css-only',
        description: 'Restyle moz-toggle',
        basePath: 'toolkit/content/widgets/moz-toggle',
        baseVersion: '146.0esr',
      }),
    });

    await initCommittedRepo(join(projectRoot, 'engine'), {
      'toolkit/content/widgets/moz-button/moz-button.css': ':host { background: white; }\n',
      'toolkit/content/widgets/moz-toggle/moz-toggle.css': ':host { opacity: 1; }\n',
      'README.txt': 'engine baseline\n',
    });
  });

  afterEach(async () => {
    restoreTTY?.();
    // Ensure all directories are writable before cleanup.
    try {
      await chmod(join(projectRoot, 'engine', 'toolkit/content/widgets/moz-toggle'), 0o755);
    } catch {
      // May not exist if test didn't reach the chmod step.
    }
    await removeTempProject(projectRoot);
  });

  it('rolls back already-copied files when a mid-apply EACCES halts the batch', async () => {
    const buttonCssEngine = join(
      projectRoot,
      'engine',
      'toolkit/content/widgets/moz-button/moz-button.css'
    );
    const toggleCssEngine = join(
      projectRoot,
      'engine',
      'toolkit/content/widgets/moz-toggle/moz-toggle.css'
    );

    const originalButtonCss = await readFile(buttonCssEngine, 'utf8');
    const originalToggleCss = await readFile(toggleCssEngine, 'utf8');

    // Inject EACCES on the second copyFile call (the toggle component), after
    // the button component has already been copied successfully.
    const copyFileSpy = vi.mocked(fsUtils.copyFile);
    let callCount = 0;
    copyFileSpy.mockImplementation(async (src: string, dest: string) => {
      callCount++;
      if (callCount >= 2) {
        const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      }
      const { copyFile: realCopyFile } =
        await vi.importActual<typeof import('../../utils/fs.js')>('../../utils/fs.js');
      return realCopyFile(src, dest);
    });

    await expect(furnaceApplyCommand(projectRoot)).rejects.toThrow();

    // The engine files must be back to their original (git baseline) content.
    // The button override was applied before the fault, so rollback must have
    // restored it; the toggle was never reached, so it should also be pristine.
    const buttonAfter = await readFile(buttonCssEngine, 'utf8');
    const toggleAfter = await readFile(toggleCssEngine, 'utf8');

    expect(buttonAfter).toBe(originalButtonCss);
    expect(toggleAfter).toBe(originalToggleCss);
  });
});
