// SPDX-License-Identifier: EUPL-1.2
/**
 * Manifest-sync repair against a REAL filesystem and a real furnace lock.
 *
 * The unit suite in `doctor.test.ts` mocks `node:fs/promises` wholesale,
 * which is why it cannot catch an empty-custom-orphan cleanup using `rm(dir)`
 * without `{ recursive: true }` — that throws EISDIR on a directory, so the
 * "Deleted N empty custom orphan directories" branch is unreachable in
 * production while the mocked test reports it working. Nor can it catch the
 * decide-before-lock window, since nothing concurrent runs there.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FurnaceConfig, OverrideComponentConfig } from '../../types/furnace.js';
import type { DoctorCheckContext } from '../doctor-check-core.js';
import { furnaceConfigSyncCheck } from '../doctor-furnace-config-sync.js';

const SIDECAR: OverrideComponentConfig = {
  type: 'css-only',
  description: 'recovered from sidecar',
  basePath: 'browser/base/content/widget.css',
  baseVersion: '145.0',
};

function emptyConfig(): FurnaceConfig {
  return { version: 1, componentPrefix: 'moz-', stock: [], overrides: {}, custom: {} };
}

describe('furnace manifest sync repair (real filesystem)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ff-manifest-sync-'));
    await mkdir(join(root, 'components', 'overrides'), { recursive: true });
    await mkdir(join(root, 'components', 'custom'), { recursive: true });
    await mkdir(join(root, '.fireforge'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeFurnaceJson(config: FurnaceConfig): Promise<void> {
    await writeFile(join(root, 'furnace.json'), JSON.stringify(config, null, 2), 'utf-8');
  }

  async function readFurnaceJson(): Promise<FurnaceConfig> {
    return JSON.parse(await readFile(join(root, 'furnace.json'), 'utf-8')) as FurnaceConfig;
  }

  function context(config: FurnaceConfig): DoctorCheckContext {
    return {
      projectRoot: root,
      furnaceConfig: config,
      furnaceConfigExists: true,
      options: { repairFurnace: true },
    } as unknown as DoctorCheckContext;
  }

  it('actually deletes an empty custom orphan directory', async () => {
    await writeFurnaceJson(emptyConfig());
    await mkdir(join(root, 'components', 'custom', 'moz-empty'), { recursive: true });

    const result = await furnaceConfigSyncCheck.run(context(emptyConfig()));
    const messages = (Array.isArray(result) ? result : [result]).map((r) => r.message).join(' ');

    expect(messages).toContain('Deleted 1 empty custom orphan directory (moz-empty)');
    await expect(readFile(join(root, 'components', 'custom', 'moz-empty'))).rejects.toThrow();
  });

  it('keeps a non-empty custom orphan directory', async () => {
    await writeFurnaceJson(emptyConfig());
    const dir = join(root, 'components', 'custom', 'moz-lived-in');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'widget.css'), 'body {}', 'utf-8');

    const result = await furnaceConfigSyncCheck.run(context(emptyConfig()));
    const messages = (Array.isArray(result) ? result : [result]).map((r) => r.message).join(' ');

    expect(messages).toContain('requires manual action (moz-lived-in)');
    await expect(readFile(join(dir, 'widget.css'), 'utf-8')).resolves.toBe('body {}');
  });

  it('does not overwrite an entry a concurrent writer registered after collection', async () => {
    // The orphan list is computed from the doctor context's config snapshot,
    // taken long before the furnace lock is held. Simulate a concurrent
    // `furnace override` by registering the same name on disk in between: the
    // repair must observe that under the lock and leave the live entry alone.
    const staleSnapshot = emptyConfig();
    const overrideDir = join(root, 'components', 'overrides', 'moz-widget');
    await mkdir(overrideDir, { recursive: true });
    await writeFile(join(overrideDir, 'override.json'), JSON.stringify(SIDECAR), 'utf-8');

    const live = emptyConfig();
    live.overrides['moz-widget'] = { ...SIDECAR, description: 'written by the concurrent command' };
    await writeFurnaceJson(live);

    const result = await furnaceConfigSyncCheck.run(context(staleSnapshot));
    const messages = (Array.isArray(result) ? result : [result]).map((r) => r.message).join(' ');

    expect(messages).toContain('Skipped 1 name (moz-widget)');
    await expect(readFurnaceJson()).resolves.toMatchObject({
      overrides: { 'moz-widget': { description: 'written by the concurrent command' } },
    });
  });

  it('never leaves a name in both custom and overrides', async () => {
    // A concurrent `furnace create` registering the orphan name under
    // `custom` must not be overwritten into `overrides` as well, producing a
    // name in BOTH maps — a state nothing in furnace-config.ts rejects.
    const staleSnapshot = emptyConfig();
    const overrideDir = join(root, 'components', 'overrides', 'moz-widget');
    await mkdir(overrideDir, { recursive: true });
    await writeFile(join(overrideDir, 'override.json'), JSON.stringify(SIDECAR), 'utf-8');

    const live = emptyConfig();
    live.custom['moz-widget'] = {
      description: 'created concurrently',
      targetPath: 'browser/components/moz-widget',
      register: true,
      localized: false,
    };
    await writeFurnaceJson(live);

    await furnaceConfigSyncCheck.run(context(staleSnapshot));

    const written = await readFurnaceJson();
    expect(Object.keys(written.overrides)).not.toContain('moz-widget');
    expect(Object.keys(written.custom)).toContain('moz-widget');
  });

  it('reconciles a name orphaned in both trees once, not once per tree', async () => {
    // Both the override half and the custom-cleanup half re-check orphans
    // against the fresh config; a name present in both orphan lists must not
    // be pushed into `reconciled` twice, reporting "Skipped 2 names (x, x)".
    const staleSnapshot = emptyConfig();
    const overrideDir = join(root, 'components', 'overrides', 'moz-widget');
    await mkdir(overrideDir, { recursive: true });
    await writeFile(join(overrideDir, 'override.json'), JSON.stringify(SIDECAR), 'utf-8');
    await mkdir(join(root, 'components', 'custom', 'moz-widget'), { recursive: true });

    const live = emptyConfig();
    live.overrides['moz-widget'] = { ...SIDECAR, description: 'written by the concurrent command' };
    await writeFurnaceJson(live);

    const result = await furnaceConfigSyncCheck.run(context(staleSnapshot));
    const messages = (Array.isArray(result) ? result : [result]).map((r) => r.message).join(' ');

    expect(messages).toContain('Skipped 1 name (moz-widget)');
    expect(messages).not.toContain('moz-widget, moz-widget');
  });

  it('restores a genuine orphan from its sidecar', async () => {
    await writeFurnaceJson(emptyConfig());
    const overrideDir = join(root, 'components', 'overrides', 'moz-widget');
    await mkdir(overrideDir, { recursive: true });
    await writeFile(join(overrideDir, 'override.json'), JSON.stringify(SIDECAR), 'utf-8');

    const result = await furnaceConfigSyncCheck.run(context(emptyConfig()));
    const messages = (Array.isArray(result) ? result : [result]).map((r) => r.message).join(' ');

    expect(messages).toContain('Re-registered 1 override (moz-widget)');
    await expect(readFurnaceJson()).resolves.toMatchObject({
      overrides: { 'moz-widget': { description: 'recovered from sidecar' } },
    });
  });
});
