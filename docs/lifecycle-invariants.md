<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Mutation lifecycle invariants (internal)

Internal architecture notes for contributors. FireForge's safety behavior
around destructive operations is deliberately spread across small modules;
this document is the one place that states the invariants those modules
uphold **together**, and which module owns which piece. If you add a new
mutating command, read the decision table at the bottom first.

## The invariants

1. **Only `bin/fireforge.ts` terminates the process.** Library code
   propagates `CommandError` / `FireForgeError`; it never calls
   `process.exit`. Enforced by the process-boundary test.
2. **At most one real engine/patch mutation runs at a time** per resource:
   furnace mutations serialize on a per-root lock, patch directory
   mutations (filename allocation + manifest writes) on a per-directory
   lock. Dry-runs skip locking entirely — they only read.
3. **A signal during a furnace mutation restores the engine or says so.**
   SIGINT/SIGTERM triggers a journal-based rollback; if rollback is
   incomplete or uncertain, a `pendingRepair` marker blocks all further
   furnace mutations until `fireforge doctor --repair-furnace` reconciles.
4. **A signal during a compound "apply + persist state" pair never tears the
   pair.** Rebase-style operations intentionally leave the engine mutated,
   so rollback is the wrong tool; instead the exit is _held_ (bounded) until
   the bookkeeping write lands, so `--continue` never sees stale progress.
5. **No lock outlives the process it belongs to** (best effort, two layers):
   the signal pipeline force-releases furnace locks before exiting, and
   stale-lock recovery (PID-first, then age) unblocks the next command for
   anything that escaped.
6. **Destructive patch operations are gated and audited**: explicit change
   summary, confirmation (or `--yes`), `--dry-run`, hard refusal on
   structural conflicts (`--force-unsafe` to override), and a JSONL history
   entry appended only after the mutation succeeded.

## Who owns what

| Module                          | Owns                                                                                                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bin/fireforge.ts`              | The only `process.exit` call sites; SIGINT/SIGTERM pipeline; re-entrancy guard (a second Ctrl+C exits immediately); exit codes 130/143.                                                                                                                                        |
| `src/core/file-lock.ts`         | Generic directory-as-lock (`mkdir` atomicity), owner PID file, stale recovery (dead PID unblocks immediately; ageless fallback after 5 min), poll + timeout. Releases in `finally` — which never runs across `process.exit`, hence invariant 5's other layer.                  |
| `src/core/furnace-operation.ts` | `runFurnaceMutation` lifecycle wrapper: per-root furnace lock, `pendingRepair` pre-flight refusal, in-flight operation registry (journal + cleanups + `completed` flag), signal rollback with bounded timeouts, `pendingRepair` persistence, furnace-lock force-release sweep. |
| `src/core/furnace-rollback.ts`  | The rollback journal itself: file snapshots and their restoration.                                                                                                                                                                                                             |
| `src/core/signal-critical.ts`   | Registry of signal-deferred critical sections (`runInSignalCriticalSection`). Pure registry — installs no handlers; the bin pipeline drains it with a bounded wait.                                                                                                            |
| `src/core/patch-lock.ts`        | `withPatchDirectoryLock` — serializes patch filename allocation and manifest read-modify-writes. **Not reentrant**: callers must not already hold it.                                                                                                                          |
| `src/core/destructive.ts`       | The destructive-operation contract: `confirmDestructive` (summary, prompt, `--yes`, `--dry-run`, conflict refusal, `--force-unsafe`) and the `.fireforge-history.jsonl` audit log.                                                                                             |

## The signal pipeline, end to end

On SIGINT/SIGTERM, `bin/fireforge.ts`:

1. If a rollback is already in flight (second Ctrl+C), exits immediately.
2. Otherwise runs **in parallel** and waits for both:
   - `rollbackActiveOperationsForSignal(signal)` — per active furnace
     operation: cleanup callbacks (15 s bound each), journal restore (15 s
     bound), `pendingRepair` marker if anything failed or no journal was
     registered yet. Operations whose body already completed are skipped, so
     a signal in the finally-window can't roll back a committed mutation.
   - `waitForActiveCriticalSections(5 s)` — holds exit for in-flight
     "apply + persist" pairs (invariant 4), bounded so a stuck write cannot
     postpone the exit the user asked for.
3. Force-releases the furnace lock directories of active operations
   (`withFileLock`'s `finally` will never run past `process.exit`).
4. `process.exit(130 | 143)`.

## Choosing a primitive for a new mutation

| Your operation…                                                                                                      | Use                                                                                          |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Mutates the engine and should be _undone_ on Ctrl+C (apply, deploy, preview, remove)                                 | `runFurnaceMutation` + `ctx.registerJournal` (plus `ctx.registerCleanup` for extra teardown) |
| Intentionally leaves the engine mutated but must finish a paired bookkeeping write (rebase-style `--continue` state) | `runInSignalCriticalSection` around the apply + persist pair — keep the body short           |
| Touches the patch directory / manifest                                                                               | `withPatchDirectoryLock` (never nested)                                                      |
| Deletes or rewrites user-owned patch state                                                                           | The `confirmDestructive` contract, history appended only on success                          |
| Only reads                                                                                                           | Nothing — dry-runs must not block or be blocked                                              |

## Where this is tested

- `src/core/__tests__/file-lock.test.ts` — lock acquisition, staleness, PID
  recovery.
- `src/core/__tests__/furnace-operation.test.ts` — wrapper lifecycle, signal
  rollback outcomes, `pendingRepair` semantics, lock force-release.
- `src/core/__tests__/signal-critical.test.ts` — the critical-section
  registry contract in isolation.
- `src/core/__tests__/signal-compound-mutation-scenario.test.ts` — the
  composed bin-handler pipeline: exit held for a compound mutation, bounded
  hold for a stuck section, rollback + drain + lock release together.
- `src/core/__tests__/destructive.test.ts` — the destructive-op contract.
- `src/__tests__/process-boundary.test.ts` — invariant 1 (`process.exit`
  only in bin).
