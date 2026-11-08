<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Proof

`fireforge prove` answers one question: has this exact source shown what its change requires? It captures the checkout, derives the obligations, runs whatever has no evidence yet and reports. A passed job means its steps ran; only `prove` says whether that was enough.

```sh
fireforge prove                       # task tier, the default
fireforge prove --tier gate           # everything the project declares
fireforge prove --tier gate --lane tiles   # one declared obligation, and the build it needs
fireforge prove status [--complete]   # the same plan as a query; runs nothing
fireforge prove plan                  # the plan and the job it would submit
fireforge prove accept <obligation> --note "..."
fireforge prove waive <obligation> --allow-machine --note "..."
fireforge prove publish [--allow-waived --note "..."]
```

Every command recomputes the plan from the captured snapshot and its base; there are no plan files. Common options: `--tier task|gate`, `--base <ref>`, `--test <path>...`, `--path <path>...`, `--mode dev|debug|release`, `--control <diff> --control-test <path> --expect <assertion>...`. `prove` also takes `--no-wait`. `prove --slot <name>` (and `prove plan --slot`) composes its jobs for that slot alone and runs every one there, as `job run --slot` does; a slot that does not exist refuses before anything is submitted. `--json` writes one document.

`prove --tier gate --lane <id>` (and `prove plan --lane`) runs only that obligation: a lane by its ID, anything else by its full ID (`stress:<id>`, `run:<id>`, `control:<id>`, `check`), plus the build it needs when no slot has one. Its step is the gate's own, in a final-gate job, so the evidence is what a full gate run of it would leave, and a later `prove --tier gate` reuses it. It exits 0 once that obligation has passed, whatever the rest of the plan says; an unknown ID refuses (`proof-unknown-obligation`), and so does an acceptance (`proof-lane-acceptance`).

## The base

A plan compares the candidate with a base. The task tier defaults to the merge-base of `HEAD` with the main branch. The gate defaults to `refs/fireforge/verified` when that is an ancestor of `HEAD`, otherwise the same merge-base; a commit published with waivers is not a base, so the gate compares with the last one published clean. Every report names its base.

The main branch comes from history: `proof.mainBranch` as the last verified commit states it, else as the tip of `main` or `master` states it. A candidate's own `proof.mainBranch` counts only when neither exists, and then a person has to accept it.

`--base <ref>` names another base. One that leaves out commits the default would cover is `narrowed`: `prove` runs for feedback, but `status --complete` refuses (`proof-base-narrowed`) and `publish` takes no base. A task with no difference from its base refuses (`proof-empty-input`).

Adopt a migrated project on the main branch. On a branch, every path under `src/` reads as changed and an upstream `test_*.html` refuses with `proof-unclassified-test`.

An upstream record under `.fireforge-sources/overrides/` whose path's bytes under `src/` are unchanged, and which differs only in where its base sits upstream (`base.commit`, `base.pin`, `base.blob`), does not make its path changed: an `authored refresh` rebases every record without changing what materializes. A changed kind, classification, component, ADR or mode, a new or removed record, or changed bytes under `src/` still count. The refresh's `fireforge.json` change still routes `unknown`, so the gate still builds in full and runs its lanes.

## Routes

Each changed path has one route; the build follows from the routes. An unknown path gets a full build.

| Route         | Paths                                                                                                                                    | Build        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `source-link` | JS, CSS, markup, Fluent and images under `browser/` and `toolkit/`                                                                       | `build --ui` |
| `test`        | under `test/` or `tests/`, or named `browser_*` or `test_*`                                                                              | `build --ui` |
| `packaged`    | `jar.mn`, `components.conf`, `chrome.manifest`                                                                                           | full         |
| `compiled`    | C++, Rust, IDL, `moz.build`, `configs/`                                                                                                  | full         |
| `component`   | `components/`, `furnace.json`                                                                                                            | full         |
| `unknown`     | anything else, and `fireforge.json`                                                                                                      | full         |
| `none`        | `.md` and `.rst`; at the root, `docs/`, `patches/`, `.github/`, licences, `package.json`, the lockfile, ignore files; `proof.noneRoutes` | none         |

