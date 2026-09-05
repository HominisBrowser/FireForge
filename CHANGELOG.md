# Changelog

## 0.46.0

### Packaging audit

- The post-build audit no longer warns about files it was never going to package. It now skips unselected branding trees, directories gated off-platform by an ancestor `moz.build`, Storybook `*.stories.mjs`/`*.stories.js` files, and paths declared in `buildAudit.unpackaged` in `fireforge.json`. The `Packaged:` line counts every skip reason so the numbers can be checked.
- A declared carve-out that does resolve to a packaged artifact is reported as stale rather than hidden. `**` in a carve-out path is refused.

### Patch queue and lint

- New `forward-registration` lint error: a test manifest that registers a file only a later patch creates. On a 338-patch queue this finds 48 real cases in three shared manifests. Each message prints the `patch staged-dependency --add --kind registration` command that fixes it.
- The command that rule prints now quotes the manifest line the way the patch actually writes it, including multi-line and multi-entry arrays. Before this it produced declarations that immediately warned as unused.
- The `staged-dependency-unused` warning prints the full removal command instead of one that refuses without its arguments.
- `lint --per-patch --patches 102` accepts a bare order number, padded or not.
- Staged-dependency registration checks now see binary files. A patch creating a binary through `GIT binary patch` used to be invisible to the resolver.
- `patch compact` refuses if the queue changed between the confirmation prompt and the lock, the same gate `patch reorder` already had.

### Patch bodies

- Fixed corruption of new non-UTF-8 text files on export. The body was built from a UTF-8 decode while the blob hash came from the real bytes, so the patch wrote different bytes than the tree held and drift detection flagged the file forever. Text vs binary is now decided by a NUL byte or invalid UTF-8, and the binary arm forces a byte-faithful `GIT binary patch`.
- Worktree-side renames no longer produce a phantom status entry. Git emits an unstaged rename as ` R new\0old\0`, and the old path was parsed as its own entry.

### Integrity

- Checksum verification fails closed. An unreachable `SHA256SUMS` used to accept the tarball on TLS alone. Ways out: fix connectivity, pin `firefox.sha256`, or set `firefox.allowUnverifiedDownload: true`. The checksum request now uses the same timeout and retry as the tarball fetch.
- Archive extraction rejects any member with a `.git` path segment. `.gitmodules` and `.gitignore` still pass.
- The mach `PYTHONPATH` shim directory is now per-user, created `0700`, and checked for ownership and mode before it joins `PYTHONPATH`. It used to be a fixed shared temp path any local account could pre-create.
- Run logs are redacted. `KEY=value` pairs matching `TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTH`, `--password=` style flags, and `Authorization:` headers are masked in the log file only. `docs/run-logs.md` states what is and is not masked.

### Locks

- A failed owner-record write no longer lets two builds into the critical section. The write is verified, and on failure the lock directory is removed and the run refuses.
- A recycled PID no longer keeps a dead lock honoured. On Linux the owner record carries the holder's start tick from `/proc`, so a different process with the same PID reads as stale. macOS and Windows keep PID-only liveness.

### Exit codes

- Commander usage errors exit 8 as documented, with a JSON envelope under `--json`. `--help`, `--version`, and a command group with no subcommand still exit 0.
- `GitNotFoundError` exits 7 like its siblings. A contract test now checks every error class against the table in `docs/exit-codes.md` in both directions.
- Manifest invariant failures raise `InternalInvariantError` and render as a bug report instead of a bare stack.

### Diagnostics

- A timed-out command keeps what it captured. `ExecTimeoutError` carries stdout, stderr, and a truncation flag, and shows the last 20 lines.
- `exec()` used to accept `processGroup` and `mirror` and ignore both. The options type is split so it cannot admit them.
- `test --help` lists all seven verdict reasons.

### Tooling

- `@types/node` moves to `^22` to match the supported Node floor, and a `node-floor` CI job runs the suite on Node 22, 24, and `.nvmrc`.
- Three copy-pasted mach test wrappers became one `runMachTestSuite(kind, options)`. Several other duplicated helpers collapsed the same way.
- `ReturnType<typeof X>` on local imports is now a lint error; every site uses the named exported type.
- Two new lint rules: `no-unnecessary-type-conversion` and `prefer-object-has-own`. Both were already satisfied when they landed.
- The spawned-CLI test helper settles on `'close'` and rejects on `'error'`.
- Wall-clock test budgets replaced with ratio checks and fake timers.

### Dead code

- Twenty-two exports that only tests referenced are gone, along with those tests and the barrel lines. `deadcode:check:production` resolves from the two real entry points and runs in `release:check`, so it cannot come back.
- Three impossible-state fallbacks removed rather than documented.
- `fireforge import --stop-at` is removed. It was an alias added in the same commit as `--until`.

### Duplication

- One `sleep(ms, { unref })` replaces nine copies that disagreed on whether the timer keeps the event loop alive.
- Eight `--order` parsers now share `parsePositiveIntegerFlag`, so `--order 12abc` is refused instead of becoming 12.
- `normalizePatchArtifact` was an identity function on every patch write path; it is gone and its warning moved to the export write site.
- `ensureGit()` is memoised and called inside `git()` instead of before 32 of the 38 call sites.
- Single helpers now cover repeated shapes: `sha256Hex`, `normalizePathSlashes`, `formatPatchOrder`, `appendHistoryBestEffort`, `proceedAfterDecision`, `deriveTestStem`, and others.
- `--dry-run`, `--yes`, and `--force-unsafe` are documented once each through five option mixins.

### Test suite

- Eleven test files and about 5,600 lines are gone with no assertion lost. They tested barrels, layers, and coverage thresholds rather than behaviour.
- Twenty-one full-text help snapshots became one inventory snapshot of commands and sorted flag names.
- `process-boundary.test.ts` is replaced by the lint rule that already enforced it.
- Four tests that asserted less than their titles claimed now assert what they say.

## 0.45.0

### Patch bodies

