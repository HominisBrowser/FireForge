// SPDX-License-Identifier: EUPL-1.2
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import { formatGeneratedJsconfig } from '../furnace-json-format.js';

describe('generated jsconfig engine formatting', () => {
  let root: string;
  beforeEach(async () => {
    root = await createTempProject('ff-json-format-');
  });
  afterEach(async () => {
    await removeTempProject(root);
  });
  it('uses installed engine Prettier and its config while preserving JSONC comments', async () => {
    await mkdir(join(root, 'engine', 'node_modules'), { recursive: true });
    const packageFile = createRequire(import.meta.url).resolve('prettier/package.json');
    await symlink(dirname(packageFile), join(root, 'engine', 'node_modules', 'prettier'), 'dir');
    await writeFile(join(root, 'engine', '.prettierrc.json'), '{"tabWidth":4}');
    const result = await formatGeneratedJsconfig(
      root,
      join(root, 'engine', 'jsconfig.json'),
      '// retained\n{\n"compilerOptions":{"paths":{"x":["./x.mjs"]}}}'
    );
    expect(result).toContain('// retained');
    expect(result).toContain('    "compilerOptions"');
    expect(result).toContain('"x": ["./x.mjs"]');
  });
});
