// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { findFirstUsefulFailureLine } from '../test-harness-output.js';

describe('findFirstUsefulFailureLine', () => {
  it('picks the first TEST-UNEXPECTED line ahead of generic output', () => {
    const output = [
      'INFO Running browser-chrome tests',
      'WARNING unrelated cleanup noise',
      'TEST-UNEXPECTED-FAIL | browser_dummy.js | expected true got false',
    ].join('\n');

    expect(findFirstUsefulFailureLine(output)).toBe(
      'TEST-UNEXPECTED-FAIL | browser_dummy.js | expected true got false'
    );
  });

  it('picks module-load runtime failures', () => {
    const output = [
      'INFO Running xpcshell tests',
      'ERROR Unexpected exception Error: Failed to load resource:///modules/HominisSurfaceManager.sys.mjs',
    ].join('\n');

    expect(findFirstUsefulFailureLine(output)).toBe(
      'ERROR Unexpected exception Error: Failed to load resource:///modules/HominisSurfaceManager.sys.mjs'
    );
  });

  it('falls back to the first nonempty output line', () => {
    expect(findFirstUsefulFailureLine('\n  first useful line\nsecond line\n')).toBe(
      'first useful line'
    );
  });
});
