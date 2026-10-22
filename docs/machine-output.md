<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Machine-readable output contract (internal)

The `--json` surface is a contract with scripted consumers. This file states
what a `--json` command has to do, so the next one added does not invent a
shape of its own.

## The rules

1. **Success writes exactly one JSON document to stdout**, with
   `schemaVersion` as its first key.
2. **Failure writes exactly one error document to stdout**, of the shape
   `{ "schemaVersion": 1, "error": "<human message>", "code": "<tag>" }`,
   and then exits non-zero. The `error` text is the same sentence the
   non-JSON mode would print. `code` is a stable machine-readable tag
   (`engine-missing`, `engine-not-git`, `tree-list-failed`, and so on) that
   consumers may branch on.
3. **Machine mode is engaged before any output.** `setMachineOutputMode(true)`
   has to run before the first write, so that every diagnostic, including one
   rendered later by `withErrorHandling`, goes to stderr and cannot
   interleave with the payload.
4. **stdout carries nothing else.** No banners, no progress, no warnings.
   `logger.ts` enforces this through a single `routeToStderr()` gate that all
   of its helpers consult, including `spinner()`, `note()` and
   `intro`/`outro`.

## Implementation

Use `emitMachineError` from `src/utils/machine-output.ts` for rule 2. It
writes the envelope and throws `CommandError`, which the CLI boundary treats
as already rendered, so the boundary adds no second rendering on stderr.

```ts
if (options.json === true) {
  setMachineOutputMode(true);
  try {
    const payload = await collect();
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: MACHINE_OUTPUT_SCHEMA_VERSION, ...payload }, null, 2)}\n`
    );
  } catch (error: unknown) {
    emitMachineError('collect-failed', toError(error).message);
  } finally {
    setMachineOutputMode(false);
  }
  return;
}
```

## Current surfaces

| Surface                            | Shape                                                                                                                                                                                                                                                                             | Notes                                                                                                                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status --json`                    | `{ schemaVersion: 1, … }`                                                                                                                                                                                                                                                         | Error envelope on three engine preconditions                                                                                                                                                                                       |
| `status --json` under `--check`    | adds `check: { enabled, failOn, allow?, failOnUnknown?, failed, offenders }`                                                                                                                                                                                                      | On the full payload too, not only `--summary`. `allow` and `failOnUnknown` appear only when set. An offender failing only through `--fail-on-unknown` carries `unnamed: true`. `--patches` adds `scope: { patches }`               |
| `furnace validate --json`          | `{ schemaVersion: 1, passed, summary, maxWarnings?, components, issues, excepted, staleExceptions }`                                                                                                                                                                              | `issues` counts after `validationExceptions`, stale-exception warnings included. `excepted` carries each suppressed finding with its `reason`                                                                                      |
| `check --json`                     | `{ schemaVersion: 1, verdict, reason?, summary, steps }`                                                                                                                                                                                                                          | One entry per step: `name`, `kind`, `command`, `status` (`pass`/`fail`/`skipped`), `exitCode`, `durationMs`, `detail`, and on failure `outputTail` (`timedOut` when killed at its budget). No verdict line under `--json`          |
| `check` verdict line               | `FIREFORGE-VERDICT: PASS\|FAIL [reason=step-failures\|lock-timeout\|skipped-steps failed=<steps>] steps=<n> skipped=<n> [skipped-steps=<steps>]`                                                                                                                                  | Not JSON. The last stdout line, after the step table, sealed like `test`'s. Its `reason=` set is its own, not `test`'s                                                                                                             |
| `tree list --json`                 | `{ schemaVersion: 1, trees }`                                                                                                                                                                                                                                                     | Error envelope on failure                                                                                                                                                                                                          |
| `token list --json`                | `{ schemaVersion: 1, tokensCssPath, categories }`                                                                                                                                                                                                                                 | Categories in file order, each with its tokens (`name`, `line`, `value`)                                                                                                                                                           |
| `token show --json`                | `{ schemaVersion: 1, name, category, declarations }`                                                                                                                                                                                                                              | One entry per declaring block, with its selector trail and line                                                                                                                                                                    |
| `token lint --json`                | `{ schemaVersion: 1, tokensCssPath, tokenPrefix, filesScanned, findings }`                                                                                                                                                                                                        | Each finding has `check`, `file`, `line`, `token`, `message`. The document is written even when findings exist; the exit is then non-zero, as with `status --check --json`                                                         |
| `test` verdict line                | `FIREFORGE-VERDICT: PASS\|FAIL reason=… [note=<class>] [started=<n>/<m> first-unstarted=<path> started-source=<src>] [shards=<p>/<t> [failed-shards=<labels>]] [runs=<p>/<n>] [control=<outcome>] [shuffle=<seed>] [furnace-applied=<names>\|furnace-apply=skipped] [log=<path>]` | Not JSON. A single final stdout line, sealed by `setStdoutSealed` so nothing can displace it. `log=` names the run's own complete output under `.fireforge/logs/`, so a piped or truncated run still leaves a re-readable artifact |
| `lint --per-patch --report <path>` | `{ schemaVersion: 1, patches, queueIssues, totals, … }`                                                                                                                                                                                                                           | Written to a file. `queueIssues` holds the cross-patch findings; `patch staged-dependency --add --from` reads back their `stagedDeclarations`                                                                                      |
| `status --raw`                     | `git status --porcelain` lines                                                                                                                                                                                                                                                    | Not JSON, but still a machine surface: it engages the same stdout discipline, so rules 3 and 4 apply and rules 1 and 2 do not. A clean tree prints nothing                                                                         |
| `build` log announcement           | `Full build output: <path>`                                                                                                                                                                                                                                                       | Not JSON. `build` prints no verdict line, so it names its run log directly on the way out                                                                                                                                          |

