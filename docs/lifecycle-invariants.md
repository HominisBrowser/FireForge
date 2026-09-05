<!-- SPDX-License-Identifier: EUPL-1.2 -->

# Mutation lifecycle invariants (internal)

Internal architecture notes for contributors. FireForge's safety behavior
around destructive operations is spread across small modules on purpose. This
document is the one place that states the invariants those modules uphold
together, and says which module owns which piece. If you add a new mutating
command, read the decision table at the bottom first.

## The invariants

1. **Only `bin/fireforge.ts` terminates the process.** Library code
   propagates `CommandError` and `FireForgeError`. It never calls
   `process.exit`. This is enforced at lint time by
   `no-restricted-properties` (`eslint.config.js`), which bans
   `process.exit` everywhere and grants a `bin/**` override.

2. **At most one real engine or patch mutation runs at a time** per
   resource. CLI build, test, export, re-export and furnace mutations first
   take the `.fireforge/engine-session.lock`, then subsystem locks such as
   build, furnace, or patch-directory locks. Furnace mutations serialize on a
   per-root lock, and patch directory mutations (filename allocation plus
   manifest writes) on a per-directory lock. Dry runs hold the engine-session
   lock too, because a `re-export --dry-run` over an untracked binary legally
   touches the git index, and holding the lock serializes even "read-only"
   previews against real writers.

3. **A furnace mutation that does not finish restores the engine or says
   so.** Both a signal (SIGINT or SIGTERM) and a thrown error trigger a
   journal-based rollback. If the rollback is incomplete or uncertain, a
   `pendingRepair` marker blocks all further furnace mutations until
   `fireforge doctor --repair-furnace` reconciles.

   The thrown-error half landed in 0.43.0. Before it, `runFurnaceMutation`'s
   `finally` only deregistered the operation, and because it also set
   `completed`, a body that threw removed itself from the signal handler's
   view as well. A throw outside a body's own catch therefore left the
   checkout torn with no marker. `applyAllComponents` was the live instance:
   it rolls back on collected `result.errors` and `stepErrors`, but a throw
   from its pre-loop or post-loop work escaped both. The wrapper now runs
   cleanups, restores the journal, and rethrows the original error. A
   rollback failure becomes a marker plus a warning, never a replacement
   error.

   Both paths race for the same journal, so each operation carries a
   `rollbackState` claimed synchronously before either path's first await.
   Whichever gets there first restores, and the other skips. Bodies that
   already restore on their own (the eight `furnace/*` command bodies,
   `furnace-apply`, `preview`) call `ctx.markRolledBack()` so the wrapper
   keeps its hands off. There is one deliberate asymmetry: on the throw path,
   a body that never registered a journal writes no marker, because a
   preflight refusal would otherwise block every later mutation behind a
   repair with nothing to reconcile. The signal path still writes one there,
   since an interrupt genuinely may have landed mid-write.

4. **A signal during a compound "apply plus persist" pair never tears the
   pair.** Rebase-style operations intentionally leave the engine mutated, so
   rollback is the wrong tool. Instead the exit is held, with a bound, until
   the bookkeeping write lands, so `--continue` never sees stale progress.

5. **No lock outlives the process it belongs to** (best effort, in two
   layers): the signal pipeline force-releases furnace locks before exiting,
   and stale-lock recovery (PID first, then age) unblocks the next command
   for anything that escaped.

6. **Destructive patch operations are gated and audited.** That means an
   explicit change summary, a confirmation (or `--yes`), `--dry-run`, a hard
   refusal on structural conflicts (`--force-unsafe` to override), and a
   JSONL history entry appended only after the mutation succeeded. This
   covers metadata mutations too: `patch tier` and `patch lint-ignore` route
   through `confirmDestructive`. They used to accept `--yes` without ever
   prompting, so the flag only showed up in the history record. Enforced by
   `patch-tier-and-lint-ignore.integration.test.ts`.

