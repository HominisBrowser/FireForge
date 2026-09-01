<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Exit codes (internal)

The exit code is the machine-readable half of the CLI's contract: a script
branches on it, and CI decides whether to retry or escalate. The values live
in `src/errors/codes.ts`; this file is the operator-facing statement of what
they mean and which class produces each.

| Code | Name                   | Meaning                                                                                                                  | Produced by                                                    |
| ---: | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
|    0 | `SUCCESS`              | Completed. Also a run that prompted and the operator declined — declining is a successful run that chose not to proceed. | —                                                              |
|    1 | `GENERAL_ERROR`        | Unspecified failure the operator must act on.                                                                            | `GeneralError`, `ParserFallbackError`                          |
|    2 | `CONFIG_ERROR`         | `fireforge.json` missing or invalid.                                                                                     | `ConfigError` and subclasses                                   |
|    3 | `DOWNLOAD_ERROR`       | Could not download or extract Firefox source.                                                                            | `DownloadError` and subclasses                                 |
|    4 | `GIT_ERROR`            | A git operation failed.                                                                                                  | `GitError` and subclasses                                      |
|    5 | `BUILD_ERROR`          | `mach build` failed, or a test suite went red.                                                                           | `BuildError` and subclasses, `TestFailureError`                |
|    6 | `PATCH_ERROR`          | A patch failed to apply, or the patch queue could not be mutated.                                                        | `PatchError`                                                   |
|    7 | `MISSING_DEPENDENCY`   | A required tool (python3, git, tar) was not found.                                                                       | `PythonNotFoundError`, `GitNotFoundError`, `MachNotFoundError` |
|    8 | `INVALID_ARGUMENT`     | The flags were wrong. Usage problem, not an environment one.                                                             | `InvalidArgumentError`                                         |
|    9 | `FURNACE_ERROR`        | A Furnace component operation failed.                                                                                    | `FurnaceError`                                                 |
|   10 | `RESOLUTION_ERROR`     | Conflict resolution failed.                                                                                              | `ResolutionError`                                              |
|   11 | `INTERNAL_ERROR`       | A FireForge invariant did not hold. **A bug in FireForge**, not something the operator can fix.                          | `InternalInvariantError`                                       |
|   12 | `SMOKE_EXIT_FAILURE`   | `run --smoke-exit` saw unallowed console errors in the smoke window.                                                     | `SmokeRunError`                                                |
|   13 | `SMOKE_LAUNCH_FAILURE` | `run --smoke-exit` saw a non-clean browser exit before the window elapsed.                                               | `SmokeRunError`                                                |
|   14 | `INCONCLUSIVE`         | A test run's verdict was thrown away: `engine/` moved while the harness ran. **Not red** — re-run it.                    | `InconclusiveVerdictError`                                     |
|   15 | `LOCK_TIMEOUT`         | A lock wait expired, so the run never started. Re-queue it, with a larger `--wait-lock`.                                 | `LockContentionError`                                          |
|  130 | `USER_CANCELLED`       | The operator INTERRUPTED a prompt (Esc / Ctrl+C). 128 + SIGINT.                                                          | `CancellationError`                                            |

## The three distinctions that matter for CI

**Retry vs escalate.** `GENERAL_ERROR` usually means the operator must change
something and a retry may help. `INTERNAL_ERROR` means nothing they could
change would have helped — escalate it, do not retry.

**Red vs never-ran vs thrown-away.** These are three different facts and,
before 0.44.0, two of them shared exit 1. `BUILD_ERROR` (5) is a suite that
FAILED — thrown as `TestFailureError` since 0.45.0, which keeps the code but
carries test remedies rather than build ones (`--json` reports it as
`test-failure`). `LOCK_TIMEOUT` (15) is a run that never started, because another
FireForge process held the lock for the whole budget — nothing about the
request was wrong, so re-queue it. `INCONCLUSIVE` (14) is a suite whose
result was DISCARDED, because `engine/` moved underneath it — the code may
be perfectly green, and reporting it as red is wrong. A summary line reading
`FAIL — exit 1` beside `FAIL — exit 5` invited treating opposites as the same
kind of fact; the codes now separate them mechanically. The
`FIREFORGE-VERDICT:` line's `reason=` key carries the same distinction for
humans.

Note that `LockContentionError` backs every lock in FireForge — engine
session, patch directory, build, furnace — so all four now exit 15. That is
deliberate: the fact is the same whichever lock was contended.

**Interrupted vs declined.** Before 0.44.0 both a Ctrl+C and a deliberate
"no" at a confirmation returned the same value and exited 0, so a script
could not tell them apart. They are now distinct: an interrupt raises
`CancellationError` and exits **130**; a declined confirmation returns
normally and exits **0**, because the run did what it was asked and the
answer was no.

## Adding a code

New codes go in `src/errors/codes.ts` with a comment saying what a consumer
should DO differently on seeing it — if the answer is "nothing different from
an existing code", it does not need one. Add a row here in the same change.
