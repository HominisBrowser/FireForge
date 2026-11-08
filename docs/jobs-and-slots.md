# Jobs and slots

In a source-mode project, `build`, `test`, `run`, `package` and `check` work run as jobs: the caller captures its checkout, a local supervisor runs the work in a private clone of the engine (a slot), and the result is one verdict line. The caller can disconnect and reconnect by job ID. `passed` means the job's steps, declared test files, cleanup and final source audit passed; whether that is enough for a change is [proof](proof.md).

Everything runs as one user. The boundary is a Unix socket inside a 0700 namespace, so nothing here authenticates people: a job's `owner` is a display label, and anyone on the host can read or cancel any job by ID. The default namespace is `~/.fireforge/host/jobs`, and `FIREFORGE_COORDINATOR` selects another. Use one namespace per host.

In a project the namespace has configured, direct `build`, `test`, `run`, `package` and `furnace` refuse outside a job, in every worktree of that repository. `status`, `lint`, `typecheck` and `verify` still run directly, from a snapshot of the checkout. `check` runs only as a job (`job run`, whose default it is, or `prove`): in an editing checkout it refuses with `authored-proof-needs-slot`.

## Set up the host

From the main checkout or any linked worktree:

```sh
fireforge host init --slots 2 --from-engine /path/to/configured/engine
```

This creates the namespace, freezes a toolchain, provisions the slots and qualifies them. It is safe to rerun: every step keeps what is already right. It never edits a project file.

- `--from-engine` needs an engine that was configured and built once (it reads `config.statusd/substs`). A source-mode project cannot run `download` or `bootstrap`, so get that engine from a legacy checkout or build one elsewhere first. Without it, `host init` sets up the coordinator and slots only, and static jobs work.
- A project made by `fireforge setup` blocks on the first run: `configs/common.mozconfig` has `--enable-bootstrap`. `host init` prints the edit (replace it with `--disable-bootstrap`), exits 1, and leaves static work usable. Make the edit and rerun.
- `--slots 0` sets up the coordinator alone. `--cpu`, `--memory`, `--max-slots`, `--browsers` and `--quiet-load` override the capacity below. `--pristine-repository` names the pristine object donor; `--python` names an interpreter; `--cache` and `--release-secrets` are described below.
- A queue project is refused with the command that migrates it: `fireforge authored migrate --out <directory> --verify`.
- With `--json` stdout is one document (`namespace`, `capacity`, `maxSlots`, `quietLoad`, `slots`, `built`, `project`); progress goes to stderr, and a blocked host answers with the error envelope.

## Run work

```sh
fireforge authored override browser/themes/shared/tabs.css   # first touch of an upstream file
$EDITOR src/browser/themes/shared/tabs.css
fireforge job run --test browser/themes/test/browser_tabs.js
```

`job run` captures the checkout, submits, waits and prints one verdict line. Exit 0 is passed, 16 failed, 17 cancelled or interrupted, 18 `--timeout` ran out (the job keeps running). The job ID is on stderr as soon as it is submitted; `job wait <id>` reattaches.

