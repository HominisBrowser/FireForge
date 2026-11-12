// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { machErrorHints } from './machHints.js';

const lines = (...text: string[]): string => text.join('\n');

describe('machErrorHints', () => {
  it('returns nothing for empty or unrecognised output', () => {
    expect(machErrorHints('')).toEqual([]);
    expect(machErrorHints('some unrelated build output')).toEqual([]);
  });

  it('names JS_PREFERENCE_FILES for a preprocessed pref file without directives, once', () => {
    const hints = machErrorHints(
      lines(
        "mozbuild.preprocessor.Preprocessor.Error: ('a.js', None, 'no preprocessor directives found', None)",
        "mozbuild.preprocessor.Preprocessor.Error: ('b.js', None, 'no preprocessor directives found', None)"
      )
    );
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('JS_PREFERENCE_PP_FILES');
    expect(hints[0]).toContain('JS_PREFERENCE_FILES instead');
  });

  it('explains a packager NoneType.open in either traceback order', () => {
    const forward = machErrorHints(
      lines(
        'Traceback (most recent call last):',
        '  File "/engine/python/mozbuild/mozpack/packager.py", line 241, in package_fastload',
        '    zip = self.target.open(path, "wb")',
        "AttributeError: 'NoneType' object has no attribute 'open'"
      )
    );
    expect(forward[0]).toMatch(/NoneType\.open.*packager\.py/);
    expect(forward[0]).toContain('fireforge build');
    const reversed = machErrorHints(
      lines(
        "AttributeError: 'NoneType' object has no attribute 'open'",
        'File "/engine/python/mozbuild/mozpack/packager.py", line 299, in sink'
      )
    );
    expect(reversed[0]).toMatch(/NoneType\.open/);
  });

  it('stays quiet on an unrelated AttributeError', () => {
    expect(
      machErrorHints(
        lines(
          'Traceback (most recent call last):',
          '  File "/engine/python/mozbuild/mozbuild/config.py", line 42, in load',
          "AttributeError: 'NoneType' object has no attribute 'keys'"
        )
      )
    ).toEqual([]);
  });

  it('explains the gecko-profiler bindgen alias failure in either order', () => {
    const compilerFirst = machErrorHints(
      lines(
        'error[E0425]: cannot find type `_CharT` in this scope',
        ' --> /work/obj/release/build/gecko-profiler-abc123/out/gecko/bindings.rs:1877:67',
        '1877 |     pub type basic_string___self_view = root::std::__1::basic_string_view<_CharT>;'
      )
    ).join('\n');
    expect(compilerFirst).toContain('gecko-profiler');
    expect(compilerFirst).toContain('basic_string___self_view');
    const pathFirst = machErrorHints(
      lines(
        '   Compiling gecko-profiler-abc123 v0.1.0 (/engine/.../gecko-profiler-abc123)',
        'error[E0425]: cannot find type `_CharT` in this scope'
      )
    );
    expect(pathFirst.some((hint) => hint.includes('gecko-profiler'))).toBe(true);
  });

  it('stays quiet on an unrelated "cannot find type" error', () => {
    const hints = machErrorHints(
      lines('error[E0425]: cannot find type `MyStruct` in this scope', ' --> src/lib.rs:42:7')
    );
    expect(hints.some((hint) => hint.includes('gecko-profiler'))).toBe(false);
  });

  it('marks the configure summary after a failed build as not a success', () => {
    const hints = machErrorHints(
      lines(
        ' 2:22.36 W 87 compiler warnings present.',
        ' Config object not found by mach.',
        'Configure complete!',
        'Be sure to run |mach build| to pick up any changes'
      )
    );
    expect(hints.some((hint) => hint.includes('post-failure configure summary'))).toBe(true);
    // A plain successful configure prints the banner without the precursor.
    expect(
      machErrorHints('Configure complete!\nBe sure to run |mach build| to pick up any changes')
    ).toEqual([]);
  });

  it('names "fireforge bootstrap" for a tool below the declared minimum', () => {
    const cbindgen = machErrorHints(
      lines(
        'ERROR: cbindgen version 0.29.1 is too old. At least version 0.29.4 is required.',
        '',
        "Please update using 'cargo install cbindgen --force' or running",
        "'./mach bootstrap', after removing the existing executable located at",
        '/Users/you/.cargo/bin/cbindgen.'
      )
    ).join('\n');
    expect(cbindgen).toContain('"fireforge bootstrap"');
    expect(cbindgen).toContain('./mach bootstrap');
    for (const output of [
      lines(
        'ERROR: Rust compiler 1.80.0 is too old.',
        '',
        'To compile Rust language sources please install at least',
        "version 1.82.0 of the 'rustc' toolchain"
      ),
      'ERROR: Cargo package manager 1.80.0 is too old.',
    ]) {
      expect(machErrorHints(output).join('\n')).toContain('"fireforge bootstrap"');
    }
  });

  it('stays quiet on other "too old" phrasing', () => {
    const hints = machErrorHints(
      'WARNING: the build telemetry cache is too old and will be regenerated.'
    );
    expect(hints.some((hint) => hint.includes('fireforge bootstrap'))).toBe(false);
  });

  it('gives the case-insensitive rule for a mozbuild UnsortedError', () => {
    const joined = machErrorHints(
      lines(
        'Traceback (most recent call last):',
        '  File "browser/modules/example/moz.build", line 12, in <module>',
        'mozbuild.util.UnsortedError: An attempt was made to add an unsorted sequence to a list.',
        "We expected 'EditorFilePaths.sys.mjs' but got 'EditorFiles.sys.mjs'"
      )
    ).join('\n');
    expect(joined).toContain('CASE-INSENSITIVELY');
    expect(joined).toContain('fireforge lint');
    expect(machErrorHints('mozbuild.util.ReadOnlyDict: cannot mutate').join('\n')).not.toContain(
      'CASE-INSENSITIVELY'
    );
  });
});
