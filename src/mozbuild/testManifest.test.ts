// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  addTest,
  defaultValue,
  listTests,
  newTestManifest,
  parseTestManifest,
  removeTest,
  supportEntries,
  supportUsers,
  testManifestReferences,
} from './testManifest.js';

const lines = (...rows: string[]): string => rows.join('\n') + '\n';
const MANIFEST = 'browser/modules/test/unit/xpcshell.toml';

describe('parseTestManifest', () => {
  it('reads sections and the keys under them', () => {
    const manifest = parseTestManifest(
      MANIFEST,
      lines(
        'prefs = ["a=1"]',
        '',
        '[DEFAULT]',
        'head = "head.js"',
        'support-files = [',
        '  "a.json",',
        '  "b.json",  # note',
        ']',
        '',
        '# about the test',
        '["test_a.js"]',
        'skip-if = ["os == \'win\'"]',
        '',
        '[include:other.toml]'
      )
    );
    expect(manifest.sections.map((s) => [s.kind, s.name, s.line, s.start, s.end])).toEqual([
      ['preamble', undefined, -1, 0, 2],
      ['default', 'DEFAULT', 2, 2, 9],
      ['test', 'test_a.js', 10, 9, 13],
      ['include', 'include:other.toml', 13, 13, 14],
    ]);
    const support = manifest.sections[1]?.keys.find((key) => key.name === 'support-files');
    expect(support).toMatchObject({
      line: 4,
      endLine: 7,
      items: [
        { value: 'a.json', line: 5 },
        { value: 'b.json', line: 6 },
      ],
    });
    expect(manifest.sections[2]?.keys[0]?.items[0]?.value).toBe("os == 'win'");
  });

  it('reads the .ini spelling with continuation lines and bare section names', () => {
    const manifest = parseTestManifest(
      'dom/test/mochitest.ini',
      lines(
        '[DEFAULT]',
        'support-files =',
        '  a.html',
        '  b.html',
        '  # not a continuation',
        'tags = x y',
        '',
        '[test_a.html]'
      )
    );
    expect(manifest.format).toBe('ini');
    const keys = manifest.sections[1]?.keys;
    expect(keys?.[0]?.items.map((i) => [i.value, i.line])).toEqual([
      ['a.html', 2],
      ['b.html', 3],
    ]);
    expect(keys?.[1]?.items.map((i) => i.value)).toEqual(['x', 'y']);
    expect(manifest.sections[2]?.name).toBe('test_a.html');
  });

  it('does not walk the file on an unterminated array', () => {
    const manifest = parseTestManifest(
      MANIFEST,
      lines('support-files = [', '  "a",', '', '["test_a.js"]')
    );
    expect(manifest.sections.map((s) => s.name)).toEqual([undefined, 'test_a.js']);
    expect(manifest.sections[0]?.keys[0]?.items).toEqual([]);
  });
});

