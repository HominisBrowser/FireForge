// SPDX-License-Identifier: EUPL-1.2
/**
 * `engine/mozconfig` is a mach CONFIGURE INPUT, so its MTIME — not its
 * content — is what `config.status` is compared against. These tests run
 * against a real filesystem on purpose: the property under test ("an
 * unchanged render does not touch the file") is invisible to a mocked
 * writer.
 */
import { stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTempProject,
  DEFAULT_CONFIG,
  removeTempProject,
  writeFiles,
} from '../../test-utils/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { readText } from '../../utils/fs.js';
import { getPlatform } from '../../utils/platform.js';
import { generateMozconfig } from '../mach-mozconfig.js';

describe('generateMozconfig write-if-changed', () => {
  let projectRoot: string;
  let configsDir: string;
  let engineDir: string;
  let config: FireForgeConfig;

  beforeEach(async () => {
    projectRoot = await createTempProject('fireforge-mozconfig-');
    configsDir = join(projectRoot, 'configs');
    engineDir = join(projectRoot, 'engine');
    config = { ...DEFAULT_CONFIG, binaryName: 'testbrowser' };
    await writeFiles(configsDir, {
      'common.mozconfig': 'ac_add_options --enable-bootstrap\n',
      [`${getPlatform()}.mozconfig`]: `ac_add_options --with-branding=browser/branding/${config.binaryName}\n`,
    });
    await writeFiles(engineDir, {
      [`browser/branding/${config.binaryName}/moz.build`]: '# branding\n',
    });
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('leaves the mtime untouched when the rendered content is identical', async () => {
    const mozconfigPath = join(engineDir, 'mozconfig');
    await generateMozconfig(configsDir, engineDir, config);
    const first = await readText(mozconfigPath);

    // Backdate so any rewrite is unambiguously visible.
    const past = new Date(Date.now() - 60_000);
    await utimes(mozconfigPath, past, past);
    const before = (await stat(mozconfigPath)).mtimeMs;

    await generateMozconfig(configsDir, engineDir, config);

    expect((await stat(mozconfigPath)).mtimeMs).toBe(before);
    expect(await readText(mozconfigPath)).toBe(first);
  });

  it('still rewrites (and advances the mtime) when the render changes', async () => {
    const mozconfigPath = join(engineDir, 'mozconfig');
    await generateMozconfig(configsDir, engineDir, config);
    const past = new Date(Date.now() - 60_000);
    await utimes(mozconfigPath, past, past);
    const before = (await stat(mozconfigPath)).mtimeMs;

    await writeFiles(configsDir, {
      'common.mozconfig': 'ac_add_options --enable-bootstrap\nmk_add_options MOZ_MAKE_FLAGS=-j4\n',
    });
    await generateMozconfig(configsDir, engineDir, config);

    expect((await stat(mozconfigPath)).mtimeMs).toBeGreaterThan(before);
    expect(await readText(mozconfigPath)).toContain('MOZ_MAKE_FLAGS');
  });
});