`proof.noneRoutes` covers project-root paths only and cannot reach `configs/`, `components/`, `furnace.json` or `fireforge.json`. An override takes the route of the file it overrides.

## Task tier

What one change needs, in order:

- `static`: one `lint` scoped to what changed (also types and upstream policy). A full-build route makes it the whole project; a change with no engine path runs `verify`. Warnings are held to `check.maxWarnings.lint`, the same line `check` and `authored lint` hold, so `authored lint` predicts this step.
- `build`: by route, and whenever a browser step needs a package. A slot with no binary of these compiled inputs turns `--ui` into a full build, and the report says so.
- `test:<path>`: each changed test, each `--test`, and each direct consumer of what changed (a captured test that mentions a changed file's name, or an `id`, `customElements.define` or `getElementById` name in it, as a whole token).
- `control:<diff>`: only with `--control`.

A changed `browser_*` or `test_*` JS file runs by itself. Any other changed test (`test_x.html`, `test_x.py`) must be named with `--test` or covered by a lane, or the plan refuses (`proof-unclassified-test`). A changed support file such as `head.js` selects the tests beside it. A deleted test is listed as `removed test: <path>` with the lanes whose patterns held it (`plan.removedTests` in JSON). A lane naming the deleted file literally goes red until the declaration changes.

More than `proof.consumerLimit` consumers (default 12) refuses with `proof-consumer-limit`; with `--test`, the named tests run and the report states how many consumers are left to the gate. A job carries 100 steps (`proof-step-limit`). A CSS change no test mentions is `static` and `build`, and the report says no test ran it; name one with `--test`.

## Gate tier

What an integrated candidate needs, declared in `fireforge.json`. The block is optional and rejects unknown keys:

```json
{
  "proof": {
    "mainBranch": "main",
    "consumerLimit": 12,
    "noneRoutes": ["tools/**"],
    "gate": {
      "build": "ui",
      "mode": "dev",
      "check": { "quiet": true },
      "lanes": [
        {
          "id": "tiles",
          "files": ["browser/tiles/test/browser_*.js"],
          "exclude": ["browser/tiles/test/browser_fullscreen.js"],
          "owns": ["browser/tiles/**"],
          "dispatch": "one-browser",
          "quiet": true
        },
        {
          "id": "fullscreen",
          "files": ["browser/tiles/test/browser_fullscreen.js"],
          "headed": true,
          "holdFront": true
        },
        {
          "id": "captures",
          "files": ["browser/tiles/test/browser_captures_*.js"],
          "uploadDir": true,
          "env": { "PROJECT_CAPTURE_DIR": "{artifacts}/captures" },
          "validate": {
            "command": ["node", "tools/count-captures.mjs", "{artifacts}/captures"],
            "footprint": { "memory": 6 }
          }
        }
      ],
      "stress": [
        {
          "id": "tiles",
          "files": ["browser/tiles/test/browser_a.js"],
          "context": ["browser/tiles/test/browser_0.js"],
          "repeat": 10
        }
      ],
      "controls": [
        {
          "id": "guard",
          "diff": "tools/controls/guard.diff",
          "test": "browser/tiles/test/browser_a.js",
          "assertions": ["the guard holds"]
        }
      ],
      "runs": [{ "id": "smoke", "args": ["--smoke-exit", "30"] }],
      "acceptance": [
        {
          "id": "scene",
          "reason": "A person looks at the tab strip.",
          "owns": ["browser/themes/**"],
          "evidence": ["lane:captures"]
        }
      ]
    }
  }
}
```

- **`lanes`**: a group of test files run as declared (a lane is one named run configuration). `files` are globs over captured tests, or literal paths, which can name upstream tests; a pattern matching nothing refuses (`proof-empty-lane`). `dispatch` is `shards` (default, a browser per file), `one-browser` (state accumulates) or `standalone` (restart between tests). `headed` takes the display. `args` takes further closed `fireforge test` options.
- **`owns`**: without it a lane always applies; with it, only when a changed path matches or is one of its files. A candidate with no difference from its base keeps every lane.
- **`stress`**: a lane run `repeat` times, with `context` files first in each repeat in the same browser. Evidence needs every repeat.
- **`controls`**: an expected red. It applies when the diff mutates a non-test path the candidate changed. `compiled` builds and restores a binary. `always` keeps it on every gate, including a candidate with no difference. It must catch its assertions by a mutation that was verified and restored; a diff that mutates nothing refuses (`proof-control-unrelated`).
- **`runs`**: a `fireforge run` that must exit clean, such as a smoke start. Takes `quiet`, `env`, `uploadDir`, `keepAwake` and `validate`, which judges what the run wrote: `--capture-console {artifacts}/console.txt` in `args`, then a validator that reads it.
- **`mode`**: the build recipe the gate's evidence must be of (default `dev`). `prove --tier gate` builds it and `publish` requires it.
- **`check`**: `fireforge check`, in the gate's final-gate job, which re-reads every tool byte. It runs first, before the build: it reads only captured source, so a static red costs no build or lane, and a project check step must not need a build. `quiet` is for a project whose check steps are not declared static.
- **`acceptance`**: see [decisions](#human-decisions).

Only what declares `quiet` runs alone; other work runs beside peers within `browser` and `display` capacity.

A gate's job goes on past a red step, so one run gives every obligation a verdict: a red check, a red lane and the lanes that pass all come back from the same job. A step that cannot run is `blocked`, not red: every lane, stress, control and run after a red build, and those after a step whose package could not be vouched for after a red. The slot is audited after each red as the next job would audit it, and a red that leaves it untrusted ends the job there. The job ends `failed` if any step went red, and each step that passed is evidence as if it had run alone.

### A candidate and its gate

A candidate answers to the union of its base's `proof` and its own, read from the base commit, not the checkout. What it adds applies at once. What it removes applies until the removing commit is itself verified, so a lane that went red cannot be deleted away. A lane in both takes the union of `files`, a file excluded only if both exclude it, the wider `owns`, the larger `repeat`, `quiet` if either says so, and the base's `validate` if the candidate has none; a run in both takes the candidate's, with the base's `validate` if the candidate has none. `build` is `full` if the base says so; `noneRoutes` keeps only what both list. A declaration whose every file the candidate deleted lets go, and the report says so.

Any change to what decides a gate adds `accept:proof-config` at gate tier, satisfied only by `prove accept`: the `proof`, `check`, `patchLint`, `patchPolicy` and `typecheck` sections (`check.skip`, `check.maxWarnings` and the lint, policy and type settings decide what the final check enforces), and any file the base or candidate names as a judge: in a lane, stress or run `validate.command`, as a control's `diff`, as a word of a `check.extraSteps` command, or as a type shim (`patchLint.checkJsExtraShim`, `patchLint.checkJsTestShim`, `typecheck.extraShim` and its per-project overrides). Only the named files are compared: what they import or call, such as an npm script's target, is not followed.

### What a lane declares

A job's environment is closed. A lane states what its harness needs, and `job run` has the same fields (`--env`, `--upload-dir`, `--mach-arg`, `--keep-awake`, `--no-keep-awake`, `--headed`, `--no-shard`, `--standalone`, `--hold-front`, `--throttle`), so a lane run by hand counts for it.

- **`env`**: variables for a test or run step with no build in it. Names are upper case; the executor refuses what it owns or what selects code (`FIREFORGE_*`, `NODE_*`, `MOZ_*`, `PATH`, `HOME`, `TMPDIR`, `DYLD_*`, `LD_*`, `GIT_*`, `PYTHON*`, `MACH*`, `RUST*`, `CARGO*`, compiler variables and similar). A value is one line and names no path outside the job: relative to the slot, or starting `{artifacts}`, the step's output directory. Values show in `job status`; no secrets.
- **`uploadDir`**: sets `MOZ_UPLOAD_DIR` to `<namespace>/artifacts/<job>/step-<n>-output`, printed as `output=<path>` and kept 30 days.
- **`machArgs`**: only `--setpref=<name>=<value>`, value without a path, name outside `marionette.*`.
- **`validate`**: judges what the harness produced (a capture count, a performance budget). `command` is an argument array, never a shell line: `node <script>` (the phase's own Node) or a captured script path; `{artifacts}` expands. It runs after a clean harness exit in the same phase; nonzero reads red. `footprint` states `cpu` and `memory` (the resources it claims) when it needs more than the lane. A changed test run by itself skips it, since a validator judges a roster. `job submit` takes it on a step; `job run` has no flag for it.
- **`keepAwake`**: holds `caffeinate -disu` on darwin while the step runs; a step with a window holds it unless this is `false`.
- **`holdFront`**: on a `headed` lane, keeps this phase's own browser frontmost (found by process ancestry, raised by process ID, no Automation grant, read back with `lsappinfo`). Raises that keep failing, or a browser never seen, read red. For tests that only need focus to read as held, use `--setpref=focusmanager.testmode=true`.
- **`throttle`**: `background` or `utility` runs the browser under that `taskpolicy` clamp.

`env`, `uploadDir`, `machArgs`, `holdFront`, `throttle` and `validate.command` are in the step fingerprint; `keepAwake` is not. An option that names a file the step writes takes `{artifacts}/<path>` to write it to the output directory: `--perf-samples`, `--keep-log`, `--coverage` and `--pgid-file` for a test, `--capture-console` and `--screenshot` for a run. Elsewhere `{artifacts}` stays as written.

Deliberately not declarable: load burners (their load is in no evidence key, so a pass under one proves nothing; keep them in a project script) and per-file prefix replay (`context` states it).

## Evidence

Evidence is a query over the coordinator's job record, keyed by source, step fingerprint and build identity, so any job contributes, including `job run` and `job submit`. `status` starts nothing.

- **Source**: the snapshot ID. Changed bytes are a different source; committing the same bytes is the same source. A gate can also read one verified source's evidence; see [documents-only candidates](#documents-only-candidates).
- **Step fingerprint**: command, arguments, roster, expected assertions, quiet, declared environment, upload directory, validator command. Where it ran, its deadline and admission are not part of it.
- **Build identity**, for a step that reads a package: the compiled anchor, the native digest (tools, Mach recipe, sites) and the toolchain. It holds no path or per-job value, so two slots building one source compare equal.

The newest result for a step decides. A pass after a red completes the step, and the report prints `earlier-reds=<n>`; a red after a pass is a red. A red job still contributes every step that passed, so `prove` reruns only what lacks evidence. A blocked step has no result: it reads `blocked` until something newer runs it. A row counts only if it proves what the obligation asks: the exact roster with every repeat, a control that caught its assertions, a check from a final-gate job with the captured check contract. An expected red never proves a positive.

Obligations read `passed`, `accepted`, `waived`, `red`, `stale` (evidence exists under another identity or is not good enough; the detail says which), `blocked` (the last job to try it could not run it, and the detail names the step that stopped it), `running` or `outstanding`. `prove` runs `red`, `stale`, `blocked` and `outstanding` obligations again.

### Documents-only candidates

A gate whose candidate differs only in documents from a commit with complete gate evidence carries that commit's evidence to every obligation except `check`, which runs on the candidate because a static check reads documents. A ledger entry or an ADR then costs one check, not the gate.

The commit it carries from is the default base, `refs/fireforge/verified` or the last commit published clean, when the candidate is documents-only from there. Otherwise it is the nearest commit along the candidate's first parents, within 50, whose own gate is complete and clean by the rules `publish` holds it to: every obligation met under the present tools, nothing waived, and none of it itself carried. That commit need not be published, so documents a peer commits on top of a finished gate carry it without publishing it first. The walk stops at the first commit the candidate is not documents-only from, and never leaves the first-parent line, so a commit on another branch is never a base, even with the same tree.

It carries only when all of these hold:

- No `--base` is named: a named base carries nothing. A commit published with waivers, or with any waived obligation, is never a base, and neither is one whose evidence is incomplete.
- Every changed path is at the project root and routes `none`. Not one under `src/` or the source metadata, since a test can declare an engine file as support. Not a declared input (a validator's script, a control's diff, a file a lane or run option names), `package.json` or `package-lock.json`.
- Nothing that decides the gate changed: anything that would add `accept:proof-config` stops the carry. As there, what a judge reads beyond the files it names is not followed, so a validator that reads a document has to name it in its `validate.command`, which makes it a judge, or the carry passes over it.

The carried evidence is the carried commit's tree's own under the candidate's pin, held to the same rules as the candidate's: one tool identity, equal to the present one, and the same build identity. A red on the candidate outranks a carried pass, and an acceptance carries but a waiver does not. A carried obligation prints `carried-from=<commit>` (`carried` in JSON), and the plan notes it.

A commit published on carried evidence records where it came from at `refs/fireforge/verified-carries/<commit>`. The next documents-only commit carries from that origin, if it is documents-only from there too and nothing that decides the gate differs, so a chain never asks a commit that ran only a check. Publishing a commit on its own evidence discharges the record.

### Against the present tools

Evidence counts only under the tools as they are now. At task tier each kind binds the parts that can change its result:

| Kind                                       | Bound to                                                                           |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| `static`                                   | quality tools (FireForge, Node, Git, TypeScript, ESLint, Prettier, `node_modules`) |
| `check`                                    | quality tools, the project's FireForge, environment                                |
| `build`                                    | build identity, toolchain                                                          |
| `test`, `lane`, `stress`, `control`, `run` | build identity, toolchain, FireForge, environment                                  |

So an ESLint upgrade re-runs `static` and leaves browser tests standing, while a FireForge upgrade re-runs task-tier tests. At a gate every kind binds every part under one shared identity, and `status --complete` and `publish` read every toolchain byte instead of comparing stat signatures, so a tool changed with size and times preserved fails the claim. The environment digest holds platform, kernel and locale only.

Tools are measured by a short process under the namespace's recorded Node, and a slot answers for the project's tools. When none can, evidence reads `stale` and claims refuse; `prove` then submits one `status` step to bring a slot to this source and measures again.

## Human decisions

`prove accept` and `prove waive` record a decision with who, when and a required `--note` (`prove accept scene` means `accept:scene`), bound to the source, the tier and what the obligation asks; it lapses when the obligation changes meaning. `by` is a label, not authentication: same-user agents and people look alike, so the note is what a reviewer checks.

**Acceptance.** An `acceptance` obligation (such as a visual scene) has no step; only `accept` satisfies it, and `waive` refuses it. `evidence` lists the obligations whose outputs the person looks at: `accept` refuses until they have passed on this source, prints each job and `output=`, records the jobs, and a later run of them lapses the acceptance. A lane an acceptance looks at runs whatever its `owns` says.

**Waivers.** A machine obligation is proved by running it. `waive` refuses one without `--allow-machine`, and a later pass replaces the waiver. The verdict reads `complete-with-waivers`: at task tier that is the caller's business; at a gate, `status --complete` and `publish` refuse (`proof-waived`) unless `--allow-waived` is stated, and `publish` also needs `--note`.

## Publication

`prove publish [--commit <revision>]` moves `refs/fireforge/verified` to a commit that has complete gate evidence for its exact tree against the default base. Evidence carried to a documents-only commit counts, alongside the check that ran on that commit's tree, and the ref moves straight to that commit whether or not the commit it carried from was published. It needs no capture and the commit need not be checked out. It is a compare-and-swap (`proof-publish-raced`), and only a fast-forward moves it; after rewritten history `--allow-rewrite` states it (`proof-verified-not-ancestor`). The ref is shared by every worktree.

`--allow-waived --note` records the waivers as a JSON blob at `refs/fireforge/verified-waivers/<commit>`, naming the last clean commit, and the next gate compares with that clean commit so the waived work is planned again. Publishing clean discharges the record.

A control diff is captured source: commit it, or pass the same `--path` and `--control` to `status`, since an uncommitted one is a different source.