describe('queries', () => {
  const text = lines(
    '[DEFAULT]',
    'head = "head.js"',
    'support-files = ["fixtures/*.sqlite", "../shared/"]',
    '',
    '["test_a.js"]',
    'support-files = "a-only.json"',
    '',
    '["sub/test_b.js"]'
  );

  it('lists the tests as engine paths', () => {
    expect(listTests(MANIFEST, text)).toEqual([
      'browser/modules/test/unit/test_a.js',
      'browser/modules/test/unit/sub/test_b.js',
    ]);
  });

  it('lists support entries with their line and the test they serve', () => {
    expect(supportEntries(MANIFEST, text).map((e) => [e.key, e.entry, e.line, e.test])).toEqual([
      ['head', 'head.js', 1, undefined],
      ['support-files', 'fixtures/*.sqlite', 2, undefined],
      ['support-files', '../shared/', 2, undefined],
      ['support-files', 'a-only.json', 5, 'browser/modules/test/unit/test_a.js'],
    ]);
    expect(supportEntries(MANIFEST, text, ['head']).map((e) => e.entry)).toEqual(['head.js']);
    expect(supportEntries(MANIFEST, text)[1]?.text).toBe(
      'support-files = ["fixtures/*.sqlite", "../shared/"]'
    );
  });

  it('reads the added lines of a patch as a fragment', () => {
    expect(
      supportEntries(MANIFEST, 'support-files = ["fixtures/*.sqlite", "head.js"]').map(
        (e) => e.entry
      )
    ).toEqual(['fixtures/*.sqlite', 'head.js']);
    expect(supportEntries(MANIFEST, 'support-files = a.json b.json').map((e) => e.entry)).toEqual([
      'a.json',
      'b.json',
    ]);
  });

  it('ignores every other key', () => {
    expect(supportEntries(MANIFEST, 'generated-files = ["x"]\nskip-if = ["y"]')).toEqual([]);
  });

  describe('supportUsers', () => {
    const manifests = [{ path: MANIFEST, text }];
    it('gives a default entry to every test and a section entry to its test only', () => {
      expect(supportUsers('browser/modules/test/unit/fixtures/schema.sqlite', manifests)).toEqual([
        'browser/modules/test/unit/sub/test_b.js',
        'browser/modules/test/unit/test_a.js',
      ]);
      expect(supportUsers('browser/modules/test/unit/a-only.json', manifests)).toEqual([
        'browser/modules/test/unit/test_a.js',
      ]);
    });
    it('reads ../ and directory entries that cover everything beneath', () => {
      expect(supportUsers('browser/modules/test/shared/deep/x.js', manifests)).toHaveLength(2);
    });
    it('does not let a single * cross a directory, and never counts a test as its own support', () => {
      expect(supportUsers('browser/modules/test/unit/fixtures/deep/x.sqlite', manifests)).toEqual(
        []
      );
      expect(supportUsers('browser/modules/test/unit/test_a.js', manifests)).toEqual([]);
    });
    it('reads root-relative and ** entries', () => {
      const rooted = [
        {
          path: MANIFEST,
          text: lines(
            '[DEFAULT]',
            'support-files = ["!/browser/other/**", "/tools/x.js"]',
            '["t.js"]'
          ),
        },
      ];
      expect(supportUsers('browser/other/deep/f.js', rooted)).toEqual([
        'browser/modules/test/unit/t.js',
      ]);
      expect(supportUsers('tools/x.js', rooted)).toHaveLength(1);
    });
  });

  it('names every test and support entry as a reference', () => {
    const refs = testManifestReferences(MANIFEST, text);
    expect(refs.map((r) => [r.kind, r.token])).toEqual([
      ['test', 'test_a.js'],
      ['test', 'sub/test_b.js'],
      ['head', 'head.js'],
      ['support-files', 'fixtures/*.sqlite'],
      ['support-files', '../shared/'],
      ['support-files', 'a-only.json'],
    ]);
  });

  it('reads a scalar default, with quoted or bare values, and ignores sections', () => {
    const toml = lines(
      '[DEFAULT]',
      'firefox-appdir = browser  # trailing',
      '["test_a.js"]',
      'firefox-appdir = "other"'
    );
    expect(defaultValue(MANIFEST, toml, 'firefox-appdir')).toEqual({ value: 'browser', line: 1 });
    expect(defaultValue(MANIFEST, 'firefox-appdir = "browser"\n', 'firefox-appdir')?.value).toBe(
      'browser'
    );
    expect(
      defaultValue(MANIFEST, lines('["t.js"]', 'firefox-appdir = "x"'), 'firefox-appdir')
    ).toBeUndefined();
    expect(defaultValue(MANIFEST, '# firefox-appdir = "x"\n', 'firefox-appdir')).toBeUndefined();
  });
});

