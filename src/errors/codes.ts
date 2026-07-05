// SPDX-License-Identifier: EUPL-1.2
/**
 * Exit codes for fireforge CLI operations.
 * Each code represents a specific category of failure.
 */
export const ExitCode = {
  /** Operation completed successfully */
  SUCCESS: 0,
  /** Unspecified error */
  GENERAL_ERROR: 1,
  /** fireforge.json missing or invalid */
  CONFIG_ERROR: 2,
  /** Failed to download or extract Firefox source */
  DOWNLOAD_ERROR: 3,
  /** Git operation failed */
  GIT_ERROR: 4,
  /** mach build failed */
  BUILD_ERROR: 5,
  /** Patch application failed */
  PATCH_ERROR: 6,
  /** Required tool not found (python3, git, tar) */
  MISSING_DEPENDENCY: 7,
  /** Invalid command-line argument */
  INVALID_ARGUMENT: 8,
  /** Furnace component management error */
  FURNACE_ERROR: 9,
  /** Patch conflict resolution error */
  RESOLUTION_ERROR: 10,
  /**
   * `fireforge run --smoke-exit` observed one or more unallowed console
   * error lines inside the smoke window. Distinct from BUILD_ERROR so CI
   * can route smoke regressions separately from compile/config failures.
   */
  SMOKE_EXIT_FAILURE: 12,
  /**
   * `fireforge run --smoke-exit` saw the browser exit with a non-clean
   * status before the smoke window elapsed — a launch-side failure that
   * did NOT surface as a console error line (crash before console wiring,
   * missing profile, etc.).
   */
  SMOKE_LAUNCH_FAILURE: 13,
  /**
   * The user cancelled an interactive prompt. 130 = 128 + SIGINT, the
   * conventional "interrupted by the user" code — scripts and CI can tell
   * a deliberate cancellation apart from a real failure (GENERAL_ERROR).
   */
  USER_CANCELLED: 130,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
