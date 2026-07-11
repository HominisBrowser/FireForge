// SPDX-License-Identifier: EUPL-1.2
/**
 * Integration tests for metadata-only `fireforge patch` subcommands.
 * These edit PatchMetadata optional fields without rewriting the `.patch`
 * body — pinning that contract end to end (real fs + manifest reload) is the
 * only way to confirm the exactOptionalPropertyTypes-aware "drop the field"
 * path actually removes the key from disk.
 */

import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HISTORY_LOG_FILENAME } from '../../core/destructive.js';
import { InvalidArgumentError } from '../../errors/base.js';
import {
  createTempProject,
  removeTempProject,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { ensureDir } from '../../utils/fs.js';
import { describeChange, patchLintIgnoreCommand } from '../patch/lint-ignore.js';
import { patchStagedDependencyCommand } from '../patch/staged-dependency.js';
import { patchTierCommand } from '../patch/tier.js';

function makeMetadata(
  filename: string,
  order: number,
  filesAffected: string[],
  extras: Partial<PatchMetadata> = {}
): PatchMetadata {
  return {
    filename,
    order,
    category: 'branding',
    name: filename.replace(/^\d+-\w+-|\.patch$/g, ''),
    description: '',
    createdAt: '2026-04-25T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected,
    ...extras,
  };
}

async function seed(
  patchesDir: string,
  patches: PatchMetadata[],
  bodyByFilename: Record<string, string> = {}
): Promise<void> {
  await ensureDir(patchesDir);
  for (const p of patches) {
    const body = bodyByFilename[p.filename] ?? `# stub body for ${p.filename}\n`;
    await writeFile(join(patchesDir, p.filename), body);
  }
  const manifest: PatchesManifest = { version: 1, patches };
  await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
}

async function loadManifest(patchesDir: string): Promise<PatchesManifest> {
  const raw = await readFile(join(patchesDir, 'patches.json'), 'utf-8');
  return JSON.parse(raw) as PatchesManifest;
}

describe('patch tier', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-pt-');
    await writeFireForgeConfig(projectRoot);
    patchesDir = join(projectRoot, 'patches');
  });
  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('--tier branding writes tier into the manifest entry', async () => {
    await seed(patchesDir, [
      makeMetadata('001-branding-assets.patch', 1, ['browser/branding/custom/logo.png']),
    ]);

    await patchTierCommand(projectRoot, '001-branding-assets.patch', {
      tier: 'branding',
      yes: true,
    });

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]?.tier).toBe('branding');
  });

  it('--clear removes the tier field entirely from the manifest entry', async () => {
    await seed(patchesDir, [
      makeMetadata('001-branding-assets.patch', 1, ['browser/branding/custom/logo.png'], {
        tier: 'branding',
      }),
    ]);

    await patchTierCommand(projectRoot, '001-branding-assets.patch', { clear: true, yes: true });

    const manifest = await loadManifest(patchesDir);
    // The on-disk JSON must omit the field — the validator preserves
    // only-when-present, and a stale `tier: undefined` would round-trip
    // back as a JSON parse error or a stray null.
    expect(manifest.patches[0]).not.toHaveProperty('tier');
  });

  it('rejects --tier and --clear together (mode mutex)', async () => {
    await seed(patchesDir, [
      makeMetadata('001-branding-assets.patch', 1, ['browser/branding/custom/logo.png']),
    ]);

    await expect(
      patchTierCommand(projectRoot, '001-branding-assets.patch', {
        tier: 'branding',
        clear: true,
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('rejects an invocation with neither --tier nor --clear', async () => {
    await seed(patchesDir, [
      makeMetadata('001-branding-assets.patch', 1, ['browser/branding/custom/logo.png']),
    ]);

    await expect(
      patchTierCommand(projectRoot, '001-branding-assets.patch', {})
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('resolves the patch by manifest `name` field, not just filename', async () => {
    await seed(patchesDir, [
      makeMetadata('001-branding-assets.patch', 1, ['browser/branding/custom/logo.png'], {
        name: 'branding-assets',
      }),
    ]);

    await patchTierCommand(projectRoot, 'branding-assets', { tier: 'branding', yes: true });

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]?.tier).toBe('branding');
  });

  it('--dry-run does not write the manifest', async () => {
    await seed(patchesDir, [
      makeMetadata('001-branding-assets.patch', 1, ['browser/branding/custom/logo.png']),
    ]);
    const manifestPath = join(patchesDir, 'patches.json');
    const beforeMtime = (await stat(manifestPath)).mtimeMs;

    await patchTierCommand(projectRoot, '001-branding-assets.patch', {
      tier: 'branding',
      dryRun: true,
    });

    const afterMtime = (await stat(manifestPath)).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
  });

  it('does not modify the .patch file body (metadata-only contract)', async () => {
    await seed(
      patchesDir,
      [makeMetadata('001-branding-assets.patch', 1, ['browser/branding/custom/logo.png'])],
      { '001-branding-assets.patch': '# original body marker\n' }
    );
    const patchPath = join(patchesDir, '001-branding-assets.patch');
    const beforeMtime = (await stat(patchPath)).mtimeMs;

    await patchTierCommand(projectRoot, '001-branding-assets.patch', {
      tier: 'branding',
      yes: true,
    });

    const afterMtime = (await stat(patchPath)).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
    const body = await readFile(patchPath, 'utf-8');
    expect(body).toBe('# original body marker\n');
  });

  it('appends a history entry on success', async () => {
    await seed(patchesDir, [
      makeMetadata('001-branding-assets.patch', 1, ['browser/branding/custom/logo.png']),
    ]);

    await patchTierCommand(projectRoot, '001-branding-assets.patch', {
      tier: 'branding',
      yes: true,
    });

    const historyPath = join(patchesDir, HISTORY_LOG_FILENAME);
    const history = await readFile(historyPath, 'utf-8');
    interface HistoryRecord {
      operation: string;
      args: { filename: string; after?: string };
    }
    const entry = JSON.parse(history.trim()) as HistoryRecord;
    expect(entry.operation).toBe('patch-tier');
    expect(entry.args.filename).toBe('001-branding-assets.patch');
    expect(entry.args.after).toBe('branding');
  });

  it('is a no-op when --tier matches the existing tier', async () => {
    await seed(patchesDir, [
      makeMetadata('001-branding-assets.patch', 1, ['browser/branding/custom/logo.png'], {
        tier: 'branding',
      }),
    ]);
    const manifestPath = join(patchesDir, 'patches.json');
    const beforeMtime = (await stat(manifestPath)).mtimeMs;

    await patchTierCommand(projectRoot, '001-branding-assets.patch', {
      tier: 'branding',
      yes: true,
    });

    const afterMtime = (await stat(manifestPath)).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
  });
});

describe('patch lint-ignore', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-pli-');
    await writeFireForgeConfig(projectRoot);
    patchesDir = join(projectRoot, 'patches');
  });
  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('--add adds an entry to an empty list', async () => {
    await seed(patchesDir, [makeMetadata('001-branding-a.patch', 1, ['a.js'])]);

    await patchLintIgnoreCommand(projectRoot, '001-branding-a.patch', {
      add: ['large-patch-files'],
      yes: true,
    });

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]?.lintIgnore).toEqual(['large-patch-files']);
  });

  it('--add with multiple values lands all of them on an empty list', async () => {
    await seed(patchesDir, [makeMetadata('001-branding-a.patch', 1, ['a.js'])]);

    await patchLintIgnoreCommand(projectRoot, '001-branding-a.patch', {
      add: ['large-patch-files', 'large-patch-lines'],
      yes: true,
    });

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]?.lintIgnore).toEqual(
      expect.arrayContaining(['large-patch-files', 'large-patch-lines'])
    );
    expect(manifest.patches[0]?.lintIgnore).toHaveLength(2);
  });

  it('--add unions with the existing list (append, no replace)', async () => {
    await seed(patchesDir, [
      makeMetadata('001-branding-a.patch', 1, ['a.js'], { lintIgnore: ['existing-rule'] }),
    ]);

    await patchLintIgnoreCommand(projectRoot, '001-branding-a.patch', {
      add: ['large-patch-files'],
      yes: true,
    });

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]?.lintIgnore).toEqual(
      expect.arrayContaining(['existing-rule', 'large-patch-files'])
    );
    expect(manifest.patches[0]?.lintIgnore).toHaveLength(2);
  });

  it('--add de-duplicates entries already in the list', async () => {
    await seed(patchesDir, [
      makeMetadata('001-branding-a.patch', 1, ['a.js'], { lintIgnore: ['large-patch-files'] }),
    ]);

    await patchLintIgnoreCommand(projectRoot, '001-branding-a.patch', {
      add: ['large-patch-files'],
      yes: true,
    });

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]?.lintIgnore).toEqual(['large-patch-files']);
  });

  it('--remove drops an entry from the list', async () => {
    await seed(patchesDir, [
      makeMetadata('001-branding-a.patch', 1, ['a.js'], {
        lintIgnore: ['large-patch-files', 'large-patch-lines'],
      }),
    ]);

    await patchLintIgnoreCommand(projectRoot, '001-branding-a.patch', {
      remove: ['large-patch-files'],
      yes: true,
    });

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]?.lintIgnore).toEqual(['large-patch-lines']);
  });

  it('--remove of an absent entry is a no-op', async () => {
    await seed(patchesDir, [
      makeMetadata('001-branding-a.patch', 1, ['a.js'], { lintIgnore: ['large-patch-lines'] }),
    ]);

    await patchLintIgnoreCommand(projectRoot, '001-branding-a.patch', {
      remove: ['large-patch-files'],
      yes: true,
    });

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]?.lintIgnore).toEqual(['large-patch-lines']);
  });

  it('--remove that empties the list drops the field from the manifest entirely', async () => {
    // The validator preserves only-when-present; an empty array would
    // round-trip back as `lintIgnore: []` and grow noise. The spread +
    // unset path keeps the manifest minimal.
    await seed(patchesDir, [
      makeMetadata('001-branding-a.patch', 1, ['a.js'], { lintIgnore: ['large-patch-files'] }),
    ]);

    await patchLintIgnoreCommand(projectRoot, '001-branding-a.patch', {
      remove: ['large-patch-files'],
      yes: true,
    });

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]).not.toHaveProperty('lintIgnore');
  });

  it('--clear drops the field entirely', async () => {
    await seed(patchesDir, [
      makeMetadata('001-branding-a.patch', 1, ['a.js'], {
        lintIgnore: ['large-patch-files', 'large-patch-lines'],
      }),
    ]);

    await patchLintIgnoreCommand(projectRoot, '001-branding-a.patch', { clear: true, yes: true });

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]).not.toHaveProperty('lintIgnore');
  });

  it('rejects --add and --remove together (mode mutex)', async () => {
    await seed(patchesDir, [makeMetadata('001-branding-a.patch', 1, ['a.js'])]);

    await expect(
      patchLintIgnoreCommand(projectRoot, '001-branding-a.patch', {
        add: ['foo'],
        remove: ['bar'],
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('rejects --clear and --add together (mode mutex)', async () => {
    await seed(patchesDir, [makeMetadata('001-branding-a.patch', 1, ['a.js'])]);

    await expect(
      patchLintIgnoreCommand(projectRoot, '001-branding-a.patch', {
        clear: true,
        add: ['foo'],
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('rejects an invocation with no mode flag', async () => {
    await seed(patchesDir, [makeMetadata('001-branding-a.patch', 1, ['a.js'])]);

    await expect(
      patchLintIgnoreCommand(projectRoot, '001-branding-a.patch', {})
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('--dry-run does not write the manifest', async () => {
    await seed(patchesDir, [makeMetadata('001-branding-a.patch', 1, ['a.js'])]);
    const manifestPath = join(patchesDir, 'patches.json');
    const beforeMtime = (await stat(manifestPath)).mtimeMs;

    await patchLintIgnoreCommand(projectRoot, '001-branding-a.patch', {
      add: ['large-patch-files'],
      dryRun: true,
    });

    const afterMtime = (await stat(manifestPath)).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
  });

  it('does not modify the .patch file body (metadata-only contract)', async () => {
    await seed(patchesDir, [makeMetadata('001-branding-a.patch', 1, ['a.js'])], {
      '001-branding-a.patch': '# original body marker\n',
    });
    const patchPath = join(patchesDir, '001-branding-a.patch');
    const beforeMtime = (await stat(patchPath)).mtimeMs;

    await patchLintIgnoreCommand(projectRoot, '001-branding-a.patch', {
      add: ['large-patch-files'],
      yes: true,
    });

    const afterMtime = (await stat(patchPath)).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
    const body = await readFile(patchPath, 'utf-8');
    expect(body).toBe('# original body marker\n');
  });

  it('appends a history entry on success', async () => {
    await seed(patchesDir, [makeMetadata('001-branding-a.patch', 1, ['a.js'])]);

    await patchLintIgnoreCommand(projectRoot, '001-branding-a.patch', {
      add: ['large-patch-files'],
      yes: true,
    });

    const historyPath = join(patchesDir, HISTORY_LOG_FILENAME);
    const history = await readFile(historyPath, 'utf-8');
    interface HistoryRecord {
      operation: string;
      args: { filename: string; mode: string; after: string[] };
    }
    const entry = JSON.parse(history.trim()) as HistoryRecord;
    expect(entry.operation).toBe('patch-lint-ignore');
    expect(entry.args.filename).toBe('001-branding-a.patch');
    expect(entry.args.mode).toBe('add');
    expect(entry.args.after).toEqual(['large-patch-files']);
  });
});

describe('patch staged-dependency', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-psd-');
    await writeFireForgeConfig(projectRoot);
    patchesDir = join(projectRoot, 'patches');
  });
  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('--add writes a staged forward-import declaration', async () => {
    await seed(patchesDir, [makeMetadata('001-ui-shim.patch', 1, ['foo/A.sys.mjs'])]);

    await patchStagedDependencyCommand(projectRoot, '001-ui-shim.patch', {
      add: true,
      file: 'foo/A.sys.mjs',
      specifier: 'resource:///modules/B.sys.mjs',
      creates: 'foo/B.sys.mjs',
      owner: '002-ui-helper.patch',
      reason: 'shared helper staged later',
    });

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]?.stagedDependencies?.forwardImports).toEqual([
      {
        file: 'foo/A.sys.mjs',
        specifier: 'resource:///modules/B.sys.mjs',
        creates: 'foo/B.sys.mjs',
        owner: '002-ui-helper.patch',
        reason: 'shared helper staged later',
      },
    ]);
  });

  it('--remove deletes matching declarations and clears the field when empty', async () => {
    await seed(patchesDir, [
      makeMetadata('001-ui-shim.patch', 1, ['foo/A.sys.mjs'], {
        stagedDependencies: {
          forwardImports: [
            {
              file: 'foo/A.sys.mjs',
              specifier: 'resource:///modules/B.sys.mjs',
              creates: 'foo/B.sys.mjs',
            },
          ],
        },
      }),
    ]);

    await patchStagedDependencyCommand(projectRoot, '001-ui-shim.patch', {
      remove: true,
      file: 'foo/A.sys.mjs',
      specifier: 'resource:///modules/B.sys.mjs',
      creates: 'foo/B.sys.mjs',
    });

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]).not.toHaveProperty('stagedDependencies');
  });

  it('--clear removes all staged dependency metadata', async () => {
    await seed(patchesDir, [
      makeMetadata('001-ui-shim.patch', 1, ['foo/A.sys.mjs'], {
        stagedDependencies: {
          forwardImports: [
            {
              file: 'foo/A.sys.mjs',
              specifier: 'resource:///modules/B.sys.mjs',
              creates: 'foo/B.sys.mjs',
            },
          ],
        },
      }),
    ]);

    await patchStagedDependencyCommand(projectRoot, '001-ui-shim.patch', { clear: true });

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]).not.toHaveProperty('stagedDependencies');
  });

  it('--dry-run leaves the manifest unchanged', async () => {
    await seed(patchesDir, [makeMetadata('001-ui-shim.patch', 1, ['foo/A.sys.mjs'])]);
    const manifestPath = join(patchesDir, 'patches.json');
    const beforeMtime = (await stat(manifestPath)).mtimeMs;

    await patchStagedDependencyCommand(projectRoot, '001-ui-shim.patch', {
      add: true,
      file: 'foo/A.sys.mjs',
      specifier: 'resource:///modules/B.sys.mjs',
      creates: 'foo/B.sys.mjs',
      dryRun: true,
    });

    const afterMtime = (await stat(manifestPath)).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
  });

  it('does not modify the .patch file body', async () => {
    await seed(patchesDir, [makeMetadata('001-ui-shim.patch', 1, ['foo/A.sys.mjs'])], {
      '001-ui-shim.patch': '# original body marker\n',
    });
    const patchPath = join(patchesDir, '001-ui-shim.patch');
    const beforeMtime = (await stat(patchPath)).mtimeMs;

    await patchStagedDependencyCommand(projectRoot, '001-ui-shim.patch', {
      add: true,
      file: 'foo/A.sys.mjs',
      specifier: 'resource:///modules/B.sys.mjs',
      creates: 'foo/B.sys.mjs',
    });

    const afterMtime = (await stat(patchPath)).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
    await expect(readFile(patchPath, 'utf-8')).resolves.toBe('# original body marker\n');
  });

  it('rejects add without exact dependency fields', async () => {
    await seed(patchesDir, [makeMetadata('001-ui-shim.patch', 1, ['foo/A.sys.mjs'])]);

    await expect(
      patchStagedDependencyCommand(projectRoot, '001-ui-shim.patch', { add: true })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  // ── 0.37.0 item 5: registration-kind entries ──

  it('--add --kind registration writes a registrations declaration', async () => {
    await seed(patchesDir, [makeMetadata('200-ui-jar.patch', 200, ['toolkit/content/jar.mn'])]);

    await patchStagedDependencyCommand(projectRoot, '200-ui-jar.patch', {
      add: true,
      kind: 'registration',
      file: 'toolkit/content/jar.mn',
      line: 'content/global/widgets/hominis-history-ui.js (widgets/hominis-history-ui.js)',
      creates: 'toolkit/content/widgets/hominis-history-ui.js',
      owner: '248-ui-history.patch',
    });

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]?.stagedDependencies?.registrations).toEqual([
      {
        file: 'toolkit/content/jar.mn',
        line: 'content/global/widgets/hominis-history-ui.js (widgets/hominis-history-ui.js)',
        creates: 'toolkit/content/widgets/hominis-history-ui.js',
        owner: '248-ui-history.patch',
      },
    ]);
    expect(manifest.patches[0]?.stagedDependencies?.forwardImports).toBeUndefined();
  });

  it('--remove --kind registration deletes the entry and clears the field when empty', async () => {
    await seed(patchesDir, [
      makeMetadata('200-ui-jar.patch', 200, ['toolkit/content/jar.mn'], {
        stagedDependencies: {
          registrations: [
            {
              file: 'toolkit/content/jar.mn',
              line: 'content/global/a.js (a.js)',
              creates: 'toolkit/content/a.js',
            },
          ],
        },
      }),
    ]);

    await patchStagedDependencyCommand(projectRoot, '200-ui-jar.patch', {
      remove: true,
      kind: 'registration',
      file: 'toolkit/content/jar.mn',
      line: 'content/global/a.js (a.js)',
      creates: 'toolkit/content/a.js',
    });

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]).not.toHaveProperty('stagedDependencies');
  });

  it('registration operations leave forwardImports of the same patch untouched', async () => {
    await seed(patchesDir, [
      makeMetadata('001-ui-shim.patch', 1, ['foo/A.sys.mjs'], {
        stagedDependencies: {
          forwardImports: [
            {
              file: 'foo/A.sys.mjs',
              specifier: 'resource:///modules/B.sys.mjs',
              creates: 'foo/B.sys.mjs',
            },
          ],
        },
      }),
    ]);

    await patchStagedDependencyCommand(projectRoot, '001-ui-shim.patch', {
      add: true,
      kind: 'registration',
      file: 'toolkit/content/jar.mn',
      line: 'content/global/a.js (a.js)',
      creates: 'toolkit/content/a.js',
    });

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]?.stagedDependencies?.forwardImports).toHaveLength(1);
    expect(manifest.patches[0]?.stagedDependencies?.registrations).toHaveLength(1);
  });

  it('rejects --kind registration without --line', async () => {
    await seed(patchesDir, [makeMetadata('200-ui-jar.patch', 200, ['toolkit/content/jar.mn'])]);

    await expect(
      patchStagedDependencyCommand(projectRoot, '200-ui-jar.patch', {
        add: true,
        kind: 'registration',
        file: 'toolkit/content/jar.mn',
        creates: 'toolkit/content/a.js',
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('rejects mixing --specifier with --kind registration and --line with --kind import', async () => {
    await seed(patchesDir, [makeMetadata('200-ui-jar.patch', 200, ['toolkit/content/jar.mn'])]);

    await expect(
      patchStagedDependencyCommand(projectRoot, '200-ui-jar.patch', {
        add: true,
        kind: 'registration',
        file: 'toolkit/content/jar.mn',
        specifier: 'resource:///modules/B.sys.mjs',
        line: 'content/global/a.js (a.js)',
        creates: 'toolkit/content/a.js',
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);

    await expect(
      patchStagedDependencyCommand(projectRoot, '200-ui-jar.patch', {
        add: true,
        file: 'toolkit/content/jar.mn',
        line: 'content/global/a.js (a.js)',
        creates: 'toolkit/content/a.js',
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });
});

describe('patch lint-ignore — describeChange message format', () => {
  it('--add no-op surfaces the existing list so the operator does not need to read patches.json', () => {
    const message = describeChange(
      ['existing-rule', 'modified-file-missing-header'],
      ['existing-rule', 'modified-file-missing-header'],
      'add',
      ['modified-file-missing-header']
    );
    expect(message).toContain('current: [existing-rule, modified-file-missing-header]');
    expect(message).toContain('all requested IDs already present');
  });

  it('--add no-op against an empty list reports `(empty)` for clarity', () => {
    const message = describeChange([], [], 'add', []);
    // Add with zero net additions over an empty list — the no-op branch
    // still fires; the operator should see the empty marker rather than
    // a bare `[]` that could read as a placeholder.
    expect(message).toContain('current: (empty)');
  });

  it('--remove no-op surfaces the existing list', () => {
    const message = describeChange(['existing-rule'], ['existing-rule'], 'remove', ['absent-id']);
    expect(message).toContain('current: [existing-rule]');
    expect(message).toContain('none of the requested IDs were present');
  });
});

describe('destructive-operation contract (2026-07-05 review follow-up)', () => {
  // Both commands mutate manifest metadata and append history; they must
  // follow the same summary + dry-run + confirmation/--yes contract as
  // patch delete/reorder/compact. They used to accept --yes without ever
  // prompting, so the flag only appeared in the history record.
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-dc-');
    await writeFireForgeConfig(projectRoot);
    patchesDir = join(projectRoot, 'patches');
  });
  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('patch tier refuses non-interactively without --yes and leaves the manifest untouched', async () => {
    await seed(patchesDir, [makeMetadata('001-branding-assets.patch', 1, ['a.js'])]);

    await expect(
      patchTierCommand(projectRoot, '001-branding-assets.patch', { tier: 'branding' })
    ).rejects.toThrow(/Use --yes to run non-interactively/);

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]?.tier).toBeUndefined();
  });

  it('patch lint-ignore refuses non-interactively without --yes and leaves the manifest untouched', async () => {
    await seed(patchesDir, [makeMetadata('001-branding-a.patch', 1, ['a.js'])]);

    await expect(
      patchLintIgnoreCommand(projectRoot, '001-branding-a.patch', {
        add: ['large-patch-files'],
      })
    ).rejects.toThrow(/Use --yes to run non-interactively/);

    const manifest = await loadManifest(patchesDir);
    expect(manifest.patches[0]?.lintIgnore).toBeUndefined();
  });
});
