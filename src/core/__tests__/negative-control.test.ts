// SPDX-License-Identifier: EUPL-1.2
import { chmod, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', async () =>
  (await import('../../commands/__tests__/test-command-mocks.js')).loggerMock()
);

import { createTempProject, removeTempProject, writeFiles } from '../../test-utils/index.js';
import { notice } from '../../utils/logger.js';
import { normalizePathSlashes } from '../../utils/paths.js';
import {
  applyNegativeControl,
  type NegativeControlPaths,
  planNegativeControl,
  recoverPendingNegativeControl,
  restoreActiveNegativeControlsForSignal,
  restoreNegativeControl,
} from '../negative-control.js';

const SOURCE = 'export function check() {\n  return true;\n}\n';
const NEUTERED = 'export function check() {\n  return false;\n}\n';

function controlDiff(path: string): string {
  return (
    `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n` +
    '@@ -1,3 +1,3 @@\n export function check() {\n-  return true;\n+  return false;\n }\n'
  );
}

let root: string;
let paths: NegativeControlPaths;
const target = 'browser/modules/Check.sys.mjs';

beforeEach(async () => {
  root = await createTempProject('fireforge-negative-control-');
  paths = { engineDir: join(root, 'engine'), fireforgeDir: join(root, '.fireforge') };
  await writeFiles(root, {
    [`engine/${target}`]: SOURCE,
    'control.diff': controlDiff(`engine/${target}`),
  });
  vi.mocked(notice).mockClear();
});

afterEach(async () => {
  await removeTempProject(root);
});

async function journalExists(): Promise<boolean> {
  try {
    await readdir(join(paths.fireforgeDir, 'negative-control'));
    return true;
  } catch {
    return false;
  }
}

