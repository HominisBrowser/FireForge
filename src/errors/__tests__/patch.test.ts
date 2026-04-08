// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { ExitCode } from '../codes.js';
import { PatchError } from '../patch.js';

describe('patch errors', () => {
  it('formats PatchError with patch name', () => {
    const error = new PatchError('apply failed', '001-toolbar.patch');

    expect(error.code).toBe(ExitCode.PATCH_ERROR);
    expect(error.patchName).toBe('001-toolbar.patch');
    expect(error.userMessage).toContain('Patch Error: apply failed');
    expect(error.userMessage).toContain('Patch: 001-toolbar.patch');
  });

  it('formats PatchError without patch name', () => {
    const error = new PatchError('generic failure');

    expect(error.patchName).toBeUndefined();
    expect(error.userMessage).toContain('Patch Error: generic failure');
    expect(error.userMessage).not.toContain('Patch:');
  });

  it('preserves cause', () => {
    const cause = new Error('git apply failed');
    const error = new PatchError('apply failed', 'fix.patch', cause);

    expect(error.cause).toBe(cause);
  });
});
