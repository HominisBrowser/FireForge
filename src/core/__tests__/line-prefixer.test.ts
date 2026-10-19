// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { createLinePrefixer } from '../line-prefixer.js';

describe('createLinePrefixer', () => {
  it('prefixes each line once, across chunk boundaries', () => {
    const prefixer = createLinePrefixer('[job 2] ');
    expect(prefixer.transform('')).toBe('');
    expect(prefixer.transform('one\ntw')).toBe('[job 2] one\n[job 2] tw');
    expect(prefixer.transform('o\n')).toBe('o\n');
    expect(prefixer.transform('\nthree')).toBe('[job 2] \n[job 2] three');
  });
});