- A new binary file can be vendored into a patch. The export was always correct; the forward-import projection refused to decode the binary body. The five duplicated projection loops became one helper that skips binary sections.
- New-file conflict recovery handles binary targets by removing the blocking file and letting `git apply` recreate it. Saved originals are buffers now, which also fixes a latent corruption on the existing path.

### Refusals

- The `--expect` "showed no drift" warning now says what it compares and when, and names the two cases that legitimately produce no drift.
- The coverage refusal names the test manifests that changed since the recorded build.
- New `--expect-unmanaged <path>` records an approved exception to `--refuse-adjacent-unmanaged`. Approved paths are always listed, and one that is never met is reported.

### Diagnostics

- `run --smoke-exit` treats `Missing chrome or resource URL:` as a smoke error. It used to exit 0 on a build that hung every browser-chrome run.
- The no-output-stall triage records the real mechanism: the crash lands in a content process with no crash reporter, so the harness log carries only the timeout. The census names the `.ips` diagnostic report to look for.
- The green-suite teardown belt names the first condition that rejected a run.
- The undefined-identifier hint recognises an unmanaged companion file loaded by a managed head and points at `re-export --scan --scan-file` instead of the globals shim.
- A failing test now raises `TestFailureError` with test-shaped remedies. Exit code stays 5; the `--json` code moves to `test-failure`.
- The build path prints a recognised teardown traceback verbatim with one labelled line naming it, rather than filtering it like the test path does.
- `fireforge doctor` reports the configured source pin beside the engine's actual `version.txt` and warns when they disagree.

### Builds

- The jar-only full-build escalation is narrowed to a new `jar.mn` or a jar declaration with a bracketed base directory. Everything else stays incremental. Probe failures still escalate.
- Post-build packaging notices name the owning patch, or mark the file `unmanaged`.

### Test harness

- Every `fireforge test` runs a preflight census of leftover harness processes anchored to this objdir, naming each with its elapsed time and the kill command. `--reap-orphans` terminates them. It never refuses a run.

### Patch lint

- `patchLint.prettier` (off by default) runs Prettier over patch-owned `.sys.mjs` modules with `cwd` set to `engine/`, which is the only place the check is meaningful.
- `patchLint.fileSizeThresholds` makes the file-size bands configurable. The message drops the soft/hard wording and says a gate at `--max-warnings 0` treats a warning as a failure.

## 0.44.0

### Gates

- `release:check` runs once per release instead of twice. `prepublishOnly` is the single gate.
- Branch-protection contexts are stable, and `setup-rulesets.sh` reconciles instead of blindly POSTing.
- All workflows read the Node version from `.nvmrc`. The old pin was one patch below the floor `eslint-plugin-jsdoc` requires, and `npm ci` only warns about that.
- A test repo now sets `user.name` as well as `user.email`, so it stops failing only on CI runners. Its git calls reject on non-zero instead of continuing against an empty repo.

### Multi-session contention

- `--wait-lock` is a budget against a stalled queue. Each improvement in queue position grants a fresh budget, up to four times the request and one hour. The refusal names the position reached.
- `FIREFORGE_WAIT_LOCK=<seconds>` supplies the budget for any lock-taking command without an explicit `--wait-lock`.
- SIGTERM and SIGINT emit `FIREFORGE-VERDICT: FAIL reason=killed signal=…` before the shutdown drain, but only if a test run was in flight.
- The signal sweep releases every lock this process holds, not just furnace ones.
- Binary-patch staging writes to a private git index. It used to touch the shared index, which made a concurrent `fireforge test` see files flapping between `A` and `??` and fail as inconclusive.
- `--wait-lock` now reaches both locks a furnace mutation takes. The furnace file lock always used a fixed 30 s, so `deploy --wait-lock 1800` died at 30 s. The refusal names which lock it is and how to raise the budget.

### Exit codes

- `reason=inconclusive` exits 14 instead of sharing 1 with real failures. `LockContentionError` moves to 15, since the run never started.

### Diagnostics

- A stale mochitest httpd on port 8888 is detected at preflight and named. It used to stall runs into a 370 s timeout with nothing pointing at a port.
- The stale-browser refusal reports elapsed time and the full command line, and offers `--kill-stale-marionette` only for a marionette-driven browser. A bare launch may be someone else's live window.
- The `--wait-lock` progress line reports the budget currently in force and announces extensions.
- `status --lock` reports the holder's CPU time, so a wedged holder looks different from a healthy long build. It is an observation, never a verdict.
- The inconclusive refusal names what moved in `engine/`: the HEAD SHAs and up to five worktree entries.
- A `moz.build` sort violation is translated instead of arriving as a Python traceback. Mozbuild lowercases before comparing, which is the opposite of the intuitive rule.
- A run whose only unexpected results are the time-driven `lastColdStartupCheck`/`globalprivacycontrol` pair says so and suggests halving the chunk.
- The packaging-coverage refusal offers `--extend-coverage` and states when it applies.
- The no-output-stall census hoists the known-good control step above the list and gives cause 3 a probe that separates it from the others.
- `test` and `build` write their full output to `.fireforge/logs/<command>-<timestamp>.log` as they stream, 20 deep per command kind. The path rides the verdict line as `log=<path>`. Opened before any preflight, so refusals are logged too.
- Failure diagnosis no longer promotes recognised teardown noise over the real assertion. The selector runs a pass that excludes known noise first.
- `fireforge test --full-output` unsets `CLAUDECODE` for test dispatches only, so mozbuild's agent output limiter stops hiding the lines the classifier reads.

### Build output resolution

- A second `obj-*` directory no longer refuses every command when `engine/mozconfig` declares `MOZ_OBJDIR`. Genuinely ambiguous cases still refuse.

### Correctness

