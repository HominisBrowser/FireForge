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
   `process.exit`. Enforced at lint time by `no-restricted-properties`
   (`eslint.config.js`), which bans `process.exit` everywhere and grants a
   `bin/**` override.
2. **At most one real engine/patch mutation runs at a time** per resource:
   CLI build/test/export/re-export/furnace mutations first take the
   `.fireforge/engine-session.lock`, then subsystem locks such as build,
   furnace, or patch-directory locks. Furnace mutations serialize on a
   per-root lock, patch directory mutations (filename allocation + manifest
   writes) on a per-directory lock. Dry-runs hold the engine-session lock
   too — a `re-export --dry-run` over an untracked binary legally touches
   the git index, and holding the lock serializes even "read-only"
   previews against real writers.
3. **A furnace mutation that does not finish restores the engine or says so.**
   Both a signal (SIGINT/SIGTERM) and a thrown error trigger a journal-based
   rollback; if rollback is incomplete or uncertain, a `pendingRepair` marker
   blocks all further furnace mutations until
   `fireforge doctor --repair-furnace` reconciles.

   The thrown-error half landed in 0.43.0. Before it, `runFurnaceMutation`'s
   `finally` only deregistered the operation — and because it also set
   `completed`, a body that threw removed itself from the signal handler's
   view as well, so a throw outside a body's own catch left the checkout
   torn with no marker. `applyAllComponents` was the live instance: it rolls
   back on collected `result.errors`/`stepErrors`, but a throw from its
   pre/post-loop work escaped both. The wrapper now runs cleanups, restores
   the journal, and rethrows the **original** error (a rollback failure
   becomes a marker plus a warning, never a replacement error).

   Both paths race for the same journal, so each operation carries a
   `rollbackState` claimed synchronously before either path's first await;
   whichever gets there first restores and the other skips. Bodies that
   already restore on their own — the eight `furnace/*` command bodies,
   `furnace-apply`, `preview` — call `ctx.markRolledBack()` so the wrapper
   keeps its hands off. One deliberate asymmetry: on the throw path a body
   that never registered a journal writes **no** marker, because a
   pre-flight refusal would otherwise block every later mutation behind a
   repair with nothing to reconcile; the signal path still writes one there,
   since an interrupt genuinely may have landed mid-write.

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
   entry appended only after the mutation succeeded. This covers metadata
   mutations too: `patch tier` and `patch lint-ignore` route through
   `confirmDestructive` (they used to accept `--yes` without ever
   prompting, so the flag only appeared in the history record). Enforced
   by `patch-tier-and-lint-ignore.integration.test.ts`.
