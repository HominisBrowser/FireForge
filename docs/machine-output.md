<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Machine output

FireForge has three things a script reads: the exit code ([exit-codes.md](exit-codes.md)), the `--json` document, and the verdict line. stdout carries results and nothing else; progress, warnings and errors go to stderr.

## `--json`

With `--json`, stdout is exactly one JSON document on one line. It always carries `schemaVersion` (currently `1`); adding a key keeps the version, removing or retyping one raises it.

A failure writes this document instead of the command's own, unless the command had already written its result:

```json
{ "schemaVersion": 1, "error": "<message>", "code": "<stable-code>", "hint": "<what to do next>" }
```

`hint` is absent when the error has none. Without `--json` the same failure is two lines on stderr, `error[<code>]: <message>` and `hint: <hint>`; with `--json` those lines are still written to stderr. `code` is a stable kebab-case tag such as `lock-timeout`, `invalid-argument` or `gate-dirty-tree`. The commands that judge (`lint`, `typecheck`, `check`, `test`, `gate`, `doctor`, `status --check`, `furnace validate`) write their full document and then fail through the exit code, so a red result is the result document, not the failure document.

These commands take `--json`:

<!-- json-commands -->

- `fireforge setup`
- `fireforge config get`
- `fireforge config set`
- `fireforge rebase`
- `fireforge migrate`
- `fireforge doctor`
- `fireforge download`
- `fireforge workspace list`
- `fireforge workspace add`
- `fireforge workspace remove`
- `fireforge workspace repair`
- `fireforge status`
- `fireforge lint`
- `fireforge typecheck`
- `fireforge verify`
- `fireforge check`
- `fireforge build`
- `fireforge run`
- `fireforge test`
- `fireforge gate`
- `fireforge gate accept`
- `fireforge gate status`
- `fireforge package`
- `fireforge export`
- `fireforge import`
- `fireforge resolve`
- `fireforge re-export`
- `fireforge patch rename`
- `fireforge patch reorder`
- `fireforge patch split`
- `fireforge patch move-files`
- `fireforge patch delete`
- `fireforge patch retire`
- `fireforge patch compact`
- `fireforge patch set`
- `fireforge discard`
- `fireforge reset`
- `fireforge override`
- `fireforge restore`
- `fireforge merge-driver install`
- `fireforge register`
- `fireforge wire`
- `fireforge token add`
- `fireforge token list`
- `fireforge token show`
- `fireforge token lint`
- `fireforge token coverage`
- `fireforge furnace create`
- `fireforge furnace apply`
- `fireforge furnace status`
- `fireforge furnace validate`
- `fireforge furnace types`
- `fireforge furnace rename`
- `fireforge furnace remove`
- `fireforge furnace override`
- `fireforge version`

<!-- /json-commands -->

`bootstrap`, `watch`, `furnace diff` and `merge-driver run` have no JSON form: they hand the terminal to another program, stream until stopped, or write a patch body.

## The verdict line

A command whose result is a pass/fail judgement ends stdout with one line:

```
FIREFORGE-VERDICT: PASS [key=value ...]
FIREFORGE-VERDICT: FAIL reason=<reason> [key=value ...]
```

Nothing follows it on stdout. Whitespace and `%` inside a value are percent-encoded, so the line splits on spaces into `key=value` pairs; decode a value with `decodeURIComponent`. Under `--json` the line is not written: the document carries the judgement.

The line is written on every way out. A run stopped by a signal writes `FAIL reason=killed signal=SIGINT` (or `SIGTERM`) before it cleans up, so a log tail can tell "killed" from "still running". A run that fails before it could judge writes `FAIL reason=<code>` with the error's `code`.

These commands end with a verdict line:

<!-- verdict-commands -->

- `fireforge check`
- `fireforge test`
- `fireforge gate`
- `fireforge furnace validate`

<!-- /verdict-commands -->

### `check`

```
FIREFORGE-VERDICT: PASS steps=7 passed=3 skipped=4
FIREFORGE-VERDICT: FAIL reason=check-failed failed=status,lint steps=7 passed=1 skipped=4
```

| Key       | Meaning                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------- |
| `reason`  | `check-failed` when a step is red; otherwise an error `code` (`lock-timeout`, `engine-missing`) |
| `failed`  | The steps that keep the check from passing, comma-separated                                     |
| `steps`   | Steps in the report                                                                             |
| `passed`  | Steps that passed                                                                               |
| `skipped` | Steps that did not run                                                                          |

