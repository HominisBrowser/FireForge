// SPDX-License-Identifier: EUPL-1.2
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  git,
  initCommittedRepo,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { furnaceApplyCommand } from '../furnace/apply.js';
import { furnaceDeployCommand } from '../furnace/deploy.js';

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

const FURNACE_CONFIG = {
  version: 1,
  componentPrefix: 'moz-',
  stock: [],
  overrides: {},
  custom: {
    'moz-audit-widget': {
      description: 'Audit widget',
      targetPath: 'browser/components/audit',
      register: true,
      localized: false,
    },
  },
} as const;

describe('Furnace rollback integration', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject();

    await writeFireForgeConfig(projectRoot);
    await writeFiles(projectRoot, {
      'furnace.json': `${JSON.stringify(FURNACE_CONFIG, null, 2)}\n`,
      'components/custom/moz-audit-widget/moz-audit-widget.mjs':
        'export class MozAuditWidget extends HTMLElement {}\n',
      'components/custom/moz-audit-widget/moz-audit-widget.css': ':host { display: block; }\n',
    });
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'README.txt': 'baseline\n',
    });
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  async function expectEngineRolledBack(): Promise<void> {
    await expect(
      access(join(projectRoot, 'engine', 'browser', 'components', 'audit', 'moz-audit-widget.mjs'))
    ).rejects.toThrow();
    await expect(access(join(projectRoot, '.fireforge', 'furnace-state.json'))).rejects.toThrow();
    await expect(git(join(projectRoot, 'engine'), ['status', '--short'])).resolves.toBe('');
  }

  it('restores touched engine files when furnace apply hits registration step errors', async () => {
    await expect(furnaceApplyCommand(projectRoot)).rejects.toThrow(/failed to apply cleanly/i);

    await expectEngineRolledBack();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('customElements.js registration')
    );
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('jar.mn registration'));
  });

  it('restores touched files for single-component deploy failures and skips state persistence', async () => {
    await expect(furnaceDeployCommand(projectRoot, 'moz-audit-widget')).rejects.toThrow(
      /apply error\(s\)/i
    );

    await expectEngineRolledBack();
    expect(logger.warn).toHaveBeenCalledWith(
      'Skipping validation for moz-audit-widget because apply failed.'
    );
  });
});