- The failure-line classifier no longer matches the English word "assertion" or `TEST-KNOWN-FAIL`. Both arms are harness-shaped and case-sensitive now. A green run could previously be turned red by its own diagnostic.
- `fireforge test --build` accepts `--refuse-unexported-drift` and forwards it to the pre-test build. It is refused without `--build`.
- A `--wait-lock` waiter no longer gets a free extension on its first probe, so a stalled queue starves on exactly the budget asked for.
- `re-export` no longer rewrites a tracked binary patch into an un-appliable stub. `--binary` now covers every diff path, a new `binary-body-not-reconstructable` lint fails closed on a payload-less binary section, and classification no longer trusts a stub's index hash.
- `re-export` reports `Unchanged` for a patch whose body did not move, and does not rewrite the file.
- `fireforge test --doctor` no longer orphans a browser tree on Ctrl+C.
- Failures during a patch-queue mutation keep their own class, stack, and exit code instead of all rendering as a patch-compatibility problem.
- Esc or Ctrl+C at a confirmation exits 130. Answering "no" exits 0.
- `furnace validate` checks that the engine exists.
- `furnace create` escapes quotes, newlines, and `*/` in generated modules.
- The signal-time furnace lock sweeper checks ownership before removing a lock.
- `killProcessTree` falls through to a direct kill when the group kill fails.
- A deletion of an upstream file can now be captured through `re-export`. All three paths filtered absent files out of the diff scope; a tracked absent path is kept and produces a real `deleted file mode` section. `--files` refuses against the full requested list, so a path that produces no hunk is reported.
- `token add --mode override` writes qualified blocks such as `:root[data-theme="light"]:not([data-private])`. It used to write dark and silently skip light. The selector is parsed structurally, and the qualifier is reported in a warning.
- `token add --variant` no longer requires `--category`, explains the create-then-variant order, and reports an already-present token with its location instead of a silent no-op.
- Mozilla's CC0 dedication is recognised as a license header in both the modified-file and vendored-file checks. Without it, `export -y` would have prepended the project header onto public-domain code.

### Security

- Six `tokens.css` scanners were super-linear in the length of a single line. One took 8.2 s on 4,000 repeated characters. Fixed by removing ambiguous adjacent quantifiers and anchoring unanchored prefixes; four became index arithmetic. Regression tests assert wall-clock, and the file now runs in about 26 ms.
- The prototype-chain guard on `config --force` moved to the point each segment is used as a property name.
- Two `replace` calls that read as incomplete escaping were rewritten as index arithmetic and the shared `escapeRegex`.

### Manifest repair

- `doctor --repair-patches-manifest` no longer drops `stagedDependencies`. The row is built by spreading the existing entry and overriding only `filesAffected` and `order`, so any future field survives too.
- An unparseable `patches.json` is no longer rebuilt into an invented one. Doctor refuses, names the parse error, and requires `--allow-metadata-loss`.
- Doctor prints what it wrote before the summary, including on a failing run.
- New narrow `doctor --repair-files-affected` recomputes only the drifted lists. Both repairs gained `--dry-run`.

### Performance

- `getAllDiff` batches its `git hash-object` calls instead of one spawn per untracked file. Output bytes are unchanged and now pinned by a test.
- `last-build.json` carries content hashes for dirty `jar.mn`, `moz.build`, `moz.configure`, `Makefile.in`, and `mozbuild.in`, so a permanently dirty worktree stops escalating every build to a full one and re-running configure. `build --ui` records which kind of build it was.

### Cleanup

- The engine-precondition refusal was written out 15 times across 13 files; it is now `assertEngineGitReady` or `assertEngineExists`.
- The furnace two-rung ladder, the 15-line rollback catch, the four manifest registrars, and five legacy scanners all collapsed to shared helpers.
- `bootstrap.ts` uses the canonical bootstrap-issue scanner instead of a second copy whose regexes had drifted.
- Content-equality now goes through one `normalizeForChecksum`, so `furnace status` and `furnace validate` cannot disagree with `apply` on a CRLF checkout.
- 18 open-coded TTY checks became `stdioIsInteractive()`.
- Modules renamed for clarity: four `manifest-*.ts` became `moz-manifest-*.ts`, the `Furnace manifest sync` check became `Furnace config sync`, and the lint modules joined the `patch-lint-*` family.
- `furnace-validate-helpers.ts` was a 572-line spill file; each block moved to the validator that uses it and 16 exports turned out to be module-private.
- Fifteen `await import()` calls became static imports.

### Types

- `DoctorCheck` encoded one ternary result in three fields. `severity` is now required and the only field.
- Three string unions are derived from their member lists through `makeEnumGuard`, so a stale allowlist is a compile error.
- `src/index.ts` no longer publishes 32 unreachable types, and gained `ApplyAllComponentsResult`.
- The per-component apply helpers take `Pick<ComponentApplyContext, …>` instead of four interchangeable strings in three different orders.
- `lintExportedPatch` takes its optional arguments in an options object.
- Twelve runtime flag checks raise `InvalidArgumentError` (exit 8) like the other 191.
- The CLI boundary walks the error `cause` chain under `--verbose`.

### CLI

- `patch tier`, `patch lint-ignore`, and `patch staged-dependency` honour `--wait-lock` instead of claiming they take no lock. All seven patch-directory commands honour it now.
- `import` and `setup` accept `-y, --yes`. On `import` it waives the prompt but keeps the integrity gate armed.
- `test --doctor` prints its preflight line once.
- `status --json` outside a project writes one JSON envelope to stdout and the guidance to stderr.
- `token add --variant` accepts every selector the matcher can find, using the matcher's own parse rather than a second grammar.
- `tree list --json` emits the same failure envelope as `status --json`.

### More correctness

- `furnace create`'s tag prompt shows the rule inline instead of dying on a typo. The message-returning validators are now named `describe*Problem`.
- `register --after` says so when a file type cannot honour it, instead of ignoring the flag.
- `RebasePatchEntry` is a discriminated union, so a status flip cannot strand the previous status's payload. Older session files still load.
- A `patches.json` from a newer FireForge is refused by name instead of being reported as malformed.
- `furnace create --test-dir` is honoured by the dry-run plan and the success note, not just the scaffolder.

### Windows

