// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  readProjectText,
  removeTempProject,
  runGit,
  setInteractiveMode,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { warn } from '../../utils/logger.js';
import { reExportCommand } from '../re-export.js';
import { verifyCommand } from '../verify.js';

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
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['tracked.txt'],
        },
      ],
    },
    null,
    2
  )}\n`;
}

function makeLegacyThreePatchManifest(): string {
  return `${JSON.stringify(
    {
      version: 1,
      patches: [
        {
          filename: '001-branding-untouched.patch',
          order: 1,
          category: 'branding',
          name: 'untouched',
          description: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['branding/untouched.txt'],
        },
        {
          filename: '002-branding-browser-assets.patch',
          order: 2,
          category: 'branding',
          name: 'browser-assets',
          description: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['branding/browser.txt'],
        },
        {
          filename: '003-branding-platform-assets.patch',
          order: 3,
          category: 'branding',
          name: 'platform-assets',
          description: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['branding/platform.txt'],
        },
      ],
    },
    null,
    2
  )}\n`;
}

function makeTwoPatchForwardImportManifest(adopterDeclared: boolean): string {
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
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['tracked.txt'],
          ...(adopterDeclared
            ? {
                stagedDependencies: {
                  forwardImports: [
                    {
                      file: 'adopter.sys.mjs',
                      specifier: 'resource:///modules/Helper.sys.mjs',
                      creates: 'modules/Helper.sys.mjs',
                      owner: '002-ui-helper.patch',
                    },
                  ],
                },
              }
            : {}),
        },
        {
          filename: '002-ui-helper.patch',
          order: 2,
          category: 'ui',
          name: 'helper',
          description: '',
          createdAt: '2026-01-01T00:00:00.000Z',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['modules/Helper.sys.mjs'],
        },
      ],
    },
    null,
    2
  )}\n`;
}