7. **A verification tree never mutates shared state.** Trees are full
   project-root CoW snapshots under `.fireforge/trees/<name>`, with no
   merge-back model.

   Enforcement is layered. The `.fireforge/tree.json` marker plus a
   default-deny command-verdict table (`src/core/tree-guard.ts`) refuse every
   mutating command through one commander `preAction` hook in `cli.ts`, so a
   newly added command is refused in trees until someone classifies it (there
   is a drift test for this). Because a tree is a full project root, its
   build and engine-session locks key on the tree root, so in-tree reads
   never contend with the primary.

   `tree create` snapshots under the primary engine-session lock, so it never
   captures a mid-mutation state. With `--with-objdir` it additionally holds
   the primary build lock, under which the objdir is resolved and its build
   artifacts validated immediately before cloning. Any probe before the lock
   is a fast-fail courtesy whose result is discarded, never the authoritative
   answer. A concurrent `fireforge build` can therefore neither tear the
   `obj-*` snapshot nor swap it between preflight and clone.

   A symlinked (or engine-escaping) primary `obj-*` is refused before any
   copying. Every `cp` mode the clone uses preserves symlinks, so the clone
   would carry a link back to the original build, and the mozinfo rewrite
   plus `_virtualenvs` removal would mutate that original through it.
   `assertCloneSafeObjdir` (`tree-store.ts`) checks lstat and realpath
   containment, which a lexical `resolve()` cannot see, on the primary objdir
   and again on the tree's copy before any write goes through it. This is
   pinned by `tree-store.integration.test.ts` and `tree.integration.test.ts`.
   Tree create and remove serialise on a primary-side `.fireforge/trees.lock`,
   and `tree remove` refuses while a live PID holds a tree lock and checks
   that its `rm -rf` target is contained in the tree path.

   In-tree `test` (0.41.0) is the one conditional carve-out, and it is
   marker-gated. mach objdirs embed absolute `topsrcdir` and `topobjdir`
   paths, so `tree create --with-objdir` rewrites the cloned objdir's
   `mozinfo.json` to the tree using the same safe-relocation rewriter that
   `build --rewrite-mozinfo` uses, scrubs the cloned `_virtualenvs` (they
   carry primary shebangs, and mach rebuilds them in-tree), and runs
   `mach configure` inside the tree so the configure-generated root files are
   regenerated against the tree's paths rather than keeping the primary's. It
   then verifies exactly that set afterwards (config.status, backend.mk,
   Makefile, config/autoconf.mk, via `findObjdirRelocationViolation`, pinned
   by `mach-objdir-relocation.test.ts`). Nested Makefiles are products of the
   verified config.status, and `.deps` build products are out of scope as
   read-only staleness that the first in-tree rebuild corrects. Finally it
   copies `last-build.json` so the in-tree stale-build gates anchor
   correctly.

   Both relocation steps fail closed: a rewrite refusal or a failed in-tree
   configure aborts the create and removes the partial tree. Only after both
   succeed is the marker's `clonedObjdir` field written, and that field is
   what the guard's `test` predicate consults. At run time, `test`
   additionally refuses when the objdir its preflight found is not the one
   the marker vouches for (`assertObjdirMatchesTreeMarker`), so an objdir
   that appeared through any path other than `tree create --with-objdir` is
   never run against. `test --build` stays refused, since a tree is a
   snapshot with no merge-back model, and a corrupt marker refuses `test`
   like every other conditional verdict.

   **Both halves of that enforcement fail closed on an unreadable state,
   because "we cannot tell" is not "there is nothing there."** A marker that
   exists but does not parse reports `corrupt`, not `absent`, and refuses the
   command. Reading it as absent granted a snapshot the full mutating command
   set on the strength of a file that failed to parse. A lock directory whose
   owner cannot be identified reports `unknown`, not free, and refuses
   removal. Since 0.45.1 `withFileLock` treats its owner-record write as
   fatal (`writeLockOwner` in `file-lock-owner.ts` removes the just-created
   directory and throws a `GeneralError` if the record cannot be written or
   does not read back as written), so an owner-less lock is only ever left by
   a pre-0.45.1 holder or by a crash inside that write. It is still refused,
   for the same reason. The one exception is a lock directory that vanished
   between the probe and the owner read: that is a clean release, and reads
   as free.

   Each case has one named escape (`--ignore-corrupt-tree-marker`,
   `tree remove --force`), and neither has a silent one. The corrupt-marker
   refusal spares the read-only commands that are unconditionally allowed
   (`status`, `lint`, `typecheck`, `verify`): their verdict never consults
   marker fields, so an unreadable marker cannot change their answer, and
   blocking them left the operator unable to diagnose the very tree that
   needs inspecting. `conditional` verdicts can write, and stay refused.
   Enforced by `tree-guard.test.ts` (verdict drift gate and corrupt-marker
   refusal), `tree-store.integration.test.ts` (marker tri-state,
   unknown-owner refusal, rewrite-then-reconfigure-then-marker ordering),
   `tree.test.ts` (under-lock objdir re-validation ordering) and
   `tree.integration.test.ts` (real-program refusal).

