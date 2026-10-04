// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getProjectPaths, loadConfig } from '../../core/config.js';
import {
  createTempProject,
  removeTempProject,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { DoctorCheckContext } from '../doctor-check-core.js';
import { ENGINE_ESLINT_DOCTOR_CHECK } from '../doctor-engine-eslint.js';
import { checkRequestedTestTypes } from '../test-checkjs.js';

let root: string;
beforeEach(async () => {
  root = await createTempProject('ff-forge-checkjs-');
  await writeFireForgeConfig(root);
});
afterEach(async () => {
  await removeTempProject(root);
});

describe('early engine and test type preconditions', () => {
  it('reports missing engine ESLint before the gate and names source-refresh setup', async () => {
    const context = { paths: getProjectPaths(root), engineExists: true } as DoctorCheckContext;
    const missing = await ENGINE_ESLINT_DOCTOR_CHECK.run(context);
    expect(missing).toMatchObject({ severity: 'warning' });
    expect(JSON.stringify(missing)).toContain('./mach eslint --setup');
    await writeFiles(root, { 'engine/node_modules/eslint/bin/eslint.js': '// installed' });
    expect(await ENGINE_ESLINT_DOCTOR_CHECK.run(context)).toMatchObject({ severity: 'ok' });
    expect(ENGINE_ESLINT_DOCTOR_CHECK.skipIf?.({ ...context, engineExists: false })).toBe(true);
  });

  it('checks a new named test before export and refuses a real checkJs type error', async () => {
    const file = 'browser/base/content/test/widgets/browser_bad.js';
    await writeFiles(root, {
      'patches/patches.json': JSON.stringify({ version: 1, patches: [] }),
      [join('engine', file)]: '/** @type {number} */ const value = "bad";\n',
    });
    const config = await loadConfig(root);
    config.patchLint = { checkJs: true, checkJsTestFiles: true };
    await expect(checkRequestedTestTypes(getProjectPaths(root), config, [file])).rejects.toThrow(
      /before build/
    );
    await writeFiles(root, { [join('engine', file)]: '/** @type {number} */ const value = 42;\n' });
    await expect(
      checkRequestedTestTypes(getProjectPaths(root), config, [file])
    ).resolves.toBeUndefined();
  });

  it('leaves checkJs opt-in and skips pathless builds', async () => {
    const config = await loadConfig(root);
    await expect(
      checkRequestedTestTypes(getProjectPaths(root), config, ['missing.js'])
    ).resolves.toBeUndefined();
    config.patchLint = { checkJs: true, checkJsTestFiles: true };
    await expect(
      checkRequestedTestTypes(getProjectPaths(root), config, [])
    ).resolves.toBeUndefined();
  });
});