function makeNewFileDiff(path: string, content: string): string {
  const lines = content.split('\n').filter((l) => l.length > 0);
  const hunk = `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    hunk,
  ].join('\n');
}

const blankContextBase = 'context\n\nmore context\n';
const blankContextModified = 'context\n\nmore context\nnew line\n';

function expectValidBlankContextHunk(patchBody: string): void {
  expect(patchBody).toContain('@@ -1,3 +1,4 @@');
  expect(patchBody).toContain('\n \n more context\n+new line');
  expect(patchBody).not.toContain('\n\n more context\n+new line');
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
      'tracked.txt': blankContextBase,
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
    await runGit(join(projectRoot, 'engine'), ['add', 'tracked.txt']);

    await expect(runGit(join(projectRoot, 'engine'), ['status', '--short'])).resolves.toBe(
      'M  tracked.txt\n'
    );

    await reExportCommand(projectRoot, ['001'], {});

    await expect(runGit(join(projectRoot, 'engine'), ['status', '--short'])).resolves.toBe(
      'M  tracked.txt\n'
    );
    await expect(readProjectText(projectRoot, 'patches/001-ui-test.patch')).resolves.toContain(
      '+changed'
    );
  });

  it('keeps dry-run side effect free for both git state and patch files', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      'tracked.txt': 'changed\n',
    });
    await runGit(join(projectRoot, 'engine'), ['add', 'tracked.txt']);

    const beforePatch = await readProjectText(projectRoot, 'patches/001-ui-test.patch');

    await reExportCommand(projectRoot, ['001'], { dryRun: true });

    await expect(runGit(join(projectRoot, 'engine'), ['status', '--short'])).resolves.toBe(
      'M  tracked.txt\n'
    );
    await expect(readProjectText(projectRoot, 'patches/001-ui-test.patch')).resolves.toBe(
      beforePatch
    );
    await expect(readProjectText(projectRoot, 'patches/patches.json')).resolves.toBe(
      makeManifest()
    );
  });

  it('--scan-file assigns only the intended adjacent new file', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      'tracked.txt': 'changed\n',
      'features/intended.txt': 'intended\n',
      'features/sibling.txt': 'sibling\n',
    });

    await reExportCommand(projectRoot, ['001'], {
      scan: true,
      scanFiles: ['features/intended.txt'],
    });

    const manifest = JSON.parse(await readProjectText(projectRoot, 'patches/patches.json')) as {
      patches: Array<{ filesAffected: string[] }>;
    };
    expect(manifest.patches[0]?.filesAffected).toEqual(['features/intended.txt', 'tracked.txt']);

    const patchBody = await readProjectText(projectRoot, 'patches/001-ui-test.patch');
    expect(patchBody).toContain('features/intended.txt');
    expect(patchBody).not.toContain('features/sibling.txt');
  });

  it('broad --scan only offers candidates from the patch directory footprint', async () => {
    // The patch claims tracked.txt at the engine root. Git pathspecs
    // recurse, so before the footprint filter the unmanaged files under
    // features/ would be offered to this patch too — the field-reported
    // cross-feature mis-assignment hazard.
    await writeFiles(join(projectRoot, 'engine'), {
      'tracked.txt': 'changed\n',
      'rootnew.txt': 'new at root\n',
      'features/deep/module-a.txt': 'a\n',
      'features/deep/module-b.txt': 'b\n',
    });

    await reExportCommand(projectRoot, ['001'], { scan: true, yes: true });

    const manifest = JSON.parse(await readProjectText(projectRoot, 'patches/patches.json')) as {
      patches: Array<{ filesAffected: string[] }>;
    };
    expect(manifest.patches[0]?.filesAffected).toEqual(['rootnew.txt', 'tracked.txt']);

    const patchBody = await readProjectText(projectRoot, 'patches/001-ui-test.patch');
    expect(patchBody).toContain('rootnew.txt');
    expect(patchBody).not.toContain('features/deep/module-a.txt');
    expect(patchBody).not.toContain('features/deep/module-b.txt');
  });

  it('refuses broad --scan adoption of a file that forward-imports a later patch, naming that patch', async () => {
    await writeFiles(projectRoot, {
      'patches/patches.json': makeTwoPatchForwardImportManifest(false),
      'patches/002-ui-helper.patch': makeNewFileDiff(
        'modules/Helper.sys.mjs',
        'export const H = 1;\n'
      ),
    });
    const manifestBefore = await readProjectText(projectRoot, 'patches/patches.json');
    await writeFiles(join(projectRoot, 'engine'), {
      'tracked.txt': 'changed\n',
      'adopter.sys.mjs':
        'import { H } from "resource:///modules/Helper.sys.mjs";\nexport const A = H;\n',
    });

    await expect(reExportCommand(projectRoot, ['001'], { scan: true, yes: true })).rejects.toThrow(
      /All selected patches failed/
    );

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('import modules created by later patches')
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('002-ui-helper.patch'));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('fireforge patch staged-dependency --add')
    );
    // Nothing adopted: the refusal fires before any write.
    await expect(readProjectText(projectRoot, 'patches/patches.json')).resolves.toBe(
      manifestBefore
    );
  });

  it('refuses --scan-file adoption of a forward-importing file with the same message', async () => {
    await writeFiles(projectRoot, {
      'patches/patches.json': makeTwoPatchForwardImportManifest(false),
      'patches/002-ui-helper.patch': makeNewFileDiff(
        'modules/Helper.sys.mjs',
        'export const H = 1;\n'
      ),
    });
    await writeFiles(join(projectRoot, 'engine'), {
      'tracked.txt': 'changed\n',
      'adopter.sys.mjs':
        'import { H } from "resource:///modules/Helper.sys.mjs";\nexport const A = H;\n',
    });

    await expect(
      reExportCommand(projectRoot, ['001'], { scan: true, scanFiles: ['adopter.sys.mjs'] })
    ).rejects.toThrow(/All selected patches failed/);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('import modules created by later patches')
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('002-ui-helper.patch'));
  });

  it('allows scan adoption of a forward import covered by a staged-dependency declaration', async () => {
    await writeFiles(projectRoot, {
      'patches/patches.json': makeTwoPatchForwardImportManifest(true),
      'patches/002-ui-helper.patch': makeNewFileDiff(
        'modules/Helper.sys.mjs',
        'export const H = 1;\n'
      ),
    });
    await writeFiles(join(projectRoot, 'engine'), {
      'tracked.txt': 'changed\n',
      'adopter.sys.mjs':
        '/* SPDX-License-Identifier: EUPL-1.2 */\n' +
        'import { H } from "resource:///modules/Helper.sys.mjs";\n' +
        '/** Adopted helper re-export. */\n' +
        'export const A = H;\n',
    });

    await reExportCommand(projectRoot, ['001'], {
      scan: true,
      scanFiles: ['adopter.sys.mjs'],
    });

    const manifest = JSON.parse(await readProjectText(projectRoot, 'patches/patches.json')) as {
      patches: Array<{ filesAffected: string[] }>;
    };
    expect(manifest.patches[0]?.filesAffected).toEqual(['adopter.sys.mjs', 'tracked.txt']);
    const patchBody = await readProjectText(projectRoot, 'patches/001-ui-test.patch');
    expect(patchBody).toContain('adopter.sys.mjs');
  });

  it('preserves blank context markers and verifies cleanly after targeted re-export', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      'tracked.txt': blankContextModified,
    });

    await reExportCommand(projectRoot, ['001'], { yes: true });

    const patchBody = await readProjectText(projectRoot, 'patches/001-ui-test.patch');
    expectValidBlankContextHunk(patchBody);

    vi.mocked(warn).mockClear();
    await verifyCommand(projectRoot);

    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Patch-owned worktree drift'));
  });

  it('does not normalize sourceVersion on any row during partial non-stamped re-export', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      'branding/untouched.txt': 'untouched\n',
      'branding/browser.txt': 'browser\n',
      'branding/platform.txt': 'platform\n',
    });
    await runGit(join(projectRoot, 'engine'), ['add', '-A']);
    await runGit(join(projectRoot, 'engine'), ['commit', '-m', 'add branding fixtures']);
    await writeFiles(projectRoot, {
      'patches/patches.json': makeLegacyThreePatchManifest(),
      'patches/001-branding-untouched.patch':
        'diff --git a/branding/untouched.txt b/branding/untouched.txt\n',
      'patches/002-branding-browser-assets.patch':
        'diff --git a/branding/browser.txt b/branding/browser.txt\n',
      'patches/003-branding-platform-assets.patch':
        'diff --git a/branding/platform.txt b/branding/platform.txt\n',
    });
    await writeFiles(join(projectRoot, 'engine'), {
      'branding/browser.txt': 'browser\nrefreshed\n',
      'branding/platform.txt': 'platform\nrefreshed\n',
    });

    await reExportCommand(projectRoot, ['002', '003'], {});

    const manifest = JSON.parse(await readProjectText(projectRoot, 'patches/patches.json')) as {
      patches: Array<{ filename: string; sourceProduct?: string; sourceVersion?: string }>;
    };
    for (const patch of manifest.patches) {
      expect(patch.sourceVersion).toBeUndefined();
      expect(patch.sourceProduct).toBeUndefined();
    }
  });

  it('stamps source metadata only on selected rows during partial stamped re-export', async () => {
    await writeFireForgeConfig(projectRoot, {
      firefox: { version: '152.0b6', product: 'firefox-devedition' },
    });
    await writeFiles(join(projectRoot, 'engine'), {
      'branding/untouched.txt': 'untouched\n',
      'branding/browser.txt': 'browser\n',
      'branding/platform.txt': 'platform\n',
    });
    await runGit(join(projectRoot, 'engine'), ['add', '-A']);
    await runGit(join(projectRoot, 'engine'), ['commit', '-m', 'add branding fixtures']);
    await writeFiles(projectRoot, {
      'patches/patches.json': makeLegacyThreePatchManifest(),
      'patches/001-branding-untouched.patch':
        'diff --git a/branding/untouched.txt b/branding/untouched.txt\n',
      'patches/002-branding-browser-assets.patch':
        'diff --git a/branding/browser.txt b/branding/browser.txt\n',
      'patches/003-branding-platform-assets.patch':
        'diff --git a/branding/platform.txt b/branding/platform.txt\n',
    });
    await writeFiles(join(projectRoot, 'engine'), {
      'branding/browser.txt': 'browser\nrefreshed\n',
      'branding/platform.txt': 'platform\nrefreshed\n',
    });

    await reExportCommand(projectRoot, ['002', '003'], { stamp: true });

    const manifest = JSON.parse(await readProjectText(projectRoot, 'patches/patches.json')) as {
      patches: Array<{ filename: string; sourceProduct?: string; sourceVersion?: string }>;
    };
    const rows = new Map(manifest.patches.map((patch) => [patch.filename, patch]));

    expect(rows.get('001-branding-untouched.patch')?.sourceVersion).toBeUndefined();
    expect(rows.get('001-branding-untouched.patch')?.sourceProduct).toBeUndefined();
    expect(rows.get('002-branding-browser-assets.patch')?.sourceVersion).toBe('152.0b6');
    expect(rows.get('002-branding-browser-assets.patch')?.sourceProduct).toBe('firefox-devedition');
    expect(rows.get('003-branding-platform-assets.patch')?.sourceVersion).toBe('152.0b6');
    expect(rows.get('003-branding-platform-assets.patch')?.sourceProduct).toBe(
      'firefox-devedition'
    );
  });

  it('preserves blank context markers and verifies cleanly after full stamped re-export', async () => {
    await writeFireForgeConfig(projectRoot, {
      firefox: { version: '152.0b6', product: 'firefox-devedition' },
    });
    await writeFiles(join(projectRoot, 'engine'), {
      'tracked.txt': blankContextModified,
    });

    await reExportCommand(projectRoot, [], { all: true, stamp: true, yes: true });

    const patchBody = await readProjectText(projectRoot, 'patches/001-ui-test.patch');
    expectValidBlankContextHunk(patchBody);

    const manifest = JSON.parse(await readProjectText(projectRoot, 'patches/patches.json')) as {
      patches: Array<{ sourceProduct?: string; sourceVersion?: string }>;
    };
    expect(manifest.patches[0]?.sourceVersion).toBe('152.0b6');
    expect(manifest.patches[0]?.sourceProduct).toBe('firefox-devedition');

    vi.mocked(warn).mockClear();
    await verifyCommand(projectRoot);

    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Patch-owned worktree drift'));
  });
});