8. **A verdict is only reported when it was actually verified.**
   `fireforge test` brackets the harness run with `snapshotEngineGeneration`
   and fails the run if `engine/` changed underneath it. The probe can
   legitimately fail, since `engine/` need not be a git checkout, so a probe
   that fails on both sides warns and proceeds. A one-sided transition
   throws, because either the second probe measured nothing about a checkout
   that had something to measure, or there was no baseline to compare
   against. Enforced by `engine-session-lock.test.ts`.

   A probe that fails on a transient `.git/index.lock`, meaning another
   writer held the index for the instant we looked, is retried on a bounded
   budget rather than latched as unmeasurable. A durable failure (a non-git
   `engine/`, an unreadable `.git`) still reports immediately. Enforced by
   `engine-generation-probe-retry.test.ts`.

   The same invariant reaches across the `tree exec` boundary. `tree exec`
   hands stdout to the child (`stdio: 'inherit'`), so the child's
   `FIREFORGE-VERDICT:` line reaches the caller byte for byte. The parent
   therefore seals stdout the moment the spawn settles, so its own "exited
   with code N" refusal cannot print after the verdict and displace it. A
   refusal raised before the child spawns emits no verdict at all, so
   consumers have to read a missing verdict as a failed step, never a pass.

9. **FireForge's own read-only commands are not writers of the primary
   engine checkout.** `verify`, `lint --per-patch` and `typecheck` are
   read-only to the operator but not to git: `git status` and `git diff HEAD`
   refresh and rewrite `.git/index`, and the untracked-binary diff path
   stages and unstages for real. Each of those commands therefore runs its
   whole body inside `withPrivateGitIndex`, which seeds a temp
   `GIT_INDEX_FILE` from the repository's own index so that every refresh
   lands there and is discarded. `typecheck` additionally forces
   `incremental: false` and drops `tsBuildInfoFile`, so no sidecar is written
   under `engine/`. The scope fails open, meaning an unresolvable git dir
   simply does not install it, and it is not reentrant. This exists so that
   invariant 8 stays evidential: a concurrent `fireforge test` must not be
   invalidated by FireForge's own read-only lane. Enforced by
   `git-readonly-index.test.ts`, against a real repository and a real index
   mtime.

10. **Lock queues are observable, and leaving one is as reliable as joining
    it.** A waiter that contends registers a file in `<lock>.waiters/` named
    `<startedAtMs>-<pid>-<uuid>` and deregisters in a `finally` that covers
    both outcomes: acquired the lock, or timed out. Depth counts only entries
    whose PID is still alive, so a killed waiter cannot inflate it forever,
    and the registry is advisory: failures to register are logged verbosely
    and never fail an acquisition. `fireforge status --lock` and the
    `--wait-lock` progress line read it. Enforced by `lock-visibility.test.ts`
    (a real concurrent waiter) and `engine-session-lock.test.ts` (queue
    position in the wait line).

11. **A manifest repair preserves what it cannot recompute, or refuses.**
    `doctor --repair-patches-manifest` is a merge: only `filesAffected` and
    `order` are derived from the patch files, and every other field on an
    existing entry is carried forward by spreading it. A field a `.patch`
    body cannot express (`stagedDependencies`, `lintIgnore`, `tier`, and
    whatever is added to `PatchMetadata` next) therefore survives without
    having to be listed. The one case where nothing can be carried forward is
    a `patches.json` that exists but does not parse. The rebuild refuses it,
    naming what would be reinvented, unless `--allow-metadata-loss` is
    passed. `doctor --repair-files-affected` is the narrow repair for drift
    that is only in the derived list: it goes through
    `mutatePatchRowsInManifest`, so untouched rows keep their exact JSON.
    Both repairs take the patch-directory lock (invariant 2), both support
    `--dry-run`, and a repair that wrote is reported before the doctor
    summary in every branch. The run can still exit non-zero on an unrelated
    check, and a non-zero exit otherwise reads as "nothing happened".
    Enforced by `patch-manifest-repair.test.ts` (real temp queues) and the
    repair cases in `doctor.test.ts`.

