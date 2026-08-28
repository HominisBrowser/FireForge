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

## Resilience

- Recognized harness crashes retry up to `--harness-retries <n>` times
  (default 2).
- `--kill-stale-marionette` terminates recognized stale browsers.
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

## Concurrency

A test run holds the engine-session lock and snapshots the engine git
generation before and after the harness run, failing the verdict as invalid if
the tree changed mid-run. To verify beside a busy primary checkout instead,
use a [verification tree](verification-trees.md).

## Dev-build gotcha

In dev builds, files under `obj-*/dist/bin` may be symlinks back into the
source tree (notably prefs), so edit source prefs directly and keep a backup
before bisection experiments.