7. **A verification tree never mutates shared state**. Trees
   are full project-root CoW snapshots under `.fireforge/trees/<name>`
   with NO merge-back model. Enforcement is layered: the `.fireforge/
tree.json` marker plus a default-deny command-verdict table
   (`src/core/tree-guard.ts`) refuse every mutating command through one
   commander `preAction` hook in `cli.ts` — a newly added command is
   refused in trees until classified (drift test). Because a tree is a
   full project root, its build and engine-session locks key on the TREE
   root, so in-tree reads never contend with the primary. `tree create`
   snapshots under the PRIMARY engine-session lock (never captures a
   mid-mutation state) — and with `--with-objdir` additionally under the
   primary BUILD lock, under which the objdir is resolved and its build
   artifacts validated immediately before cloning (any pre-lock probe is
   a fast-fail courtesy whose result is discarded, never the
   authoritative answer), so a concurrent `fireforge build` can neither
   tear the obj-\* snapshot nor swap it between preflight and clone.
   A symlinked (or engine-escaping) primary obj-\* is refused BEFORE any
   copying: every `cp` mode the clone uses preserves symlinks, so the
   clone would carry a link back to the original build and the mozinfo
   rewrite plus `_virtualenvs` removal would mutate that original
   through it — `assertCloneSafeObjdir` (tree-store.ts) checks lstat and
   realpath containment (lexical `resolve()` cannot see either) on the
   primary objdir and again on the tree's copy before any write goes
   through it, pinned by `tree-store.integration.test.ts` and
   `tree.integration.test.ts`;
   tree create/remove serialise on a primary-side
   `.fireforge/trees.lock`; `tree remove` refuses while a live PID holds
   a tree lock and path-contains its `rm -rf` target.

   In-tree `test` (0.41.0) is the one conditional carve-out, and it is
   marker-gated: mach objdirs embed absolute `topsrcdir`/`topobjdir`
   paths, so `tree create --with-objdir` rewrites the cloned objdir's
   `mozinfo.json` to the tree via the same safe-relocation rewriter
   `build --rewrite-mozinfo` uses, scrubs the cloned `_virtualenvs`
   (primary shebangs; mach rebuilds them in-tree), runs `mach configure`
   inside the tree so the configure-generated root files are regenerated
   against the tree's paths rather than retaining the primary's — and
   verifies exactly that set afterwards (config.status, backend.mk,
   Makefile, config/autoconf.mk, via `findObjdirRelocationViolation`,
   pinned by `mach-objdir-relocation.test.ts`; nested Makefiles are
   products of the verified config.status, and `.deps` build products
   are out of scope as read-only staleness corrected by the first
   in-tree rebuild) — and copies
   `last-build.json` so the in-tree stale-build gates anchor correctly.
   Both relocation steps are fail-closed — a rewrite refusal or a failed
   in-tree configure aborts the create and removes the partial tree —
   and only after both succeed is the marker's `clonedObjdir` field
   written, which is what the guard's `test` predicate consults. At run
   time, `test` additionally refuses when the objdir its preflight found
   is not the one the marker vouches for
   (`assertObjdirMatchesTreeMarker`), so an objdir that appeared through
   any path other than `tree create --with-objdir` is never run against.
   `test --build` stays refused (a tree is a snapshot with no merge-back
   model), and a corrupt marker refuses `test` like every conditional
   verdict.

   **Both halves of that enforcement fail CLOSED on an unreadable state,
   because "we cannot tell" is not "there is nothing there."** A marker
   that exists but does not parse reports `corrupt`, not `absent`, and
   refuses the command — reading it as absent granted a snapshot the
   full mutating command set on the strength of a file that failed to
   parse. A lock directory whose owner cannot be identified reports
   `unknown`, not free, and refuses removal. Since 0.45.1 `withFileLock`
   treats its owner-record write as FATAL (`writeLockOwner` in
   `file-lock-owner.ts` removes the just-created directory and throws a
   `GeneralError` if the record cannot be written or does not read back
   as written), so an owner-less lock is only ever left by a pre-0.45.1
   holder or by a crash inside that write — it is still refused, because
   "cannot tell" is not "nothing there" (a lock directory that vanished
   between the probe and the owner read is the one exception: that is a
   clean release, and reads as free). Each has one named escape (`--ignore-corrupt-tree-marker`,
   `tree remove --force`); neither has a silent one. The corrupt-marker
   refusal spares the unconditionally-**allowed** read-only commands
   (`status`, `lint`, `typecheck`, `verify`): their verdict never consults
   marker fields, so an unreadable marker cannot change their answer, and
   blocking them left the operator unable to diagnose the very tree that
   needs inspecting. `conditional` verdicts can write and stay refused.
   Enforced by
   `tree-guard.test.ts` (verdict drift gate + corrupt-marker refusal),
   `tree-store.integration.test.ts` (marker tri-state, unknown-owner
   refusal, rewrite-then-reconfigure-then-marker ordering),
   `tree.test.ts` (under-lock objdir re-validation ordering) and
   `tree.integration.test.ts` (real-program refusal).

8. **A verdict is only reported when it was actually verified.** `fireforge
test` brackets the harness run with `snapshotEngineGeneration` and
   fails the run if `engine/` changed underneath it. The probe can
   legitimately fail — `engine/` need not be a git checkout — so a probe
   that fails on **both** sides warns and proceeds; a one-sided
   transition throws, because either the second probe measured nothing
   about a checkout that had something to measure, or there was no
   baseline to compare against. Enforced by
   `engine-session-lock.test.ts`.

   A probe that fails on a **transient** `.git/index.lock` — another
   writer held the index for the instant we looked — is retried on a
   bounded budget rather than latched as "unmeasurable";
   a durable failure (a non-git `engine/`, an unreadable `.git`) still
   reports immediately. Enforced by
   `engine-generation-probe-retry.test.ts`.

   The same invariant reaches across the `tree exec` boundary.
   `tree exec` hands stdout to the child (`stdio: 'inherit'`), so the
   child's `FIREFORGE-VERDICT:` line reaches the caller byte-for-byte; the
   parent therefore seals stdout the moment the spawn settles, so its own
   "exited with code N" refusal cannot print after the verdict and displace
   it. A refusal raised BEFORE the child spawns emits no verdict at all —
   consumers must read a missing verdict as a failed step, never a pass.

