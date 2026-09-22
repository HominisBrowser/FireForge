// SPDX-License-Identifier: EUPL-1.2
/**
 * The opt-in `forward-registration` arms: jar.mn, moz.build, test-manifest
 * sections and customElements.js. Each kind has a positive, a declared
 * negative, and an unresolvable line that stays silent; the default scope
 * reports none of them.
 */
import { describe, expect, it } from 'vitest';

import { lintPatchQueueForwardRegistrations } from '../patch-lint-forward-registration.js';

type Entry = Parameters<typeof lintPatchQueueForwardRegistrations>[0]['entries'][number];

function entry(
  filename: string,
  order: number,
  options: {
    added?: Record<string, string>;
    created?: Record<string, string>;
    declared?: Array<{ file: string; creates: string }>;
  } = {}
): Entry {
  return {
    filename,
    order,
    newFiles: new Map(Object.entries(options.created ?? {})),
    modifiedFileAdditions: new Map(Object.entries(options.added ?? {})),
    createdFiles: new Set(Object.keys(options.created ?? {})),
    metadata:
      options.declared !== undefined
        ? { stagedDependencies: { registrations: options.declared } }
        : null,
  };
}

const extended = (entries: Entry[]): ReturnType<typeof lintPatchQueueForwardRegistrations> =>
  lintPatchQueueForwardRegistrations({ entries, forwardRegistration: 'extended' });
const byDefault = (entries: Entry[]): ReturnType<typeof lintPatchQueueForwardRegistrations> =>
  lintPatchQueueForwardRegistrations({ entries });

const ASIDE = 'toolkit/content/widgets/moz-hominis-history/moz-hominis-history-aside.mjs';

describe('forward-registration, extended: jar.mn', () => {
  const jarLine =
    '  content/global/elements/moz-hominis-history-aside.mjs  (widgets/moz-hominis-history/moz-hominis-history-aside.mjs)';
  const queue = (declared?: Array<{ file: string; creates: string }>): Entry[] => [
    entry('202-ui-tile-widgets.patch', 202, {
      added: { 'toolkit/content/jar.mn': jarLine },
      ...(declared !== undefined ? { declared } : {}),
    }),
    entry('245-ui-history-widgets.patch', 245, { created: { [ASIDE]: 'export {};\n' } }),
  ];

  it('flags a packaging line for a file a later patch creates, with the exact remedy', () => {
    const issues = extended(queue());
    expect(issues).toHaveLength(1);
    expect(issues[0]?.patches).toEqual(['202-ui-tile-widgets.patch']);
    expect(issues[0]?.message).toContain('for packaging');
    expect(issues[0]?.message).toContain(
      'fireforge patch staged-dependency 202-ui-tile-widgets.patch --add --kind registration ' +
        `--file toolkit/content/jar.mn --line "${jarLine.trim()}" ` +
        `--creates ${ASIDE} --owner 245-ui-history-widgets.patch`
    );
  });

  it('is silent once declared', () => {
    expect(extended(queue([{ file: 'toolkit/content/jar.mn', creates: ASIDE }]))).toEqual([]);
  });

  it('is silent for a locale-substituted source', () => {
    const issues = extended([
      entry('001.patch', 1, {
        added: { 'toolkit/locales/jar.mn': '  locale/@AB_CD@/x.ftl  (%x.ftl)' },
      }),
      entry('002.patch', 2, { created: { 'toolkit/locales/x.ftl': '' } }),
    ]);
    expect(issues).toEqual([]);
  });

  it('is not reported by default', () => {
    expect(byDefault(queue())).toEqual([]);
  });
});

