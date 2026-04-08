// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeProjectPaths } from '../../test-utils/index.js';

vi.mock('../../core/config.js', () => ({
  getProjectPaths: vi.fn(),
}));

vi.mock('../../core/manifest-rules.js', () => ({
  registerFile: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

import { getProjectPaths } from '../../core/config.js';
import { registerFile } from '../../core/manifest-rules.js';
import { pathExists } from '../../utils/fs.js';
import { info, outro, success, warn } from '../../utils/logger.js';
import { registerCommand } from '../register.js';

describe('registerCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectPaths).mockReturnValue(makeProjectPaths());
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(registerFile).mockResolvedValue({
      manifest: 'browser/base/jar.mn',
      entry: 'content/browser/new-widget.js',
      skipped: false,
    });
  });

  it('skips file existence checks during dry-run and reports the planned registration', async () => {
    vi.mocked(registerFile).mockResolvedValue({
      manifest: 'browser/base/jar.mn',
      entry: 'content/browser/new-widget.js',
      previousEntry: 'content/browser/browser.js',
      afterFallback: true,
      skipped: false,
    });

    await expect(
      registerCommand('/project', 'browser/base/content/new-widget.js', {
        dryRun: true,
        after: 'missing-entry',
      })
    ).resolves.toBeUndefined();

    expect(pathExists).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      '[dry-run] Would register browser/base/content/new-widget.js'
    );
    expect(info).toHaveBeenCalledWith('  manifest: browser/base/jar.mn');
    expect(info).toHaveBeenCalledWith('  entry: content/browser/new-widget.js');
    expect(info).toHaveBeenCalledWith('  insert after: content/browser/browser.js');
    expect(warn).toHaveBeenCalledWith(
      '--after target "missing-entry" not found, falling back to alphabetical order'
    );
    expect(outro).toHaveBeenCalledWith('Dry run complete');
  });

  it('validates that the target file exists for real registrations', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(registerCommand('/project', 'browser/base/content/new-widget.js')).rejects.toThrow(
      'File not found in engine: browser/base/content/new-widget.js'
    );

    expect(registerFile).not.toHaveBeenCalled();
  });

  it('reports successful registrations with the insertion position and build hint', async () => {
    vi.mocked(registerFile).mockResolvedValue({
      manifest: 'browser/base/jar.mn',
      entry: 'content/browser/new-widget.js',
      previousEntry: 'content/browser/browser.js',
      skipped: false,
    });

    await expect(
      registerCommand('/project', 'browser/base/content/new-widget.js')
    ).resolves.toBeUndefined();

    expect(success).toHaveBeenCalledWith(
      'Registered browser/base/content/new-widget.js in browser/base/jar.mn (after content/browser/browser.js)'
    );
    expect(info).toHaveBeenCalledWith(
      "hint: Run 'fireforge build --ui' to make the new module available at runtime"
    );
    expect(outro).toHaveBeenCalledWith('Done');
  });
});
