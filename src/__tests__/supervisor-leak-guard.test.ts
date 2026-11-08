// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { leakedSupervisors, parseSupervisors } from '../test-utils/supervisor-leak-guard.js';

describe('the supervisor leak guard', () => {
  const output = [
    '  101 /usr/local/bin/node --import /x/source-loader-bootstrap.cjs /x/src/core/jobs/supervisor-main.ts /tmp/ns one',
    '  102 node /pkg/dist/src/core/jobs/supervisor-main.js /tmp/other',
    '  103 node /x/vitest.js supervisor-main',
    '  104 grep supervisor-main.ts',
  ].join('\n');

  it('reads a supervisor and its namespace out of ps output, and nothing else', () => {
    expect(parseSupervisors(output)).toEqual([
      { pid: 101, namespace: '/tmp/ns one' },
      { pid: 102, namespace: '/tmp/other' },
    ]);
  });

  it('counts only what this run started', () => {
    const [first, second] = parseSupervisors(output);
    if (first === undefined || second === undefined) throw new Error('fixture has two');
    expect(leakedSupervisors([first], [first, second])).toEqual([second]);
    expect(leakedSupervisors([first, second], [first])).toEqual([]);
  });
});