describe('forward-registration, extended: moz.build', () => {
  const queue = (declared?: Array<{ file: string; creates: string }>): Entry[] => [
    entry('100.patch', 100, {
      added: { 'browser/modules/hominis/moz.build': '    "HominisStore.sys.mjs",' },
      ...(declared !== undefined ? { declared } : {}),
    }),
    entry('200.patch', 200, {
      created: { 'browser/modules/hominis/HominisStore.sys.mjs': 'export {};\n' },
    }),
  ];

  it('flags a path token for a file a later patch creates', () => {
    const issues = extended(queue());
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain(
      '--creates browser/modules/hominis/HominisStore.sys.mjs --owner 200.patch'
    );
  });

  it('is silent once declared', () => {
    expect(
      extended(
        queue([
          {
            file: 'browser/modules/hominis/moz.build',
            creates: 'browser/modules/hominis/HominisStore.sys.mjs',
          },
        ])
      )
    ).toEqual([]);
  });

  it('is silent for bare words and objdir-generated tokens', () => {
    const issues = extended([
      entry('100.patch', 100, {
        added: {
          'browser/moz.build':
            'BUG_COMPONENT = ("Firefox", "General")\nGENERATED_FILES += ["!gen.h"]',
        },
      }),
      entry('200.patch', 200, { created: { 'browser/Firefox': '', 'browser/gen.h': '' } }),
    ]);
    expect(issues).toEqual([]);
  });

  it('does not flag a file the same or an earlier patch creates', () => {
    const issues = extended([
      entry('100.patch', 100, { created: { 'browser/a/New.sys.mjs': '' } }),
      entry('200.patch', 200, { added: { 'browser/a/moz.build': '"New.sys.mjs",' } }),
    ]);
    expect(issues).toEqual([]);
  });
});

describe('forward-registration, extended: test-manifest sections', () => {
  const manifest = 'browser/components/hominis/test/browser/browser.toml';
  const created = 'browser/components/hominis/test/browser/browser_history.js';
  const queue = (declared?: Array<{ file: string; creates: string }>): Entry[] => [
    entry('300.patch', 300, {
      added: { [manifest]: '["browser_history.js"]' },
      ...(declared !== undefined ? { declared } : {}),
    }),
    entry('400.patch', 400, { created: { [created]: '' } }),
  ];

  it('flags a test section whose file a later patch creates', () => {
    const issues = extended(queue());
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('as a test');
  });

  it('is silent once declared', () => {
    expect(extended(queue([{ file: manifest, creates: created }]))).toEqual([]);
  });

  it('is silent for [DEFAULT] and a section that climbs out of the tree', () => {
    const issues = extended([
      entry('300.patch', 300, {
        added: { 'a/browser.toml': '[DEFAULT]\n["../../../../escape.js"]' },
      }),
      entry('400.patch', 400, { created: { 'a/DEFAULT': '' } }),
    ]);
    expect(issues).toEqual([]);
  });
});

describe('forward-registration, extended: customElements.js', () => {
  const customElements = 'toolkit/content/customElements.js';
  const ceLine =
    '["moz-hominis-history-aside", "chrome://global/content/elements/moz-hominis-history-aside.mjs"],';
  const jarLine =
    '  content/global/elements/moz-hominis-history-aside.mjs  (widgets/moz-hominis-history/moz-hominis-history-aside.mjs)';
  const queue = (declared?: Array<{ file: string; creates: string }>): Entry[] => [
    entry('050.patch', 50, { added: { 'toolkit/content/jar.mn': jarLine } }),
    entry('202.patch', 202, {
      added: { [customElements]: ceLine },
      declared: [{ file: 'toolkit/content/jar.mn', creates: ASIDE }, ...(declared ?? [])],
    }),
    entry('245.patch', 245, { created: { [ASIDE]: '' } }),
  ];

  it('resolves the chrome URL through the queue jar.mn and flags it', () => {
    const issues = extended(queue()).filter((issue) => issue.file === customElements);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('as a custom element');
    expect(issues[0]?.message).toContain(`--creates ${ASIDE} --owner 245.patch`);
  });

  it('is silent once declared', () => {
    const issues = extended(queue([{ file: customElements, creates: ASIDE }])).filter(
      (issue) => issue.file === customElements
    );
    expect(issues).toEqual([]);
  });

  it('is silent for a chrome URL no queue jar.mn line packages', () => {
    const issues = extended([
      entry('202.patch', 202, { added: { [customElements]: ceLine } }),
      entry('245.patch', 245, { created: { [ASIDE]: '' } }),
    ]);
    expect(issues).toEqual([]);
  });
});
