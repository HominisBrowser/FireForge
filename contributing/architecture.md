<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Architecture

FireForge maintains a Firefox fork: it acquires a pinned Firefox source, keeps the fork's changes
apart from upstream, enforces quality rules on those changes, and builds, runs and tests the result.
This document is the map of the code and the rules it follows. A change that breaks a rule here
changes this document in the same commit. [lifecycle.md](lifecycle.md) holds the invariants of a
running process: exiting, signals, locks and rollback.

## Concepts

- **Project**: a directory with `fireforge.json`. Its `mode` is `patches` or `source`.
- **Pin**: the Firefox version, product and archive checksum the project builds on.
- **Engine**: a checkout of the pinned Firefox with the project's changes applied.
- **Owned change**: one path the project adds, modifies or deletes relative to the pin. Every
  quality rule (lint, policy, typecheck scope) is defined over the set of owned changes, never over
  a mode's storage format.
- **Patch mode**: the project edits `engine/` in place. Owned changes are stored as a numbered patch
  queue in `patches/` with a manifest. `import` applies the queue, `export` and `re-export` capture
  edits back into it.
- **Source mode**: owned files are ordinary tracked files under `src/`, where `src/<path>` supplies
  engine file `<path>`. An upstream file is touched only after `override` records its upstream
  identity. The patch queue is generated output (`export`).
- **Workspace**: an engine with its object directory, at a stable path, that commands build and test
  in. In patch mode the project's `engine/` is its one workspace. In source mode workspaces live in
  a per-host pool; a command leases one for its duration, brings it to the checkout's source
  (materialize), and releases it. Parallel sessions are separate git worktrees leasing separate
  workspaces.
- **Gate**: `check` plus a build and the declared test lanes, run on a clean committed tree. A pass
  with every declared acceptance recorded moves `refs/fireforge/verified` to that commit.

The daily commands (`status`, `lint`, `typecheck`, `check`, `build`, `test`, `run`) mean the same
thing and take the same flags in both modes. A mode adds verbs for its storage only.

## Layout

```
bin/fireforge.ts     process entry: signals, exit code, stdio drain. The only caller of process.exit.
src/
  kernel/            no FireForge concepts: fs, json, json-edit, hash, glob, text, time, process, lock, journal,
                     signals, schema, errors, log, tty
  cli/               command definition, option parsing, output (human, --json, verdict line), error boundary,
                     the version and build identity
  config/            the fireforge.json schema (single source of types, validation and key paths), load, edit
  git/               git plumbing, byte-exact diff generation, status, private index
  diff/              unified diff model: parse, write, apply in memory
  mozbuild/          jar.mn, moz.build and test-manifest parsing and editing
  syntax/            the languages the fork's files are written in: JavaScript (acorn), CSS, fragment
                     markers
  project/           project context: root discovery, paths, the state document, the git checkout, the
                     owned-change model both modes produce, the tracked-files interface, license headers
  engine/            acquisition (archive, pristine repository), workspaces and the pool, host locks,
                     mach (mozconfig, invocation, output hints), build and staleness, run and smoke starts,
                     package, watch
  queue/             patch mode: manifest, transactions, apply, baseline, capture, queue operations, rebase
  source/            source mode: override records, materialize, queue export plan, adoption, merge driver, pin refresh
  lint/              rules over owned changes, policy, checkJs, cache
  typecheck/         project typecheck
  test/              test runs: preflight, harness invocation, crash classification, verdict, negative controls
  furnace/           component deployment, registration, validation, scaffolding, generated typing files
  tokens/            design-token files
  register/          build-manifest registration and chrome subscript wiring
  mode/              the one place that asks which mode is active: owned changes, workspace acquisition,
                     tracked files, status and verify, queue export, migration, the upgrade of a project
                     in the previous format, rebase, project setup,
                     watch, the mode-dependent diagnostics
  check/             the composed static check and the gate
  doctor/            diagnostics
  commands/          one file per top-level command: declares the command and calls its feature module
  testing/           fixtures shared by tests (temporary git repositories, synthetic Firefox trees, projects
                     of either mode, the stand-in mach)
```

### Layering

Imports go downward only:

```
commands  →  check, doctor  →  mode  →  feature modules  →  project  →  config, git, diff, mozbuild, syntax  →  cli, kernel
```

- `kernel` imports nothing from the rest of `src`.
- Feature modules (`engine`, `queue`, `source`, `lint`, `typecheck`, `test`, `furnace`, `tokens`,
  `register`) do not import `commands`, and import each other only through the other module's
  `index.ts`.
- `queue` and `source` never import each other. What both need (the owned-change model, diff
  writing, the engine) is below them.
