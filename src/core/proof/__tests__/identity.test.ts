// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { measureCurrentIdentity, measureTools } from '../identity.js';

describe('measuring what a claim stands on', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fireforge-identity-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('counts a slot that cannot answer as no answer, not as a change', async () => {
    // Holding a FireForge with no guards in it, which no job can run under.
    const broken = join(directory, 'broken');
    await mkdir(join(broken, 'node_modules/@hominis/fireforge'), { recursive: true });
    await writeFile(join(broken, 'node_modules/@hominis/fireforge/package.json'), '{}');
    const measured = await measureTools([broken]);
    expect(measured.executor).toMatch(/^[a-f0-9]{64}$/);
    expect(measured.environment).toMatch(/^[a-f0-9]{64}$/);
    expect(measured.answers).toEqual([{ root: broken }]);
  });

  it('has no toolchain to report on a host with none, and asks for no measuring', async () => {
    await mkdir(join(directory, 'coordinator'));
    const identity = await measureCurrentIdentity(
      join(directory, 'coordinator'),
      'a'.repeat(64),
      false,
      false
    );
    expect(identity.toolchain).toBeUndefined();
    expect(identity.toolchainProblem).toBeUndefined();
  });

  it('refuses a namespace it cannot reach rather than reading as no toolchain', async () => {
    await writeFile(join(directory, 'file'), '');
    await expect(
      measureCurrentIdentity(join(directory, 'file', 'coordinator'), 'a'.repeat(64), false, false)
    ).rejects.toThrow(/ENOTDIR/);
  });
});
