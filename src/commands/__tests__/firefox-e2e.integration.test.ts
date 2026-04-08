// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as prompts from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadState } from '../../core/config.js';
import { resetResolvedPython } from '../../core/mach.js';
import { loadPatchesManifest } from '../../core/patch-manifest.js';
import { FIREFOX_WORKFLOW_SETUP_OPTIONS } from '../../test-utils/firefox-workflow-fixtures.js';
import {
  createTempProject,
  git,
  readText,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
} from '../../test-utils/index.js';
import {
  makeSyntheticFirefoxArchive,
  SYNTHETIC_FIREFOX_PATHS,
} from '../../test-utils/synthetic-firefox.js';
import { bootstrapCommand } from '../bootstrap.js';
import { buildCommand } from '../build.js';
import { discardCommand } from '../discard.js';
import { downloadCommand } from '../download.js';
import { exportCommand } from '../export.js';
import { exportAllCommand } from '../export-all.js';
import { importCommand } from '../import.js';
import { reExportCommand } from '../re-export.js';
import { resetCommand } from '../reset.js';
import { resolveCommand } from '../resolve.js';
import { setupCommand } from '../setup.js';

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  note: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  step: vi.fn(),
  verbose: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  spinner: vi.fn(() => ({
    message: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('connected Firefox workflow integration', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    resetResolvedPython();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject('fireforge-firefox-e2e-');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await setupCommand(projectRoot, { ...FIREFOX_WORKFLOW_SETUP_OPTIONS, force: true });

    const archivePath = await makeSyntheticFirefoxArchive(projectRoot);
    const archiveBody = await readFile(archivePath);
    fetchMock.mockResolvedValue(
      new Response(archiveBody, {
        status: 200,
        headers: { 'content-length': String(archiveBody.length) },
      })
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    restoreTTY?.();
    resetResolvedPython();
    await removeTempProject(projectRoot);
  });

  it('runs setup, download, bootstrap, build, patch round-trip, and file-scoped recovery with unrelated dirty engine state preserved', async () => {
    await downloadCommand(projectRoot, {});

    const initialState = await loadState(projectRoot);
    expect(initialState.baseCommit).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await bootstrapCommand(projectRoot);
    await buildCommand(projectRoot, {});

    const fireforgeConfig = JSON.parse(await readText(projectRoot, 'fireforge.json')) as {
      build?: { jobs?: number };
    };
    const expectedBuildArgs = fireforgeConfig.build?.jobs
      ? ['build', '-j', String(fireforgeConfig.build.jobs)]
      : ['build'];

    const buildInfo = JSON.parse(
      await readText(join(projectRoot, 'engine'), SYNTHETIC_FIREFOX_PATHS.buildInfo)
    ) as {
      args: string[];
      mozconfigExists: boolean;
      brandingConfigured: boolean;
      vendorLinePatched: boolean;
    };
    expect(buildInfo.args).toEqual(expectedBuildArgs);
    expect(buildInfo.mozconfigExists).toBe(true);
    expect(buildInfo.brandingConfigured).toBe(true);
    expect(buildInfo.vendorLinePatched).toBe(true);

    const machLog = (await readText(join(projectRoot, 'engine'), SYNTHETIC_FIREFOX_PATHS.machLog))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { args: string[] });
    expect(machLog.map((entry) => entry.args)).toEqual([
      ['bootstrap', '--application-choice', 'browser'],
      expectedBuildArgs,
    ]);

    const buildDirtyStatus = await git(join(projectRoot, 'engine'), ['status', '--short']);
    expect(buildDirtyStatus).toContain(' M browser/moz.configure');
    expect(buildDirtyStatus).toContain('?? browser/branding/mybrowser/');

    await writeFiles(join(projectRoot, 'engine'), {
      [SYNTHETIC_FIREFOX_PATHS.browserScript]: 'export const browserTitle = "patched";\n',
    });

    await exportCommand(projectRoot, [SYNTHETIC_FIREFOX_PATHS.browserScript], {
      name: 'browser-title',
      category: 'ui',
      description: 'Synthetic browser title workflow',
    });

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifest?.patches).toHaveLength(1);
    expect(manifest?.patches[0]?.filesAffected).toEqual([SYNTHETIC_FIREFOX_PATHS.browserScript]);

    const patchFilename = manifest?.patches[0]?.filename;
    expect(patchFilename).toBeDefined();
    await expect(readText(projectRoot, `patches/${patchFilename}`)).resolves.toContain(
      '+export const browserTitle = "patched";'
    );

    await git(join(projectRoot, 'engine'), [
      'checkout',
      '--',
      SYNTHETIC_FIREFOX_PATHS.browserScript,
    ]);
    await importCommand(projectRoot, {});

    await expect(
      readText(join(projectRoot, 'engine'), SYNTHETIC_FIREFOX_PATHS.browserScript)
    ).resolves.toBe('export const browserTitle = "patched";\n');

    await git(join(projectRoot, 'engine'), [
      'checkout',
      '--',
      SYNTHETIC_FIREFOX_PATHS.browserScript,
    ]);
    await writeFiles(join(projectRoot, 'engine'), {
      [SYNTHETIC_FIREFOX_PATHS.browserScript]: 'export const browserTitle = "local-only";\n',
    });

    await expect(importCommand(projectRoot, {})).rejects.toThrow(
      'Uncommitted changes in patch-touched files. Commit or stash them first, or use --force.'
    );

    await discardCommand(projectRoot, SYNTHETIC_FIREFOX_PATHS.browserScript, { force: true });

    const recoveredStatus = await git(join(projectRoot, 'engine'), ['status', '--short']);
    expect(recoveredStatus).toContain(' M browser/moz.configure');
    expect(recoveredStatus).toContain('?? browser/branding/mybrowser/');
    expect(recoveredStatus).not.toContain(SYNTHETIC_FIREFOX_PATHS.browserScript);

    await importCommand(projectRoot, {});
    await expect(
      readText(join(projectRoot, 'engine'), SYNTHETIC_FIREFOX_PATHS.browserScript)
    ).resolves.toBe('export const browserTitle = "patched";\n');
  });

  it('records pending resolution on a true patch conflict and refreshes the patch via resolve', async () => {
    await downloadCommand(projectRoot, {});

    await writeFiles(join(projectRoot, 'engine'), {
      [SYNTHETIC_FIREFOX_PATHS.browserScript]: 'export const browserTitle = "patched";\n',
    });

    await exportCommand(projectRoot, [SYNTHETIC_FIREFOX_PATHS.browserScript], {
      name: 'browser-title-conflict',
      category: 'ui',
      description: 'Synthetic conflict and resolve workflow',
    });

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    const patchFilename = manifest?.patches[0]?.filename;
    expect(patchFilename).toBeDefined();

    await git(join(projectRoot, 'engine'), [
      'checkout',
      '--',
      SYNTHETIC_FIREFOX_PATHS.browserScript,
    ]);
    await writeFiles(join(projectRoot, 'engine'), {
      [SYNTHETIC_FIREFOX_PATHS.browserScript]:
        'export const browserTitle = "conflicting-upstream";\n',
    });
    await git(join(projectRoot, 'engine'), ['add', SYNTHETIC_FIREFOX_PATHS.browserScript]);
    await git(join(projectRoot, 'engine'), ['commit', '-m', 'conflicting upstream change']);

    await expect(importCommand(projectRoot, { force: true })).rejects.toThrow(
      'Failed to apply 1 patch(es)'
    );

    const failedState = await loadState(projectRoot);
    expect(failedState.pendingResolution?.patchFilename).toBe(patchFilename);
    expect(failedState.pendingResolution?.originalError).toEqual(expect.any(String));
    await expect(
      readText(join(projectRoot, 'engine'), SYNTHETIC_FIREFOX_PATHS.browserScript)
    ).resolves.toBe('export const browserTitle = "conflicting-upstream";\n');

    restoreTTY?.();
    restoreTTY = setInteractiveMode(true);
    vi.mocked(prompts.confirm).mockResolvedValue(true);

    await writeFiles(join(projectRoot, 'engine'), {
      [SYNTHETIC_FIREFOX_PATHS.browserScript]: 'export const browserTitle = "patched";\n',
    });
    await resolveCommand(projectRoot);

    const resolvedState = await loadState(projectRoot);
    expect(resolvedState.pendingResolution).toBeUndefined();
    await expect(readText(projectRoot, `patches/${patchFilename}`)).resolves.toContain(
      '-export const browserTitle = "conflicting-upstream";'
    );
    await expect(readText(projectRoot, `patches/${patchFilename}`)).resolves.toContain(
      '+export const browserTitle = "patched";'
    );

    await resetCommand(projectRoot, { force: true });
    await importCommand(projectRoot, { force: true });

    await expect(
      readText(join(projectRoot, 'engine'), SYNTHETIC_FIREFOX_PATHS.browserScript)
    ).resolves.toBe('export const browserTitle = "patched";\n');
  });

  it('exports and round-trips a non-JS source file (Rust build.rs)', async () => {
    await downloadCommand(projectRoot, {});

    const engineDir = join(projectRoot, 'engine');
    const rustFile = SYNTHETIC_FIREFOX_PATHS.rustBuildScript;

    // Apply a realistic Rust modification (similar to a real fork's build.rs edit)
    await writeFiles(engineDir, {
      [rustFile]: [
        'use std::fs;',
        '',
        'fn generate_bindings() {',
        '    let out_file = "bindings.rs";',
        '    let src = "// post-processed".to_string();',
        '    fs::write(out_file, src).expect("write failed");',
        '}',
        '',
        'fn main() {',
        '    generate_bindings();',
        '}',
        '',
      ].join('\n'),
    });

    await exportCommand(projectRoot, [rustFile], {
      name: 'profiler-bindgen-fix',
      category: 'infra',
      description: 'Fix profiler Rust API build script',
    });

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifest?.patches).toHaveLength(1);
    expect(manifest?.patches[0]?.filesAffected).toEqual([rustFile]);

    const patchFilename = manifest?.patches[0]?.filename;
    expect(patchFilename).toBeDefined();
    const patchContent = await readText(projectRoot, `patches/${patchFilename}`);
    expect(patchContent).toContain('+    let src = "// post-processed".to_string();');
    expect(patchContent).toContain('+    fs::write(out_file, src).expect("write failed");');

    // Round-trip: checkout original, re-import, verify
    await git(engineDir, ['checkout', '--', rustFile]);
    await importCommand(projectRoot, {});

    const imported = await readText(engineDir, rustFile);
    expect(imported).toContain('let src = "// post-processed".to_string();');
    expect(imported).toContain('fs::write(out_file, src).expect("write failed");');
  });

  it('exports multiple patches across JS and Rust files, then re-imports the full stack', async () => {
    await downloadCommand(projectRoot, {});

    const engineDir = join(projectRoot, 'engine');

    // Export a JS patch first
    await writeFiles(engineDir, {
      [SYNTHETIC_FIREFOX_PATHS.browserScript]: 'export const browserTitle = "patched";\n',
    });
    await exportCommand(projectRoot, [SYNTHETIC_FIREFOX_PATHS.browserScript], {
      name: 'browser-title',
      category: 'ui',
      description: 'UI patch',
    });

    // Export a Rust patch second
    await writeFiles(engineDir, {
      [SYNTHETIC_FIREFOX_PATHS.rustBuildScript]: [
        'use std::fs;',
        '',
        'fn generate_bindings() {',
        '    let out_file = "bindings.rs";',
        '    let src = "// fixed".to_string();',
        '    fs::write(out_file, src).expect("write failed");',
        '}',
        '',
        'fn main() {',
        '    generate_bindings();',
        '}',
        '',
      ].join('\n'),
    });
    await exportCommand(projectRoot, [SYNTHETIC_FIREFOX_PATHS.rustBuildScript], {
      name: 'profiler-fix',
      category: 'infra',
      description: 'Infra patch',
    });

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifest?.patches).toHaveLength(2);
    expect(manifest?.patches[0]?.category).toBe('ui');
    expect(manifest?.patches[1]?.category).toBe('infra');

    // Reset both files and re-import full stack
    await git(engineDir, ['checkout', '--', SYNTHETIC_FIREFOX_PATHS.browserScript]);
    await git(engineDir, ['checkout', '--', SYNTHETIC_FIREFOX_PATHS.rustBuildScript]);
    await importCommand(projectRoot, {});

    await expect(readText(engineDir, SYNTHETIC_FIREFOX_PATHS.browserScript)).resolves.toBe(
      'export const browserTitle = "patched";\n'
    );
    const rustContent = await readText(engineDir, SYNTHETIC_FIREFOX_PATHS.rustBuildScript);
    expect(rustContent).toContain('let src = "// fixed".to_string();');
  });

  it('exports a binary branding asset (PNG) as a GIT binary patch', async () => {
    await downloadCommand(projectRoot, {});

    const engineDir = join(projectRoot, 'engine');
    const pngPath = SYNTHETIC_FIREFOX_PATHS.brandingPng;

    // Replace the 1x1 PNG with a different one (2x1)
    const modifiedPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAC0lEQVQI12NgAAIABQAB' +
        'Nl7BcQAAAABJRU5ErkJggg==',
      'base64'
    );
    await writeFiles(engineDir, { [pngPath]: modifiedPng });

    await exportCommand(projectRoot, [pngPath], {
      name: 'branding-icon-fix',
      category: 'ui',
      description: 'Update branding icon',
    });

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifest?.patches).toHaveLength(1);
    expect(manifest?.patches[0]?.filesAffected).toEqual([pngPath]);

    const patchFilename = manifest?.patches[0]?.filename;
    expect(patchFilename).toBeDefined();
    const patchContent = await readText(projectRoot, `patches/${patchFilename}`);
    expect(patchContent).toContain('GIT binary patch');
    expect(patchContent).toContain('diff --git');

    // Binary patches produce GIT binary patch format without +++ b/ lines.
    // Verify git can apply it directly (bypasses manifest consistency check).
    await git(engineDir, ['checkout', '--', pngPath]);
    const patchPath = join(projectRoot, 'patches', patchFilename ?? '');
    await git(engineDir, ['apply', '--binary', patchPath]);
    const roundTripped = await readFile(join(engineDir, pngPath));
    expect(roundTripped.equals(modifiedPng)).toBe(true);
  });

  it('exports three patches across JS, Rust, and moz.build, then imports the full stack with ordering', async () => {
    await downloadCommand(projectRoot, {});

    const engineDir = join(projectRoot, 'engine');

    // Patch 1: JS change
    await writeFiles(engineDir, {
      [SYNTHETIC_FIREFOX_PATHS.browserScript]: 'export const browserTitle = "patched";\n',
    });
    await exportCommand(projectRoot, [SYNTHETIC_FIREFOX_PATHS.browserScript], {
      name: 'browser-title',
      category: 'ui',
      description: 'UI title patch',
    });

    // Patch 2: moz.build change (build system)
    await writeFiles(engineDir, {
      [SYNTHETIC_FIREFOX_PATHS.mozbuild]: 'DIRS += ["newtab"]\nDIRS += ["mybrowser"]\n',
    });
    await exportCommand(projectRoot, [SYNTHETIC_FIREFOX_PATHS.mozbuild], {
      name: 'build-registration',
      category: 'infra',
      description: 'Register mybrowser in build system',
    });

    // Patch 3: Rust change
    await writeFiles(engineDir, {
      [SYNTHETIC_FIREFOX_PATHS.rustBuildScript]: [
        'use std::fs;',
        '',
        'fn generate_bindings() {',
        '    let out_file = "bindings.rs";',
        '    let src = "// patched".to_string();',
        '    fs::write(out_file, src).expect("write failed");',
        '}',
        '',
        'fn main() {',
        '    generate_bindings();',
        '}',
        '',
      ].join('\n'),
    });
    await exportCommand(projectRoot, [SYNTHETIC_FIREFOX_PATHS.rustBuildScript], {
      name: 'profiler-fix',
      category: 'infra',
      description: 'Profiler bindgen fix',
    });

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifest?.patches).toHaveLength(3);

    // Reset all and import the full stack
    await git(engineDir, ['checkout', '--', SYNTHETIC_FIREFOX_PATHS.browserScript]);
    await git(engineDir, ['checkout', '--', SYNTHETIC_FIREFOX_PATHS.mozbuild]);
    await git(engineDir, ['checkout', '--', SYNTHETIC_FIREFOX_PATHS.rustBuildScript]);
    await importCommand(projectRoot, {});

    // All three changes should be applied
    await expect(readText(engineDir, SYNTHETIC_FIREFOX_PATHS.browserScript)).resolves.toBe(
      'export const browserTitle = "patched";\n'
    );
    const mozbuild = await readText(engineDir, SYNTHETIC_FIREFOX_PATHS.mozbuild);
    expect(mozbuild).toContain('DIRS += ["mybrowser"]');
    const rust = await readText(engineDir, SYNTHETIC_FIREFOX_PATHS.rustBuildScript);
    expect(rust).toContain('let src = "// patched".to_string();');
  });

  it('export-all refuses branding-managed changes in a connected workflow', async () => {
    await downloadCommand(projectRoot, {});

    const engineDir = join(projectRoot, 'engine');

    // Make a non-branding change AND a branding change
    await writeFiles(engineDir, {
      [SYNTHETIC_FIREFOX_PATHS.browserScript]: 'export const browserTitle = "patched";\n',
      [SYNTHETIC_FIREFOX_PATHS.mozConfigure]: 'imply_option("MOZ_APP_VENDOR", "My Company")\n',
    });

    // export-all should refuse because moz.configure is branding-managed
    await expect(
      exportAllCommand(projectRoot, {
        name: 'all-changes',
        category: 'infra',
        description: 'Should fail due to branding files',
      })
    ).rejects.toThrow('branding');

    // Individual export of just the browser script should work fine
    await exportCommand(projectRoot, [SYNTHETIC_FIREFOX_PATHS.browserScript], {
      name: 'browser-title-only',
      category: 'ui',
      description: 'Non-branding change exported individually',
    });

    const manifest = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifest?.patches).toHaveLength(1);
    expect(manifest?.patches[0]?.filesAffected).toEqual([SYNTHETIC_FIREFOX_PATHS.browserScript]);
  });

  it('re-exports a patch with --scan after adding new files to a touched directory', async () => {
    await downloadCommand(projectRoot, {});

    const engineDir = join(projectRoot, 'engine');

    // Export initial moz.build change
    await writeFiles(engineDir, {
      [SYNTHETIC_FIREFOX_PATHS.mozbuild]: 'DIRS += ["newtab"]\nDIRS += ["mybrowser"]\n',
    });
    await exportCommand(projectRoot, [SYNTHETIC_FIREFOX_PATHS.mozbuild], {
      name: 'build-dirs',
      category: 'infra',
      description: 'Add mybrowser to DIRS',
    });

    const manifestBefore = await loadPatchesManifest(join(projectRoot, 'patches'));
    expect(manifestBefore?.patches[0]?.filesAffected).toEqual([SYNTHETIC_FIREFOX_PATHS.mozbuild]);

    // Add a new file in the same directory
    await writeFiles(engineDir, {
      'browser/modules/MyBrowserInit.sys.mjs':
        '/* SPDX-License-Identifier: EUPL-1.2 */\n\n/** Init module. */\nexport function init() {}\n',
    });

    // Re-export with --scan to discover the new file
    await reExportCommand(projectRoot, ['1'], { scan: true });

    const manifestAfter = await loadPatchesManifest(join(projectRoot, 'patches'));
    const updatedPatch = manifestAfter?.patches[0];
    expect(updatedPatch?.filesAffected).toContain(SYNTHETIC_FIREFOX_PATHS.mozbuild);
    expect(updatedPatch?.filesAffected).toContain('browser/modules/MyBrowserInit.sys.mjs');
  });
});