The document is `{ pass, failed, durationMs, steps }`. Each step is `{ name, kind, status, detail, durationMs, skipped, output }`: `kind` is `builtin` or `extra`; `status` is `pass`, `fail` or `skipped`; `skipped` is `config` (left out by `check.skip` or `--skip`), `unavailable` (the project has nothing for it to run) or `null`; `output` holds what a failed step reported, line by line.

A `check.extraSteps` command runs from the project root with `FIREFORGE_PROJECT_ROOT`, `FIREFORGE_OWNED_PATHS` (a file listing the owned engine paths, one per line), `FIREFORGE_CHECK_LINT_REPORT` (the lint step's JSON report, when `check.lintReport` is set; order the step `after: ["lint"]` to read it) and, for a step declaring `engine: true`, `FIREFORGE_ENGINE` (the engine directory of the workspace the check holds).

### `test`

```
FIREFORGE-VERDICT: PASS checks=12 unexpected=0 log=<path> [results=<path>]
FIREFORGE-VERDICT: FAIL reason=test-failures shards=3/4 log=<path>
FIREFORGE-VERDICT: FAIL reason=preflight note=build-stale
```

| `reason`               | Meaning                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `test-failures`        | The suite ran and reported unexpected results, or planned files never started or finished             |
| `crash`                | The harness or the browser died, or a clean exit showed no completed suite                            |
| `server-startup`       | A test server never came up before any test ran                                                       |
| `no-tests`             | The harness ran nothing                                                                               |
| `validate`             | The harness was green and the lane's `validate` command exited nonzero                                |
| `inconclusive`         | The engine changed while the harness ran (exit code 14)                                               |
| `control-missed`       | A negative control's tests stayed green with the mutation applied                                     |
| `control-wrong-red`    | A negative control went red, but not at exactly the expected assertions                               |
| `control-baseline-red` | A negative control's tests were red without the mutation                                              |
| `preflight`            | Refused before the harness started; `note=` is the refusal's `code` and its text precedes the verdict |
| `lock-timeout`         | The workspace, the display or a build slot did not come free                                          |
| `killed`               | A signal ended the run; `signal=` names it                                                            |

| Key                                                                                                  | Meaning                                                                                                          |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `checks=<n>` `unexpected=<n>`                                                                        | The harness summary of a run with one harness invocation                                                         |
| `shards=<passed>/<total>`                                                                            | A run of several invocations                                                                                     |
| `runs=<passed>/<total>`                                                                              | `--repeat`                                                                                                       |
| `started=<n>/<m>` `first-unstarted=<path>` `started-source=`                                         | Where a run that did not start every planned file stopped, and what that was read from                           |
| `unfinished=<n>` `app-exit=<signal>`                                                                 | Files that started and never ended; the signal the browser died on                                               |
| `note=`                                                                                              | `exit-noise-ignored` or `teardown-noise-ignored` on a pass that overruled harness noise                          |
| `control=caught\|missed\|wrong-red\|baseline-red\|inconclusive` `control-restore-build=done\|failed` | A negative control ([testing.md](testing.md#negative-controls)), and the build that restored a compiled mutation |
| `shuffle=<seed>` `orphans-reaped=<n>`                                                                | The `--shuffle` seed; harness processes left over and terminated                                                 |
| `log=<path>` `results=<path>`                                                                        | The run's complete output; the `--results` document                                                              |

The document (also written by `--results`) is `{ schemaVersion, verdict, reason?, log, tree, tests, dispatches, files, summary, built?, engineMoved?, validateExit? }`: `verdict` is `pass` or `fail`; `tests` are the planned files with their suite; `dispatches` are the harness invocations with exit code, attempts and verdict; `files` is one record per test file per invocation with its failures (at most 10 per file, each assertion and message clipped to 400 characters, `failuresOmitted` counting the rest) and, for a file that ended unexpectedly, the harness's `message`; a dispatch's `verdict` carries `failureBlocks`, the failing lines read from the output when no structured log named a failure; `summary` is `{ files, passed, failed, unfinished, neverStarted, reaped }`. A negative control's document is `{ schemaVersion, verdict, control, why?, targets, restoreBuild?, baseline?, mutated? }`, where `baseline` and `mutated` are run documents. `restoreBuild` is `done` or `failed` for the build of the restored engine, and `deferred` for a control of a run of several (`gate --lane 'control:*'`), whose restoring build is left to the next control or to the end of the run.

### `gate`

```
FIREFORGE-VERDICT: PASS result=verified commit=<sha>
FIREFORGE-VERDICT: PASS result=pending commit=<sha> accept=visual,wording
FIREFORGE-VERDICT: PASS result=verified commit=<sha> reused=lane:tiles
FIREFORGE-VERDICT: PASS result=feedback
FIREFORGE-VERDICT: FAIL result=failed reason=gate-failed failed=check,lane:tiles commit=<sha>
FIREFORGE-VERDICT: FAIL reason=gate-dirty-tree
```

| Key             | Meaning                                                                                                                                                                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `result`        | `verified` (the ref is at the commit), `pending` (passed; acceptances outstanding; the ref has not moved), `failed`, or `feedback` (a `--lane` subset)                                                                                                   |
| `reason`        | `gate-failed` for a red entry; `lock-timeout` or `gate-inconclusive` when every failed entry is blocked; otherwise the `code` of what stopped the gate (`gate-dirty-tree`, `gate-not-fast-forward`, `gate-ref-moved`, `gate-tree-moved`, `lock-timeout`) |
| `failed`        | The failed entries, comma-separated: `check`, `build`, `lane:<id>`, `stress:<id>`, `control:<id>`, `run:<id>`                                                                                                                                            |
| `blocked`       | The failed entries that could not judge the commit (a lock did not come free, or the engine changed under them); a subset of `failed`                                                                                                                    |
| `commit`        | The gated commit; absent for feedback                                                                                                                                                                                                                    |
| `accept`        | The acceptance IDs still to record with `fireforge gate accept <id> --note <text>`                                                                                                                                                                       |
| `reused`        | The entries taken from an earlier run of the commit by `gate --resume`, comma-separated, not run again ([gate.md](gate.md#resuming))                                                                                                                     |
| `controls-owed` | The declared controls with no standing proof, comma-separated ([gate.md](gate.md#controls-owed)); informs, changes no exit code                                                                                                                          |

`PASS` means nothing was red; only `result=verified` means the commit is verified. A gate that outlives its session leaves this line in whatever file its output went to, and `gate status` says meanwhile whether it is still running.

The document is `{ outcome, basis, pass, commit, tree, entries, check, pending, artifacts, owed, resume }`. `outcome` is the verdict's `result`. `basis` says where the entries come from: `run` (this invocation ran them), `recorded` (the pass recorded for this commit stands), `documents` (only `gate.documents` paths changed since the verified commit, so the check alone ran), `controls` (only documents, control diffs and `gate.controls` changed, so the check ran, and the build and the controls that changed when there were any), `already-verified`, or `feedback`. Each entry is `{ id, status, detail, durationMs, ranAt?, reused?, artifacts?, blocked?, hint?, control?, load? }` with `status` `pass`, `fail` or `skipped` (after a red build or a build that could not run). `blocked` (`lock-timeout` or `inconclusive`) marks a failed entry that could not judge the commit, with the error's `hint`; `control` is a negative control's outcome (`caught`, `missed`, `wrong-red`, `baseline-red`, `inconclusive`). `ranAt` is when the entry ended; `reused` is true on an entry that `gate --resume` took from an earlier run of the commit, and `ranAt` is then when it originally ran. `load` is present on an entry that was red, blocked or interrupted when the host could be sampled: `{ cpus, start, end, busiest? }`, the one-minute load average when the entry started and ended, and, when either exceeded `cpus`, the busiest process outside the command's own process tree as `{ pid, name, cpu }`. It informs and never changes a verdict. `resume` is `null` unless `--resume` was passed; then it is `{ reused, why }`, the IDs of the entries taken and the reason none could be (`null` when a run was resumed). `owed` lists the declared controls with no standing proof as `{ id, reason, detail }`, `reason` being `never-run`, `changed`, `tree-changed`, `missed`, `wrong-red` or `not-caught`. `check` is the check document of this invocation or `null`. `artifacts` is the run's directory, `.fireforge/gate/<commit>/`, which holds `result.json` and one directory per entry (`lane-<id>/output.log`, `lane-<id>/results.json`, `lane-<id>/upload/`, `run-<id>/console.txt`).

`gate status --json` is `{ head, clean, verified, relation, ahead, result, accepted, pending, controls, running }`, `controls` being the declared controls owed a run, as `owed` above: `running` lists the gates running in this checkout as `{ pid, since, kind, commit, onHead, entry }`, read from the locks without taking or changing them: `kind` is `full` or `feedback`, `since` is the ISO time the process asked for its run slot, `commit` is the commit a full gate judges, `onHead` says it is HEAD, and `entry` is `{ id, position, total, since }` for the entry it is on, or `null` when it recorded none: `relation` is `verified`, `ahead` (HEAD descends from the verified commit, by `ahead` commits), `diverged` or `unverified`; `result` is `{ pass, finishedAt, entries }` for HEAD in this checkout or `null`; `accepted` maps acceptance IDs to `{ by, at, note, commit }`. `gate accept --json` is `{ id, commit, tree, acceptance, pending }`.

### `status`

`status --json` is `{ mode, owned, groups, pending, clean }`. `owned` lists every owned path as `{ path, group }`, `group` being the ID of its group. `groups` lists the groups in application order as `{ id, kind, paths }`: `kind` is `patch`, `component` (the upstream changes of a source-mode component), `created` (a source-mode group of created files) or `furnace` (the files a Furnace component deploys, which are not among `owned`). `pending` lists what is unaccounted for as `{ code, subject?, message, hint? }`.

### `migrate`

`migrate --json` is `{ state, mode, converted, removed, manual, rewritten, deleted, followUp, verify, pass }`. `state` is `upgraded`, or `current` when the project was already in the current format and nothing was written. `converted`, `removed` and `manual` are lists of `{ key, message }`: what was rewritten, what was dropped and why, and what was not carried over because only a person can decide it. `rewritten` and `deleted` are project-relative files. `verify` is the `verify` document and `pass` its outcome. `migrate --to-source --json` is `{ created, overridden, deleted, pristineCommit }`.

A pre-push hook can compare the tree of `refs/fireforge/verified` with the tree of the commit being pushed:

```sh
test "$(git rev-parse refs/fireforge/verified^{tree})" = "$(git rev-parse "$pushed"^{tree})"
```

### `furnace validate`

```
FIREFORGE-VERDICT: PASS errors=0 warnings=2
FIREFORGE-VERDICT: FAIL errors=1 warnings=0
```

The document is `{ pass, judged, errors, warnings, findings, excepted }`.

### `workspace`

`workspace list --json` is `{ engine, host, workspaces }`. It reads the locks without taking or changing them, so it is safe to poll.

Each workspace is `{ name, path, pin, commit, built, clonedFrom, lessee, holders, leased, leases, unidentifiedHolders }`. `built` says a build has configured its object directory. `lessee` is `{ checkout, root, at }` for whoever leased it last, or `null`. `leased` is true while a command holds it. `leases` lists those commands, `holders` their PIDs, and `unidentifiedHolders` counts holders that left no readable record (they also make `leased` true).

A lease is `{ pid, mode, since, checkout, command }`: `mode` is `exclusive` or `shared`, `since` is the ISO timestamp at which the holder asked for the lock, `checkout` is the project root of the command that leased a workspace, and `command` is the command it runs. Either is `null` when the holder did not say.

`host` is `{ display, build }`, the locks shared by every project on the host. Each carries `leased`, `leases`, `unidentifiedHolders` and `waiting` (the live waiters in the queue). `build` adds `slots`, the limit of `buildSlots` in `host.json`, and `inUse`, the compiles using a slot; a free slot exists while `inUse` is below `slots`.

`engine` is `null` unless the project is in patch mode and has an `engine/`; then it is `{ path, holders, leased, leases, unidentifiedHolders, waiting }` for the engine lock.

### `doctor`

`doctor --json` is `{ healthy, checks }`. Each check is `{ id, title, status, detail, fix }`: `status` is `ok`, `warn` or `fail`, and `fix` is what to run or `null`. Check IDs: `config`, `git`, `pristine`, `engine`, `merge-driver`, `workspaces`, `storage`, `components`, `python`, `journals`, `locks`, `disk`, `typing`, and `toolchain:<toolchain>/<tool>` for each tool `externalToolchains` declares. A check that does not apply to the project's mode, or that an earlier failure makes meaningless, is absent.
