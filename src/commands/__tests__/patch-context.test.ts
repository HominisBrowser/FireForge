// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit tests for the shared patch-command preamble. The error wording is
 * load-bearing — every patch subcommand surfaces these exact messages —
 * so the throw paths are pinned here once instead of per command.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import {
  createTempProject,
  removeTempProject,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { ensureDir } from '../../utils/fs.js';
import { requirePatchQueue, requirePatchTarget } from '../patch/patch-context.js';

function makeMetadata(filename: string, order: number): PatchMetadata {
  return {
    filename,
    order,
    category: 'branding',
    name: filename.replace(/^\d+-\w+-|\.patch$/g, ''),
    description: '',
    createdAt: '2026-04-25T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected: ['browser/some/file.css'],
  };
}

describe('requirePatchQueue', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-pcx-');
    await writeFireForgeConfig(projectRoot);
    patchesDir = join(projectRoot, 'patches');
  });
  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('returns paths and the manifest when the queue is populated', async () => {
    const patches = [makeMetadata('001-branding-logo.patch', 1)];
    await ensureDir(patchesDir);
    const manifest: PatchesManifest = { version: 1, patches };
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));

    const ctx = await requirePatchQueue(projectRoot);
    expect(ctx.paths.patches).toBe(patchesDir);
    expect(ctx.manifest.patches).toHaveLength(1);
  });

  it('throws GeneralError when the patches directory is missing', async () => {
    await expect(requirePatchQueue(projectRoot)).rejects.toThrow(
      new GeneralError('Patches directory not found.')
    );
  });

  it('honours a caller-specific missing-directory message', async () => {
    await expect(
      requirePatchQueue(projectRoot, {
        missingDirMessage: 'Patches directory not found. No patches to delete.',
      })
    ).rejects.toThrow('Patches directory not found. No patches to delete.');
  });

  it('throws GeneralError when the manifest is absent or empty', async () => {
    await ensureDir(patchesDir);
    await expect(requirePatchQueue(projectRoot)).rejects.toThrow('No patches in manifest.');

    const empty: PatchesManifest = { version: 1, patches: [] };
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(empty, null, 2));
    await expect(requirePatchQueue(projectRoot)).rejects.toThrow('No patches in manifest.');
  });
});

describe('requirePatchTarget', () => {
  const patches = [
    makeMetadata('001-branding-logo.patch', 1),
    makeMetadata('002-ui-tabs.patch', 2),
  ];

  it('resolves by order number, filename, and name fragment', () => {
    expect(requirePatchTarget('2', patches).filename).toBe('002-ui-tabs.patch');
    expect(requirePatchTarget('001-branding-logo.patch', patches).filename).toBe(
      '001-branding-logo.patch'
    );
  });

  it('throws InvalidArgumentError with suggestions for an unknown identifier', () => {
    expect(() => requirePatchTarget('does-not-exist', patches)).toThrow(InvalidArgumentError);
  });
});