| Flag                                                                                                                                             | Meaning                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `--check`                                                                                                                                        | Run the project check. The default when nothing else is named.                                                                     |
| `--build ui\|full\|none`                                                                                                                         | A `--test` brings a UI build unless told otherwise. It needs a full build to extend: with none on the host it refuses (see below). |
| `--test <path>...`                                                                                                                               | Browser test files.                                                                                                                |
| `--release`                                                                                                                                      | Build and package the release recipe (below). Takes no `--test`, `--build` or `--check`.                                           |
| `--slot <name>`                                                                                                                                  | Default `auto`: the cheapest free slot on the pin, preferring one already on this source, then a matching build.                   |
| `--headed`, `--no-shard`, `--standalone`, `--env`, `--upload-dir`, `--mach-arg`, `--keep-awake`, `--no-keep-awake`, `--hold-front`, `--throttle` | How the tests run; the same fields a gate lane declares ([proof.md](proof.md#what-a-lane-declares)). They need `--test`.           |
| `--path <path>...`, `--owner`, `--timeout <seconds>`                                                                                             | Extra captured paths, a display label, a wait limit.                                                                               |

A job that needs a built slot waits for a peer that holds one rather than building a second. `job run --test` on a host with no build refuses at submit and exits 1, naming `fireforge job run --build full` and `fireforge job run --build full --test <path>...` (both in one job); a full build takes hours on a real tree. Any other job nothing on the host can ever run is refused the same way, naming the command to run.

`job submit request.json --snapshot snapshot.json` runs anything `job run` does not express (`fireforge authored capture --out snapshot.json` makes the snapshot). `job status`, `job wait`, `job logs`, `job list`, `job cancel <id>` reconnect by ID, or by a prefix of it of at least 8 hex characters that names one job; an ambiguous prefix is refused, listing the IDs it matches. None of the reads starts a supervisor. `job logs` reads bounded chunks (`--offset`, `--limit` up to 1048576 bytes). `--step <n>` reads one step's output, numbered from 0 as in `artifacts/<job>/step-<n>-*`, with offsets counted from its start; a step that ran again after a requeue shows its latest run. Asked for no range, a failed job's log opens on its red step (the last red one when it went on past reds), or that step's last chunk when it is longer, with a note on stderr naming the step and how to read the others; a red step that wrote nothing shows the log from its start. `job status` and `job wait` exit nonzero for failed, cancelled and interrupted jobs.

A request is its steps; everything else has a default:

```json
{ "steps": [{ "command": "test", "args": ["--headless", "browser/foo/browser_x.js"] }] }
```

`sourceId` comes from `--snapshot`. `key` defaults to a digest of the request: a repeat attaches to the live or passed job and runs anew after a failure. An explicit `key` is strict. `slot` is optional. A test or run step may set `env` and `uploadDir`, any step `keepAwake`, and a step may set `deadlineSeconds` (default: full build 6 hours, other builds and tests 2 hours, anything else 1 hour).

## Output

Default output is human text. `--json` writes exactly one JSON document with `schemaVersion` (a job as its record, `job list` as `{jobs}`, `slot list` as `{slots}`), and failures as `{schemaVersion, error, code}`. Whole-number flags (`--cpu`, `--timeout`, `--slots` ...) that are not whole numbers are usage errors: exit 8, code `invalid-argument`. Refusals carry `unknown-job`, `ambiguous-job`, `unknown-slot`, `invalid-log-range`, `job-cannot-run` and `executor-mismatch`, each with the next command in its text. In a queue project, `job run`, `prove`, `slot create|prepare|refresh-deps`, `host init` and the `authored` source commands say to run `fireforge authored migrate --out <directory> --verify`.

## Capacity

Defaults come from the host: every available CPU, 80% of physical memory in GiB, three slots, one browser, one display. A build claims 75% of the CPU budget (or the project's `build.jobs` if lower) and half the memory, and that figure is its `-j`. A static phase claims 2 CPU and 2 GiB, a browser test 2 CPU and 4 GiB. `--browsers <n>` lets more browsers run at once once you have measured that they can; windows stay one at a time.

A job that cannot start reserves what it waits for, and a later job passes it only if it fits and touches nothing reserved. Every queued job reports why in `blockedBy`: the resource, a quarantined slot (with the restore command), the host, the disk or the display. A step with a window waits with `blockedBy: display: <reason>` while no display is active: graphics off, every display asleep, or a closed lid with no external display. A closed lid with an external display counts as active, and an unreadable display counts as available.

A quiet step runs alone on the host. Only a lane, stress, run, check or control that declares `quiet` is quiet. Once the other jobs have drained, it also waits for the host's one-minute load, which counts every process on the host and not only jobs, to fall below the quiet limit: `host init --quiet-load <n>`, by default the CPU capacity. Meanwhile it reports `blockedBy: host-load: one-minute load <x> is at or above the quiet limit <n>`, and every job behind it waits too. A quiet phase still waiting when its step deadline has passed since it queued ends `interrupted`, since nothing ran. A quiet step that goes red while its load peak, less the CPU the step was admitted with, reached the limit also ends `interrupted` (exit 17), with no verdict against the step and its reason naming the peak; the next `prove` runs it again. A pass under load stands. A check stays parallel when every `check.extraSteps` entry declares `"footprint": { "static": true }` (optionally with `cpu` and `memory`): it then claims up to a quarter of the host and needs no toolchain. A step without a footprint may do anything, so that check needs a quiet host and the native toolchain.

A test needs a roster: `expected.files` or test files named as arguments. Each file must start and finish in the harness results; a file that did not is a red.

## Host conditions

A test or run step watches the host on the same 30-second tick as its load peak, and records what changed under it in its evidence as `hostState`, each entry the seconds into the step it was first seen:

| Entry          | Seen when                                                                                   | Read on             |
| -------------- | ------------------------------------------------------------------------------------------- | ------------------- |
| `networkLost`  | no interface other than loopback or a tunnel keeps an address beyond link-local             | every platform      |
| `lidClosed`    | the lid closes                                                                              | macOS               |
| `displaySlept` | no display stays active: graphics off, every display asleep, or a closed lid alone          | macOS               |
| `input`        | keyboard or pointer input reaches the host (`HIDIdleTime` is shorter than the step has run) | macOS, window steps |

Network, lid and display count only once a sample saw them fine, so a step that starts offline or with the lid closed is not excused by it. A red step ends `interrupted` (exit 17) instead, with no verdict against it and its reason naming what changed, when the network went away under any step, the lid closed or the display slept under a quiet step, or input reached a step with a window. The next `prove` runs it again. A pass stands. A red or interrupted job carries its last step's `hostState`, and each red in `stepVerdicts` carries its own; `--json` shows them. `hostState` is context only: no fingerprint, identity or proof reads it.

## Slots

Each pin has one pristine template in the namespace. A slot is a clone of it (`cp -c -R -p`, a physical copy where the volume has no copy-on-write) and takes minutes.

```sh
fireforge slot create b                          # from this checkout
fireforge slot create c --from a                 # clone a built slot, objects included
fireforge slot list | audit <name> | prepare <name> --snapshot s.json | remove <name> | restore <name>
```

- `slot create` works from any checkout and takes only the new slot's lock. `--pristine-repository` is needed only if the pin has no template and the checkout has no `engine/`.
- `slot create` then qualifies the new slot's native sites, as `host init` does, when the host has a frozen toolchain and the source's mozconfigs disable bootstrap; a qualification that goes red fails the command, naming `slot qualify-native <name>`. When it cannot qualify, or `--no-qualify` says not to, it warns on stderr that native jobs refuse on the slot, says why and names `slot qualify-native <name>`.
- `--from <built-slot>` clones source and objdir together, so an incremental build sees only real differences. If this host's toolchain built the source slot, its UI-build anchor comes along (the anchor records which compiled inputs the build holds); otherwise the next build is full. Qualifying the clone relocates its object directory.
- `slot remove` works under the slot's lock in any state and refuses while a process holds a file in the slot.
- Dependency trees: a slot holds the root `node_modules` plus whatever `slots.dependencyCaches` declares as `{source, target, lockfile?}`. `source` is relative to the checkout; one under `engine/` comes from the engine `--from-engine` names; `--cache <target>=<path>` names another place on this host. A `target` is a canonical path that names nothing a slot's runtime owns; inside `engine/` it can only be a `node_modules` that upstream does not track. A tree with npm's install record (`.package-lock.json`) is compared with an npm lockfile, whatever its directory is called, and refused if they disagree. A `node_modules` with no record is refused. Any other tree cannot be compared: `slot refresh-deps`, `slot create` and `host init` say so, and the slot identifies it by its bytes and its lockfile by its digest, so a moved lockfile over the same bytes draws a warning rather than a refusal. A tree holding private state, an absolute link or a link leaving the tree is refused. A job whose lockfile moved refuses and names `fireforge slot refresh-deps <name>...`, which replaces the trees from this checkout and deletes nothing outside their targets. It reads only `fireforge.json` and the declared lockfiles, which must be committed; other uncommitted paths are taken at their committed bytes. Trees follow lockfiles rather than the pin, so it serves slots on another pin than the checkout's; a lockfile the pin itself holds (an engine lockfile the source does not own) is read at the slot's pin, and a tree that disagrees with it is refused.
- Storage: a slot's reservation is what its object directory can still grow to (the largest built slot's size, or five times the source until one exists), checked with the other slots' growth and an 8 GiB free-disk floor. A job waits for room rather than failing. A release build has a second object directory, which is refused at submit unless the disk has room for it above the floor; what the slot's release directory held at its last release counts as already there.

## Failures and recovery

A red step, a refusal before launch and a cancel with a clean process census end the job and return the slot to the pool; the next job there audits it first. A request with `continueOnFailure` (which `prove --tier gate` sets) goes on past a plain red instead: the slot is audited as the next job would audit it, and the job runs its next step. A step that reads the package or builds over the anchor is blocked, not run, when the last build before it went red or was blocked, or when the package could not be vouched for after a red. A step that cannot be settled cleanly or a failed audit still ends the job. The job ends `failed`, its `stepVerdicts` list each red and blocked step, its reason starts `<n> of <m> steps red`, and every step that passed is sealed as evidence. A slot is quarantined only for uncertainty: a process that cannot be shown to be gone, a failed audit, an unrestored negative control, an interrupted or over-30-minute preparation or seal, or a supervisor interrupted while holding it. Jobs waiting on it stay queued and `blockedBy` names it.

- `fireforge slot restore <name>` re-materializes the slot from the template plus its snapshot, keeps its object directory (and declared dependency trees), audits, and clears the quarantine. It refuses while a process uses the slot. The next build must be full. Safe to repeat.
- `slot audit` reports integrity and clears nothing. Do not delete locks or quarantine files by hand.
- A process group that outlives its phase holds its slot until it is gone. A self-detached descendant with no foothold in the slot is reported as `detached=<pids>` on the verdict and the slot is audited next. A process with a working directory or open file in a slot is found at seal and at admission, so an editor or shell sitting in a slot quarantines it.
- Host-wide quarantine (an executor whose start could not be established) shows in `blockedBy` on every job. `fireforge job host-clear` clears it once a process census succeeds; `--forget-group <group>` clears a group whose number now belongs to something else.
- One damaged journal row moves to `journal.damaged.jsonl`; that job ends `interrupted` and the host keeps running. A supervisor that cannot start says why to the client that started it (`supervisor.log`). Terminal jobs older than 30 days leave the journal with their logs.

A red's reason carries the step's last complaint, and a test step's stopping point (`started=<n>/<m> first-unstarted=<path>`) when its verdict has one. A failed job's verdict line names its last step's load peak (`host-load-peak=`), and a failed or interrupted job's names what changed on the host under that step (`host-state=networkLost@12,input@40`). An executor killed from outside ends the job `interrupted` (exit 17) with no verdict against its step.

## Builds and the package

A build advances a slot's identity only when it succeeds. UI-only source changes keep the compiled anchor; C++, Rust, build-manifest or `configs/` changes need a full build. A build that can touch compiled output clears the anchor before it launches, so a failed one leaves nothing a later source could match. Changed tools need `mach clobber objdir --full` and a full build.

A build records a stat signature of its package (`dist/bin` and any `dist/*.app`, minus lock, update, crash and log files). A step that reads the package checks it before launch and every seal checks it again; a package that moved costs the slot its anchor (and `slot audit` reports it), so the next build is full. A harness that writes elsewhere under `dist/` costs a full build per test job, so watch the refusal's named paths.

`run` always uses a fresh temporary profile (`--profile` refuses). `--profile-file` and `--console-allow-file` take only captured files.

`job run --release` submits `package --recipe release`. It needs `build.release` in the config: `overlay` (a captured mozconfig fragment appended last), optionally `secrets: {variable, files}`, and optionally `outputs`. `variable` is set to the directory that `fireforge host init --release-secrets <dir>` recorded, and a missing file refuses at submit. It builds in `.fireforge/release/obj` in the slot, emptied first so every release is built from clean, with the frozen tools and one build date, leaving the development build untouched. `outputs` lists paths in that object directory (`dist/*.app`, `dist/*.dmg`, `dist/host/bin/mar`, `config.status`; `*` only in the last segment), and each is copied to the step's output directory at the same relative path, a clone where the volume supports one. A declared output the build did not produce reads red. The output directory (`output=` on the verdict, kept 30 days with the job's artifacts) holds those copies and `release.json`, the build's identity. Package checks, signing and notarization are the project's, run against those copies.

## Toolchain

The toolchain belongs to the host. `host init --from-engine` reads the engine's `config.statusd/substs`, runs nothing but Python, and clones each tool read-only under `~/.fireforge/toolchains/<digest>/` (`FIREFORGE_TOOLCHAINS` moves the store). The digest covers bytes, relative paths and platform, so hosts with the same tools agree. System and Xcode paths are used in place; so is a Python that could not be cloned (a Homebrew build), or name one with `--python`. `WASI_SYSROOT`, `MACOS_SDK_DIR` and the ONNX Runtime directory (`FIREFORGE_ONNX_RUNTIME_DIR`, turned into `--with-onnx-runtime` by the generated mozconfig) come along; a slot whose configure loses or changes one is refused at qualification.

Identity is checked by stat signature per job and by bytes at derivation, qualification and a request's `finalGate`. Quality tools (FireForge, ESLint, Prettier, Node) are recorded in receipts and cache keys and do not bind the compiled anchor.

Captured mozconfigs must set `--disable-bootstrap`; a native step on one that does not is refused at submit naming the file, line and edit. `slot qualify-native <name>` (which `host init` runs per slot) provisions the Mach sites at the slot's final path and runs `mach configure` with the frozen tools. The sites are `mach`, `common` and `build`, plus `taskgraph` when the source declares `build.release`: `mach package` resolves its DMG tools through `mach taskgraph`, which provisions that site with hash-pinned pip from PyPI, as the build site is. A native step runs only on the recorded sites: a site Mach adds that nobody qualified reads red by name, and a source whose roster differs from the slot's record (a release declared after the slot qualified) is refused before it runs, naming `slot qualify-native <name>`. Qualification provisions afresh any site it did not record and removes a recorded one the source no longer needs.

Installed dependency trees are read by stat signature and re-read when it moves. A slot has no repository, so a project check that needs the tracked file list reads `$FIREFORGE_CAPTURED_FILES`, one path per line.

## Environment

| Variable                        | Effect                                                              |
| ------------------------------- | ------------------------------------------------------------------- |
| `FIREFORGE_COORDINATOR`         | Namespace; default `~/.fireforge/host/jobs`.                        |
| `FIREFORGE_TOOLCHAINS`          | Toolchain store; default `~/.fireforge/toolchains`.                 |
| `FIREFORGE_OWNER`               | Default owner label shown by `job list`.                            |
| `FIREFORGE_PRISTINE_REPOSITORY` | Pristine donor, ahead of the template and the checkout's `engine/`. |

Jobs do not inherit a caller's environment: `PATH`, `HOME`, locale and display cross from the values recorded when the coordinator was set up, and steps declare anything else. The supervisor is a detached child of the first client that needs one, and inherits that client's login session and macOS privacy grants. A first client that is sandboxed or on SSH passes those limits to every job until the supervisor exits: a step with a window then refuses at submit, and a supervisor that cannot read FireForge's own folder is stopped and named by `Coordinator did not start`.

One coordinator runs one FireForge. The supervisor runs from the package of the client that started it, and every checkout or worktree sharing the namespace submits to it. A submit from a client whose FireForge differs (`npm ci` in one worktree only, or a rebuilt checkout) is refused before anything runs, with exit 1 and code `executor-mismatch`: results sealed by the other FireForge would read as stale for this one. The refusal names the supervisor's package and version. Give the checkouts the same install (the same `package-lock.json`, then `npm ci` in each) and let the supervisor go idle: it exits `idleMs` (30 s by default) after its last job, and the next submit starts it from its own package. `job status`, `job wait`, `job logs`, `job list` and `job cancel` work across the difference, as do `prove status` and `prove plan`, which submit nothing.
