// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { useTempDir } from '../testing/temp.js';
import { withEngineLock } from './index.js';

const dir = useTempDir();

describe('withEngineLock', () => {
  it('lets readers overlap and keeps a writer out while they hold it', async () => {
    const project = { paths: { stateDir: dir() } };
    const order: string[] = [];
    await withEngineLock(project, { command: 'status', mode: 'shared' }, async () => {
      await withEngineLock(project, { command: 'verify', mode: 'shared' }, async () => {
        order.push('two readers');
        await Promise.resolve();
      });
      await expect(
        withEngineLock(project, { command: 'import', waitMs: 1000 }, async () => {
          await Promise.resolve();
        })
      ).rejects.toMatchObject({
        code: 'lock-timeout',
        message: expect.stringContaining('command=status') as string,
      });
    });
    await withEngineLock(project, { command: 'import' }, async () => {
      order.push('writer');
      await Promise.resolve();
    });
    expect(order).toEqual(['two readers', 'writer']);
  });
});
