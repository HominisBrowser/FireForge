// SPDX-License-Identifier: EUPL-1.2
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const COVERAGE_SUMMARY_PATH = resolve('coverage/coverage-summary.json');

const MODULE_THRESHOLDS = {
  'src/core/mach.ts': { lines: 95, branches: 88 },
  // Pinned just below their landing coverage.
  'src/utils/concurrency.ts': { lines: 98, branches: 90, functions: 100 },
  // Identity must degrade to the plain semver, never throw — the guarded
  // fallbacks are the point of the module.
  'src/utils/build-info.ts': { lines: 90, branches: 80, functions: 100 },
  'src/commands/status-json.ts': { lines: 95, branches: 80 },
  // Pinned just below landing coverage. The extend anchor is the fail-closed
  // guard for a coverage claim, so every refusal branch must stay exercised.
  'src/core/coverage-extend.ts': { lines: 95, branches: 85 },
  'src/commands/status-ownership.ts': { lines: 95, branches: 85 },
  'src/commands/export-placement-conflicts.ts': { lines: 95, branches: 80 },
  'src/commands/patch/staged-dependency-validate.ts': { lines: 95, branches: 85 },
  // Pinned just below their landing coverage so regressions surface without
  // blocking unrelated refactors.
  'src/core/test-harness-crash.ts': { lines: 98, branches: 90 },
  'src/core/furnace-css-fragments.ts': { lines: 96, branches: 78 },
  'src/core/furnace-jsconfig.ts': { lines: 89, branches: 78 },
  'src/core/patch-lint-observer.ts': { lines: 94, branches: 85 },
  'src/commands/test-run.ts': { lines: 94, branches: 75 },
  'src/commands/test-diagnose.ts': { lines: 92, branches: 85 },
  // The verdict sink is tiny and fully unit-tested; hold it there.
  'src/commands/test-verdict.ts': { lines: 98, branches: 95 },
  // The command body's uncovered ranges are the under-lock rollback warns
  // and the commander registration block; the planning logic carries the
  // higher split-plan.ts thresholds.
  'src/commands/patch/split.ts': { lines: 78, branches: 64 },
  'src/commands/patch/split-plan.ts': { lines: 89, branches: 78 },
  'src/cli.ts': { lines: 98, branches: 84, functions: 98 },
  'src/commands/setup.ts': { lines: 98, branches: 79 },
  'src/commands/setup-support.ts': { lines: 96, branches: 85 },
  'src/commands/token.ts': { lines: 98, branches: 76, functions: 85 },
  'src/commands/furnace/index.ts': { lines: 98, branches: 50, functions: 98 },
  // The remaining branch gap (~5% from 94.36 → 95) is the defensive
  // `else { continue; }` in `reValidateComponents` for componentNames that
  // are neither in `config.overrides` nor `config.custom`. The fixable-issue
  // set (`missing-jar-mn-mjs`, `missing-jar-mn-css`) does not emit issues
  // for stock components, so that branch is functionally unreachable; it is
  // retained for defence-in-depth against a future invariant change.
  'src/commands/furnace/validate.ts': { lines: 93, branches: 94 },
  // Pure re-export barrel: V8 reports no executable lines, so only require a tracked coverage entry.
  'src/core/furnace-validate-checks.ts': {},
  'src/core/furnace-validate-registration.ts': { lines: 94, branches: 75 },
  'src/core/furnace-registration-ast.ts': { lines: 89, branches: 75 },
  'src/core/furnace-rollback.ts': { lines: 95, branches: 80 },
  'src/core/wire-init.ts': { lines: 95, branches: 79 },
  'src/core/wire-subscript.ts': { lines: 98, branches: 80 },
  'src/core/patch-export.ts': { lines: 93, branches: 75 },
  'src/utils/logger.ts': { lines: 95, branches: 76, functions: 95 },
  // The fuzz path is exercised against a REAL git binary (a mocked test can
  // validate behaviour real git cannot produce),
  // and the two furnace state/step-error modules own the invariants whose
  // divergence caused the named-apply state wipe and the rollback-contract
  // drift. Pins keep those regression nets from silently thinning.
  'src/core/patch-apply-fuzz.ts': { lines: 90, branches: 80, functions: 100 },
  'src/core/furnace-state-persist.ts': { lines: 80, branches: 70, functions: 100 },
  'src/core/furnace-step-errors.ts': { lines: 98, branches: 95, functions: 100 },
  'src/utils/platform.ts': { lines: 98, branches: 95, functions: 100 },
  'src/core/register-browser-content.ts': { lines: 98, branches: 94 },
  'src/core/register-shared-css.ts': { lines: 98, branches: 94 },
  'src/core/moz-manifest-rules.ts': { lines: 98, branches: 83 },
  'src/commands/run.ts': { lines: 95, branches: 86 },
  'src/core/wire-dom-fragment.ts': { lines: 93, branches: 82 },
  'src/commands/furnace/override.ts': { lines: 98, branches: 95 },
  // Pure pattern-based error-hint translator — trivially testable.
  'src/core/mach-error-hints.ts': { lines: 98, branches: 95, functions: 100 },
  // Post-build audit (warn-only) — critical because misdetections here
  // cause noisy warnings on every successful build.
  'src/core/build-audit.ts': { lines: 88, branches: 75 },
  // Shared "what changed since the last build" collector behind the
  // audit, auto-configure, and stale-build preflights. Small and fully
  // exercised through all three consumers (measured 100/90/100); a drop
  // below the pin means one of those probe paths lost its coverage.
  'src/core/engine-changes.ts': { lines: 95, branches: 85, functions: 100 },
  // Shared patch-command preamble (queue load + identifier resolve).
  // Direct unit tests pin the error wording every patch subcommand
  // surfaces (measured 100/100/100).
  'src/commands/patch/patch-context.ts': { lines: 95, branches: 95, functions: 100 },
  // Audit helpers — pure path-resolution and Python-style moz.build
  // gate detection. Both are easy to unit-test exhaustively.
  'src/core/build-audit-resolve.ts': { lines: 90, branches: 80 },
  'src/core/build-audit-platform.ts': { lines: 88, branches: 80 },
  // Registration-aware artifact resolver — walks jar.mn ancestors to
  // disambiguate same-basename collisions across unrelated subtrees.
  'src/core/build-audit-registration.ts': { lines: 95, branches: 85 },
  // Known source→chrome packaging transforms used when no jar.mn
  // `(source)` annotation is available. Pure path rewriting + dist probe.
  'src/core/build-audit-transforms.ts': { lines: 95, branches: 85, functions: 100 },
  // Build-artifact preflight + mozinfo rewriter. Coverage for the
  // rewriter lives in `mach-mozinfo-rewrite.test.ts` (real fs) because
  // the `mach.test.ts` suite mocks `utils/fs.js` module-wide.
  'src/core/mach-build-artifacts.ts': { lines: 90, branches: 80 },
  // Build baseline marker — tiny file, easy to hit high coverage.
  'src/core/build-baseline.ts': { lines: 95, branches: 85 },
  // Patch-aware discard planner (P0 data loss): the restore-target
  // decision must stay exhaustively covered — a misclassified plan reverts a
  // patch-backed file past its owning patch.
  'src/core/discard-baseline.ts': { lines: 90, branches: 80, functions: 90 },
  // Per-patch moz.build sorted-list check — pure parser. The
  // uncovered branches are defensive nullish fallbacks on regex captures.
  'src/core/patch-lint-mozbuild.ts': { lines: 95, branches: 78 },
  // Stale-build preflight for `fireforge test`. Pure git + path-filter
  // wrapper; broken probes must never fail-open-as-stale so the defensive
  // branches are exhaustively exercised.
  'src/core/test-stale-check.ts': { lines: 90, branches: 75, functions: 100 },
  // Lint diff-scoping helper — pure filtering + git integration.
  'src/core/patch-lint-diff-tag.ts': { lines: 95, branches: 80 },
  // Chrome-doc scaffolder — transactional, journal-backed.
  'src/commands/furnace/chrome-doc.ts': { lines: 88, branches: 78 },
  // Chrome-doc templates — pure string assembly.
  'src/commands/furnace/chrome-doc-templates.ts': { lines: 98, branches: 95, functions: 100 },
  // Chrome-doc packaging-verification test templates — pure string
  // assembly; every branch is exercised by the unit tests.
  'src/commands/furnace/chrome-doc-tests.ts': { lines: 98, branches: 95, functions: 100 },
  // MochiKit scaffolder — mirrors the xpcshell scaffolder shape.
  'src/commands/furnace/create-mochikit.ts': { lines: 95, branches: 80 },
  // Dry-run + success-note formatter for `furnace create` — pure string
  // assembly, exhaustively exercisable.
  'src/commands/furnace/create-dry-run.ts': { lines: 95, branches: 85, functions: 100 },
  // xpcshell appdir auto-injection — the resolver shapes the `--app-path`
  // arg passed verbatim to mach test, so a regression here re-breaks
  // every rebranded fork's xpcshell suite. Real-fs unit tests cover both
  // happy path and the four "skip" outcomes.
  'src/core/xpcshell-appdir.ts': { lines: 90, branches: 85, functions: 100 },
  // Override refresh merge semantics — fatal `git merge-file` exits must
  // never be surfaced as ordinary conflict counts.
  'src/core/furnace-refresh.ts': { lines: 95, branches: 85, functions: 100 },
  // Patch queue renumbering — destructive manifest/filesystem mutation.
  'src/commands/patch/compact.ts': { lines: 88, branches: 75, functions: 85 },
  // xpcshell scaffold rename — filesystem rewrite helper for component rename.
  'src/commands/furnace/rename-xpcshell.ts': { lines: 98, branches: 80, functions: 100 },
  // Edge modules that the global threshold alone would mask.
  // Signal-deferred critical sections: the SIGINT/SIGTERM exit path
  // depends on this registry behaving exactly as specified.
  'src/core/signal-critical.ts': { lines: 98, branches: 95, functions: 80 },
  // Bootstrap output pattern scanner + SDK-probe branching.
  'src/commands/bootstrap-checks.ts': { lines: 95, branches: 90, functions: 95 },
  // Destructive command: directory-recursion fallback, batch partial
  // failures, and the Furnace-managed warnings must stay exercised.
  'src/commands/discard.ts': { lines: 92, branches: 80, functions: 85 },
  // Furnace compatibility validation incl. compose/CSS hygiene warnings.
  'src/core/furnace-validate-compatibility.ts': { lines: 94, branches: 88, functions: 95 },
  // Tar extraction preflight — rejects traversal names and escaping links.
  'src/core/firefox-extract.ts': { lines: 90, branches: 85, functions: 85 },
  // These four sit on destructive or
  // verdict-blessing paths and had NO pin at all: with 314 files diluting the
  // global aggregate, a refactor could drop any of them 15 points and
  // `release:check` would still pass. Pinned just below landing coverage.
  //
  // Process-liveness primitives. `isProcessAlive` must keep treating EPERM as
  // ALIVE: reading it as "dead" in a predicate that gates an `rm -rf` deletes
  // live state. Kept at 100 because the module is tiny and pure.
  'src/utils/errors.ts': { lines: 98, branches: 95, functions: 100 },
  // The assertion primitive. Every internal invariant check in the
  // codebase funnels through this one module precisely so the failure branch
  // is covered once here instead of uncovered at ~40 call sites — which only
  // works while this file itself stays fully exercised.
  'src/utils/assert.ts': { lines: 98, branches: 95, functions: 100 },
  // Tree clone removal: `inspectTreeLock` gates `rm -rf` of a full project
  // clone in `removeTree`.
  'src/core/tree-store.ts': { lines: 92, branches: 84 },
  // `doctor --repair-furnace` deletes the furnace lock directory.
  'src/commands/doctor-furnace.ts': { lines: 82, branches: 72 },
  // Engine generation guard: decides whether a test verdict is trustworthy.
  // The suite bypasses the lock by default, so its own tests are the only
  // exercise this module gets (measured 75.0/72.2 → 92.3/81.8).
  'src/core/engine-session-lock.ts': { lines: 90, branches: 80 },
  // Lock owner record: the fatal write-and-verify that stops an owner-less
  // lock being reaped under a live holder, and the PID-reuse liveness guard.
  // A false "dead" verdict here reaps a live lock, so every branch stays pinned.
  'src/core/file-lock-owner.ts': { lines: 95, branches: 90, functions: 100 },
  // Severity resolution for every doctor check — one resolver shared by
  // `doctor.ts` and `bootstrap.ts`, which are easy to drift apart.
  'src/commands/doctor-check-core.ts': { lines: 98, branches: 80, functions: 100 },
  // Each of these was a coverage outlier with no pin, so the global aggregate
  // could not see a regression in it.
  //
  // Pure config validator with zero I/O that runs on EVERY config load.
  'src/core/config-validate-test-toolchains.ts': { lines: 98, branches: 95, functions: 100 },
  // Commander wiring for `fireforge test`. Registration alone runs during
  // help tests without invoking any argParser callback or the action body,
  // so the pin is what keeps them exercised: the two numeric flags must keep
  // rejecting out-of-range input through commander's invalid-argument
  // channel.
  'src/commands/test-register.ts': { lines: 95, branches: 90, functions: 100 },
  // Stale jar.mn registration check — `--repair-furnace` must actually prune,
  // not report success without touching the lines.
  'src/commands/doctor-furnace-jar.ts': { lines: 95, branches: 80, functions: 100 },
  // Manifest repair. Pinned just below landing coverage: the preserve-or-
  // refuse branches are the whole point of both modules, and a regression
  // there is silent data loss rather than a visible failure.
  'src/core/patch-manifest-files-affected.ts': { lines: 95, branches: 85 },
  'src/commands/doctor-patch-manifest.ts': { lines: 85, branches: 78 },
  // Deletes engine sources and rewrites three jar manifests. Happy-path round
  // trips alone leave the refusal, cancel, idempotent-re-remove and rollback
  // arms dark.
  'src/commands/furnace/chrome-doc-remove.ts': { lines: 95, branches: 85, functions: 100 },
  // The two furnace mutators that concentrate the most risk: both delete
  // engine files. Pinned so a future line-budget extraction cannot silently
  // thin the nets guarding them.
  'src/commands/furnace/remove.ts': { lines: 96, branches: 84, functions: 100 },
  'src/commands/furnace/refresh.ts': { lines: 94, branches: 88, functions: 100 },
  // `tree remove --all` deletes whole cloned trees and `tree exec` spawns the
  // CLI inside one.
  'src/commands/tree.ts': { lines: 94, branches: 92 },
  // The ftlBasePath shape probe only runs when engine/ exists, so an
  // all-mocked suite never reaches it.
  'src/commands/furnace/init.ts': { lines: 90, branches: 90 },
};

