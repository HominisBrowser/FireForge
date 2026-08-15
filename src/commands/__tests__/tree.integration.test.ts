// SPDX-License-Identifier: EUPL-1.2
/**
 * End-to-end coverage for `fireforge tree` (FORGE G15): real tempdir +
 * git, real clone (CoW when the filesystem supports it — the create path
 * probes and uses clonefile/reflink on APFS/btrfs; `--force-copy` keeps
 * the same path green on ext4 CI runners), and the read-only guard
 * enforced through the real commander program.
 */
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readTreeMarker } from '../../core/tree-store.js';
import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
  writeFireForgeConfig,
  writeSyntheticObjdir,
} from '../../test-utils/index.js';
import { pathExists } from '../../utils/fs.js';
import { treeCreateCommand, treeListCommand, treeRemoveCommand } from '../tree.js';

// `tree create --with-objdir` now runs `mach configure` inside the clone;
// the synthetic objdir has no real mach, so only that call is stubbed —
// everything else in core/mach.js stays real. The default implementation
// (set in beforeEach) simulates a RELOCATING configure — it rewrites the
// cloned config.status/backend.mk to the tree's paths — because the
// post-configure relocation check verifies exactly that; the failure-case
// tests override it per case with mockImplementationOnce.
vi.mock('../../core/mach.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/mach.js')>();
  return { ...actual, runMach: vi.fn(() => Promise.resolve(0)) };
});

vi.mock('../../utils/logger.js', () => ({
  setStdoutSealed: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
  note: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  setVerbose: vi.fn(),
  setMachineOutputMode: vi.fn(),
  spinner: vi.fn(() => ({ message: vi.fn(), stop: vi.fn(), error: vi.fn() })),
}));

import { runMach } from '../../core/mach.js';
import { info } from '../../utils/logger.js';

const describePosix = process.platform === 'win32' ? describe.skip : describe;

