// SPDX-License-Identifier: EUPL-1.2
/**
 * Severity-resolution contract for DoctorCheck.
 *
 * `src/types/commands/project.ts` documents the field precedence, and before
 * 0.41.0 two consumers implemented it differently: `reportDoctorResults`
 * consulted `warning` only inside the `passed === true` branch, so the
 * documented `passed: false + warning: true` downgrade produced an error and
 * a non-zero doctor exit, while `bootstrap.ts` — reading the same array one
 * line earlier — classified it as a warning. No in-tree producer emitted the
 * combination, so the contradiction was latent; the interface is exported, so
 * the next hand-rolled check would have hit it.
 */
import { describe, expect, it } from 'vitest';

import type { DoctorCheck } from '../../types/commands/index.js';
import { failure, ok, resolveDoctorSeverity, warning } from '../doctor-check-core.js';

type Severity = 'ok' | 'warning' | 'error';

function check(fields: Partial<DoctorCheck>): DoctorCheck {
  return { name: 'test', passed: true, message: 'm', ...fields };
}

describe('resolveDoctorSeverity', () => {
  it.each<[string, Partial<DoctorCheck>, Severity]>([
    ['passed, no warning, no severity', { passed: true }, 'ok'],
    ['passed + warning, no severity', { passed: true, warning: true }, 'warning'],
    // The cell the two consumers disagreed on.
    ['NOT passed + warning, no severity', { passed: false, warning: true }, 'warning'],
    ['NOT passed, no warning, no severity', { passed: false }, 'error'],
  ])('resolves %s to %s', (_label, fields, expected) => {
    expect(resolveDoctorSeverity(check(fields))).toBe(expected);
  });

  it.each<[string, Partial<DoctorCheck>, Severity]>([
    ['severity ok beats passed:false', { passed: false, severity: 'ok' }, 'ok'],
    ['severity error beats passed:true', { passed: true, severity: 'error' }, 'error'],
    [
      'severity error beats warning:true',
      { passed: false, warning: true, severity: 'error' },
      'error',
    ],
    ['severity warning beats passed:true', { passed: true, severity: 'warning' }, 'warning'],
  ])('treats severity as authoritative: %s', (_label, fields, expected) => {
    expect(resolveDoctorSeverity(check(fields))).toBe(expected);
  });

  it('agrees with every in-tree result builder', () => {
    expect(resolveDoctorSeverity(ok('a'))).toBe('ok');
    expect(resolveDoctorSeverity(warning('a', 'm'))).toBe('warning');
    expect(resolveDoctorSeverity(failure('a', 'm'))).toBe('error');
  });
});
