// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { PreviousWaiver, SourceStatus } from '../source/index.js';
import { placeWaivers, type WaiverPlacement, withWaivers } from './previousWaivers.js';

/** Owned paths shaped like a project cut from a patch queue: upstream changes, declared groups, a directory group. */
const STATUS: SourceStatus = {
  owned: [
    { path: 'browser/base/content/browser.js', kind: 'modify', group: '200-ui-window-shell.patch' },
    { path: 'browser/base/jar.mn', kind: 'modify', group: '200-ui-window-shell.patch' },
    { path: 'browser/actors/A.sys.mjs', kind: 'modify', group: '924-infra-callers.patch' },
    { path: 'browser/actors/B.sys.mjs', kind: 'delete', group: '924-infra-callers.patch' },
    { path: 'browser/themes/icons/a.svg', kind: 'create', group: 'ui-icons' },
    { path: 'browser/themes/icons/b.svg', kind: 'create', group: 'ui-icons' },
    { path: 'browser/base/content/kit/vendor.js', kind: 'create', group: 'ui-kit' },
    { path: 'browser/base/content/kit/kit.js', kind: 'create', group: 'ui-kit' },
    { path: 'browser/app/NOTICES.md', kind: 'create', group: 'created-browser-app' },
  ],
  groups: [
    { id: '200-ui-window-shell.patch', kind: 'component', paths: 2 },
    { id: '924-infra-callers.patch', kind: 'component', paths: 2 },
    { id: 'created-browser-app', kind: 'created', paths: 1 },
    { id: 'ui-icons', kind: 'created', paths: 2 },
    { id: 'ui-kit', kind: 'created', paths: 2 },
  ],
  problems: [],
};
const DECLARED = new Set(['ui-icons', 'ui-kit']);
const COMPONENTS = [
  {
    id: 'moz-terminal',
    paths: [
      'toolkit/content/widgets/moz-terminal/moz-terminal.mjs',
      'toolkit/content/widgets/moz-terminal/xterm.mjs',
    ],
  },
  { id: 'moz-icons', paths: ['toolkit/content/widgets/moz-icons/moz-icons.mjs'] },
];

const ceiling = (
  rule: string,
  max: number,
  share?: 'product' | 'test'
): Exclude<PreviousWaiver['checks'][number], string> => ({
  rule,
  max,
  reason: 'Reviewed.',
  ...(share === undefined ? {} : { share }),
  meta: { decision: 'budget decision 15' },
});

function place(...waivers: PreviousWaiver[]): WaiverPlacement {
  return placeWaivers(waivers, STATUS, DECLARED, COMPONENTS);
}

