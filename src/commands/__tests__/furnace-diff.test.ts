// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { nativePath } from '../../test-utils/index.js';

vi.mock('../../core/config.js', () => ({
  getProjectPaths: vi.fn(() => ({
    root: '/project',
    engine: nativePath('/project/engine'),
    config: nativePath('/project/fireforge.json'),
    fireforgeDir: nativePath('/project/.fireforge'),
    state: nativePath('/project/.fireforge/state.json'),
    patches: nativePath('/project/patches'),
    configs: nativePath('/project/configs'),
    src: nativePath('/project/src'),
    componentsDir: nativePath('/project/components'),
  })),
  loadState: vi.fn(() => Promise.resolve({ baseCommit: 'base123' })),
}));

vi.mock('../../core/git-file-ops.js', () => ({
  getFileContentAtRef: vi.fn(),
}));

vi.mock('../../core/furnace-config.js', () => ({
  // The shared rollback handler records the pending-repair marker
  // through furnace state.
  updateFurnaceState: vi.fn(() => Promise.resolve()),

  getFurnacePaths: vi.fn(() => ({
    furnaceConfig: nativePath('/project/furnace.json'),
    componentsDir: nativePath('/project/components'),
    overridesDir: nativePath('/project/components/overrides'),
    customDir: nativePath('/project/components/custom'),
    furnaceState: nativePath('/project/.fireforge/furnace-state.json'),
  })),
  loadFurnaceConfig: vi.fn(() =>
    Promise.resolve({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-card': {
          type: 'css-only',
          description: 'Override card',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
      custom: {},
    })
  ),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
  readText: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  // Verbose + stdout-seal state: the CLI error boundary consults both
  // before walking a cause chain or emitting a --json error envelope.
  isVerbose: vi.fn(() => false),
  isStdoutSealed: vi.fn(() => false),
  setStdoutSealed: vi.fn(),

  info: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  formatErrorText: vi.fn((value: string) => value),
  formatSuccessText: vi.fn((value: string) => value),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(),
  };
});

import { readdir } from 'node:fs/promises';

import { loadState } from '../../core/config.js';
import { loadFurnaceConfig } from '../../core/furnace-config.js';
import { getFileContentAtRef } from '../../core/git-file-ops.js';
import { pathExists, readText } from '../../utils/fs.js';
import { info, intro, outro } from '../../utils/logger.js';
import { furnaceDiffCommand } from '../furnace/diff.js';

