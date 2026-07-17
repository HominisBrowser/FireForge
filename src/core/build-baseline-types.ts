// SPDX-License-Identifier: EUPL-1.2
/**
 * Type of the last-build baseline marker, split out of `build-baseline.ts`
 * so its consumers (`build-audit`, `build-prepare`, `test-stale-check`) can
 * import the shape without importing the I/O module — `build-baseline.ts`
 * itself depends on `build-audit.ts` at runtime, and a type import back
 * into it would make the dependency graph cyclic.
 */

/** Shape of the on-disk baseline marker. */
export interface BuildBaseline {
  /** SHA of engine HEAD at the time the build succeeded. */
  engineHeadSha: string;
  /**
   * ISO-8601 timestamp of when the baseline was recorded. Informational —
   * downstream code keys off `engineHeadSha` for diffs, but the timestamp
   * helps operators reason about stale markers.
   */
  builtAt: string;
  /**
   * The binaryName used at build time. Captured so the dist-tree audit
   * can resolve the expected bundle root under obj-star/dist/ even when
   * the project has since been renamed.
   */
  binaryName: string;
  /**
   * Content hash per packageable engine path that was dirty at build
   * time (modified-against-HEAD or untracked). Used by
   * `checkStaleBuildForTest` to distinguish "this file's content was
   * already in `dist/` when the build completed" from "this file has
   * been edited since". Missing on baselines written before 0.16.0; the
   * stale-check falls back to the path-only comparison in that case,
   * so older baselines retain their existing behavior.
   *
   * Keys are engine-relative POSIX paths. Values are hex-encoded
   * SHA-256 digests of the file contents at the moment the baseline
   * was recorded.
   */
  packageableFingerprints?: Record<string, string>;
  /**
   * What the packaged test runtime produced by the recorded build covers.
   *
   * - `'full'`: the build packaged the full test set — written by
   *   `fireforge build` / `build --ui` and by a path-less
   *   `fireforge test --build` (full-suite run).
   * - `string[]`: engine-relative POSIX request paths of the file/directory-
   *   scoped `fireforge test --build` invocation that produced the runtime.
   *   A directory entry covers everything beneath it. Support fixtures for
   *   manifests outside this list may be missing from `obj-*`/`_tests/`, so
   *   an `--allow-stale-build` run over uncovered paths is refused rather
   *   than dispatched into a hang.
   *
   * Missing on baselines written before 0.37.0 — only `fireforge build`
   * wrote baselines then, so "full" is the honest historical value and the
   * stale-check treats an absent field as full coverage.
   *
   * The record is project-scoped, which is also per-obj-dir: multi-objdir
   * checkouts are refused up-front (`AmbiguousBuildArtifactsError`), so at
   * most one obj dir exists per project.
   *
   * Union/"shared coverage" across successive scoped builds was evaluated
   * and rejected as unsound — every baseline write refreshes
   * `packageableFingerprints` for ALL dirty packageable paths, so a union
   * would whitewash an earlier scope's edited fixtures while
   * `obj-*`/`_tests/` still holds its stale staging; coverage therefore
   * REPLACES.
   */
  testPackagingCoverage?: TestPackagingCoverage;
  /**
   * Anchor for the compiled StaticComponents table: the engine HEAD SHA of
   * the last FULL-coverage build plus content fingerprints of the
   * `components.conf` manifests that were dirty at that moment. Written
   * fresh only on FULL-coverage baseline writes (`fireforge build`,
   * `build --ui`, path-less `test --build`); a scoped `test --build`
   * carries the previous record forward verbatim, because `mach build
   * faster` does not rebake `components.conf` registrations into the
   * compiled table. Missing on pre-0.38.0 baselines — the
   * static-components stale check degrades to "fresh" in that case.
   */
  staticComponentsBaseline?: StaticComponentsBaseline;
}

/**
 * State of the engine at the last FULL build, as far as compiled-in XPCOM
 * component registration is concerned. See
 * {@link BuildBaseline.staticComponentsBaseline}.
 */
export interface StaticComponentsBaseline {
  /** Engine HEAD SHA at the time of the last full build. */
  engineHeadSha: string;
  /**
   * Hex-encoded SHA-256 per `components.conf` path that was dirty
   * (modified-against-HEAD or untracked) when the full build ran. Keys are
   * engine-relative POSIX paths.
   */
  fingerprints: Record<string, string>;
}

/** Coverage claim of the packaged test runtime. See {@link BuildBaseline.testPackagingCoverage}. */
export type TestPackagingCoverage = 'full' | string[];
