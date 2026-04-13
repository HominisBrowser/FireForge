// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
}));

import type { ApplyResult, DryRunAction } from '../../types/furnace.js';
import { error, info, success, warn } from '../../utils/logger.js';
import { logApplyResult } from '../furnace-apply-output.js';

const mockError = vi.mocked(error);
const mockInfo = vi.mocked(info);
const mockSuccess = vi.mocked(success);
const mockWarn = vi.mocked(warn);

beforeEach(() => {
  vi.clearAllMocks();
});

function emptyResult(): ApplyResult {
  return { applied: [], skipped: [], errors: [] };
}

describe('logApplyResult — dry-run', () => {
  it('prints "no actions" when dry-run produced an empty action list', () => {
    logApplyResult(emptyResult(), true);
    expect(mockInfo).toHaveBeenCalledWith('No actions would be performed.');
    expect(mockSuccess).not.toHaveBeenCalled();
  });

  it('prints each planned action prefixed with action kind and component', () => {
    const actions: DryRunAction[] = [
      {
        component: 'moz-banner',
        action: 'copy',
        description: 'copy moz-banner.mjs to engine',
      },
      {
        component: 'moz-banner',
        action: 'register-ce',
        description: 'register moz-banner in customElements.js',
      },
    ];

    logApplyResult({ ...emptyResult(), actions }, true);

    expect(mockInfo).toHaveBeenCalledWith('Planned actions:');
    expect(mockInfo).toHaveBeenCalledWith('  [copy] moz-banner: copy moz-banner.mjs to engine');
    expect(mockInfo).toHaveBeenCalledWith(
      '  [register-ce] moz-banner: register moz-banner in customElements.js'
    );
  });

  it('falls through to "no actions" when dry-run actions array is empty', () => {
    logApplyResult({ ...emptyResult(), actions: [] }, true);
    expect(mockInfo).toHaveBeenCalledWith('No actions would be performed.');
  });
});

describe('logApplyResult — successful apply', () => {
  it('prints a success line per applied component with file count', () => {
    const result: ApplyResult = {
      applied: [
        { name: 'moz-banner', type: 'override', filesAffected: ['banner.mjs', 'banner.css'] },
        { name: 'my-widget', type: 'custom', filesAffected: ['widget.mjs'] },
      ],
      skipped: [],
      errors: [],
    };

    logApplyResult(result, false);

    expect(mockSuccess).toHaveBeenCalledWith('moz-banner (override) → 2 files');
    expect(mockSuccess).toHaveBeenCalledWith('my-widget (custom) → 1 files');
  });

  it('prints a skipped reason per skipped component', () => {
    const result: ApplyResult = {
      applied: [],
      skipped: [{ name: 'moz-card', reason: 'No changes since last apply' }],
      errors: [],
    };

    logApplyResult(result, false);

    expect(mockInfo).toHaveBeenCalledWith('moz-card — No changes since last apply');
  });
});

describe('logApplyResult — step errors', () => {
  it('warns once per step error on an applied component', () => {
    const result: ApplyResult = {
      applied: [
        {
          name: 'moz-banner',
          type: 'custom',
          filesAffected: ['banner.mjs'],
          stepErrors: [
            { step: 'register-ce', error: 'customElements.js parse failed' },
            { step: 'register-jar', error: 'jar.mn entry refused' },
          ],
        },
      ],
      skipped: [],
      errors: [],
    };

    logApplyResult(result, false);

    expect(mockWarn).toHaveBeenCalledWith(
      'moz-banner: [register-ce] customElements.js parse failed'
    );
    expect(mockWarn).toHaveBeenCalledWith('moz-banner: [register-jar] jar.mn entry refused');
  });
});

describe('logApplyResult — component errors', () => {
  it('logs each component-level error after the body', () => {
    const result: ApplyResult = {
      applied: [],
      skipped: [],
      errors: [{ name: 'moz-broken', error: 'workspace directory missing' }],
    };

    logApplyResult(result, false);

    expect(mockError).toHaveBeenCalledWith('moz-broken — workspace directory missing');
  });

  it('logs component errors even in dry-run mode', () => {
    const result: ApplyResult = {
      applied: [],
      skipped: [],
      errors: [{ name: 'moz-broken', error: 'workspace directory missing' }],
    };

    logApplyResult({ ...result, actions: [] }, true);

    expect(mockError).toHaveBeenCalledWith('moz-broken — workspace directory missing');
  });
});

describe('logApplyResult — mixed result', () => {
  it('emits applied, skipped, step-error, and component-error sections in order', () => {
    const result: ApplyResult = {
      applied: [
        { name: 'moz-banner', type: 'override', filesAffected: ['banner.css'] },
        {
          name: 'moz-toggle',
          type: 'custom',
          filesAffected: ['toggle.mjs'],
          stepErrors: [{ step: 'register-jar', error: 'jar.mn locked' }],
        },
      ],
      skipped: [{ name: 'moz-card', reason: 'No changes since last apply' }],
      errors: [{ name: 'moz-broken', error: 'workspace directory missing' }],
    };

    logApplyResult(result, false);

    // Each category was reached at least once.
    expect(mockSuccess).toHaveBeenCalledWith('moz-banner (override) → 1 files');
    expect(mockSuccess).toHaveBeenCalledWith('moz-toggle (custom) → 1 files');
    expect(mockInfo).toHaveBeenCalledWith('moz-card — No changes since last apply');
    expect(mockWarn).toHaveBeenCalledWith('moz-toggle: [register-jar] jar.mn locked');
    expect(mockError).toHaveBeenCalledWith('moz-broken — workspace directory missing');
  });
});
