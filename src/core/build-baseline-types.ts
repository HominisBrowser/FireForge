// SPDX-License-Identifier: EUPL-1.2
/**
 * Type of the last-build baseline marker, split out of `build-baseline.ts`
 * so its consumers (`build-audit`, `build-prepare`, `test-stale-check`) can
 * import the shape without importing the I/O module. `build-baseline.ts`
 * itself depends on `build-audit.ts` at runtime, and a type import back
 * into it would make the dependency graph cyclic.
 */

/** Shape of the on-disk baseline marker. */
export const DELETED_FILE_FINGERPRINT = '<deleted>';

export interface BuildBaseline {
  /** SHA of engine HEAD at the time the build succeeded. */
  engineHeadSha: string;
  /**
   * ISO-8601 timestamp of when the baseline was recorded. Informational:
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
   * Content hash per packageable engine path that was dirty at build time
   * (modified-against-HEAD or untracked). Used by `checkStaleBuildForTest`
   * to distinguish "this file's content was already in `dist/` when the
   * build completed" from "this file has been edited since". When absent,
   * the stale-check falls back to a path-only comparison.
   *
   * Keys are engine-relative POSIX paths. Values are hex-encoded SHA-256
   * digests of the file contents at the moment the baseline was recorded,
   * or {@link DELETED_FILE_FINGERPRINT} when the successful build observed
   * a tracked deletion.
   */
  packageableFingerprints?: Record<string, string>;
  /**
   * Content hash per build-input manifest (`jar.mn`, `moz.build`,
   * `moz.configure`, `Makefile.in`, `mozbuild.in`) that was dirty
   * (modified-against-HEAD or untracked) when the recorded build succeeded.
   * Same key/value shape as {@link BuildBaseline.packageableFingerprints}.
   *
   * Consumed by `build-prepare`: a dirty build input whose live hash still
   * matches its entry was already consumed by the recorded build, so it
   * neither re-runs `mach configure` nor escalates a pre-test build to a
   * full `mach build`. Without this the persistent worktree diff every
   * fork carries (imported patches + Furnace-applied components) made a
   * patch-touched `jar.mn` "changed" on every run, and each `test --build`
   * after a full build paid the full build again.
   *
   * Refresh rules, per entry kind:
   * - backend inputs (`moz.build` & co) are refreshed on every successful
   *   write, because every baseline-writing path ran the auto-configure
   *   preflight against the previous baseline, so a changed one was
   *   reconfigured.
   * - `jar.mn` entries are refreshed only by a full build and carried
   *   forward verbatim from the previous record on a `faster` write, since
   *   `fireforge build --ui` never escalates and recording a `jar.mn` no
   *   full build has installed would hide the next escalation.
   *
   * Absent on baselines written before the field existed. `build-prepare`
   * then falls back to the path-only comparison (every dirty build input
   * counts as changed).
   */
  buildInputFingerprints?: Record<string, string>;
  /**
   * What the packaged test runtime produced by the recorded build covers.
   *
   * - `'full'`: the build packaged the full test set, written by
   *   `fireforge build` / `build --ui` and by a path-less
   *   `fireforge test --build` (full-suite run).
   * - `string[]`: engine-relative POSIX request paths of the file/directory-
   *   scoped `fireforge test --build` invocation that produced the runtime.
   *   A directory entry covers everything beneath it. Support fixtures for
   *   manifests outside this list may be missing from `obj-*`/`_tests/`, so
   *   an `--allow-stale-build` run over uncovered paths is refused rather
   *   than dispatched into a hang.
   *
   * An absent field is treated as full coverage.
   *
   * The record is project-scoped, which is also per-obj-dir: multi-objdir
   * checkouts are refused up-front (`AmbiguousBuildArtifactsError`), so at
   * most one obj dir exists per project.
   *
   * Union/"shared coverage" across successive scoped builds is unsound in
   * general: every baseline write refreshes `packageableFingerprints` for
   * all dirty packageable paths, so a blind union would whitewash an
   * earlier scope's edited fixtures while `obj-*`/`_tests/` still holds its
   * stale staging. Coverage therefore replaces by default.
   *
   * The one exception is `test --build --extend-coverage`, which unions only
   * after proving the previous record's anchor still holds: same engine
   * HEAD, same {@link BuildBaseline.mozconfigHash}, and every previously
   * fingerprinted path byte-identical, i.e. the wholesale fingerprint
   * refresh is a no-op for everything the earlier scope's staging depended
   * on. Any divergence refuses fail-closed. See `src/core/coverage-extend.ts`
   * for the one boundary that guard does not cover (dirty non-packageable
   * fixtures).
   */
  testPackagingCoverage?: TestPackagingCoverage;
  /**
   * Hex-encoded SHA-256 of `engine/mozconfig` as it stood for this build.
   * Recorded because the mozconfig is regenerated from project-side
   * `configs/*.mozconfig` templates plus `fireforge.json` on every build, so
   * `engineHeadSha` does not cover it: two builds at the same engine SHA can
   * configure differently. Consumed by the `--extend-coverage` anchor, which
   * refuses when the field is absent (one plain build re-records it).
   */
  mozconfigHash?: string;
  /**
   * Anchor for the compiled StaticComponents table: the engine HEAD SHA of
   * the last full-coverage build plus content fingerprints of the
   * `components.conf` manifests that were dirty at that moment. Written
   * fresh only on full-coverage baseline writes (`fireforge build`,
   * `build --ui`, path-less `test --build`). A scoped `test --build` carries
   * the previous record forward verbatim, because `mach build faster` does
   * not rebake `components.conf` registrations into the compiled table. When
   * absent, the static-components stale check degrades to "fresh".
   */
  staticComponentsBaseline?: StaticComponentsBaseline;
  /**
   * Invocation shape that recorded this baseline (`'fireforge build'`,
   * `'fireforge build --ui'`, `'fireforge test --build [paths]'`).
   * Informational, surfaced by `fireforge status --test-coverage`. Render
   * as "unknown" when absent.
   */
  recordedBy?: string;
}

/**
 * State of the engine at the last full build, as far as compiled-in XPCOM
 * component registration is concerned. See
 * {@link BuildBaseline.staticComponentsBaseline}.
 */
export interface StaticComponentsBaseline {
  /** Engine HEAD SHA at the time of the last full build. */
  engineHeadSha: string;
  /**
   * Hex-encoded SHA-256 per `components.conf` path that was dirty
   * (modified-against-HEAD or untracked) when the full build ran. A tracked
   * deletion is represented by {@link DELETED_FILE_FINGERPRINT}. Keys are
   * engine-relative POSIX paths.
   */
  fingerprints: Record<string, string>;
}

/** Coverage claim of the packaged test runtime. See {@link BuildBaseline.testPackagingCoverage}. */
export type TestPackagingCoverage = 'full' | string[];
