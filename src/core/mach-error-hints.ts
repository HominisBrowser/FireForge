// SPDX-License-Identifier: EUPL-1.2
/**
 * Pattern-based translator for cryptic mozbuild / mach errors.
 *
 * Each entry maps a stderr regex to an actionable hint. The goal is not to
 * parse every mach failure — it's to convert the handful of errors whose
 * message is non-obvious into a one-line "here's what to change". New
 * entries should only be added when a concrete diagnosis of the cryptic
 * output has been established; low-confidence hints would train operators
 * to ignore the translator.
 */

/** A single translator entry. */
export interface MachErrorHint {
  /** Pattern to search within the captured mach stderr. */
  pattern: RegExp;
  /** Actionable, one-line hint to surface alongside the raw mach output. */
  hint: string;
}

/**
 * Registered hint patterns. Order-sensitive: the first match wins per
 * pattern, but multiple distinct patterns may fire for the same stderr.
 */
export const MACH_ERROR_HINTS: MachErrorHint[] = [
  {
    pattern: /mozbuild\.preprocessor\.Preprocessor\.Error[\s\S]*?no preprocessor directives found/,
    hint:
      'A file registered under JS_PREFERENCE_PP_FILES contains no preprocessor directives. ' +
      'Use JS_PREFERENCE_FILES instead, or add at least one #filter / #expand directive to the file.',
  },
  {
    // `mach package` inside `packager.py` dereferences a `None` sink when
    // the packaging input set cannot resolve an entry it expected — the
    // most common real-world cause is running `fireforge package` before
    // a full `fireforge build` has finished, so `obj-*/dist/` is missing
    // pieces the packager assumes exist. The hint points at that root
    // cause specifically; the broader "build failed" path has already
    // surfaced the raw traceback above this hint.
    pattern:
      /packager\.py[\s\S]*?AttributeError: 'NoneType' object has no attribute 'open'|AttributeError: 'NoneType' object has no attribute 'open'[\s\S]*?packager\.py/,
    hint:
      '`mach package` tripped a `NoneType.open` inside `packager.py`. This is almost always a ' +
      'symptom of the packager being handed an incomplete `obj-*/dist/` tree — e.g. running ' +
      '"fireforge package" before a full "fireforge build" (not --ui) completed, or packaging ' +
      'after a build that failed late. Re-run "fireforge build" to completion, confirm the app ' +
      'bundle exists under `obj-*/dist/`, and rerun "fireforge package".',
  },
  {
    // Upstream bindgen on some macOS libc++ SDK versions emits
    // `pub type basic_string___self_view = root::std::__1::basic_string_view<_CharT>;`
    // inside gecko-profiler's generated `bindings.rs`, but `_CharT` is
    // not in scope where the alias lands — so the Rust compile fails
    // with "cannot find type `_CharT`". The symptom is obscure and the
    // fix is external: Hominis ships
    // `990-infra-bindgen-basic-string-workaround.patch` in its patch
    // queue, which strips the offending alias line post-generation.
    // This hint surfaces the workaround pointer alongside the raw
    // bindgen output so operators don't have to reverse-engineer the
    // failure.
    pattern:
      /cannot find type `_CharT` in this scope[\s\S]*?gecko-profiler-|gecko-profiler-[\s\S]*?cannot find type `_CharT` in this scope/,
    hint:
      'The Rust compile failed on a bindgen-generated `basic_string___self_view` alias in ' +
      'gecko-profiler/bindings.rs. This is an upstream bindgen output bug against some ' +
      'macOS libc++ SDK versions and needs a post-generation patch to strip the alias. ' +
      'The known-working workaround is the `990-infra-bindgen-basic-string-workaround.patch` ' +
      "Hominis ships in its patch queue — import the equivalent into your fork's patches/, " +
      'then re-run "fireforge import" + "fireforge build". If you do not use Hominis\' queue, ' +
      'apply the following post-process to the generated file before the Rust compile: ' +
      'remove any `pub type basic_string___self_view = …<_CharT>;` line from ' +
      '`<objdir>/release/build/gecko-profiler-*/out/gecko/bindings.rs`.',
  },
];

/**
 * Scans captured stderr for known mach errors and returns matching hints.
 * Pure function — safe to call on any string; never throws.
 * @param stderr Captured mach stderr.
 * @returns Ordered, de-duplicated list of hint strings. Empty when nothing matches.
 */
export function explainMachError(stderr: string): string[] {
  if (!stderr) {
    return [];
  }
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const { pattern, hint } of MACH_ERROR_HINTS) {
    if (pattern.test(stderr) && !seen.has(hint)) {
      seen.add(hint);
      hits.push(hint);
    }
  }
  return hits;
}
