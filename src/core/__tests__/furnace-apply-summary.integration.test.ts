// SPDX-License-Identifier: EUPL-1.2
/**
 * FORGE H6 investigation: a 0.39.0 field report claimed `furnace apply`
 * printed "No changes since last apply" for a component whose SOURCE had
 * just been edited, while the copy had actually landed (outcome correct,
 * report wrong). These tests exercise every candidate mechanism by which
 * the skip decision could disagree with the file state, against a real
 * filesystem. They double as the refutation evidence if the incident does
 * not reproduce: with content-based state checksums, "edited source +
 * skip report + identical files" implies an earlier apply (a watch cycle
 * or named apply) had already deployed exactly that edit — making the
 * report accurate.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import { applyAllComponents } from '../furnace-apply.js';

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
  note: vi.fn(),
  spinner: vi.fn(() => ({ message: vi.fn(), stop: vi.fn(), error: vi.fn() })),
}));

describe('furnace apply skip-report accuracy (FORGE H6)', () => {
  let projectRoot: string;
  let overrideDir: string;
  let engineCssPath: string;

  function furnaceConfig(overrideType: 'full' | 'css-only'): string {
    return `${JSON.stringify({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        panel: {
          type: overrideType,
          description: 'Panel override',
          basePath: 'browser/components/panel',
          baseVersion: '152.0',
        },
      },
      custom: {},
    })}\n`;
  }

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-h6-');
    overrideDir = join(projectRoot, 'components', 'overrides', 'panel');
    engineCssPath = join(projectRoot, 'engine', 'browser', 'components', 'panel', 'panel.css');

    await mkdir(overrideDir, { recursive: true });
    await mkdir(join(projectRoot, 'engine', 'browser', 'components', 'panel'), {
      recursive: true,
    });
    await writeFile(
      join(projectRoot, 'fireforge.json'),
      `${JSON.stringify({
        name: 'Test Browser',
        vendor: 'Test',
        appId: 'org.test.browser',
        binaryName: 'testbrowser',
        firefox: { version: '152.0', product: 'firefox' },
      })}\n`
    );
    await writeFile(join(projectRoot, 'furnace.json'), furnaceConfig('full'));
    // Engine baseline the override replaces.
    await writeFile(engineCssPath, '.panel { color: black; }\n');
    await writeFile(join(overrideDir, 'panel.css'), '.panel { color: red; }\n');
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await removeTempProject(projectRoot);
  });

  it('candidate 1 (the incident shape): an edited source is applied, never reported as "No changes"', async () => {
    const first = await applyAllComponents(projectRoot);
    expect(first.errors).toEqual([]);
    expect(first.applied.map((entry) => entry.name)).toEqual(['panel']);

    // Settled state skips — the baseline for the incident sequence.
    const settled = await applyAllComponents(projectRoot);
    expect(settled.skipped).toEqual([{ name: 'panel', reason: 'No changes since last apply' }]);

    // The incident: edit the SOURCE, then apply. The report must say
    // applied, and the engine copy must carry the edit.
    await writeFile(join(overrideDir, 'panel.css'), '.panel { color: rebeccapurple; }\n');
    const afterEdit = await applyAllComponents(projectRoot);
    expect(afterEdit.errors).toEqual([]);
    expect(afterEdit.skipped).toEqual([]);
    expect(afterEdit.applied.map((entry) => entry.name)).toEqual(['panel']);
    await expect(readFile(engineCssPath, 'utf-8')).resolves.toBe(
      '.panel { color: rebeccapurple; }\n'
    );
  });

  it('candidate 2: engine-side tampering defeats the cached-hash drift fast path', async () => {
    await applyAllComponents(projectRoot);

    // Tamper the DEPLOYED copy out-of-band (reset/manual edit). The cached
    // engine hash no longer matches, so the fast path must report drift and
    // re-apply — not trust the workspace checksum match into a skip.
    await writeFile(engineCssPath, '/* clobbered out-of-band */\n');
    const afterTamper = await applyAllComponents(projectRoot);
    expect(afterTamper.skipped).toEqual([]);
    expect(afterTamper.applied.map((entry) => entry.name)).toEqual(['panel']);
    await expect(readFile(engineCssPath, 'utf-8')).resolves.toBe('.panel { color: red; }\n');
  });

  it('candidate 3: css-only override with a non-css workspace file cannot wedge into a stale skip', async () => {
    // The checksummed file set (.mjs/.css/.ftl) is a SUPERSET of the
    // css-only copy set (.css), so a non-css edit reads as "changed" and
    // re-applies (harmlessly re-copying the css) rather than the reverse —
    // there is no file the copy predicate deploys that the change detector
    // cannot see.
    await writeFile(join(projectRoot, 'furnace.json'), furnaceConfig('css-only'));
    await writeFile(join(overrideDir, 'helper.mjs'), 'export const H = 1;\n');

    const first = await applyAllComponents(projectRoot);
    expect(first.applied.map((entry) => entry.name)).toEqual(['panel']);

    await writeFile(join(overrideDir, 'helper.mjs'), 'export const H = 2;\n');
    const afterMjsEdit = await applyAllComponents(projectRoot);
    // Never a skip while any checksummed workspace file changed.
    expect(afterMjsEdit.skipped).toEqual([]);
    expect(afterMjsEdit.applied.map((entry) => entry.name)).toEqual(['panel']);

    // And the state settles again.
    const settled = await applyAllComponents(projectRoot);
    expect(settled.skipped).toEqual([{ name: 'panel', reason: 'No changes since last apply' }]);
  });

  it('candidate 4: a named apply with persistState:false leaves batch state honest', async () => {
    await applyAllComponents(projectRoot);

    // Named-apply core semantics: the mutation runs but the batch state file
    // is NOT rewritten (the CLI merges per-component state separately). The
    // next batch apply must therefore still see the pre-edit checksums and
    // re-apply — it must never read the un-persisted run as "already done".
    await writeFile(join(overrideDir, 'panel.css'), '.panel { color: teal; }\n');
    const named = await applyAllComponents(projectRoot, false, {
      componentName: 'panel',
      persistState: false,
    });
    expect(named.applied.map((entry) => entry.name)).toEqual(['panel']);
    await expect(readFile(engineCssPath, 'utf-8')).resolves.toBe('.panel { color: teal; }\n');

    // Batch apply after the unpersisted named run: state still records the
    // pre-edit checksums, so this re-applies (idempotent copy) rather than
    // skipping on state it never persisted. Outcome AND report agree.
    const batch = await applyAllComponents(projectRoot);
    expect(batch.applied.map((entry) => entry.name)).toEqual(['panel']);
    expect(batch.skipped).toEqual([]);

    // And once persisted, the report settles to an accurate skip.
    const settled = await applyAllComponents(projectRoot);
    expect(settled.skipped).toEqual([{ name: 'panel', reason: 'No changes since last apply' }]);
    await expect(readFile(engineCssPath, 'utf-8')).resolves.toBe('.panel { color: teal; }\n');
  });
});