9. **FireForge's own read-only commands are not writers of the primary
   engine checkout**. `verify`, `lint --per-patch`, and
   `typecheck` are read-only to the operator but not to git: `git status`
   and `git diff HEAD` refresh and rewrite `.git/index`, and the
   untracked-binary diff path stages and unstages for real. Each of those
   commands therefore runs its whole body inside `withPrivateGitIndex`,
   which seeds a temp `GIT_INDEX_FILE` from the repository's own index so
   every refresh lands there and is discarded; `typecheck` additionally
   forces `incremental: false` and drops `tsBuildInfoFile`, so no sidecar
   is written under `engine/`. The scope is fail-open — an unresolvable
   git dir simply does not install it — and non-reentrant. This exists so
   invariant 8 stays evidential: a concurrent `fireforge test` must not be
   invalidated by FireForge's own read-only lane. Enforced by
   `git-readonly-index.test.ts` (real repository, real index mtime).

10. **Lock queues are observable, and leaving one is as reliable as
    joining it**. A waiter that contends registers a file in
    `<lock>.waiters/` named `<startedAtMs>-<pid>-<uuid>` and deregisters
    in a `finally` that covers both outcomes — acquired the lock, or timed
    out. Depth counts only entries whose PID is still alive, so a killed
    waiter cannot inflate it forever, and the registry is advisory:
    failures to register are logged verbosely and never fail an
    acquisition. `fireforge status --lock` and the `--wait-lock` progress
    line read it. Enforced by `lock-visibility.test.ts` (real concurrent
    waiter) and `engine-session-lock.test.ts` (queue position in the wait
    line).

11. **A manifest repair preserves what it cannot recompute, or refuses.**
    `doctor --repair-patches-manifest` is a MERGE: only `filesAffected` and
    `order` are derived from the patch files, and every other field on an
    existing entry is carried forward by spreading it, so a field a `.patch`
    body cannot express — `stagedDependencies`, `lintIgnore`, `tier`, and
    whatever is added to `PatchMetadata` next — survives by construction
    rather than by being listed. The one case where nothing can be carried
    forward is a `patches.json` that exists but does not parse; the rebuild
    refuses it, naming what would be reinvented, unless
    `--allow-metadata-loss` is passed. `doctor --repair-files-affected` is
    the narrow repair for drift that is only in the derived list: it goes
    through `mutatePatchRowsInManifest`, so untouched rows keep their exact
    JSON. Both repairs take the patch-directory lock (invariant 2), both
    support `--dry-run`, and a repair that wrote is reported before the
    doctor summary in every branch — the run can still exit non-zero on an
    unrelated check, and a non-zero exit otherwise reads as "nothing
    happened". Enforced by `patch-manifest-repair.test.ts` (real temp
    queues) and the repair cases in `doctor.test.ts`.

## Lock release (0.44.0)

`releaseLockIfOwned(lockPath)` in `src/core/file-lock.ts` is the ownership-
checked removal for callers that hold no acquisition token — currently the
signal-time furnace sweeper (`forceReleaseFurnaceLocksForActiveOperations`).
It verifies the PID before removing, which is the half of `releaseLock`'s
guard a sweeper can still perform: the sweeper knows which lock paths its own
operations opened but not the per-acquisition UUID they minted. The bare `rm`
it replaced could delete a lock a DIFFERENT process had acquired in the window
between our operation dying and the sweep running.

`completeJournalRollback` in `src/core/furnace-operation.ts` owns the
mutation-body rollback sequence that eight furnace commands previously
duplicated verbatim. The ordering is the invariant: `markRolledBack()` runs
BEFORE the restore, so a restore that itself fails does not leave the
lifecycle wrapper replaying the same journal on the way out; and the ORIGINAL
error is rethrown unless the rollback is what failed.

## Who owns what