- `fireforge lint`'s checkJs pass reported zero findings, silently: the path maps were keyed with backslashes while TypeScript hands out forward slashes. `typecheck` had the same defect.
- `furnace diff` reported every overridden file as new, because `git show ref:path` only understands forward slashes.
- Engine-relative paths were recorded in two spellings at once; normalised at the five producing sites.
- `build-audit` collapsed to one path segment, `removeTree` refused every removal, and `initRepository` never pinned `core.autocrlf`, which shifted every blob hash.
- `furnace init` accepted `--ftl-base-path ../escape/path`, because the traversal guard normalised to backslashes before testing for `../`.
- `furnace` jsconfig sync did nothing and reported a clean summary while doing it.
- On the test side: path expectations go through `nativePath()` and `nativeAbsPath()`, fixture repos pin `core.autocrlf=false`, platform branches are forced rather than inherited, and POSIX-only suites are skipped explicitly with a paired win32 refusal test.

### Test infrastructure

- `createLoggerMock()` and `createFsMock()` replace hand-rolled `vi.mock` factories at 110 sites. Each old factory listed a subset of the real module, so adding an export broke a hundred suites at once. The new ones are typed, so `tsc` reports a missing export in one file.
- `test.test.ts` was 2,943 lines held together by a 190-line mock header. The header moved to `test-command-mocks.ts` and the file split into six. The split exposed a real isolation bug in a Marionette preflight test.
- Fourteen verdict assertions passed only because writing to a filesystem root fails on POSIX. They state the precondition now via `createRunLogMock()`.
- A lock-wait test decided its result on a `readdir`; its retirement and release are synchronous and its timing constants scaled.

### Documentation

- README's reference material moved to `docs/`, split by task: `patch-workflow.md`, `testing.md`, `furnace.md`, `verification-trees.md`, `configuration.md`, with `docs/README.md` as the index.
- New `docs/run-logs.md` states the `.fireforge/logs/` contract.
- `machine-output.md` and `lifecycle-invariants.md` were stale against the code and now match it.
- The published package ships `docs/`, so the README's relative links resolve after install. A smoke test asserts the tree is packed.
- The four environment variables FireForge reads are tabulated in `configuration.md`.

## 0.43.0

### Verdict correctness

- A suite that ends clean and then dies in the known mozsystemmonitor teardown traceback is a PASS with a note. Every hard-evidence veto still fails the run.
- `engine/mozconfig` is written only when its content changes, so mach stops re-running configure on every invocation. Consumers who raised hang-canary bounds for this can restore them.
- `verify`, `lint --per-patch`, and `typecheck` no longer write the primary engine checkout. They run git plumbing against a private `GIT_INDEX_FILE`, so they stop tripping a concurrent test run's inconclusive refusal.

### Diagnostics

- An xpcshell SIGSEGV with no test evidence names its known cause: an `.sys.mjs` imported from a packaged module with no `EXTRA_JS_MODULES` registration.
- `fireforge verify` resolves every `resource://` specifier the queue-owned modules import, including lazy `defineESModuleGetters` ones, and names unregistered targets.
- A headed stall probes the display power state on macOS and reports it, and lists the three recorded causes of that signature. The old `caffeinate` advice was wrong: it prevents sleep, it cannot wake a display.
- FireForge's own escalation notices carry a `[FireForge] NOTICE:` prefix at warning severity, so agent output filters keep them.

### Messages and refusals

- The stale-build refusal suggests `--build` first and says plainly what `--allow-stale-build` accepts.
- `--refuse-foreign-drift` stops calling the operator's own additions foreign, and tags each file by whether it changed since their last export.
- Unknown patch identifiers suggest the nearest matches instead of printing the whole manifest.
- `patch move-files` and `patch split` refuse a prompt-less non-TTY run up front, naming `--yes`.

### Features

- `--wait-lock` is accepted by every command. Lock-free commands accept and ignore it and say so.
- `status --lock` reports the engine session lock without acquiring it: holder, command, hold time, liveness, and queue depth. The wait progress line now states queue position.
- An export refused by projected cross-patch lint prints the working adopt-then-split sequence with real arguments.
- `fireforge typecheck` runs the per-patch checkJs pass, so a green typecheck means export-clean types.
- The per-patch lint cache records the waiver set that produced each entry and refuses a replay under a different one.
- Internal invariants are checked at runtime and exit 11 with a stack trace. Nothing an operator can misconfigure reaches this path.

### Hardening

- `build-prepare` warns before overwriting engine content matching neither a patch body nor the baseline, and `build --refuse-unexported-drift` makes it a hard stop.
- A furnace mutation that throws now rolls back the engine, not just one that is interrupted. A rollback that itself fails leaves a `pendingRepair` marker and keeps the original error.
- The unexported-drift guard expands collapsed untracked directories, so it stops false-positiving on any wholly-untracked directory. It and `status --unmanaged` now answer about the same tree.

### Release hygiene

- The composed macOS bundle identity is pinned end to end: `MOZ_MACBUNDLE_ID` plus `--with-distribution-id` must equal the configured `appId`.

## 0.42.0

- `MOZ_MACBUNDLE_ID` carries only the leaf segment of `appId`, and the mozconfig emits `--with-distribution-id=<prefix>`. Upstream composes the two, so writing the full reverse-domain name double-prefixed the shipped bundle id.

## 0.41.0

### Release and build integrity

- Release publishing commits version bumps before building and enforces a clean tree.
- Builds stamp `dist/build-info.json`; `--version` includes the commit and dirty-content hash.
- Build baselines keep deletion tombstones, so removed files cannot look fresh.
- `test --build` uses a full build for new `jar.mn` registrations.
- `--extend-coverage` unions scoped coverage only while HEAD, packageable inputs, and mozconfig are unchanged.
- Shared build and engine preflights reject incomplete builds and unborn engine repositories consistently.

### Tests and verification trees

