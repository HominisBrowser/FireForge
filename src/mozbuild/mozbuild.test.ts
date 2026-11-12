// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  addToMozBuildList,
  findMozBuildLists,
  mozBuildReferences,
  mozBuildSortViolations,
  mozBuildTestManifests,
  parseMozBuild,
  removeFromMozBuildList,
} from './mozbuild.js';

/** Whether a list of `variable` the selector allows holds `value`. */
const contains = (
  text: string,
  variable: string,
  value: string,
  selector: Parameters<typeof findMozBuildLists>[2] = {}
): boolean =>
  findMozBuildLists(text, variable, selector).some((list) =>
    list.items.some((item) => item.value === value)
  );

const lines = (...rows: string[]): string => rows.join('\n') + '\n';

describe('parseMozBuild', () => {
  it('reads the variable, operator and items of each list', () => {
    const { lists } = parseMozBuild(
      lines(
        'EXTRA_JS_MODULES += [',
        '    "Foo.sys.mjs",',
        "    'Bar.sys.mjs',  # trailing",
        ']',
        'EXTRA_JS_MODULES.sessionstore = ["a.mjs"]',
        'FOO["x"] += []'
      )
    );
    expect(lists.map((l) => [l.variable, l.name, l.operator, l.startLine, l.endLine])).toEqual([
      ['EXTRA_JS_MODULES', 'EXTRA_JS_MODULES', '+=', 0, 3],
      ['EXTRA_JS_MODULES.sessionstore', 'EXTRA_JS_MODULES', '=', 4, 4],
      ['FOO["x"]', 'FOO', '+=', 5, 5],
    ]);
    expect(lists[0]?.items.map((i) => [i.value, i.quote, i.ownLine])).toEqual([
      ['Foo.sys.mjs', '"', true],
      ['Bar.sys.mjs', "'", true],
    ]);
    expect(lists[1]?.items[0]?.ownLine).toBe(false);
  });

  it('marks lists inside if, elif and else, and every indented list, conditional', () => {
    const { lists } = parseMozBuild(
      lines(
        'A += ["a"]',
        'if CONFIG["X"]:',
        '    B += ["b"]',
        'elif CONFIG["Y"]:',
        '    C += ["c"]',
        'else:',
        '    D += ["d"]',
        'with Files("**"):',
        '    E += ["e"]',
        'F += ["f"]'
      )
    );
    expect(lists.map((l) => [l.name, l.conditional])).toEqual([
      ['A', false],
      ['B', true],
      ['C', true],
      ['D', true],
      ['E', true],
      ['F', false],
    ]);
  });

  it('reads a block header whose condition spans several lines', () => {
    const text = lines(
      'if (',
      '    CONFIG["NIGHTLY_BUILD"]',
      '    and not CONFIG["MOZ_DEBUG"]',
      '):',
      '    EXTRA_JS_MODULES += [',
      '        "BHRTelemetryService.sys.mjs",',
      '    ]',
      '',
      'XPIDL_SOURCES += [',
      '    "nsIHangDetails.idl",',
      ']'
    );
    expect(parseMozBuild(text).lists.map((l) => [l.name, l.conditional])).toEqual([
      ['EXTRA_JS_MODULES', true],
      ['XPIDL_SOURCES', false],
    ]);
    expect(() => addToMozBuildList(text, 'EXTRA_JS_MODULES', 'New.sys.mjs')).toThrow(
      /No list assigned to EXTRA_JS_MODULES/
    );
  });

  it('does not read brackets or quotes inside comments and strings as structure', () => {
    const { lists } = parseMozBuild(
      lines(
        'EXTRA_JS_MODULES += [',
        '    "icons[2x].png",  # see foo[0] and "Beta.sys.mjs"',
        '    "don\'t.js",',
        '    "has#hash.js",',
        ']'
      )
    );
    expect(lists[0]?.items.map((i) => i.value)).toEqual([
      'icons[2x].png',
      "don't.js",
      'has#hash.js',
    ]);
  });

  it('skips an unterminated list without hiding the lists after it', () => {
    const text = lines(
      'EXTRA_COMPONENTS += [',
      '    "Broken.js",',
      '',
      'EXTRA_JS_MODULES += [',
      '    "Alpha.sys.mjs",',
      ']'
    );
    const { lists } = parseMozBuild(text);
    expect(lists.map((l) => [l.variable, l.items.map((i) => i.value)])).toEqual([
      ['EXTRA_JS_MODULES', ['Alpha.sys.mjs']],
    ]);
  });

  it('reads a list whose first items share the opening line', () => {
    const { lists } = parseMozBuild('EXTRA_JS_MODULES += ["B.sys.mjs",\n    "A.sys.mjs",\n]\n');
    expect(lists[0]?.items.map((i) => [i.value, i.ownLine])).toEqual([
      ['B.sys.mjs', false],
      ['A.sys.mjs', true],
    ]);
  });
});

