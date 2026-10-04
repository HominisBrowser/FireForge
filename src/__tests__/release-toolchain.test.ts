// SPDX-License-Identifier: EUPL-1.2
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../scripts/check-release-toolchain.mjs', import.meta.url));
const pinnedNode = readFileSync(new URL('../../.nvmrc', import.meta.url), 'utf8').trim();
const metadata = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
) as { packageManager: string };
const pinnedNpm = metadata.packageManager.slice(4);

function check(userAgent: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, npm_config_user_agent: userAgent },
  });
}

it.each(['', 'npm/0.0.0 node/v22.23.2'])('refuses an unpinned npm invocation %j', (agent) => {
  const result = check(agent);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(String(result.stderr)).toContain(`npm ${pinnedNpm} required by packageManager`);
});

it('accepts only the pinned Node version even when npm matches', () => {
  const result = check(`npm/${pinnedNpm} node/v${process.versions.node}`);
  expect(result.error).toBeUndefined();
  if (process.versions.node === pinnedNode) {
    expect(result.status).toBe(0);
    expect(String(result.stdout)).toContain(
      `Release toolchain: Node ${pinnedNode}, npm ${pinnedNpm}`
    );
  } else {
    expect(result.status).toBe(1);
    expect(String(result.stderr)).toContain(`Node ${pinnedNode} required by .nvmrc`);
  }
});
