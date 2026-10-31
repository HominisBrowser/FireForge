<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Running tests

`fireforge test` wraps `mach test`. Most of what follows exists because
mach's own defaults are wrong for a fork that has to know exactly what ran.

## Scope is exact

`fireforge test <directory>` runs exactly that directory. FireForge
enumerates the directory's test files and passes the explicit file list to
mach in one invocation, so mach's prefix-based path matching cannot quietly
sweep in sibling directories that share the name prefix. Excluded siblings
are echoed with their test-file counts.

Multiple path arguments run as sequential shards by default: one browser
instance per argument, with a directory argument keeping its files together.
FireForge announces this with a notice, since isolated instances do not
exercise cross-argument state. `--no-shard` restores one combined
invocation.

## Several runs under one lock hold

Every `fireforge test` holds the engine-session lock for its whole run. Three
request shapes run more than one mach invocation inside that one hold, so a
peer cannot take the lock, build, or replace the packaging record between
them:

- **Mixed harnesses.** xpcshell and browser/mochitest paths in one request
  run as two consecutive mach invocations, the xpcshell half first. With
  `--build`, one pre-test build packages both halves (its coverage claim is
  the union), and the second half runs build-less against it.
- **`--repeat <n>`** runs the same selection n times. A `--build` builds
  once, and `--doctor` probes once. Every run is reported, so a flaky suite's
  rate is visible from one invocation.
- **`--negative-control <diff>`**, below.

Each sub-run prints the verdict it would have printed alone as a
`FIREFORGE-RUN:` line (its own status, reason and counts, plus
`run=<i>/<n>` and, for a mixed request, `harness=xpcshell|mochitest`). The
invocation still ends with exactly one `FIREFORGE-VERDICT:` line:
`PASS runs=<n>/<n>`, or `FAIL reason=<most structural failing run>
[note=…] runs=<passed>/<planned>`. Runs continue after a red or a crash; a
preflight refusal or an inconclusive run stops the invocation, since the
runs after it would not be comparable. `--mach-arg` and every other option
apply to each sub-run. `--repeat` and `--negative-control` need explicit
paths and cannot be combined with `--build-only`, `--canary` or `--auto`.

## Negative controls

A negative control proves a test can fail: neuter the code under test, run
the test, and expect red. Done by hand on a shared engine it is dangerous.
The objdir's chrome and widget files are symlinks into `engine/`, so the
browser reads the sources when it loads them, after the build step. A
mutation is therefore live for every build and suite that touches the file
while it is in place: a peer's `test --build` can build and test the
neuter, a `--build` run re-deploys `components/` over an engine-side
control, and a neuter restored at `Build complete` (or after the first
`TEST_START`) is already gone for the later shards of the same run.

`fireforge test --negative-control <diff> <paths…>` makes the control part
of the run:

1. The diff is read (resolved against the project root), parsed, and every
   hunk is checked against the current file before anything else, so a
   stale control is refused (`note=negative-control`) before the build. A
   `components/` target is checked after the build instead, because the
   build redeploys it.
2. With `--build`, the pre-test build (including the Furnace deploy)
   runs first and packages the clean sources.
3. After every gate has passed and right before the harness spawns, the
   control is applied. It stays in place until the run, every shard of it,
   has finished.
4. The files are restored byte-exact. Then the next repetition (if any)
   re-applies it, and only after the last restore is the lock released.

The diff is `git diff` output (a `diff --git` header per file). Paths may be
project-relative (`engine/…`, `components/…`) or engine-relative, so both
`git diff` at the project root and `git -C engine diff` work. A
`components/custom/<name>/<file>.mjs|.css` or
`components/overrides/<name>/<file>` path is applied to the engine copy
Furnace deployed it to, since that is what the run reads; the component
source itself is never touched. Only modifications of existing text files
are accepted: a created, deleted, renamed or binary file, or a symlinked
target, is refused. Hunks must match exactly; the only tolerance is a line
offset, as in `git apply`, never fuzz. A file named by more than one
section (a generator that writes one section per edit) is applied as one
section with every hunk in file order; sections whose hunks overlap are
refused, with the advice to write one section for the file.

The verdict says how the control came out with `control=`:

- `caught`: every repetition went red with `reason=test-failures`, which is
  what a control is for. The invocation exits 0.
- `missed`: a repetition stayed green with the mutation in place, so the
  selected tests do not detect it. Exit 5, like a red suite.
- `inconclusive`: a run crashed, found no tests, was refused, or did not
  run. The exit code is that failure's.

The status word keeps describing what the harness saw, so a caught control
reads `FIREFORGE-VERDICT: FAIL reason=test-failures … control=caught` and
exits 0. Key a control's success on `control=caught`, not on `PASS`.

