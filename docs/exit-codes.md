<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Exit codes

A script branches on the exit code, and CI uses it to decide whether to retry or escalate. Under `--json` a failure also writes `{ schemaVersion, error, code }` to stdout (see [machine-output.md](machine-output.md)).

| Code | Name                   | Meaning                                                                                                                                     |
| ---: | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
|    0 | `SUCCESS`              | Completed. A prompt you declined also exits 0: the run did what it was asked.                                                               |
|    1 | `GENERAL_ERROR`        | Unspecified failure you have to act on. Includes job and slot refusals.                                                                     |
|    2 | `CONFIG_ERROR`         | `fireforge.json` is missing or invalid, including an unknown key.                                                                           |
|    3 | `DOWNLOAD_ERROR`       | Firefox source could not be downloaded or extracted.                                                                                        |
|    4 | `GIT_ERROR`            | A Git operation failed.                                                                                                                     |
|    5 | `BUILD_ERROR`          | `mach build` failed, or a test suite went red.                                                                                              |
|    6 | `PATCH_ERROR`          | A patch failed to apply (including one `rebase --dry-run` predicts will reject), or the patch queue could not be changed.                   |
|    7 | `MISSING_DEPENDENCY`   | A required tool (python3, git, tar) was not found.                                                                                          |
|    8 | `INVALID_ARGUMENT`     | The flags were wrong: an unknown command or option, a missing argument, or a value that is not what the flag takes. A usage problem.        |
|    9 | `FURNACE_ERROR`        | A Furnace component operation failed. `furnace validate` also uses it for warnings past `--max-warnings`.                                   |
|   10 | `RESOLUTION_ERROR`     | Conflict resolution failed.                                                                                                                 |
|   11 | `INTERNAL_ERROR`       | A FireForge invariant did not hold: a bug in FireForge. Escalate it.                                                                        |
|   12 | `SMOKE_EXIT_FAILURE`   | `run --smoke-exit` saw console errors that were not allowed in the smoke window, or an allowlisted shape fired past its `# max-hits` limit. |
|   13 | `SMOKE_LAUNCH_FAILURE` | `run --smoke-exit` saw the browser exit uncleanly before the window elapsed, or exit cleanly before it without any console output.          |
|   14 | `INCONCLUSIVE`         | A test verdict was discarded because `engine/` moved while the harness ran. Not red: run it again.                                          |
|   15 | `LOCK_TIMEOUT`         | A lock wait expired, so the run never started. Re-queue it with a larger `--wait-lock`.                                                     |
|   16 | `JOB_FAILED`           | A job's work went red: a step failed, was refused before it launched, or its evidence would not seal.                                       |
|   17 | `JOB_STOPPED`          | A job ended with no verdict: cancelled, past its step deadline, or its supervisor or executor was killed.                                   |
|   18 | `JOB_WAIT_TIMEOUT`     | `job wait` or `job run --timeout` ran out of time. The job keeps running and may yet pass.                                                  |
|  130 | `USER_CANCELLED`       | You interrupted a prompt (Esc or Ctrl+C).                                                                                                   |

`--help`, `--version` and a command group invoked without a subcommand print help and exit 0.

## Distinctions that matter for CI

- **Retry or escalate.** Exit 1 usually means something has to change first. Exit 11 means nothing you could change would have helped: escalate, do not retry.
- **Red, never ran, or thrown away.** Exit 5 is a suite that failed (`--json` code `test-failure`). Exit 15 is a run that never started, because another FireForge process held a lock for the whole budget (engine session, patch directory, build and Furnace locks all exit 15); re-queue it. Exit 14 is a suite whose result was discarded because `engine/` moved: the code may be green. The verdict line's `reason=` carries the same distinction.
- **Interrupted or declined.** Ctrl+C exits 130. A declined confirmation exits 0.

## `job`, `slot`, `host` and `prove`

`job wait`, `job status`, `job run` and `prove` (when it waits for its job) exit by what the job means, so `fireforge job wait ID && git commit` cannot treat a red job as success.

| Exit | When                                                                                                                                                                                          |
| ---: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
|    0 | `job wait` and `job run`: the job passed. `job status`: the job passed or has not ended.                                                                                                      |
|   16 | The job failed.                                                                                                                                                                               |
|   17 | The job was cancelled or interrupted.                                                                                                                                                         |
|   18 | The wait timed out with the job unfinished. Wait again.                                                                                                                                       |
|    1 | No answer: no coordinator, or a refusal. `--json` codes `unknown-job`, `ambiguous-job`, `unknown-slot`, `invalid-log-range`, `job-cannot-run` and `executor-mismatch` name the common causes. |
|    8 | A flag value that is not a whole number, or any other usage error. Every numeric flag in these groups behaves alike.                                                                          |

A quarantined slot, a blocked host and a disk below its floor do not fail a job: it stays queued, and `job status` reports why in `blockedBy`. `prove` exits 1 when the evidence is incomplete.

## `check`

| Exit | When                                                                                                                                                |
| ---: | --------------------------------------------------------------------------------------------------------------------------------------------------- |
|    0 | Every step passed or was skipped.                                                                                                                   |
|    1 | A step failed (`reason=step-failures`; each step's code is in `steps[].exitCode` of the `--json` document), or a `--patches` name matched no patch. |
|   15 | Every failed step exited 15 (`reason=lock-timeout`): nothing was judged red. Re-queue it.                                                           |
|    2 | `fireforge.json` is invalid, including a `check.status` policy `status` would refuse.                                                               |
|    8 | An unknown `--only` or `--skip` step, or a bad `--jobs`.                                                                                            |

`furnace validate` exits 9 for errors and for warnings past `--max-warnings`; read `summary.errors` from its `--json` document to tell them apart.