## Lock release (0.44.0)

`releaseLockIfOwned(lockPath)` in `src/core/file-lock.ts` is the
ownership-checked removal for callers that hold no acquisition token.
Currently that is the signal-time furnace sweeper
(`forceReleaseFurnaceLocksForActiveOperations`). It verifies the PID before
removing, which is the half of `releaseLock`'s guard a sweeper can still
perform: the sweeper knows which lock paths its own operations opened, but
not the per-acquisition UUID they minted. The bare `rm` it replaced could
delete a lock that a different process had acquired in the window between our
operation dying and the sweep running.

`completeJournalRollback` in `src/core/furnace-operation.ts` owns the
mutation-body rollback sequence that eight furnace commands previously
duplicated verbatim. The ordering is the invariant: `markRolledBack()` runs
before the restore, so a restore that itself fails does not leave the
lifecycle wrapper replaying the same journal on the way out, and the original
error is rethrown unless the rollback is what failed.

## Who owns what

### `bin/fireforge.ts`

The only `process.exit` call sites, the SIGINT/SIGTERM pipeline, the
re-entrancy guard (a second Ctrl+C exits immediately), and exit codes 130 and 143.

### `src/core/file-lock.ts`

The generic directory-as-lock, using `mkdir` for atomicity. The owner file
carries the PID, a per-acquisition token, the acquisition time and the start
tick. Stale recovery works by renaming the lock aside and reaping it: a dead
PID unblocks immediately, with an age-based fallback after 5 minutes for
records with no usable liveness answer. The probe re-runs about every 5
seconds while waiting, so a holder dying mid-wait cannot strand waiters until
`timeoutMs`. Acquisition then polls until the timeout.

The owner-record write is fatal. A failed or unverifiable write releases the
just-created lock and throws a `GeneralError` instead of running the
operation. Without that, a lock with no readable owner is reaped by the age
heuristic after 5 minutes, which for a multi-hour build meant a second holder
inside the critical section. Covered by `file-lock.test.ts`, "owner record
write at acquisition": write failure, corrupt read-back, recorded acquisition
time.

Release verifies that the lock still carries this acquisition's token before
removing, so a lock that a reaper has replaced is never deleted by its
previous owner. Enforced by `file-lock.test.ts` (two-waiter reap race,
mid-wait holder death, foreign-owner release). Releases happen in a `finally`,
which never runs across `process.exit`, and that is why invariant 5 needs its
other layer.

Wait ergonomics are opt-in: `pollMaxMs` (the poll interval doubles from
`pollMs` up to the cap) and `waitProgressMs` with `onWaitProgress` (a periodic
progress callback carrying the holder's PID, liveness, and owner-metadata
lines from the pid file). All three are inert when unset, so existing callers
keep byte-identical behavior.

### `src/core/file-lock-owner.ts`

The owner record (the `pid` file) itself: its format (PID, token,
`acquired-at-ms=` and `start-tick=` lines, plus free-form metadata, and older
records without the mechanical lines still parse), the write-and-verify
contract described above (a read-back that errors is retried before it counts
as a failed write, while a missing or mismatching record fails immediately),
and PID-reuse liveness.

`isLockOwnerAlive` is the liveness check that every stale probe, reap
re-verification, status snapshot and timeout message uses. Beyond
`isProcessAlive`, on Linux the record carries the writer's boot-relative start
tick (`/proc/self/stat` field 22), and the probe reads the candidate's tick
from `/proc/<pid>/stat`. A different tick means a different process, so the
lock is stale. A crashed build's PID handed to a long-lived daemon therefore
no longer keeps the dead lock honoured until the waiter's timeout. It uses
ticks rather than wall-clock times because `btime` moves with clock steps, and
a wall-clock comparison would reap a live holder after NTP steps the clock
forward. macOS and Windows have no cheap start-time source (a `ps` spawn per
poll is not worth it) and keep the PID-only answer, and so do records without
a start tick. Enforced by `file-lock-owner.test.ts`: backward-compatible
parsing, forged mechanical lines dropped, transient read-back error retried
versus persistent error versus mismatch, fake-procfs tick parsing, reused-PID
versus genuine-holder verdicts, stepped-clock immunity, and on Linux a
real-procfs `withFileLock` reap of a live-PID stale record.

