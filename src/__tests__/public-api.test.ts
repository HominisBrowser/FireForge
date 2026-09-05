// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import * as api from '../index.js';
import { PUBLIC_API_EXPORTS } from '../test-utils/public-api.js';

describe('public package API', () => {
  it('exports only the supported runtime surface', () => {
    expect(Object.keys(api).sort()).toEqual(PUBLIC_API_EXPORTS);
  });

  it('pins the documented ExitCode literals (docs/exit-codes.md)', () => {
    expect(api.ExitCode).toMatchObject({
      SUCCESS: 0,
      GENERAL_ERROR: 1,
      INVALID_ARGUMENT: 8,
      RESOLUTION_ERROR: 10,
    });
  });
});
