// SPDX-License-Identifier: EUPL-1.2
/**
 * Integration tests for `patch retire` and the retired-slot placeholder it
 * leaves in patches.json: the gap check accepts it, every manifest write
 * keeps it, and a patch that later takes the order fills it.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_HISTORY_LOG_PATH } from '../../core/history-log-file.js';
import { withPatchDirectoryLock } from '../../core/patch-lock.js';
import {
  addPatchToManifest,
  loadPatchesManifest,
  renumberPatchesInManifest,
} from '../../core/patch-manifest.js';
import { rebuildPatchesManifest } from '../../core/patch-manifest-consistency.js';
import { evaluatePatchPolicy } from '../../core/patch-policy.js';
import { InvalidArgumentError } from '../../errors/base.js';
import {
  createTempProject,
  DEFAULT_CONFIG,
  removeTempProject,
  setInteractiveMode,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { CommandContext } from '../../types/cli.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import type { FireForgeConfig, PatchPolicyConfig } from '../../types/config.js';
import { ensureDir, pathExists } from '../../utils/fs.js';
import { registerPatch } from '../patch/index.js';
import { patchRetireCommand } from '../patch/retire.js';

const POLICY = {
  ranges: [{ from: 200, to: 299, category: 'ui' }],
  allowGaps: false,
} satisfies PatchPolicyConfig;
const POLICY_CONFIG: FireForgeConfig = { ...DEFAULT_CONFIG, patchPolicy: POLICY };

function meta(order: number, files: string[]): PatchMetadata {
  return {
    filename: `${order}-ui-p${order}.patch`,
    order,
    category: 'ui',
    name: `p${order}`,
    description: 'test',
    createdAt: '2025-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected: files,
  };
}

function newFileDiff(path: string, content: string): string {
  const lines = content.split('\n');
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

async function seed(
  patchesDir: string,
  patches: Array<{ metadata: PatchMetadata; body: string }>,
  extra: Partial<PatchesManifest> = {}
): Promise<void> {
  await ensureDir(patchesDir);
  for (const patch of patches) {
    await writeFile(join(patchesDir, patch.metadata.filename), patch.body);
  }
  const manifest: PatchesManifest = {
    version: 1,
    patches: patches.map((patch) => patch.metadata),
    ...extra,
  };
  await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
}

function plain(order: number): { metadata: PatchMetadata; body: string } {
  const file = `ui/P${order}.sys.mjs`;
  return { metadata: meta(order, [file]), body: newFileDiff(file, `export const P = ${order};`) };
}

async function readManifest(patchesDir: string): Promise<PatchesManifest> {
  return JSON.parse(await readFile(join(patchesDir, 'patches.json'), 'utf8')) as PatchesManifest;
}

describe('patch retire', () => {
  let projectRoot: string;
  let patchesDir: string;
  let restoreTTY: () => void = () => undefined;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-retire-');
    await writeFireForgeConfig(projectRoot, { patchPolicy: POLICY });
    patchesDir = join(projectRoot, 'patches');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    restoreTTY = setInteractiveMode(false);
  });
  afterEach(async () => {
    restoreTTY();
    vi.restoreAllMocks();
    await removeTempProject(projectRoot);
  });

  it('removes the patch, keeps its order as a retired slot, and leaves no numeric gap', async () => {
    await seed(patchesDir, [plain(201), plain(202), plain(203)]);

    await patchRetireCommand(projectRoot, '202', { yes: true, reason: 'renamed away' });

    expect(await pathExists(join(patchesDir, '202-ui-p202.patch'))).toBe(false);
    const manifest = await readManifest(patchesDir);
    expect(manifest.patches.map((patch) => patch.order)).toEqual([201, 203]);
    expect(manifest.retired).toEqual([
      expect.objectContaining({
        order: 202,
        category: 'ui',
        filename: '202-ui-p202.patch',
        reason: 'renamed away',
      }),
    ]);
    expect(evaluatePatchPolicy(POLICY_CONFIG, manifest)).toEqual([]);
    // Without the slot the same queue has the gap retire exists to avoid.
    expect(
      evaluatePatchPolicy(POLICY_CONFIG, { version: 1, patches: manifest.patches }).map(
        (issue) => issue.code
      )
    ).toEqual(['numeric-gap']);

    const history = JSON.parse(
      (await readFile(join(patchesDir, '..', DEFAULT_HISTORY_LOG_PATH), 'utf8')).trim()
    ) as { operation: string; args: { order: number; reason?: string } };
    expect(history.operation).toBe('patch-retire');
    expect(history.args).toMatchObject({ order: 202, reason: 'renamed away' });
  });

  it('--dry-run changes nothing', async () => {
    await seed(patchesDir, [plain(201), plain(202)]);
    const before = await readFile(join(patchesDir, 'patches.json'), 'utf8');
    await patchRetireCommand(projectRoot, '202', { dryRun: true });
    expect(await readFile(join(patchesDir, 'patches.json'), 'utf8')).toBe(before);
    expect(await pathExists(join(patchesDir, '202-ui-p202.patch'))).toBe(true);
  });

  it('refuses like delete when a later patch imports a file the target creates', async () => {
    await seed(patchesDir, [
      plain(201),
      {
        metadata: meta(202, ['ui/C.sys.mjs']),
        body: newFileDiff('ui/C.sys.mjs', 'import { P } from "resource:///modules/P201.sys.mjs";'),
      },
    ]);
    await expect(patchRetireCommand(projectRoot, '201', { yes: true })).rejects.toBeInstanceOf(
      InvalidArgumentError
    );
    expect(await pathExists(join(patchesDir, '201-ui-p201.patch'))).toBe(true);
    expect((await readManifest(patchesDir)).retired).toBeUndefined();
  });

  it('wires `patch retire` and `patch delete` through the CLI', async () => {
    await seed(patchesDir, [plain(201), plain(202), plain(203)]);
    const context: CommandContext = {
      getProjectRoot: () => projectRoot,
      withErrorHandling:
        <T extends unknown[]>(handler: (...args: T) => Promise<void>) =>
        (...args: T) =>
          handler(...args),
    };
    const program = new Command();
    registerPatch(program, context);

    await program.parseAsync([
      'node',
      'fireforge',
      'patch',
      'retire',
      '202',
      '--yes',
      '--reason',
      'r',
    ]);
    await program.parseAsync(['node', 'fireforge', 'patch', 'delete', '203', '--yes']);

    const manifest = await readManifest(patchesDir);
    expect(manifest.patches.map((patch) => patch.order)).toEqual([201]);
    expect(manifest.retired?.map((slot) => slot.reason)).toEqual(['r']);
  });

  it('notes that no check reads the slot when gaps are allowed', async () => {
    await writeFireForgeConfig(projectRoot);
    await seed(patchesDir, [plain(201), plain(202)]);
    await patchRetireCommand(projectRoot, '201', { yes: true });
    expect((await readManifest(patchesDir)).retired?.map((slot) => slot.order)).toEqual([201]);
  });
});

describe('retired slots across manifest writes', () => {
  let projectRoot: string;
  let patchesDir: string;
  const slot = {
    order: 202,
    category: 'ui',
    filename: '202-ui-old.patch',
    retiredAt: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-retired-');
    patchesDir = join(projectRoot, 'patches');
  });
  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('is preserved by load and by an unrelated append', async () => {
    await seed(patchesDir, [plain(201), plain(203)], { retired: [slot] });
    expect((await loadPatchesManifest(patchesDir))?.retired).toEqual([slot]);
    await addPatchToManifest(patchesDir, meta(204, ['ui/P204.sys.mjs']));
    expect((await readManifest(patchesDir)).retired).toEqual([slot]);
  });

  it('is filled (dropped) when a patch takes its order', async () => {
    await seed(patchesDir, [plain(201), plain(203)], { retired: [slot] });
    await addPatchToManifest(patchesDir, meta(202, ['ui/P202.sys.mjs']));
    const manifest = await readManifest(patchesDir);
    expect(manifest.retired).toBeUndefined();
    expect(manifest.patches.map((patch) => patch.order)).toEqual([201, 202, 203]);
  });

  it('is filled when a renumber moves a patch onto its order', async () => {
    await seed(patchesDir, [plain(201), plain(203)], {
      retired: [slot, { ...slot, order: 205, filename: '205-ui-old.patch' }],
    });
    await withPatchDirectoryLock(patchesDir, async () => {
      await renumberPatchesInManifest(
        patchesDir,
        new Map([['203-ui-p203.patch', { newFilename: '202-ui-p203.patch', newOrder: 202 }]])
      );
    });
    expect((await readManifest(patchesDir)).retired?.map((entry) => entry.order)).toEqual([205]);
  });

  it('survives a manifest rebuild from the patch files', async () => {
    await seed(patchesDir, [plain(201), plain(203)], { retired: [slot] });
    await rebuildPatchesManifest(patchesDir, '140.9.0esr');
    expect((await readManifest(patchesDir)).retired).toEqual([slot]);
  });

  it('rejects a malformed retired list as manifest corruption', async () => {
    await seed(patchesDir, [plain(201)], {
      retired: [{ order: -1 }] as unknown as NonNullable<PatchesManifest['retired']>,
    });
    expect(await loadPatchesManifest(patchesDir)).toBeNull();
    await writeFile(
      join(patchesDir, 'patches.json'),
      JSON.stringify({ version: 1, patches: [], retired: {} })
    );
    expect(await loadPatchesManifest(patchesDir)).toBeNull();
  });
});
