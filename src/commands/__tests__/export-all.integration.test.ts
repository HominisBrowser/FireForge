// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadPatchesManifest } from '../../core/patch-manifest.js';
import {
  FIREFOX_WORKFLOW_FIXTURES,
  FIREFOX_WORKFLOW_SETUP_OPTIONS,
} from '../../test-utils/firefox-workflow-fixtures.js';
import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
} from '../../test-utils/index.js';
import { exportAllCommand } from '../export-all.js';
import { setupCommand } from '../setup.js';

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  cancel: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
  note: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  spinner: vi.fn(() => ({
    message: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('export-all lint integration', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject('fireforge-export-all-integration-');
    await setupCommand(projectRoot, { ...FIREFOX_WORKFLOW_SETUP_OPTIONS, force: true });
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('export-all blocks when lint finds errors', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.sysMjsLintViolations;
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/modules/mybrowser/.gitkeep': '',
    });
    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);

    await expect(
      exportAllCommand(projectRoot, {
        name: 'lint-error-test',
        category: 'infra',
        description: 'Should fail due to lint errors',
      })
    ).rejects.toThrow('error');
  });

  it('export-all succeeds with --skipLint despite lint errors', async () => {
    const fixture = FIREFOX_WORKFLOW_FIXTURES.sysMjsLintViolations;
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/modules/mybrowser/.gitkeep': '',
    });
    await writeFiles(join(projectRoot, 'engine'), fixture.modifiedFiles);

    await exportAllCommand(projectRoot, {
      name: 'skip-lint-test',
      category: 'infra',
      description: 'Should succeed with skipLint',
      skipLint: true,
    });

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifest?.patches).toHaveLength(1);
    expect(manifest?.patches[0]?.name).toBe('skip-lint-test');
  });

  it('export-all succeeds with warnings only', async () => {
    // CSS with license header but raw hex color — triggers raw-color-value warning only
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/themes/shared/.gitkeep': '',
    });
    await writeFiles(join(projectRoot, 'engine'), {
      'browser/themes/shared/warn-only.css': [
        '/* SPDX-License-Identifier: EUPL-1.2 */',
        '',
        '.panel { background: #ff6600; }',
        '',
      ].join('\n'),
    });

    await exportAllCommand(projectRoot, {
      name: 'warning-only-test',
      category: 'ui',
      description: 'Should succeed with warnings only',
    });

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifest?.patches).toHaveLength(1);
    expect(manifest?.patches[0]?.name).toBe('warning-only-test');
  });

  it('export-all refuses branding-managed file changes', async () => {
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/moz.configure': 'imply_option("MOZ_APP_VENDOR", "Mozilla")\n',
    });
    // Modify the branding-managed moz.configure file
    await writeFiles(join(projectRoot, 'engine'), {
      'browser/moz.configure': 'imply_option("MOZ_APP_VENDOR", "My Company")\n',
    });

    await expect(
      exportAllCommand(projectRoot, {
        name: 'branding-test',
        category: 'infra',
        description: 'Should be rejected',
      })
    ).rejects.toThrow('branding');
  });

  it('export-all reports no changes when engine is clean', async () => {
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/base/content/browser.js': 'export const title = "unchanged";\n',
    });

    // No modifications — should return cleanly
    await expect(
      exportAllCommand(projectRoot, {
        name: 'empty-test',
        category: 'ui',
        description: 'Nothing to export',
      })
    ).resolves.toBeUndefined();
  });
});
