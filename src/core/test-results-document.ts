// SPDX-License-Identifier: EUPL-1.2
/**
 * The document `fireforge test --results <path>` writes, which a job's
 * evidence reads back: one record per test file and per `--repeat` run.
 */
import type { RawTestResult } from './test-raw-log.js';

/** The `repetition` of a control's unmutated baseline dispatch. */
export const CONTROL_BASELINE_REPETITION = 0;

/** One file's result in one dispatch. */
export interface TestFileResult extends RawTestResult {
  /** `--repeat` run (1-based); 1 for a single run. */
  run: number;
  /** The shard (path argument or `--shard-size` chunk) the file ran in. */
  shard: string;
  /** Line of the run log where this file's dispatch began (1-based). */
  logLine: number;
  /**
   * The shard's dispatched files, on a harness pseudo-record only: a result
   * the harness itself reports, which names no test file.
   */
  shardFiles?: string[];
  /** The shard's one file, on a harness pseudo-record of a one-file shard. */
  file?: string;
}

/** The document `--results` writes. */
export interface TestResultsDocument {
  schemaVersion: 1;
  /** Files in dispatch-completion order, for the numbered runs. `run` is 1 or more. */
  files: TestFileResult[];
  /** Started files that never ended, per dispatch of a numbered run. */
  unfinished: Array<{ test: string; run: number; shard: string }>;
  /** A negative control's unmutated dispatch, which is not one of its runs. */
  controlBaseline?: {
    files: TestFileResult[];
    unfinished: Array<{ test: string; run: number; shard: string }>;
  };
  /** Exact dispatch rosters from the structured log, including requests never started. */
  dispatches?: TestDispatchRoster[];
  /** Actual applied mutation/restoration evidence, never inferred from an unrelated red. */
  controls?: TestControlEvidence[];
}

export interface TestControlEvidence {
  run: number;
  /** Orchestrated harness sub-run ordinal; repeats share the results' run number. */
  dispatch: number;
  harness?: 'xpcshell' | 'mochitest';
  diffDigest: string;
  mutationVerified: boolean;
  restored: boolean;
  compiled: boolean;
  compiledRestoreBuild?: 'done' | 'failed' | 'not-built';
  targets: Array<{
    path: string;
    originalSha256: string;
    mutatedSha256: string;
    mode: number;
    restoredSha256: string;
    restoredMode: number;
  }>;
}

/** Runtime observations for one requested dispatch, without inferring task execution. */
export interface TestDispatchRoster {
  run: number;
  shard: string;
  requested: string[];
  started: string[];
  completed: string[];
  skipped: string[];
  unfinished: string[];
  attempts: number;
}
