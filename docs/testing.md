<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Testing

`fireforge test` runs Firefox's own test harnesses (mochitest, xpcshell, reftest) through `mach` in the project's workspace and judges the result. It is the same command in patch mode and source mode.

```sh
npx fireforge test browser/base/content/test/sidebar/browser_focus.js
npx fireforge test browser/base/content/test/sidebar/
npx fireforge test browser/base/content/test/sidebar/browser.toml
npx fireforge test 'browser/base/content/test/sidebar/browser_*.js'
```

## What to run

Paths are engine-relative test files, directories, test manifests or globs; at least one is required. FireForge resolves them through the manifests to the exact test files, each with the harness that runs it, and hands every file to `mach` by name, so a directory never sweeps in a sibling that shares its prefix.

- A named file that is not a test is refused before anything runs. When a manifest lists it as a support file, the refusal names the tests that read it.
- A path that does not exist, or that selects no test, is refused.
- A reftest list (`reftest*.list`, `crashtests*.list`) runs as one `mach test` invocation.

## How tests are dispatched

| Option         | Mochitest files run                                     |
| -------------- | ------------------------------------------------------- |
| `--shard`      | each in a browser of its own; this is the default       |
| `--no-shard`   | all in one browser                                      |
| `--standalone` | in one invocation, restarting the browser between files |

xpcshell runs every file in a process of its own, so all xpcshell files go to one invocation. A run that mixes harnesses runs one invocation per harness.

Other options:

