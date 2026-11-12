<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Workspaces and parallel work

A **workspace** is a Firefox engine with its object directory (the build output), at a stable path, that commands build, run and test in. This page explains where workspaces live, how parallel sessions share a host, and what the host keeps under `~/.fireforge`.

- In **patch mode** the project's `engine/` is its one workspace. Commands that use it take the engine lock (`.fireforge/locks/engine`) exclusively; `check` and dry runs take it shared, so they overlap each other but not a writer. One patch-mode project is one session at a time.
- In **source mode** workspaces live in a per-host pool. A command leases one for its duration, brings it to its checkout's `src/` (materialization, see [source-workflow.md](source-workflow.md#materialization)) and gives it back when it ends. Parallel sessions are separate git worktrees, each leasing its own workspace.

The rest of this page is about source mode, except the host locks, which apply in both.

## Parallel sessions are git worktrees

A session is a checkout of the project. Make one per line of work with `git worktree`:

```sh
git worktree add ../mybrowser-sidebar -b sidebar
git worktree add ../mybrowser-toolbar -b toolbar
```

Each worktree has its own `src/`, its own `.fireforge/` state and its own branch, and shares the repository's refs and git config (so the merge driver and `refs/fireforge/verified` are shared). Run FireForge commands inside the worktree you are working in.

## The pool

```sh
npx fireforge workspace list
```

```
w1  firefox-esr-140.9.0esr  built  leased by PID 41822  last used by /Users/me/mybrowser-sidebar
w2  firefox-esr-140.9.0esr  built  free  last used by /Users/me/mybrowser-toolbar
```