| Module                            | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/fireforge.ts`                | The only `process.exit` call sites; SIGINT/SIGTERM pipeline; re-entrancy guard (a second Ctrl+C exits immediately); exit codes 130/143.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `src/core/file-lock.ts`           | Generic directory-as-lock (`mkdir` atomicity), owner PID **+ per-acquisition token + acquisition time + start tick** file, stale recovery via **rename-aside reaping** (dead PID unblocks immediately; ageless fallback after 5 min; the probe re-runs every ~5 s while waiting, so a holder dying mid-wait cannot strand waiters until `timeoutMs`), poll + timeout. **The owner-record write is fatal**: a failed or unverifiable write releases the just-created lock and throws a `GeneralError` instead of running the operation — a lock with no readable owner is reaped by the age heuristic after 5 min, which for a multi-hour build meant a second holder inside the critical section (`file-lock.test.ts` "owner record write at acquisition": write failure, corrupt read-back, recorded acquisition time). Release verifies the lock still carries this acquisition's token before removing — a reaper-replaced lock is never deleted by its previous owner. Enforced by `file-lock.test.ts` (two-waiter reap race, mid-wait holder death, foreign-owner release). Releases in `finally` — which never runs across `process.exit`, hence invariant 5's other layer. Opt-in wait ergonomics: `pollMaxMs` (poll interval doubles from `pollMs` up to the cap) and `waitProgressMs`/`onWaitProgress` (periodic progress callback carrying the holder's PID, liveness, and owner-metadata lines from the pid file). All three are inert when unset — existing callers keep byte-identical behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/core/file-lock-owner.ts`     | The owner record (`pid` file) itself: format (PID, token, `acquired-at-ms=` and `start-tick=` lines, free-form metadata — older records without the mechanical lines still parse), the write-and-verify contract above (a read-back that ERRORS is retried before it counts as a failed write; a missing or mismatching record fails immediately), and **PID-reuse liveness**: `isLockOwnerAlive` is the liveness check every stale probe, reap re-verification, status snapshot and timeout message use. Beyond `isProcessAlive`, on Linux the record carries the writer's boot-relative start tick (`/proc/self/stat` field 22) and the probe reads the candidate's tick from `/proc/<pid>/stat`; a different tick is a different process, so the lock is stale — a crashed build's PID handed to a long-lived daemon no longer keeps the dead lock honoured until the waiter's timeout. Ticks, not wall-clock times: `btime` moves with clock steps, and a wall-clock comparison would reap a LIVE holder after NTP steps the clock forward. macOS and Windows have no cheap start-time source (a `ps` spawn per poll is not worth it) and keep the PID-only answer; so do records without a start tick. Enforced by `file-lock-owner.test.ts` (backward-compatible parsing, forged mechanical lines dropped, transient read-back error retried vs persistent error vs mismatch, fake-procfs tick parsing, reused-PID vs genuine-holder verdicts, stepped-clock immunity, and on Linux a real-procfs `withFileLock` reap of a live-PID stale record).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/core/engine-session-lock.ts` | Project-wide engine-session lock under `.fireforge/`, stamped with PID, command, and start time metadata. CLI `build`, `test`, `export`, `re-export`, `furnace apply`, `furnace deploy`, and `furnace sync` take it before subsystem locks — unconditionally, dry-runs included: a `re-export --dry-run` over an untracked binary legally touches the git index (temporary `--intent-to-add` staging), so holding the lock serializes even "read-only" previews against real writers. Dry-run purity is separately enforced at runtime by `withDryRunPurityGuard` (`re-export-bulk-scan.ts`), which fingerprints the engine tree and every patch artifact around the dry-run and fails hard on divergence. Contention fails fast after ~1 s by default with the fixed message "Another FireForge engine-mutating command is already running. Wait for it to finish, then retry `<command>`." — that message contract is unchanged and also closes the bounded wait. Each of those commands accepts `--wait-lock [seconds]` (bare flag = 60, valid 1..3600) for a bounded operator wait instead: polling backs off exponentially 100 ms → 2 s, and roughly every 5 s a progress line identifies the holder from the lock's owner-metadata lines (`Waiting for the FireForge engine lock held by PID 12345 (command=build, started=…) — 10s of up to 60s.`). The budget is not the engine lock's alone: it covers EVERY lock the command takes, which for the three furnace commands means the per-root furnace lock as well (see the `furnace-operation.ts` row). `FIREFORGE_WAIT_LOCK=<seconds>` sets the same budget for a whole session, parsed by the same bounds as the flag so the two cannot drift; an explicit budget at a call site always wins. Commands that take no lock accept `--wait-lock` and ignore it, so a scripted sequence can blanket-append the flag without a usage error killing the run. `fireforge test` also snapshots the engine git generation before and after the harness run and fails the verdict as invalid if the tree changes mid-run. |
| `src/core/furnace-operation.ts`   | `runFurnaceMutation` lifecycle wrapper: per-root furnace lock, `pendingRepair` pre-flight refusal, in-flight operation registry (journal + cleanups + `completed` flag), signal rollback with bounded timeouts, `pendingRepair` persistence, furnace-lock force-release sweep. The lock's wait budget is `options.lockTimeoutMs` (threaded from `--wait-lock` by `waitLockMutationOptions`, which does the seconds→ms conversion once) falling back to `sessionWaitLockMs()` (`FIREFORGE_WAIT_LOCK`) and then to `DEFAULT_LOCK_TIMEOUT_MS`. The fallback is what covers the twelve furnace mutators that declare no flag (`create`, `remove`, `rename`, `refresh`, `scan`, `override`, `chrome-doc`, …). A contended refusal here names the FURNACE lock, says it is the second of two, and points at `--wait-lock`/`FIREFORGE_WAIT_LOCK` — a budget that is paid in full and then refuses anyway is the worst shape a budget can have, so the refusal must not read as the engine lock's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/core/furnace-rollback.ts`    | The rollback journal itself: file snapshots and their restoration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/utils/assert.ts`             | The runtime-assertion primitive (`assert`, `expectDefined`) and, through `InternalInvariantError`, exit code 11. Checks state FireForge itself established — journal-before-mutation, lock-held-before-write, manifest order well-formedness — and is deliberately NOT input validation: anything derived from user input, the filesystem, or a subprocess stays a typed error from `src/errors/`. Every check routes through the helper rather than an inline `if (!c) throw` so the failure branch is covered once here instead of uncovered at every call site.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/core/signal-critical.ts`     | Registry of signal-deferred critical sections (`runInSignalCriticalSection`). Pure registry — installs no handlers; the bin pipeline drains it with a bounded wait.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/core/patch-lock.ts`          | `withPatchDirectoryLock` — serializes patch filename allocation and manifest read-modify-writes. **Not reentrant**: callers must not already hold it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/core/destructive.ts`         | The destructive-operation contract: `confirmDestructive` (summary, prompt, `--yes`, `--dry-run`, conflict refusal, `--force-unsafe`) and the `.fireforge-history.jsonl` audit log.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/core/tree-store.ts`          | Verification-tree lifecycle: CoW snapshot contents/exclusions, the objdir clone relocation (mozinfo rewrite + caller-supplied in-tree `mach configure`, both before the marker records `clonedObjdir`; `assertObjdirMatchesTreeMarker` re-checks at `test` time), the `.fireforge/tree.json` marker and its absent/valid/**corrupt** tri-state, staleness fingerprints, the primary-side `trees.lock`, and removal that refuses both a live holder and a lock of **unknown** ownership, with rm-target containment.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `src/core/tree-guard.ts`          | Read-only enforcement inside trees: the default-deny per-command verdict table and the `preAction` hook body `runTreeGuardHook` installed by `createProgram()` (invariant 7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

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
| Runs read verification concurrently beside a busy primary                                                            | A `fireforge tree` (CoW snapshot; mutation refused inside — invariant 7)                     |

## Where this is tested

- `src/core/__tests__/file-lock.test.ts` — lock acquisition, staleness, PID
  recovery, fatal owner-record write.
- `src/core/__tests__/file-lock-owner.test.ts` — owner-record format
  compatibility and PID-reuse liveness.
- `src/core/__tests__/furnace-operation.test.ts` — wrapper lifecycle, signal
  rollback outcomes, `pendingRepair` semantics, lock force-release.
- `src/core/__tests__/signal-critical.test.ts` — the critical-section
  registry contract in isolation.
- `src/core/__tests__/signal-compound-mutation-scenario.test.ts` — the
  composed bin-handler pipeline: exit held for a compound mutation, bounded
  hold for a stuck section, rollback + drain + lock release together.
- `src/core/__tests__/destructive.test.ts` — the destructive-op contract.
- `src/core/__tests__/tree-guard.test.ts` — invariant 7's verdict table
  (default-deny drift gate, conditional predicates, corrupt-marker refusal).
- `src/core/__tests__/tree-store.integration.test.ts` — clone contents,
  objdir rewrite/reconfigure/marker ordering, marker tri-state,
  unknown-owner removal refusal.
- `src/commands/__tests__/tree.test.ts` — create/remove command flow,
  including objdir re-validation under the primary build lock, and the
  `tree exec` stdout seal (invariant 8).
- `src/__tests__/tree-exec-verdict.test.ts` — invariant 8 across a real
  process boundary: exactly one verdict line, last on stdout, refusal on
  stderr.
- `src/commands/__tests__/tree.integration.test.ts` — real-program in-tree
  refusals and `--with-objdir` end-to-end against a synthetic objdir.