- Tests emit exactly one final `FIREFORGE-VERDICT:` line with the right reason, including sharded, lock-timeout, crash, and inconclusive runs.
- `tree exec` preserves the child verdict as the last stdout line.
- Browser preflight detects stale apps from the same objdir even after they release Marionette.
- Mach commands use process groups and reap surviving descendants.
- `tree create --with-objdir` supports build-less tests, with relocation and reconfiguration checks.
- Tree creation refuses symlinked objdirs, cleans failed clones, and handles unreadable locks fail-closed.
- Verification trees permit `re-export --dry-run`; mutating operations stay blocked.

### Status and diagnostics

- Status classification reuses one patch context and runs through a bounded pool.
- `status --json --summary` returns counts and offenders without the file payload; `--include-ownership` adds ownership without a second scan.
- JSON output drains fully through slow pipes, and machine-mode refusals go to stderr.
- Multi-owner files stay conflicts even when Furnace-managed or branding-generated.

### Patch, export, and lint workflow

- `export-all --exclude-furnace` keeps its scope after license-header repair.
- `re-export --expect <path>` permits intended drift and reports paths skipped by earlier refusals.
- Missing drift baselines fail closed, binary patches compare by content, and partial re-exports exit non-zero.
- Re-export builds checkJs once per run and reuses the per-patch cache.
- Patch lint rejects new imported system modules with no projected `moz.build` registration.
- Export placement refusals print projected errors and name renumbering consequences.
- `patch rename` can recategorize and renumber atomically.
- `patch move-files` and `patch split` use whole-queue projection lint.
- Queue-mutating patch commands support `--wait-lock`.

### Furnace and validation

- Furnace computes checksums once per apply and warns before overwriting divergent patch-owned files.
- Manifest-sync failures are visible, and repairs run under the Furnace lock.
- `furnace validate --fix` changes only reported components and detects missing custom-element registrations.
- Localization validation recognizes non-Latin text while exempting emoji and punctuation.
- `furnace rename` uses single-pass, boundary-aware substitutions.
- Rollback failures leave repair breadcrumbs for `doctor --repair-furnace`.

### Safety, performance, and maintenance

- Nano ID 3.3.18 resolves a high-severity audit finding.
- Rebase loading distinguishes absent from corrupt sessions; `rebase --abort` can recover invalid state.
- PID liveness treats `EPERM` as alive.
- The moz.build parser handles comments, quoted brackets and apostrophes, and unterminated lists.
- Parser failures no longer silently certify validation success.
- Toolchain probes, baseline fingerprints, and manifest reads use bounded concurrency.
- Four local ESLint rules prevent unsafe error casts, duplicate regex escaping, and empty JSDoc.
- The release gate pins weak critical modules so aggregate coverage cannot hide local regressions.

## 0.40.0

- Adopted all five open dependabot PRs after a TypeScript 6 compatibility review. Production: `acorn` 8.18.0 and `magic-string` 1.1.0 (a major that only drops the CJS/UMD builds). Dev tooling and SHA-pinned actions bumped alongside. knip 6.29's stricter re-export tracking found seven dead type re-exports, now removed.
- New `fireforge tree`: copy-on-write verification clones for concurrent read-only work. `tree create <name>` snapshots the project into `.fireforge/trees/<name>` via APFS clonefile or btrfs/XFS reflink, taken under the engine session lock. Read-only commands run inside a tree unmodified; every mutating command is refused through a default-deny table. Filesystems without CoW refuse honestly, with `--force-copy` as the explicit opt-in. `tree list`, `tree remove`, and `tree exec` round it out. Windows is not supported.
- Concurrent xpcshell runs no longer collide on Firefox's fixed profile directory. Every dispatch that can run xpcshell exports a fresh `mkdtemp` profile dir and removes it afterwards. An operator-supplied `XPCSHELL_TEST_PROFILE_DIR` is respected and never deleted.
- Per-patch lint can typecheck patch-adopted test `.js` files through `patchLint.checkJsTestFiles` and `patchLint.checkJsTestShim`. Test files were never in the checkJs program at all before, so a harness global that does not exist could not fail at the patch boundary.
- Patch size metrics are on the public API (`countNonBinaryDiffLines`, `resolvePatchSizeTier`, `getPatchSizeThresholds`), and `lint --per-patch --report <path>` writes a machine-readable per-patch report.
- A size finding waived by `lintIgnore` still reports its measurement as a NOTICE, so a waived patch's current size can be read back from the tool that enforces it.
- Smoke-run summaries attribute allowlist hits per entry and flag zero-hit entries as removal candidates.
- `lint --per-patch <patch…>` accepts positional arguments through the same alias resolution as `--patches`.
- `patch staged-dependency --remove` accepts `--file` plus `--specifier` and infers `--creates` from a unique match. Error messages name the missing flag instead of restating the command.
- `token add` can no longer strand or skip a token when its category is wrong. Category banners match exactly, idempotency is checked per category, and `--variant` validates `--category` instead of discarding it.
- Patch-lint `raw-color-value` no longer fires on hex colors inside comments that open on a context line and close on an added one.
- `export --name ui-foo --category ui` lands manifest `name: "foo"` in one step, and a `.patch` suffix no longer trips the dot validator.
- New `status --check` and `--fail-on <class,…>` turn classification drift into a non-zero exit, so CI no longer has to parse `--json` and reimplement the rules.
- `status --json` file entries carry a `patch` field naming the owning patch.
- The scan-less `re-export` adjacency notice is classification-aware, and `--refuse-adjacent-unmanaged` upgrades it to a refusal that skips the write.
- `re-export` retries once after 300 ms on transient git `index.lock` contention.
- `export --before/--after` no longer refuses placements whose renumber never reaches a reserved range.

## 0.39.0

