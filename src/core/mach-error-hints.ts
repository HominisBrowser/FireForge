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
    // fix is external: a downstream consumer's patch queue may ship
    // `990-infra-bindgen-basic-string-workaround.patch`, which strips
    // the offending alias line post-generation. This hint surfaces the
    // workaround pointer alongside the raw bindgen output so operators
    // don't have to reverse-engineer the failure.
    pattern:
      /cannot find type `_CharT` in this scope[\s\S]*?gecko-profiler-|gecko-profiler-[\s\S]*?cannot find type `_CharT` in this scope/,
    hint:
      'The Rust compile failed on a bindgen-generated `basic_string___self_view` alias in ' +
      'gecko-profiler/bindings.rs. This is an upstream bindgen output bug against some ' +
      'macOS libc++ SDK versions and needs a post-generation patch to strip the alias. ' +
      'The known-working workaround is the `990-infra-bindgen-basic-string-workaround.patch` ' +
      "shipped by some downstream patch queues — import the equivalent into your fork's patches/, " +
      'then re-run "fireforge import" + "fireforge build". If your fork does not carry such a patch, ' +
      'apply the following post-process to the generated file before the Rust compile: ' +
      'remove any `pub type basic_string___self_view = …<_CharT>;` line from ' +
      '`<objdir>/release/build/gecko-profiler-*/out/gecko/bindings.rs`.',
  },
  {
    // Firefox declares per-release toolchain minimums in-tree
    // (`build/moz.configure/bindgen.configure` for cbindgen; mozboot's
    // MINIMUM_RUST_VERSION for rustc/cargo), and a source hop can move
    // them. The 152.0b7 → 153.0b8 source-refresh drill hit exactly this:
    // the first post-hop build died ~8s into `mach configure` with
    // "ERROR: cbindgen version 0.29.1 is too old. At least version
    // 0.29.4 is required." — and mach's own remediation text names
    // "./mach bootstrap", the wrong entry point for a FireForge-managed
    // repo. Pattern matches configure's cbindgen die() shape.
    pattern: /\bversion [\d.]+ is too old\.?\s+At least version [\d.]+ is required/i,
    hint:
      'A toolchain component is older than the minimum this Firefox source declares — typical ' +
      'after "fireforge download --force" moved the engine to a new Firefox major version. ' +
      'Run "fireforge bootstrap" (not mach\'s suggested "./mach bootstrap") to update the ' +
      'toolchain, then retry the build.',
  },
  {
    // Same family, rust.configure's die() shapes: "Rust compiler {v} is
    // too old." / "Cargo package manager {v} is too old." — the minimum
    // is only named further down that message, so the pattern keys on
    // the first line.
    pattern: /\b(?:Rust compiler|Cargo package manager) [\d.]+(?:[\w.-]*)? is too old/i,
    hint:
      "The Rust toolchain is older than the minimum this Firefox source declares (mozboot's " +
      'MINIMUM_RUST_VERSION) — typical after "fireforge download --force" moved the engine to a ' +
      'new Firefox major version. Run "fireforge bootstrap" to update the toolchain, then retry ' +
      'the build.',
  },
  {
    // When `mach build` fails mid-compile, mach's own shutdown pipeline still
    // runs its trailing "Config object not found by mach. / Configure
    // complete! / Be sure to run |mach build|..." summary on the way out.
    // Those three lines are plain upstream mach output, printed AFTER the
    // non-zero exit code has already been established, and they look
    // deceptively like a success banner — the eval's Darwin 25 log had
    // operators double-checking whether `make` had actually failed. We do
    // not own those lines, but we can give the operator a specific nudge
    // that they are cosmetic post-failure output rather than a mixed
    // success/failure signal.
    pattern: /Config object not found by mach\.[\s\S]*?Configure complete!/,
    hint:
      'Ignore the trailing "Config object not found by mach. / Configure complete!" block — ' +
      "that is mach's post-failure configure summary printed after the build already failed, " +
      'not a sign the build succeeded. The real failure is the error above this block.',
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
