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

`--build-only` packages mixed-harness paths once, and then each harness half
can run without `--build`. `--extend-coverage` retains prior scoped coverage
instead of replacing it. It is refused when the build anchor moved (engine
HEAD, `engine/mozconfig`, or a previously fingerprinted packageable file).

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
  An entry added to an existing `dist/bin` manifest no longer escalates. Any
  probe failure (an unreadable manifest, no git) escalates, and the notice
  names the manifest and the reason.

Each escalation is paid once per actual content change. A `jar.mn` that is
dirty against HEAD but byte-identical to what the last full build consumed
does not escalate again. `fireforge build --ui` is itself a
`mach build faster` and never escalates. The `jar.mn` record it writes is
carried forward from the previous full build, so a registration made between
a `build --ui` and the next `test --build` still triggers the full build
once.

The 0.44.0 changelog left an open question here: whether a full build is
really required for an entry added to an existing `dist/bin` `jar.mn`. It was
settled downstream by exactly the experiment that entry asked for. In two
clean runs, a jar-only registration of a new content file was installed by a
plain `fireforge build --ui` (`faster/install_dist_bin_browser` named the
destination, and the file reached `dist/bin` and the `.app` bundle) and then
fetched over `chrome://` by a plain `fireforge test`. That case no longer
escalates. The two halves the experiment did not cover, a new `jar.mn` file
and a non-default install destination, still escalate, for the reason the
original entry gives: relaxing a stale-artifact guard without evidence trades
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
FIREFORGE-VERDICT: PASS|FAIL reason=… [note=<class>] [shuffle=<seed>] [orphans-reaped=<n>] [log=<path>]
```

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

`fireforge test --shuffle` runs a mochitest selection in a seeded random file
order and prints the seed; `--shuffle=<seed>` replays it. FireForge forwards
mach's own `--shuffle`, exports `FIREFORGE_SHUFFLE_SEED=<seed>` to the harness
so in-file task reordering (harness `head.js` code, not FireForge) can key off
the same number, and stamps `shuffle=<seed>` on the verdict line. It is
mochitest-only: the xpcshell harness has no shuffle, and generic `mach test`
dispatch would hand the flag to every suite. Write the flag as
`--shuffle=<seed>` or after the paths, because a bare `--shuffle <path>` reads
the path as the seed.

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
if the tree changed mid-run. To verify beside a busy primary checkout
instead, use a [verification tree](verification-trees.md).

## Dev-build gotcha

In dev builds, files under `obj-*/dist/bin` may be symlinks back into the
source tree (prefs especially), so edit source prefs directly and keep a
backup before bisection experiments.
