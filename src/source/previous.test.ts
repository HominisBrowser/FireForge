// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  parsePreviousWaivers,
  parseScopeDecisions,
  upgradeAttributes,
  upgradeRecord,
} from './index.js';

/** A record as the previous format wrote it, one line with sorted keys. */
const PREVIOUS_RECORD =
  '{"adr":"docs/architecture/adr/0011-terminal-helper.md","base":{"blob":"665d02c00cbfaedacefb6a6719055529aac4d1bb",' +
  '"commit":"a5654e28a51104adec4bfa85c976d5c0bee7c0c6","mode":"100644",' +
  '"pin":"f34e2c19ca61596aad5fac9649681c85dae3fd94e744647680408afafad82dd2"},"classification":"exception",' +
  '"component":"906-infra-terminal-helper.patch","kind":"override","path":"Cargo.toml","schemaVersion":1}\n';

const CURRENT_RECORD = `{
  "adr": "docs/architecture/adr/0011-terminal-helper.md",
  "base": {
    "blob": "665d02c00cbfaedacefb6a6719055529aac4d1bb",
    "commit": "a5654e28a51104adec4bfa85c976d5c0bee7c0c6",
    "mode": "100644"
  },
  "classification": "exception",
  "component": "906-infra-terminal-helper.patch",
  "kind": "override"
}
`;

describe('upgradeRecord', () => {
  it('rewrites a record of the previous format, keeping its component as written', () => {
    expect(upgradeRecord(PREVIOUS_RECORD, 'Cargo.toml')).toEqual({
      state: 'converted',
      text: CURRENT_RECORD,
    });
    expect(upgradeRecord(CURRENT_RECORD, 'Cargo.toml')).toEqual({ state: 'current' });
  });

  it('converts a tombstone', () => {
    const tombstone = PREVIOUS_RECORD.replace('"kind":"override"', '"kind":"delete"');
    const result = upgradeRecord(tombstone, 'Cargo.toml');
    expect(result.state === 'converted' && JSON.parse(result.text)).toMatchObject({
      kind: 'delete',
    });
  });

  it.each([
    ['is not JSON', '{', 'Cargo.toml'],
    ['is not an override record', '[]', 'Cargo.toml'],
    [
      'has schemaVersion 2',
      PREVIOUS_RECORD.replace('"schemaVersion":1', '"schemaVersion":2'),
      'Cargo.toml',
    ],
    [
      'names path "Cargo.toml", not the path of its own location',
      PREVIOUS_RECORD,
      'browser/Cargo.toml',
    ],
    [
      '"adr" ',
      PREVIOUS_RECORD.replace('"adr":"docs/architecture/adr/0011-terminal-helper.md",', ''),
      'Cargo.toml',
    ],
    [
      '"base.blob" ',
      PREVIOUS_RECORD.replace('665d02c00cbfaedacefb6a6719055529aac4d1bb', 'abc'),
      'Cargo.toml',
    ],
  ])('refuses a record that %s', (problem, text, path) => {
    const result = upgradeRecord(text, path);
    expect(result.state).toBe('invalid');
    expect(result.state === 'invalid' && result.problem).toContain(problem.trim());
  });
});

describe('upgradeAttributes', () => {
  it('renames the merge driver and nothing else', () => {
    expect(upgradeAttributes('* -text\n* merge=fireforge-authored\n')).toBe(
      '* -text\n* merge=fireforge\n'
    );
    expect(upgradeAttributes('*.svg binary merge=fireforge-authored diff\n')).toBe(
      '*.svg binary merge=fireforge diff\n'
    );
    expect(upgradeAttributes('* -text\n* merge=fireforge\n')).toBeUndefined();
    expect(upgradeAttributes('* merge=fireforge-authored-old\n')).toBeUndefined();
  });
});

describe('parsePreviousWaivers', () => {
  it('reads bare checks, ceilings and tiers', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      exceptions: [
        {
          component: '008-branding-unbranded.patch',
          paths: ['browser/branding/unbranded/Assets.car'],
          checks: [],
          tier: 'branding',
          provenance: 'ab'.repeat(32),
        },
        {
          component: '126-infra-third-party-notices.patch',
          paths: ['browser/app/distribution/THIRD-PARTY-NOTICES.md'],
          checks: [
            'missing-license-header',
            {
              max: 2142,
              meta: { decision: 'raised for the notice line', kind: 'structural' },
              reason: 'Generated third-party notices.',
              rule: 'large-patch-lines',
              share: 'product',
            },
          ],
          provenance: 'ab'.repeat(32),
        },
      ],
    });
    expect(parsePreviousWaivers(text, 'waivers.json')).toEqual([
      {
        component: '008-branding-unbranded.patch',
        paths: ['browser/branding/unbranded/Assets.car'],
        checks: [],
        tier: 'branding',
      },
      {
        component: '126-infra-third-party-notices.patch',
        paths: ['browser/app/distribution/THIRD-PARTY-NOTICES.md'],
        checks: [
          'missing-license-header',
          {
            max: 2142,
            meta: { decision: 'raised for the notice line', kind: 'structural' },
            reason: 'Generated third-party notices.',
            rule: 'large-patch-lines',
            share: 'product',
          },
        ],
      },
    ]);
    expect(() =>
      parsePreviousWaivers('{"schemaVersion":2,"exceptions":[]}', 'waivers.json')
    ).toThrow(/schemaVersion/);
  });
});

describe('parseScopeDecisions', () => {
  const rule = { filenamePattern: '-tests\\.patch$', files: ['**/test/**', '**/tests/**'] };
  const policy = JSON.stringify({
    schemaVersion: 1,
    status: 'approved',
    adr: 'docs/architecture/adr/0045-source-mode.md',
    legacyScopeDigest: '02f7ed44bb87b13ef1a916fa251051f250f199b52d7089b2dfb61268d246676e',
    retireCreatedPatchBudgets: true,
    createdPatchBudgetReason: 'Budgets measured patch files.',
    scopeRules: [
      {
        // The digest the previous format computed for this rule at index 0.
        legacyRule: '5c32f4bde0f55a45f130f1ec9a7bad9968f28eb30ef651538aebc1f042c7d7d0',
        decision: 'retire',
        reason: 'It kept -tests patches free of product code.',
        select: [],
        allow: ['**/test/**', '**/tests/**'],
      },
    ],
  });

  it('binds each decision to its rule by the digest of the rule and its position', () => {
    expect(parseScopeDecisions(policy, 'policy.json', [rule])).toEqual([
      { decision: 'retire', reason: 'It kept -tests patches free of product code.' },
    ]);
    // The same rule in another position, or an edited rule, has no decision.
    expect(
      parseScopeDecisions(policy, 'policy.json', [{ category: 'ui', files: [] }, rule])
    ).toEqual([undefined, undefined]);
    expect(
      parseScopeDecisions(policy, 'policy.json', [{ ...rule, files: ['**/test/**'] }])
    ).toEqual([undefined]);
  });

  it('refuses a policy that is not approved', () => {
    expect(() =>
      parseScopeDecisions(policy.replace('"approved"', '"pending"'), 'policy.json', [rule])
    ).toThrow(/status/);
  });
});