describe('queries', () => {
  const text = lines(
    '# EXTRA_JS_MODULES += [',
    '# "File.sys.mjs",',
    '# ]',
    'OTHER += [',
    ' "File.sys.mjs",',
    ']',
    'EXTRA_JS_MODULES += [',
    ' "File.sys.mjs.extra",',
    " 'Real.sys.mjs',",
    ']',
    'if CONFIG["WIN"]:',
    '    EXTRA_JS_MODULES += [',
    '        "Windows.sys.mjs",',
    '    ]'
  );

  it('matches only active values in the requested list, with either quote style', () => {
    expect(contains(text, 'EXTRA_JS_MODULES', 'File.sys.mjs')).toBe(false);
    expect(contains(text, 'EXTRA_JS_MODULES', 'Real.sys.mjs')).toBe(true);
  });

  it('leaves conditional lists out unless asked', () => {
    expect(contains(text, 'EXTRA_JS_MODULES', 'Windows.sys.mjs')).toBe(false);
    expect(contains(text, 'EXTRA_JS_MODULES', 'Windows.sys.mjs', { conditional: true })).toBe(true);
  });

  it('keeps a namespaced variable distinct from the bare one', () => {
    const ns = 'EXTRA_JS_MODULES.ns += [\n "A.sys.mjs",\n]\n';
    expect(contains(ns, 'EXTRA_JS_MODULES', 'A.sys.mjs')).toBe(false);
    expect(contains(ns, 'EXTRA_JS_MODULES.ns', 'A.sys.mjs')).toBe(true);
    expect(findMozBuildLists(ns, 'EXTRA_JS_MODULES.ns')).toHaveLength(1);
  });

  it('finds a real entry in a later or inline list', () => {
    const css =
      'OTHER += ["Owned.sys.mjs"]\nEXTRA_JS_MODULES += []\nEXTRA_JS_MODULES += ["Real.sys.mjs"] # retained\n';
    expect(contains(css, 'EXTRA_JS_MODULES', 'Real.sys.mjs')).toBe(true);
    expect(contains(css, 'EXTRA_JS_MODULES', 'Owned.sys.mjs')).toBe(false);
  });
});