### `src/core/engine-session-lock.ts`

The project-wide engine-session lock under `.fireforge/`, stamped with PID,
command, and start time metadata. CLI `build`, `test`, `export`, `re-export`,
`furnace apply`, `furnace deploy` and `furnace sync` take it before subsystem
locks, unconditionally, including dry runs: a `re-export --dry-run` over an
untracked binary legally touches the git index (temporary `--intent-to-add`
staging), so holding the lock serializes even "read-only" previews against
real writers. Dry-run purity is separately enforced at runtime by
`withDryRunPurityGuard` (`re-export-bulk-scan.ts`), which fingerprints the
engine tree and every patch artifact around the dry run and fails hard on
divergence.

Contention fails fast after about a second by default, with the fixed message
"Another FireForge engine-mutating command is already running. Wait for it to
finish, then retry `<command>`." That message contract is unchanged, and it
also closes the bounded wait. Each of those commands accepts
`--wait-lock [seconds]` (bare flag means 60, valid 1 to 3600) for a bounded
operator wait instead: polling backs off exponentially from 100 ms to 2 s, and
roughly every 5 s a progress line identifies the holder from the lock's
owner-metadata lines, in the form `Waiting for the FireForge engine lock held
by PID 12345 (command=build, started=…)` followed by how long the wait has
run and how large the budget is.

The budget is not the engine lock's alone. It covers every lock the command
takes, which for the three furnace commands means the per-root furnace lock as
well (see the `furnace-operation.ts` section). `FIREFORGE_WAIT_LOCK=<seconds>`
sets the same budget for a whole session, parsed with the same bounds as the
flag so the two cannot drift, and an explicit budget at a call site always
wins. Commands that take no lock accept `--wait-lock` and ignore it, so a
scripted sequence can append the flag everywhere without a usage error killing
the run. `fireforge test` also snapshots the engine git generation before and
after the harness run, and fails the verdict as invalid if the tree changes
mid-run.

### `src/core/furnace-operation.ts`

The `runFurnaceMutation` lifecycle wrapper: the per-root furnace lock, the
`pendingRepair` preflight refusal, the in-flight operation registry (journal,
cleanups and a `completed` flag), signal rollback with bounded timeouts,
`pendingRepair` persistence, and the furnace-lock force-release sweep.

The lock's wait budget is `options.lockTimeoutMs`, threaded from `--wait-lock`
by `waitLockMutationOptions`, which does the seconds-to-milliseconds
conversion once. It falls back to `sessionWaitLockMs()`
(`FIREFORGE_WAIT_LOCK`) and then to `DEFAULT_LOCK_TIMEOUT_MS`. That fallback
is what covers the twelve furnace mutators that declare no flag (`create`,
`remove`, `rename`, `refresh`, `scan`, `override`, `chrome-doc`, and the
rest). A contended refusal here names the furnace lock, says it is the second
of two, and points at `--wait-lock` and `FIREFORGE_WAIT_LOCK`. A budget that
is paid in full and then refuses anyway is the worst shape a budget can have,
so the refusal must not read as the engine lock's.

### `src/core/furnace-rollback.ts`

The rollback journal itself: file snapshots and their restoration.

### `src/utils/assert.ts`

The runtime-assertion primitive (`assert`, `expectDefined`) and, through
`InternalInvariantError`, exit code 11. It checks state FireForge itself
established (journal before mutation, lock held before write, manifest order
well-formedness) and is deliberately not input validation: anything derived
from user input, the filesystem, or a subprocess stays a typed error from
`src/errors/`. Every check routes through the helper rather than an inline
`if (!c) throw`, so the failure branch is covered once here instead of being
uncovered at every call site.

### `src/core/signal-critical.ts`

The registry of signal-deferred critical sections
(`runInSignalCriticalSection`). It is a pure registry and installs no
handlers. The bin pipeline drains it with a bounded wait.

### `src/core/patch-lock.ts`

`withPatchDirectoryLock`, which serializes patch filename allocation and
manifest read-modify-writes. It is not reentrant: callers must not already
hold it.

### `src/core/destructive.ts`

The destructive-operation contract: `confirmDestructive` (summary, prompt,
`--yes`, `--dry-run`, conflict refusal, `--force-unsafe`) and the
`.fireforge-history.jsonl` audit log.

### `src/core/tree-store.ts`