describe('placeWaivers', () => {
  it('puts a size ceiling and the tier on the component of upstream changes, and names the dropped notes', () => {
    const plan = place({
      component: '200-ui-window-shell.patch',
      paths: ['browser/base/content/browser.js', 'browser/base/jar.mn', 'browser/gone.js'],
      checks: [ceiling('large-patch-files', 25), ceiling('large-patch-lines', 4839, 'product')],
      tier: 'branding',
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.waivers).toEqual([
      {
        group: '200-ui-window-shell.patch',
        rule: 'large-patch-files',
        max: 25,
        reason: 'Reviewed.',
      },
      {
        group: '200-ui-window-shell.patch',
        rule: 'large-patch-lines',
        max: 4839,
        reason: 'Reviewed.',
        share: 'product',
      },
    ]);
    expect(plan.componentTiers).toEqual({ '200-ui-window-shell.patch': 'branding' });
    expect(plan.removed.map((note) => note.key)).toEqual([
      'waivers.json 200-ui-window-shell.patch checks[0].meta',
      'waivers.json 200-ui-window-shell.patch checks[1].meta',
    ]);
    expect(plan.removed[0]?.message).toContain('budget decision 15');
  });

  it('drops what bounded upstream changes a component no longer has, and says so', () => {
    const plan = place({
      component: '444-ui-icons.patch',
      paths: ['browser/themes/icons/a.svg', 'browser/themes/icons/b.svg'],
      checks: [{ rule: 'large-patch-files', max: 60, reason: 'One generated set.' }],
      tier: 'branding',
    });
    expect(plan.waivers).toEqual([]);
    expect(plan.componentTiers).toEqual({});
    expect(plan.removed.map((note) => note.key)).toEqual([
      'waivers.json 444-ui-icons.patch tier',
      'waivers.json 444-ui-icons.patch checks[0]',
    ]);
  });

  it('places a per-path check on the groups that hold exactly its paths', () => {
    const plan = place(
      {
        component: '924-infra-callers.patch',
        paths: ['browser/actors/A.sys.mjs', 'browser/actors/B.sys.mjs'],
        checks: ['modified-file-missing-header'],
      },
      {
        component: '444-ui-icons.patch',
        paths: ['browser/themes/icons/a.svg', 'browser/themes/icons/b.svg'],
        checks: ['missing-license-header'],
      }
    );
    expect(plan.blockers).toEqual([]);
    expect(plan.groups).toEqual([]);
    expect(plan.waivers).toEqual([
      {
        group: '924-infra-callers.patch',
        rule: 'modified-file-missing-header',
        reason: 'Carried over from 924-infra-callers.patch',
      },
      {
        group: 'ui-icons',
        rule: 'missing-license-header',
        reason: 'Carried over from 444-ui-icons.patch',
      },
    ]);
  });

  it('gives created files that share a group with others a group of their own', () => {
    const plan = place({
      component: '411-ui-kit-vendor.patch',
      paths: ['browser/base/content/kit/vendor.js', 'browser/app/NOTICES.md'],
      checks: ['missing-license-header', 'raw-color-value'],
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.groups).toEqual([
      {
        name: 'ui-kit-vendor',
        paths: ['browser/app/NOTICES.md', 'browser/base/content/kit/vendor.js'],
      },
    ]);
    expect(plan.waivers.map((waiver) => [waiver.group, waiver.rule])).toEqual([
      ['ui-kit-vendor', 'missing-license-header'],
      ['ui-kit-vendor', 'raw-color-value'],
    ]);
    const merged = withWaivers(
      { exportQueue: { groups: [{ name: 'ui-kit', paths: ['browser/base/content/kit/**'] }] } },
      plan
    );
    // The new group goes first: a created file joins the first group that matches it.
    expect(merged).toMatchObject({
      exportQueue: { groups: [{ name: 'ui-kit-vendor' }, { name: 'ui-kit' }] },
      patchLint: { waivers: [{ group: 'ui-kit-vendor' }, { group: 'ui-kit-vendor' }] },
    });
  });

  it('never widens: part of a component is a blocker, part of a Furnace component is left to a person', () => {
    const plan = place(
      {
        component: '200-ui-window-shell.patch',
        paths: ['browser/base/jar.mn'],
        checks: ['modified-file-missing-header'],
      },
      {
        component: '336-ui-terminal-vendor.patch',
        paths: ['toolkit/content/widgets/moz-terminal/xterm.mjs'],
        checks: ['missing-license-header'],
      },
      {
        component: '337-ui-icons-widget.patch',
        paths: ['toolkit/content/widgets/moz-icons/moz-icons.mjs'],
        checks: ['missing-license-header'],
      }
    );
    expect(plan.blockers.map((note) => note.key)).toEqual([
      'waivers.json 200-ui-window-shell.patch checks[0]',
    ]);
    expect(plan.manual).toHaveLength(1);
    expect(plan.manual[0]?.message).toContain(
      '{"group":"moz-terminal","rule":"missing-license-header","reason":"Carried over from 336-ui-terminal-vendor.patch"}'
    );
    // A whole Furnace component is a group like any other.
    expect(plan.waivers.map((waiver) => waiver.group)).toEqual(['moz-icons']);
  });

  it('refuses a rule it does not know, a group ID that is taken, and a path a glob cannot spell', () => {
    const plan = place(
      { component: '001-x.patch', paths: [], checks: ['no-such-rule'] },
      {
        component: '555-ui-icons.patch',
        paths: ['browser/base/content/kit/vendor.js'],
        checks: ['missing-license-header'],
      },
      {
        component: '556-ui-odd.patch',
        paths: ['browser/app/NOTICES.md'],
        checks: ['missing-license-header'],
      }
    );
    expect(plan.blockers.map((note) => note.message)).toEqual([
      'waives "no-such-rule", which is not a lint rule',
      expect.stringContaining('needs a group "ui-icons"'),
    ]);
    expect(plan.groups.map((group) => group.name)).toEqual(['ui-odd']);
    const odd = placeWaivers(
      [{ component: '1-ui-q.patch', paths: ['browser/a?.js'], checks: ['jsdoc'] }],
      { ...STATUS, owned: [{ path: 'browser/a?.js', kind: 'create', group: 'created-browser' }] },
      DECLARED
    );
    expect(odd.blockers[0]?.message).toContain('which a glob cannot name literally');
  });
});
