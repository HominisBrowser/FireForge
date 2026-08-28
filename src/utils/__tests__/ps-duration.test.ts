// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { formatPsDuration, parsePsDuration } from '../ps-duration.js';

describe('parsePsDuration', () => {
  it('parses the linux hh:mm:ss dialect, with and without days', () => {
    expect(parsePsDuration('03:14:12')).toBe(3 * 3600 + 14 * 60 + 12);
    expect(parsePsDuration('26-03:14:12')).toBe(26 * 86400 + 3 * 3600 + 14 * 60 + 12);
  });

  it('parses the darwin mm:ss.cc dialect, whose minutes do not wrap', () => {
    expect(parsePsDuration('38412:07.55')).toBe(38412 * 60 + 7.55);
    expect(parsePsDuration('12:30')).toBe(750);
  });

  it('returns NaN for an unrecognized shape rather than guessing zero', () => {
    // A zero would be read as "just started", which is the opposite of the
    // attribution this feeds.
    expect(parsePsDuration('')).toBeNaN();
    expect(parsePsDuration('not-a-duration')).toBeNaN();
    expect(parsePsDuration('1:2:3:4')).toBeNaN();
  });

  it('tolerates surrounding whitespace from a ps column', () => {
    expect(parsePsDuration('  12:30  ')).toBe(750);
  });
});

describe('formatPsDuration', () => {
  it('renders seconds, minutes and hours', () => {
    expect(formatPsDuration(4)).toBe('4s');
    expect(formatPsDuration(750)).toBe('12m30s');
    expect(formatPsDuration(7500)).toBe('2h05m');
  });

  it('returns undefined for an unmeasured duration so the clause can be omitted', () => {
    expect(formatPsDuration(NaN)).toBeUndefined();
    expect(formatPsDuration(-1)).toBeUndefined();
  });
});
