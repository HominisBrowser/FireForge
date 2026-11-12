<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Getting started

This page takes you from an empty directory to a built, running fork, then shows the loop you repeat every day. It covers both ways a project can store its changes:

- **Patch mode**: you edit Firefox in place under `engine/`, and FireForge stores your changes as a numbered queue of `.patch` files in `patches/`.
- **Source mode**: your changes are ordinary files under `src/`, tracked by git. `src/<path>` supplies the Firefox file `<path>`. FireForge builds them in a workspace it keeps on the host, and can write a patch queue from them whenever you want one.

Both modes use the same daily commands with the same flags. Pick source mode when several people or several checkouts work at once; pick patch mode for a small fork kept by one person. [migrating.md](migrating.md) covers the previous release; `fireforge migrate` converts a patch-mode project to source mode later.

## Requirements

- Node.js 22.22.2 or later
- Git
- Python 3
- The Firefox platform build tools: the Xcode command line tools on macOS, the `build-essential` packages on Linux, Visual Studio Build Tools on Windows. `fireforge bootstrap` installs the rest.
- Watchman, only for `fireforge watch`
- Disk: a built Firefox takes tens of gigabytes. In source mode each further workspace costs that again (see [workspaces.md](workspaces.md)).

## Create the project

Install FireForge into a fresh directory that is a git repository:

```sh
mkdir mybrowser && cd mybrowser
git init
npm init -y
npm install --save-dev @hominis/fireforge
```

Then create the project. Every value can also be answered at a prompt when you leave the option out.

Patch mode:

```sh
npx fireforge setup --name MyBrowser --vendor "My Company" --firefox-version 140.9.0esr --mode patches
```

Source mode:

```sh
npx fireforge setup --name MyBrowser --vendor "My Company" --firefox-version 140.9.0esr --mode source
```

`setup` writes:

- `fireforge.json`: the project configuration ([configuration.md](configuration.md)).
- `configs/*.mozconfig`: the build configuration templates. FireForge fills in your browser's name and identity and places the object directory itself; a template that sets `MOZ_OBJDIR` is refused.
- `LICENSE`, and `.gitignore` entries for `engine/` (patch mode) and `.fireforge/`, the project's local state.
- Source mode only: `src/.gitattributes`, which routes owned files through FireForge's merge driver. Creating a source-mode project also downloads the pinned Firefox, because `fireforge.json` records the exact commit it imports as (`source.pristineCommit`).

Commit the result:

```sh
git add -A && git commit -m "Create MyBrowser"
```

## Download, bootstrap, build, run

The same five commands work in both modes.

```sh
npx fireforge download
npx fireforge bootstrap
npx fireforge build
npx fireforge run
```

- `download` fetches the Firefox source archive named in `fireforge.json`, checks its SHA-256, and imports it as one commit into a pristine repository under `~/.fireforge/pristine/`. In patch mode it then checks that commit out as `engine/`. A host that already has the pin downloads nothing.
- `bootstrap` runs `mach bootstrap`, which installs the compilers and libraries Firefox needs. It may prompt and ask for elevated rights.
- `build` runs a full `mach build`. The first one takes an hour or more.
- `run` starts the browser you just built. Arguments after `--` go to the browser: `npx fireforge run -- --jsconsole`.

In patch mode, a project that already has a patch queue applies it before the first build:

```sh
npx fireforge import
```

In source mode there is no `engine/` in the project. `bootstrap`, `build`, `run` and `test` lease a workspace from the host pool, the first one called `w1`, and bring it to your checkout's `src/` before they start. [workspaces.md](workspaces.md) explains the pool.

## Make a first change

Patch mode: edit the file inside `engine/`.

```sh
$EDITOR engine/browser/base/content/browser.js
```

Source mode: a Firefox file is touched only after `override` records which upstream version you started from. It copies the pristine file to `src/` for you to edit:

```sh
npx fireforge override browser/base/content/browser.js
$EDITOR src/browser/base/content/browser.js
```

A file Firefox does not have needs no override; create it under `src/`:

```sh
mkdir -p src/browser/base/content/mybrowser
$EDITOR src/browser/base/content/mybrowser/panel.mjs
```

## The daily loop

The loop is the same in both modes. Only the step that records your work differs.

| Step                   | Patch mode                                                        | Source mode                                                              |
| ---------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Edit                   | files under `engine/`                                             | files under `src/` (`fireforge override <path>` first for upstream ones) |
| See what you own       | `fireforge status`                                                | `fireforge status`                                                       |
| Quality rules          | `fireforge lint`                                                  | `fireforge lint`                                                         |
| Types                  | `fireforge typecheck`                                             | `fireforge typecheck`                                                    |
| Rebuild the front end  | `fireforge build --ui`                                            | `fireforge build --ui`                                                   |
| Run the tests          | `fireforge test <path>`                                           | `fireforge test <path>`                                                  |
| Record the work        | `fireforge export <paths> --name <name>` or `fireforge re-export` | `git commit`                                                             |
| Everything static once | `fireforge check`                                                 | `fireforge check`                                                        |

As commands, patch mode:

```sh
npx fireforge status
npx fireforge lint
npx fireforge typecheck
npx fireforge build --ui
npx fireforge test browser/base/content/test/mybrowser/browser_panel.js
npx fireforge export browser/base/content/mybrowser --name ui-panel -d "The MyBrowser panel"
npx fireforge check
git add patches && git commit -m "Add the panel"
```

Source mode:

```sh
npx fireforge status
npx fireforge lint
npx fireforge typecheck
npx fireforge build --ui
npx fireforge test browser/base/content/test/mybrowser/browser_panel.js
npx fireforge check
git add src .fireforge-sources && git commit -m "Add the panel"
```

What each step does:

- `status` lists the owned changes (every path the project adds, modifies or deletes relative to the pinned Firefox) and anything unaccounted for: in patch mode, edits no patch holds yet; in source mode, upstream files edited without an override. `status --check` exits 1 when anything is listed.
- `lint` runs the quality rules over the owned changes ([quality.md](quality.md)).
- `typecheck` checks the `jsconfig` projects in `typecheck.projects` and the strict typing of owned files.
- `build --ui` rebuilds only the front end (`mach build faster`). When a compiled source or a build definition changed since the last build, it runs a full build instead.
- `test` runs mochitest, xpcshell and reftest files through mach and ends with one `FIREFORGE-VERDICT:` line ([testing.md](testing.md)). It refuses a build older than the source; `--build` builds first.
- In patch mode, `export` captures edits into a new patch and `re-export` rewrites existing patches from what `engine/` holds ([patch-workflow.md](patch-workflow.md)). In source mode git is the record; `fireforge export` writes a patch queue from `src/` when you want one ([source-workflow.md](source-workflow.md)).
- `check` runs status, verify, lint, typecheck, component validation, the token checks and your own extra steps as one judgement ([quality.md](quality.md)).

Before you push, `fireforge gate` runs `check`, a build and the test lanes `fireforge.json` declares on the committed tree, and marks the commit verified ([gate.md](gate.md)).

## When something is wrong

```sh
npx fireforge doctor
```

`doctor` checks the configuration, git, the pinned source, the engine or the workspace pool, the stored changes, interrupted runs, locks, disk space, generated typing files and the tools `externalToolchains` declares, and says what to run for each problem. `doctor --recover` undoes changes an interrupted command left half-made.

Every failure prints `error[<code>]: <message>` with its stable code, and a `hint:` line saying what to do next. Scripts read the exit code ([exit-codes.md](exit-codes.md)) and `--json` ([machine-output.md](machine-output.md)).
