<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Exit codes (internal)

The exit code is the machine-readable half of the CLI's contract. A script
branches on it, and CI uses it to decide whether to retry or escalate. The
values live in `src/errors/codes.ts`. This file says what they mean and
which error class produces each one.

| Code | Name                   | Meaning                                                                                                                 | Produced by                                                                                       |
| ---: | ---------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
|    0 | `SUCCESS`              | Completed. Also a run that prompted and the operator declined: declining is a successful run that chose not to proceed. | (none)                                                                                            |
|    1 | `GENERAL_ERROR`        | Unspecified failure the operator has to act on.                                                                         | `GeneralError` (and `PreflightRefusalError`), `ParserFallbackError`, `ExecTimeoutError`           |
|    2 | `CONFIG_ERROR`         | `fireforge.json` missing or invalid.                                                                                    | `ConfigError` and subclasses                                                                      |
|    3 | `DOWNLOAD_ERROR`       | Could not download or extract Firefox source.                                                                           | `DownloadError` and subclasses                                                                    |
|    4 | `GIT_ERROR`            | A git operation failed.                                                                                                 | `GitError` and subclasses, except `GitNotFoundError`                                              |
|    5 | `BUILD_ERROR`          | `mach build` failed, or a test suite went red.                                                                          | `BuildError` and subclasses, `TestFailureError`                                                   |
|    6 | `PATCH_ERROR`          | A patch failed to apply, or the patch queue could not be mutated.                                                       | `PatchError`, `PatchManifestCorruptError`, `RebaseError` and subclasses                           |
|    7 | `MISSING_DEPENDENCY`   | A required tool (python3, git, tar) was not found.                                                                      | `PythonNotFoundError`, `GitNotFoundError`, `MachNotFoundError`                                    |
|    8 | `INVALID_ARGUMENT`     | The flags were wrong. A usage problem, not an environment one.                                                          | `InvalidArgumentError`, plus commander usage errors (unknown command or option, missing argument) |
|    9 | `FURNACE_ERROR`        | A Furnace component operation failed.                                                                                   | `FurnaceError`                                                                                    |
|   10 | `RESOLUTION_ERROR`     | Conflict resolution failed.                                                                                             | `ResolutionError`                                                                                 |
|   11 | `INTERNAL_ERROR`       | A FireForge invariant did not hold. This is a bug in FireForge, not something the operator can fix.                     | `InternalInvariantError`                                                                          |
|   12 | `SMOKE_EXIT_FAILURE`   | `run --smoke-exit` saw console errors that were not allowed in the smoke window.                                        | `SmokeRunError`                                                                                   |
|   13 | `SMOKE_LAUNCH_FAILURE` | `run --smoke-exit` saw the browser exit uncleanly before the window elapsed.                                            | `SmokeRunError`                                                                                   |
|   14 | `INCONCLUSIVE`         | A test run's verdict was thrown away because `engine/` moved while the harness ran. This is not red. Re-run it.         | `InconclusiveVerdictError`                                                                        |
|   15 | `LOCK_TIMEOUT`         | A lock wait expired, so the run never started. Re-queue it with a larger `--wait-lock`.                                 | `LockContentionError`                                                                             |
|  130 | `USER_CANCELLED`       | The operator interrupted a prompt (Esc or Ctrl+C). 128 + SIGINT.                                                        | `CancellationError`                                                                               |

Usage errors that commander detects itself (an unknown command, an unknown
or malformed option, a missing required argument) never reach a command
action. Before 0.46.0 commander terminated the process with its own exit 1
and printed no refusal envelope under `--json`. `createProgram` now installs
commander's `exitOverride()`, and the entry point maps the resulting
`CommanderError` to `INVALID_ARGUMENT` (8) with the standard envelope on
stdout. `--help` and `--version` take the same path and still exit 0, and so
does a command group invoked without a subcommand (`fireforge`,
`fireforge tree`): commander prints the group's help and the entry point
treats that as informational rather than as a wrong flag. That matches the
exit 0 that `patch`, `token` and `furnace` give through their own help
action.

## The three distinctions that matter for CI

**Retry or escalate.** `GENERAL_ERROR` usually means the operator has to
change something, and a retry may then help. `INTERNAL_ERROR` means nothing
they could change would have helped. Escalate it, do not retry.

**Red, never ran, or thrown away.** These are three different facts, and
before 0.44.0 two of them shared exit 1.

- `BUILD_ERROR` (5) is a suite that failed. Since 0.45.0 it is thrown as
  `TestFailureError`, which keeps the code but carries test remedies rather
  than build ones (`--json` reports it as `test-failure`).
- `LOCK_TIMEOUT` (15) is a run that never started, because another FireForge
  process held the lock for the whole budget. Nothing about the request was
  wrong, so re-queue it.
- `INCONCLUSIVE` (14) is a suite whose result was discarded because
  `engine/` moved underneath it. The code may be perfectly green, so
  reporting it as red is wrong.

A summary line reading `FAIL - exit 1` beside `FAIL - exit 5` invited
treating opposite facts as the same kind of thing. The codes now separate
them. The `FIREFORGE-VERDICT:` line's `reason=` key carries the same
distinction for humans.

`LockContentionError` backs every lock in FireForge (engine session, patch
directory, build, furnace), so all four exit 15. That is intentional: the
fact is the same whichever lock was contended.

**Interrupted or declined.** Before 0.44.0 a Ctrl+C and a deliberate "no" at
a confirmation both returned the same value and exited 0, so a script could
not tell them apart. They are now distinct: an interrupt raises
`CancellationError` and exits 130, and a declined confirmation returns
normally and exits 0, because the run did what it was asked and the answer
was no.

## Adding a code

New codes go in `src/errors/codes.ts` with a comment saying what a consumer
should do differently on seeing it. If the answer is "nothing different from
an existing code", it does not need one. Add a row here in the same change.
