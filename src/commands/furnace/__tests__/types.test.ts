// SPDX-License-Identifier: EUPL-1.2
/**
 * `furnace types`: writes the generated typecheck files from the component
 * workspace, in source mode into the tracked copies, and `--check` fails on
 * a stale copy naming the command that fixes it.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../../test-utils/module-mocks.js';
import { ensureDir, pathExists, writeJson } from '../../../utils/fs.js';

vi.mock('../../../utils/logger.js', () => createLoggerMock());

import { warn } from '../../../utils/logger.js';
import { furnaceTypesCommand } from '../types.js';

let root: string;

beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), 'fireforge-furnace-types-'));
  await writeJson(join(root, 'fireforge.json'), {
    name: 'Fresh',
    vendor: 'Vendor',
    appId: 'org.example.fresh',
    binaryName: 'freshforge',
    firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    test: { reapOrphans: 'owned' },
    sources: {
      schemaVersion: 1,
      mode: 'authored',
      root: 'src',
      metadataRoot: '.fireforge-sources',
      pristineCommit: 'a'.repeat(40),
    },
  });
  await writeJson(join(root, 'furnace.json'), {
    version: 1,
    componentPrefix: 'moz-',
    stock: [],
    overrides: {},
    custom: {
      'moz-x': {
        description: 'x',
        targetPath: 'toolkit/content/widgets/moz-x',
        register: true,
        localized: false,
      },
    },
    typecheckJsconfig: ['engine/browser/base/content/jsconfig.json'],
    typecheckTagMap: 'types/tags.d.ts',
  });
  await ensureDir(join(root, 'components/custom/moz-x'));
  await writeFile(
    join(root, 'components/custom/moz-x/moz-x.mjs'),
    'export class MozX extends HTMLElement {}\ncustomElements.define("moz-x", MozX);\n'
  );
  await ensureDir(join(root, 'src/browser/base/content'));
  await writeFile(
    join(root, 'src/browser/base/content/jsconfig.json'),
    '{ "compilerOptions": { "checkJs": true } }\n'
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('furnaceTypesCommand', () => {
  it('--check fails on stale copies, a write fixes the tracked copies, then --check passes', async () => {
    await expect(furnaceTypesCommand(root, { check: true })).rejects.toThrow(
      '2 generated typecheck file(s) are out of date. Run "fireforge furnace types" and commit the result.'
    );
    expect(vi.mocked(warn).mock.calls.map((call) => call[0])).toEqual([
      'engine/browser/base/content/jsconfig.json [jsconfig-paths-drift] missing: chrome://global/content/elements/moz-x.mjs',
      'types/tags.d.ts [tag-map-drift] the file does not exist',
    ]);
    expect(await pathExists(join(root, 'types/tags.d.ts'))).toBe(false);

    await furnaceTypesCommand(root);

    expect(await pathExists(join(root, 'engine'))).toBe(false);
    const jsconfig = JSON.parse(
      await readFile(join(root, 'src/browser/base/content/jsconfig.json'), 'utf8')
    ) as { compilerOptions: Record<string, unknown> };
    expect(jsconfig.compilerOptions).toEqual({
      checkJs: true,
      paths: {
        'chrome://global/content/elements/moz-x.mjs': [
          '../../../../components/custom/moz-x/moz-x.mjs',
        ],
      },
    });
    expect(await readFile(join(root, 'types/tags.d.ts'), 'utf8')).toContain(
      `"moz-x": HTMLElement & import("chrome://global/content/elements/moz-x.mjs").MozX;`
    );
    await expect(furnaceTypesCommand(root, { check: true })).resolves.toBeUndefined();
  });
});
