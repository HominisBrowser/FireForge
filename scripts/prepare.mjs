// SPDX-License-Identifier: EUPL-1.2
import { spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

const cwd = process.cwd();
const gitDir = join(cwd, '.git');
const huskyBin = join(cwd, 'node_modules', 'husky', 'bin.js');

if (process.env.CI) {
  process.exit(0);
}

try {
  await access(gitDir, constants.F_OK);
  await access(huskyBin, constants.F_OK);
} catch {
  process.exit(0);
}

const result = spawnSync(process.execPath, [huskyBin], {
  cwd,
  stdio: 'ignore',
});

if (typeof result.status === 'number') {
  process.exit(result.status);
}

if (result.error) {
  throw result.error;
}