`--raw` is why `cli.ts` reads `process.argv` for `--json` or `--raw` before
dispatching. Rule 3 is about who owns stdout, and that question is settled
the same way for a porcelain stream as for a JSON document.

`doctor` and `verify` have no `--json` mode (`fireforge check` reports
`verify` as a step with its exit code and output tail). `doctor` already computes a
serializable `DoctorCheck[]`, so adding one is cheap if a consumer asks for
it. Follow the rules above rather than inventing a shape.

The run logs behind `log=` are specified in [`run-logs.md`](run-logs.md).

Additive keys outside `test`:

- `check --json`: a skipped step carries `skipKind`, `config` when
  `check.skip` names it and `unavailable` when the project has nothing for
  it to run. The verdict line adds `skipped-steps=<steps>` whenever a step
  is skipped, and `reason=skipped-steps` when `check.failOnSkipped` fails a
  run on an `unavailable` skip alone.
- `furnace validate --json`: a finding about particular elements carries
  `tags` (`no-keyboard-handler` names each synthetic element with an
  `@click`). An exception that matched an error adds a
  `validation-exception-on-error` error, and a full run under
  `furnace.json#minComponents` a `component-floor` error on `furnace.json`.
- `furnace validate --json`: a `hardcoded-text` finding
  carries `files`, the component's module file names it was found in.

## Versioning

`schemaVersion` is `MACHINE_OUTPUT_SCHEMA_VERSION` in
`src/utils/machine-output.ts`. Additive changes (a new key) do not bump it.
Removing or retyping a key does, and needs a changelog note saying what
moved.

## `test` verdict reasons

`FIREFORGE-VERDICT: FAIL reason=<reason>` uses a closed set
(`FireforgeVerdictReason`, `src/commands/test-verdict.ts`):

