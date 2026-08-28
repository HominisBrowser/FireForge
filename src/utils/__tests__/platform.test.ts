// SPDX-License-Identifier: EUPL-1.2
/**
 * Tests for the one surviving platform helper. The rest of the module's
 * exports had zero production consumers and were removed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  platform: vi.fn(() => 'linux'),
}));

import { platform } from 'node:os';

import { GeneralError } from '../../errors/base.js';
import { getPlatform } from '../platform.js';

describe('getPlatform', () => {
  afterEach(() => {
    vi.mocked(platform).mockReturnValue('linux');
  });

  it.each(['darwin', 'linux', 'win32'] as const)('returns %s unchanged', (value) => {
    vi.mocked(platform).mockReturnValue(value);
    expect(getPlatform()).toBe(value);
  });

  it('refuses an unsupported platform by name', () => {
    // The message names the platform it saw AND the ones it supports: the
    // operator needs both to know whether to file a bug or change machine.
    vi.mocked(platform).mockReturnValue('freebsd');
    expect(() => getPlatform()).toThrow(GeneralError);
    expect(() => getPlatform()).toThrow(/Unsupported platform: freebsd/);
    expect(() => getPlatform()).toThrow(/darwin, linux, and win32/);
  });
});
