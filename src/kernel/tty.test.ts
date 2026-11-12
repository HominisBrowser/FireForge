// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { ask, choose, confirm, isInteractive } from './tty.js';

describe('tty', () => {
  it('refuses to prompt without a terminal, naming the flag that answers instead', async () => {
    // Test workers have no terminal on stdin.
    expect(isInteractive()).toBe(false);
    await expect(confirm('Delete 3 patches?')).rejects.toMatchObject({
      code: 'invalid-argument',
      exitCode: 8,
      hint: 'Pass --yes to confirm without a prompt.',
    });
  });

  it('refuses a question or a choice without a terminal, naming the option to pass', async () => {
    const refusal = {
      code: 'invalid-argument',
      exitCode: 8,
      hint: 'Pass the value as an option.',
    };
    await expect(ask('Name of the browser?')).rejects.toMatchObject(refusal);
    await expect(
      choose('Which mode?', [
        { value: 'patches', label: 'A patch queue' },
        { value: 'source', label: 'Owned files' },
      ])
    ).rejects.toMatchObject({
      ...refusal,
      message: '"Which mode?" needs an answer, but no terminal is attached.',
    });
  });
});