Verification-tree lifecycle: CoW snapshot contents and exclusions, the objdir
clone relocation (mozinfo rewrite plus a caller-supplied in-tree
`mach configure`, both before the marker records `clonedObjdir`, with
`assertObjdirMatchesTreeMarker` re-checking at `test` time), the
`.fireforge/tree.json` marker and its absent/valid/corrupt tri-state,
staleness fingerprints, the primary-side `trees.lock`, and removal that
refuses both a live holder and a lock of unknown ownership, with containment
checks on the removal target.

### `src/core/tree-guard.ts`

Read-only enforcement inside trees: the default-deny per-command verdict table
and the `preAction` hook body `runTreeGuardHook` that `createProgram()`
installs (invariant 7).

## The signal pipeline, end to end

On SIGINT or SIGTERM, `bin/fireforge.ts`:

1. Exits immediately if a rollback is already in flight (a second Ctrl+C).
2. Otherwise runs both of these in parallel and waits for both:
   - `rollbackActiveOperationsForSignal(signal)`, which for each active
     furnace operation runs the cleanup callbacks (15 s bound each), restores
     the journal (15 s bound), and writes a `pendingRepair` marker if anything
     failed or no journal was registered yet. Operations whose body already
     completed are skipped, so a signal in the finally-window cannot roll back
     a committed mutation.
   - `waitForActiveCriticalSections(5 s)`, which holds the exit for in-flight
     "apply plus persist" pairs (invariant 4). It is bounded so that a stuck
     write cannot postpone the exit the user asked for.
3. Force-releases the furnace lock directories of active operations, since
   `withFileLock`'s `finally` will never run past `process.exit`.
4. Calls `process.exit(130 | 143)`.

## Choosing a primitive for a new mutation

| Your operation                                                                                                       | Use                                                                                            |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Mutates the engine and should be undone on Ctrl+C (apply, deploy, preview, remove)                                   | `runFurnaceMutation` plus `ctx.registerJournal` (and `ctx.registerCleanup` for extra teardown) |
| Intentionally leaves the engine mutated but must finish a paired bookkeeping write (rebase-style `--continue` state) | `runInSignalCriticalSection` around the apply plus persist pair, keeping the body short        |
| Touches the patch directory or manifest                                                                              | `withPatchDirectoryLock` (never nested)                                                        |
| Deletes or rewrites user-owned patch state                                                                           | The `confirmDestructive` contract, with history appended only on success                       |
| Only reads                                                                                                           | Nothing. Dry runs must not block or be blocked                                                 |
| Runs read verification concurrently beside a busy primary                                                            | A `fireforge tree` (a CoW snapshot, with mutation refused inside, invariant 7)                 |

## Where this is tested

- `src/core/__tests__/file-lock.test.ts`: lock acquisition, staleness, PID
  recovery, fatal owner-record write.
- `src/core/__tests__/file-lock-owner.test.ts`: owner-record format
  compatibility and PID-reuse liveness.
- `src/core/__tests__/furnace-operation.test.ts`: wrapper lifecycle, signal
  rollback outcomes, `pendingRepair` semantics, lock force-release.
- `src/core/__tests__/signal-critical.test.ts`: the critical-section registry
  contract in isolation.
- `src/core/__tests__/signal-compound-mutation-scenario.test.ts`: the composed
  bin-handler pipeline, covering exit held for a compound mutation, the
  bounded hold for a stuck section, and rollback plus drain plus lock release
  together.
- `src/core/__tests__/destructive.test.ts`: the destructive-operation
  contract.
- `src/core/__tests__/tree-guard.test.ts`: invariant 7's verdict table
  (default-deny drift gate, conditional predicates, corrupt-marker refusal).
- `src/core/__tests__/tree-store.integration.test.ts`: clone contents, objdir
  rewrite/reconfigure/marker ordering, marker tri-state, unknown-owner removal
  refusal.
- `src/commands/__tests__/tree.test.ts`: create and remove command flow,
  including objdir re-validation under the primary build lock, and the
  `tree exec` stdout seal (invariant 8).
- `src/__tests__/tree-exec-verdict.test.ts`: invariant 8 across a real process
  boundary, with exactly one verdict line, last on stdout, and the refusal on
  stderr.
- `src/commands/__tests__/tree.integration.test.ts`: real-program in-tree
  refusals and `--with-objdir` end to end against a synthetic objdir.
