<!-- SPDX-License-Identifier: EUPL-1.2 -->

# FireForge documentation

Start with [getting-started.md](getting-started.md). `fireforge <command> --help` lists every option; these pages cover what an option list cannot say.

## Using FireForge

| Page                                     | Covers                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- |
| [getting-started.md](getting-started.md) | From an empty directory to a running fork in either mode, and the daily loop                 |
| [patch-workflow.md](patch-workflow.md)   | Patch mode: the queue and manifest, import, export, re-export, queue operations, rebase      |
| [source-workflow.md](source-workflow.md) | Source mode: `src/`, overrides, materialization, exporting a queue, the merge driver, rebase |
| [workspaces.md](workspaces.md)           | Parallel sessions: git worktrees, the workspace pool, locks, host state and disk use         |
| [quality.md](quality.md)                 | Lint rules and waivers, policy, typecheck, and `check`                                       |
| [gate.md](gate.md)                       | `gate`: lanes, controls, smoke starts, acceptances, the verified ref and a pre-push hook     |
| [testing.md](testing.md)                 | `test`: what runs, dispatch, build freshness, the verdict, host hygiene, negative controls   |
| [furnace.md](furnace.md)                 | Components: create, override, deploy, validate, shared CSS fragments, typing files           |
| [authoring.md](authoring.md)             | Design tokens, build-manifest registration, chrome script wiring                             |
| [configuration.md](configuration.md)     | Every key of `fireforge.json`, `furnace.json` and `host.json`, and the environment variables |
| [migrating.md](migrating.md)             | Upgrading a project from 0.56: removed commands, flags and keys, step by step                |

## For scripts and CI

| Page                                   | Covers                                                   |
| -------------------------------------- | -------------------------------------------------------- |
| [exit-codes.md](exit-codes.md)         | Every exit code, and what the judging commands exit with |
| [machine-output.md](machine-output.md) | The `--json` document and the `FIREFORGE-VERDICT:` line  |

Release history is in [`../CHANGELOG.md`](../CHANGELOG.md). Contributors read [`../contributing/architecture.md`](../contributing/architecture.md).
