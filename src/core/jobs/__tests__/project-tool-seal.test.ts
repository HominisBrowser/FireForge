// SPDX-License-Identifier: EUPL-1.2
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { expect, it } from 'vitest';

import { getPackageVersion } from '../../../utils/package-root.js';
import { sourceFixture } from '../../authored/__tests__/fixtures.js';
import { captureAuthoredSnapshot } from '../../authored/index.js';
import { assertProjectToolCompatibility } from '../project-tools.js';
import type { JobRecord } from '../schema.js';
import { createSlot } from '../slot-lifecycle.js';
import { acquireSlot, sealSlot } from '../slots.js';
import { writeDurable } from '../store.js';

it('vetoes a seal when same-version project tool code changed after campaign ownership began', async () => {
  const f = await sourceFixture();
  try {
    const snapshot = await captureAuthoredSnapshot({
      projectRoot: f.root,
      intendedPaths: ['src'],
      pristineRepository: f.pristine,
    });
    const namespace = join(dirname(f.root), 'coordinator');
    const slot = await createSlot({ namespace, id: 'a', snapshot, pristineRepository: f.pristine });
    const pkg = join(slot.root, 'node_modules', '@hominis', 'fireforge');
    await writeDurable(join(pkg, 'package.json'), {
      name: '@hominis/fireforge',
      version: getPackageVersion(),
    });
    await mkdir(join(pkg, 'dist', 'src', 'core', 'jobs'), { recursive: true });
    await writeFile(
      join(pkg, 'dist', 'src', 'core', 'jobs', 'guard.js'),
      'original qualified guard'
    );
    await writeFile(join(pkg, 'policy.js'), 'original policy');
    const projectToolsDigest = await assertProjectToolCompatibility(slot.root);
    const job: JobRecord = {
      schemaVersion: 1,
      id: 'fixture-job',
      owner: 'fixture',
      epoch: 1,
      state: 'sealing',
      submittedAt: '',
      updatedAt: '',
      cancellationRequested: false,
      projectToolsDigest,
      request: {
        schemaVersion: 1,
        key: 'fixture',
        slot: 'a',
        sourceId: snapshot.id,
        steps: [{ command: 'status', args: [] }],
        resources: { cpu: 1, memory: 1, build: 0, browser: 0, display: 0 },
        quiet: false,
      },
    };
    const release = await acquireSlot(namespace, 'a', { jobId: job.id });
    try {
      await writeFile(join(pkg, 'policy.js'), 'different policy at the same advertised version');
      await expect(sealSlot(namespace, slot, job)).rejects.toThrow(/Project-installed tool code/);
      await expect(access(join(namespace, 'receipts', `${job.id}.json`))).rejects.toThrow();
    } finally {
      await release();
    }
  } finally {
    await rm(dirname(f.root), { recursive: true, force: true });
  }
});