function loadCoverageSummary() {
  return JSON.parse(readFileSync(COVERAGE_SUMMARY_PATH, 'utf8'));
}

function findCoverageEntry(summary, modulePath) {
  if (summary[modulePath]) {
    return summary[modulePath];
  }

  const normalizedPath = modulePath.replace(/\\/g, '/');

  for (const [entryPath, entry] of Object.entries(summary)) {
    const normalizedEntry = entryPath.replace(/\\/g, '/');
    // Require a path-separator boundary: a bare endsWith could bind
    // 'core/git.ts' to an unrelated '.../not-core/git.ts'-shaped entry
    // whose path merely ends with the same characters.
    if (normalizedEntry === normalizedPath || normalizedEntry.endsWith(`/${normalizedPath}`)) {
      return entry;
    }
  }

  return null;
}

function formatThresholdFailure(modulePath, metric, actual, minimum) {
  return `${modulePath}: ${metric} coverage ${actual.toFixed(2)}% is below ${minimum}%`;
}

function checkMetric(failures, modulePath, entry, metric, minimum) {
  if (minimum === undefined) {
    return;
  }

  if (entry[metric].pct < minimum) {
    failures.push(formatThresholdFailure(modulePath, metric, entry[metric].pct, minimum));
  }
}

/**
 * Floor for every covered module that carries no explicit pin.
 *
 * The pin list is a ratchet for modules whose coverage someone deliberately
 * raised; it says nothing about the rest. Without a floor, every unpinned
 * module is governed only by the global aggregate — which sits in the low 90s
 * and absorbs a lot — so a module can sit well below the global line
 * threshold with nothing to notice, and a new module arrives completely
 * unguarded.
 *
 * Deliberately modest: this is a floor against rot, not a target. Raising a
 * module above it is what MODULE_THRESHOLDS is for.
 */
