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
}
