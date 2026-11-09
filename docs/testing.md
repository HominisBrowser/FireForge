<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Running tests

`fireforge test` wraps `mach test`. It exists because mach's defaults are
wrong for a fork that has to know exactly what ran: it fixes the scope,
refuses stale builds, and ends every run with one machine-readable verdict.
The same command runs unchanged inside a coordinated job
([`jobs-and-slots.md`](jobs-and-slots.md)); a [verification
tree](verification-trees.md) is the alternative beside a busy primary
checkout.

## Scope is exact

`fireforge test <directory>` runs exactly that directory. FireForge
enumerates its test files and passes the explicit list to mach in one
invocation, so mach's prefix matching cannot sweep in sibling directories
that share the name prefix. Excluded siblings are echoed with their file
counts.

Multiple path arguments run as sequential shards by default: one browser per
argument, a directory argument keeping its files together. A notice says so,
since isolated instances do not exercise cross-argument state. `--no-shard`
restores one combined invocation.

A run with no paths must choose a mode: `--auto` (mach's own selection),
`--doctor` (Marionette preflight only) or `--canary [path]` (one short
browser-chrome test; `test.canaryPath` and `test.canaryTimeoutSeconds` give
the defaults).

## Several runs under one lock hold

Every `fireforge test` holds the engine-session lock for its whole run, so a
peer cannot build or replace the packaging record between sub-runs. Three
request shapes run more than one mach invocation in that one hold:

- **Mixed harnesses.** xpcshell and browser/mochitest paths in one request
  run as two invocations, xpcshell first. With `--build`, one pre-test build
  packages both halves.
- **`--repeat <n>`** runs the same selection n times, building and probing
  once, and reports every run, so a flaky suite's rate is visible from one
  invocation.
- **`--negative-control <diff>`**, below.

Each sub-run prints the verdict it would have printed alone as a
`FIREFORGE-RUN:` line (with `run=<i>/<n>` and, for a mixed request,
`harness=xpcshell|mochitest`). The invocation still ends with exactly one
`FIREFORGE-VERDICT:` line: `PASS runs=<n>/<n>`, or `FAIL reason=<most
structural failing run> [note=…] runs=<passed>/<planned>`. Runs continue
after a red or a crash; a preflight refusal or inconclusive run stops the
invocation. Every other option applies to each sub-run. `--repeat` and
`--negative-control` need explicit paths and cannot combine with
`--build-only`, `--canary` or `--auto`. The tree is judged against the
packaged runtime once per hold; packaging coverage is judged per run for its
own paths.

## Negative controls

A negative control proves a test can fail: neuter the code under test, run
the test, expect red. By hand on a shared engine this is dangerous, because
the objdir's chrome and widget files are symlinks into `engine/`, so a
mutation is live for every build and suite that touches the file while it is
in place. `fireforge test --negative-control <diff> <paths…>` makes the
control part of the run:

1. The diff is parsed and every hunk checked against the current file before
   anything else, so a stale control is refused (`note=negative-control`)
   before the build. A `components/` target is checked after the build,
   because the build redeploys it.
2. With `--build`, the pre-test build (including the Furnace deploy) runs
   first and packages the clean sources.
3. The selection is dispatched once unmutated (`run=baseline` on its
   `FIREFORGE-RUN:` line, one dispatch per harness half). Only a selection
   that is green without the mutation can show the mutation turned it red, so
   a baseline that is not green stops the invocation with nothing applied.
   **This doubles the cost of the first repetition:** every control pays one
   extra full dispatch of the selection.
4. After every gate has passed and right before the harness spawns, the
   control is applied. It stays until the run, every shard of it, has
   finished.
5. The files are restored byte-exact; the next repetition re-applies it, and
   the lock is released only after the last restore.

The diff is `git diff` output, a plain unified diff (`diff -u`; the path
comes from `---`/`+++`), or `git diff --no-index <engine file> <edited
copy>` (a new side outside `engine/` and `components/` targets the old
side). Paths may be project-relative (`engine/…`, `components/…`) or
engine-relative. A `components/custom/<name>/<file>.mjs|.css` or
`components/overrides/<name>/<file>` path is applied to the engine copy
Furnace deployed, which is what the run reads; component sources are never
touched. Only modifications of existing text files are accepted (created,
deleted, renamed, binary and symlinked targets are refused). Hunks must match
exactly, allowing a line offset as `git apply` does, never fuzz. A file named
by several sections is applied as one with every hunk in order; overlapping
hunks are refused.

The verdict reports the outcome as `control=`:

- `caught`: the baseline was green and every repetition went red with
  `reason=test-failures`, and, in a job's control step, at exactly the
  assertions the control names ([`proof.md`](proof.md)). Exit 0.
- `missed`: a repetition stayed green with the mutation in place. Exit 5.
- `inconclusive`: the baseline was not green (`note=baseline-red`, or the
  note of the gate that refused it, with `runs=0/<n>`), or a run crashed,
  found no tests, was refused or did not run. The exit code is that failure's.
  In a job's control step, reds at other assertions than the control names
  are `inconclusive` too (exit 5), and the run says which labels it saw.

The status word still describes what the harness saw, so a caught control
reads `FIREFORGE-VERDICT: FAIL reason=test-failures … control=caught` and
exits 0. Key success on `control=caught`, not on `PASS`. A control targets
what the objdir symlinks: a file the build preprocesses or copies is read
from the objdir, so a control on it stays green and reports `missed`; target
the file the browser actually loads.

A control on compiled source (C/C++, Rust, IDL, WebIDL, IPDL, or YAML no
install manifest ships; a header counts as compiled even when an `EXPORTS`
manifest copies it) can only reach the binary through a build. Without
`--build` it is refused before the lock. With `--build` the baseline runs on
a clean build first, then the control is applied before a second pre-test
build, which is a full `mach build` (a notice names the files; `mach build
faster` compiles nothing and would report `missed`). The verdict adds
`control-build=compiled`. After the last restore, still under the same hold,
FireForge runs one more full `mach build` and records a fresh baseline
(`control-restore-build=done|failed`), because restoring the source does not
unbuild the binary. The build records a `controlBuild` stamp that only a full
build clears: if the run is killed before that build, or it fails, the next
`fireforge test` refuses with `note=control-built` until `fireforge build`
succeeds, and `fireforge build --ui` keeps the stamp. A build-less compiled
control whose packaging is not current is refused before the lock with the
advice to add `--build`.

### Restore safety

- Apply, run and restore all happen inside the engine-session lock hold; a
  build that overwrites the mutation is refused rather than counted.
- Before the first mutated byte, every target's original bytes and a journal
  (original and mutated SHA-256, mode, timestamps) go to
  `.fireforge/negative-control/`. Writes are atomic.
- Restore writes the original bytes, mode and timestamps back and reads the
  file to prove it.
- A file is restored only while it still holds the bytes the control wrote. A
  file someone edited meanwhile keeps that edit, its original stays in the
  journal directory, and the run ends `FAIL reason=inconclusive
note=negative-control-restore` naming the paths. Reconcile by hand, then
  delete the directory.
- Pass, red, crash, refusal after apply, SIGINT and SIGTERM all restore
  before the locks are released.
- After a SIGKILL the journal survives: the next `fireforge test` checks for
  it first, restores a file still holding the control's bytes with a notice,
  and refuses any other state with `note=negative-control-pending`.

There is no `--mutate <file> <old> <new>` shorthand; a one-hunk diff expresses
the same edit and can be reviewed first.

## Build freshness

When packageable engine files changed since the last successful FireForge
build, `test` fails before launching stale artifacts. Use `--build` to
refresh, or `--allow-stale-build` for an intentional out-of-band rebuild. The
refusal prints the repackaging command for the requested paths
(`fireforge test --build-only <paths>`), so a build-less sitting can
repackage without dispatching anything.

No recorded build means nothing says the runtime matches the tree, so a
build-less run refuses with `note=no-build-baseline`. A record whose engine
commit no longer exists, as after `fireforge download --force`, counts as no
record: the refusal names the commit, and the first `fireforge build` treats
the build as unrecorded and runs in full even under `--ui`. Any other git
failure still refuses. `--allow-stale-build` accepts a runtime built outside
FireForge, and the verdict carries `baseline=none`. A pre-test build whose
record cannot be written stops the run with `note=baseline-write-failed`.
A build-less run judges all of this under the lock, and before requesting it
when a peer holds or is queued for it, so a refusal does not cost the wait.

Two kinds of edit do not count as stale, because the packaged runtime already
serves them (FireForge reads the objdir's install manifests to decide): a file
whose every objdir copy is a symlink resolving to the edited source, and a
test file the build does not package (installed only by `mach test` itself, or
by no manifest). A copy, a preprocessed file, a symlink that does not resolve
to the source, or an unreadable objdir keeps the edit stale. Exempted edits are
named on the run.

### Compiled sources newer than the binary

Every run also compares compiled sources changed since the last build (C/C++,
assembly, Rust, IDL, WebIDL, IPDL, YAML such as `StaticPrefList.yaml`, and
generator inputs such as `Bindings.conf` and `Cargo.toml`) with the time the
binary under test was last linked (`libxul` beside the launchable binary).
Sources under `test`, `tests`, `gtest`, `testing` or `taskcluster`
directories are not counted. A newer source means the run would test the
binary from before the edit, where a red reads as a failed fix. Without
`--build` the run refuses with `note=stale-compiled`, naming the files and
link time; `--allow-stale-build` turns it into a warning. With `--build` the
pre-test build escalates to a full `mach build` with a notice.

Every run that reaches dispatch stamps the binary's `BuildID` on the verdict
as `build-id=`.

### Packaging coverage

`--build-only` packages mixed-harness paths once, after which each half can
run without `--build`. Coverage is kept per staged path: each path of a scoped
build records its staging inputs (its manifest directory plus whatever a
manifest there names outside it: `support-files`, `head`, `!/` shared
fixtures) with their content at that build. A later scoped build keeps every
earlier path whose own inputs and `engine/mozconfig` are unchanged, whatever
moved elsewhere. A path whose inputs changed is dropped and named. A changed
input voids a claim only when the runtime could be missing it: an edit the
objdir already serves leaves the claim standing, while a changed manifest, a
copied input and a deleted one always count. Without a readable objdir index
every change counts. A scoped build after a full build carries the full
build's anchor forward while nothing outside its scope moved, so a later
build-less run over any path stays covered while that path's own inputs are
unchanged.

A refusal names the inputs that changed and who wrote the coverage record
(invocation, time, pid, `FIREFORGE_SESSION_ID`), so a peer can tell whose
build to wait for; `status --test-coverage` shows the same. The verdict names
the paths to rebuild as `build-paths=<path>,…`, so a script can retry with
`--build <paths>`. Retention is the default; `--extend-coverage` only turns a
drop into a refusal before the build. A baseline without complete staging
fingerprints cannot prove anything unchanged, so its claims are dropped once.

### Furnace components in a pre-test build

`test --build` and `--build-only` run `furnace apply` first, like `fireforge
build`, deploying every component whose `components/` source changed since its
last deploy, another session's undeployed edits included. They are named in a
notice and on the verdict (`furnace-applied=<names>`).
`--no-furnace-apply` (`--furnace-apply none`) packages `engine/` as it stands
and stamps `furnace-apply=skipped`. `--furnace-apply reached` (or
`test.furnaceApply: "reached"`) deploys only the components a requested test
reaches (the test path, test file, a `head*.js` beside it, or any test under
a requested directory); the rest are named and stamped
`furnace-skipped=<names>`. `all` is the default; a path-less build reaches
every component.

When `patchLint.checkJs` and `patchLint.checkJsTestFiles` are on, named
pre-test builds type-check the selected test scripts, including scripts no
patch owns yet, before the lock is requested, so a type error refuses at once.
An unowned `head*.js` that a named test loads joins the check, with a notice
naming the `re-export --scan --scan-file` command that adopts it.

### What a pre-test build costs

`test --build` runs `mach build faster`. Escalations are decided by comparing
build inputs with the last successful build in `.fireforge/last-build.json`,
not with engine HEAD:

- A changed `moz.build`, `moz.configure` or `Makefile.in` runs `mach
configure` first.
- A changed `jar.mn` escalates to a full `mach build` (minutes rather than
  seconds) only when it is a new manifest (untracked, so no install manifest
  exists for it yet) or its jar declaration has a bracketed base-directory
  prefix. An entry added to an existing `dist/bin` manifest does not
  escalate; a plain `fireforge build --ui` installs it. Any probe failure
  escalates, and the notice names the manifest and reason.

Each escalation is paid once per actual content change. `fireforge build
--ui` never escalates and carries the previous full build's `jar.mn` record
forward, so a registration made between a `build --ui` and the next `test
--build` still triggers the full build once.

## Shared browsers, ports and host state

Browser ownership is checked before a pre-test deployment and before full or
UI builds. A live or unreadable parent means busy, with the owner named when
known. `--kill-stale-marionette` terminates a recognized stale browser only
when its parent is dead and harness arguments match; a plain launchd-parented
app is left alone.

`test --wait-browser [seconds]` waits for this objdir's browser to exit;
`--wait-port [seconds]` waits for mochitest and Marionette listeners;
`build --wait-browser` queues a full or UI build behind the browser. Bare
flags wait 60 seconds; values accept 1-86400. They are separate from the lock
budget and are spent before the lock is requested, so a run waiting out a
browser does not hold every peer behind it. The run then joins the lock queue
and re-checks once under the lock. Checks that follow work already done under
the lock (after a `--build`, and between `--repeat` or `--negative-control`
runs) wait the budgets out again rather than throw the work away. A
path-shaped argument right after `--wait-lock`, `--wait-browser`,
`--wait-port` or `--shuffle` (a `/`, a file extension, or `.`) is a test
path, not the flag's value; a bare word is a usage error.

`--wait-port` makes sibling checkouts take turns. `--auto-ports` (or
`test.mochitestPorts: "auto"`) lets them run browser suites at the same time:
the engine's `runtests.py` moves each busy port to a free one, and FireForge's
own gates step aside, with a notice naming the holder, when the holder is not
this checkout's. This checkout's own leftovers are refused as in the default
mode. Auto mode applies only when the engine's `runtests.py` carries that
fallback (otherwise a notice says so) and never to `--doctor`. The default is
`"fixed"`. Desktop `mach mochitest` has no `--http-port` or `--ssl-port`.

Every dispatch samples the host before and after, and the verdict reports it,
because a headless timing failure on a sleeping display or on battery
otherwise reads like a product failure:

- `host-load=<n>`: highest load average seen; load of at least 4 or a
  process at 90% CPU also warns and stamps `host-cpu-warning=true`.
- `host-load-peak=<n>` and `host-load-peak-at=<s>`: the highest one-minute
  load average sampled every 30 s while a suite ran, and how many seconds
  after the run started; a peak of at least 4 also stamps
  `host-cpu-warning=true`. Absent on Windows, whose load average reads zero.
- `display=asleep|awake|unknown` (macOS `system_profiler`); starting asleep
  warns.
- `power-source=ac|battery|unknown` (macOS `pmset`); `power-changed=true`
  says both were seen.
- `host-slept=true`: the machine slept during a dispatch.

A sharded or repeated run reports its worst host. `unknown` means nothing was
measured. Perf sample JSON carries a `fireforgeHost` object, and a known
power-source change during a perf run is `FAIL reason=inconclusive
power-changed=true`.

### Profile overlays

Repeatable `--profile-file source=relative/destination` adds files to the test
profile:

```sh
fireforge test --perf-samples sample.json --profile-file arm.css=chrome/userChrome.css browser/base/content/test/perf/browser_perf.js
```

The source resolves from the project root; destinations stay relative with no
traversal. FireForge stages copies and merges only those directories into the
harness profile, preserving existing chrome files. A raw
`--extra-profile-file` collision is `reason=harness-arguments`.
`--perf-samples <path>` publishes a perf-sample artifact path to the harness
(exported as `<BINARYNAME>_PERF_SAMPLE_JSON`). `--restart-between-tests`
forwards mochitest's flag of the same name; it is refused for xpcshell and
generic dispatch.

## JavaScript coverage

```bash
fireforge test browser/base/content/test/example/browser_example.js --coverage artifacts/jscov
```

`--coverage <dir>` instruments runtime JavaScript for explicit suite-specific
mochitest or xpcshell dispatches. Each physical attempt, including retries,
gets a fresh directory, and the verdict names the final one as
`coverage=<path>`. Output contains per-process start/flush receipts, `.lcov`
files, native runtime `.info` files and `fireforge-coverage.json`. A complete
report requires every started process to have a matching successful flush,
positive discovered-global and `SF:` source counts that agree between receipts
and LCOV, and exactly one complete parent barrier for mochitest (outstanding
acknowledgements time out after ten seconds). Anything less (missing adapters
or receipts, collection errors, empty output) is a harness failure with
`note=coverage-incomplete`, so it cannot prove a caught control. The report
lists process IDs, missing PIDs, output files and `lostFiles`.

Generic mach dispatch, pathless selection, `--build-only`, `--canary` and
`--auto` refuse coverage. Xpcshell coverage requires a POSIX host. Use
uninstrumented runs for performance evidence.

## Cleaning up after a run

- Recognized harness crashes retry up to `--harness-retries <n>` times
  (default 2).
- Each dispatch records the PID and kernel start identity of every helper the
  harness announces (httpd, websocket server, SSL tunnel, process bridge,
  browser). After mach exits, an announced survivor is terminated only when
  that identity still matches, its command uses the exact objdir, and its shape
  matches the launch; identity is rechecked before each signal. The count is
  `orphans-reaped=<n>`.
- Helpers that are not announced (notably `moz-http2`, which starts in a new
  session without logging its PID) are reported and left alone: a path match or
  parent PID of 1 cannot tell them from a peer's process. Stop them by hand.
  A preflight census of helper-shaped processes is a diagnostic and never
  refuses a run; the `Orphaned harness workers` doctor check covers reparented
  Python workers.
- Each dispatch keeps its announced helpers in a ledger under
  `.fireforge/harness-helpers/`, removed when the dispatch ends, so a FireForge
  killed outright leaves it behind. The next run settles it before requesting
  the lock. `test.reapOrphans` (`report`, `reap` or `owned`) and
  `--reap-orphans` decide what happens: with `reap`, `owned` or the flag, the
  next run terminates the helpers the ledger names once the run that wrote it
  is provably gone (under the checks above) and adds to `orphans-reaped=<n>`;
  with `report` it signals nothing. A ledger whose writer is alive is never
  touched, and everything unannounced stays report-only. This runs first
  because survivors of a killed run keep its engine lock held through their
  process group.
- `fireforge test` spawns mach as leader of its own process group.
  A supervisor that kills its own group does not reach mach; send SIGTERM to
  FireForge, which forwards it to the mach group, escalates to SIGKILL after a
  grace period, reaps the tracked helpers and writes `FAIL reason=killed
signal=SIGTERM`. If the process above FireForge is SIGKILLed, FireForge
  notices the reparenting within about two seconds, writes `FAIL reason=killed
signal=parent-exit`, reaps the group and helpers, and ends the run.
- `--pgid-file <path>` publishes the harness group id on each mach spawn and
  removes it on controlled completion. After a SIGKILL it can be stale, so it
  is a locator, not authority to signal: revalidate ownership before killing
  anything, and never signal a number just because the file still holds it.
  Managed jobs quarantine resources when ownership is uncertain.

## The verdict line

Every test run ends with one machine-readable line:

```
FIREFORGE-VERDICT: PASS|FAIL reason=… [note=<class>] [started=<n>/<m> first-unstarted=<path> started-source=<src>] [unfinished=<n>] [shards=<p>/<t> [failed-shards=<labels>]] [runs=<p>/<n>] [control=<outcome>] [shuffle=<seed>] [orphans-reaped=<n>] [host-load=<n>] [host-load-peak=<n> host-load-peak-at=<s>] [host-cpu-warning=true] [host-slept=true] [display=<state>] [power-source=<source>] [power-changed=true] [baseline=none] [furnace-applied=<names>|furnace-apply=skipped] [furnace-skipped=<names>] [control-build=compiled] [control-restore-build=done|failed] [build-id=<id>] [drift-tolerated=<n>] [jobs=<n>] [upload-dirs=<dirs>] [lock=shared] [results=<path>] [coverage=<path>] [slot-generation=<a>/<b>] [build-paths=<paths>] [log=<path>]
```

Automation should branch on this line rather than on the process code, and
treat a missing verdict as a failure. The closed set of `reason=` values and
the stdout rules are in [`machine-output.md`](machine-output.md); `log=` names
the run's complete output ([`run-logs.md`](run-logs.md)). `reason=preflight`
covers every gate before the harness; a refusal that can classify itself adds
`note=<class>` (`stale-browser`, `coverage-replaced`, …), and its full text
is written to stdout before the verdict and into the run log. A sharded run
also prints a `FIREFORGE-SHARD:` line per shard and names failed ones as
`failed-shards=`.

### What counts as a pass

A run is never `PASS` when its summary reports unexpected results, when the
harness printed "Application shut down (without crashing) in the middle of a
test", or when a requested test file never produced a start (or skip) marker,
even if mach exited 0. Such a run is `FAIL reason=test-failures`, and a short
start count adds `started=<n>/<m> first-unstarted=<path>` (read from every
line the harness printed, with `started-source=` naming the evidence). A red
run carries the same count. A requested directory or manifest is counted
from the raw log: the tests its `suite_start` records announced, each needing
a start or a skip record; `--start-at` and `--end-at` turn that count off,
since the browser passes over announced tests without either.
Markers count only where the harness writes them (the start of a line, behind
its timestamp and level), so a test logging `TEST_START:` or `Failed: 2`
through `console.log` changes nothing.

An exit-0 run passes only when it shows it completed:

- With a raw log (`--results`, `--shard-size`, `--jobs`), the log decides:
  every requested file ended, no test is unfinished (`unfinished=<n>`), none
  reported an unexpected result, every requested directory ran something, and
  a `suite_end` closed the suite.
- Without one, the output must carry a positive check count and a completed
  suite (`SUITE_END` or the `Unexpected results:` summary), and every started
  test must have ended.
- A run with neither a count nor a summary is `FAIL reason=crash` (retried).
  A negative control therefore reads it as inconclusive, not caught.
- A summary that counted zero checks is `FAIL reason=no-tests`, whatever the
  exit code, since a hang and a browser dying at startup print the same `Ran 0
checks`.
- The closing `TEST-START | Shutdown` of a browser run is the harness's
  teardown, not an unfinished test.

A green summary speaks only for the suite it closes, so a non-zero exit after
one passes only when recognized noise owns the exit: the resource-monitor
traceback (`AttributeError: 'SystemResourceMonitor' object has no attribute
'stop_time'` or `'poll_interval'`, from `resourcemonitor.py`, after a
`SUITE_END`), its degradation warnings, or a telemetry traceback mach caught.
It never passes when the process died on a signal (including SIGKILL or
SIGTERM relayed as exit 9 or 15), or when any other traceback followed the
last `SUITE_END`. In a terminal the recognized resource-monitor traceback is
collapsed to one `[FireForge]` line; captures and the run log keep it raw.
Builds print it verbatim with a note.

Exit 14 (`INCONCLUSIVE`) is not red: `engine/` moved while the harness ran and
the result was thrown away. Exit 15 (`LOCK_TIMEOUT`) means the run never
started. See [`exit-codes.md`](exit-codes.md).

## Concurrency options

A test run holds the engine-session lock and measures the engine before and
after the harness, failing the verdict as invalid if the tree changed in a way
the running browser can see (a file the objdir links to its source, a file
staged at dispatch, or a test file or staging input of the run). A peer's edit
to anything else leaves the verdict standing with a warning and
`drift-tolerated=<n>`; the next invocation's stale-build gate judges whether it
needs a rebuild. A `--perf-samples` run fails only when HEAD moved or a changed
path is packaged by the running build.

`--shared-lock` (or `test.lockMode: "shared"`) holds the lock shared for a
build-less run with no negative control and auto ports, so several such runs on
one objdir overlap. Anything that writes still holds the lock alone: it waits
for shared holders, and new shared holders queue behind it. `status --lock`
counts shared holders.

`--jobs <n>` runs a request's shards on n harness instances inside one lock
hold. It requires auto ports. Each instance has its own profile, Marionette
port and mochitest test list; output lines carry a `[job <i>]` prefix. A
`--jobs` run always reads each dispatch's raw log, and a dispatch whose log
starts none of its requested files fails with `started=0/<m>`. With
`--no-shard` or a single directory, the files are split into n contiguous
chunks. Parallel browsers raise host load, so measure first. When the caller
sets `MOZ_UPLOAD_DIR`, each instance gets `<MOZ_UPLOAD_DIR>/job-<i>`, named on
the verdict as `upload-dirs=`. On more than one instance FireForge holds
placeholder listeners on the mochitest HTTP, ssltunnel and WebSocket ports
(8888, 4443, 9988) so every instance's busy-port probe fails and each falls
back to its own port; each `FIREFORGE-SHARD:` line carries its
`ports=http:<n>,ssl:<n>,ws:<n>`. A server that still fails to start is
retried within `--harness-retries` and reported as `reason=server-startup`,
not `no-tests`.

`--shard-size <n>` dispatches n files per mach invocation (mochitest restarts
the browser between files), paying the harness start once per chunk and
judging each file from mozlog's structured log; `shards=` then counts files.

`--shuffle` permutes isolated mochitest path arguments and prints the seed;
`--shuffle=<seed>` replays that order. A directory remains one invocation, and
`--no-shard` disables the permutation. Native mach `--shuffle` within an
invocation is forwarded unseeded. `FIREFORGE_SHUFFLE_SEED=<seed>` is available
to a custom `head.js`, and `shuffle=<seed>` is on the verdict. Mochitest only.

## The results document

`--results <path>` writes one JSON record per test file and `--repeat` run
(status, expected status, duration, unexpected subtests, shard, and the
run-log line where the dispatch began) from mozlog's structured log, and names
it on the verdict as `results=<path>`. A `--log-raw <file>` already forwarded
with `--mach-arg` is read instead. A harness-level record (`test` is
`automation.py`, such as a hung browser's TIMEOUT) also carries `shardFiles`,
and `file` when the shard has exactly one.

The document is `schemaVersion: 1`. `dispatches` entries keep `run`, `shard`,
`requested`, `started`, `completed`, `skipped`, `unfinished` and `attempts`
separately; selected files are not assumed to have executed. `run` in `files`
and `unfinished` is 1 or more. A negative control's unmutated baseline is not
one of its runs: its records sit in a `controlBaseline` object with the same
two lists, and its `dispatches` entry has `run: 0`. File results can include
mozlog `unexpectedAssertions` labels and `unexpectedAssertionResults` entries
(`assertion`, `status`, `expected`), which distinguish a failing assertion
from an unexpected pass. An xpcshell entry's `assertion` is the task name, and
its `message` is the failing assertion's own text.

A negative-control invocation also records `controls[]`: per repetition
(`run`, `dispatch`, `harness`), `diffDigest`, `mutationVerified` (the mutated
bytes and mode were reread immediately before dispatch), `restored`,
`compiled`, `compiledRestoreBuild` (`done|failed|not-built`) and per target
`path`, `originalSha256`, `mutatedSha256`, `mode`, `restoredSha256` and
`restoredMode`. Missing evidence, `restored: false`, mismatched hashes or
modes, or a failed restore build cannot prove cleanup. The record alone does
not prove a test caught the intended failure: a consumer must also require the
exact dispatch roster and the expected assertion's unexpected status. Those
obligations belong to the job or proof plan ([`proof.md`](proof.md)).

## Output verbosity

mozbuild quiets terminal output when it detects a coding agent
(`CLAUDECODE`). The build half is useful; the test half removes `TEST_START`
and console INFO, which a hang diagnosis needs and which FireForge's
classifier reads (`Ran N checks`, `Unexpected results:`,
`TEST-UNEXPECTED-*`), pushing runs toward `reason=no-tests`. `--full-output`
unsets the marker for test dispatches only; the build path stays quiet.

## Before launch

Checks that need no lock run before it is requested: the launchable binary, the
named-file checkJs pass and the `--wait-browser`/`--wait-port` budgets. The run
log is open from the start, so a `reason=lock-timeout` line carries `log=`.

`test` checks for the launchable binary and names the cause when the bundle is
incomplete. Every protected build (`build`, `build --ui`, `test --build`)
records itself in `.fireforge/build-run.json` while it runs; a failed or
interrupted build leaves the record, and the refusal
(`note=no-launchable-binary`) says which command was interrupted or failed and
when. A missing binary while a build is still running is not refused: the run
queues behind it.

In dev builds, files under `obj-*/dist/bin` may be symlinks into the source
tree (prefs, chrome JS and CSS, deployed widgets), so edit source prefs
directly and back up before bisection experiments. A running suite reads
`engine/` when its browser loads a file, after any `--build` step: `Build
complete` is not a snapshot. An edit made before the `FIREFORGE-VERDICT` line,
yours or a peer's, can reach the running suite, so keep a temporary edit in
place until the verdict, or use `--negative-control`.

## Commands that take the objdir as it stands

`fireforge package` ships what the last build left and writes nothing to the
engine first. It refuses a binary that still carries a negative control. It
also refuses, unless `--allow-stale-build` is passed, when no build is
recorded, when packaged or compiled sources moved past the recorded build, and
when Furnace components have undeployed edits. Run `fireforge build` first.

`fireforge run` launches regardless, since looking at an old build can be the
point, and warns about a carried control or a tree past the build.
