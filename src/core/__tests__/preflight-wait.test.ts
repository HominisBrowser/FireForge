// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());
vi.mock('../../utils/sleep.js', () => ({ sleep: vi.fn(() => Promise.resolve()) }));

import { GeneralError, PreflightRefusalError } from '../../errors/base.js';
import { info } from '../../utils/logger.js';
import { waitBeforeLock, waitForPreflight } from '../preflight-wait.js';

const busy = (): PreflightRefusalError => new PreflightRefusalError('busy', 'browser-busy');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('waitForPreflight', () => {
  it('retries a refusal until the probe clears within the budget', async () => {
    const action = vi.fn().mockRejectedValueOnce(busy()).mockResolvedValueOnce(undefined);
    await waitForPreflight(action, 60);
    expect(action).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledWith('Waiting up to 60 seconds: busy');
  });

  it('probes once without a budget and rethrows non-refusals at once', async () => {
    await expect(waitForPreflight(() => Promise.reject(busy()))).rejects.toThrow('busy');
    const boom = vi.fn(() => Promise.reject(new GeneralError('boom')));
    await expect(waitForPreflight(boom, 60)).rejects.toThrow('boom');
    expect(boom).toHaveBeenCalledTimes(1);
  });
});

describe('waitBeforeLock', () => {
  it('joins the lock queue instead of refusing when the budget runs out', async () => {
    await expect(waitBeforeLock(() => Promise.reject(busy()), undefined)).resolves.toBe(undefined);
    expect(info).toHaveBeenCalledWith(
      'Still busy after the 0-second wait; joining the lock queue and re-checking once under the lock.'
    );
  });

  it('treats a refusal class in clearNotes as clear without waiting', async () => {
    const action = vi.fn(() => Promise.reject(new PreflightRefusalError('stale', 'stale-browser')));
    await waitBeforeLock(action, 60, ['stale-browser']);
    expect(action).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
  });

  it('still throws anything that is not a preflight refusal', async () => {
    await expect(
      waitBeforeLock(() => Promise.reject(new GeneralError('lsof crashed')), 60)
    ).rejects.toThrow('lsof crashed');
  });
});
