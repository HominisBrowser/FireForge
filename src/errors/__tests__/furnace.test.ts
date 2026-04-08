// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { ExitCode } from '../codes.js';
import { FurnaceError } from '../furnace.js';

describe('furnace errors', () => {
  it('formats FurnaceError with component name', () => {
    const error = new FurnaceError('registration failed', 'my-button');

    expect(error.code).toBe(ExitCode.FURNACE_ERROR);
    expect(error.component).toBe('my-button');
    expect(error.userMessage).toContain('Furnace Error (my-button): registration failed');
    expect(error.userMessage).toContain('furnace validate');
  });

  it('formats FurnaceError without component', () => {
    const error = new FurnaceError('config invalid');

    expect(error.component).toBeUndefined();
    expect(error.userMessage).toContain('Furnace Error: config invalid');
    expect(error.userMessage).not.toContain('(');
  });

  it('preserves cause', () => {
    const cause = new Error('disk full');
    const error = new FurnaceError('copy failed', 'sidebar', cause);

    expect(error.cause).toBe(cause);
  });
});
