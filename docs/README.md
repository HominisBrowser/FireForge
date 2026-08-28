<!-- SPDX-License-Identifier: EUPL-1.2 -->

# FireForge documentation

[`../README.md`](../README.md) is the getting-started page. These files are
the reference material behind it. `fireforge --help` (and
`fireforge <command> --help`) stays the authority on flags; the docs cover
what a flag list cannot state.

## Using FireForge

| File                                           | Covers                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| [patch-workflow.md](patch-workflow.md)         | Export, re-export, deletions, queue maintenance, per-patch lint, CI gating, rebasing |
| [testing.md](testing.md)                       | `fireforge test`: scope, modes, build freshness, the verdict line, verbosity         |
| [furnace.md](furnace.md)                       | Components: overrides, shared CSS fragments, typed cross-module imports              |
| [verification-trees.md](verification-trees.md) | CoW snapshots for concurrent read-mostly verification                                |
| [configuration.md](configuration.md)           | `fireforge.json` settings, design tokens, lock waits, environment variables          |

## Contracts for scripts and CI

| File                                   | Covers                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------- |
| [exit-codes.md](exit-codes.md)         | Every exit code, which error class produces it, and how CI should branch    |
| [machine-output.md](machine-output.md) | The `--json` / `--raw` / verdict-line output contract and its versioning    |
| [run-logs.md](run-logs.md)             | `.fireforge/logs/`: what `test` and `build` write, and what survives a pipe |

## Internals

| File                                               | Covers                                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| [lifecycle-invariants.md](lifecycle-invariants.md) | Locking, rollback, signal handling, and the decision table for new mutations |

Release history and the reasoning behind individual changes live in
[`../CHANGELOG.md`](../CHANGELOG.md).
