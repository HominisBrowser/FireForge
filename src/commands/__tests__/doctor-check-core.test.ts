// SPDX-License-Identifier: EUPL-1.2
/**
 * Severity-resolution contract for DoctorCheck. `severity` is the single
 * source of truth, so every consumer of a `DoctorCheck[]` resolves the same
 * way.
 */
import { describe, expect, it } from 'vitest';

import type { DoctorCheck } from '../../types/commands/index.js';
import { failure, ok, resolveDoctorSeverity, warning } from '../doctor-check-core.js';

type Severity = 'ok' | 'warning' | 'error';

function check(fields: Partial<DoctorCheck>): DoctorCheck {
  return { name: 'test', severity: 'ok', message: 'm', ...fields };
}

describe('resolveDoctorSeverity', () => {
  // With `severity` required, the illegal combinations of `passed` +
  // `warning` + optional `severity` are no longer representable and the
  // resolver is a field read.
  it.each<[string, Partial<DoctorCheck>, Severity]>([
    ['ok', { severity: 'ok' }, 'ok'],
    ['warning', { severity: 'warning' }, 'warning'],
    ['error', { severity: 'error' }, 'error'],
  ])('resolves %s', (_label, fields, expected) => {
    expect(resolveDoctorSeverity(check(fields))).toBe(expected);
  });

  it('agrees with every in-tree result builder', () => {
    expect(resolveDoctorSeverity(ok('a'))).toBe('ok');
    expect(resolveDoctorSeverity(warning('a', 'm'))).toBe('warning');
    expect(resolveDoctorSeverity(failure('a', 'm'))).toBe('error');
  });
});
