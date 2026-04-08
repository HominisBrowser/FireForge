// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeProjectPaths } from '../../test-utils/index.js';

vi.mock('../../core/config.js', () => ({
  getProjectPaths: vi.fn(),
  loadConfig: vi.fn(),
}));

vi.mock('../../core/browser-wire.js', () => ({
  wireSubscript: vi.fn(),
  DEFAULT_BROWSER_SUBSCRIPT_DIR: 'browser/base/content',
}));

vi.mock('../../core/parser-fallback.js', () => ({
  consumeParserFallbackEvents: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  verbose: vi.fn(),
  warn: vi.fn(),
}));

import { wireSubscript } from '../../core/browser-wire.js';
import { getProjectPaths, loadConfig } from '../../core/config.js';
import { consumeParserFallbackEvents } from '../../core/parser-fallback.js';
import { pathExists } from '../../utils/fs.js';
import { info, outro, success, warn } from '../../utils/logger.js';
import { wireCommand } from '../wire.js';

describe('wireCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectPaths).mockReturnValue(makeProjectPaths());
    vi.mocked(loadConfig).mockResolvedValue({
      wire: { subscriptDir: 'browser/components/custom' },
    } as never);
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(consumeParserFallbackEvents).mockReturnValue([]);
    vi.mocked(wireSubscript).mockResolvedValue({
      subscriptAdded: true,
      initAdded: true,
      destroyAdded: false,
      domInserted: true,
      jarMnResult: {
        manifest: 'browser/base/jar.mn',
        entry: 'content/browser/panel.js',
        skipped: false,
      },
    });
  });

  it('shows an accurate dry-run plan using the configured subscript directory', async () => {
    await expect(
      wireCommand('/project', 'panel', {
        init: 'Panel.init()',
        destroy: 'Panel.destroy()',
        dom: '/project/engine/browser/base/content/fragments/panel.inc.xhtml',
        dryRun: true,
      })
    ).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledWith('[dry-run] Would wire subscript:');
    expect(info).toHaveBeenCalledWith('  source: browser/components/custom/panel.js');
    expect(info).toHaveBeenCalledWith(
      '  browser-main.js: loadSubScript("chrome://browser/content/panel.js")'
    );
    expect(info).toHaveBeenCalledWith('  browser-init.js: Panel.init()');
    expect(info).toHaveBeenCalledWith('  browser-init.js onUnload(): Panel.destroy()');
    expect(info).toHaveBeenCalledWith(
      '  browser.xhtml: #include ../../base/content/fragments/panel.inc.xhtml'
    );
    expect(info).toHaveBeenCalledWith(
      '  jar.mn: content/browser/panel.js (../components/custom/panel.js)'
    );
    expect(outro).toHaveBeenCalledWith('Dry run complete');
    expect(wireSubscript).not.toHaveBeenCalled();
  });

  it('validates the DOM fragment path before wiring', async () => {
    vi.mocked(pathExists).mockImplementation((value) =>
      Promise.resolve(value !== '/project/engine/browser/base/content/fragments/panel.inc.xhtml')
    );

    await expect(
      wireCommand('/project', 'panel', {
        dom: '/project/engine/browser/base/content/fragments/panel.inc.xhtml',
      })
    ).rejects.toThrow(
      'DOM fragment file not found: /project/engine/browser/base/content/fragments/panel.inc.xhtml'
    );

    expect(wireSubscript).not.toHaveBeenCalled();
  });

  it('rejects DOM fragment files outside engine/', async () => {
    await expect(
      wireCommand('/project', 'panel', {
        dom: '/tmp/panel.inc.xhtml',
      })
    ).rejects.toThrow('DOM fragment file must stay within engine/: /tmp/panel.inc.xhtml');

    expect(wireSubscript).not.toHaveBeenCalled();
  });

  it('rejects subscript directories that escape engine/', async () => {
    await expect(
      wireCommand('/project', 'panel', {
        subscriptDir: '../outside',
      })
    ).rejects.toThrow('Subscript directory must stay within engine/: ../outside');

    expect(wireSubscript).not.toHaveBeenCalled();
  });

  it('normalizes inputs for wireSubscript and reports applied versus skipped changes', async () => {
    vi.mocked(wireSubscript).mockResolvedValue({
      subscriptAdded: false,
      initAdded: false,
      destroyAdded: true,
      domInserted: false,
      jarMnResult: {
        manifest: 'browser/base/jar.mn',
        entry: 'content/browser/panel.js',
        skipped: true,
      },
    });

    await expect(
      wireCommand('/project', 'panel', {
        init: 'Panel.init()',
        destroy: 'Panel.destroy()',
        after: 'existing-panel',
        subscriptDir: 'browser/base/content/custom',
        dom: '/project/engine/browser/base/content/fragments/panel.inc.xhtml',
      })
    ).resolves.toBeUndefined();

    expect(wireSubscript).toHaveBeenCalledWith('/project', 'panel', {
      init: 'Panel.init()',
      destroy: 'Panel.destroy()',
      domFilePath: 'browser/base/content/fragments/panel.inc.xhtml',
      after: 'existing-panel',
      subscriptDir: 'browser/base/content/custom',
      dryRun: false,
    });
    expect(info).toHaveBeenCalledWith('panel.js already registered in browser-main.js (skipped)');
    expect(info).toHaveBeenCalledWith(
      'Init expression already present in browser-init.js (skipped)'
    );
    expect(success).toHaveBeenCalledWith('Added destroy expression to browser-init.js onUnload()');
    expect(info).toHaveBeenCalledWith(
      '#include directive already present in browser.xhtml (skipped)'
    );
    expect(info).toHaveBeenCalledWith('panel.js already registered in jar.mn (skipped)');
    expect(outro).toHaveBeenCalledWith('Wiring complete');
  });

  it('surfaces parser fallback usage when wiring had to use the legacy path', async () => {
    vi.mocked(consumeParserFallbackEvents)
      .mockReturnValueOnce([])
      .mockReturnValueOnce([{ context: 'browser/base/jar.mn', reason: 'parse failed' }]);

    await expect(wireCommand('/project', 'panel')).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledWith(
      'Legacy parser fallback was used for 1 file: browser/base/jar.mn'
    );
  });

  it('warns when config fails to load and falls back to default subscript directory', async () => {
    vi.mocked(loadConfig).mockRejectedValue(new Error('parse error'));

    await expect(wireCommand('/project', 'panel')).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('fireforge.json could not be loaded')
    );
    // subscriptDir is omitted when it equals the default, confirming the fallback was used
    expect(wireSubscript).toHaveBeenCalledWith(
      '/project',
      'panel',
      expect.not.objectContaining({ subscriptDir: expect.any(String) as unknown })
    );
  });
});
