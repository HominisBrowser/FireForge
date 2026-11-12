<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Migrating from 0.56

FireForge 0.60 keeps the two ways of storing a fork (patch mode and source mode) and gives them the same daily commands. Source mode no longer routes work through a host daemon: there are no jobs, slots, supervisor or proof ledger. Builds and tests run in the foreground in a workspace leased from a per-host pool, parallel sessions are git worktrees, and `gate` replaces `prove`. This page lists every command, flag and configuration key that was removed or renamed, and the upgrade steps for each mode.

`fireforge.json` keys that no longer exist are refused (exit 2) with the nearest known key, so a project does not run until it is converted. `fireforge migrate` does the conversion in place ([Upgrading a project](#upgrading-a-project)); the tables below say what it does and what replaces each command.

## Commands

| 0.56                                                       | 0.60                                                                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `config <key> [value]`                                     | `config get <key>`, `config set <key> <value>`                                                                       |
| `source set --version ... --product ... --sha256 ...`      | `rebase --to <version> [--product ...] [--sha256 ...] [--candidate ...]`, which also downloads and moves the changes |
| `export-all`                                               | `export --all --name <name>`                                                                                         |
| `park`                                                     | none; `discard` saves a recovery snapshot of what it throws away                                                     |
| `tree create\|exec\|list\|remove`                          | none; use git worktrees of a source-mode project ([workspaces.md](workspaces.md))                                    |
| `patch tier <patch> <tier>`                                | `patch set <patch> --tier branding\|none`                                                                            |
| `patch lint-ignore`                                        | `patch set <patch> --lint-ignore <rule> [--max <n>] [--reason <text>]`, `--remove-lint-ignore <rule>`                |
| `patch staged-dependency`                                  | `patch set <patch> --staged-dependency <file>:<creates>`, `--remove-staged-dependency`                               |
| `patch body`                                               | none; `git -C engine diff` shows the engine against pristine                                                         |
| `patch stage`                                              | none; `git add patches/`                                                                                             |
| `patch reserve`                                            | none; `patch retire` keeps a deleted patch's order taken                                                             |
| `lint cache clear`                                         | none; the type-check cache validates every entry against file digests                                                |
| `furnace deploy`                                           | `furnace apply`; `build`, `run`, `test`, `package`, `watch` and `gate` deploy on their own                           |
| `furnace init`                                             | none; `furnace.json` is created on the first Furnace edit                                                            |
| `furnace list`, `furnace scan`                             | `furnace status`                                                                                                     |
| `furnace refresh`, `furnace sync`                          | none; `furnace validate` reports `override-base-version-drift`, `furnace diff` shows the override against stock      |
| `furnace preview`, `furnace chrome-doc create\|remove`     | none                                                                                                                 |
| `authored capture`, `authored validate`, `authored prune`  | none; commands read the working tree directly and keep no snapshots                                                  |
| `authored materialize`                                     | none; every workspace command materializes before it starts                                                          |
| `authored status`, `authored delta`                        | `status`; `status --groups` lists the groups by ID                                                                   |
| `authored lint`, `authored typecheck`, `authored verify`   | `lint`, `typecheck`, `verify`                                                                                        |
| `authored override`, `authored restore-upstream`           | `override`, `restore`                                                                                                |
| `authored export-queue --snapshot ... --out <dir>`         | `export [--out <dir>]`                                                                                               |
| `authored migrate --out ... --verify`                      | `migrate --to-source` (in place, on a committed tree)                                                                |
| `authored refresh ...`                                     | `rebase --to <version>`                                                                                              |
| `authored pristine fetch`                                  | `download`                                                                                                           |
| `authored merge-install`, `authored merge-driver`          | `merge-driver install` (git runs the driver itself)                                                                  |
| `host init`                                                | none; the first workspace command creates workspace `w1`; `workspace add` adds more                                  |
| `host status`                                              | `workspace list`, `doctor`                                                                                           |
| `host prune`, `host upgrade`                               | none                                                                                                                 |
| `slot create [--from <slot>]`                              | `workspace add <name> [--from <name>]`                                                                               |
| `slot list`                                                | `workspace list`                                                                                                     |
| `slot remove`                                              | `workspace remove <name>`                                                                                            |
| `slot restore`, `slot audit`                               | `workspace repair <name>`                                                                                            |
| `slot prepare`, `slot qualify-native`, `slot refresh-deps` | none; leasing materializes, `bootstrap` installs toolchains                                                          |
| `job run --check`                                          | `check`                                                                                                              |
| `job run --build ui\|full`                                 | `build --ui`, `build`                                                                                                |
| `job run --test <path>`                                    | `test <path>` (`--build` to build first)                                                                             |
| `job run --run`                                            | `run`                                                                                                                |
| `job run --release`                                        | `package --release`                                                                                                  |
| `job watch`                                                | `watch`                                                                                                              |
| `job submit\|wait\|status\|list\|logs\|cancel\|host-clear` | none; commands run in the foreground, Ctrl+C stops them, `test` prints its log path                                  |
| `prove`, `prove run`                                       | `gate`                                                                                                               |
| `prove accept`                                             | `gate accept <id> --note <text>`                                                                                     |
| `prove status`                                             | `gate status`                                                                                                        |
| `prove publish`                                            | none; a passing `gate` moves `refs/fireforge/verified` itself                                                        |
| `prove plan`, `prove waive`                                | none; `gate --lane <id>` runs entries for feedback                                                                   |
| (none)                                                     | `workspace`, `override`, `restore`, `migrate`, `merge-driver install`, `gate`, `patch set`, `version`                |

The global `--ignore-corrupt-tree-marker` is gone with `tree`.

## Flags of commands that remain

Flags not listed kept their name and meaning.

| Command                        | 0.56                                                                                                                                                                                                                                                                 | 0.60                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `setup`                        | `--force`, `--yes`                                                                                                                                                                                                                                                   | removed; setup refuses a directory with `fireforge.json`. `--mode patches\|source` added                        |
| `config`                       | `--force`                                                                                                                                                                                                                                                            | removed                                                                                                         |
| `download`                     | `--yes`                                                                                                                                                                                                                                                              | removed; `--force` replaces `engine/` after a recovery snapshot                                                 |
| `build`                        | `--brand`                                                                                                                                                                                                                                                            | removed; select branding with `--with-branding` in `configs/common.mozconfig`                                   |
| `build`                        | `--keep-log`, `--refuse-unexported-drift`, `--rewrite-mozinfo`, `--wait-browser`                                                                                                                                                                                     | removed; an object directory configured for another path is removed and the build starts from nothing           |
| `run`                          | `--no-purge-caches`                                                                                                                                                                                                                                                  | removed. `--build` and `--screenshot` added                                                                     |
| `package`                      | `--recipe release`                                                                                                                                                                                                                                                   | `--release`                                                                                                     |
| `package`                      | `--brand`, `--allow-stale-build`                                                                                                                                                                                                                                     | removed; `--build` builds first. `--out` and `-j, --jobs` added                                                 |
| `test`                         | `--headless`                                                                                                                                                                                                                                                         | the default; `--headed` shows the browser                                                                       |
| `test`                         | `--negative-control`                                                                                                                                                                                                                                                 | `--control <diff> --expect <assertion>`                                                                         |
| `test`                         | `--restart-between-tests`                                                                                                                                                                                                                                            | `--standalone`                                                                                                  |
| `test`                         | `--shard-size <n>`                                                                                                                                                                                                                                                   | `--shard` (default, one browser per file) or `--no-shard` (one browser)                                         |
| `test`                         | `--auto-ports`                                                                                                                                                                                                                                                       | `test.mochitestPorts: "auto"`                                                                                   |
| `test`                         | `--reap-orphans`, `--kill-stale-marionette`, `--wait-port`                                                                                                                                                                                                           | removed; leftovers of the workspace are reaped and foreign port holders waited for automatically                |
| `test`                         | `--allow-stale-build`, `--allow-stale-components`, `--furnace-apply`, `--no-furnace-apply`, `--build-only`                                                                                                                                                           | removed; components are always deployed, a stale build is refused or built with `--build`; `build` builds alone |
| `test`                         | `--auto`, `--canary`, `--doctor`, `--extend-coverage`, `--full-output`, `--generic-mach-test`, `--harness-retries`, `--jobs`, `--marionette-port`, `--perf-samples`, `--pgid-file`, `--profile-file`, `--refuse-unexported-drift`, `--shared-lock`, `--wait-browser` | removed. `--env NAME=VALUE` added                                                                               |
| `status`                       | `--fail-on`, `--allow`, `--fail-on-unknown`                                                                                                                                                                                                                          | `check.status.failOn` and `check.status.allow`; `status --check` fails on anything pending                      |
| `status`                       | `--raw`, `--summary`, `--ownership`, `--include-ownership`, `--unmanaged`, `--lock`, `--patches`, `--test-coverage`                                                                                                                                                  | removed; `status --json` lists every owned path with its group                                                  |
| `lint`                         | `--report <path>`                                                                                                                                                                                                                                                    | `--json`, or `check.lintReport` inside `check`                                                                  |
| `lint`                         | `--patches`, `--since`, `--only-introduced`, `--notices`, `--no-cache`                                                                                                                                                                                               | removed                                                                                                         |
| `verify`, `check`              | `--patches`                                                                                                                                                                                                                                                          | removed                                                                                                         |
| `check`                        | `--jobs`                                                                                                                                                                                                                                                             | removed. `--workspace` and `--wait-lock` added                                                                  |
| `typecheck`                    | `--source-files`                                                                                                                                                                                                                                                     | removed; the owned files are always checked                                                                     |
| `doctor`                       | `--repair-patches-manifest`, `--repair-files-affected`, `--repair-furnace`, `--allow-metadata-loss`, `--clear-resolution`, `--post-rebase-audit`, `--dry-run`, `--wait-lock`                                                                                         | `--recover` undoes interrupted changes; the rest removed                                                        |
| `import`                       | `--dry-run`, `--yes`                                                                                                                                                                                                                                                 | removed; `verify` checks that the queue replays                                                                 |
| `discard`                      | `--dry-run`, `--to-upstream`, `--yes`                                                                                                                                                                                                                                | removed; a recovery snapshot keeps what is discarded                                                            |
| `reset`                        | `--dry-run`                                                                                                                                                                                                                                                          | removed                                                                                                         |
| `resolve`                      | `--yes`                                                                                                                                                                                                                                                              | removed                                                                                                         |
| `export`                       | `--category`                                                                                                                                                                                                                                                         | the first word of `--name` is the category                                                                      |
| `export`                       | `--lint-ignore`                                                                                                                                                                                                                                                      | `patch set --lint-ignore`, or `patchLint.waivers`                                                               |
| `export`                       | `--dry-run`, `--skip-lint`, `--allow-overlap`, `--allow-stale-furnace`, `--exclude-furnace`, `--force-unsafe`, `--supersede`, `--yes`                                                                                                                                | removed. `--all` and, in source mode, `--out` added                                                             |
| `re-export`                    | `--tier`, `--lint-ignore`                                                                                                                                                                                                                                            | `patch set --tier`, `patch set --lint-ignore`                                                                   |
| `re-export`                    | `--scan-file`, `--scan-files`                                                                                                                                                                                                                                        | `--scan`                                                                                                        |
| `re-export`                    | `--files`, `--exclude-hunks`, `--hunks-from`, `--expect*`, `--adjacent-ignore*`, `--allow-shrink`, `--allow-stale-furnace`, `--declarations-out`, `--force-unsafe`, `--no-cache`, `--refuse-adjacent-unmanaged`, `--refuse-foreign-drift`, `--skip-lint`, `--yes`    | removed; an edit to a file several patches change goes to the last re-exported one                              |
| `rebase`                       | `--max-fuzz`, `--yes`                                                                                                                                                                                                                                                | removed. `--to`, `--product`, `--sha256` added                                                                  |
| `patch rename`                 | `--to <name>`, `--category`, `--description`, `--order`                                                                                                                                                                                                              | `patch rename <patch> <name>`; `patch set --description`; `patch reorder`                                       |
| `patch reorder`                | `--to`, `--from`, `--through`, `--shift`, `--map-out`                                                                                                                                                                                                                | `--order <n>`, `--before <patch>`, `--after <patch>`                                                            |
| `patch split`                  | `--files`, `--category`, `--declarations-out`, `--map-out`, `--skip-lint`                                                                                                                                                                                            | files as arguments: `patch split <patch> <files...> --name <name>`                                              |
| `patch move-files`             | `--file`, `--scan-file`, `--create`, `--category`, `--description`, `--order`, `--retire-empty`, `--declarations-out`, `--skip-lint`                                                                                                                                 | `patch move-files <from> <to> <files...>`; an emptied source is removed                                         |
| `patch delete`, `patch retire` | `--delete-created`                                                                                                                                                                                                                                                   | removed; `discard` the files afterwards                                                                         |
| `patch *`                      | `--dry-run`, `--force-unsafe`, `--yes`                                                                                                                                                                                                                               | removed; operations that would change the produced tree are refused                                             |
| `furnace apply`                | `--force`, `--watch`                                                                                                                                                                                                                                                 | removed; `watch` follows component edits                                                                        |
| `furnace create`               | `--with-tests`, `--xpcshell`, `--test-style`, `--test-dir`                                                                                                                                                                                                           | `--tests browser-chrome\|mochikit\|xpcshell`                                                                    |
| `furnace create`               | `--allow-prefix-mismatch`                                                                                                                                                                                                                                            | removed; change `componentPrefix` instead                                                                       |
| `furnace override`             | `--type css-only\|full`                                                                                                                                                                                                                                              | `--css-only`                                                                                                    |
| `furnace remove`               | `--yes`                                                                                                                                                                                                                                                              | removed; `--dry-run` shows what would change                                                                    |
| `furnace validate`             | `--fix`                                                                                                                                                                                                                                                              | removed                                                                                                         |
| `wire`                         | `--subscript-dir`, `--target`                                                                                                                                                                                                                                        | `wire.subscriptDir`, `wire.domTarget` in `fireforge.json`                                                       |

Every command that works in a workspace takes `--workspace <name>` and `--wait-lock <seconds>`; the default wait is two hours.

## Configuration

| 0.56                                                                                                     | 0.60                                                                                                                       |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `sources: { schemaVersion, mode: "authored", root, metadataRoot, pristineCommit }`                       | `"mode": "source"` and `source: { root, metadataRoot, pristineCommit }`                                                    |
| no `sources` block                                                                                       | `"mode": "patches"` (the default; may be left out)                                                                         |
| `proof.gate.{build, lanes, stress, controls, runs, acceptance}`                                          | `gate.{build, lanes, stress, controls, runs, acceptance}`                                                                  |
| `proof.noneRoutes`                                                                                       | `gate.documents`                                                                                                           |
| `proof.mainBranch`, `proof.consumerLimit`, `proof.gate.mode`, `proof.gate.check`                         | removed                                                                                                                    |
| lane `owns`, `quiet`, `args`, `keepAwake`, `holdFront`, `throttle`; `validate.footprint`                 | removed                                                                                                                    |
| stress `context`                                                                                         | removed                                                                                                                    |
| control `compiled`, `always`                                                                             | removed; a control builds what its mutation needs and always runs                                                          |
| run `args: ["--smoke-exit", "20", "--headless", "--console-allow-file", "f", "--", "-url", "about:"]`    | `{ "smokeExit": 20, "headless": true, "consoleAllowFile": "f", "args": ["-url", "about:"] }`                               |
| run `quiet`, `env`, `uploadDir`, `keepAwake`                                                             | removed                                                                                                                    |
| acceptance `owns`                                                                                        | removed                                                                                                                    |
| `slots` (`dependencyCaches`)                                                                             | removed                                                                                                                    |
| `test.canaryPath`, `test.canaryTimeoutSeconds`, `test.reapOrphans`, `test.lockMode`, `test.furnaceApply` | removed; `test.mochitestPorts` stays, `test.harnessFailurePatterns` added                                                  |
| `check.extraSteps[].command` as a shell string, `cwd`, `footprint`                                       | `command` as an argument vector run from the project root without a shell; `engine: true` for a step that reads the engine |
| `check.extraSteps[].timeout` unbounded by default                                                        | default 600 seconds                                                                                                        |
| `check.timeout`, `check.timeouts`, `check.status.failOnUnknown`                                          | removed                                                                                                                    |
| `check.skip` steps                                                                                       | adds `token-lint`                                                                                                          |
| `patchLint.jsdocClassMethods`                                                                            | `patchLint.rules["jsdoc-class-method"]`                                                                                    |
| `patchLint.chromeScriptJsDoc`                                                                            | `patchLint.rules["chrome-script-jsdoc"]`                                                                                   |
| `patchLint.testAssertionFloor`                                                                           | `patchLint.rules["test-needs-assertion"]`                                                                                  |
| `patchLint.forwardRegistration`                                                                          | removed; `forward-registration` always runs in patch mode, its severity set in `patchLint.rules`                           |
| `patchLint.prettier`                                                                                     | removed; run Prettier as a `check.extraSteps` entry                                                                        |
| `<metadataRoot>/waivers.json` (source mode)                                                              | `patchLint.waivers`, and `exportQueue.componentTiers` for tiers                                                            |
| `<metadataRoot>/policy.json`, `cutover-map.json`, `legacy-manifest.json` (source mode)                   | removed; a scope rule `policy.json` retired is dropped, and created files are judged file by file, not by group size       |
| `history.path`                                                                                           | removed                                                                                                                    |
| `patchPolicy.mutationMode: "force"`                                                                      | `"error"`                                                                                                                  |
| no `license` key (it meant `MPL-2.0`)                                                                    | `"license": "MPL-2.0"`, written out; the default is `EUPL-1.2`                                                             |
| `patchPolicy.scopeRules[].category`, `.filenamePattern`                                                  | `patchPolicy.scopeRules[].group`, a regular expression over group IDs                                                      |
| `wire` with `subscriptDir`                                                                               | adds `domTarget`                                                                                                           |

The severity keys take `off`, `warning` or `error` in 0.56 and `off`, `notice`, `warning` or `error` in `patchLint.rules`.

A `scopeRules` entry with `category: "ui"` becomes `{ "group": "^\\d+-ui-", "files": [...] }`; one with `filenamePattern: "X"` becomes `{ "group": "X", ... }`. The expression runs over group IDs: patch file names in patch mode, and in source mode the names `status --groups` lists ([source-workflow.md](source-workflow.md#groups)).

### Override records

A source-mode override record carried `schemaVersion`, its own `path` and the archive digest `base.pin`. A record holds `kind`, `base` (`commit`, `blob`, `mode`), `component`, `classification` and `adr`; the path is the record file's location. The component is kept as written. The merge driver `fireforge-authored` is `fireforge`.

### Patch manifest

`patches/patches.json` with `"version": 1` (rows carrying `filename`, `category`, `filesAffected`, `sourceVersion`, `sourceProduct`) is read as it is and written as version 2 on the next change to the queue: the file name, category and touched files are derived, and the Firefox stamp is stored once for the queue. To convert it at once:

```sh
npx fireforge re-export --all --stamp
```

### Object directory

FireForge places the object directory itself, at `obj-fireforge` inside every engine, and refuses a mozconfig template that sets `MOZ_OBJDIR`. `migrate` deletes `MOZ_OBJDIR` lines from `configs/*.mozconfig`. The first build after the upgrade is a full build in the new directory; the old `engine/obj-*` directory can be deleted.

### Host state

0.56 kept its coordinator, slots, job artifacts and frozen toolchains under `~/.fireforge/host/` and `~/.fireforge/toolchains/`, and the download cache in each project's `.fireforge/cache/`. 0.60 keeps `pristine/`, `workspaces/`, `locks/`, `cache/` and `host.json` under `~/.fireforge` ([workspaces.md](workspaces.md#host-state)).

- **The pristine repository is reused.** The archive imports as the same commit in both versions, and a repository 0.56 left under `~/.fireforge/pristine/` serves the pin as it is, so nothing is downloaded and `source.pristineCommit` does not change. (0.56 filed a release-candidate pin without its `candidate`; such a repository is used when its record and `firefox.sha256` name the same archive.)
- **Builds held in slots are not reused.** An object directory records the path it was configured at in files no rewrite reaches (Cargo's build-script outputs, generated sources, the vendored-crate configuration), and a slot's also names the frozen toolchain. The first `fireforge build` creates workspace `w1` and builds it in full.
- To keep a download on a host without the pristine repository, move the archive from the project's `.fireforge/cache/` to `~/.fireforge/cache/` first; `download` verifies and uses it.

Once no 0.56 command or supervisor runs on the host and the first build has passed, delete:

```sh
rm -rf ~/.fireforge/host ~/.fireforge/toolchains
```

and any pristine donor you created with `authored pristine fetch --out <dir>`.

## Upgrading a project

`fireforge migrate` upgrades a 0.56 project in place, in either mode. It needs a committed tree, and git is its undo.

1. **With 0.56**, let running jobs finish (source mode) or finish any paused import or rebase and capture every edit (patch mode), and commit everything.
2. Install 0.60:

   ```sh
   npm install --save-dev @hominis/fireforge@0.60.1
   ```

3. Upgrade:

   ```sh
   npx fireforge migrate
   ```

   In one transaction it:
   - rewrites the keys of `fireforge.json` listed under [Configuration](#configuration), keeping the layout of everything it does not change;
   - deletes `MOZ_OBJDIR` lines from `configs/*.mozconfig`;
   - in source mode, rewrites every override record, names the merge driver `fireforge` in `<source.root>/.gitattributes`, applies the decisions of `policy.json`, turns `waivers.json` into `patchLint.waivers` and `exportQueue.componentTiers`, and deletes `waivers.json`, `policy.json`, `cutover-map.json` and `legacy-manifest.json`;
   - installs the merge driver in the repository's git configuration, and ends by running `verify`.

   A source-mode project needs its pin's pristine repository for this; `migrate` downloads the pin when the host lacks it.

   It prints every key it converted and every key or file it removed, each with the reason. Nothing is dropped unnamed, and a project already upgraded is left alone.

4. Read what it could not decide.
   - **Blockers.** A key or file that needs a decision stops the upgrade before anything is written (`migrate-blocked`, exit 2), each named with what to do: a smoke start argument with no structured equivalent, an extra step that ran in another directory, a scope rule `policy.json` retained as a path scope, a key neither version knows. Change each one, commit, and run `migrate` again.
   - **For you to check or decide.** A waiver that covered some files of a Furnace component and not others is left out, because a waiver names a whole group: `migrate` prints the `patchLint.waivers` entry that would waive the whole component; add it, or fix what `lint` then reports. It also names the converted keys that need a look (step 6).
   - **Left for you.** The repository's git configuration keeps the `fireforge-authored` merge driver while other checkouts still use it. When none does: `git config --remove-section merge.fireforge-authored`.

5. Review and commit:

   ```sh
   git diff
   npx fireforge status
   npx fireforge lint
   git add -A && git commit -m "Upgrade to FireForge 0.60"
   ```

   `git checkout .` undoes an upgrade that is not committed.

6. Finish the configuration by hand where the old keys had no mechanical equivalent:
   - `check.extraSteps`: set `"engine": true` on every step that reads engine files; it then runs holding a workspace, with `FIREFORGE_ENGINE` naming the engine. A command that used shell syntax runs as `["sh", "-c", "..."]`; split it into steps or a script when you can.
   - `gate` validators: the harness uploads into `{artifacts}/upload`, so an argument that names an uploaded file needs that directory (`migrate` names each such validator).
   - `gate`: every lane, stress run and control runs in every gate. Lanes that `owns` restricted to some paths, and acceptances with `owns`, apply always; use `gate.documents` for the commits that need `check` alone.
   - `patchLint.prettier` is gone: run Prettier as a `check.extraSteps` entry.

7. Build.
   - **Source mode.** The first build creates workspace `w1` and builds in full; add workspaces for parallel sessions:

     ```sh
     npx fireforge build
     npx fireforge workspace add w2
     ```

   - **Patch mode.** Replace `engine/` with a checkout of the pin from the host's pristine repository, apply the queue, and build. `download --force` keeps the old engine's uncommitted changes as a recovery snapshot; its build is not kept. `re-export --all --stamp` writes the manifest in its current form.

     ```sh
     npx fireforge download --force
     npx fireforge import
     npx fireforge build
     npx fireforge re-export --all --stamp
     ```

8. Delete the old host state (see above).

`.fireforge/` in the project is left as it is: the state document keeps the sections it does not know, and nothing else there is read. The old `engine/obj-*` directory of a patch-mode project can be deleted.

A patch-mode project that had no `license` key and none of the keys above already validates, so `migrate` finds nothing to do; add `"license": "MPL-2.0"` to keep the header `lint` expects.