- `fireforge discard` restores patch-claimed paths to their patch-applied baseline and re-materializes patch-created files. It used to return upstream Firefox artwork and drop every fork line from `jar.mn`.
- New per-patch check `mozbuild-unsorted-list` catches unsorted `EXTRA_JS_MODULES` before any build is dispatched.
- Forward-import detection catches a bare getter line added to an existing `defineESModuleGetters` map, and every refusal names the `patch staged-dependency` command to paste.
- `patch move-files <from> <to>` into an existing patch is a real transaction rather than a printed preview with the two commands in the wrong order.
- `patch lint-ignore --add` warns that the waiver is subject to the project's patch-policy review.
- The mixed-harness refusal runs before the pre-test build instead of after it.
- `token add --mode override` also writes existing `:root[data-theme="dark"]` and `:root[data-theme="light"]` blocks.
- A `.patch` extension on a patch-name argument no longer double-suffixes, and `patch rename` explains its no-ops.
- xpcshell-only runs skip the Marionette port preflight and the mochitest client flags.
- New `fireforge status --test-coverage` reports the last build baseline's packaging coverage.
- `typecheck` and the checkJs pass no longer suppress undefined free identifiers (TS2304/TS2552).
- `reset` and `import` warn when `components.conf` diverged from the last full build.
- The forward-import "closest legal ordinal" hint is suppressed when no legal ordinal exists.
- `export` never offers to prepend the project license header onto a vendored third-party file.
- Signal-shaped configure and build exits are labeled as external interruptions.
- Headed macOS no-output timeouts hint at display sleep.

## 0.38.0

- `status --ownership` reports a furnace-deployed file whose owning patch body went stale as drift.
- Scoped `test --build` and build-less runs refuse a `components.conf` changed since the last full build, since those entries bake into the compiled static component table.
- Per-patch size lint agrees with `wc -l` and fires only above the soft limit.
- Patch lint accepts both established upstream MPL header wraps.
- The packaged-test coverage guard accepts same-manifest siblings instead of demanding the exact recorded path set.
- Positional inserts refuse with one actionable error when they would renumber a reserved range, `patch move-files --create --order <n>` bootstraps a split in one step, and `re-export --scan` refuses forward-import adoptions.
- Engine-mutating commands can wait for the engine lock instead of failing fast.
- `furnace validate` credits the implicit wrapping `<label>` association.
- `furnace create --shared-ftl <path>` validation is pinned by tests.
- `source set --candidate <buildN>` fetches release-candidate archives.

## 0.37.0

- `fireforge test --build` records the stale-build baseline, so a plain `test` right afterwards is not refused.
- Every non-`--build` test run tracks packaged-runtime coverage, not just tree state.
- `export` and `re-export` refuse to capture a stale furnace deploy, with `--allow-stale-furnace` to downgrade it to a warning.
- `stagedDependencies` gains a registration-kind entry shape for jar.mn lines, customElements registrations, and actor registrations.
- `furnace validate` accepts `kind: "library"` components.
- The failure summary echoes the first five `TEST-UNEXPECTED-*` lines with their assertion text.
- The known mozsystemmonitor teardown traceback is collapsed to one labeled line.
- Mach dispatches reap their whole process group, and `doctor` detects pre-existing orphaned harness workers.

## 0.36.0

- `fireforge test` with no path requires `--auto`, `--doctor`, or `--canary`, and stale packaged-engine drift fails fast unless `--build` or `--allow-stale-build` is given.
- A SIGSEGV-truncated run is no longer reported as PASSED.
- The build toolchain preflight probes the cbindgen mach actually resolves, which is the mozbuild state directory first.
- Exact-directory test selection was cosmetic on Firefox 153's mach and its exclusion echo was wrong; both fixed.
- Verbatim upstream MPL-2.0 block headers are accepted on non-JS files too.
- `rebase --max-fuzz` was dead code: `git apply` has no `--fuzz` flag, so every escalation failed with a swallowed usage error. Reimplemented, and the flag now rejects invalid numbers.
- A corrupt `patches.json` is no longer silently destroyed on the next export.
- `furnace apply <name>` no longer wipes every other component's checksum state.
- Ordinary `config <key> <value>` no longer deletes `--force`-written keys.
- Downloads verify against Mozilla's published SHA256SUMS by default, failing closed on mismatch.
- Archive-safety preflight streams tar listings instead of scanning a truncated capture, and `--dry-run` exports are genuinely read-only.
- `applyPatchIdempotent` checks git exit codes, chunks pathspecs against `E2BIG`, and threads a protected-files set through both apply loops.
- File locks are race-hardened: PID plus per-acquisition token, rename-aside stale reaping, and a stale probe that re-runs while waiting.
- The bin signal handler waits up to 12 s for spawned children, making the SIGTERM to SIGKILL escalation reachable. Windows smoke-run cleanup kills the whole tree.
- `writeFileAtomic` retries its final rename on transient Windows errors.
- `status --json` and `--raw` own stdout exclusively; every diagnostic goes to stderr as plain text.
- All captured child output decodes through `StringDecoder`, and patch parsing is CRLF-tolerant through one shared diff walker.
- `--version` works alongside other root flags, and option parse errors print one clean line.
- `furnace remove` deletes only the files the component deployed, and `furnace rename` journals the new-name side.
- `validatePatchIntegrity` batches HEAD-existence checks through one chunked `ls-tree`.
- `doctor --repair-patches-manifest` runs under the patch-directory lock.
- All GitHub Actions are SHA-pinned, and `coverage.include` closes the Vitest 4 hole where never-imported modules were invisible to thresholds.

## 0.35.0

- The patch symlink-escape guard was dead code: it normalized the path text but never followed the link. Target validation now resolves the link.
- `stampPatchVersions` runs under the shared patch-directory lock.
- Authoritative-state probes use `pathExistsStrict`, so an EACCES surfaces as an error instead of "missing".
- `extractTarXz` validates the archive listing before writing anything, rejecting absolute members, `..` segments, and escaping link targets.
- The CI matrix gained a cross-platform unit-test subset on macOS and Windows. The README's "never tested on Windows" claim was replaced with what CI actually covers.
- New `docs/lifecycle-invariants.md` records the six invariants the destructive-operation contract upholds.
- `discard <directory>/` no longer produces doubled slashes, which also broke the Furnace fallback.
- The installed-package smoke tests skip with a clear message when npm is unavailable.
- The release workflow installs the exact npm version pinned in `packageManager`.
- New toolchain preflight for Firefox source hops, after a build died 8 s into configure on an out-of-date cbindgen.
- The per-patch Firefox-globals shim is extensible: `ChromeUtils` and `Localization` are named interfaces a project can add to.
- `fireforge test <directory>` selects exactly that directory. Mach matches test paths by string prefix, so a bare directory used to sweep in prefix-named siblings.
- Per-file test sharding announces itself, and `--no-shard` runs a single combined instance.
- A headed smoke run on a non-CI host warns that input during the window contaminates the console capture. New `fireforge run --headless`.
- The verbatim upstream MPL-2.0 header is accepted on new JS files regardless of the project license.

