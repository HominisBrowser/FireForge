// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getTokensCssPath } from '../../core/token-manager.js';
import {
  createTempProject,
  DEFAULT_CONFIG,
  removeTempProject,
  writeFiles,
} from '../../test-utils/index.js';
import { info, warn } from '../../utils/logger.js';
import { tokenAddCommand } from '../token.js';

vi.mock('../../utils/logger.js', async () => {
  const { createLoggerMock } = await import('../../test-utils/module-mocks.js');
  return createLoggerMock();
});
let root: string;
const name = `--${DEFAULT_CONFIG.binaryName}-color`;
const cssPath = getTokensCssPath(DEFAULT_CONFIG.binaryName);
const original = `:root {\n  ${name}: black;\n}\n:root[data-theme="light"] {\n  ${name}: white;\n}\n`;
beforeEach(async () => {
  root = await createTempProject('ff-token-variant-preview-');
  await writeFiles(root, {
    'fireforge.json': JSON.stringify(DEFAULT_CONFIG),
    'furnace.json': JSON.stringify({
      version: 1,
      componentPrefix: 'moz-',
      tokenPrefix: `--${DEFAULT_CONFIG.binaryName}-`,
      stock: [],
      overrides: {},
      custom: {},
    }),
    [`engine/${cssPath}`]: original,
  });
  vi.clearAllMocks();
});
afterEach(async () => {
  await removeTempProject(root);
});

describe('actual token variant preview and write contracts', () => {
  it('warns during the insertion preview and leaves every source byte unchanged', async () => {
    await tokenAddCommand(root, name, 'blue', {
      mode: 'static',
      variant: '[data-skin="precision"]',
      dryRun: true,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('later equal-specificity declaration')
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${cssPath}:5`));
    expect(await readFile(join(root, 'engine', cssPath), 'utf8')).toBe(original);
  });

  it('retains the same warning on write and preserves insertion/cascade ordering for review', async () => {
    await tokenAddCommand(root, name, 'blue', {
      mode: 'static',
      variant: '[data-skin="precision"]',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(':root[data-theme="light"]'));
    const written = await readFile(join(root, 'engine', cssPath), 'utf8');
    expect(written.indexOf(':root[data-skin="precision"]')).toBeLessThan(
      written.indexOf(':root[data-theme="light"]')
    );
    expect(written).toContain(`:root[data-theme="light"] {\n  ${name}: white;\n}`);
    expect(written).toContain(`${name}: blue;`);
  });
});

describe('actual base token preview and write parity', () => {
  const categorized = `:root {\n  /* = Colors = */\n  ${name}: black;\n  /* = Spacing = */\n  --${DEFAULT_CONFIG.binaryName}-gap: 1px;\n}\n`;
  it('refuses an existing token from another category in both preview and write without changing bytes', async () => {
    await writeFiles(root, { [`engine/${cssPath}`]: categorized });
    for (const dryRun of [true, false]) {
      await expect(
        tokenAddCommand(root, name, 'blue', { mode: 'static', category: 'Spacing', dryRun })
      ).rejects.toThrow(/already declared outside category/);
      expect(await readFile(join(root, 'engine', cssPath), 'utf8')).toBe(categorized);
    }
  });
  it('reports an existing same-category token as unchanged in preview', async () => {
    await writeFiles(root, { [`engine/${cssPath}`]: categorized });
    await tokenAddCommand(root, name, 'blue', { mode: 'static', category: 'Colors', dryRun: true });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('unchanged (skipped)'));
    expect(info).not.toHaveBeenCalledWith('[dry-run] Would add token:');
    expect(await readFile(join(root, 'engine', cssPath), 'utf8')).toBe(categorized);
  });
});
