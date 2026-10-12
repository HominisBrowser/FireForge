// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { restartBetweenTestsArgs } from '../test-modes.js';

describe('restartBetweenTestsArgs', () => {
  it('forwards the mochitest flag once, and nothing when it was not asked for', () => {
    expect(restartBetweenTestsArgs({ restartBetweenTests: true }, 'mochitest', [])).toEqual([
      '--restart-between-tests',
    ]);
    expect(
      restartBetweenTestsArgs({ restartBetweenTests: true }, 'mochitest', [
        '--restart-between-tests',
      ])
    ).toEqual([]);
    expect(restartBetweenTestsArgs({}, 'xpcshell', [])).toEqual([]);
  });

  it.each(['xpcshell', 'generic'] as const)('refuses a %s dispatch', (suite) => {
    expect(() => restartBetweenTestsArgs({ restartBetweenTests: true }, suite, [])).toThrow(
      /mochitest harness's per-file browser restart/
    );
  });
});
