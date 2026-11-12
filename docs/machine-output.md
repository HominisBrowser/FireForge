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

The document (also written by `--results`) is `{ schemaVersion, verdict, reason?, log, tree, tests, dispatches, files, summary, built?, engineMoved?, validateExit? }`: `verdict` is `pass` or `fail`; `tests` are the planned files with their suite; `dispatches` are the harness invocations with exit code, attempts and verdict; `files` is one record per test file per invocation with its failures; `summary` is `{ files, passed, failed, unfinished, neverStarted, reaped }`. A negative control's document is `{ schemaVersion, verdict, control, why?, targets, restoreBuild?, baseline?, mutated? }`, where `baseline` and `mutated` are run documents.

### `gate`

```
FIREFORGE-VERDICT: PASS result=verified commit=<sha>
FIREFORGE-VERDICT: PASS result=pending commit=<sha> accept=visual,wording
FIREFORGE-VERDICT: PASS result=feedback
FIREFORGE-VERDICT: FAIL result=failed reason=gate-failed failed=check,lane:tiles commit=<sha>
FIREFORGE-VERDICT: FAIL reason=gate-dirty-tree
```

| Key      | Meaning                                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `result` | `verified` (the ref is at the commit), `pending` (passed; acceptances outstanding; the ref has not moved), `failed`, or `feedback` (a `--lane` subset)                         |
| `reason` | `gate-failed` for a red entry; otherwise the `code` of what stopped the gate (`gate-dirty-tree`, `gate-not-fast-forward`, `gate-ref-moved`, `gate-tree-moved`, `lock-timeout`) |
| `failed` | The red entries, comma-separated: `check`, `build`, `lane:<id>`, `stress:<id>`, `control:<id>`, `run:<id>`                                                                     |
| `commit` | The gated commit; absent for feedback                                                                                                                                          |
| `accept` | The acceptance IDs still to record with `fireforge gate accept <id> --note <text>`                                                                                             |

`PASS` means nothing was red; only `result=verified` means the commit is verified.

The document is `{ outcome, basis, pass, commit, tree, entries, check, pending, artifacts }`. `outcome` is the verdict's `result`. `basis` says where the entries come from: `run` (this invocation ran them), `recorded` (the pass recorded for this commit stands), `documents` (only `gate.documents` paths changed since the verified commit, so the check alone ran), `already-verified`, or `feedback`. Each entry is `{ id, status, detail, durationMs, artifacts? }` with `status` `pass`, `fail` or `skipped` (after a red build). `check` is the check document of this invocation or `null`. `artifacts` is the run's directory, `.fireforge/gate/<commit>/`, which holds `result.json` and one directory per entry (`lane-<id>/output.log`, `lane-<id>/results.json`, `lane-<id>/upload/`, `run-<id>/console.txt`).

`gate status --json` is `{ head, clean, verified, relation, ahead, result, accepted, pending }`: `relation` is `verified`, `ahead` (HEAD descends from the verified commit, by `ahead` commits), `diverged` or `unverified`; `result` is `{ pass, finishedAt, entries }` for HEAD in this checkout or `null`; `accepted` maps acceptance IDs to `{ by, at, note, commit }`. `gate accept --json` is `{ id, commit, tree, acceptance, pending }`.

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

### `doctor`

`doctor --json` is `{ healthy, checks }`. Each check is `{ id, title, status, detail, fix }`: `status` is `ok`, `warn` or `fail`, and `fix` is what to run or `null`. Check IDs: `config`, `git`, `pristine`, `engine`, `merge-driver`, `workspaces`, `storage`, `components`, `python`, `journals`, `locks`, `disk`, `typing`, and `toolchain:<toolchain>/<tool>` for each tool `externalToolchains` declares. A check that does not apply to the project's mode, or that an earlier failure makes meaningless, is absent.
