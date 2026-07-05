// SPDX-License-Identifier: EUPL-1.2
/**
 * Real-filesystem regression tests for the symlink-escape guard in patch
 * target validation. The pre-0.35.0 guard normalized the path text with
 * `resolve()` but never followed the link, so it could not reject anything:
 * these tests pin that a patch targeting a symlink (direct, dangling, or via
 * a symlinked parent directory) that physically resolves outside engine/ is
 * rejected before `git apply` runs, while inside-tree symlinks still pass.
 */
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import { validatePatches } from '../patch-apply.js';

function patchModifying(file: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    '-old',
    '+new',
    '',
  ].join('\n');
}

describe.skipIf(process.platform === 'win32')('patch symlink-escape validation (real fs)', () => {
  let tempRoot: string;
  let patchesDir: string;
  let engineDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    tempRoot = await createTempProject('ff-patch-symlink-');
    patchesDir = join(tempRoot, 'patches');
    engineDir = join(tempRoot, 'engine');
    outsideDir = join(tempRoot, 'outside');
    await mkdir(patchesDir, { recursive: true });
    await mkdir(join(engineDir, 'browser'), { recursive: true });
    await mkdir(outsideDir, { recursive: true });
  });

  afterEach(async () => {
    await removeTempProject(tempRoot);
  });

  it('rejects a target symlink that resolves outside engine/', async () => {
    await writeFile(join(outsideDir, 'victim.txt'), 'old\n');
    await symlink(join(outsideDir, 'victim.txt'), join(engineDir, 'browser', 'evil.txt'));
    await writeFile(join(patchesDir, '001-evil.patch'), patchModifying('browser/evil.txt'));

    const result = await validatePatches(patchesDir, engineDir);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      '001-evil.patch: Patch targets a path that resolves outside engine/ (symlink escape): browser/evil.txt',
    ]);
  });

  it('rejects a dangling symlink that points outside engine/', async () => {
    // The destination does not exist, so realpath() cannot resolve the link —
    // but a write through it would still be created outside the tree.
    await symlink(join(outsideDir, 'not-yet.txt'), join(engineDir, 'browser', 'dangling.txt'));
    await writeFile(join(patchesDir, '001-dangling.patch'), patchModifying('browser/dangling.txt'));

    const result = await validatePatches(patchesDir, engineDir);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      '001-dangling.patch: Patch targets a path that resolves outside engine/ (symlink escape): browser/dangling.txt',
    ]);
  });

  it('rejects a target under a symlinked directory that resolves outside engine/', async () => {
    await writeFile(join(outsideDir, 'victim.txt'), 'old\n');
    await symlink(outsideDir, join(engineDir, 'sneaky'));
    await writeFile(join(patchesDir, '001-dir.patch'), patchModifying('sneaky/victim.txt'));

    const result = await validatePatches(patchesDir, engineDir);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      '001-dir.patch: Patch targets a path that resolves outside engine/ (symlink escape): sneaky/victim.txt',
    ]);
  });

  it('does not flag a symlink that stays inside engine/ as an escape', async () => {
    await writeFile(join(engineDir, 'browser', 'real.txt'), 'old\n');
    await symlink('real.txt', join(engineDir, 'browser', 'alias.txt'));
    await writeFile(join(patchesDir, '001-alias.patch'), patchModifying('browser/alias.txt'));

    // `git apply --check` itself refuses to patch through a symlink, so the
    // overall validation still fails — the pinned behavior is that OUR guard
    // is not the rejector for an inside-tree link.
    const result = await validatePatches(patchesDir, engineDir);
    expect(result.errors.join('\n')).not.toContain('symlink escape');
  });

  it('accepts a plain new file in a not-yet-existing directory', async () => {
    await writeFile(
      join(patchesDir, '001-new.patch'),
      [
        'diff --git a/browser/deep/new.txt b/browser/deep/new.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/browser/deep/new.txt',
        '@@ -0,0 +1 @@',
        '+created',
        '',
      ].join('\n')
    );

    await expect(validatePatches(patchesDir, engineDir)).resolves.toEqual({
      valid: true,
      errors: [],
    });
  });
});