const UNPINNED_FLOOR = { lines: 70, branches: 55 };

/**
 * Modules exempted from {@link UNPINNED_FLOOR}, with the reason.
 *
 * Seeded from the modules already below the floor when it was introduced, so
 * the gate starts green and catches REGRESSIONS rather than demanding a
 * coverage push as the price of adding the check. Each is a candidate for
 * removal once its coverage comes up.
 */
const UNPINNED_FLOOR_EXEMPT = new Map([
  // Branch-heavy toolchain probing whose arms need real external binaries.
  ['src/commands/doctor-external-toolchains.ts', 'external toolchain probes'],
  ['src/commands/export-placement-gate.ts', 'placement gating covered through export flows'],
  ['src/commands/furnace/create-readback.ts', 'readback verification covered end-to-end'],
  ['src/commands/furnace/list.ts', 'display-only listing'],
  ['src/commands/patch/move-files-into.ts', 'covered by patch-move-files integration tests'],
  ['src/commands/re-export-register.ts', 'registration covered through re-export flows'],
  ['src/core/config.ts', 'thin facade; the validators it delegates to are pinned'],
  ['src/core/furnace-apply-ftl.ts', 'localized-component paths need FTL fixtures'],
  ['src/errors/config.ts', 'message-only error classes'],
  ['src/errors/run.ts', 'message-only error classes'],
  ['src/utils/elapsed.ts', 'formatting helper, 6 lines'],
]);

