// SPDX-License-Identifier: EUPL-1.2
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
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
import { info, success, warn } from '../../utils/logger.js';
import { reExportCommand } from '../re-export.js';
import { withDryRunPurityGuard } from '../re-export-bulk-scan.js';
import { verifyCommand } from '../verify.js';

vi.mock('../../utils/logger.js', () => ({
  // Verbose + stdout-seal state: the CLI error boundary consults both
  // before walking a cause chain or emitting a --json error envelope.
  isVerbose: vi.fn(() => false),
  isStdoutSealed: vi.fn(() => false),
  setStdoutSealed: vi.fn(),

  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  verbose: vi.fn(),
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

  it('reports Unchanged and does not rewrite a patch whose body did not move', async () => {
    await writeFiles(join(projectRoot, 'engine'), { 'tracked.txt': 'changed\n' });
    await reExportCommand(projectRoot, ['001'], {});

    const patchPath = join(projectRoot, 'patches/001-ui-test.patch');
    const firstBody = await readProjectText(projectRoot, 'patches/001-ui-test.patch');
    const firstMtime = (await stat(patchPath)).mtimeMs;
    expect(vi.mocked(success)).toHaveBeenCalledWith('Re-exported 001-ui-test.patch');

    vi.clearAllMocks();
    // Nothing in engine/ moved between the two runs.
    await reExportCommand(projectRoot, ['001'], {});

    expect(vi.mocked(info)).toHaveBeenCalledWith('Unchanged 001-ui-test.patch');
    expect(vi.mocked(success)).not.toHaveBeenCalledWith('Re-exported 001-ui-test.patch');
    await expect(readProjectText(projectRoot, 'patches/001-ui-test.patch')).resolves.toBe(
      firstBody
    );
    expect((await stat(patchPath)).mtimeMs).toBe(firstMtime);
  });

  it('round-trips a tracked binary file as a GIT binary patch, not a stub', async () => {
    const engineDir = join(projectRoot, 'engine');
    const cert = 'certs/release_primary.der';
    await mkdir(join(engineDir, 'certs'), { recursive: true });
    await writeFile(join(engineDir, cert), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));
    await runGit(engineDir, ['add', '--', cert]);
    await runGit(engineDir, ['commit', '-m', 'add cert']);
    await writeFile(join(engineDir, cert), Buffer.from([0x00, 0x09, 0x63, 0x21, 0x44]));

    await writeFiles(projectRoot, {
      'patches/patches.json': makeManifest().replace('"tracked.txt"', `"${cert}"`),
    });

    await reExportCommand(projectRoot, ['001'], {});

    const body = await readProjectText(projectRoot, 'patches/001-ui-test.patch');
    expect(body).toContain('GIT binary patch');
    expect(body).not.toContain('Binary files');
    // And the queue this produced is one `verify` accepts.
    await expect(verifyCommand(projectRoot)).resolves.toBeUndefined();
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

  it('--scan-file names the FIRST missing path in argument order when several are missing', async () => {
    // The existence probes now run through a bounded pool; the refusal
    // must still deterministically name the first missing file in
    // argument order, exactly as the serial loop did.
    await writeFiles(join(projectRoot, 'engine'), {
      'tracked.txt': 'changed\n',
    });

    await expect(
      reExportCommand(projectRoot, ['001'], {
        scan: true,
        scanFiles: ['features/gone-a.txt', 'features/gone-b.txt'],
      })
    ).rejects.toThrow('All selected patches failed to re-export.');
    // The per-patch refusal is reported through the warn channel and must
    // name gone-a (first in argument order), never gone-b.
    const warned = vi.mocked(warn).mock.calls.map((call) => call[0]);
    expect(
      warned.some(
        (message) =>
          typeof message === 'string' &&
          message.startsWith('--scan-file path not found in engine/: features/gone-a.txt')
      )
    ).toBe(true);
    expect(warned.join('\n')).not.toContain('features/gone-b.txt');
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

/**
 * Adjacent-unmanaged reproduction. The same-directory advisory fires for the
 * canonical shape — a new test created beside a patch's owned tests — which
 * the first test pins. The second documents the residual blind spot: a new
 * file in a subdirectory that is not the dirname of any owned file is
 * deliberately not reported, because recursive directory scans are too noisy
 * on Firefox-sized trees.
 */
describe('reExportCommand adjacency advisory', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  function makeTestsManifest(): string {
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
            filesAffected: ['comp/tests/browser/browser_a.js'],
          },
        ],
      },
      null,
      2
    )}\n`;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject();
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'comp/tests/browser/browser_a.js': blankContextBase,
    });
    await writeFiles(projectRoot, {
      'patches/patches.json': makeTestsManifest(),
      'patches/001-ui-test.patch':
        'diff --git a/comp/tests/browser/browser_a.js b/comp/tests/browser/browser_a.js\n',
    });
    await writeFiles(join(projectRoot, 'engine'), {
      'comp/tests/browser/browser_a.js': blankContextModified,
    });
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('warns about a brand-new test created beside the patch-owned tests (refutes the "fully silent" claim)', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      'comp/tests/browser/browser_b.js': 'new test\n',
    });

    await reExportCommand(projectRoot, ['001'], {});

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "found 1 unmanaged file(s) adjacent to this patch's ownership " +
          '(comp/tests/browser/browser_b.js (beside engine/comp/tests/browser))'
      )
    );
  });

  it('refuses the run under --refuse-adjacent-unmanaged without writing the patch', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      'comp/tests/browser/browser_b.js': 'new test\n',
    });
    const before = await readProjectText(projectRoot, 'patches/001-ui-test.patch');

    await expect(
      reExportCommand(projectRoot, ['001'], { refuseAdjacentUnmanaged: true })
    ).rejects.toThrow('Refused 1 patch(es) with adjacent unmanaged files');

    await expect(readProjectText(projectRoot, 'patches/001-ui-test.patch')).resolves.toBe(before);
  });

  it('reports a new file in a subdirectory below an owned directory (untracked scan is recursive)', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      'comp/tests/browser/helpers/head_extra.js': 'helper\n',
    });

    await reExportCommand(projectRoot, ['001'], {});

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('comp/tests/browser/helpers/head_extra.js')
    );
  });

  it('still misses a new file in a cousin directory no owned file lives in (documented blind spot, out of scope)', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      'comp/other/new_module.js': 'cousin\n',
    });

    await reExportCommand(projectRoot, ['001'], {});

    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('new_module.js'));
  });
});

describe('reExportCommand per-patch lint cache reuse', () => {
  const OWNED = 'comp/cached.js';
  const BASE = 'a\nb\n';
  const PATCHED = 'a\npatched\nb\n';

  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  function makeCacheManifest(): string {
    return `${JSON.stringify(
      {
        version: 1,
        patches: [
          {
            filename: '001-ui-cached.patch',
            order: 1,
            category: 'ui',
            name: 'cached',
            description: '',
            createdAt: '2026-01-01T00:00:00.000Z',
            sourceEsrVersion: '140.9.0esr',
            filesAffected: [OWNED],
          },
        ],
      },
      null,
      2
    )}\n`;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject();
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(join(projectRoot, 'engine'), { [OWNED]: BASE });
    await writeFiles(projectRoot, {
      'patches/patches.json': makeCacheManifest(),
      'patches/001-ui-cached.patch': `diff --git a/${OWNED} b/${OWNED}\n`,
    });
    await writeFiles(join(projectRoot, 'engine'), { [OWNED]: PATCHED });
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  function reusedLines(): string[] {
    return vi
      .mocked(info)
      .mock.calls.map((c) => c[0])
      .filter((l) => l.includes('Reused lint cache'));
  }

  it('a repeat identical re-export reuses the cached lint result', async () => {
    await reExportCommand(projectRoot, ['001'], {});
    expect(reusedLines()).toHaveLength(0);

    vi.clearAllMocks();
    await reExportCommand(projectRoot, ['001'], {});
    expect(reusedLines()).toEqual(['Reused lint cache for 1 patch.']);
  });

  it('an engine edit to an owned file invalidates the cached entry', async () => {
    await reExportCommand(projectRoot, ['001'], {});
    vi.clearAllMocks();
    await writeFiles(join(projectRoot, 'engine'), { [OWNED]: 'a\npatched differently\nb\n' });

    await reExportCommand(projectRoot, ['001'], {});
    expect(reusedLines()).toHaveLength(0);
  });

  it('--no-cache bypasses reads and writes', async () => {
    await reExportCommand(projectRoot, ['001'], {});
    vi.clearAllMocks();

    await reExportCommand(projectRoot, ['001'], { noCache: true });
    expect(reusedLines()).toHaveLength(0);
  });
});

describe('reExportCommand foreign-drift guard', () => {
  const OWNED = 'comp/mod.js';
  const BASE = 'line1\nline2\nline3\n';
  const PATCHED = 'line1\nline2\npatched line\nline3\n';
  const WITH_FOREIGN = 'line1\nforeign registration\nline2\npatched line\nline3\n';

  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  function makeDriftManifest(): string {
    return `${JSON.stringify(
      {
        version: 1,
        patches: [
          {
            filename: '001-ui-mod.patch',
            order: 1,
            category: 'ui',
            name: 'mod',
            description: '',
            createdAt: '2026-01-01T00:00:00.000Z',
            sourceEsrVersion: '140.9.0esr',
            filesAffected: [OWNED],
          },
        ],
      },
      null,
      2
    )}\n`;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject();
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(join(projectRoot, 'engine'), { [OWNED]: BASE });
    await writeFiles(projectRoot, {
      'patches/patches.json': makeDriftManifest(),
      'patches/001-ui-mod.patch': `diff --git a/${OWNED} b/${OWNED}\n`,
    });
    await writeFiles(join(projectRoot, 'engine'), { [OWNED]: PATCHED });
    // First re-export materializes the real old body for the guard to
    // compare against.
    await reExportCommand(projectRoot, ['001'], {});
    vi.clearAllMocks();
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('previews foreign lines entering the body and still refreshes without the flag', async () => {
    await writeFiles(join(projectRoot, 'engine'), { [OWNED]: WITH_FOREIGN });

    await reExportCommand(projectRoot, ['001'], {});

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('refreshed body absorbs 1 line not present in the old patch body')
    );
    const body = await readProjectText(projectRoot, 'patches/001-ui-mod.patch');
    expect(body).toContain('+foreign registration');
  });

  it('prints no drift preview when the refresh only re-captures the same change', async () => {
    await reExportCommand(projectRoot, ['001'], {});
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('refreshed body absorbs'));
  });

  it('refuses under --refuse-foreign-drift leaving the body byte-identical', async () => {
    await writeFiles(join(projectRoot, 'engine'), { [OWNED]: WITH_FOREIGN });
    const before = await readProjectText(projectRoot, 'patches/001-ui-mod.patch');

    await expect(
      reExportCommand(projectRoot, ['001'], { refuseForeignDrift: true })
    ).rejects.toThrow('--refuse-foreign-drift');

    await expect(readProjectText(projectRoot, 'patches/001-ui-mod.patch')).resolves.toBe(before);
  });

  it('previews under --dry-run without writing', async () => {
    await writeFiles(join(projectRoot, 'engine'), { [OWNED]: WITH_FOREIGN });
    const before = await readProjectText(projectRoot, 'patches/001-ui-mod.patch');

    await reExportCommand(projectRoot, ['001'], { dryRun: true });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refreshed body absorbs'));
    await expect(readProjectText(projectRoot, 'patches/001-ui-mod.patch')).resolves.toBe(before);
  });
});

/**
 * `--expect` scopes `--refuse-foreign-drift` to the files the
 * slice intends to export (the content-based detector cannot tell the
 * session's own edits from another session's), and a missing/unreadable old
 * body under the flag refuses fail-closed instead of silently writing.
 */
describe('reExportCommand --expect and fail-closed drift baseline', () => {
  const OWNED = 'comp/mod.js';
  const OTHER = 'comp/other.js';
  const BASE = 'line1\nline2\nline3\n';
  const PATCHED = 'line1\nline2\npatched line\nline3\n';
  const OWNED_DRIFTED = 'line1\nintended slice edit\nline2\npatched line\nline3\n';
  const OTHER_DRIFTED = 'line1\nforeign registration\nline2\npatched line\nline3\n';

  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  function makeTwoFileManifest(): string {
    return `${JSON.stringify(
      {
        version: 1,
        patches: [
          {
            filename: '001-ui-mod.patch',
            order: 1,
            category: 'ui',
            name: 'mod',
            description: '',
            createdAt: '2026-01-01T00:00:00.000Z',
            sourceEsrVersion: '140.9.0esr',
            filesAffected: [OWNED, OTHER],
          },
        ],
      },
      null,
      2
    )}\n`;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject();
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(join(projectRoot, 'engine'), { [OWNED]: BASE, [OTHER]: BASE });
    await writeFiles(projectRoot, {
      'patches/patches.json': makeTwoFileManifest(),
      'patches/001-ui-mod.patch': `diff --git a/${OWNED} b/${OWNED}\n`,
    });
    await writeFiles(join(projectRoot, 'engine'), { [OWNED]: PATCHED, [OTHER]: PATCHED });
    // Materialize the real old body for the guard to compare against.
    await reExportCommand(projectRoot, ['001'], {});
    vi.clearAllMocks();
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('exports when drift is confined to --expect files, tagging them in the preview', async () => {
    await writeFiles(join(projectRoot, 'engine'), { [OWNED]: OWNED_DRIFTED });

    await reExportCommand(projectRoot, ['001'], {
      refuseForeignDrift: true,
      expect: [OWNED],
    });

    expect(info).toHaveBeenCalledWith(expect.stringContaining('(expected via --expect)'));
    expect(info).toHaveBeenCalledWith(expect.stringContaining('drift confined to --expect'));
    const body = await readProjectText(projectRoot, 'patches/001-ui-mod.patch');
    expect(body).toContain('+intended slice edit');
  });

  it('accepts engine/-prefixed --expect paths via the shared normalizer', async () => {
    await writeFiles(join(projectRoot, 'engine'), { [OWNED]: OWNED_DRIFTED });

    await reExportCommand(projectRoot, ['001'], {
      refuseForeignDrift: true,
      expect: [`engine/${OWNED}`],
    });

    const body = await readProjectText(projectRoot, 'patches/001-ui-mod.patch');
    expect(body).toContain('+intended slice edit');
  });

  it('still refuses when drift also touches files outside --expect, naming only those', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      [OWNED]: OWNED_DRIFTED,
      [OTHER]: OTHER_DRIFTED,
    });
    const before = await readProjectText(projectRoot, 'patches/001-ui-mod.patch');

    await expect(
      reExportCommand(projectRoot, ['001'], { refuseForeignDrift: true, expect: [OWNED] })
    ).rejects.toThrow('--refuse-foreign-drift');

    // The preview tags the expected file; the unexpected one carries no tag.
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining(`${OWNED}: +1/-0 newly captured line(s) (expected via --expect)`)
    );
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining(`${OTHER}: +1/-0 newly captured line(s)`)
    );
    expect(info).not.toHaveBeenCalledWith(
      expect.stringContaining(`${OTHER}: +1/-0 newly captured line(s) (expected`)
    );
    await expect(readProjectText(projectRoot, 'patches/001-ui-mod.patch')).resolves.toBe(before);
  });

  it('warns about --expect paths that never drifted (typo protection)', async () => {
    await writeFiles(join(projectRoot, 'engine'), { [OWNED]: OWNED_DRIFTED });

    await expect(
      reExportCommand(projectRoot, ['001'], {
        refuseForeignDrift: true,
        expect: ['comp/typo.js'],
      })
    ).rejects.toThrow('--refuse-foreign-drift');

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('--expect path(s) showed no drift this run')
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('comp/typo.js'));
  });

  it('does not claim --expect had no drift when adjacency refused before evaluation', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      [OWNED]: OWNED_DRIFTED,
      'comp/adjacent-foreign.js': 'owned by another session\n',
    });

    await expect(
      reExportCommand(projectRoot, ['001'], {
        refuseAdjacentUnmanaged: true,
        refuseForeignDrift: true,
        expect: [OWNED],
      })
    ).rejects.toThrow('--refuse-adjacent-unmanaged');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('were not evaluated'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('showed no drift this run'));
  });

  it('refuses fail-closed under the flag when the old patch body is missing', async () => {
    await rm(join(projectRoot, 'patches/001-ui-mod.patch'));
    await writeFiles(join(projectRoot, 'engine'), { [OWNED]: OWNED_DRIFTED });

    await expect(
      reExportCommand(projectRoot, ['001'], { refuseForeignDrift: true })
    ).rejects.toThrow('missing or unreadable');

    // The refused patch is not written on the strength of a comparison that
    // never ran.
    await expect(readProjectText(projectRoot, 'patches/001-ui-mod.patch')).rejects.toThrow();
  });

  it('a missing old body without the flag still fails per-patch downstream, not via the drift guard', async () => {
    await rm(join(projectRoot, 'patches/001-ui-mod.patch'));
    await writeFiles(join(projectRoot, 'engine'), { [OWNED]: OWNED_DRIFTED });

    // The drift guard skips its preview (advisory path); the write layer's
    // own missing-file refusal then fails the patch, so the run is still
    // non-zero — but with the generic per-patch failure, not the drift
    // refusal message.
    await expect(reExportCommand(projectRoot, ['001'], {})).rejects.toThrow(
      'All selected patches failed to re-export'
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('patch file is missing on disk'));
  });

  it('a dry-run refusal still exits non-zero and writes nothing (pin)', async () => {
    await writeFiles(join(projectRoot, 'engine'), { [OWNED]: OWNED_DRIFTED });
    const before = await readProjectText(projectRoot, 'patches/001-ui-mod.patch');

    await expect(
      reExportCommand(projectRoot, ['001'], { dryRun: true, refuseForeignDrift: true })
    ).rejects.toThrow('--refuse-foreign-drift');

    await expect(readProjectText(projectRoot, 'patches/001-ui-mod.patch')).resolves.toBe(before);
  });
});

/**
 * A fully refused `--refuse-foreign-drift` run must reject with the refusal
 * (naming every patch), and the refusal must outrank the generic all-failed
 * abort. A consumer observing exit 0 is reading the shell pipeline's status
 * (`… | tee`), not the CLI's; the cross-process exit code is pinned in
 * src/__tests__/re-export-refusal-exit.test.ts.
 */
describe('reExportCommand fully-refused run exit contract', () => {
  const FILE_A = 'comp/a.js';
  const FILE_B = 'comp/b.js';
  const BASE = 'line1\nline2\nline3\n';

  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  function makeTwoPatchManifest(): string {
    return `${JSON.stringify(
      {
        version: 1,
        patches: [
          {
            filename: '001-ui-a.patch',
            order: 1,
            category: 'ui',
            name: 'a',
            description: '',
            createdAt: '2026-01-01T00:00:00.000Z',
            sourceEsrVersion: '140.9.0esr',
            filesAffected: [FILE_A],
          },
          {
            filename: '002-ui-b.patch',
            order: 2,
            category: 'ui',
            name: 'b',
            description: '',
            createdAt: '2026-01-01T00:00:00.000Z',
            sourceEsrVersion: '140.9.0esr',
            filesAffected: [FILE_B],
          },
        ],
      },
      null,
      2
    )}\n`;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject();
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(join(projectRoot, 'engine'), { [FILE_A]: BASE, [FILE_B]: BASE });
    await writeFiles(projectRoot, {
      'patches/patches.json': makeTwoPatchManifest(),
      'patches/001-ui-a.patch': `diff --git a/${FILE_A} b/${FILE_A}\n`,
      'patches/002-ui-b.patch': `diff --git a/${FILE_B} b/${FILE_B}\n`,
    });
    await writeFiles(join(projectRoot, 'engine'), {
      [FILE_A]: 'line1\nline2\npatched a\nline3\n',
      [FILE_B]: 'line1\nline2\npatched b\nline3\n',
    });
    await reExportCommand(projectRoot, ['001', '002'], {});
    vi.clearAllMocks();
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('a run in which EVERY patch is refused rejects with the refusal naming both patches', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      [FILE_A]: 'line1\nforeign X\nline2\npatched a\nline3\n',
      [FILE_B]: 'line1\nforeign Y\nline2\npatched b\nline3\n',
    });

    await expect(
      reExportCommand(projectRoot, ['001', '002'], { refuseForeignDrift: true })
    ).rejects.toThrow(
      /Refused 2 patch\(es\).*--refuse-foreign-drift.*001-ui-a\.patch, 002-ui-b\.patch/s
    );
  });

  it('the refusal outranks the generic all-failed abort (ordering pin)', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      [FILE_A]: 'line1\nforeign X\nline2\npatched a\nline3\n',
      [FILE_B]: 'line1\nforeign Y\nline2\npatched b\nline3\n',
    });

    const failure = await reExportCommand(projectRoot, ['001', '002'], {
      refuseForeignDrift: true,
    }).then(
      () => undefined,
      (error: unknown) => error as Error
    );

    expect(failure).toBeDefined();
    expect(failure?.message).toContain('--refuse-foreign-drift');
    expect(failure?.message).not.toContain('All selected patches failed to re-export');
  });
});

/**
 * Dry-run purity: a real re-export of patch A followed by a `--dry-run` of
 * unrelated patch B must leave A's just-written export intact. These tests
 * pin the exact sequence byte-for-byte (patch artifacts, manifest, engine
 * working tree, AND the git index — the one place a dry-run can legally
 * touch state), plus the untracked-binary staging variant and the runtime
 * purity guard itself.
 */
describe('reExportCommand dry-run purity', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  function makeTwoPatchManifest(patchBFiles: string[]): string {
    return `${JSON.stringify(
      {
        version: 1,
        patches: [
          {
            filename: '001-ui-capture.patch',
            order: 1,
            category: 'ui',
            name: 'capture',
            description: '',
            createdAt: '2026-01-01T00:00:00.000Z',
            sourceEsrVersion: '140.9.0esr',
            filesAffected: ['capture.txt'],
          },
          {
            filename: '002-ui-widgets.patch',
            order: 2,
            category: 'ui',
            name: 'widgets',
            description: '',
            createdAt: '2026-01-01T00:00:00.000Z',
            sourceEsrVersion: '140.9.0esr',
            filesAffected: patchBFiles,
          },
        ],
      },
      null,
      2
    )}\n`;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject();
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'capture.txt': blankContextBase,
      'widgets.txt': blankContextBase,
    });
    await writeFiles(projectRoot, {
      'patches/patches.json': makeTwoPatchManifest(['widgets.txt']),
      'patches/001-ui-capture.patch': 'diff --git a/capture.txt b/capture.txt\n',
      'patches/002-ui-widgets.patch': 'diff --git a/widgets.txt b/widgets.txt\n',
    });
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('a dry-run of patch B leaves a just-written re-export of patch A byte-identical (the incident sequence)', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      'capture.txt': 'changed capture\n',
      'widgets.txt': 'changed widgets\n',
    });

    // Step 1: real re-export of patch A, exactly as observed in the field.
    await reExportCommand(projectRoot, ['001'], { refuseAdjacentUnmanaged: true });

    const patchAAfterWrite = await readProjectText(projectRoot, 'patches/001-ui-capture.patch');
    expect(patchAAfterWrite).toContain('+changed capture');
    const manifestAfterWrite = await readProjectText(projectRoot, 'patches/patches.json');
    const engineDir = join(projectRoot, 'engine');
    const statusAfterWrite = await runGit(engineDir, ['status', '--porcelain']);
    const indexAfterWrite = await runGit(engineDir, ['ls-files', '--stage']);

    // Step 2: dry-run of the unrelated patch B.
    await reExportCommand(projectRoot, ['002'], { dryRun: true });

    // Step 3: everything from step 1 is byte-identical.
    await expect(readProjectText(projectRoot, 'patches/001-ui-capture.patch')).resolves.toBe(
      patchAAfterWrite
    );
    await expect(readProjectText(projectRoot, 'patches/patches.json')).resolves.toBe(
      manifestAfterWrite
    );
    await expect(runGit(engineDir, ['status', '--porcelain'])).resolves.toBe(statusAfterWrite);
    await expect(runGit(engineDir, ['ls-files', '--stage'])).resolves.toBe(indexAfterWrite);
  });

  it('a dry-run over an untracked binary preserves staged state and leaves no index entry behind', async () => {
    const engineDir = join(projectRoot, 'engine');
    await writeFiles(projectRoot, {
      'patches/patches.json': makeTwoPatchManifest(['assets/logo.png', 'widgets.txt']),
    });
    // Patch B owns an untracked binary — the one dry-run shape that touches
    // the git index (temporary intent-to-add staging).
    await mkdir(join(engineDir, 'assets'), { recursive: true });
    await writeFile(
      join(engineDir, 'assets', 'logo.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00, 0x03])
    );
    // Pre-existing staged state the cleanup must not disturb.
    await writeFiles(engineDir, {
      'capture.txt': 'staged capture change\n',
      'widgets.txt': 'changed widgets\n',
    });
    await runGit(engineDir, ['add', 'capture.txt']);
    const indexBefore = await runGit(engineDir, ['ls-files', '--stage']);
    const statusBefore = await runGit(engineDir, ['status', '--porcelain']);
    expect(statusBefore).toContain('M  capture.txt');

    await reExportCommand(projectRoot, ['002'], { dryRun: true });

    await expect(runGit(engineDir, ['ls-files', '--stage'])).resolves.toBe(indexBefore);
    await expect(runGit(engineDir, ['status', '--porcelain'])).resolves.toBe(statusBefore);
    expect(indexBefore).not.toContain('logo.png');
  });

  it('withDryRunPurityGuard turns a mutating dry-run into a hard error naming the artifact', async () => {
    await expect(
      withDryRunPurityGuard(join(projectRoot, 'engine'), join(projectRoot, 'patches'), true, () =>
        writeFiles(projectRoot, {
          'patches/001-ui-capture.patch': 'tampered\n',
        })
      )
    ).rejects.toThrow(
      /\[dry-run\] invariant violated: this dry run modified patches\/001-ui-capture\.patch/
    );
  });

  it('withDryRunPurityGuard is a no-op outside dry-run', async () => {
    await expect(
      withDryRunPurityGuard(join(projectRoot, 'engine'), join(projectRoot, 'patches'), false, () =>
        writeFiles(projectRoot, {
          'patches/001-ui-capture.patch': 'a real write\n',
        })
      )
    ).resolves.toBeUndefined();
  });

  it('withDryRunPurityGuard still post-checks when the operation throws: mutation wins, original error attached', async () => {
    // A dry-run that mutates and THEN fails is exactly the case where a
    // rollback defect must not hide behind the operation's own error.
    const failure = await withDryRunPurityGuard(
      join(projectRoot, 'engine'),
      join(projectRoot, 'patches'),
      true,
      async () => {
        await writeFiles(projectRoot, { 'patches/001-ui-capture.patch': 'tampered\n' });
        throw new Error('operation exploded mid-dry-run');
      }
    ).then(
      () => undefined,
      (error: unknown) => error as Error & { cause?: unknown }
    );

    expect(failure?.message).toMatch(
      /\[dry-run\] invariant violated: this dry run modified patches\/001-ui-capture\.patch/
    );
    expect(failure?.message).toContain('operation exploded mid-dry-run');
    expect((failure?.cause as Error | undefined)?.message).toBe('operation exploded mid-dry-run');
  });

  it('withDryRunPurityGuard rethrows a clean failure unchanged', async () => {
    const original = new Error('clean failure, nothing mutated');
    await expect(
      withDryRunPurityGuard(join(projectRoot, 'engine'), join(projectRoot, 'patches'), true, () =>
        Promise.reject(original)
      )
    ).rejects.toBe(original);
  });

  it('withDryRunPurityGuard fails closed when the patches directory cannot be listed', async () => {
    // An unreadable directory is not evidence it is empty — vouching for
    // purity over state the guard never saw would fail open.
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const patchesDir = join(projectRoot, 'patches');
    const { chmod } = await import('node:fs/promises');
    await chmod(patchesDir, 0o000);
    try {
      await expect(
        withDryRunPurityGuard(join(projectRoot, 'engine'), patchesDir, true, () =>
          Promise.resolve()
        )
      ).rejects.toThrow(/\[dry-run\] cannot fingerprint .*patches/);
    } finally {
      await chmod(patchesDir, 0o755);
    }
  });

  it('withDryRunPurityGuard fails closed on an unreadable individual patch file', async () => {
    // A constant "unreadable" placeholder would make unreadable-before equal
    // unreadable-after even when the bytes changed underneath (fail open).
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const patchPath = join(projectRoot, 'patches', '001-ui-capture.patch');
    const { chmod } = await import('node:fs/promises');
    await chmod(patchPath, 0o000);
    try {
      await expect(
        withDryRunPurityGuard(join(projectRoot, 'engine'), join(projectRoot, 'patches'), true, () =>
          Promise.resolve()
        )
      ).rejects.toThrow(/\[dry-run\] cannot fingerprint .*001-ui-capture\.patch/);
    } finally {
      await chmod(patchPath, 0o644);
    }
  });

  it('withDryRunPurityGuard names the FIRST unreadable patch in sorted order when several fail', async () => {
    // The hashing now runs through a bounded pool; error selection happens
    // in a deterministic post-pool pass, so the refusal must name the
    // first failing file in sorted filename order — not whichever worker
    // happened to fail first.
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const patchesDir = join(projectRoot, 'patches');
    const { chmod, writeFile: writeFileFs } = await import('node:fs/promises');
    await writeFileFs(join(patchesDir, '009-ui-zeta.patch'), 'placeholder\n');
    await chmod(join(patchesDir, '001-ui-capture.patch'), 0o000);
    await chmod(join(patchesDir, '009-ui-zeta.patch'), 0o000);
    try {
      await expect(
        withDryRunPurityGuard(join(projectRoot, 'engine'), patchesDir, true, () =>
          Promise.resolve()
        )
      ).rejects.toThrow(/\[dry-run\] cannot fingerprint .*001-ui-capture\.patch/);
    } finally {
      await chmod(join(patchesDir, '001-ui-capture.patch'), 0o644);
      await chmod(join(patchesDir, '009-ui-zeta.patch'), 0o644);
    }
  });

  it('withDryRunPurityGuard fails closed when the engine generation cannot be measured', async () => {
    // Real `re-export` refuses a non-git engine before the guard ever runs;
    // this pins the guard's own fail-closed defence: an `unavailable:` token
    // measured nothing, so it must never be hashed as engine state.
    const nonGitEngine = join(projectRoot, 'not-a-git-engine');
    await mkdir(nonGitEngine, { recursive: true });
    await expect(
      withDryRunPurityGuard(nonGitEngine, join(projectRoot, 'patches'), true, () =>
        Promise.resolve()
      )
    ).rejects.toThrow(/\[dry-run\] cannot fingerprint the engine working tree/);
  });

  it('withDryRunPurityGuard reports a patch file the dry run deleted as the violation, not a fingerprint error', async () => {
    const { rm } = await import('node:fs/promises');
    await expect(
      withDryRunPurityGuard(join(projectRoot, 'engine'), join(projectRoot, 'patches'), true, () =>
        rm(join(projectRoot, 'patches', '001-ui-capture.patch'))
      )
    ).rejects.toThrow(
      /\[dry-run\] invariant violated: this dry run modified patches\/001-ui-capture\.patch/
    );
  });

  it('withDryRunPurityGuard surfaces both errors when the after-pass fingerprint fails on a failed dry run', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const patchesDir = join(projectRoot, 'patches');
    const { chmod } = await import('node:fs/promises');
    const failure = await withDryRunPurityGuard(
      join(projectRoot, 'engine'),
      patchesDir,
      true,
      async () => {
        await chmod(patchesDir, 0o000);
        throw new Error('operation exploded after locking everyone out');
      }
    ).then(
      () => undefined,
      (error: unknown) => error as Error & { cause?: unknown }
    );
    await chmod(patchesDir, 0o755);

    expect(failure?.message).toContain('operation exploded after locking everyone out');
    expect(failure?.message).toMatch(/purity could not be verified afterwards/);
    expect((failure?.cause as Error | undefined)?.message).toBe(
      'operation exploded after locking everyone out'
    );
  });
});
