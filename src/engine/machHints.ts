// SPDX-License-Identifier: EUPL-1.2
/**
 * Remedies for the mach and mozbuild failures whose own message does not say
 * what to change. The list is deliberately short: a hint is added only for a
 * failure whose cause is established, because a low-confidence hint teaches
 * the operator to ignore all of them.
 */

interface MachHint {
  /** Matched against everything mach wrote. */
  pattern: RegExp;
  /** What to do, in one paragraph. */
  hint: string;
}

const HINTS: readonly MachHint[] = [
  {
    pattern: /mozbuild\.preprocessor\.Preprocessor\.Error[\s\S]*?no preprocessor directives found/,
    hint:
      'A file registered under JS_PREFERENCE_PP_FILES contains no preprocessor directives. ' +
      'Use JS_PREFERENCE_FILES instead, or add at least one #filter / #expand directive to the file.',
  },
  {
    // mozbuild sorts StrictOrderingOnAppendList entries by `.lower()`, so an
    // entry placed correctly by byte order can still be rejected. Its own
    // message names the file and both entries; the hint supplies the rule.
    pattern: /\bUnsortedError\b/,
    hint:
      'A moz.build list is out of order: mozbuild rejects the file while reading it, so ' +
      'configure dies before any compile. Entries are compared CASE-INSENSITIVELY (mozbuild ' +
      'lowercases before comparing), so uppercase does not sort before lowercase: ' +
      '"PanelPaths.sys.mjs" belongs BEFORE "Panels.sys.mjs" ("panelp" < "panels"). ' +
      'The mozbuild error above names the file and both entries; move the entry to the ' +
      'position it names. "fireforge lint" checks list order before a build.',
  },
  {
    // packager.py dereferences a None sink when the object directory's
    // dist/ lacks pieces it assumes exist.
    pattern:
      /packager\.py[\s\S]*?AttributeError: 'NoneType' object has no attribute 'open'|AttributeError: 'NoneType' object has no attribute 'open'[\s\S]*?packager\.py/,
    hint:
      '"mach package" tripped a NoneType.open inside packager.py. That is almost always an ' +
      'incomplete dist/ tree: packaging before a full "fireforge build" (not --ui) finished, ' +
      'or after a build that failed late. Run "fireforge build" to completion, then ' +
      '"fireforge package" again.',
  },
  {
    // bindgen emits `pub type basic_string___self_view = ...<_CharT>;` into
    // gecko-profiler's bindings.rs against some macOS libc++ SDKs, where
    // `_CharT` is not in scope.
    pattern:
      /cannot find type `_CharT` in this scope[\s\S]*?gecko-profiler-|gecko-profiler-[\s\S]*?cannot find type `_CharT` in this scope/,
    hint:
      'The Rust compile failed on a bindgen-generated `basic_string___self_view` alias in ' +
      'gecko-profiler/bindings.rs. This is an upstream bindgen defect against some macOS ' +
      'libc++ SDK versions. The project needs a change that strips the alias after generation: ' +
      'remove any `pub type basic_string___self_view = …<_CharT>;` line from ' +
      '`<objdir>/release/build/gecko-profiler-*/out/gecko/bindings.rs` before the Rust compile.',
  },
  {
    // Configure's die() for a tool below the minimum the source declares.
    // mach's own text names "./mach bootstrap", the wrong entry point here.
    pattern: /\bversion [\d.]+ is too old\.?\s+At least version [\d.]+ is required/i,
    hint:
      'A toolchain component is older than the minimum this Firefox source declares, which is ' +
      'typical after moving to a new Firefox version. Run "fireforge bootstrap" (not mach\'s ' +
      'suggested "./mach bootstrap") to update the toolchain, then build again.',
  },
  {
    // rust.configure names the minimum only further down its message.
    pattern: /\b(?:Rust compiler|Cargo package manager) [\d.]+(?:[\w.-]*)? is too old/i,
    hint:
      'The Rust toolchain is older than the minimum this Firefox source declares, which is ' +
      'typical after moving to a new Firefox version. Run "fireforge bootstrap" to update the ' +
      'toolchain, then build again.',
  },
  {
    // A failed `mach build` still prints its configure summary on the way
    // out, which reads like a success banner.
    pattern: /Config object not found by mach\.[\s\S]*?Configure complete!/,
    hint:
      'Ignore the trailing "Config object not found by mach. / Configure complete!" block: ' +
      "that is mach's post-failure configure summary, printed after the build already failed. " +
      'The real failure is the error above it.',
  },
];

/**
 * The known remedies for what a failed `mach` command wrote, in a stable
 * order and without repeats. Pass both streams: mach's wrapper writes a
 * subcommand's errors to either.
 *
 * @param output - Everything mach wrote
 * @returns One paragraph per recognised failure; empty when none is recognised
 */
export function machErrorHints(output: string): string[] {
  return HINTS.filter(({ pattern }) => pattern.test(output)).map(({ hint }) => hint);
}