describe('addToMozBuildList', () => {
  it('inserts case-insensitively, as mozbuild orders', () => {
    const text = lines('EXTRA_JS_MODULES += [', '    "HomesteadAppMenuIntegration.sys.mjs",', ']');
    const placed = addToMozBuildList(
      text,
      'EXTRA_JS_MODULES',
      'HomesteadAppearanceController.sys.mjs'
    );
    expect(placed.text).toBe(
      lines(
        'EXTRA_JS_MODULES += [',
        '    "HomesteadAppearanceController.sys.mjs",',
        '    "HomesteadAppMenuIntegration.sys.mjs",',
        ']'
      )
    );
    expect(placed.line).toBe(1);
  });

  it('reports the entry it follows and copies indentation and quotes', () => {
    const text = lines(
      'if X:',
      '    EXTRA_JS_MODULES += [',
      "        'A.sys.mjs',",
      "        'C.sys.mjs',",
      '    ]'
    );
    const placed = addToMozBuildList(text, 'EXTRA_JS_MODULES', 'B.sys.mjs', { conditional: true });
    expect(placed.text.split('\n')[3]).toBe("        'B.sys.mjs',");
    expect(placed.previous).toBe("'A.sys.mjs',");
  });

  it('appends when the list is not sorted', () => {
    const text = lines('DIRS += [', '    "zebra",', '    "alpha",', ']');
    expect(addToMozBuildList(text, 'DIRS', 'mid').text).toBe(
      lines('DIRS += [', '    "zebra",', '    "alpha",', '    "mid",', ']')
    );
  });

  it('adds the missing comma after a last item that lacks one', () => {
    const text = lines('DIRS += [', '    "a",', '    "b"', ']');
    expect(addToMozBuildList(text, 'DIRS', 'c').text).toBe(
      lines('DIRS += [', '    "a",', '    "b",', '    "c",', ']')
    );
  });

  it('expands a one-line list into the multi-line shape', () => {
    expect(
      addToMozBuildList('EXTRA_JS_MODULES += []\n', 'EXTRA_JS_MODULES', 'First.sys.mjs').text
    ).toBe(lines('EXTRA_JS_MODULES += [', '    "First.sys.mjs",', ']'));
    expect(addToMozBuildList('X += ["b.js", "d.js"] # note\n', 'X', 'c.js').text).toBe(
      lines('X += [', '    "b.js",', '    "c.js",', '    "d.js",', '] # note')
    );
    expect(
      addToMozBuildList('  FOO["k"] += ["a"]\n', 'FOO["k"]', 'b', { conditional: true }).text
    ).toBe(lines('  FOO["k"] += [', '      "a",', '      "b",', '  ]'));
  });

  it('fills an empty multi-line list', () => {
    expect(addToMozBuildList('X += [\n]\n', 'X', 'a').text).toBe('X += [\n    "a",\n]\n');
  });

  it('keeps a comment attached to the item below it', () => {
    const text = lines('X += [', '    "a",', '    # explains c', '    "c",', ']');
    expect(addToMozBuildList(text, 'X', 'b').text).toBe(
      lines('X += [', '    "a",', '    "b",', '    # explains c', '    "c",', ']')
    );
  });

  it('changes nothing for an item already present', () => {
    const text = lines('X += [', '    "a",', ']');
    expect(addToMozBuildList(text, 'X', 'a')).toEqual({ text, changed: false, line: 1 });
  });

  it('refuses a missing list unless asked to create it', () => {
    expect(() => addToMozBuildList('Y += ["a"]\n', 'X', 'a')).toThrow(/No list assigned to X/);
    expect(addToMozBuildList('Y += ["a"]\n', 'X', 'a', { create: true }).text).toBe(
      lines('Y += ["a"]', '', 'X += [', '    "a",', ']')
    );
    expect(addToMozBuildList('', 'X', 'a', { create: true }).text).toBe(
      lines('X += [', '    "a",', ']')
    );
  });

  it('refuses two candidate lists and takes the line option to choose', () => {
    const text = lines('X += []', 'X += ["b"]');
    expect(() => addToMozBuildList(text, 'X', 'a')).toThrow(/several places/);
    expect(addToMozBuildList(text, 'X', 'a', { line: 1 }).text).toContain('"a"');
  });

  it('chooses the unconditional list when a conditional one exists too', () => {
    const text = lines('X += [', '    "a",', ']', 'if Y:', '    X += [', '        "z",', '    ]');
    expect(addToMozBuildList(text, 'X', 'b').text.split('\n').slice(0, 4)).toEqual([
      'X += [',
      '    "a",',
      '    "b",',
      ']',
    ]);
  });

  it('keeps CRLF line endings', () => {
    const text = 'X += [\r\n    "a",\r\n]\r\n';
    expect(addToMozBuildList(text, 'X', 'b').text).toBe('X += [\r\n    "a",\r\n    "b",\r\n]\r\n');
  });
});

describe('removeFromMozBuildList', () => {
  const text = lines('X += [', '    "a",', '    "b",', '    "c",', ']', 'Y += ["p", "q", "r"]');

  it('removes an item that is alone on its line along with the line', () => {
    expect(removeFromMozBuildList(text, 'X', 'b').text).toBe(
      lines('X += [', '    "a",', '    "c",', ']', 'Y += ["p", "q", "r"]')
    );
  });

  it('removes an item sharing its line with a neighbouring comma', () => {
    expect(removeFromMozBuildList(text, 'Y', 'q').text).toContain('Y += ["p", "r"]');
    expect(removeFromMozBuildList(text, 'Y', 'r').text).toContain('Y += ["p", "q"]');
    expect(removeFromMozBuildList(text, 'Y', 'p').text).toContain('Y += ["q", "r"]');
  });

  it('is a no-op for an absent item', () => {
    expect(removeFromMozBuildList(text, 'X', 'zzz')).toEqual({ text, changed: false });
  });
});

