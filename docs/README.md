<!-- SPDX-License-Identifier: EUPL-1.2 -->

# FireForge documentation

[`../README.md`](../README.md) is the getting-started page. These files are the reference behind it. `fireforge <command> --help` is the authority on flags; these docs cover what a flag list cannot say.

## Using FireForge

| File                                           | Covers                                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| [patch-workflow.md](patch-workflow.md)         | Export, re-export, deletions, queue maintenance, per-patch lint, CI gating, rebasing |
| [testing.md](testing.md)                       | `fireforge test`: scope, modes, build freshness, the verdict line, verbosity         |
| [furnace.md](furnace.md)                       | Components: overrides, shared CSS fragments, typed cross-module imports              |
| [verification-trees.md](verification-trees.md) | Copy-on-write snapshots for concurrent read-mostly verification                      |
| [configuration.md](configuration.md)           | `fireforge.json` settings, design tokens, lock waits, environment variables          |

## Source mode

| File                                       | Covers                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------- |
| [authored-sources.md](authored-sources.md) | Tracked source, overrides, capture, migration, refresh, which commands need a slot |
| [jobs-and-slots.md](jobs-and-slots.md)     | `host init`, `job run`, slots, capacity and recovery                               |
| [proof.md](proof.md)                       | `prove`: obligations, evidence, accept and waive, and the verified ref             |

## For scripts and CI

| File                                   | Covers                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------- |
| [exit-codes.md](exit-codes.md)         | Every exit code and how CI should branch                                    |
| [machine-output.md](machine-output.md) | The `--json` / `--raw` / verdict-line contract and its versioning           |
| [run-logs.md](run-logs.md)             | `.fireforge/logs/`: what `test` and `build` write, and what survives a pipe |

Release history lives in [`../CHANGELOG.md`](../CHANGELOG.md).