describe('furnaceDiffCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-card': {
          type: 'css-only',
          description: 'Override card',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
      custom: {},
    });
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(loadState).mockResolvedValue({ baseCommit: 'base123' });
  });

  it('fails when the requested component is not found in furnace.json', async () => {
    await expect(furnaceDiffCommand('/project', 'moz-button')).rejects.toThrow(
      /not found in furnace\.json/i
    );

    expect(intro).toHaveBeenCalledWith('Furnace Diff');
    expect(readdir).not.toHaveBeenCalled();
  });

  it('fails when the override directory does not exist', async () => {
    vi.mocked(pathExists).mockImplementation((filePath) =>
      Promise.resolve(!filePath.includes(nativePath('/components/overrides/moz-card')))
    );

    await expect(furnaceDiffCommand('/project', 'moz-card')).rejects.toThrow(
      /Override directory not found/i
    );

    expect(readdir).not.toHaveBeenCalled();
  });

  it('reports new files and changed files against the Firefox original', async () => {
    vi.mocked(readdir).mockResolvedValue([
      { name: 'moz-card.css', isFile: () => true },
      { name: 'moz-new.mjs', isFile: () => true },
      { name: 'README.md', isFile: () => true },
      { name: 'nested', isFile: () => false },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(pathExists).mockImplementation((filePath) => {
      if (filePath.endsWith(nativePath('/project/components/overrides/moz-card'))) {
        return Promise.resolve(true);
      }
      return Promise.resolve(true);
    });
    vi.mocked(getFileContentAtRef).mockImplementation((_repo, path) => {
      if (path === 'toolkit/content/widgets/moz-card/moz-card.css') {
        return Promise.resolve(['.root {', '  color: blue;', '  padding: 4px;', '}'].join('\n'));
      }
      if (path === 'toolkit/content/widgets/moz-card/moz-new.mjs') {
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
    });
    vi.mocked(readText).mockImplementation((filePath) => {
      if (filePath.endsWith(nativePath('/project/components/overrides/moz-card/moz-card.css'))) {
        return Promise.resolve(['.root {', '  color: red;', '  padding: 4px;', '}'].join('\n'));
      }
      throw new Error(`Unexpected file read: ${filePath}`);
    });

    await furnaceDiffCommand('/project', 'moz-card');

    expect(getFileContentAtRef).toHaveBeenCalledWith(
      nativePath('/project/engine'),
      'toolkit/content/widgets/moz-card/moz-card.css',
      'base123'
    );
    expect(info).toHaveBeenCalledWith('moz-new.mjs: original not found in engine (new file)');
    expect(info).toHaveBeenCalledWith('--- toolkit/content/widgets/moz-card/moz-card.css');
    expect(info).toHaveBeenCalledWith('+++ components/overrides/moz-card/moz-card.css');
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/^@@ -\d+,\d+ \+\d+,\d+ @@$/));
    expect(info).toHaveBeenCalledWith('  .root {');
    expect(info).toHaveBeenCalledWith('-   color: blue;');
    expect(info).toHaveBeenCalledWith('+   color: red;');
    expect(info).toHaveBeenCalledWith('    padding: 4px;');
    expect(outro).toHaveBeenCalledWith('Diff complete');
  });

  it('diffs override Fluent files against the shared localization baseline', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-card': {
          type: 'full',
          description: 'Override card',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
      },
      custom: {},
    });
    vi.mocked(readdir).mockResolvedValue([
      { name: 'moz-card.ftl', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(getFileContentAtRef).mockResolvedValue('title = Card\n');
    vi.mocked(readText).mockResolvedValue('title = Better Card\n');

    await furnaceDiffCommand('/project', 'moz-card');

    expect(getFileContentAtRef).toHaveBeenCalledWith(
      nativePath('/project/engine'),
      'toolkit/locales/en-US/toolkit/global/moz-card.ftl',
      'base123'
    );
    expect(info).toHaveBeenCalledWith('--- toolkit/locales/en-US/toolkit/global/moz-card.ftl');
  });

  it('emits multiple hunks when edits are scattered across the file', async () => {
    // Regression guard for the single-region coalescing limitation that used
    // to collapse unrelated edits into one giant hunk. With the LCS-based
    // renderer, two edits more than 2*context=6 lines apart must produce two
    // distinct `@@ … @@` headers.
    vi.mocked(readdir).mockResolvedValue([
      { name: 'moz-card.css', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    const oldLines = [
      '.root {',
      '  color: blue;',
      '  padding: 4px;',
      '  margin: 0;',
      '  border: none;',
      '  outline: none;',
      '  display: block;',
      '  width: 100%;',
      '  height: auto;',
      '  font-size: 14px;',
      '}',
      '',
    ].join('\n');
    const newLines = [
      '.root {',
      '  color: red;',
      '  padding: 4px;',
      '  margin: 0;',
      '  border: none;',
      '  outline: none;',
      '  display: block;',
      '  width: 100%;',
      '  height: auto;',
      '  font-size: 16px;',
      '}',
      '',
    ].join('\n');
    vi.mocked(getFileContentAtRef).mockResolvedValue(oldLines);
    vi.mocked(readText).mockResolvedValue(newLines);

    await furnaceDiffCommand('/project', 'moz-card');

    const hunkHeaders = vi
      .mocked(info)
      .mock.calls.map((call) => call[0])
      .filter((line): line is string => typeof line === 'string' && /^@@ /.test(line));
    expect(hunkHeaders).toHaveLength(2);
    expect(info).toHaveBeenCalledWith('-   color: blue;');
    expect(info).toHaveBeenCalledWith('+   color: red;');
    expect(info).toHaveBeenCalledWith('-   font-size: 14px;');
    expect(info).toHaveBeenCalledWith('+   font-size: 16px;');
  });

  it('reports when no override files differ from the original', async () => {
    vi.mocked(readdir).mockResolvedValue([
      { name: 'moz-card.css', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(getFileContentAtRef).mockResolvedValue('.root {\n  color: blue;\n}\n');
    vi.mocked(readText).mockResolvedValue('.root {\n  color: blue;\n}\n');

    await furnaceDiffCommand('/project', 'moz-card');

    expect(info).toHaveBeenCalledWith('No modifications found');
    expect(outro).toHaveBeenCalledWith('Diff complete');
  });

  it('diffs against baseCommit even when the engine worktree matches the override', async () => {
    // After an override has been applied, the engine working tree equals
    // the override — so an implementation reading from the worktree silently
    // reports no differences. Reading from baseCommit via `git show` detects
    // the real difference against pristine Firefox even then.
    vi.mocked(readdir).mockResolvedValue([
      { name: 'moz-card.css', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(getFileContentAtRef).mockResolvedValue('.root {\n  color: blue;\n}\n');
    // readText (for the override) returns the modified content, and a
    // hypothetical pathExists-based engine read would ALSO return the
    // override content (which is how the bug manifested). We simulate that
    // by having readText return the override content for both reads —
    // getFileContentAtRef is the only pristine-aware channel.
    vi.mocked(readText).mockResolvedValue('.root {\n  color: red;\n}\n');

    await furnaceDiffCommand('/project', 'moz-card');

    expect(info).not.toHaveBeenCalledWith('No modifications found');
    expect(info).toHaveBeenCalledWith('-   color: blue;');
    expect(info).toHaveBeenCalledWith('+   color: red;');
  });

  it('throws when baseCommit is missing from fireforge state', async () => {
    vi.mocked(loadState).mockResolvedValue({});

    await expect(furnaceDiffCommand('/project', 'moz-card')).rejects.toThrow(
      /baseCommit not recorded for this override/i
    );
  });

  it('suggests furnace refresh --reset-base in the missing-baseCommit error', async () => {
    vi.mocked(loadState).mockResolvedValue({});

    await expect(furnaceDiffCommand('/project', 'moz-card')).rejects.toThrow(
      /furnace refresh --reset-base moz-card/
    );
  });

  it('uses per-override baseCommit when available', async () => {
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-card': {
          type: 'css-only',
          description: 'Override card',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
          baseCommit: 'override-specific-sha',
        },
      },
      custom: {},
    });
    vi.mocked(readdir).mockResolvedValue([
      { name: 'moz-card.css', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(getFileContentAtRef).mockResolvedValue('.root {\n  color: blue;\n}\n');
    vi.mocked(readText).mockResolvedValue('.root {\n  color: blue;\n}\n');

    await furnaceDiffCommand('/project', 'moz-card');

    // Should use the per-override baseCommit, not the global state one
    expect(getFileContentAtRef).toHaveBeenCalledWith(
      nativePath('/project/engine'),
      expect.any(String),
      'override-specific-sha'
    );
  });

  it('checks the locale tree for a custom component .ftl instead of targetPath', async () => {
    // `diff` must probe `engine/<ftlDir>/<name>.ftl`, where
    // `furnace apply` actually writes the `.ftl` — not
    // `engine/<customConfig.targetPath>/<name>.ftl`. Probing the wrong
    // directory reports "not yet deployed to engine (new file)" after a
    // clean apply, while the deployed file sits in the locale tree with
    // matching contents.
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-lab-pill': {
          description: 'localized custom',
          register: true,
          localized: true,
          targetPath: 'toolkit/content/widgets/moz-lab-pill',
        },
      },
    });
    vi.mocked(readdir).mockResolvedValue([
      { name: 'moz-lab-pill.ftl', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    const workspaceFtl = 'moz-lab-pill = Localized Pill\n';
    vi.mocked(readText).mockResolvedValue(workspaceFtl);

    const probedPaths: string[] = [];
    vi.mocked(pathExists).mockImplementation((probedPath: string) => {
      probedPaths.push(probedPath);
      return Promise.resolve(true);
    });

    await furnaceDiffCommand('/project', 'moz-lab-pill');

    // The FTL deployment probe must hit the locale tree (the default
    // `ftlDir` resolves to `toolkit/locales/en-US/toolkit/global/` for
    // a project without an override in `ftlBasePath`), NOT the component
    // targetPath.
    expect(
      probedPaths.some(
        (p) => p.includes(nativePath('toolkit/locales/en-US')) && p.endsWith('moz-lab-pill.ftl')
      )
    ).toBe(true);
    expect(
      probedPaths.some((p) =>
        p.endsWith(
          nativePath('/project/engine/toolkit/content/widgets/moz-lab-pill/moz-lab-pill.ftl')
        )
      )
    ).toBe(false);

    // With workspace and deployed contents equal, the command must not
    // report "not yet deployed to engine".
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('not yet deployed to engine'));
  });
});
