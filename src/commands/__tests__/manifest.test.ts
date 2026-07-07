// SPDX-License-Identifier: EUPL-1.2
/**
 * Integrity test for the top-level command manifest.
 *
 * The manifest is a single point of failure for CLI dispatch: a typo in
 * an import, a `register` export that is not actually a function, or a
 * missing group label all break the CLI at runtime with the kind of
 * stack trace that masks the root cause. A ten-line structural check
 * that runs under `npm test` catches those before the bin script does.
 *
 * The test deliberately inspects the manifest structure rather than
 * exercising commander's `--help` output — help parsing is already
 * covered elsewhere via snapshot, and the goal here is to pin the
 * manifest contract itself (each entry has a name, a known group, and
 * a callable register function; names are unique; no entry is null).
 *
 * The drift test at the end walks every top-level command file under
 * `src/commands/` and asserts that each `export function register*`
 * with a top-level `Command` signature is referenced by the manifest
 * source — catching the one remaining silent-drift failure mode a
 * structural check cannot see: "I added a new command file and forgot
 * to wire it into the manifest."
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../../types/cli.js';
import { COMMAND_MANIFEST } from '../manifest.js';

const COMMANDS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Command files under `src/commands/` that intentionally do NOT export a
 * top-level registrar. They are either helpers (`export-flow.ts`), the
 * manifest itself, or shared support modules consumed by other
 * registrars. Keeping this list explicit means the drift test fails
 * loudly when a new helper is added, forcing the author to acknowledge
 * whether the file should be wired into the manifest or classified as
 * a helper.
 */
const HELPER_FILES: ReadonlySet<string> = new Set([
  'manifest.ts',
  'export-flow.ts',
  // Placement-flag gating split out of export.ts so the command body
  // stays inside the per-function complexity and line budgets. Exports
  // `gatePlacementPlan` / `patchMetadataExtras` consumed by export.ts;
  // no top-level register* is exported and none is wanted.
  'export-placement-gate.ts',
  'export-placement-policy.ts',
  'export-shared.ts',
  'doctor-external-toolchains.ts',
  'setup-support.ts',
  'status-output.ts',
  'test.ts',
  'test-modes.ts',
  'token-coverage.ts',
  // Post-bootstrap validation checks consumed by bootstrap.ts. Exports
  // check helpers, not a top-level registrar.
  'bootstrap-checks.ts',
  // Furnace doctor checks split out of doctor.ts so the main file stays
  // under the max-lines threshold. The file exports a typed array of
  // DoctorCheckDefinition values that doctor.ts splices into its
  // registry; no top-level register* is exported and none is wanted.
  'doctor-furnace.ts',
  // Stale jar.mn registration check split out of doctor-furnace.ts to
  // keep that file within the line budget; exports a
  // DoctorCheckDefinition consumed by doctor-furnace.ts (0.34.0).
  'doctor-furnace-jar.ts',
  // Orphan-override detection split out of doctor-furnace.ts to keep
  // that file under the max-lines threshold. Exports a single
  // `DoctorCheckDefinition` consumed by doctor-furnace.ts.
  'doctor-furnace-manifest-sync.ts',
  // Ownership-aware working-tree inspector split out of doctor.ts so
  // that file stays under max-lines. Exports an async helper that
  // `doctor.ts` calls from inside its git-checks group.
  'doctor-working-tree.ts',
  // Shared doctor check types and `ok` / `warning` / `failure` builders.
  // Split out so `doctor-furnace.ts` and siblings import without cycling
  // through `doctor.ts`.
  'doctor-check-core.ts',
  // The --files path for re-export, extracted from re-export.ts to keep
  // it under the max-lines threshold. Consumed by re-export.ts; no
  // top-level registrar.
  're-export-files.ts',
  // Bulk scan manifest and option helpers for re-export, extracted from
  // re-export.ts to keep that command under max-lines.
  're-export-bulk-scan.ts',
  're-export-options.ts',
  // Per-patch lint orchestration split out of lint.ts so the aggregate
  // command and cache-backed queue path both stay under max-lines.
  'lint-per-patch.ts',
  // Scan planning helpers for re-export, including targeted --scan-file.
  // Consumed by re-export.ts; no top-level registrar.
  're-export-scan.ts',
  // Xpcshell appdir auto-injection helper consumed by test.ts; no
  // top-level registrar.
  'test-appdir.ts',
  // Harness retry/shard orchestration and failure diagnosis split out of
  // test.ts so all three stay under the max-lines threshold. Consumed by
  // test.ts; no top-level registrar.
  'test-run.ts',
  'test-diagnose.ts',
]);

const ALLOWED_GROUPS = new Set(['project', 'workflow', 'engine', 'diagnostics', 'components']);

