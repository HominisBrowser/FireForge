<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Running tests

`fireforge test` wraps `mach test`. Most of what follows exists because
mach's own defaults are wrong for a fork that must know exactly what ran.

## Scope is exact

`fireforge test <directory>` runs exactly that directory: FireForge enumerates
the directory's test files and passes the explicit file list to mach in one
invocation, so mach's prefix-based path matching cannot silently sweep in
sibling directories sharing the name prefix. Excluded siblings are echoed with
their test-file counts.

Multiple path arguments run as **sequential shards** by default — one browser
instance per argument, with a directory argument keeping its files together —
announced with a notice, since isolated instances do not exercise
cross-argument state. `--no-shard` restores one combined invocation.

## Pathless runs must choose a mode

- `--auto` forwards mach's own auto-selection.
- `--doctor` runs the Marionette preflight only.
- `--canary [path]` runs one short browser-chrome canary
  (`test.canaryPath` / `test.canaryTimeoutSeconds` in `fireforge.json`
  provide defaults).

## Build freshness

When packageable engine files changed since the last successful FireForge
build, `test` fails before launching stale artifacts. Use `--build` to
refresh, or `--allow-stale-build` only for intentional out-of-band rebuilds.

`--build-only` packages mixed-harness paths once, then each harness half can
run without `--build`. `--extend-coverage` safely retains prior scoped
coverage instead of replacing it; it is refused when the build anchor moved
(engine HEAD, `engine/mozconfig`, or a previously fingerprinted packageable
file).

### What a pre-test build costs

`test --build` runs `mach build faster`, with two escalations decided by
comparing build inputs against the **last successful build** recorded in
`.fireforge/last-build.json` — not against engine HEAD, since a fork's
worktree is permanently dirty (imported patches, Furnace-applied
components):

- a changed `moz.build` / `moz.configure` / `Makefile.in` runs
  `mach configure` first;
- a changed `jar.mn` escalates the whole build to a full `mach build`
  (minutes rather than seconds) **only** when it is a NEW manifest
  (untracked in the engine repo, so no install manifest exists for it yet)
  or when its jar declaration carries a bracketed base-directory prefix,
  which redirects the install destination away from the default chrome
  root. An entry added to an existing `dist/bin` manifest no longer
  escalates. Any probe failure (unreadable manifest, no git) escalates, and
  the notice names the manifest and the reason.

Each escalation is paid once per actual content change: a `jar.mn` that is
dirty against HEAD but byte-identical to what the last full build consumed
does not escalate again. `fireforge build --ui` is itself a
`mach build faster` and never escalates; the `jar.mn` record it writes is
carried forward from the previous full build, so a registration made
between a `build --ui` and the next `test --build` still triggers the full
build once.

The open question the 0.44.0 changelog recorded here — whether a full build
is really required for an entry added to an existing `dist/bin` `jar.mn` —
was settled downstream by exactly the experiment that entry asked for: two
clean runs where a jar-only registration of a new content file was
installed by a plain `fireforge build --ui`
(`faster/install_dist_bin_browser` named the destination, the file reached
`dist/bin` and the `.app` bundle) and fetched over `chrome://` by a plain
`fireforge test`. That case no longer escalates. The two halves the
experiment did NOT exercise — a new `jar.mn` file, and a non-default
install destination — still do, for the reason the original entry gives:
relaxing a stale-artifact guard without evidence trades a slow build for a
silently wrong test.

## Resilience

- Recognized harness crashes retry up to `--harness-retries <n>` times
  (default 2).
- `--kill-stale-marionette` terminates recognized stale browsers.
- Every dispatch runs a **census of orphaned harness helpers** — `xpcshell`
  (the harness httpd), `pywebsocket`, `ssltunnel`, `moz-http2` — that
  survived an earlier run in this project's objdir. It runs at preflight,
  before this run spawns anything, so every hit is a survivor by
  construction; a match must be objdir-anchored, since `xpcshell` and
  `server.js` are far too generic to report on their own. Survivors slow
  every later run without appearing in its output (a three-second suite
  taking minutes of wall clock is the usual symptom). Report-only by
  default; `--reap-orphans` terminates them. It never refuses a run.
  A different shape — reparented Python `multiprocessing` workers — is
  covered by the `Orphaned harness workers` doctor check.
- `--perf-samples <path>` publishes a perf-sample artifact path to the
  harness (exported as `<BINARYNAME>_PERF_SAMPLE_JSON`).

## The verdict line

Every test run ends with one machine-readable line:

```
FIREFORGE-VERDICT: PASS|FAIL reason=… [log=<path>]
```

Automation should branch on it rather than on the raw process code, and must
treat a **missing** verdict as failure. The closed set of `reason=` values and
the stdout rules around the line are in
[`machine-output.md`](machine-output.md); `log=` names the run's own complete
output, specified in [`run-logs.md`](run-logs.md).

Exit code 14 (`INCONCLUSIVE`) is not red: it means `engine/` moved while the
harness ran and the result was thrown away. Exit 15 (`LOCK_TIMEOUT`) means the
run never started. See [`exit-codes.md`](exit-codes.md).

## Output verbosity

mozbuild quiets terminal output to warnings and errors when it detects a
coding agent (`is_running_under_coding_agent()` keys on `CLAUDECODE`). The
build half of that quieting is useful; the test half removes `TEST_START` and
console INFO — the lines a hang or stall diagnosis needs, and the ones
FireForge's own classifier reads (`Ran N checks`, `Unexpected results:`,
`TEST-UNEXPECTED-*`), so suppression pushes a run toward `reason=no-tests`.

`fireforge test --full-output` unsets the marker for **test dispatches only**;
the build path stays quiet. It is opt-in rather than automatic because it
changes how much a third party prints, and an operator who wants the quieting
should keep it.

## Known upstream teardown noise

Recent engines can end a run with a Python traceback at harness teardown:

```
AttributeError: 'SystemResourceMonitor' object has no attribute 'stop_time'
```

(or `poll_interval`), raised from `mozsystemmonitor/resourcemonitor.py`. It is
an upstream defect in the resource monitor's own shutdown, it is cosmetic, and
it does not affect any verdict. It matters only because it lands exactly where
a reader looks for the failure summary.

FireForge recognizes this one signature — and only this one. Recognition
requires **all** of: an `AttributeError` on `SystemResourceMonitor` naming one
of those two attributes, a `resourcemonitor.py` stack frame, and (in a test
run) a preceding `SUITE_END`. A novel attribute, a different exception, or the
same traceback before shutdown is treated as a real failure and printed
verbatim, always.

The two phases handle it differently, deliberately:

- **Tests** collapse the traceback in the terminal echo to one labeled
  `[FireForge]` line. Captures and the run log keep the **raw** traceback, and
  the classifier reads the raw form — a real failure always outranks this
  signature in diagnosis.
- **Builds** print it verbatim and add a note naming it. A build has no
  `SUITE_END` — no boundary separating teardown from work still in progress —
  so FireForge cannot distinguish cosmetic teardown noise from a real
  build-time traceback there, and withholding the block would be the wrong
  risk to take.

## Concurrency

A test run holds the engine-session lock and snapshots the engine git
generation before and after the harness run, failing the verdict as invalid if
the tree changed mid-run. To verify beside a busy primary checkout instead,
use a [verification tree](verification-trees.md).

## Dev-build gotcha

In dev builds, files under `obj-*/dist/bin` may be symlinks back into the
source tree (notably prefs), so edit source prefs directly and keep a backup
before bisection experiments.