A one-run control keeps its own counts on the verdict line; a repeated or
mixed one aggregates them as above. The mutation targets what the objdir
symlinks. A file the build preprocesses or copies (rather than links) is
read from the objdir, not from `engine/`, so a control on it stays green
and reports `missed`: that result is the signal to target the file the
browser actually loads.

A control on compiled source (C/C++, Rust, IDL, WebIDL, IPDL or YAML that no
install manifest ships) can only reach the binary through a build. A
header (`.h`, `.hh`, `.hpp`, `.ipdlh`) counts as compiled even when an
`EXPORTS` install manifest copies it into `dist/include`: that copy only feeds
other compiles. Without
`--build` it is refused before the lock. With `--build` it is applied before
the pre-test build, so the binary under test carries it, and is restored
with a fresh mtime so the next build recompiles the original. Every
`--repeat` run (and a mixed request's second half) tests that same binary,
with the source applied again before its dispatch and restored after it:
those runs accept their own invocation's `controlBuild` stamp and the
control files' fresh mtimes instead of refusing with `note=control-built`
or `note=stale-compiled`. That pre-test build is a full
`mach build`, with a notice naming the control's files: the default
`mach build faster` compiles nothing, so the control would still test
the previous binary and report `missed`. The verdict adds
`control-build=compiled`.

FireForge also rebuilds after such a control. Restoring the
source byte-exact does not unbuild the binary, which would keep the mutation
until the next full build, so every later run would test the control. After the last
run's restore, still under the same lock hold, it runs one more full
`mach build` and records a fresh baseline. The verdict adds
`control-restore-build=done` (or `=failed`). The baseline the control's build
writes carries a `controlBuild` stamp (diff file, targets, time applied) that
only a full build clears: if the run is killed before the restore build, or
that build fails, the next `fireforge test` refuses with `note=control-built`
until `fireforge build` succeeds, and a `test --build` escalates to a full
build. `fireforge build --ui` compiles nothing and keeps the stamp. A
build-less control whose packaging is not current is refused before the
lock with the advice to add `--build`, instead of ending `inconclusive`
after a full queue.

Besides `git diff` output, a control may be a plain unified diff
(`diff -u`, no `diff --git` lines; the path comes from `---`/`+++`) or a
`git diff --no-index <engine file> <edited copy>`: when the new side names a
copy outside `engine/` and `components/`, the control targets the old side.

### The restore safety model

- **Only under the lock.** Apply, run and restore all happen inside the
  engine-session lock hold of the `fireforge test` invocation, and the
  control is applied after the pre-test build. No peer build or test
  observes it, and the build cannot overwrite it or trip `stale-build`
  over it.
- **Journal first.** Before the first mutated byte is written, the
  original bytes of every target go to `.fireforge/negative-control/`
  with a journal of each file's original and mutated SHA-256, mode and
  timestamps. Every write (originals, journal, mutation, restore) is an
  atomic temp-file-and-rename. A failure while writing the mutation puts
  back whatever was written before the run can start.
- **Byte-exact restore, verified.** Restore writes the original bytes back,
  re-applies the original mode and timestamps (so make-based tooling sees
  no change either), and reads the file back to prove the bytes match. The
  stale-build gate hashes content, so a repeated control's next run is not
  refused.
- **Never clobber.** A file is only restored while it still holds exactly
  the bytes the control wrote. A file someone edited while the control ran
  (an agent working outside the lock, say) keeps that edit. Its original
  stays in the journal directory, and the run ends
  `FAIL reason=inconclusive note=negative-control-restore` with the paths
  named. Reconcile by hand, then delete the directory.
- **Every exit path.** Pass, red, crash and a refusal after the apply all
  restore in the run's own control flow. SIGINT and SIGTERM restore in the
  signal pipeline after the harness has shut down and before the held
  locks are released. A restore already in flight is awaited, not
  repeated.
- **The binary too.** A compiled control's binary is rebuilt
  after the restore, under the same hold, and a binary still carrying a
  control is refused (`note=control-built`) rather than tested. See above.
- **Even after SIGKILL.** A SIGKILLed FireForge cannot restore, but the
  journal survives it. Every later `fireforge test` checks for it first,
  under the lock, before any gate or build: a file still holding the
  control's bytes is restored, with a notice; any other state refuses with
  `note=negative-control-pending` rather than guess.

There is no `--mutate <file> <old> <new>` shorthand. Commander options take
one value, so a three-value option would have to swallow the positional test
paths. A one-hunk diff expresses
the same edit and can be reviewed before it runs.

## Pathless runs must choose a mode

- `--auto` forwards mach's own auto-selection.
- `--doctor` runs the Marionette preflight only.
- `--canary [path]` runs one short browser-chrome canary
  (`test.canaryPath` and `test.canaryTimeoutSeconds` in `fireforge.json`
  provide the defaults).

## Build freshness

When packageable engine files changed since the last successful FireForge
build, `test` fails before launching stale artifacts. Use `--build` to
refresh, or `--allow-stale-build` only for intentional out-of-band rebuilds.
The refusal prints the one-line repackaging command for the requested paths
(`fireforge test --build-only <paths>`), so a build-less sitting can
repackage without dispatching anything.

Two kinds of edit do not count as stale, because the packaged runtime
already serves them. FireForge reads the objdir's install manifests
(`obj-*/_build_manifests/install/*`, `obj-*/faster/install_*`) to decide:

- a file whose every objdir copy is a symlink resolving to the edited source
  (the usual dev-build shape on macOS and Linux for chrome scripts and test
  files);
- a test file the build does not package: one installed only by `mach test`
  itself at dispatch (`_test_files`), or a test-tree file no manifest installs.

A copy, a preprocessed file, a symlink that does not resolve to the source,
or an unreadable objdir keeps the edit stale. Exempted edits are named on
the run (and in the refusal, when other edits are stale). On a
`--perf-samples` run the refusal also says which stale files are staging
inputs of the sampled test and which lie elsewhere, so a sample whose fixture
is unaffected can proceed knowingly under `--allow-stale-build`.

### Compiled sources newer than the binary

The packaging check above judges packaged files only. Every run
also compares the compiled sources changed since the last build (C/C++,
Rust, IDL, WebIDL, IPDL, and YAML such as `StaticPrefList.yaml`) with the
time the binary under test was last linked: the newer of the launchable
binary and the `libxul` beside it. Sources under `test`, `tests`, `gtest`,
`testing` or `taskcluster` directories never reach that binary and are not
counted. A newer source means the run would test the binary from before the
edit, where a red reads as a failed fix. Without `--build` the run refuses
with `note=stale-compiled`, naming the files and the link time, and suggests
`fireforge build` or `test --build`; `--allow-stale-build` turns the refusal
into a warning. With `--build` the pre-test build escalates to a full
`mach build` with a notice, since `mach build faster` compiles nothing.

Every run that reaches dispatch also stamps the binary's `BuildID` (from the
`application.ini` beside it, the `moz:buildID` the browser reports) on its
verdict line as `build-id=`, so a result can be matched to the build it ran
against.

