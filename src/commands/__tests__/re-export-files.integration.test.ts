// SPDX-License-Identifier: EUPL-1.2
/**
 * Integration coverage for `re-export --files`. Uses a real runGit repo so
 * the diff-generation path runs, and exercises the destructive-safety
 * contract plus the projection-lint fix: the lint pass must now run
 * against the shrunken/expanded state, not the current queue.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InvalidArgumentError } from '../../errors/base.js';
import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  runGit,
  setInteractiveMode,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { ensureDir, pathExists } from '../../utils/fs.js';
import { reExportCommand } from '../re-export.js';

vi.mock('@clack/prompts', async () => {
  const actual = await vi.importActual<typeof import('@clack/prompts')>('@clack/prompts');
  return {
    ...actual,
    confirm: vi.fn(),
  };
});

function makeMetadata(filename: string, order: number, filesAffected: string[]): PatchMetadata {
  return {
    filename,
    order,
    category: 'infra',
    name: 'test',
    description: '',
    createdAt: '2025-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected,
  };
}

async function seedManifest(
  patchesDir: string,
  patches: Array<{ metadata: PatchMetadata; body: string }>
): Promise<void> {
  await ensureDir(patchesDir);
  for (const p of patches) {
    await writeFile(join(patchesDir, p.metadata.filename), p.body);
  }
  const manifest: PatchesManifest = {
    version: 1,
    patches: patches.map((p) => p.metadata),
  };
  await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
}

describe('re-export --files integration', () => {
  let projectRoot: string;
  let engineDir: string;
  let patchesDir: string;
  let restoreTTY: () => void = () => undefined;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-re-export-files-');
    await writeFireForgeConfig(projectRoot);
    engineDir = join(projectRoot, 'engine');
    patchesDir = join(projectRoot, 'patches');

    // Initialize a real git repo with a seed file so
    // getDiffForFilesAgainstHead has something to compute against.
    await initCommittedRepo(engineDir, {
      'browser/base/content/browser.js': 'original;\n',
      'browser/base/content/browser.css': '.root { color: red; }\n',
    });

    restoreTTY = setInteractiveMode(false);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    restoreTTY();
    vi.restoreAllMocks();
    await removeTempProject(projectRoot);
  });

  it('--files rejects mutually exclusive --scan', async () => {
    await seedManifest(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['browser/base/content/browser.js']),
        body: '(unused — validation throws before reading)',
      },
    ]);
    await expect(
      reExportCommand(projectRoot, ['001-infra-a.patch'], {
        files: ['browser/base/content/browser.js'],
        scan: true,
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('--files rejects zero target patches', async () => {
    await seedManifest(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['browser/base/content/browser.js']),
        body: '(unused)',
      },
    ]);
    await expect(
      reExportCommand(projectRoot, [], {
        files: ['browser/base/content/browser.js'],
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('--files additive/same-scope non-TTY proceeds without --yes', async () => {
    await seedManifest(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['browser/base/content/browser.js']),
        body: '',
      },
    ]);
    // Make an actual modification so the diff is non-empty.
    await writeFile(join(engineDir, 'browser/base/content/browser.js'), 'modified;\n');
    await expect(
      reExportCommand(projectRoot, ['001-infra-a.patch'], {
        files: ['browser/base/content/browser.js'],
      })
    ).resolves.toBeUndefined();
  });

  it('--files shrink non-TTY without --yes rejects', async () => {
    await seedManifest(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, [
          'browser/base/content/browser.js',
          'browser/base/content/browser.css',
        ]),
        body: '',
      },
    ]);
    await writeFile(join(engineDir, 'browser/base/content/browser.js'), 'modified;\n');

    await expect(
      reExportCommand(projectRoot, ['001-infra-a.patch'], {
        files: ['browser/base/content/browser.js'],
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('--files --force writes the shrunken patch and history entry', async () => {
    await seedManifest(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, [
          'browser/base/content/browser.js',
          'browser/base/content/browser.css',
        ]),
        body: '',
      },
    ]);
    // Modify only browser.js so the shrink that drops browser.css is
    // sensible.
    await writeFile(join(engineDir, 'browser/base/content/browser.js'), 'shrunken content;\n');

    await reExportCommand(projectRoot, ['001-infra-a.patch'], {
      files: ['browser/base/content/browser.js'],
      yes: true,
    });

    const manifest = JSON.parse(
      await readFile(join(patchesDir, 'patches.json'), 'utf-8')
    ) as PatchesManifest;
    expect(manifest.patches[0]?.filesAffected).toEqual(['browser/base/content/browser.js']);

    // History entry must be appended.
    expect(await pathExists(join(patchesDir, '.fireforge-history.jsonl'))).toBe(true);
    const history = await readFile(join(patchesDir, '.fireforge-history.jsonl'), 'utf-8');
    expect(history).toContain('re-export-files');

    // And the patch file itself must contain the new diff body (with the
    // shrunken content).
    const newBody = await readFile(join(patchesDir, '001-infra-a.patch'), 'utf-8');
    expect(newBody).toContain('browser/base/content/browser.js');
    expect(newBody).not.toContain('browser/base/content/browser.css');
  });

  it('--files --dry-run does not write and does not append history', async () => {
    await seedManifest(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, [
          'browser/base/content/browser.js',
          'browser/base/content/browser.css',
        ]),
        body: 'unchanged',
      },
    ]);
    await writeFile(join(engineDir, 'browser/base/content/browser.js'), 'modified;\n');

    await reExportCommand(projectRoot, ['001-infra-a.patch'], {
      files: ['browser/base/content/browser.js'],
      dryRun: true,
      yes: true,
    });

    const manifest = JSON.parse(
      await readFile(join(patchesDir, 'patches.json'), 'utf-8')
    ) as PatchesManifest;
    expect(manifest.patches[0]?.filesAffected).toEqual([
      'browser/base/content/browser.js',
      'browser/base/content/browser.css',
    ]);
    const body = await readFile(join(patchesDir, '001-infra-a.patch'), 'utf-8');
    expect(body).toBe('unchanged');
    expect(await pathExists(join(patchesDir, '.fireforge-history.jsonl'))).toBe(false);
  });

  it('--files rejects a scope that would erase the patch body entirely', async () => {
    await seedManifest(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, ['browser/base/content/browser.js']),
        body: 'unchanged',
      },
    ]);
    // Leave browser.js identical to HEAD so the projected scope produces
    // no hunks. Writing an empty .patch file would break later import/apply.
    await expect(
      reExportCommand(projectRoot, ['001-infra-a.patch'], {
        files: ['browser/base/content/browser.js'],
        yes: true,
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);

    const manifest = JSON.parse(
      await readFile(join(patchesDir, 'patches.json'), 'utf-8')
    ) as PatchesManifest;
    expect(manifest.patches[0]?.filesAffected).toEqual(['browser/base/content/browser.js']);
    expect(await readFile(join(patchesDir, '001-infra-a.patch'), 'utf-8')).toBe('unchanged');
    expect(await pathExists(join(patchesDir, '.fireforge-history.jsonl'))).toBe(false);
  });

  it('--files drops missing paths from the persisted manifest, not just the diff', async () => {
    // Regression: the command used to warn "missing on disk — will be
    // dropped" and then write filesAffected: requested (including the
    // missing path), leaving patches.json out of sync with the body.
    await seedManifest(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, [
          'browser/base/content/browser.js',
          'browser/base/content/browser.css',
        ]),
        body: '',
      },
    ]);
    // Modify one file; delete the other so --files catches a missing path.
    await writeFile(join(engineDir, 'browser/base/content/browser.js'), 'present and modified;\n');
    const { rm } = await import('node:fs/promises');
    await rm(join(engineDir, 'browser/base/content/browser.css'));

    await reExportCommand(projectRoot, ['001-infra-a.patch'], {
      files: ['browser/base/content/browser.js', 'browser/base/content/browser.css'],
      yes: true,
    });

    const manifest = JSON.parse(
      await readFile(join(patchesDir, 'patches.json'), 'utf-8')
    ) as PatchesManifest;
    expect(manifest.patches[0]?.filesAffected).toEqual(['browser/base/content/browser.js']);

    const newBody = await readFile(join(patchesDir, '001-infra-a.patch'), 'utf-8');
    expect(newBody).toContain('browser/base/content/browser.js');
    expect(newBody).not.toContain('browser/base/content/browser.css');

    // History payload should record both the persisted files and the
    // missing-files-dropped audit trail.
    const history = await readFile(join(patchesDir, '.fireforge-history.jsonl'), 'utf-8');
    interface HistoryRecord {
      args: { files?: string[]; missingFilesDropped?: string[] };
    }
    const entry = JSON.parse(history.trim()) as HistoryRecord;
    expect(entry.args.files).toEqual(['browser/base/content/browser.js']);
    expect(entry.args.missingFilesDropped).toEqual(['browser/base/content/browser.css']);
  });

  it('--files rejects unchanged requested paths instead of desyncing filesAffected', async () => {
    await seedManifest(patchesDir, [
      {
        metadata: makeMetadata('001-infra-a.patch', 1, [
          'browser/base/content/browser.js',
          'browser/base/content/browser.css',
        ]),
        body: 'unchanged',
      },
    ]);
    await writeFile(join(engineDir, 'browser/base/content/browser.js'), 'changed;\n');

    await expect(
      reExportCommand(projectRoot, ['001-infra-a.patch'], {
        files: ['browser/base/content/browser.js', 'browser/base/content/browser.css'],
        yes: true,
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);

    const manifest = JSON.parse(
      await readFile(join(patchesDir, 'patches.json'), 'utf-8')
    ) as PatchesManifest;
    expect(manifest.patches[0]?.filesAffected).toEqual([
      'browser/base/content/browser.js',
      'browser/base/content/browser.css',
    ]);
    expect(await readFile(join(patchesDir, '001-infra-a.patch'), 'utf-8')).toBe('unchanged');
    expect(await pathExists(join(patchesDir, '.fireforge-history.jsonl'))).toBe(false);
  });

  it('--files --force does NOT block on a pre-existing issue in an unrelated patch', async () => {
    // Fix 2: a dirty queue with a cross-patch forward-import error
    // between two *other* patches must not prevent shrinking a third,
    // unrelated patch. Before the fix, `reExportFilesInPlace` treated
    // any error anywhere in the projected queue as a conflict, so users
    // could not reach for `re-export --files` to repair a broken queue
    // — which is one of the main reasons the command exists.
    //
    // Queue shape:
    //   001 creates foo/Helper.sys.mjs with `import ... Target.sys.mjs`
    //   002 creates foo/Target.sys.mjs (creator lives AFTER the importer
    //       → pre-existing forward-import error between 001 and 002)
    //   003 claims browser.js, entirely unrelated
    //
    // Shrinking 003 to `--files [browser.js]` should succeed. The
    // 001/002 error should remain, surfaced as a warning rather than a
    // hard block.
    const helperImporterDiff = [
      'diff --git a/foo/Helper.sys.mjs b/foo/Helper.sys.mjs',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/foo/Helper.sys.mjs',
      '@@ -0,0 +1,1 @@',
      '+import { X } from "resource:///modules/Target.sys.mjs";',
    ].join('\n');
    const targetCreatorDiff = [
      'diff --git a/foo/Target.sys.mjs b/foo/Target.sys.mjs',
      'new file mode 100644',
      'index 0000000..2222222',
      '--- /dev/null',
      '+++ b/foo/Target.sys.mjs',
      '@@ -0,0 +1,1 @@',
      '+export const X = 1;',
    ].join('\n');
    await seedManifest(patchesDir, [
      {
        metadata: makeMetadata('001-infra-helper.patch', 1, ['foo/Helper.sys.mjs']),
        body: helperImporterDiff,
      },
      {
        metadata: makeMetadata('002-infra-target.patch', 2, ['foo/Target.sys.mjs']),
        body: targetCreatorDiff,
      },
      {
        metadata: makeMetadata('003-infra-unrelated.patch', 3, ['browser/base/content/browser.js']),
        body: '',
      },
    ]);
    await writeFile(join(engineDir, 'browser/base/content/browser.js'), 'clean;\n');

    // Should not throw — the 001/002 error is pre-existing and unrelated.
    await reExportCommand(projectRoot, ['003-infra-unrelated.patch'], {
      files: ['browser/base/content/browser.js'],
      yes: true,
    });

    const newBody = await readFile(join(patchesDir, '003-infra-unrelated.patch'), 'utf-8');
    expect(newBody).toContain('clean;');

    // The pre-existing patches must still be present, untouched.
    expect(await readFile(join(patchesDir, '001-infra-helper.patch'), 'utf-8')).toBe(
      helperImporterDiff
    );
    expect(await readFile(join(patchesDir, '002-infra-target.patch'), 'utf-8')).toBe(
      targetCreatorDiff
    );
  });

  it('--files --force DOES block when the shrink introduces a NEW cross-patch error', async () => {
    // Fix 2 negative: the regression-only gate must still fire when the
    // shrink itself introduces an error. Otherwise we'd have traded one
    // class of miss for another.
    //
    // Construction:
    //   001 claims browser.js with an EMPTY body (baseline has no added
    //       lines → no forward-import from 001)
    //   002 creates foo/Helper.sys.mjs (order 2)
    // On disk: modify browser.js to add `import "./Helper.sys.mjs"`.
    // Shrinking 001 --files [browser.js] regenerates 001's diff from
    // the dirty engine state, so 001's new modifiedFileAdditions now
    // contains the import. Projected check: 001 (order 1) imports a
    // leaf owned by 002 (order 2) → new forward-import error that the
    // baseline did not have → regression → must reject.
    const targetCreatorDiff = [
      'diff --git a/foo/Helper.sys.mjs b/foo/Helper.sys.mjs',
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/foo/Helper.sys.mjs',
      '@@ -0,0 +1,1 @@',
      '+export const Helper = 1;',
    ].join('\n');
    await seedManifest(patchesDir, [
      {
        metadata: makeMetadata('001-infra-target.patch', 1, ['browser/base/content/browser.js']),
        body: '',
      },
      {
        metadata: makeMetadata('002-infra-helper.patch', 2, ['foo/Helper.sys.mjs']),
        body: targetCreatorDiff,
      },
    ]);
    // Dirty the engine's browser.js with a forward import into Helper.
    await writeFile(
      join(engineDir, 'browser/base/content/browser.js'),
      'import { H } from "resource:///modules/Helper.sys.mjs";\n'
    );

    await expect(
      reExportCommand(projectRoot, ['001-infra-target.patch'], {
        files: ['browser/base/content/browser.js'],
        yes: true,
      })
    ).rejects.toThrow();
  });

  it('rejects reserved exceptions when projected files exceed the policy allowlist', async () => {
    await writeFireForgeConfig(projectRoot, {
      patchPolicy: {
        ranges: [{ from: 100, to: 199, category: 'infra' }],
        reservedRanges: [
          {
            from: 900,
            to: 999,
            allowed: [
              {
                filename: '900-infra-bootstrap-workaround.patch',
                files: ['browser/base/content/browser.js'],
                adr: 'docs/architecture/adr/0001-bootstrap-workaround.md',
              },
            ],
          },
        ],
      },
    });
    await seedManifest(patchesDir, [
      {
        metadata: {
          ...makeMetadata('900-infra-bootstrap-workaround.patch', 900, [
            'browser/base/content/browser.js',
          ]),
          description: 'bootstrap workaround',
        },
        body: '',
      },
    ]);
    await writeFile(join(engineDir, 'browser/base/content/browser.js'), 'modified;\n');
    await writeFile(
      join(engineDir, 'browser/base/content/browser.css'),
      '.root { color: blue; }\n'
    );

    await expect(
      reExportCommand(projectRoot, ['900-infra-bootstrap-workaround.patch'], {
        files: ['browser/base/content/browser.js', 'browser/base/content/browser.css'],
        yes: true,
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  // Keep git happy across test reordering.
  afterEach(async () => {
    try {
      await runGit(engineDir, ['reset', '--hard', 'HEAD']);
    } catch {
      // Ignore — the temp project may already be gone.
    }
  });
});