describe('COMMAND_MANIFEST integrity', () => {
  it('has at least one entry', () => {
    expect(COMMAND_MANIFEST.length).toBeGreaterThan(0);
  });

  it('every entry has a non-empty name, a known group, and a register function', () => {
    for (const entry of COMMAND_MANIFEST) {
      expect(entry).toBeDefined();
      expect(typeof entry.name).toBe('string');
      expect(entry.name.length).toBeGreaterThan(0);
      expect(ALLOWED_GROUPS.has(entry.group)).toBe(true);
      expect(typeof entry.register).toBe('function');
    }
  });

  it('has no duplicate command names', () => {
    const seen = new Set<string>();
    for (const entry of COMMAND_MANIFEST) {
      expect(seen.has(entry.name)).toBe(false);
      seen.add(entry.name);
    }
  });

  it('every register function accepts a Commander program without throwing', () => {
    // A registrar with a broken import surface (e.g. an undefined export
    // that slipped past the type system via re-exports) will throw at
    // registration time, not at definition time. Running the registrars
    // against a throwaway program catches those cases.
    const noopContext: CommandContext = {
      getProjectRoot: () => '/tmp/fireforge-manifest-test',
      withErrorHandling: <T extends unknown[]>(handler: (...args: T) => Promise<void>) => {
        return handler;
      },
    };

    for (const entry of COMMAND_MANIFEST) {
      const program = new Command();
      expect(() => {
        entry.register(program, noopContext);
      }).not.toThrow();
    }
  });

  it('registers a command whose first positional name matches the manifest entry', () => {
    // Catches the one remaining "silent drift" failure mode: a registrar
    // whose .command(...) call uses a different name than the manifest
    // entry advertises. The two must stay aligned so manifest-based
    // documentation tooling and the CLI surface agree.
    const noopContext: CommandContext = {
      getProjectRoot: () => '/tmp/fireforge-manifest-test',
      withErrorHandling: <T extends unknown[]>(handler: (...args: T) => Promise<void>) => {
        return handler;
      },
    };

    for (const entry of COMMAND_MANIFEST) {
      const program = new Command();
      entry.register(program, noopContext);
      const registeredNames = program.commands.map((c) => c.name());
      expect(registeredNames).toContain(entry.name);
    }
  });

  it('every top-level command file with a registrar is referenced by the manifest', async () => {
    // Drift protection: scans src/commands/*.ts for `export function
    // register*` declarations and asserts the manifest source imports
    // each one. Previously a new command could compile and type-check
    // cleanly without being added to the manifest — the command
    // simply would not ship, and no test would fail. This walks the
    // files directly so it surfaces the omission at test time.
    const manifestSource = await readFile(join(COMMANDS_DIR, 'manifest.ts'), 'utf-8');
    const importedRegistrars = new Set<string>();
    const importPattern = /\bregister[A-Z][A-Za-z0-9_]*/g;
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(manifestSource)) !== null) {
      importedRegistrars.add(match[0]);
    }

    const entries = await readdir(COMMANDS_DIR, { withFileTypes: true });
    const topLevelFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
      .map((e) => e.name)
      .filter((name) => !HELPER_FILES.has(name));

    const missing: Array<{ file: string; registrar: string }> = [];
    // Match three export shapes:
    //   - `export function registerXxx(...)`
    //   - `export const registerXxx = ...`
    //   - `export { registerXxx } from './x.js'` (barrel re-export)
    // Barrel files like `rebase.ts` that re-export a registrar from a
    // subdirectory should still satisfy the drift check — the file's
    // job is to expose a registrar at a stable import path, not to
    // declare one.
    const declPattern = /export\s+(?:function|const)\s+(register[A-Z][A-Za-z0-9_]*)/g;
    const reExportPattern = /export\s*\{[^}]*\b(register[A-Z][A-Za-z0-9_]*)\b[^}]*\}\s*from/g;
    for (const filename of topLevelFiles) {
      const content = await readFile(join(COMMANDS_DIR, filename), 'utf-8');
      const registrars = new Set<string>();
      let exportMatch: RegExpExecArray | null;
      while ((exportMatch = declPattern.exec(content)) !== null) {
        if (exportMatch[1]) registrars.add(exportMatch[1]);
      }
      while ((exportMatch = reExportPattern.exec(content)) !== null) {
        if (exportMatch[1]) registrars.add(exportMatch[1]);
      }
      for (const registrar of registrars) {
        if (!importedRegistrars.has(registrar)) {
          missing.push({ file: filename, registrar });
        }
      }
      // A top-level command file should export at least one
      // registrar. If it does not, either classify it as a HELPER_FILE
      // or add a registrar — silent "this file does nothing" states
      // are a drift source in their own right.
      if (registrars.size === 0) {
        missing.push({ file: filename, registrar: '(no register* export found)' });
      }
    }

    expect(missing, `unreferenced registrars: ${JSON.stringify(missing)}`).toEqual([]);
  });

  it('each group-style parent command installs a default action that exits cleanly', () => {
    // Finding #1: pre-0.16.0 `fireforge patch` and `fireforge token` fell
    // through to commander's default help-then-exit-1 path, while
    // `fireforge furnace` had a friendly default action and exited 0.
    // Scripts probing the CLI surface saw an inconsistent exit contract
    // for informational invocations. Each group-style parent now installs
    // a default action that prints its own help and returns successfully.
    const noopContext: CommandContext = {
      getProjectRoot: () => '/tmp/fireforge-manifest-test',
      withErrorHandling: <T extends unknown[]>(handler: (...args: T) => Promise<void>) => {
        return handler;
      },
    };
    const parentGroups = ['furnace', 'patch', 'token'];
    for (const name of parentGroups) {
      const entry = COMMAND_MANIFEST.find((e) => e.name === name);
      expect(entry, `manifest entry for ${name}`).toBeDefined();
      if (!entry) continue;
      const program = new Command();
      entry.register(program, noopContext);
      const parent = program.commands.find((c) => c.name() === name);
      expect(parent, `parent command ${name}`).toBeDefined();
      // Commander stores the default action handler on a private symbol.
      // The public `action()` method sets `_actionHandler`; we just need
      // to confirm something was installed (commander falls back to
      // "outputHelp + process.exit(1)" when `_actionHandler` is absent).
      expect((parent as unknown as { _actionHandler?: unknown })._actionHandler).toBeDefined();
    }
  });
});