- Only `mode` branches on the project's mode. Below it the mode appears only where the two project
  shapes are built (`config/schema/source.ts`, `project/project.ts`) and where a mode-only command
  narrows its project (`requirePatchMode`, `requireSourceMode`). `mode` turns either storage into the owned-change set
  (`ownedChanges`), gives a command its workspace (`withWorkspace`) and its writer for tracked
  engine files (`trackedFiles`). Feature modules that judge, build or edit (`lint`, `typecheck`,
  `test`, `furnace`, `register`, `tokens`) take a change set, a workspace or a `TrackedFiles` as an
  argument and never ask where it came from.
- The exact allowed imports per module are the `MODULE_IMPORTS` table in `eslint.config.js`.
- A module exposes its API from `index.ts`. Files inside a module are free to import each other.
- No barrel exists only to keep old import paths alive, and no file re-exports another module's API.

ESLint enforces the layering with `no-restricted-imports` per directory, and `dpdm` refuses cycles.

## Rules

### One mechanism each

Each of these has exactly one implementation, and new code uses it:

| Need                                                        | Owner                              |
| ----------------------------------------------------------- | ---------------------------------- |
| File reads and writes, atomic replace, JSON documents       | `kernel/fs.ts`, `kernel/json.ts`   |
| Editing a JSON file without changing its layout             | `kernel/json-edit.ts`              |
| Hashing                                                     | `kernel/hash.ts`                   |
| Spawning, process groups, process identity, listing         | `kernel/process/`                  |
| Locks (exclusive, shared, queued, with crash recovery)      | `kernel/lock.ts`                   |
| Multi-file changes that roll back on failure or signal      | `kernel/journal.ts`                |
| Validation of untrusted documents                           | `kernel/schema.ts`                 |
| Globs                                                       | `kernel/glob.ts`                   |
| Git invocation                                              | `git/`                             |
| Parsing, writing and applying a unified diff                | `diff/`                            |
| Parsing and editing `jar.mn`, `moz.build`, test manifests   | `mozbuild/`                        |
| Parsing JavaScript, walking its AST, blanking its comments  | `syntax/js.ts`                     |
| CSS comments, declarations, `var()` references, raw colours | `syntax/css.ts`                    |
| `@fireforge-include` fragment markers                       | `syntax/fragments.ts`              |
| The upstream-edit comment marker                            | `config/schema/identity.ts`        |
| Applying a patch to an engine                               | `queue/apply.ts`                   |
| Producing a patch body from an engine or from source        | `git/diff.ts`                      |
| Deciding whether a build is stale                           | `engine/staleness.ts`              |
| Refusing a stale build, or building first                   | `engine/build.ts`                  |
| The default wait for what another command holds             | `kernel/lock.ts`, `cli/command.ts` |
| The lock over a patch-mode project's engine and queue       | `engine/workspace.ts`              |
| Engine files a project tracks, read and written per mode    | `project/tracked.ts`, `mode/`      |
| License header text and its detection                       | `project/license.ts`               |
| Resolving a configured path to the engine or the project    | `project/project.ts`               |
| A command's options, their types and help text              | the command's `defineCommand` call |
| A config key, its type, validation and documentation string | `config/schema/`                   |
| The project state document and its sections                 | `project/state.ts`                 |
| The owned-change model lint, policy and typecheck read      | `project/changes.ts`               |

`node:fs`, `node:child_process` and `node:crypto` are imported only inside `kernel`. `JSON.parse` of
a file's content goes through `kernel/json.ts`.

### Files and functions

- A file is one cohesive unit and is as long as that unit needs. ESLint refuses past 1000 lines of
  code, which only catches a file that has stopped being one unit; the answer is a real seam, not a
  file of leftovers. A file is never split to satisfy a limit, and no comment mentions a line
  budget.
- A function over 120 lines or complexity 25 is refused. More than five parameters means an options
  object.
- A helper used by one caller lives in that caller's file.
- Comments state purpose, invariants and limits. They do not narrate history, incidents, versions
  or the code's earlier shape. Exported functions carry a short JSDoc.
- No project names in generic code. Anything specific to one fork is configuration.

### Commands

A command is declared once with `defineCommand` (`cli/command.ts`): its name, summary, arguments,
options and `run`. Option types are inferred from the declaration; there is no separate options
interface. `run` receives a `CommandContext` and returns nothing or throws.

- Command files are thin. They parse nothing by hand, hold no logic a test would want to reach
  without the CLI, and call one feature function.
- Output goes through `ctx.out`: results on stdout, progress and diagnostics on stderr. With
  `--json`, stdout carries exactly one JSON document with `schemaVersion`; a failure is
  `{schemaVersion, error, code, hint}`. Commands whose result is a pass/fail judgement (`test`, `check`,
  `gate`, `furnace validate`) end stdout with one `FIREFORGE-VERDICT:` line written by `ctx.out.verdict`.
- Failures are `FireForgeError`s with a stable string `code`, a message that says what to do next,
  and an exit code from `kernel/errors.ts`. The error boundary (`cli/program.ts`) prints every
  failure the same way on stderr: `error[<code>]: <message>`, then `hint: <hint>` when there is
  one. Only `bin/fireforge.ts` exits the process.