| Reason              | Meaning                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crash`             | The harness or the browser died, so there is no trustworthy suite result.                                                                                                                                                                                                                                                                                         |
| `server-startup`    | A mochitest server never came up (`could not start server on port`, `Timed out while waiting for server startup`) before any test ran. An infrastructure failure, retried like `crash` within `--harness-retries`; this reason is what is left once the budget is spent.                                                                                          |
| `harness-arguments` | Profile or other harness argument setup failed before any tests could run; a rebuild is not the repair.                                                                                                                                                                                                                                                           |
| `no-tests`          | The run dispatched but nothing ran.                                                                                                                                                                                                                                                                                                                               |
| `test-failures`     | The suite ran and reported unexpected results.                                                                                                                                                                                                                                                                                                                    |
| `preflight`         | The run was refused before the harness was reached.                                                                                                                                                                                                                                                                                                               |
| `inconclusive`      | A result exists, but `engine/` moved under it or a perf run changed power source, so the result was discarded.                                                                                                                                                                                                                                                    |
| `lock-timeout`      | The run never started: the engine session lock stayed contended.                                                                                                                                                                                                                                                                                                  |
| `killed`            | A signal terminated the run, or FireForge ended it because its parent process vanished. Written from the signal handler (or the parent-exit watchdog) so that a log tail always describes itself. A killed run must never be silent, or "killed", "still running" and "never started" all look alike. `signal=` names the cause: a signal name, or `parent-exit`. |

### The additive `note=` key

A `FAIL reason=preflight` line covers every gate before the harness: a
missing build, a peer's packaging record replacing this session's, a
developer browser holding the objdir. An unattended reader whose pipe kept
only the verdict line could not tell those apart, so a preflight refusal that
can classify itself also emits `note=<class>`.

`note=` is additive, like `log=`, `signal=` and `shards=`. `reason=` always
comes from the closed set above, so a consumer that
tokenises `key=value` pairs is unaffected, and a gate that names no class
emits no `note=` at all. The classes are not a closed set and may grow, so
consumers should treat an unrecognised one as opaque. Current values:
`browser-busy`, `stale-browser`, `stale-browser-kill-failed`, `marionette-port-busy`, `mochitest-port-busy`,
`coverage-replaced`, `stale-build`, `stale-components`, `no-launchable-binary`, `negative-control` (the
control diff was refused), `negative-control-pending` (an interrupted run's
control could not be undone safely). Also `stale-compiled`
(compiled sources changed after the binary under test was linked) and
`control-built` (the binary still carries a compiled negative control whose
restore build never ran or failed). An `invalid-build-baseline` refusal
names the first failing field and its value. `note=negative-control-restore` rides a
`reason=inconclusive` line whose control could not be restored byte-exact.

### Multi-run invocations: `FIREFORGE-RUN:`, `runs=` and `control=`

A mixed-harness request, `--repeat <n>` and `--negative-control <diff>` run
several mach invocations under one lock hold (see
[`testing.md`](testing.md#several-runs-under-one-lock-hold)). Each sub-run
writes one raw stdout line before the verdict:

```
FIREFORGE-RUN: PASS|FAIL [reason=…] [note=…] [checks=<n>] [unexpected=<n>] [shards=<p>/<t>] run=<i>/<n> [harness=xpcshell|mochitest]
```

Its keys are the ones that sub-run's verdict line would have carried alone.
A `FIREFORGE-RUN:` line is never a verdict: the invocation still ends with
exactly one `FIREFORGE-VERDICT:` line. With more than one planned run it
carries `runs=<passed>/<planned>` and no count keys; a failed aggregate takes
the most structural reason among its runs (`inconclusive`, `preflight`,
`crash`, `server-startup`, `harness-arguments`, `no-tests`, `test-failures`) and that run's
`note=`. A run that never started (the invocation stopped at a refusal)
counts toward `<planned>` but not `<passed>`.

`control=caught|missed|inconclusive` is present only for a negative control.
`caught` means every repetition went red with `reason=test-failures`, and
the process exits 0 even though the status is `FAIL`; `missed` means a
repetition stayed green (exit 5); `inconclusive` covers every other outcome.
A one-run control keeps its run's full line, counts included, and appends
the key.

### The additive `started=` and `first-unstarted=` keys

Written together on a `FAIL reason=test-failures` line when a run that mach
exited 0 on was refused its pass because requested test files never started:
`started=<n>/<m>` counts the requested test files with a start (or skip)
marker, and `first-unstarted=<path>` names the first, in dispatch order,
that has none. A run refused only for a non-zero `unexpected=` count or a
mid-test shutdown carries neither. Absent on every other line. See
[`testing.md`](testing.md#the-verdict-line).

`started-source=raw|stream|capture` follows them and names the evidence the
count came from: the mozlog structured log (a run with `--results` or
`--shard-size`), the complete streamed output (every other run), or, only
when nothing was streamed, the last 2 MB of the capture.

### Shards: `FIREFORGE-SHARD:` and `failed-shards=`

A sharded run prints one `FIREFORGE-SHARD:` line per finished shard, before
the verdict line:

```
FIREFORGE-SHARD: PASS|FAIL [reason=…] [checks=<n>] [unexpected=<n>] shard=<i>/<n> path=<label> [failed-files=<path>,…] [ports=http:<n>,ssl:<n>,ws:<n>]
```

`path=` is the shard's path argument (whitespace replaced by `_`), or a
`--shard-size`/`--jobs` chunk's first file plus `+<k>`. `failed-files=`
appears under `--shard-size` and names the chunk's files that failed. The
aggregate verdict appends `failed-shards=<label>,…` after `shards=` when any
shard did not pass; under `--shard-size` `shards=` counts files and
`failed-shards=` names files. Both are absent on a green run.

`ports=` names the mochitest HTTP server, ssltunnel and
WebSocket ports the shard's harness reported (its "falling back to port"
lines), in that order and only those it reported; it is absent when the
harness reported none (an xpcshell shard, or a harness that died before its
servers). A shard whose server never started says `reason=server-startup`,
and the aggregate verdict does too when every crashed shard failed that way.

### Additive keys of parallel and per-file runs

`jobs=<n>` marks a `--jobs` run, `lock=shared` a run that held the engine
session lock shared, and `results=<path>` names the `--results` document.
A `--jobs` run whose caller set `MOZ_UPLOAD_DIR` appends
`upload-dirs=<dir>,…`, the per-instance upload directories
(`<MOZ_UPLOAD_DIR>/job-<i>`, one per instance that ran), and a `--results`
record whose `test` is `automation.py` (a harness-level result) carries
`shardFiles`, plus `file` when its shard has exactly one file. A
run whose engine changed mid-run only in files the running browser cannot
see keeps its verdict and appends `drift-tolerated=<n>`. A negative control
on compiled source appends `control-build=compiled`, and
`control-restore-build=done|failed` for the full build that recompiles the
restored source after the last run. Every run that reaches
dispatch appends `build-id=<BuildID>`, read from the launchable build's
`application.ini` (absent when that file has no `BuildID`). A raw log
that starts none of a dispatch's requested files counts as
`started=0/<m> ... started-source=raw`.

### The additive `shuffle=` key

A `fireforge test --shuffle [seed]` run records the seed used to permute
FireForge's isolated path-argument shards. Repeating the seed and selection
repeats that shard order. It also forwards native mach `--shuffle`, which
randomizes files within an invocation without using this seed. `--no-shard`
disables FireForge's seeded argument permutation. The seed is exported as
`FIREFORGE_SHUFFLE_SEED` for custom in-file task code and appended as
`shuffle=<seed>` to every verdict form. This field does not claim replayable
native harness file order. Absent when shuffle was not requested.

### The additive `orphans-reaped=` key

How many harness processes FireForge terminated itself during the run: at
preflight, survivors of an earlier run in this objdir under `--reap-orphans`
or `test.reapOrphans: "reap"`; at teardown, helpers this run's harness
launched (httpd, websocket server, ssltunnel, process bridge, the browser,
`moz-http2`) that were still alive after mach exited. Summed across the census, every
retry attempt and every shard. Absent when nothing was reaped, so a green after a reap is
distinguishable from a green on a quiet machine. A run ended by SIGTERM or by the parent-exit
watchdog writes its verdict before the teardown reap runs, so that line never
carries the key; the reap is reported on stderr instead.

A preflight refusal's own text is written to stdout before the verdict line,
and into the run log, so the verdict stays the last stdout write while the
reason survives both a redirect and a `tail`. See
[`run-logs.md`](run-logs.md).

### Additive host and perf keys

`host-load=<number>` records the one-minute load at suite startup. Each suite
also samples the highest CPU process before and after dispatch. A contention
warning appends `host-cpu-warning=true`; the diagnostic names the process
and measured CPU. These diagnostics annotate a test failure without changing
its classifier reason.

Perf runs append `power-source=ac|battery|unknown`. On macOS the source is
read from `pmset -g ps`, so charging on AC reads `ac`. A known source
transition appends `power-changed=true` and refuses the run as
`reason=inconclusive`. The producer's sample JSON carries an additional
`fireforgeHost: { start, end, powerSourceChanged }` object, where each host
state includes `load`, `power` and an optional `topProcess` with CPU and
command. Consumers should tolerate this additive object. Unknown power
state is visible but never treated as a proven transition.

On a perf run (`--perf-samples`), an `engine/` change during the run makes
the verdict `reason=inconclusive` only when HEAD moved or a changed path is
packaged by the running build: a source an objdir install manifest names, a
directory one installs from, or a test file. Edits that no manifest installs
(compiled sources, build files, docs) leave the sample standing with a
warning naming them. Other runs are inconclusive only when a changed path is
one the running browser can see: a file the objdir links to its source, one
staged at dispatch, or a test file or staging input of the run; anything
else leaves the verdict standing with `drift-tolerated=<n>`.

### Additive Furnace keys

A `fireforge test --build` or `--build-only` run whose pre-test Furnace apply
deployed components appends `furnace-applied=<name>,<name>…`: the components
whose `components/` source changed since their last deploy, which the
runtime under test therefore includes. `--no-furnace-apply` skips that apply
and appends `furnace-apply=skipped`. `--furnace-apply reached` appends
`furnace-skipped=<names>` for components with undeployed edits that no
requested test reaches. All are absent otherwise.