## 0.34.0

- The macOS resource-monitor crash mitigation is now an in-process guard installed into every discovered mach virtualenv before each dispatch.
- Every mach build dispatch goes through one protected path with a uniform recognized-crash retry budget.
- Fixed the degraded-psutil fallback crashing mozsystemmonitor on itself, and taught the crash classifier its two signatures.
- A fully green run is no longer marked `CRASH (N attempts)`: a completed green summary vetoes signature-based classification.
- `fireforge test <directory>` dispatches xpcshell-only directories to `mach xpcshell-test`.
- New `fireforge register --create-manifest` scaffolds a directory `moz.build` and wires the parent `DIRS` chain.
- `re-export <patch> --files` accepts the space-separated path shape, with clearer dry-run previews.
- `furnace deploy` no longer leaves a stale toolkit `jar.mn` line after a helper file rename.
- New `furnace scan --track` persists discovered untracked components non-interactively.
- New `furnace chrome-doc create --browser-window` scaffolds a browser.xhtml-like main window document.
- New `furnace create --test-dir <dir>` redirects the test scaffold, and all test scaffolds are collision-safe.
- Fixed the degraded-psutil guard wedging `mach build` at exit and failing a build after a fully successful compile.

## 0.33.0

- `furnace deploy` and `apply` prune a dangling per-widget locale `jar.mn` entry for a `sharedFtl` widget, which used to fail the build outright.
- New `fireforge token add --variant '[data-skin=precision]'` authors a declaration inside an attribute-keyed `:root` block, creating it if absent.
- `fireforge register` sorts `EXTRA_JS_MODULES` case-insensitively, matching mozbuild's rule.
- `fireforge typecheck` regenerates the Furnace-managed jsconfig before running, so a stale shim stops reporting phantom errors.
- `patch split --dry-run` models the forward edge the split introduces, so the preview matches the real gate.
- `fireforge test <one xpcshell .js>` recognizes the xpcshell result-summary block as an execution signal.
- `fireforge build` injects a resource-monitor degrade shim so a host `psutil` failure warns instead of aborting the build.
- New per-project `typecheck.projectOverrides` to override or opt out of the shared shim.

## 0.32.0

- `fireforge lint <files>` evaluates `large-patch-files` against each file's owning patch instead of the file-list size.
- The ad-hoc `lint <files>` path honours each file's owning-patch `lintIgnore`, so all three lint modes agree.
- New `lint --per-patch --patches <name…>` lints a named subset of the queue.
- The per-patch checkJs pass builds the queue-wide program once per run instead of once per patch.
- Cross-patch `resource:///` and `chrome://` imports resolve during export and re-export lint.
- `furnace sync` emits `./`-prefixed relative `compilerOptions.paths` values.
- `fireforge test` auto-dispatches a single-suite run to the suite-specific mach command.
- The crash classifier and `--harness-retries` budget cover the pre-test `--build` step.

## 0.31.0

- `patch compact` is range-aware: each configured category range compacts independently.
- Staged-dependency `owner` references are rewritten during every renumber instead of dangling.
- New `fireforge patch split <source> --files <paths…> --name <name>` moves files into a new patch as one transaction.
- Plain `re-export --scan` is scoped to the patch's exact directory footprint. Git pathspecs recurse, so a shallow claimed file used to sweep the whole subtree.
- The per-patch checkJs pass resolves imports of patch-owned modules to their real sources, so JSDoc type guards and generics survive module boundaries.
- Added `ChromeUtils.getClassName`, `ChromeUtils.defineLazyGetter`, and the `Localization` constructor to the shipped shim.
- The JSDoc `@param` extractor scans balanced braces, so nested generics parse.
- `observer-topic-naming` parses balanced multi-line call sites and inspects the actual topic argument, with a known-Firefox-topics allowlist.
- `fireforge test` classifies harness runs from their output rather than trusting exit codes.
- Multi-path test runs are sharded into sequential single-file runs with per-shard retries. `--no-shard` restores the combined invocation.
- New `fireforge test --perf-samples <path>` publishes the artifact path to the harness.
- Named `furnace deploy <component>` runs the same pipeline as deploy-all, so renames and deletions prune their engine copies.
- Shared CSS fragments for Furnace widgets through a `/* @fireforge-include <fragment>.css */` directive.
- Automatic jsconfig `paths` maintenance for multi-file components.
- `token add` no longer double-prefixes a name that already starts with the configured prefix.
- New `token add --create-category` declares the banner and inserts the token in one write.
- Two new release gates: `deadcode:check` (knip) and `cycles:check` (dpdm).
- Internalized 45 exports with no outside consumers and untangled seven type-only import cycles.
- Refactored the twelve functions above cyclomatic complexity 30 and now enforce the limit.
- `process.exit()` is restricted to `bin/fireforge.ts` by lint.
- TypeScript `target`/`lib` moved from ES2022 to ES2023.

## 0.30.0

- Added repo-local per-patch lint result caching, with `--no-cache` and `lint cache clear`. Warm hits skip diff generation as well as rule execution.

## 0.29.0

- `test --build` failure reporting names the rebuild command, requested paths, and first failure line separately from stale-artifact advice.

## 0.28.0

