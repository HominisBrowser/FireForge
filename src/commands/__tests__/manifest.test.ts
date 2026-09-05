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
 * The test inspects the manifest structure rather than exercising
 * commander's `--help` output. Help parsing is already covered
 * elsewhere via snapshot, and the goal here is to pin the manifest
 * contract itself (each entry has a name, a known group, and a
 * callable register function, names are unique, and no entry is null).
 *
 * The drift test at the end walks every top-level command file under
 * `src/commands/` and asserts that each exported `register*` is
 * referenced by the manifest source. That catches the one remaining
 * silent-drift failure mode a structural check cannot see: "I added a
 * new command file and forgot to wire it into the manifest." Files that
 * export no registrar are helpers and are simply skipped.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../../types/cli.js';
import { COMMAND_MANIFEST } from '../manifest.js';

const COMMANDS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

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
    // register*` declarations and asserts the manifest source imports each
    // one. Without it a new command compiles and type-checks cleanly
    // without being added to the manifest. It simply does not ship, and no
    // test fails.
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
      .map((e) => e.name);

    const missing: Array<{ file: string; registrar: string }> = [];
    // Match three export shapes:
    //   - `export function registerXxx(...)`
    //   - `export const registerXxx = ...`
    //   - `export { registerXxx } from './x.js'` (barrel re-export)
    // Barrel files like `rebase.ts` that re-export a registrar from a
    // subdirectory should still satisfy the drift check. The file's
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
    }

    expect(missing, `unreferenced registrars: ${JSON.stringify(missing)}`).toEqual([]);
  });

  it.each(['furnace', 'patch'])(
    'renders its default action and exits cleanly when `%s` is invoked without a subcommand',
    async (name) => {
      // Every group-style parent installs a default action that renders
      // something informational (`patch` prints its help, `furnace` prints
      // component status) and returns successfully. Falling through to
      // commander's default help-then-exit-1 path gives scripts probing the
      // CLI surface an inconsistent exit contract for informational
      // invocations. (`token` is covered the same way in token.test.ts.)
      const noopContext: CommandContext = {
        getProjectRoot: () => '/tmp/fireforge-manifest-test',
        withErrorHandling: <T extends unknown[]>(handler: (...args: T) => Promise<void>) => {
          return handler;
        },
      };
      const entry = COMMAND_MANIFEST.find((e) => e.name === name);
      if (!entry) throw new Error(`manifest entry for ${name} is missing`);
      const program = new Command();
      entry.register(program, noopContext);

      const originalWrite = process.stdout.write.bind(process.stdout);
      let captured = '';
      process.stdout.write = (chunk: string | Uint8Array) => {
        captured += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
        return true;
      };
      try {
        await program.parseAsync(['node', 'fireforge', name]);
      } finally {
        process.stdout.write = originalWrite;
      }

      // Reaching here at all is the contract: commander's fallback for a
      // group with no default action prints help and exits 1, which would
      // abort the process instead of resolving. The output check pins that
      // the informational invocation actually said something.
      expect(captured.trim().length).toBeGreaterThan(0);
    }
  );
});