describe('mozBuildReferences', () => {
  it('resolves list items against the moz.build directory and ignores other strings', () => {
    const refs = mozBuildReferences(
      'browser/base/moz.build',
      lines(
        'with Files("content/docs/**"):',
        '    BUG_COMPONENT = ("Firefox", "General")',
        'BROWSER_CHROME_MANIFESTS += [',
        '    "content/test/about/browser.toml",',
        '    "/toolkit/x.toml",',
        '    "!generated.h",',
        '    "plain",',
        ']'
      )
    );
    expect(refs.map((ref) => [ref.token, ref.matcher.exact, ref.line])).toEqual([
      ['content/test/about/browser.toml', 'browser/base/content/test/about/browser.toml', 3],
      ['/toolkit/x.toml', 'toolkit/x.toml', 4],
    ]);
  });
});

describe('mozBuildTestManifests', () => {
  it('lists the manifests of the test variables with their flavour, conditional ones included', () => {
    const text = lines(
      'BROWSER_CHROME_MANIFESTS += ["tests/browser-srd.toml", "eval.toml"]',
      'if CONFIG["OS_ARCH"] == "Linux":',
      '    XPCSHELL_TESTS_MANIFESTS += ["unit/xpcshell-remote.toml"]',
      'PYTHON_UNITTEST_MANIFESTS += ["python.toml"]',
      'JAR_MANIFESTS += ["jar.mn"]'
    );
    expect(mozBuildTestManifests('browser/components/x/moz.build', text)).toEqual([
      {
        path: 'browser/components/x/tests/browser-srd.toml',
        flavor: 'browser-chrome',
        variable: 'BROWSER_CHROME_MANIFESTS',
        value: 'tests/browser-srd.toml',
      },
      {
        path: 'browser/components/x/eval.toml',
        flavor: 'browser-chrome',
        variable: 'BROWSER_CHROME_MANIFESTS',
        value: 'eval.toml',
      },
      {
        path: 'browser/components/x/unit/xpcshell-remote.toml',
        flavor: 'xpcshell',
        variable: 'XPCSHELL_TESTS_MANIFESTS',
        value: 'unit/xpcshell-remote.toml',
      },
    ]);
  });
});

describe('mozBuildSortViolations', () => {
  const violations = (...rows: string[]): { variable: string; expected: string; got: string }[] =>
    mozBuildSortViolations(lines(...rows)).map(({ variable, expected, got }) => ({
      variable,
      expected,
      got,
    }));

  it('passes a sorted list and compares case-insensitively', () => {
    expect(violations('EXTRA_JS_MODULES += [', '"Aa.mjs",', '"aB.mjs",', '"b.mjs",', ']')).toEqual(
      []
    );
  });

  it('reports the first expected and got pair', () => {
    expect(violations('EXTRA_JS_MODULES += [', '"B.mjs",', '"A.mjs",', ']')).toEqual([
      { variable: 'EXTRA_JS_MODULES', expected: 'A.mjs', got: 'B.mjs' },
    ]);
  });

  it('names the full dotted variable and checks each list on its own', () => {
    expect(
      violations(
        'EXTRA_JS_MODULES.ns += [',
        '"b",',
        '"a",',
        ']',
        'EXPORTS += [',
        '"c",',
        '"d",',
        ']',
        'TESTING_JS_MODULES += ["B.sys.mjs", "A.sys.mjs"]'
      ).map((v) => v.variable)
    ).toEqual(['EXTRA_JS_MODULES.ns', 'TESTING_JS_MODULES']);
  });

  it('does not flag DIRS', () => {
    expect(violations('DIRS += [', '"zebra",', '"alpha",', ']')).toEqual([]);
  });

  it('ignores a quoted string in a trailing comment and a bracket in a comment', () => {
    expect(
      violations(
        'EXTRA_JS_MODULES += [',
        '"Zeta.cpp",  # replaces "Beta.cpp" see foo[0]',
        '"Zulu.cpp",',
        ']'
      )
    ).toEqual([]);
  });

  it('checks the second list when the first never closes', () => {
    expect(
      violations(
        'EXTRA_COMPONENTS += [',
        '"Broken.js",',
        '',
        'EXTRA_JS_MODULES += [',
        '"Zeta",',
        '"Alpha",',
        ']'
      )
    ).toEqual([{ variable: 'EXTRA_JS_MODULES', expected: 'Alpha', got: 'Zeta' }]);
  });
});