- A flag exists because a user needs to choose. Behaviour that is always right is not a flag, and a
  flag is not added to work around one incident.

### Configuration

`config/schema/` declares `fireforge.json` with the combinators in `kernel/schema.ts`, one file
per section (`firefox.ts`, `lint.ts` for `patchLint`, `gate.ts`, ...) composed in `index.ts`; the
feature a section configures owns its file. The TypeScript type is inferred from it, validation
errors name the key path, unknown keys are refused with the nearest known key, and
`config get|set` reads its key list from it.

### State

- Project state lives under `.fireforge/` in the project and is never committed: the state
  document `state.json`, the engine lock, and, for a patch-mode project, what is recorded about
  its `engine/`.
- Host state lives under `~/.fireforge/` (`FIREFORGE_HOME` moves it): `pristine/` (pristine
  repositories per pin), `workspaces/` (the pool), `locks/` (display, build, the pool and one
  lease per workspace), `cache/` (downloaded archives).
- What is recorded about an engine's content lives beside that engine, in the workspace's state
  directory (`workspaces/<name>/` for a pool workspace, `.fireforge/` for a patch-mode project):
  one file per record (`source-ledger.json`, `furnace-deployment.json`, their journals, test
  runs).
- Every state document has a schema and is read through it. A state file that fails its schema is
  reported with the command that repairs it, never silently reset.
- Anything that mutates more than one file (the patch queue, component deployment, materialization,
  registration edits) runs inside a `kernel/journal.ts` transaction, so an error, a signal or a
  crash leaves either the old state or the new one.

### The previous format

What the previous release wrote is read in one clearly bounded file per owning module, named
`previous.ts` (`config/previous.ts`, `source/previous.ts`), and nowhere else. Each is a pure
conversion to the current format that reports what it rewrote or dropped and refuses what it cannot
convert without a decision. `mode/upgrade.ts` runs them as one journaled change (`fireforge
migrate`). No other code branches on a format.

### Tests

- A test exercises behaviour through a module's `index.ts` API or through the CLI, against real
  files and real git repositories from `src/testing/`. Pure functions (parsers, classifiers, rule
  logic) are tested as input/output tables.
- A test does not mock another FireForge module. The only doubles are for the outside world that a
  unit test cannot have: `mach`, a real Firefox build, the network, the clock.
- Tests live beside the code as `<file>.test.ts`; slower multi-module scenarios are
  `<name>.integration.test.ts` in the module's directory.
- Coverage is judged by one global threshold. There are no per-file pins.

## Workspaces in detail

A workspace directory holds `engine/` (a git checkout of the pristine commit plus applied owned
changes, with its object directory inside), `workspace.json` (the workspace's identity: its pin,
pristine commit and last lessee; and the build baseline), and one file per record of what the engine
holds: `source-ledger.json` (the ledger of materialized paths), `furnace-deployment.json`, their
journals, and test runs. Everything in the directory describes its engine, so a clone copies all of
it but the builds and their baseline, and `workspace repair` puts the engine back to pristine and
clears every record of its content through one function (`resetWorkspaceState` in
`engine/pool.ts`), keeping only the engine, the release build, and the identity and build sections
of `workspace.json`.

Acquiring one (`mode.withWorkspace`, over `engine/workspace.ts`):

1. Patch mode: the project's `engine/`, under the engine lock.
2. Source mode: from the pool, a free workspace on the project's pin, preferring the one this
   checkout used last (its object directory is warm for this source), then the least recently used.
   If all are leased the command waits, naming the holders each minute, up to `--wait-lock`
   (two hours by default; `0` does not wait). `--workspace <name>` selects one.
3. Materialize: bring `engine/` to the checkout's owned files, writing only changed paths under a
   journal and restoring upstream bytes for paths no longer owned. Then deploy the checkout's
   components, so the engine holds what this checkout builds whichever checkout leased it last.
4. Run the command; record the build baseline after a successful build.
5. Release.

Before a command builds, runs or tests in its workspace it brings the deployed components in line
with the project (`mode.deployComponents`, which also records the deployment in a source-mode
workspace's ledger). `run`, `package` and `test` refuse a build that is older than the engine with
the build that catches up, or run that build first under `--build` (`engine.ensureBuilt`).

A lease lasts for one command. Commands that only read owned changes (`lint`, `status`, `verify`,
`export`) take no workspace: they read `src/` and the pristine repository directly.

Two host locks apply in both modes: `display` (one headed browser at a time) and `build` (a counting
lock, default one concurrent compile).

`workspace add <name>` creates a workspace from the pristine repository; `--from <name>` clones
another workspace's engine copy-on-write with what is recorded about its content. A build is never
copied or moved: an object directory belongs to the path it was configured at (`engine/objdir.ts`
says why), so a new workspace starts unbuilt and a build that finds an object directory configured
elsewhere removes it and builds from nothing.