- `--repeat <n>` runs everything that many times; every repetition must pass.
- `--shuffle <seed>` permutes the mochitest files with that seed; the verdict line repeats the seed.
- `--headed` shows the browser and holds the host display lock ([workspaces.md](workspaces.md#host-locks)). The default is headless.
- `--mach-arg <arg>` passes `--setpref=<name>=<value>` (a value that names no path, outside `marionette.*`), `--timeout=<seconds>` or `--app-path=<absolute path>` to mach. FireForge owns the log, the profile, the control port, the test list and the run shape.
- `--env NAME=VALUE` sets a variable in the harness environment. `FIREFORGE_*` names are reserved.
- `--coverage <dir>` writes the harnesses' per-test JavaScript coverage under that directory (mochitest and xpcshell).
- `--workspace <name>` and `--wait-lock <seconds>` as for every workspace command.

A rebranded build's application name is not `firefox`, so the `firefox-appdir` key of an xpcshell manifest does not apply to it. When a manifest has only that key, FireForge passes `--app-path` itself so `resource:///modules/...` imports resolve. Each xpcshell invocation also gets a profile of its own.

## Build freshness

A test must run against a build of the source it is testing. Before the harness starts, `test`:

1. Deploys the project's Furnace components into the engine.
2. Compares the engine with the last build. Compiled sources and build definitions are compared with the last full build; packaged front-end files with the last build of any kind (and do not count while the object directory serves them by symlink); a `jar.mn` counts only when the build backend has never seen it or it installs outside the default chrome root; tests, documentation and dot files never make a build stale; any other file is assumed to be packaged, needing a full build under a `branding` directory (icons, installer scripts) and a UI build elsewhere.
3. Refuses a stale build with `FAIL reason=preflight note=build-stale`, naming the build that catches up. `--build` runs that build first instead: `build --ui` when it is enough, a full build otherwise.

`run` and `package` apply the same rule.

## The verdict

Every run ends stdout with one line, written on every way out, including Ctrl+C:

```
FIREFORGE-VERDICT: PASS checks=12 unexpected=0 log=/Users/me/.fireforge/workspaces/w1/test-runs/<id>/output.log
FIREFORGE-VERDICT: FAIL reason=crash started=2/8 first-unstarted=browser/base/content/test/sidebar/browser_keys.js log=...
```

A test result is not the harness's exit code or its summary line. The verdict keys on what the harness itself writes: start and end markers for each file, the suite summary, crash markers, and the structured log each invocation writes. So:

- A crash, a hang, or a browser that quit mid-suite is a failure, even when mach exits 0 or the summary reads `Failed: 0`.
- Every planned file must start and finish. A file that never started or never finished is a failure.
- An engine that changed while the harness ran makes the result `inconclusive` (exit 14): run again.
- A harness failure FireForge recognizes before any test ran (mach's resource monitor failing at startup, for instance) is retried up to twice, because it says nothing about the tests. `test.harnessFailurePatterns` adds output lines that mean the browser failed before any test ran.

[machine-output.md](machine-output.md#test) lists every `reason` and key of the verdict line and the shape of the results document. [exit-codes.md](exit-codes.md#test) lists the exit codes.

### Logs and results

Each run writes its complete output to `test-runs/<id>/output.log` in the workspace's state directory (`~/.fireforge/workspaces/<name>/` in source mode, `.fireforge/` in patch mode); the verdict line names it as `log=`. A workspace keeps its 10 latest runs. To keep one for good:

```sh
npx fireforge test browser/base/content/test/sidebar/ --keep-log sidebar.log --results sidebar.json
```

- `--keep-log <path>` also writes the complete output there.
- `--results <path>` writes the per-file results document (the same document `--json` prints): the planned tests, each invocation with its exit code, attempts and verdict, one record per file with its failures, and a summary.

## The host around a run

While a command holds the workspace, no other FireForge run uses its engine. `test` uses that to keep the host clean without touching anything else:

- **Before**: harness processes an earlier, killed run of this workspace left behind (their parent died, or they carry this engine's marker) are terminated by exact process identity. The verdict reports `orphans-reaped=<n>`.
- **Ports**: a browser harness binds the Marionette port and mochitest server ports. A leftover of this workspace holding one is terminated. A process of anyone else is never signalled: the run waits for it up to `--wait-lock`, then refuses with `port-busy` naming it. With `test.mochitestPorts: "auto"`, a run proceeds while another workspace holds the Marionette port (FireForge moves this run's to a free one) or a server port the harness can move away from by itself.
- **After**: helpers this run started that escaped its process group (xpcshell's HTTP/2 server, for instance) are found by the run marker in their environment and terminated.

Nothing about this is configurable; it is what a correct run needs.

## Negative controls

A green test proves something only if it would go red when the behaviour breaks. A negative control checks that: apply a reviewed mutation, require the tests to fail at exactly the expected assertions, and put everything back.

```sh
npx fireforge test browser/base/content/test/sidebar/browser_focus.js \
  --control controls/sidebar-focus.diff \
  --expect "focus moves to the first item"
```

1. The tests run unmutated and must be green. This is skipped when the workspace recorded a green run of exactly these tests on exactly this engine state. A red baseline fails the control as `baseline-red`, and the mutation is not applied.
2. The diff is applied to the engine inside a transaction, and what the mutation needs is built. A path in the diff names an engine file: engine-relative, under `engine/`, or as the checkout holds it, so the output of `git diff` works as it is (`src/<path>` in source mode, and a component's `components/custom/<tag>/<file>` or `components/overrides/<name>/<file>` in either mode).
3. The tests run again. They must go red at every `--expect` assertion and at no other. Repeat `--expect` for each assertion.
4. Every byte is restored, whatever happened: an error, Ctrl+C or a crash (on the next run) puts the engine back. When the mutation needed a build, the restored engine is built again so the workspace does not keep a mutated binary (`control-restore-build=done|failed`).

The verdict reports how the control came out:

| `control=`     | Meaning                                                                                                                                                                                                                      | Exit | `code`                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | ---------------------- |
| `caught`       | Red at exactly the expected assertions                                                                                                                                                                                       |    0 |                        |
| `missed`       | The tests stayed green with the mutation                                                                                                                                                                                     |    5 | `control-missed`       |
| `wrong-red`    | Red with the mutation, but not at exactly the expected assertions: an expected one stayed green, another one failed, or the run failed some other way (a crash). The message names the expected assertions and what was seen |    5 | `control-wrong-red`    |
| `baseline-red` | The tests were red without the mutation                                                                                                                                                                                      |    5 | `control-baseline-red` |
| `inconclusive` | The engine changed while one of the two runs was under way: run again                                                                                                                                                        |   14 | `control-inconclusive` |

A `wrong-red` control is a failed control, not a result to retry: correct `--expect`, or narrow the mutation or the tests until only the expected assertions fail. [gate.md](gate.md) declares controls under `gate.controls` so every gate run repeats them.
