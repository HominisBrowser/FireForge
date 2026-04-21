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

vi.mock('../../core/furnace-config.js', () => ({
  furnaceConfigExists: vi.fn(),
  loadFurnaceConfig: vi.fn(),
}));

vi.mock('../../core/parser-fallback.js', () => ({
  consumeParserFallbackEvents: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
  writeText: vi.fn(),
}));

// The dry-run/real-run parity probe added in 0.16.0 reads the chrome
// document from disk and runs the same insertion-point scan the real
// run uses. Every wire test in this file drives `pathExists` through a
// generic mock that says "yes, everything exists", so the probe would
// then try to read those files — we stub it out here to keep the focus
// on the command-level behaviours these tests already cover. A
// dedicated integration test pins the probe contract separately.
vi.mock('../../core/wire-dom-fragment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/wire-dom-fragment.js')>();
  return {
    ...actual,
    probeDomFragmentInsertionPoint: vi.fn().mockResolvedValue(undefined),
  };
});

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
import { furnaceConfigExists, loadFurnaceConfig } from '../../core/furnace-config.js';
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
    vi.mocked(furnaceConfigExists).mockResolvedValue(false);
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
    });
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
      '  browser/base/content/browser.xhtml: #include ../../base/content/fragments/panel.inc.xhtml'
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

  it('probes engine-relative --dom paths inside the engine root', async () => {
    // Engine-relative input must be joined with paths.engine before the
    // existence probe. Before the 0.16.0 fix, `pathExists` ran on the
    // bare engine-relative path and resolved against CWD, so operators
    // hit "DOM fragment file not found" for files that were correctly
    // placed inside engine/.
    await expect(
      wireCommand('/project', 'panel', {
        dom: 'browser/base/content/fragments/panel.inc.xhtml',
      })
    ).resolves.toBeUndefined();

    expect(pathExists).toHaveBeenCalledWith(
      '/project/engine/browser/base/content/fragments/panel.inc.xhtml'
    );
    expect(wireSubscript).toHaveBeenCalledWith(
      '/project',
      'panel',
      expect.objectContaining({
        domFilePath: 'browser/base/content/fragments/panel.inc.xhtml',
      })
    );
  });

  it('probes repo-root-relative --dom paths via stripEnginePrefix + engine join', async () => {
    // The `engine/`-prefixed form strips the prefix and then joins with
    // paths.engine, so the probe targets the same absolute path as the
    // engine-relative form above.
    await expect(
      wireCommand('/project', 'panel', {
        dom: 'engine/browser/base/content/fragments/panel.inc.xhtml',
      })
    ).resolves.toBeUndefined();

    expect(pathExists).toHaveBeenCalledWith(
      '/project/engine/browser/base/content/fragments/panel.inc.xhtml'
    );
    expect(wireSubscript).toHaveBeenCalledWith(
      '/project',
      'panel',
      expect.objectContaining({
        domFilePath: 'browser/base/content/fragments/panel.inc.xhtml',
      })
    );
  });

  it('probes absolute --dom paths as-is (no engine join)', async () => {
    // Absolute input already carries its full path; joining with engine
    // would produce a double-rooted garbage path. Regression guard so a
    // future refactor doesn't accidentally re-route absolutes through join.
    await expect(
      wireCommand('/project', 'panel', {
        dom: '/project/engine/browser/base/content/fragments/panel.inc.xhtml',
      })
    ).resolves.toBeUndefined();

    expect(pathExists).toHaveBeenCalledWith(
      '/project/engine/browser/base/content/fragments/panel.inc.xhtml'
    );
  });

  it('surfaces the original --dom input in the not-found error for engine-relative paths', async () => {
    // When the joined engine path does not exist, the error message
    // should echo the operator's original input (not the internal
    // joined path) — matching the existing absolute-input behaviour so
    // the error is copy-pasteable back into the CLI.
    vi.mocked(pathExists).mockImplementation((value) =>
      Promise.resolve(value !== '/project/engine/browser/base/content/fragments/missing.inc.xhtml')
    );

    await expect(
      wireCommand('/project', 'panel', {
        dom: 'browser/base/content/fragments/missing.inc.xhtml',
      })
    ).rejects.toThrow(
      'DOM fragment file not found: browser/base/content/fragments/missing.inc.xhtml'
    );

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
      '#include directive already present in browser/base/content/browser.xhtml (skipped)'
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

  it('resolves the DOM target from furnace.json tokenHostDocuments when present', async () => {
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
      tokenHostDocuments: ['browser/base/content/mybrowser-shell.xhtml'],
    });

    await expect(
      wireCommand('/project', 'panel', {
        dom: '/project/engine/browser/base/content/fragments/panel.inc.xhtml',
      })
    ).resolves.toBeUndefined();

    expect(wireSubscript).toHaveBeenCalledWith(
      '/project',
      'panel',
      expect.objectContaining({
        domFilePath: 'browser/base/content/fragments/panel.inc.xhtml',
        domTargetPath: 'browser/base/content/mybrowser-shell.xhtml',
      })
    );
    expect(success).toHaveBeenCalledWith(
      'Inserted #include directive into browser/base/content/mybrowser-shell.xhtml'
    );
  });

  it('--target overrides furnace.json tokenHostDocuments', async () => {
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
      tokenHostDocuments: ['browser/base/content/mybrowser-shell.xhtml'],
    });

    await expect(
      wireCommand('/project', 'panel', {
        dom: '/project/engine/browser/base/content/fragments/panel.inc.xhtml',
        target: 'browser/base/content/mybrowser.xhtml',
      })
    ).resolves.toBeUndefined();

    expect(wireSubscript).toHaveBeenCalledWith(
      '/project',
      'panel',
      expect.objectContaining({
        domTargetPath: 'browser/base/content/mybrowser.xhtml',
      })
    );
  });

  it('omits domTargetPath when the resolved target is the upstream default', async () => {
    await expect(
      wireCommand('/project', 'panel', {
        dom: '/project/engine/browser/base/content/fragments/panel.inc.xhtml',
      })
    ).resolves.toBeUndefined();

    // No furnace config and no --target: leave browser-wire's internal default alone
    expect(wireSubscript).toHaveBeenCalledWith(
      '/project',
      'panel',
      expect.not.objectContaining({ domTargetPath: expect.any(String) as unknown })
    );
  });

  it('rejects --target values that escape engine/', async () => {
    await expect(
      wireCommand('/project', 'panel', {
        dom: '/project/engine/browser/base/content/fragments/panel.inc.xhtml',
        target: '../outside.xhtml',
      })
    ).rejects.toThrow('Target chrome document must stay within engine/: ../outside.xhtml');

    expect(wireSubscript).not.toHaveBeenCalled();
  });

  it('fails with a pointer to tokenHostDocuments when the resolved target is missing', async () => {
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
      tokenHostDocuments: ['browser/base/content/mybrowser-shell.xhtml'],
    });
    vi.mocked(pathExists).mockImplementation((p: string) =>
      Promise.resolve(!p.includes('mybrowser-shell.xhtml'))
    );

    await expect(
      wireCommand('/project', 'panel', {
        dom: '/project/engine/browser/base/content/fragments/panel.inc.xhtml',
      })
    ).rejects.toThrow(/Chrome document not found.*tokenHostDocuments/s);

    expect(wireSubscript).not.toHaveBeenCalled();
  });

  it('falls through to the upstream default when furnace.json fails to load', async () => {
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
    vi.mocked(loadFurnaceConfig).mockRejectedValue(new Error('parse error'));

    await expect(
      wireCommand('/project', 'panel', {
        dom: '/project/engine/browser/base/content/fragments/panel.inc.xhtml',
      })
    ).resolves.toBeUndefined();

    // The broken furnace config was swallowed; the command proceeds with the
    // upstream default and does not emit domTargetPath to wireSubscript.
    expect(wireSubscript).toHaveBeenCalledWith(
      '/project',
      'panel',
      expect.not.objectContaining({ domTargetPath: expect.any(String) as unknown })
    );
  });

  it('rejects invalid init expressions in --dry-run with the same error as the real run', async () => {
    // Finding #7: pre-0.16.0 `wire --dry-run --init 'void 0'` previewed the
    // expression successfully even though the real run rejected `void 0`
    // (space characters fail the safe-interpolation regex). Validation now
    // runs up-front in both paths, so the preview no longer silently
    // promises a wiring the real command will refuse.
    await expect(
      wireCommand('/project', 'panel', { init: 'void 0', dryRun: true })
    ).rejects.toThrow(/Invalid init expression "void 0"/);
    expect(info).not.toHaveBeenCalledWith('[dry-run] Would wire subscript:');
  });

  it('rejects invalid destroy expressions in --dry-run', async () => {
    await expect(
      wireCommand('/project', 'panel', { destroy: 'void 0', dryRun: true })
    ).rejects.toThrow(/Invalid destroy expression "void 0"/);
  });

  it('coerces bare property chains to function calls in the dry-run preview', async () => {
    // Finding #8: the preview must mirror what the real wire emits —
    // `EvalStartup.init` is coerced to `EvalStartup.init()` in the
    // generated block, so the preview reflects the same shape.
    await expect(
      wireCommand('/project', 'panel', {
        init: 'EvalStartup.init',
        destroy: 'EvalStartup.destroy',
        dryRun: true,
      })
    ).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledWith('  browser-init.js: EvalStartup.init()');
    expect(info).toHaveBeenCalledWith('  browser-init.js onUnload(): EvalStartup.destroy()');
  });
});