function main() {
  const summary = loadCoverageSummary();
  const failures = [];

  for (const [modulePath, thresholds] of Object.entries(MODULE_THRESHOLDS)) {
    const entry = findCoverageEntry(summary, modulePath);

    if (!entry) {
      failures.push(`${modulePath}: coverage entry not found in ${COVERAGE_SUMMARY_PATH}`);
      continue;
    }

    checkMetric(failures, modulePath, entry, 'lines', thresholds.lines);
    checkMetric(failures, modulePath, entry, 'branches', thresholds.branches);
    checkMetric(failures, modulePath, entry, 'functions', thresholds.functions);
  }

  // Floor for everything else with executable statements.
  for (const [entryPath, entry] of Object.entries(summary)) {
    if (entryPath === 'total') continue;
    if (!entry.statements || entry.statements.total === 0) continue;
    const normalized = entryPath.replace(/\\/g, '/');
    const index = normalized.indexOf('src/');
    if (index === -1) continue;
    const modulePath = normalized.slice(index);
    if (MODULE_THRESHOLDS[modulePath] !== undefined) continue;
    if (UNPINNED_FLOOR_EXEMPT.has(modulePath)) continue;
    checkMetric(failures, modulePath, entry, 'lines', UNPINNED_FLOOR.lines);
    checkMetric(failures, modulePath, entry, 'branches', UNPINNED_FLOOR.branches);
  }

  if (failures.length > 0) {
    console.error('Critical module coverage checks failed:');
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `Coverage checks passed (${Object.keys(MODULE_THRESHOLDS).length} pinned modules, ` +
      `floor ${UNPINNED_FLOOR.lines}/${UNPINNED_FLOOR.branches} elsewhere with ` +
      `${UNPINNED_FLOOR_EXEMPT.size} exemptions).`
  );
}

main();
