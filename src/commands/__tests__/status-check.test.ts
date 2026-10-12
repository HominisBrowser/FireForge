// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { ClassifiedFile } from '../../core/status-classify.js';
import {
  collectStatusCheckOffenders,
  policyNeedsOwnership,
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
      /Unknown --fail-on classification "bogus"\. Valid: patch-backed, patch-owned-drift, unmanaged, branding, furnace, conflict, binary-unsupported, ownership-conflict\./
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

describe('--allow, --fail-on-unknown and ownership-conflict', () => {
  it('--allow implies --check and subtracts from the default set', () => {
    expect(resolveStatusCheckPolicy({ allow: 'conflict' })).toEqual({
      checkEnabled: true,
      failOn: ['unmanaged', 'patch-owned-drift'],
      allow: ['conflict'],
    });
  });

  it('accepts ownership-conflict in --fail-on', () => {
    expect(resolveStatusCheckPolicy({ failOn: 'unmanaged,ownership-conflict' })).toEqual({
      checkEnabled: true,
      failOn: ['unmanaged', 'ownership-conflict'],
    });
  });

  it('refuses a class named in both --fail-on and --allow', () => {
    expect(() => resolveStatusCheckPolicy({ failOn: 'unmanaged', allow: 'unmanaged' })).toThrow(
      '--fail-on and --allow both name unmanaged'
    );
  });

  it('refuses an unknown --allow class and an empty --allow', () => {
    expect(() => resolveStatusCheckPolicy({ allow: 'bogus' })).toThrow(
      'Unknown --allow classification "bogus"'
    );
    expect(() => resolveStatusCheckPolicy({ allow: ',' })).toThrow(
      '--allow requires at least one classification'
    );
  });

  it('refuses --fail-on-unknown without --allow', () => {
    expect(() => resolveStatusCheckPolicy({ failOn: 'unmanaged', failOnUnknown: true })).toThrow(
      '--fail-on-unknown requires --allow'
    );
  });

  it('records --fail-on-unknown on the policy and implies --check', () => {
    expect(
      resolveStatusCheckPolicy({ allow: 'patch-backed', failOnUnknown: true, failOn: 'unmanaged' })
    ).toEqual({
      checkEnabled: true,
      failOn: ['unmanaged'],
      allow: ['patch-backed'],
      failOnUnknown: true,
    });
  });

  it('refuses --allow alongside a classification-skipping mode', () => {
    expect(() => resolveStatusCheckPolicy({ allow: 'unmanaged', raw: true })).toThrow(
      '--check cannot be combined with'
    );
  });

  it('fails every present class neither list names, marked unnamed', () => {
    const policy = resolveStatusCheckPolicy({
      failOn: 'unmanaged',
      allow: 'patch-backed',
      failOnUnknown: true,
    });
    const files = [
      entry('a.js', 'patch-backed'),
      entry('b.css', 'branding'),
      entry('c.js', 'unmanaged'),
      entry('d.css', 'branding'),
    ];
    expect(collectStatusCheckOffenders(files, policy, ['x.js'])).toEqual([
      { classification: 'unmanaged', count: 1, files: ['c.js'] },
      { classification: 'branding', count: 2, files: ['b.css', 'd.css'], unnamed: true },
      { classification: 'ownership-conflict', count: 1, files: ['x.js'], unnamed: true },
    ]);
    expect(() => {
      runStatusCheck(files, policy, ['x.js']);
    }).toThrow('2 branding [named by neither --fail-on nor --allow] (b.css, d.css)');
  });

  it('passes under --fail-on-unknown when every present class is allowed', () => {
    const policy = resolveStatusCheckPolicy({
      allow: 'patch-backed,ownership-conflict',
      failOnUnknown: true,
    });
    expect(collectStatusCheckOffenders([entry('a.js', 'patch-backed')], policy, ['x.js'])).toEqual(
      []
    );
  });

  it('fails ownership-conflict from the conflict paths when it is in the fail set', () => {
    const policy = resolveStatusCheckPolicy({ failOn: 'ownership-conflict' });
    expect(() => {
      runStatusCheck([], policy, ['a.js', 'b.js']);
    }).toThrow('status --check failed: 2 ownership-conflict (a.js, b.js)');
    expect(() => {
      runStatusCheck([], policy, []);
    }).not.toThrow();
  });

  it('policyNeedsOwnership is true only when ownership-conflict can fail', () => {
    expect(policyNeedsOwnership(resolveStatusCheckPolicy({}))).toBe(false);
    expect(policyNeedsOwnership(resolveStatusCheckPolicy({ check: true }))).toBe(false);
    expect(policyNeedsOwnership(resolveStatusCheckPolicy({ failOn: 'ownership-conflict' }))).toBe(
      true
    );
    expect(
      policyNeedsOwnership(resolveStatusCheckPolicy({ allow: 'unmanaged', failOnUnknown: true }))
    ).toBe(true);
    expect(
      policyNeedsOwnership(
        resolveStatusCheckPolicy({ allow: 'ownership-conflict', failOnUnknown: true })
      )
    ).toBe(false);
  });
});