describePosix('fireforge tree end to end (FORGE G15)', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(runMach).mockImplementation(async (args: string[], engineDir: string) => {
      if (args[0] === 'configure') {
        const { readdir, writeFile } = await import('node:fs/promises');
        const objDirs = (await readdir(engineDir)).filter((entry) => entry.startsWith('obj-'));
        for (const objDir of objDirs) {
          await writeFile(join(engineDir, objDir, 'config.status'), `topsrcdir = "${engineDir}"\n`);
          await writeFile(join(engineDir, objDir, 'backend.mk'), `topsrcdir := ${engineDir}\n`);
        }
      }
      return 0;
    });
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject('ff-tree-cmd-');
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/base/content/app.js': 'content\n',
    });
    await writeFiles(projectRoot, {
      'patches/patches.json': '{"version":1,"patches":[]}\n',
    });
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('create → list → remove round-trips with a real clone', async () => {
    await treeCreateCommand(projectRoot, 'shard-a', { forceCopy: true });

    const treeRoot = join(projectRoot, '.fireforge', 'trees', 'shard-a');
    await expect(pathExists(join(treeRoot, 'fireforge.json'))).resolves.toBe(true);
    await expect(readTreeMarker(treeRoot)).resolves.toMatchObject({ name: 'shard-a' });

    await treeListCommand(projectRoot);
    expect(vi.mocked(info)).toHaveBeenCalledWith(expect.stringContaining('shard-a'));
    expect(vi.mocked(info)).toHaveBeenCalledWith(expect.stringContaining('fresh'));

    // Duplicate names refuse — refresh is remove + create.
    await expect(treeCreateCommand(projectRoot, 'shard-a', { forceCopy: true })).rejects.toThrow(
      /already exists/
    );

    await treeRemoveCommand(projectRoot, 'shard-a');
    await expect(pathExists(treeRoot)).resolves.toBe(false);
  });

  it('tree list --json emits a machine-readable document', async () => {
    await treeCreateCommand(projectRoot, 'shard-json', { forceCopy: true });
    const writes: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      });
    try {
      await treeListCommand(projectRoot, { json: true });
    } finally {
      stdoutSpy.mockRestore();
    }
    const payload = JSON.parse(writes.join('')) as {
      schemaVersion: number;
      trees: Array<{ name: string; staleness: string }>;
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.trees).toMatchObject([{ name: 'shard-json', staleness: 'fresh' }]);
  });

  it('creating a tree from INSIDE a tree is refused (no nesting)', async () => {
    await treeCreateCommand(projectRoot, 'outer', { forceCopy: true });
    const treeRoot = join(projectRoot, '.fireforge', 'trees', 'outer');

    await expect(treeCreateCommand(treeRoot, 'inner', { forceCopy: true })).rejects.toThrow(
      /cannot be nested/
    );
  });

  it('--with-objdir clones and rewrites the primary build; the guard then admits build-less test', async () => {
    const engineDir = join(projectRoot, 'engine');
    await writeSyntheticObjdir(engineDir, 'obj-e2e');

    await treeCreateCommand(projectRoot, 'shard-obj', { forceCopy: true, withObjdir: true });

    const treeRoot = join(projectRoot, '.fireforge', 'trees', 'shard-obj');
    await expect(readTreeMarker(treeRoot)).resolves.toMatchObject({ clonedObjdir: 'obj-e2e' });
    // The clone was reconfigured IN THE TREE before the marker vouched for it.
    expect(vi.mocked(runMach)).toHaveBeenCalledWith(['configure'], join(treeRoot, 'engine'));
    const { readFile } = await import('node:fs/promises');
    const mozinfo = JSON.parse(
      await readFile(join(treeRoot, 'engine', 'obj-e2e', 'mozinfo.json'), 'utf8')
    ) as Record<string, string>;
    expect(mozinfo['topsrcdir']).toBe(join(treeRoot, 'engine'));

    const { createProgram } = await import('../../cli.js');
    const previousCwd = process.cwd();
    process.chdir(treeRoot);
    try {
      // `test --build` is refused by the guard, naming the primary tree.
      const buildProgram = createProgram();
      buildProgram.exitOverride();
      await expect(
        buildProgram.parseAsync(['node', 'fireforge', 'test', '--build'])
      ).rejects.toThrow(/"test --build" rebuilds the engine and must run in the primary tree/);

      // Build-less `test` passes the guard: it proceeds into the command
      // proper and fails on the synthetic objdir's missing binary — NOT on
      // a tree refusal, and NOT on the relocated-artifacts mismatch the
      // mozinfo rewrite exists to prevent.
      const testProgram = createProgram();
      testProgram.exitOverride();
      const failure = await testProgram.parseAsync(['node', 'fireforge', 'test']).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(failure).toBeDefined();
      expect(String(failure)).not.toMatch(/verification tree|copied or relocated/);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('a refused mozinfo rewrite fails the create and leaves no partial tree behind', async () => {
    // A mozinfo with no topobjdir passes the primary artifact preflight
    // (an undefined field is not a mismatch) but the safe-relocation
    // rewriter refuses it — exercising cloneTree's fail-closed path.
    const engineDir = join(projectRoot, 'engine');
    await writeSyntheticObjdir(engineDir, 'obj-e2e', { topobjdir: null });

    await expect(
      treeCreateCommand(projectRoot, 'shard-bad', { forceCopy: true, withObjdir: true })
    ).rejects.toThrow(/Cannot keep the cloned build/);
    await expect(pathExists(join(projectRoot, '.fireforge', 'trees', 'shard-bad'))).resolves.toBe(
      false
    );

    // The name is immediately reusable (no "already exists" debris).
    await treeCreateCommand(projectRoot, 'shard-bad', { forceCopy: true });
    await expect(pathExists(join(projectRoot, '.fireforge', 'trees', 'shard-bad'))).resolves.toBe(
      true
    );
  });

  it('--with-objdir refuses a symlinked primary objdir and leaves no partial tree behind (FORGE I11)', async () => {
    // An external build symlinked into engine/ passes the symlink-agnostic
    // artifact detection (its mozinfo names the engine paths), but the
    // clone guard must refuse before any copying — the clone would carry
    // the link and rewrite the EXTERNAL build through it.
    const engineDir = join(projectRoot, 'engine');
    const externalRoot = join(projectRoot, 'external-build');
    await writeSyntheticObjdir(externalRoot, 'obj-e2e', {
      topsrcdir: engineDir,
      topobjdir: join(engineDir, 'obj-e2e'),
    });
    const { symlink, readFile } = await import('node:fs/promises');
    await symlink(join(externalRoot, 'obj-e2e'), join(engineDir, 'obj-e2e'));
    const externalMozinfoBefore = await readFile(
      join(externalRoot, 'obj-e2e', 'mozinfo.json'),
      'utf8'
    );

    await expect(
      treeCreateCommand(projectRoot, 'shard-link', { forceCopy: true, withObjdir: true })
    ).rejects.toThrow(/refuses engine\/obj-e2e: it is a symlink/);
    await expect(pathExists(join(projectRoot, '.fireforge', 'trees', 'shard-link'))).resolves.toBe(
      false
    );
    // The external build was never touched.
    await expect(readFile(join(externalRoot, 'obj-e2e', 'mozinfo.json'), 'utf8')).resolves.toBe(
      externalMozinfoBefore
    );
    await expect(pathExists(join(externalRoot, 'obj-e2e', '_virtualenvs'))).resolves.toBe(true);
  });

  it('a configure that exits 0 but leaves the primary path in config.status fails the create (FORGE I10)', async () => {
    const engineDir = join(projectRoot, 'engine');
    await writeSyntheticObjdir(engineDir, 'obj-e2e');
    // Exit 0 while writing nothing: the cloned config.status still embeds
    // the primary engine path the fixture wrote.
    vi.mocked(runMach).mockImplementationOnce(() => Promise.resolve(0));

    await expect(
      treeCreateCommand(projectRoot, 'shard-stale', { forceCopy: true, withObjdir: true })
    ).rejects.toThrow(
      /did not relocate the objdir: obj-e2e\/config\.status still contains the primary engine path/
    );
    await expect(pathExists(join(projectRoot, '.fireforge', 'trees', 'shard-stale'))).resolves.toBe(
      false
    );
  });

  it('a configure that targets a different objdir (no config.status written) fails the create', async () => {
    const engineDir = join(projectRoot, 'engine');
    await writeSyntheticObjdir(engineDir, 'obj-e2e');
    // Simulate a stray MOZCONFIG/MOZ_OBJDIR steering configure elsewhere:
    // exit 0, and the intended objdir's config.status is gone entirely.
    vi.mocked(runMach).mockImplementationOnce(async (args: string[], treeEngineDir: string) => {
      if (args[0] === 'configure') {
        const { rm } = await import('node:fs/promises');
        await rm(join(treeEngineDir, 'obj-e2e', 'config.status'), { force: true });
      }
      return 0;
    });

    await expect(
      treeCreateCommand(projectRoot, 'shard-wrong', { forceCopy: true, withObjdir: true })
    ).rejects.toThrow(/obj-e2e\/config\.status was not written/);
    await expect(pathExists(join(projectRoot, '.fireforge', 'trees', 'shard-wrong'))).resolves.toBe(
      false
    );
  });

  it('a configure that regresses mozinfo back to the primary fails the create', async () => {
    const engineDir = join(projectRoot, 'engine');
    await writeSyntheticObjdir(engineDir, 'obj-e2e');
    vi.mocked(runMach).mockImplementationOnce(async (args: string[], treeEngineDir: string) => {
      if (args[0] === 'configure') {
        const { writeFile } = await import('node:fs/promises');
        // Relocate config.status/backend.mk but stamp mozinfo with the
        // PRIMARY paths again — the shape a wrong mozconfig produces.
        await writeFile(
          join(treeEngineDir, 'obj-e2e', 'config.status'),
          `topsrcdir = "${treeEngineDir}"\n`
        );
        await writeFile(
          join(treeEngineDir, 'obj-e2e', 'backend.mk'),
          `topsrcdir := ${treeEngineDir}\n`
        );
        await writeFile(
          join(treeEngineDir, 'obj-e2e', 'mozinfo.json'),
          `${JSON.stringify({
            topsrcdir: engineDir,
            topobjdir: join(engineDir, 'obj-e2e'),
            mozconfig: join(engineDir, 'mozconfig'),
          })}\n`
        );
      }
      return 0;
    });

    await expect(
      treeCreateCommand(projectRoot, 'shard-regressed', { forceCopy: true, withObjdir: true })
    ).rejects.toThrow(/obj-e2e\/mozinfo\.json topsrcdir resolves to/);
    await expect(
      pathExists(join(projectRoot, '.fireforge', 'trees', 'shard-regressed'))
    ).resolves.toBe(false);
  });

  it('the guard refuses a mutating command run with cwd inside a tree, through the real program', async () => {
    await treeCreateCommand(projectRoot, 'guarded', { forceCopy: true });
    const treeRoot = join(projectRoot, '.fireforge', 'trees', 'guarded');

    const { createProgram } = await import('../../cli.js');
    const previousCwd = process.cwd();
    process.chdir(treeRoot);
    try {
      const program = createProgram();
      program.exitOverride();
      await expect(program.parseAsync(['node', 'fireforge', 're-export'])).rejects.toThrow(
        /verification tree \("guarded"/
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('the guard admits re-export --dry-run inside a tree and the tree state stays byte-identical (FORGE H1/H3)', async () => {
    const { readFile } = await import('node:fs/promises');
    await writeFiles(projectRoot, {
      'patches/patches.json': `${JSON.stringify({
        version: 1,
        patches: [
          {
            filename: '001-ui-app.patch',
            order: 1,
            category: 'ui',
            name: 'app',
            description: '',
            createdAt: '2026-01-01T00:00:00.000Z',
            sourceEsrVersion: '140.9.0esr',
            filesAffected: ['browser/base/content/app.js'],
          },
        ],
      })}\n`,
      'patches/001-ui-app.patch':
        'diff --git a/browser/base/content/app.js b/browser/base/content/app.js\n',
    });
    await writeFiles(join(projectRoot, 'engine'), {
      'browser/base/content/app.js': 'content\nplus drift\n',
    });
    await treeCreateCommand(projectRoot, 'dryrun-ok', { forceCopy: true });
    const treeRoot = join(projectRoot, '.fireforge', 'trees', 'dryrun-ok');
    const patchPath = join(treeRoot, 'patches', '001-ui-app.patch');
    const patchBefore = await readFile(patchPath, 'utf8');

    const { createProgram } = await import('../../cli.js');
    const previousCwd = process.cwd();
    process.chdir(treeRoot);
    try {
      const program = createProgram();
      program.exitOverride();
      await program.parseAsync(['node', 'fireforge', 're-export', '001', '--dry-run']);
    } finally {
      process.chdir(previousCwd);
    }

    // The dry-run passed the guard AND its own purity guard; assert the
    // artifact byte-identity independently too.
    await expect(readFile(patchPath, 'utf8')).resolves.toBe(patchBefore);
  });
});
