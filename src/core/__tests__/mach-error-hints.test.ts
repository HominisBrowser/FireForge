// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { explainMachError, MACH_ERROR_HINTS } from '../mach-error-hints.js';

describe('explainMachError', () => {
  it('returns an empty array for empty or unknown stderr', () => {
    expect(explainMachError('')).toEqual([]);
    expect(explainMachError('some unrelated build output')).toEqual([]);
  });

  it('surfaces the preprocessor hint for the JS_PREFERENCE_PP_FILES trap', () => {
    const stderr = [
      'mozbuild.preprocessor.Preprocessor.Error: (',
      "'mybrowser.js', None, 'no preprocessor directives found', None",
      ')',
    ].join('\n');
    const hints = explainMachError(stderr);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('JS_PREFERENCE_PP_FILES');
    expect(hints[0]).toContain('JS_PREFERENCE_FILES instead');
  });

  it('deduplicates hints when the same pattern matches multiple times', () => {
    const stderr = [
      "mozbuild.preprocessor.Preprocessor.Error: ('a.js', None, 'no preprocessor directives found', None)",
      "mozbuild.preprocessor.Preprocessor.Error: ('b.js', None, 'no preprocessor directives found', None)",
    ].join('\n');
    const hints = explainMachError(stderr);
    expect(hints).toHaveLength(1);
  });

  it('exposes its pattern table for inspection', () => {
    expect(MACH_ERROR_HINTS.length).toBeGreaterThan(0);
    for (const entry of MACH_ERROR_HINTS) {
      expect(entry.pattern).toBeInstanceOf(RegExp);
      expect(typeof entry.hint).toBe('string');
      expect(entry.hint.length).toBeGreaterThan(20);
    }
  });

  it('surfaces the packager NoneType hint when packager.py trips on None.open', () => {
    // Finding #12: `mach package` dereferences a None sink inside
    // packager.py when the obj-*/dist/ tree is incomplete. The hint
    // explicitly points at running a full `fireforge build` before
    // `fireforge package`, which is the real-world recovery path.
    const stderr = [
      'Traceback (most recent call last):',
      '  File "/engine/python/mozbuild/mozpack/packager.py", line 241, in package_fastload',
      '    zip = self.target.open(path, "wb")',
      "AttributeError: 'NoneType' object has no attribute 'open'",
    ].join('\n');

    const hints = explainMachError(stderr);
    expect(hints.length).toBeGreaterThanOrEqual(1);
    expect(hints[0]).toMatch(/NoneType\.open.*packager\.py/);
    expect(hints[0]).toContain('fireforge build');
  });

  it('matches the NoneType hint even when the traceback order is reversed', () => {
    // Some mach runs surface the `AttributeError` line before the
    // traceback frame that names packager.py. The regex needs to cope
    // with both orderings so the hint fires regardless.
    const stderr = [
      "AttributeError: 'NoneType' object has no attribute 'open'",
      'File "/engine/python/mozbuild/mozpack/packager.py", line 299, in sink',
    ].join('\n');

    const hints = explainMachError(stderr);
    expect(hints.length).toBeGreaterThanOrEqual(1);
    expect(hints[0]).toMatch(/NoneType\.open/);
  });

  it('does NOT fire the NoneType hint on unrelated AttributeErrors', () => {
    // Keep the pattern narrow so unrelated NoneType errors elsewhere in
    // mach (e.g. a preprocessor pass) don't train operators to ignore
    // the hint. Maintaining this negative case also pins the branch
    // count for the 100/95/100 coverage threshold.
    const stderr = [
      'Traceback (most recent call last):',
      '  File "/engine/python/mozbuild/mozbuild/config.py", line 42, in load',
      "AttributeError: 'NoneType' object has no attribute 'keys'",
    ].join('\n');

    const hints = explainMachError(stderr);
    expect(hints).toEqual([]);
  });

  it('surfaces the gecko-profiler bindgen hint on the _CharT alias compile error', () => {
    // Finding #12: upstream bindgen emits
    // `pub type basic_string___self_view = …<_CharT>;` into gecko-profiler's
    // generated bindings.rs against some macOS libc++ SDKs, and the Rust
    // compile fails with "cannot find type `_CharT` in this scope". The
    // hint points operators at the 990-infra-bindgen workaround
    // patch + the file-level recovery.
    const stderr = [
      'error[E0425]: cannot find type `_CharT` in this scope',
      ' --> /Users/you/workspace/obj-debug/release/build/gecko-profiler-abc123/out/gecko/bindings.rs:1877:67',
      '  |',
      '1877 |     pub type basic_string___self_view = root::std::__1::basic_string_view<_CharT>;',
      'error: aborting due to previous error',
    ].join('\n');

    const hints = explainMachError(stderr);
    expect(hints.length).toBeGreaterThanOrEqual(1);
    expect(hints.join('\n')).toContain('gecko-profiler');
    expect(hints.join('\n')).toContain('basic_string___self_view');
    expect(hints.join('\n')).toContain('990-infra-bindgen-basic-string-workaround');
  });

  it('matches the bindgen hint when the gecko-profiler build-output path appears before the _CharT line', () => {
    // Real-world ordering: cargo prints the obj-build path (e.g.
    // `gecko-profiler-abc123/build-script-build`) before the compiler
    // diagnostics. The pattern has an alternation that accepts either
    // ordering so the hint surfaces regardless.
    const stderr = [
      '   Compiling gecko-profiler-abc123 v0.1.0 (/engine/.../gecko-profiler-abc123)',
      'error[E0425]: cannot find type `_CharT` in this scope',
    ].join('\n');

    const hints = explainMachError(stderr);
    expect(hints.some((hint) => hint.includes('gecko-profiler'))).toBe(true);
  });

  it('does NOT fire the bindgen hint on unrelated "cannot find type" errors', () => {
    const stderr = [
      'error[E0425]: cannot find type `MyStruct` in this scope',
      ' --> src/lib.rs:42:7',
    ].join('\n');

    const hints = explainMachError(stderr);
    expect(hints.some((hint) => hint.includes('gecko-profiler'))).toBe(false);
  });

  it('surfaces the post-failure "Configure complete!" clarification hint', () => {
    // Finding #6: after `mach build` fails, mach's own shutdown pipeline
    // runs a configure summary that prints the three-line
    // "Config object not found by mach. / Configure complete! / Be sure
    // to run |mach build|..." block. Operators were double-checking
    // whether the build had actually failed. The hint clarifies that
    // the trailing block is cosmetic post-failure output.
    const output = [
      ' 2:22.36 W 87 compiler warnings present.',
      ' Config object not found by mach.',
      'Configure complete!',
      'Be sure to run |mach build| to pick up any changes',
    ].join('\n');

    const hints = explainMachError(output);
    expect(hints.some((hint) => hint.includes('post-failure configure summary'))).toBe(true);
  });

  it('does NOT fire the epilogue hint on a standalone "Configure complete!" without the mach-not-found precursor', () => {
    // A vanilla `mach configure` run legitimately prints "Configure
    // complete!" on success. The pattern only matches when it follows
    // "Config object not found by mach.", which is the distinctive
    // post-failure signature.
    const output = 'Configure complete!\nBe sure to run |mach build| to pick up any changes';

    const hints = explainMachError(output);
    expect(hints.some((hint) => hint.includes('post-failure configure summary'))).toBe(false);
  });

  it('surfaces the fireforge bootstrap hint on the cbindgen too-old configure failure', () => {
    // 152.0b7 → 153.0b8 source-refresh drill: the first post-hop build
    // died ~8s into `mach configure` with this exact die() text, whose
    // own remediation names "./mach bootstrap" — the wrong entry point
    // for a FireForge-managed repo. The hint must name
    // `fireforge bootstrap` instead.
    const stderr = [
      'ERROR: cbindgen version 0.29.1 is too old. At least version 0.29.4 is required.',
      '',
      "Please update using 'cargo install cbindgen --force' or running",
      "'./mach bootstrap', after removing the existing executable located at",
      '/Users/you/.cargo/bin/cbindgen.',
    ].join('\n');

    const hints = explainMachError(stderr);
    expect(hints.length).toBeGreaterThanOrEqual(1);
    expect(hints.join('\n')).toContain('"fireforge bootstrap"');
    expect(hints.join('\n')).toContain('./mach bootstrap');
  });

  it('surfaces the fireforge bootstrap hint on the Rust compiler / Cargo too-old failures', () => {
    // rust.configure's die() shapes name the minimum only further down
    // the message, so the pattern keys on the first line.
    const rustStderr = [
      'ERROR: Rust compiler 1.80.0 is too old.',
      '',
      'To compile Rust language sources please install at least',
      "version 1.82.0 of the 'rustc' toolchain (or, if using nightly,",
      'at least one version newer than 1.82.0) and make sure it is',
      'first in your path.',
    ].join('\n');
    const cargoStderr = 'ERROR: Cargo package manager 1.80.0 is too old.';

    for (const stderr of [rustStderr, cargoStderr]) {
      const hints = explainMachError(stderr);
      expect(hints.length).toBeGreaterThanOrEqual(1);
      expect(hints.join('\n')).toContain('"fireforge bootstrap"');
    }
  });

  it('does NOT fire the toolchain hints on unrelated "too old" phrasing', () => {
    // "is too old" appears in other mach output (e.g. clock-skew or
    // cache-staleness warnings). Without the "At least version … is
    // required" tail or the Rust/Cargo lead-in, the hints must stay
    // quiet so operators keep trusting the translator.
    const stderr = 'WARNING: the build telemetry cache is too old and will be regenerated.';

    const hints = explainMachError(stderr);
    expect(hints.some((hint) => hint.includes('fireforge bootstrap'))).toBe(false);
  });
});