describe('addTest', () => {
  it('inserts in sort order among existing sections', () => {
    const text = lines('[DEFAULT]', 'head = "head.js"', '', '["test_a.js"]', '', '["test_z.js"]');
    expect(addTest(MANIFEST, text, 'test_m.js').text).toBe(
      lines(
        '[DEFAULT]',
        'head = "head.js"',
        '',
        '["test_a.js"]',
        '',
        '["test_m.js"]',
        '',
        '["test_z.js"]'
      )
    );
  });

  it('follows byte order when the manifest is sorted that way', () => {
    const text = lines('["test_Alpha.js"]', '', '["test_beta.js"]');
    expect(addTest(MANIFEST, text, 'test_Zulu.js').line).toBe(2);
  });

  it('appends when the new section sorts last, or when there are no tests yet', () => {
    expect(addTest(MANIFEST, '[DEFAULT]\n', 'test_x.js').text).toBe(
      lines('[DEFAULT]', '', '["test_x.js"]')
    );
    expect(addTest(MANIFEST, lines('[DEFAULT]', '', '["test_a.js"]'), 'test_b.js').text).toBe(
      lines('[DEFAULT]', '', '["test_a.js"]', '', '["test_b.js"]')
    );
    expect(addTest(MANIFEST, '', 'test_x.js').text).toBe('["test_x.js"]\n');
  });

  it('trims trailing blank lines when appending', () => {
    expect(addTest(MANIFEST, '["test_a.js"]\n\n\n', 'test_b.js').text).toBe(
      lines('["test_a.js"]', '', '["test_b.js"]')
    );
  });

  describe('with comments and keys', () => {
    const text = lines(
      '[DEFAULT]',
      '',
      '["test_HomesteadStore.js"]',
      'skip-if = ["os == \'win\'"]',
      '',
      '# Exercises the harness itself.',
      '# Keep it last.',
      '["test_HomesteadStoreTestHarness.js"]'
    );

    it('goes ahead of the comments that introduce the next section', () => {
      expect(addTest(MANIFEST, text, 'test_HomesteadStoreQuota.js').text).toBe(
        lines(
          '[DEFAULT]',
          '',
          '["test_HomesteadStore.js"]',
          'skip-if = ["os == \'win\'"]',
          '',
          '["test_HomesteadStoreQuota.js"]',
          '',
          '# Exercises the harness itself.',
          '# Keep it last.',
          '["test_HomesteadStoreTestHarness.js"]'
        )
      );
    });

    it('--after places the section after the whole block of the named one', () => {
      const placed = addTest(MANIFEST, text, 'test_HomesteadAAA.js', {
        after: 'test_HomesteadStore.js',
      });
      expect(placed.previous).toBe('["test_HomesteadStore.js"]');
      expect(placed.afterFallback).toBeUndefined();
      const rows = placed.text.split('\n');
      expect(rows.indexOf('["test_HomesteadAAA.js"]')).toBe(5);
      expect(rows.indexOf('# Exercises the harness itself.')).toBe(7);
      const last = addTest(MANIFEST, text, 'test_HomesteadAAA.js', {
        after: 'test_HomesteadStoreTestHarness.js',
      });
      expect(last.text.endsWith('["test_HomesteadAAA.js"]\n')).toBe(true);
    });

    it('--after naming nothing falls back to sort order and says so', () => {
      const placed = addTest(MANIFEST, text, 'test_A.js', { after: 'test_missing.js' });
      expect(placed.afterFallback).toBe(true);
      expect(placed.text.indexOf('test_A.js')).toBeLessThan(
        placed.text.indexOf('test_HomesteadStore.js')
      );
    });
  });

  it('writes keys, and the INI spelling for .ini', () => {
    expect(
      addTest(MANIFEST, '', 'test_x.js', { keys: { 'skip-if': ['os == "win"'], head: 'head.js' } })
        .text
    ).toBe(lines('["test_x.js"]', 'skip-if = ["os == "win""]', 'head = "head.js"'));
    expect(
      addTest('dom/mochitest.ini', '[DEFAULT]\n', 'test_x.html', {
        keys: { 'support-files': ['a', 'b'] },
      }).text
    ).toBe(lines('[DEFAULT]', '', '[test_x.html]', 'support-files = a b'));
  });

  it('changes nothing for a test that is already listed', () => {
    const text = lines('["test_a.js"]');
    expect(addTest(MANIFEST, text, 'test_a.js')).toEqual({ text, changed: false, line: 0 });
  });

  it('keeps CRLF endings', () => {
    expect(addTest(MANIFEST, '["a.js"]\r\n', 'b.js').text).toBe('["a.js"]\r\n\r\n["b.js"]\r\n');
  });
});

describe('removeTest', () => {
  const text = lines(
    '[DEFAULT]',
    '',
    '# first',
    '["test_a.js"]',
    'skip-if = ["x"]',
    '',
    '["test_b.js"]',
    '',
    '["test_c.js"]',
    'tags = "y"'
  );

  it('removes the header, keys, leading comment and separating blanks', () => {
    expect(removeTest(MANIFEST, text, 'test_a.js').text).toBe(
      lines('[DEFAULT]', '', '["test_b.js"]', '', '["test_c.js"]', 'tags = "y"')
    );
  });

  it('removes the last section with the blank line before it', () => {
    expect(removeTest(MANIFEST, text, 'test_c.js').text).toBe(
      lines('[DEFAULT]', '', '# first', '["test_a.js"]', 'skip-if = ["x"]', '', '["test_b.js"]')
    );
  });

  it('is a no-op for a test that is not listed', () => {
    expect(removeTest(MANIFEST, text, 'test_zzz.js')).toEqual({ text, changed: false });
  });
});

describe('newTestManifest', () => {
  it('writes a DEFAULT section and the test, in the format the name picks', () => {
    expect(newTestManifest(MANIFEST, 'test_a.js')).toBe('[DEFAULT]\n\n["test_a.js"]\n');
    expect(newTestManifest('a/xpcshell.ini', 'test_a.js')).toBe('[DEFAULT]\n\n[test_a.js]\n');
    expect(
      newTestManifest(MANIFEST, 'browser_a.js', {
        header: '# SPDX-License-Identifier: 0BSD',
        defaults: { 'support-files': ['head.js'] },
      })
    ).toBe(
      '# SPDX-License-Identifier: 0BSD\n\n[DEFAULT]\nsupport-files = ["head.js"]\n\n["browser_a.js"]\n'
    );
    expect(listTests(MANIFEST, newTestManifest(MANIFEST, 'test_a.js'))).toEqual([
      'browser/modules/test/unit/test_a.js',
    ]);
  });
});
