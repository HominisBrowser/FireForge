// SPDX-License-Identifier: EUPL-1.2
/**
 * Patch-owned overwrite detection for `furnace apply` (FORGE J6): a
 * deployed engine file whose bytes differ from the component source AND
 * whose path is patch-owned produces a loud warning naming file + owner;
 * unclaimed drift and clean deployments stay silent.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, writeFiles } from '../../test-utils/index.js';
import type { CustomComponentConfig, OverrideComponentConfig } from '../../types/furnace.js';
import {
  findPatchOwnedOverwrites,
  formatPatchOwnedOverwriteWarning,
} from '../furnace-apply-overwrite-warn.js';

const FTL_DIR = 'toolkit/locales/en-US/toolkit/global';

describe('findPatchOwnedOverwrites', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-overwrite-warn-');
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  describe('custom components', () => {
    const config: CustomComponentConfig = {
      targetPath: 'browser/components/custom/widget',
      register: false,
    } as CustomComponentConfig;

    async function seed(engineContent: string, sourceContent: string): Promise<void> {
      await writeFiles(projectRoot, {
        'components/custom/my-widget/my-widget.mjs': sourceContent,
        'engine/browser/components/custom/widget/my-widget.mjs': engineContent,
      });
    }

    it('warns when the deployed copy differs and the path is patch-owned', async () => {
      await seed('engine-only fix\n', 'component source\n');
      const warnings = await findPatchOwnedOverwrites({
        type: 'custom',
        root: projectRoot,
        name: 'my-widget',
        config,
        ftlDir: FTL_DIR,
        patchClaims: new Map([
          ['browser/components/custom/widget/my-widget.mjs', ['120-ui-widget.patch']],
        ]),
      });
      expect(warnings).toEqual([
        {
          component: 'my-widget',
          file: 'browser/components/custom/widget/my-widget.mjs',
          owners: ['120-ui-widget.patch'],
        },
      ]);
      const line = formatPatchOwnedOverwriteWarning(warnings[0] as never);
      expect(line).toContain('overwriting deployed browser/components/custom/widget/my-widget.mjs');
      expect(line).toContain('120-ui-widget.patch');
    });

    it('stays silent when the drifted file is not patch-owned', async () => {
      await seed('engine-only fix\n', 'component source\n');
      const warnings = await findPatchOwnedOverwrites({
        type: 'custom',
        root: projectRoot,
        name: 'my-widget',
        config,
        ftlDir: FTL_DIR,
        patchClaims: new Map([['some/other/file.js', ['001-ui-other.patch']]]),
      });
      expect(warnings).toEqual([]);
    });

    it('stays silent when deployed bytes match the source', async () => {
      await seed('same content\n', 'same content\n');
      const warnings = await findPatchOwnedOverwrites({
        type: 'custom',
        root: projectRoot,
        name: 'my-widget',
        config,
        ftlDir: FTL_DIR,
        patchClaims: new Map([
          ['browser/components/custom/widget/my-widget.mjs', ['120-ui-widget.patch']],
        ]),
      });
      expect(warnings).toEqual([]);
    });
  });

  describe('override components', () => {
    const config: OverrideComponentConfig = {
      basePath: 'browser/themes/shared',
      type: 'css',
    } as unknown as OverrideComponentConfig;

    it('warns when a claimed engine target differs from the override source', async () => {
      await writeFiles(projectRoot, {
        'components/overrides/tabs/tabs.css': 'source css\n',
        'engine/browser/themes/shared/tabs.css': 'engine-only css fix\n',
      });
      const warnings = await findPatchOwnedOverwrites({
        type: 'override',
        engineDir: join(projectRoot, 'engine'),
        name: 'tabs',
        componentDir: join(projectRoot, 'components/overrides/tabs'),
        config,
        ftlDir: FTL_DIR,
        patchClaims: new Map([['browser/themes/shared/tabs.css', ['210-ui-tabs.patch']]]),
      });
      expect(warnings).toEqual([
        {
          component: 'tabs',
          file: 'browser/themes/shared/tabs.css',
          owners: ['210-ui-tabs.patch'],
        },
      ]);
    });

    it('treats a missing engine target as a fresh deploy, not a lost edit', async () => {
      await writeFiles(projectRoot, {
        'components/overrides/tabs/tabs.css': 'source css\n',
      });
      const warnings = await findPatchOwnedOverwrites({
        type: 'override',
        engineDir: join(projectRoot, 'engine'),
        name: 'tabs',
        componentDir: join(projectRoot, 'components/overrides/tabs'),
        config,
        ftlDir: FTL_DIR,
        patchClaims: new Map([['browser/themes/shared/tabs.css', ['210-ui-tabs.patch']]]),
      });
      expect(warnings).toEqual([]);
    });
  });

  it('returns empty with no patch claims without probing anything', async () => {
    const warnings = await findPatchOwnedOverwrites({
      type: 'override',
      engineDir: join(projectRoot, 'engine'),
      name: 'tabs',
      componentDir: join(projectRoot, 'does-not-exist'),
      config: { basePath: 'x', type: 'css' } as unknown as OverrideComponentConfig,
      ftlDir: FTL_DIR,
      patchClaims: new Map(),
    });
    expect(warnings).toEqual([]);
  });

  it('degrades to empty when the probe itself fails', async () => {
    const warnings = await findPatchOwnedOverwrites({
      type: 'override',
      engineDir: join(projectRoot, 'engine'),
      name: 'tabs',
      componentDir: join(projectRoot, 'does-not-exist'),
      config: { basePath: 'x', type: 'css' } as unknown as OverrideComponentConfig,
      ftlDir: FTL_DIR,
      patchClaims: new Map([['x/a.css', ['001-ui-a.patch']]]),
    });
    expect(warnings).toEqual([]);
  });
});
