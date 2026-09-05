// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit tests for the post-`mach configure` relocation check: every violation
 * class the pure checker reports, and the clean shapes it must accept,
 * including the substring non-collision property that makes the primary-path
 * search safe against the tree's own nested path.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeFiles } from '../../test-utils/index.js';
import { findObjdirRelocationViolation } from '../mach-build-artifacts.js';

describe('findObjdirRelocationViolation', () => {
  let primaryEngine: string;
  let treeEngine: string;

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'ff-objdir-relocation-'));
    primaryEngine = join(root, 'engine');
    treeEngine = join(root, '.fireforge', 'trees', 'shard-a', 'engine');
  });

  afterEach(async () => {
    await rm(join(primaryEngine, '..'), { recursive: true, force: true });
  });

  async function writeRelocatedObjdir(
    overrides: Partial<Record<'config.status' | 'backend.mk' | 'mozinfo.json', string>> = {}
  ): Promise<void> {
    await writeFiles(join(treeEngine, 'obj-e2e'), {
      'config.status': overrides['config.status'] ?? `topsrcdir = "${treeEngine}"\n`,
      'backend.mk': overrides['backend.mk'] ?? `topsrcdir := ${treeEngine}\n`,
      'mozinfo.json':
        overrides['mozinfo.json'] ??
        `${JSON.stringify({
          topsrcdir: treeEngine,
          topobjdir: join(treeEngine, 'obj-e2e'),
        })}\n`,
    });
  }

  function check(): Promise<string | undefined> {
    return findObjdirRelocationViolation({
      engineDir: treeEngine,
      objDir: 'obj-e2e',
      forbiddenDir: primaryEngine,
    });
  }

  it('accepts a fully relocated objdir', async () => {
    await writeRelocatedObjdir();
    await expect(check()).resolves.toBeUndefined();
  });

  it('accepts a relocated objdir with no backend.mk (not every configure writes one)', async () => {
    await writeRelocatedObjdir();
    await rm(join(treeEngine, 'obj-e2e', 'backend.mk'));
    await expect(check()).resolves.toBeUndefined();
  });

  it('the tree path containing the primary root does not false-positive the substring search', async () => {
    // `<root>/.fireforge/trees/shard-a/engine` does not contain the
    // substring `<root>/engine`, which is the property the checker relies
    // on.
    await writeRelocatedObjdir();
    expect(treeEngine.startsWith(join(primaryEngine, '..'))).toBe(true);
    await expect(check()).resolves.toBeUndefined();
  });

  it('reports a missing config.status as a mistargeted configure', async () => {
    await writeRelocatedObjdir();
    await rm(join(treeEngine, 'obj-e2e', 'config.status'));
    await expect(check()).resolves.toMatch(
      /obj-e2e\/config\.status was not written — mach configure may have targeted a different objdir/
    );
  });

  it('reports unreadable or invalid mozinfo.json (fail closed)', async () => {
    await writeRelocatedObjdir({ 'mozinfo.json': 'not json\n' });
    await expect(check()).resolves.toMatch(/obj-e2e\/mozinfo\.json could not be read/);
  });

  it('reports a mozinfo topsrcdir that still resolves to the primary', async () => {
    await writeRelocatedObjdir({
      'mozinfo.json': `${JSON.stringify({
        topsrcdir: primaryEngine,
        topobjdir: join(treeEngine, 'obj-e2e'),
      })}\n`,
    });
    await expect(check()).resolves.toMatch(/obj-e2e\/mozinfo\.json topsrcdir resolves to/);
  });

  it('reports a mozinfo topobjdir pointing at the primary objdir', async () => {
    await writeRelocatedObjdir({
      'mozinfo.json': `${JSON.stringify({
        topsrcdir: treeEngine,
        topobjdir: join(primaryEngine, 'obj-e2e'),
      })}\n`,
    });
    await expect(check()).resolves.toMatch(/obj-e2e\/mozinfo\.json topobjdir resolves to/);
  });

  it('reports an absent mozinfo topsrcdir instead of treating it as relocated', async () => {
    await writeRelocatedObjdir({ 'mozinfo.json': '{}\n' });
    await expect(check()).resolves.toMatch(/topsrcdir resolves to \(absent\)/);
  });

  it('reports the primary engine path surviving in config.status', async () => {
    await writeRelocatedObjdir({
      'config.status': `topsrcdir = "${primaryEngine}"\n`,
    });
    await expect(check()).resolves.toMatch(
      /obj-e2e\/config\.status still contains the primary engine path/
    );
  });

  it('reports the primary engine path surviving in backend.mk alone', async () => {
    await writeRelocatedObjdir({
      'backend.mk': `topsrcdir := ${primaryEngine}\n`,
    });
    await expect(check()).resolves.toMatch(
      /obj-e2e\/backend\.mk still contains the primary engine path/
    );
  });

  it('reports the primary engine path surviving in the top-level Makefile', async () => {
    await writeRelocatedObjdir();
    await writeFiles(join(treeEngine, 'obj-e2e'), {
      Makefile: `topsrcdir = ${primaryEngine}\n`,
    });
    await expect(check()).resolves.toMatch(
      /obj-e2e\/Makefile still contains the primary engine path/
    );
  });

  it('reports the primary engine path surviving in config/autoconf.mk', async () => {
    await writeRelocatedObjdir();
    await writeFiles(join(treeEngine, 'obj-e2e'), {
      'config/autoconf.mk': `top_srcdir = ${primaryEngine}\n`,
    });
    await expect(check()).resolves.toMatch(
      /obj-e2e\/config\/autoconf\.mk still contains the primary engine path/
    );
  });

  it('accepts a relocated objdir with no Makefile or config/autoconf.mk (not every configure writes them)', async () => {
    // The default fixture writes neither. Their absence must stay clean.
    await writeRelocatedObjdir();
    await expect(check()).resolves.toBeUndefined();
  });
});