Each workspace is `~/.fireforge/workspaces/<name>/`, holding `engine/` (a checkout of the pin's pristine commit with the object directory `obj-fireforge` inside) and `workspace.json` (the pin, the last lessee, the build baseline), plus what FireForge records about the engine's content: the materialization ledger, the component deployment record, test run logs.

The first command that needs a workspace for a pin creates `w1`. Further workspaces are your decision, because each costs tens of gigabytes once built:

```sh
npx fireforge workspace add w2
npx fireforge workspace add w3 --from w1
```

- `workspace add <name>` checks the pinned Firefox out of the pristine repository.
- `--from <name>` clones the engine of another workspace copy-on-write instead, with everything recorded about its content (the materialization ledger, the component deployment record), so the clone takes no disk space until it diverges. Its object directory and release build are not copied. Cloning needs a file system with copy-on-write clones (APFS on macOS, Btrfs or XFS with reflinks on Linux) and a source workspace that nobody leases.
- Either way the new workspace needs a full build before it is useful (see [A build stays where it was configured](#a-build-stays-where-it-was-configured)).
- `workspace add` runs inside a project, since the project names the pin.

```sh
npx fireforge workspace repair w2
npx fireforge workspace remove w3
```

- `workspace repair <name>` restores every engine file to the pristine commit, removes added files, and forgets what was recorded about the engine's content, so the next lease materializes the checkout afresh. The object directory and the release build stay.
- `workspace remove <name>` deletes the workspace and its build. It refuses while a command leases it, or while a process started from inside it (a browser left running) is alive.

Both refuse a workspace that is leased.

### A build stays where it was configured

An object directory belongs to the absolute path it was configured at. FireForge never copies or moves a build to another path, and there is no command that brings an engine built elsewhere into the pool: add a workspace and build it.

The reason is what a built object directory holds. `mach configure` at a new path regenerates its own output (`config.status`, the make backend, the install manifests), and nothing makes the build regenerate the rest, which keeps naming the old source:

- `.cargo/config.toml` points cargo at the vendored crates of the old source, and the recorded output of Rust build scripts names the old object directory as a link search path.
- Some of cargo's dependency records hold absolute source paths in a binary format.
- Generated sources embed the paths, some in an escaped spelling that a search for the path does not find.
- The dependency files of every compiled object, and the install tracking files, list old absolute paths. While the old directory exists, make judges staleness by its files, not by the ones being built.

A build continued from such a directory would read, link and judge staleness against another workspace without saying so. So when `fireforge build` finds an object directory configured for another path (a project directory that was moved or renamed, a pool under a `FIREFORGE_HOME` that changed, an engine copied by hand), it warns, removes that object directory and builds from nothing. Moving the directory back before building keeps the build.

## Leasing

A command that works in a workspace (`bootstrap`, `build`, `run`, `test`, `typecheck`, `check`, `watch`, `package`, `gate`, and the `furnace` commands that deploy or compare) leases one for exactly as long as it runs:

1. It takes a free workspace on the project's pin, preferring the one this checkout used last (its object directory is warm for this source, so builds are incremental), then the least recently used.
2. It materializes the checkout into it.
3. It runs. `watch` holds its workspace until you stop it.
4. It releases the workspace. The lease is a lock under `~/.fireforge/locks/`, so a command that dies gives its workspace back by dying.

`--workspace <name>` picks a specific workspace. A workspace on another pin is refused; a patch-mode project refuses `--workspace`.

Commands that only read owned changes (`status`, `verify`, `lint`, `export`) take no workspace: they read `src/` and the pristine repository directly.

## Waiting

When every workspace on the pin is leased, the command waits, naming the holders:

```
Waiting for a free workspace ("w1" by PID 41822 (checkout=/Users/me/mybrowser-sidebar, command=build)): 5s of up to 2h 00m.
```

The same applies to every other lock a command needs (the engine lock in patch mode, the display, a build slot). The default wait is two hours, long enough for the build holding it to finish. Change it per command or per shell:

```sh
npx fireforge build --wait-lock 600
export FIREFORGE_WAIT_LOCK=0
```

`--wait-lock 0` fails at once instead of waiting. A wait that expires exits 15 (`lock-timeout`) and the work never started. Ctrl+C stops a wait.

## Host locks

Two locks are shared by every project and checkout on the host, in both modes:

- **display**: one browser window at a time. `run` without `--headless`, `test --headed`, and headed gate lanes and smoke starts hold it, so two sessions do not fight over focus.
- **build**: a counting lock on compiles. By default one `mach build` runs at a time on the host; raise it in `~/.fireforge/host.json`:

```json
{ "buildSlots": 2 }
```

`host.json` also takes `releaseSecrets`, an absolute directory holding the secret files a release build reads ([configuration.md](configuration.md#build)).

## Host state

Everything FireForge keeps per host lives under `~/.fireforge`, or under `$FIREFORGE_HOME` when that is set:

| Path          | Holds                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `pristine/`   | One bare repository per pin (`pristine/firefox-esr-140.9.0esr/`), the archive imported as one commit |
| `workspaces/` | The pool                                                                                             |
| `locks/`      | The display, build and workspace locks                                                               |
| `cache/`      | Downloaded and verified source archives                                                              |
| `host.json`   | `buildSlots` and `releaseSecrets`                                                                    |

Project state lives under `.fireforge/` in each checkout and is never committed: `state.json`, the gate's results and artifacts, the type-check cache, and in patch mode the engine lock, the build baseline and the test run logs.

### Disk use

A built workspace takes tens of gigabytes; the pool is usually the largest thing on the disk. To reclaim space:

- `fireforge workspace remove <name>` for workspaces you do not need, including those on a pin no project uses after a rebase (`workspace list` shows each workspace's pin).
- A pin's pristine repository and its cached archive are needed only while a project builds on that pin; `fireforge download` recreates them.
- `fireforge doctor` reports free disk space.

## When a workspace reports drift

A workspace belongs to FireForge. When a file inside one was changed by something else, materialization stops with `materialize-drift`, lists the files, and names the repair:

```
error[materialize-drift]: Engine files changed outside FireForge; materialization would overwrite them:
  browser/base/content/browser.js
hint: Save anything you need from /Users/me/.fireforge/workspaces/w1/engine, then run "fireforge workspace repair w1" and retry.
```

Copy anything you want to keep into `src/`, then:

```sh
npx fireforge workspace repair w1
```

The build stays, so the next build is incremental. The same repair answers `journal-conflict` and `materialize-pin-mismatch`.

## Worked example: two sessions

Two pieces of work on one host with two workspaces.

```sh
cd ~/mybrowser
npx fireforge build                    # creates and builds w1
npx fireforge workspace add w2         # the first build in w2 is a full build
git worktree add ../mybrowser-sidebar -b sidebar
git worktree add ../mybrowser-toolbar -b toolbar
```

Terminal 1:

```sh
cd ~/mybrowser-sidebar
npx fireforge override browser/base/content/browser-sidebar.js
$EDITOR src/browser/base/content/browser-sidebar.js
npx fireforge build --ui               # leases w1 or w2, materializes, builds
npx fireforge test browser/base/content/test/sidebar/
```

Terminal 2, at the same time:

```sh
cd ~/mybrowser-toolbar
$EDITOR src/browser/themes/shared/mybrowser-toolbar.css
npx fireforge build --ui               # leases the other workspace
npx fireforge run                      # waits for the display while terminal 1's headed test holds it
```

Each command leases whichever workspace is free and prefers the one its checkout used last, so each worktree keeps returning to its own warm object directory. With `buildSlots` at 1 the two compiles take turns; the rest runs side by side. A third worktree would wait for a free workspace, naming who holds them, until one is released or you add `w3`.

When both branches are merged, the merge driver resolves two first touches of the same upstream file against its pristine blob ([source-workflow.md](source-workflow.md#the-merge-driver)).
