<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Exit codes

A script branches on the exit code, and CI uses it to decide whether to retry or escalate. Every failure also has a stable string `code` (`lock-timeout`, `gate-dirty-tree`). It is printed on stderr with the message, followed by the hint when the failure has one:

```
error[gate-dirty-tree]: <message>
hint: <what to do next>
```

The `--json` failure document `{ schemaVersion, error, code, hint }` carries the same three ([machine-output.md](machine-output.md)). Branch on the exit code for the category and on `code` for the exact cause.

| Code | Name                   | Meaning                                                                                                                  |
| ---: | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
|    0 | `SUCCESS`              | Completed. A prompt answered "no" also exits 0: the run did what it was asked.                                           |
|    1 | `GENERAL_ERROR`        | A failure you act on: a red `lint`, `typecheck`, `check` or `doctor`, a refusal before any work started.                 |
|    2 | `CONFIG_ERROR`         | `fireforge.json` or a state document is missing or invalid, including an unknown key.                                    |
|    3 | `DOWNLOAD_ERROR`       | The Firefox source could not be downloaded or extracted, or this host has not downloaded the pin yet.                    |
|    4 | `GIT_ERROR`            | A git operation failed, or a ref could not be moved the way the command requires.                                        |
|    5 | `BUILD_ERROR`          | `mach` failed: a build that did not compile, a test run that went red.                                                   |
|    6 | `PATCH_ERROR`          | A patch did not apply, or the patch queue is inconsistent or could not be changed.                                       |
|    7 | `MISSING_DEPENDENCY`   | A required tool (git, python3, watchman for `watch`) is not installed or not usable.                                     |
|    8 | `INVALID_ARGUMENT`     | The command line is wrong: an unknown option, a bad value, a combination that is refused.                                |
|    9 | `FURNACE_ERROR`        | Component management failed: validation errors, generated typing files out of date.                                      |
|   10 | `RESOLUTION_ERROR`     | Conflicts are left for a person to resolve, such as a rebase that ended with conflict markers.                           |
|   11 | `INTERNAL_ERROR`       | An internal invariant did not hold: a bug in FireForge, never yours to fix. The message asks for a report.               |
|   12 | `SMOKE_EXIT_FAILURE`   | A smoke start (`run --smoke-exit`) saw console errors that no allowlist entry accepts.                                   |
|   13 | `SMOKE_LAUNCH_FAILURE` | A smoke start's browser exited before its window elapsed.                                                                |
|   14 | `INCONCLUSIVE`         | A result exists but cannot be trusted, because what it judged changed underneath it. Run again; do not report it as red. |
|   15 | `LOCK_TIMEOUT`         | A wait for a lock or a workspace expired, so the work never started. Run again, or pass `--wait-lock <seconds>`.         |
|  130 | `USER_CANCELLED`       | Interrupted with Ctrl+C (SIGINT), at a prompt or while running. Changes in progress were rolled back.                    |
|  143 | `TERMINATED`           | Asked to stop with SIGTERM. Changes in progress were rolled back.                                                        |

A second interrupt while the first is still being handled ends the process at once with the same code, without the rollback.

## The commands that judge

### `test`

| Result                                                                                         | Exit |
| ---------------------------------------------------------------------------------------------- | ---: |
| Every planned test file ran and passed; a negative control was caught                          |    0 |
| Refused before the harness started: a stale build without `--build`, a path that is not a test |    1 |
| Red: failures, a crash, a hang, a file that never started or finished                          |    5 |
| A negative control failed: `control-missed`, `control-wrong-red`, `control-baseline-red`       |    5 |
| The engine changed while the harness ran (`test-inconclusive`, `control-inconclusive`)         |   14 |
| The workspace, the display or a build slot did not come free                                   |   15 |

### `check`

| Result                                                                                        | Exit |
| --------------------------------------------------------------------------------------------- | ---: |
| Every step that ran passed                                                                    |    0 |
| A step failed, or a step had nothing to run and `check.failOnSkipped` is set (`check-failed`) |    1 |
| An unknown step name for `--only` or `--skip`                                                 |    8 |
| The workspace did not come free; no step's result is reported                                 |   15 |

### `gate`

| Result                                                                                                                                                       | Exit |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---: |
| `verified`: everything passed and `refs/fireforge/verified` is at the commit                                                                                 |    0 |
| `pending`: everything passed and acceptances are outstanding; the ref has not moved                                                                          |    0 |
| `feedback`: the entries named with `--lane` passed; nothing was recorded                                                                                     |    0 |
| The working tree differs from HEAD (`gate-dirty-tree`); only the check is red (`gate-check-failed`)                                                          |    1 |
| No commit to judge (`gate-no-commit`); the verified commit is not an ancestor (`gate-not-fast-forward`); the ref moved while the gate ran (`gate-ref-moved`) |    4 |
| The build, a lane, a stress run, a control or a smoke start is red (`gate-failed`)                                                                           |    5 |
| The working tree or HEAD changed while the gate ran (`gate-tree-moved`)                                                                                      |   14 |
| The workspace did not come free                                                                                                                              |   15 |

A gate that exits 0 has not necessarily moved the ref: read `result=` on the verdict line, `outcome` in the JSON document, or the ref itself. A red check with green lanes exits 1 because nothing `mach` ran failed; any red build or declared entry exits 5 whatever the check said.

`gate accept` exits 1 when a lane it stands on has no recorded pass for the commit (`gate-evidence-missing`) or the tree is dirty, and 8 for an undeclared ID.

### `doctor`

Exits 0 when no check failed (warnings do not count) and 1 otherwise (`doctor-unhealthy`). A missing tool of `externalToolchains` is a failed check when it is `required` and a warning otherwise.