describe('planNegativeControl', () => {
  it('resolves engine/ and engine-relative paths and proves the hunks apply', async () => {
    await writeFiles(root, { 'relative.diff': controlDiff(target) });
    for (const file of ['control.diff', 'relative.diff']) {
      const plan = await planNegativeControl(root, paths.engineDir, file);
      expect(plan.targets.map((t) => t.enginePath)).toEqual([target]);
    }
  });

  it('refuses a missing diff, a missing target and a hunk that does not apply', async () => {
    await expect(planNegativeControl(root, paths.engineDir, 'nope.diff')).rejects.toMatchObject({
      note: 'negative-control',
    });
    await writeFiles(root, { 'missing.diff': controlDiff('engine/browser/gone.mjs') });
    await expect(planNegativeControl(root, paths.engineDir, 'missing.diff')).rejects.toThrow(
      /does not exist/
    );
    await writeFile(join(paths.engineDir, target), NEUTERED);
    await expect(planNegativeControl(root, paths.engineDir, 'control.diff')).rejects.toThrow(
      /already present/
    );
  });

  it('refuses an unparseable diff, a non-UTF-8 target and a symlinked target', async () => {
    await writeFiles(root, { 'junk.diff': 'not a diff\n' });
    await expect(planNegativeControl(root, paths.engineDir, 'junk.diff')).rejects.toThrow(
      /no diff sections found/
    );
    await writeFile(join(paths.engineDir, target), Buffer.from([0xff, 0xfe, 0x00]));
    await expect(planNegativeControl(root, paths.engineDir, 'control.diff')).rejects.toThrow(
      /not valid UTF-8/
    );
  });

  it('accepts a git diff --no-index against an edited copy outside engine/', async () => {
    // `git diff --no-index engine/<file> <scratch copy>` names the copy on
    // its new side; absolute paths lose their leading slash under a/ and b/
    // (`a/Users/…`), while a Windows drive path keeps its drive (`a/C:/Users/…`).
    const absolute = normalizePathSlashes(join(root, 'engine', target)).replace(/^\//, '');
    // Only the new side's own `b/` (after a space, or `+++ `) is replaced:
    // a temp root whose random suffix ends in `b` puts `…b/engine/…` inside
    // the absolute old side too.
    const newSide = (diff: string, path: string): string =>
      diff.replace(/(^\+\+\+ | )b\/engine\/browser\/modules\/Check\.sys\.mjs/gm, `$1b/${path}`);
    await writeFiles(root, {
      'relative.diff': newSide(controlDiff(`engine/${target}`), 'scratch/Check.sys.mjs'),
      'absolute.diff': newSide(
        controlDiff(`engine/${target}`).replace(
          /a\/engine\/browser\/modules\/Check\.sys\.mjs/g,
          `a/${absolute}`
        ),
        'private/tmp/Check.sys.mjs'
      ),
      'rename.diff': newSide(
        controlDiff(`engine/${target}`),
        'engine/browser/modules/Other.sys.mjs'
      ),
    });
    for (const file of ['relative.diff', 'absolute.diff']) {
      const plan = await planNegativeControl(root, paths.engineDir, file);
      expect(plan.targets.map((t) => t.enginePath)).toEqual([target]);
    }
    await expect(planNegativeControl(root, paths.engineDir, 'rename.diff')).rejects.toThrow(
      /is a rename/
    );
  });

  it('marks a compiled-source target, and restores it with a fresh mtime', async () => {
    const cpp = 'gfx/layers/apz/src/AsyncPanZoomController.cpp';
    await writeFiles(root, {
      [`engine/${cpp}`]: SOURCE,
      'cpp.diff': controlDiff(`engine/${cpp}`),
    });
    const old = new Date('2020-01-01T00:00:00Z');
    await utimes(join(paths.engineDir, cpp), old, old);
    const plan = await planNegativeControl(root, paths.engineDir, 'cpp.diff');
    expect(plan.compiled).toEqual([cpp]);
    const control = await applyNegativeControl(paths, plan);
    await restoreNegativeControl(control);
    const restored = await stat(join(paths.engineDir, cpp));
    expect(await readFile(join(paths.engineDir, cpp), 'utf8')).toBe(SOURCE);
    expect(restored.mtimeMs).toBeGreaterThan(old.getTime() + 1000);
    // A script target is not compiled and keeps its original timestamps.
    expect((await planNegativeControl(root, paths.engineDir, 'control.diff')).compiled).toBe(
      undefined
    );
  });

  it('maps a custom component source onto its deployed engine copy', async () => {
    await writeFiles(root, {
      'furnace.json': JSON.stringify({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {
          'moz-card': {
            type: 'css-only',
            description: 'Card',
            basePath: 'toolkit/content/widgets/moz-card',
            baseVersion: '145.0',
          },
        },
        custom: {
          'moz-tile': {
            description: 'Tile',
            targetPath: 'browser/components/tile',
            register: false,
            localized: false,
          },
        },
      }),
      'engine/browser/components/tile/moz-tile.mjs': SOURCE,
      'engine/toolkit/content/widgets/moz-card/moz-card.mjs': SOURCE,
      'tile.diff': controlDiff('components/custom/moz-tile/moz-tile.mjs'),
      'card.diff': controlDiff('components/overrides/moz-card/moz-card.mjs'),
      'ftl.diff': controlDiff('components/overrides/moz-card/moz-card.ftl'),
      'shared.diff': controlDiff('components/shared/fragment.css'),
    });
    const tile = await planNegativeControl(root, paths.engineDir, 'tile.diff');
    expect(tile.targets[0]).toMatchObject({
      enginePath: 'browser/components/tile/moz-tile.mjs',
      fromComponents: true,
    });
    const card = await planNegativeControl(root, paths.engineDir, 'card.diff');
    expect(card.targets[0]?.enginePath).toBe('toolkit/content/widgets/moz-card/moz-card.mjs');
    for (const file of ['ftl.diff', 'shared.diff']) {
      await expect(planNegativeControl(root, paths.engineDir, file)).rejects.toThrow(
        /does not map to one deployed engine file/
      );
    }
  });

  it('defers the apply check for a components/ target when the run builds first', async () => {
    await writeFiles(root, {
      'furnace.json': JSON.stringify({
        version: 1,
        componentPrefix: 'moz-',
        stock: [],
        overrides: {},
        custom: {
          'moz-tile': {
            description: 'Tile',
            targetPath: 'browser/components/tile',
            register: false,
            localized: false,
          },
        },
      }),
      'tile.diff': controlDiff('components/custom/moz-tile/moz-tile.mjs'),
    });
    // Not deployed yet: only the build will put the engine copy there.
    await expect(planNegativeControl(root, paths.engineDir, 'tile.diff')).rejects.toThrow(
      /does not exist/
    );
    await expect(
      planNegativeControl(root, paths.engineDir, 'tile.diff', { deferApplyCheck: true })
    ).resolves.toMatchObject({ targets: [{ fromComponents: true }] });
  });

  it('refuses two sections that resolve to the same engine file', async () => {
    await writeFiles(root, {
      'twice.diff': controlDiff(`engine/${target}`) + controlDiff(target),
    });
    await expect(planNegativeControl(root, paths.engineDir, 'twice.diff')).rejects.toThrow(
      /two diff sections resolve/
    );
  });
});

describe('apply and restore', () => {
  it('mutates the file, journals the original, and restores bytes, mode and mtime', async () => {
    const file = join(paths.engineDir, target);
    await chmod(file, 0o640);
    await utimes(file, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-02T00:00:00Z'));
    const before = await stat(file);
    const plan = await planNegativeControl(root, paths.engineDir, 'control.diff');

    const control = await applyNegativeControl(paths, plan);
    expect(await readFile(file, 'utf8')).toBe(NEUTERED);
    expect(await journalExists()).toBe(true);

    const result = await restoreNegativeControl(control);
    expect(result).toEqual({ restored: [target], conflicts: [] });
    expect(await readFile(file, 'utf8')).toBe(SOURCE);
    const after = await stat(file);
    expect(after.mode & 0o7777).toBe(before.mode & 0o7777);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await journalExists()).toBe(false);
    // Idempotent: a second restore is the same promise.
    await expect(restoreNegativeControl(control)).resolves.toEqual(result);
  });

  it('keeps an edit made while the control ran, and keeps the original in the journal', async () => {
    const plan = await planNegativeControl(root, paths.engineDir, 'control.diff');
    const control = await applyNegativeControl(paths, plan);
    await writeFile(join(paths.engineDir, target), 'someone else edited this\n');

    await expect(restoreNegativeControl(control)).rejects.toThrow(
      /left 1 file\(s\) alone.*Reconcile by hand/s
    );
    expect(await readFile(join(paths.engineDir, target), 'utf8')).toBe(
      'someone else edited this\n'
    );
    expect(await readFile(join(paths.fireforgeDir, 'negative-control', '0.orig'), 'utf8')).toBe(
      SOURCE
    );
    // The next run refuses rather than overwriting it.
    await expect(recoverPendingNegativeControl(paths)).rejects.toMatchObject({
      note: 'negative-control-pending',
    });
  });

  it('refuses to restore from a backup that no longer matches its journal', async () => {
    const plan = await planNegativeControl(root, paths.engineDir, 'control.diff');
    const control = await applyNegativeControl(paths, plan);
    await writeFile(join(paths.fireforgeDir, 'negative-control', '0.orig'), 'tampered');
    await expect(restoreNegativeControl(control)).rejects.toThrow(/does not match its journal/);
    expect(await readFile(join(paths.engineDir, target), 'utf8')).toBe(NEUTERED);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a failed mutation write leaves the engine untouched and no journal behind',
    async () => {
      const plan = await planNegativeControl(root, paths.engineDir, 'control.diff');
      const dir = join(paths.engineDir, 'browser/modules');
      await chmod(dir, 0o555);
      try {
        await expect(applyNegativeControl(paths, plan)).rejects.toThrow();
      } finally {
        await chmod(dir, 0o755);
      }
      expect(await readFile(join(paths.engineDir, target), 'utf8')).toBe(SOURCE);
      expect(await journalExists()).toBe(false);
    }
  );

  it('the signal path restores every applied control and never throws', async () => {
    const plan = await planNegativeControl(root, paths.engineDir, 'control.diff');
    await applyNegativeControl(paths, plan);
    await restoreActiveNegativeControlsForSignal();
    expect(await readFile(join(paths.engineDir, target), 'utf8')).toBe(SOURCE);
    // Nothing left to restore: a second sweep is a no-op.
    await expect(restoreActiveNegativeControlsForSignal()).resolves.toBeUndefined();
  });

  it('the signal path reports a failed restore on stderr instead of throwing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const plan = await planNegativeControl(root, paths.engineDir, 'control.diff');
      await applyNegativeControl(paths, plan);
      await writeFile(join(paths.engineDir, target), 'peer edit\n');
      await expect(restoreActiveNegativeControlsForSignal()).resolves.toBeUndefined();
      expect(errors).toHaveBeenCalledWith(expect.stringMatching(/restore after signal failed/));
    } finally {
      errors.mockRestore();
    }
  });
});

describe('recoverPendingNegativeControl', () => {
  it('is a no-op without a journal', async () => {
    await expect(recoverPendingNegativeControl(paths)).resolves.toBeUndefined();
    expect(notice).not.toHaveBeenCalled();
  });

  it('restores a control a killed run left applied', async () => {
    const plan = await planNegativeControl(root, paths.engineDir, 'control.diff');
    // Applied, then the process "died": nothing restored it.
    await applyNegativeControl(paths, plan);
    await recoverPendingNegativeControl(paths);
    expect(await readFile(join(paths.engineDir, target), 'utf8')).toBe(SOURCE);
    expect(await journalExists()).toBe(false);
    expect(notice).toHaveBeenCalledWith(expect.stringMatching(/Restored 1 file\(s\)/));
    await restoreActiveNegativeControlsForSignal();
  });

  it('refuses an unreadable journal', async () => {
    await writeFiles(root, { '.fireforge/negative-control/journal.json': '{nope' });
    await expect(recoverPendingNegativeControl(paths)).rejects.toThrow(/journal .* is unreadable/);
  });
});