- Restored mach lint compatibility by materializing a `.hgignore` copy of `.gitignore` when Firefox's ignorefile linter config is present.
- `source set` prints the resolved archive URL so a pinned checksum can be verified before download.
- `re-export --dry-run` takes a lock so parallel previews serialize instead of racing on `.git/index.lock`.
- New `re-export --scan --scan-files <manifest>` for bulk generated-file assignment.
- Better `fireforge test` diagnostics for harness startup failures and zero-tests-run.
- Build failure summaries put real make and mach failures above trailing warnings.
- Blank context lines keep their unified-diff marker, so generated patches stop producing false drift warnings.
- Partial `re-export` writes preserve legacy source metadata on unselected rows.

## 0.27.3

- `firefox-devedition` downloads resolve against `/pub/devedition/releases`.
- `download --force` keeps the existing `engine/` tree until the replacement extracts successfully.
- Checksum mismatch diagnostics include the resolved URL and product.

## 0.27.0

- First-class `firefox-devedition` support and atomic `fireforge source set`.
- `source set --version` accepts both space and equals forms without colliding with the root version flag.
- New `sourceProduct` and `sourceVersion` patch metadata; `sourceEsrVersion` stays as a deprecated alias.
- Unified status, ownership, doctor, and verify worktree classification, including an explained patch-owned drift state.
- Build diagnostics carry exit codes, tails, log hints, and verbose rerun suggestions.
- Progress output for git indexing, archive validation, extraction, and rebase refreshes.
- New `re-export --files --allow-shrink`, so ownership shrinkage must be acknowledged.
- Preserved patch-owned branding `configure.sh` settings during build preflight.
- Custom element registration support for Furnace validate and apply.
- Improved rebase conflict summaries and new `doctor --post-rebase-audit`.

## 0.26.0

- New targeted `re-export --scan --scan-file <path>` for reviewed single-patch new-file assignment.
- A FireForge-owned whitespace gate excludes generated `patches/*.patch` diff syntax from repository whitespace checks.

## 0.25.0

- Kept `MOZ_APP_VENDOR` in `browser/moz.configure` for Firefox ESR 140 trees instead of generated branding `configure.sh`.
- Added a regression for stale xpcshell install symlink repair.

## 0.24.0

- Moved branding vendor identity into generated branding configure scripts.
- Added metadata-backed staged forward-import declarations and `patch staged-dependency`.
- Added stale xpcshell `_tests` symlink repair with a single safe retry.
- Added `patch move-files` for previewable ownership-transfer plans.

## 0.23.0

- Improved xpcshell argument filtering and mixed-harness diagnostics.
- Locked pre-test build phases and improved stale harness diagnostics.
- Fixed binary-safe re-export for new untracked files.
- Improved additive `re-export --files` and lint warning guidance.

## 0.22.0

- Added `doctor --clear-resolution` with verify-backed safety checks.
- Shared patch queue health checks between `verify` and doctor recovery.
- Improved Furnace repair for empty custom orphan directories.
- Enforced patch policy during `patch compact`.

## 0.21.0

- Added chrome-doc dry-runs and cleanup.
- Added versioned `status --json` output.
- Added configurable patch queue policy.
- Hardened export, Furnace deploy, and UI build preflights.

## 0.20.0

- Added pinned Firefox archive checksums.
- Added `fireforge patch compact`.
- Added Furnace xpcshell scaffolding.
- Locked download and archive-cache mutation paths.
- Hardened atomic writes, stale locks, and Furnace refresh.

## 0.19.0

- Added stricter patch `checkJs` options.
- Added ambient `resource:*` and `chrome:*` module shims.
- Fixed Mozilla licence-header detection.
- Fixed Marionette port forwarding for mixed test suites.
- Restored browser-chrome as the default Furnace test harness.

## 0.18.0

- Kept existing 0.17 patch queues compatible.
- Fixed aggregate lint and `export-all` directory crashes.
- Improved doctor ownership classification.
- Fixed localized Furnace remove and rename registration.
- Hardened Furnace concurrency, rollback, and validation paths.

## 0.17.0

- Improved fresh-project setup and branding output.
- Added `patch tier` and per-patch lint-ignore editing.
- Fixed `export-all` ownership and Furnace exclusion cases.
- Improved build, test, and status diagnostics.

## 0.16.0

- Hardened release and config security paths.
- Fixed `config --force` read and write behaviour.
- Improved download, status, and setup feedback.
- Added safer Furnace init, create, preview, and chrome-doc behaviour.
- Improved lint, build audit, and rebase reliability.

## 0.15.0

- Added `re-export --stamp` and per-patch lint ignores.
- Added `lint --per-patch`, `--since`, and introduced-only checks.
- Added xpcshell appdir handling and test diagnostics.
- Added `run --smoke-exit` for unattended chrome smoke checks.
- Expanded Furnace localisation, chrome-doc, build, and validation support.

## 0.14.0

- Made patch and state writes transactional.
- Hardened rebase, import, and download recovery.
- Improved Furnace apply, rename, deploy, diff, and validation.
- Added broader input validation across setup, config, wire, register, and test.
- Improved status output and watch/run preflights.

## 0.13.0

- Improved bootstrap checks after `mach bootstrap`.
- Added tiered lint severity for large files and patches.
- Added raw-colour allowlists and inline suppression.
- Added `fireforge patch compact`.
- Improved register support for XHTML and CSS.

## 0.12.0

- Made JSDoc linting AST-based and stricter.
- Added optional patch-owned `checkJs`.
- Hardened path validation and symlink handling.
- Improved stale-lock recovery.
- Expanded forward-import detection and Furnace repair diagnostics.

## 0.11.0

- Added `verify`, `patch delete`, and `patch reorder`.
- Added export, import, status, and Furnace workflow flags.
- Expanded Furnace refresh, apply, remove, scan, diff, and status.
- Added cross-patch lint rules.
- Improved doctor, rollback, build preparation, and packaging reliability.

## 0.10.0

- Tightened patch export and re-export validation.
- Added raw-colour linting for patch diffs.
- Improved Furnace accessibility checks.
- Improved build-artifact and git failure handling.
- Updated package metadata and install guidance.

## 0.9.0

- Published the npm package.
