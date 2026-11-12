<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Process lifecycle

What happens between a FireForge process starting and ending: how it exits, what a signal does, and how locks and multi-file changes survive both. These are invariants; a change that breaks one changes this document in the same commit. [architecture.md](architecture.md) names the module that owns each mechanism.

## Exiting

- `bin/fireforge.ts` is the only caller of `process.exit`. Everything else returns an exit code or throws a `FireForgeError`, whose `exitCode` comes from `kernel/errors.ts`.
- `runProgram` (`cli/program.ts`) turns a thrown error into output and an exit code and returns the code. It never ends the process.
- Every exit but the forced one drains stdout and stderr first (`cli/stdio.ts`, bounded at 5 seconds), because `process.exit` discards what a pipe still has queued. A reader that closes the pipe early (`| head`) ends the process quietly.
- An unhandled rejection prints and exits 1. It is a bug: code awaits or handles every promise.
- When a command returns while an interrupt is being handled, the process entry does not exit; the interrupt pipeline makes the exit.

## Signals

`installSignalHandlers` (`kernel/signals.ts`) listens for SIGINT, SIGTERM and SIGHUP. The first one runs the interrupt pipeline and then exits with 130 (SIGINT) or 143 (SIGTERM, SIGHUP). A signal that arrives while the pipeline runs calls the force-exit handlers and exits at once with the same code, without rollback.

`finally` blocks do not run across `process.exit`. Anything that must happen on an interrupt registers with `onShutdown(phase, handler)`. The phases run in this order:

| Phase      | Runs                                                 | Registered by                                                                                              |
| ---------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `announce` | synchronously, in the signal's own tick              | `cli/output.ts`: `FIREFORGE-VERDICT: FAIL reason=killed signal=<signal>` for a command that owes a verdict |
| `stop`     | children get the signal and are waited for           | `kernel/process/spawn.ts`: SIGTERM, SIGKILL after the child's grace                                        |
| `rollback` | journaled changes are undone                         | `kernel/journal.ts`: every open transaction                                                                |
| `restore`  | temporary alterations are put back, locks still held | `engine/run.ts`: temporary browser profiles                                                                |
| `release`  | locks are released                                   | `kernel/lock.ts`: every lock this process holds                                                            |
| `finish`   | logs closed, scratch removed                         |                                                                                                            |

Rules:

- Each phase starts only once every handler of the phase before it has finished. `rollback` follows `stop`, so no child is still writing a file being restored; `release` follows `restore`, so the next lock holder never sees a temporary alteration.
- Every handler is bounded (15 seconds by default; `stop` and `rollback` 120 seconds) and its failure is logged, never thrown.
- When a handler overruns its bound, every phase after it up to `finish` is skipped: no undo starts and no lock is released, because a child may still be writing or an undo may still be restoring. The journal stays on disk for the next run, and the locks are taken over once this process is gone.
- `announce` handlers are synchronous and cannot stall.
- `onForceExit` handlers run on the second signal. They are synchronous and cannot wait: the last chance to SIGKILL a child.

Feature modules do not register shutdown handlers of their own for files, children or locks: they use `transaction`, `run` and `withLock`, which register. A feature module registers directly only for a temporary alteration no kernel mechanism covers (as `engine/run.ts` does for a profile directory), in the `restore` phase, and removes the registration when the alteration is undone.

## Children

- Every child process is started through `kernel/process` (`run`, `runBytes`), with an argument vector, never a shell string. That is how the interrupt pipeline knows it.
- A child that runs in its own process group (`mach`) gets the signal forwarded and is escalated to SIGKILL after its grace; the process does not exit while a child's teardown is still running.
- Process identity is the pid plus its start time from the kernel (`kernel/process/identity.ts`). A pid alone never grants authority to signal a process or to call a lock holder alive.
- A descendant that left the process group is signalled only when its command line names a directory this run owns (`kernel/process/tree.ts`). `mach` runs hold the workspace until every process of the run is gone, and `test` sweeps helpers by the run marker in their environment.

## Locks

All locks go through `kernel/lock.ts`: exclusive, shared, or shared with a holder limit.

- A lock is a directory. Taking it is one atomic hard link of the next generation's owner record; taking over from a dead holder is the same step, so two contenders race on one link and nothing ever deletes a live claim.
- A holder is identified by pid and start time. It stays a holder while any process group it started under the lock still runs, so a build that outlives a killed FireForge does not overlap the next one.
- Waiters queue and are served in arrival order. A waiter prints progress after 5 seconds and then every minute, and gives up after its wait (`--wait-lock`, `FIREFORGE_WAIT_LOCK`, default two hours) with `lock-timeout`, exit 15.
- Locks are not reentrant. Take each lock once, at the outermost point that needs it.
- The locks in use: the engine lock of a patch-mode project (`.fireforge/locks/engine`, exclusive for writers, shared for `check` and dry runs), one lease lock per pool workspace, the pool lock, the pristine import lock per pin, the host `display` lock, the host `build` lock (shared, limited by `buildSlots`), and the locks over the state document, the source tree, Furnace edits and `fireforge.json` edits.
- A command that can wait on a lock takes `--wait-lock`; one that cannot wait does not.

## Multi-file changes

Anything that changes more than one file (the patch queue, the engine during import or discard, materialization, component deployment, Furnace and tracked-file edits, override records, a source-mode rebase, a negative control's mutation) runs inside `transaction` (`kernel/journal.ts`). Then an error, a signal or a crash leaves either the old state or the new one.

- Before a path is touched, its before-image (a copy, or a copy-on-write clone) and a journal record reach stable storage.
- The body returning flushes every changed path, then deletes the journal. That deletion is the commit.
- The body throwing restores the before-images and rethrows. A signal rolls back the same way, after children have stopped.
- A crash leaves the journal. The next transaction on the same journal path undoes it first, and `fireforge doctor --recover` undoes every one it finds.
- One journal path serves one transaction at a time; the caller holds the lock that makes that true.
- Journals live where `doctor` looks for them: as `*.journal` files, or under `journals/`, in the project's `.fireforge/` or a pool workspace's directory.
- Paths are absolute.

A single-file write uses the atomic replace in `kernel/fs.ts` and needs no journal.

## State documents

- Every state document has a schema and is read through it (`kernel/schema.ts`). One that fails its schema is reported with the command that repairs it, never silently reset.
- `.fireforge/state.json` is one object of named sections (`project/state.ts`). A module declares its section with `defineStateSection`, reads and updates only that section, and carries the others through untouched. Updates are serialised by a lock and replace the file atomically.

## Where this is tested

- `src/kernel/signals.test.ts` and `signals.integration.test.ts`: phase order, bounds, the skip on overrun, the second signal.
- `src/kernel/journal.test.ts`: commit, rollback, crash recovery.
- `src/kernel/lock.test.ts` and `lock.integration.test.ts`: generations, take-over, shared limits, queues, process groups.
- `src/cli/stdio.test.ts`: draining and broken pipes.
