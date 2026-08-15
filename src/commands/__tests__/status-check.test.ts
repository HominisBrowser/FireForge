// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { ClassifiedFile } from '../../core/status-classify.js';
import {
  collectStatusCheckOffenders,
  resolveStatusCheckPolicy,
  runStatusCheck,
} from '../status-check.js';

function entry(file: string, classification: ClassifiedFile['classification']): ClassifiedFile {
  return { file, status: ' M', classification };
}

describe('resolveStatusCheckPolicy', () => {
  it('is disabled when neither --check nor --fail-on is given', () => {
    expect(resolveStatusCheckPolicy({})).toMatchObject({ checkEnabled: false });
  });

  it('applies the default fail set under bare --check', () => {
    expect(resolveStatusCheckPolicy({ check: true })).toEqual({
      checkEnabled: true,
      failOn: ['unmanaged', 'patch-owned-drift', 'conflict'],
    });
  });

  it('--fail-on implies --check, replaces the set, trims, and de-dupes', () => {
    expect(resolveStatusCheckPolicy({ failOn: ' conflict , unmanaged, conflict ' })).toEqual({
      checkEnabled: true,
      failOn: ['conflict', 'unmanaged'],
    });
  });

  it('refuses an unknown classification naming the valid set', () => {
    expect(() => resolveStatusCheckPolicy({ failOn: 'bogus' })).toThrow(
      /Unknown --fail-on classification "bogus"\. Valid: patch-backed, patch-owned-drift, unmanaged, branding, furnace, conflict, binary-unsupported\./
    );
  });

  it('refuses an empty --fail-on value', () => {
    expect(() => resolveStatusCheckPolicy({ failOn: ' , ' })).toThrow(
      '--fail-on requires at least one classification'
    );
  });

  it('refuses --check with each classification-skipping mode', () => {
    for (const mode of ['raw', 'unmanaged', 'ownership', 'testCoverage'] as const) {
      expect(() => resolveStatusCheckPolicy({ check: true, [mode]: true })).toThrow(
        '--check cannot be combined with'
      );
    }
  });
});

describe('runStatusCheck', () => {
  it('no-ops when the policy is disabled even with offending files', () => {
    expect(() => {
      runStatusCheck([entry('a.js', 'unmanaged')], { checkEnabled: false, failOn: ['unmanaged'] });
    }).not.toThrow();
  });

  it('passes when every file is outside the fail set', () => {
    expect(() => {
      runStatusCheck(
        [entry('a.js', 'patch-backed'), entry('b.css', 'branding'), entry('c.css', 'furnace')],
        { checkEnabled: true, failOn: ['unmanaged', 'patch-owned-drift', 'conflict'] }
      );
    }).not.toThrow();
  });

  it('names each offending classification with the first three files and a +N overflow', () => {
    const files = [
      entry('a.js', 'unmanaged'),
      entry('b.js', 'unmanaged'),
      entry('c.js', 'unmanaged'),
      entry('d.js', 'unmanaged'),
      entry('e.js', 'patch-owned-drift'),
    ];
    expect(() => {
      runStatusCheck(files, { checkEnabled: true, failOn: ['unmanaged', 'patch-owned-drift'] });
    }).toThrow(
      'status --check failed: 4 unmanaged (a.js, b.js, c.js, +1 more), 1 patch-owned-drift (e.js)'
    );
  });
});

describe('collectStatusCheckOffenders', () => {
  it('collects only fail-set classifications with full file lists, in policy order', () => {
    const files = [
      entry('a.js', 'unmanaged'),
      entry('b.js', 'patch-owned-drift'),
      entry('c.js', 'unmanaged'),
      entry('d.js', 'patch-backed'),
    ];
    expect(
      collectStatusCheckOffenders(files, {
        checkEnabled: true,
        failOn: ['patch-owned-drift', 'unmanaged'],
      })
    ).toEqual([
      { classification: 'patch-owned-drift', count: 1, files: ['b.js'] },
      { classification: 'unmanaged', count: 2, files: ['a.js', 'c.js'] },
    ]);
  });

  it('returns an empty list when nothing in the fail set is present', () => {
    expect(
      collectStatusCheckOffenders([entry('a.js', 'patch-backed')], {
        checkEnabled: true,
        failOn: ['unmanaged'],
      })
    ).toEqual([]);
  });
});