### Packaging coverage

`--build-only` packages mixed-harness paths once, and then each harness half
can run without `--build`. A plain mixed `test --build` does both in one
invocation (see [Several runs under one lock hold](#several-runs-under-one-lock-hold)). Coverage is kept per staged path. Each path of a
scoped build records its own staging inputs: its manifest directory (the
nearest directory at or above it with a test manifest) plus whatever a
manifest there names outside it (`support-files`, `head`, `!/` shared
fixtures), with their content at that build. A later scoped build keeps every
earlier path whose own inputs and `engine/mozconfig` are unchanged, whatever
moved elsewhere in the engine, including a peer's edits and an engine HEAD
move that touches none of them. A path whose inputs changed is dropped and
named, with the inputs that changed. Changed inputs this build restages are
allowed, and a scoped build of one file restages that file's test manifest
too: a manifest that gained an entry for the new file does not drop the
claims of its sibling files. A build-less run's packaging gates also run
before the lock is requested, so a `coverage-replaced` or `stale-build`
refusal arrives before the run queues.

A scoped build after a full build keeps the claim full while nothing outside
its scope moved. Otherwise it carries the full build's anchor forward, and a
later build-less run over any path stays covered while that path's own
staging inputs are unchanged since the full build. A refusal names the inputs
that did change, and who wrote the coverage record: its
invocation, when, and the writing process's pid (marked `still running`
while it is), `FIREFORGE_SESSION_ID` and invocation id, the id its history
records carry. `status --test-coverage` shows the pid and session too. A
peer whose run a scoped build or a test-file edit refused can tell whose
build to wait for. The verdict line names the paths the refusal tells you
to rebuild as `build-paths=<path>,…`, so a script can retry with
`--build <paths>` without parsing the refusal text (see
[`machine-output.md`](machine-output.md#the-additive-note-key)).

Retention is the default, so `--extend-coverage` only turns a drop into a
refusal before the build. A baseline without complete staging-input
fingerprints cannot prove anything unchanged, so its claims are dropped once.

A scoped build records its request paths normalized (no trailing `/`, no
`./`), as the baseline validator requires. An invalid baseline's refusal
names the first failing field and its value, and when that field is part of
the coverage claim it offers rerunning with `--build` as well as
`fireforge build`. Dirty paths are fingerprinted unquoted, so a non-ASCII
file name does not make the baseline invalid.

### Furnace components in a pre-test build

`test --build` and `--build-only` run `furnace apply` first, like
`fireforge build`, and that apply deploys every component whose
`components/` source changed since its last deploy, another session's
undeployed edits included. The run names those components in a notice and
on the verdict line (`furnace-applied=<names>`). `--no-furnace-apply`
packages `engine/` as it stands, for example for a before-capture, names the
components with undeployed edits it left out, and stamps
`furnace-apply=skipped`.

On a shared engine a peer's default `test --build` deploys every session's
undeployed component edits. `--furnace-apply reached` (or
`test.furnaceApply: "reached"`) deploys only the components a requested test
reaches: the test path, the test file, a `head*.js` beside it, or any test
file under a requested directory names the component. The rest are named in
a notice and stamped `furnace-skipped=<names>`. A path-less build reaches
every component. `--furnace-apply none` is `--no-furnace-apply`; `all` is the
default.

When `patchLint.checkJs` and `patchLint.checkJsTestFiles` are enabled, named
pre-test builds check the selected test scripts before deployment or mach.
This includes new scripts not yet owned by an exported patch. The check runs
before the engine lock is requested, so a type error refuses at once instead
of after a place in the lock queue. An unowned `head*.js` in a named test's
directory joins the check when that test loads it with `loadSubScript` or a
manifest beside it lists it in `support-files`, so a suite moved onto a new
support head can be proven before the head is exported. A notice names each
such head and the `re-export --scan --scan-file` command that adopts it.

`--restart-between-tests` forwards mochitest's flag of the same name, which
restarts the browser between test files (the run shape a manifest's
`standalone` key asks for). It is refused for an xpcshell or generic
dispatch, like `--shuffle`.

### Shared browsers, ports and host state

Browser ownership is checked before a pre-test deployment and before full
or UI builds. A live or unreadable parent means busy, with its owner named
when available. `--kill-stale-marionette` requires a dead parent plus harness
arguments; a profile argument alone does not prove abandonment. A plain
launchd-parented app remains unattributed and is not automatically killed.

`test --wait-browser [seconds]` waits for this objdir's browser to exit;
`test --wait-port [seconds]` waits for mochitest and Marionette listeners.
`build --wait-browser [seconds]` queues a full or UI build behind the browser.
Bare flags wait 60 seconds; explicit values accept 1–86400 seconds. They are
independent of the FireForge lock budget, and they are spent BEFORE the
engine session lock is requested, so a run waiting out a browser or a port
does not hold every peer's build, test and re-export behind it. The run then
joins the lock queue and re-checks once under the lock; the normal preflight
refusal and its remedy apply if the resource is busy again (or still busy)
there. A check that follows work the run already did under the lock waits
the budgets out again instead: the browser and port checks after a
`--build` run's pre-test build, and those of every later run of a `--repeat`
or `--negative-control` sequence, so a peer's browser that started during
the build does not throw the build away. With `--kill-stale-marionette` a reapable stale browser counts as
clear before the lock, and the port waits stay under the lock, where the
stale listener can be reaped.

A path-shaped argument right after `--wait-lock`, `--wait-browser`,
`--wait-port` or `--shuffle` (it has a `/`, a file extension, or is `.`) is
a test path, not the flag's value, and the flag takes its default:
`fireforge test --wait-lock browser_x.js` waits 60 seconds and runs
`browser_x.js`. A bare word (`--wait-lock soon`) is still a usage error.

`--wait-port` makes sibling checkouts take turns. `--auto-ports` (or
`test.mochitestPorts: "auto"` in `fireforge.json`) lets them run browser
suites at the same time. Desktop `mach mochitest` has no `--http-port` or
`--ssl-port` option; those exist only for Android and iOS. Recent engines
do something better instead: `testing/mochitest/runtests.py` bind-probes
the HTTP server, ssltunnel and WebSocket ports before starting its servers,
and the Marionette port before launching the browser, moves each busy one to
a free port, and routes `mochi.test:8888` to wherever the server landed.
In the default mode FireForge's own refusal fires before that fallback can.
In auto mode the mochitest-server and Marionette gates step aside, with a notice
naming the holder, when the holder is not this checkout's own (a sibling
checkout's live suite or an unrelated listener). This checkout's own
leftovers are refused exactly as in the default mode, and `--kill-stale-marionette`
still applies to them. Auto mode takes effect only when the engine's
`runtests.py` carries the fallback; otherwise a notice says so and the
default refusal stays. It never applies to `--doctor`'s Marionette probe,
which launches its own browser on that port. The default is `"fixed"`.

Every suite samples host load and the highest CPU process before and after
dispatch. Load at least 4 or a process at least 90% CPU produces a warning;
verdicts include `host-load` and, when needed, `host-cpu-warning=true`.
Perf runs include `power-source=ac|battery|unknown`; on macOS this comes from
`pmset -g ps`, including charging on AC. Sample JSON carries a `fireforgeHost`
object with start/end states and `powerSourceChanged`. A known power-source
transition produces `FAIL reason=inconclusive power-changed=true`.
Unknown power state is reported without inventing a transition.

### Profile overlays

Use repeatable `--profile-file source=relative/destination` to add files to
the test profile, for example:

```sh
fireforge test --perf-samples sample.json --profile-file arm.css=chrome/userChrome.css browser/base/content/test/perf/browser_perf.js
```

The source resolves from the project root. Destinations must stay relative
with no traversal. FireForge stages copies and merges only those staged
directories into the harness profile, preserving existing chrome files.
A raw `--extra-profile-file` directory collision is classified as
`reason=harness-arguments` and names this remedy rather than a rebuild.

### What a pre-test build costs

`test --build` runs `mach build faster`. Two escalations are possible, and
both are decided by comparing build inputs against the last successful build
recorded in `.fireforge/last-build.json`, not against engine HEAD, since a
fork's worktree is permanently dirty from imported patches and
Furnace-applied components:

- A changed `moz.build`, `moz.configure` or `Makefile.in` runs
  `mach configure` first.
- A changed `jar.mn` escalates the whole build to a full `mach build`
  (minutes rather than seconds), but only when it is a new manifest
  (untracked in the engine repo, so no install manifest exists for it yet),
  or when its jar declaration carries a bracketed base-directory prefix,
  which redirects the install destination away from the default chrome root.
  An entry added to an existing `dist/bin` manifest does not escalate. Any
  probe failure (an unreadable manifest, no git) escalates, and the notice
  names the manifest and the reason.

Each escalation is paid once per actual content change. A `jar.mn` that is
dirty against HEAD but byte-identical to what the last full build consumed
does not escalate again. `fireforge build --ui` is itself a
`mach build faster` and never escalates. The `jar.mn` record it writes is
carried forward from the previous full build, so a registration made between
a `build --ui` and the next `test --build` still triggers the full build
once.

An entry added to an existing `dist/bin` `jar.mn` needs no full build: a
jar-only registration of a new content file is installed by a plain
`fireforge build --ui` (`faster/install_dist_bin_browser` names the
destination, and the file reaches `dist/bin` and the `.app` bundle) and is
then fetched over `chrome://` by a plain `fireforge test`. A new `jar.mn`
file and a non-default install destination have no such evidence and
escalate: relaxing a stale-artifact guard without evidence trades
a slow build for a silently wrong test.

## Resilience

- Recognized harness crashes retry up to `--harness-retries <n>` times
  (default 2).
- `--kill-stale-marionette` terminates recognized stale browsers.
- Every dispatch runs a census of orphaned harness helpers (`xpcshell`, the
  harness httpd, `pywebsocket`, `ssltunnel`, `moz-http2`) that survived an
  earlier run in this project's objdir. It runs at preflight, before this run
  spawns anything, so every hit is necessarily a survivor. A match has to be
  objdir-anchored, since `xpcshell` and `server.js` are far too generic to
  report on their own, and structural: the process's executable is a helper
  binary, or an interpreter whose script argument is a helper script. A
  process that merely mentions such a path (an editor, a `grep`, the shell
  FireForge runs under) is not a helper, and FireForge's own ancestors are
  never candidates. Survivors slow every later run without appearing in
  its output. The usual symptom is a three-second suite taking minutes of
  wall clock. The census is report-only by default; `--reap-orphans`, or
  `test.reapOrphans: "reap"` in `fireforge.json`, terminates what it finds
  (SIGTERM, a 500 ms grace, SIGKILL). It never refuses a run. Every reap is
  stamped on the verdict line as `orphans-reaped=<n>`. A different shape,
  reparented Python `multiprocessing` workers, is covered by the
  `Orphaned harness workers` doctor check.
- Every dispatch owns its own kill path. The harness announces what it
  launches (`runtests.py | Server pid: <n>`, the websocket server, the SSL
  tunnel, the websocket/process bridge, and the browser as `Application
pid`); FireForge tracks those pids and, after mach has exited for any
  reason (a clean finish, a harness crash before a retry, a no-output
  timeout, a forwarded SIGTERM, the parent-exit watchdog below), terminates
  any of them still alive. A tracked pid is re-read from `ps` first and must
  still be anchored to this objdir and still look like the thing that was
  launched, so a recycled pid is never signalled. One helper is never
  announced: mozserve starts `moz-http2` in a session of its own and logs no
  pid, so it is in neither the group nor the announcements. For it, FireForge
  snapshots the same-objdir helpers before the dispatch spawns and, after
  mach exits, reaps any helper-shaped process under this checkout's absolute
  objdir that is new since that snapshot and reparented to launchd. An
  earlier run's survivor is in the snapshot and stays the census's call. This
  reap runs inside the exec layer's close path, so the signal handler's
  bounded child-shutdown wait covers it. The count joins `orphans-reaped=`.
- FireForge watches its own parent while a dispatch runs. A supervisor that
  SIGKILLs the process above `fireforge test` (an `npm run` step killed at
  its bound) signals nothing below it; FireForge notices the reparenting
  within about two seconds, writes `FIREFORGE-VERDICT: FAIL reason=killed
signal=parent-exit`, reaps the harness process group and the tracked
  helpers, and ends the run without classifying or retrying.
- `--perf-samples <path>` publishes a perf-sample artifact path to the
  harness (exported as `<BINARYNAME>_PERF_SAMPLE_JSON`).

## Process groups and supervisors

`fireforge test` spawns mach as the leader of its **own** process group
(`detached: true`), so that FireForge can signal the whole harness tree with
one negative-pid kill and sweep the group after mach exits. Two consequences
for anything that supervises `fireforge test`:

- A supervisor that kills _its own_ process group (`kill -- -<npm pid>`) does
  not reach mach: mach is not in that group. Killing the `npm`/`node` chain
  above FireForge leaves the harness tree running.
- SIGTERM to FireForge is the right signal. FireForge forwards it to the
  mach group, escalates to SIGKILL after a grace period, sweeps the group,
  reaps the tracked helpers, and writes `FAIL reason=killed signal=SIGTERM`.
  (That line, like the watchdog's `signal=parent-exit` line, is written
  before the teardown reap runs, so it cannot carry `orphans-reaped=`; the
  reap reports to stderr.)
- A supervisor that has to SIGKILL FireForge should pass
  `--pgid-file <path>`. FireForge rewrites the file with the harness group id
  on every mach spawn (each retry attempt and shard) and removes it when the
  run ends under its own control. After a SIGKILL the file is still there:
  `kill -TERM -- -$(cat <path>)`, then `-KILL`, takes mach and every helper
  that shares its group. Two processes are outside it: the browser
  (mozprocess puts it in a group of its own) and `moz-http2` (mozserve
  starts it in its own session). A SIGTERM to the group gives `runtests.py`
  the chance to run its own cleanup, which normally takes the browser with
  it; nothing takes `moz-http2`, so after a SIGKILL of FireForge it stays
  until the next run's census, which is why that run should carry the reap
  posture. A browser that does survive is the Marionette preflight's and
  `--kill-stale-marionette`'s to remove.

The mochitest helpers (httpd, websocket server, ssltunnel, process bridge)
are plain children of `runtests.py` and share mach's group. The browser and
`moz-http2` do not, which is why the teardown reap above exists alongside the
group sweep.

## The verdict line

Every test run ends with one machine-readable line:

```
FIREFORGE-VERDICT: PASS|FAIL reason=… [note=<class>] [started=<n>/<m> first-unstarted=<path> started-source=<src>] [shards=<p>/<t> [failed-shards=<labels>]] [runs=<p>/<n>] [control=<outcome>] [shuffle=<seed>] [orphans-reaped=<n>] [furnace-applied=<names>|furnace-apply=skipped] [furnace-skipped=<names>] [jobs=<n>] [lock=shared] [results=<path>] [log=<path>]
```

The start count reads every line the harness printed, not the last 2 MB of
captured output, so a suite printing more than that (a large browser
directory, or any run under `--full-output`) does not report files that ran
and passed as never started. `started-source=` names the evidence. A sharded run also
prints a `FIREFORGE-SHARD:` line per shard and names the shards that did not
pass as `failed-shards=`; see [`machine-output.md`](machine-output.md).

A run is never `PASS` when its summary reports unexpected results, when the
harness printed "Application shut down (without crashing) in the middle of a
test", or when a requested test file never produced a start (or skip)
marker, even if mach exited 0. A browser that quits cleanly mid-suite does
exactly that: the counts then cover only the files that ran. Such a run is
`FAIL reason=test-failures`, and a short start count adds
`started=<n>/<m> first-unstarted=<path>`: how many requested files started,
and the first, in dispatch order, that never did. The file count is only
taken when the output's start lines name the requested files; an xpcshell
dispatch that proves execution with a result summary alone is not counted.

Automation should branch on this line rather than on the raw process code,
and has to treat a missing verdict as a failure. The closed set of `reason=`
values and the stdout rules around the line are in
[`machine-output.md`](machine-output.md). `log=` names the run's own complete
output, specified in [`run-logs.md`](run-logs.md).

`reason=preflight` covers every gate before the harness, so a refusal that
can classify itself adds an additive `note=<class>` (`stale-browser`,
`coverage-replaced`, and so on) naming which gate fired. The refusal's full
text is written to stdout before the verdict line and into the run log, so a
redirected run keeps the reason as well as the verdict. See
[`run-logs.md`](run-logs.md).

## Seeded shuffle

`fireforge test --shuffle` deterministically permutes isolated mochitest path
arguments and prints the seed; `--shuffle=<seed>` replays that shard order for
the same input selection. A directory remains one invocation. `--no-shard`
disables this argument permutation. FireForge also forwards native mach
`--shuffle` within each invocation, whose file order remains unseeded and is
not replayed by the FireForge seed. `FIREFORGE_SHUFFLE_SEED=<seed>` is available
to custom harness `head.js` code for in-file task ordering, and `shuffle=<seed>`
is recorded on the verdict. The option is mochitest-only. A path-shaped
argument right after a bare `--shuffle` is a test path, not a seed (see
"Shared browsers, ports and host state" above).

Exit code 14 (`INCONCLUSIVE`) is not red: it means `engine/` moved while the
harness ran and the result was thrown away. Exit 15 (`LOCK_TIMEOUT`) means
the run never started. See [`exit-codes.md`](exit-codes.md).

## Output verbosity

mozbuild quiets terminal output to warnings and errors when it detects a
coding agent (`is_running_under_coding_agent()` keys on `CLAUDECODE`). The
build half of that quieting is useful. The test half removes `TEST_START` and
console INFO, which are the lines a hang or stall diagnosis needs, and also
the ones FireForge's own classifier reads (`Ran N checks`,
`Unexpected results:`, `TEST-UNEXPECTED-*`), so suppression pushes a run
toward `reason=no-tests`.

`fireforge test --full-output` unsets the marker for test dispatches only,
and the build path stays quiet. It is opt-in rather than automatic because it
changes how much a third party prints, and an operator who wants the quieting
should keep it.

## Known upstream teardown noise

Recent engines can end a run with a Python traceback at harness teardown:

```
AttributeError: 'SystemResourceMonitor' object has no attribute 'stop_time'
```

(or `poll_interval`), raised from `mozsystemmonitor/resourcemonitor.py`. It
is an upstream defect in the resource monitor's own shutdown, it is cosmetic,
and it does not affect any verdict. It matters only because it lands exactly
where a reader looks for the failure summary.

FireForge recognizes this one signature and no others. Recognition requires
all of: an `AttributeError` on `SystemResourceMonitor` naming one of those
two attributes, a `resourcemonitor.py` stack frame, and, in a test run, a
preceding `SUITE_END`. A novel attribute, a different exception, or the same
traceback before shutdown is treated as a real failure and always printed
verbatim.

The two phases handle it differently, on purpose:

- **Tests** collapse the traceback in the terminal echo to one line labeled
  `[FireForge]`. Captures and the run log keep the raw traceback, and the
  classifier reads the raw form, so a real failure always outranks this
  signature in diagnosis.
- **Builds** print it verbatim and add a note naming it. A build has no
  `SUITE_END`, so there is no boundary separating teardown from work still in
  progress, and FireForge cannot tell cosmetic teardown noise from a real
  build-time traceback there. Withholding the block would be the wrong risk
  to take.

## Concurrency

A test run holds the engine-session lock and snapshots the engine git
generation before and after the harness run, failing the verdict as invalid
if the tree changed mid-run in a way the running browser can see: a file the
objdir links to its source, a file staged at dispatch, or a test file or
staging input of the run. A peer's edit to anything else (a compiled source,
a copied file, an unrelated test) leaves the verdict standing with a warning
and `drift-tolerated=<n>`; the next run's stale-build gate judges whether it
needs a rebuild.

`--shared-lock` (or `test.lockMode: "shared"`) holds the lock shared for a
build-less run that applies no negative control and uses auto ports, so
several such runs on one objdir overlap. Anything that writes (a build, a
re-export, a `test --build`) still holds the lock alone: it waits for shared
holders to finish, and new shared holders queue behind it.
`status --lock` counts shared holders. Orphan reaping only touches helpers
whose parent died, so overlapping runs do not reap each other's live
helpers.

`--jobs <n>` runs a request's shards on n harness instances inside one lock
hold. Each instance has its own profile and its own Marionette port, and
auto ports (required) move each instance's mochitest server ports; output
lines carry a `[job <i>]` prefix in the terminal and the run log. Each
instance also writes its own mochitest test list
(`--testrun-manifest-file`): on the harness's shared default
`_tests/testing/mochitest/tests.json`, the second instance would run the
first shard's file and pass, or find none. A `--jobs` run always reads each
dispatch's mozlog raw log, and a dispatch whose raw log starts none of its
requested files fails with `started=0/<m>` instead of passing on another
shard's results. With `--no-shard`, or a single directory argument, the
files are split in order into n contiguous chunks. Parallel browsers raise
host load, so measure before relying on it.

When the caller sets `MOZ_UPLOAD_DIR`, each `--jobs` instance gets its own
`<MOZ_UPLOAD_DIR>/job-<i>` (created up front) instead of the shared
directory, where instances would replace each other's fixed-name artifacts
such as the `modifiedPrefs.json` pref census. The verdict names them as
`upload-dirs=<dir>,<dir>,...` so a caller can merge per-instance artifacts.
Without `MOZ_UPLOAD_DIR` nothing changes.

A browser `--jobs` run on more than one instance also holds
placeholder listeners on `127.0.0.1` on the mochitest HTTP, ssltunnel and
WebSocket ports (8888, 4443, 9988) for the whole parallel hold, after the
server-port preflight. Desktop mochitest has no flags for these ports, and
its busy-port probe passes for instances that start together, which then
race for 8888 and die with `could not start server on port 8888`. With the
ports held, every instance's probe fails and each falls back to its own
port; a port that is already busy is left alone. Each `FIREFORGE-SHARD:`
line carries the ports its instance took as `ports=http:<n>,ssl:<n>,ws:<n>`.
A harness whose server still fails to start (`could not start server on
port` or `Timed out while waiting for server startup`, before any test) is
an infrastructure failure, not `no-tests`: it is retried within the
`--harness-retries` budget like a harness crash, and reported as
`reason=server-startup` once the budget is spent.

`--shard-size <n>` dispatches n files per mach invocation (mochitest restarts
the browser between files), paying the harness start once per chunk instead
of once per file, and judges each file from mozlog's structured log:
`shards=` then counts files and `failed-shards=` names failed files.

`--results <path>` writes one JSON record per test file and `--repeat` run
(status, expected status, duration, unexpected subtests, the shard, and the
run-log line where the dispatch began) from mozlog's structured log, which
each dispatch then writes with `--log-raw`, and names it on the verdict as
`results=<path>`. A `--log-raw <file>` already forwarded with `--mach-arg` is
read instead. A harness-level record (`test` is `automation.py`,
such as a hung browser's no-output TIMEOUT) also carries `shardFiles`, the
shard's dispatched files, and `file` when the shard has exactly one. The checks that need no lock run before it is
requested: the launchable binary, the named-file checkJs pass, and the
`--wait-browser`/`--wait-port` budgets. The run log is open from the start,
so a `reason=lock-timeout` line carries `log=` too.
A `--perf-samples` run fails only when HEAD
moved or a changed path is packaged by the running build (an install-manifest
source or a test file); an edit no manifest installs, such as a compiled
source, leaves the sample standing with a warning. To verify beside a busy primary checkout
instead, use a [verification tree](verification-trees.md).

## Dev-build gotcha

In dev builds, files under `obj-*/dist/bin` may be symlinks back into the
source tree (prefs, chrome JS and CSS, deployed widgets), so edit source
prefs directly and keep a backup before bisection experiments. The same
symlinks mean a running suite reads `engine/` when its browser loads a file,
after any `--build` step: `Build complete` is not a snapshot. An edit to
`engine/`, yours or a peer session's, made before the `FIREFORGE-VERDICT`
line can reach the running suite, so keep a temporary edit, such as a
hand-made neuter, in place until the verdict line, or use
`--negative-control` for deliberate mutations. `fireforge test --help` says
so too.

## Missing launchable binary

`test` checks for the launchable binary before it requests the engine lock,
and names the cause when the bundle is incomplete. Every protected mach
build (`build`, `build --ui`, `test --build`) records itself in
`.fireforge/build-run.json` while it runs. A successful build removes the
record, a failed one keeps it with its exit code, and a build whose process
died part-way leaves it marked running with a PID that no longer exists. The
refusal (`note=no-launchable-binary`) then says, in any session, that the
last build was interrupted or failed, by which command and when. A missing
binary while a build is still running is not refused early: the run queues
behind that build, which relinks the bundle before it releases the lock.

## Repository release gate

Run `npm run release:check` with the exact Node version in `.nvmrc` and npm
version in `package.json`'s `packageManager`. The gate verifies these pins
before formatting, whitespace, zero-warning lint, strict typecheck, development
and production dead-code checks, import cycles, coverage floors, and installed
package smoke tests. `prepublishOnly` and the CI quality job run the same gate.
Supported Node-version and OS matrices continue to run ordinary tests separately.

The full-Firefox integration runner is opt-in. It snapshots project files,
engine changes and the index before arming recovery; a refusal cannot erase an
existing workspace. Failed recovery fails the run, preserves affected paths and
writes recovery evidence for manual repair.
