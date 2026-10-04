// SPDX-License-Identifier: EUPL-1.2
/** Command registration must be reachable from the real manifest and executable. */
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import type { CommandContext } from '../../types/cli.js';
import { COMMAND_MANIFEST } from '../manifest.js';

const COMMANDS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function unwiredRegistrars(program: ts.Program, manifestPath: string, directory: string): string[] {
  const checker = program.getTypeChecker();
  const resolveSymbol = (node: ts.Node): ts.Symbol | undefined => {
    const symbol = checker.getSymbolAtLocation(node);
    return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  };
  const manifest = program.getSourceFile(manifestPath);
  if (!manifest) throw new Error(`Missing manifest: ${manifestPath}`);
  const manifestModule = checker.getSymbolAtLocation(manifest);
  const manifestDeclaration =
    manifestModule &&
    checker.getExportsOfModule(manifestModule).find((symbol) => symbol.name === 'COMMAND_MANIFEST')
      ?.valueDeclaration;
  if (
    !manifestDeclaration ||
    !ts.isVariableDeclaration(manifestDeclaration) ||
    !manifestDeclaration.initializer
  ) {
    throw new Error('COMMAND_MANIFEST must export the registration table');
  }
  const reachable = new Set<ts.Symbol>();
  const pending: ts.Symbol[] = [];
  const visitRoots = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText() === 'register') {
      const symbol = resolveSymbol(node.initializer);
      if (symbol) pending.push(symbol);
    }
    ts.forEachChild(node, visitRoots);
  };
  visitRoots(manifestDeclaration.initializer);
  while (pending.length > 0) {
    const symbol = pending.pop();
    if (!symbol || reachable.has(symbol)) continue;
    reachable.add(symbol);
    const declaration = symbol.valueDeclaration;
    if (!declaration || !declaration.getSourceFile().fileName.startsWith(directory)) continue;
    const visitCalls = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const called = resolveSymbol(node.expression);
        if (called) pending.push(called);
      }
      ts.forEachChild(node, visitCalls);
    };
    visitCalls(declaration);
  }
  const missing = new Set<string>();
  for (const file of program.getSourceFiles()) {
    if (!file.fileName.startsWith(directory) || file.fileName.includes('__tests__')) continue;
    const module = checker.getSymbolAtLocation(file);
    if (!module) continue;
    for (const exported of checker.getExportsOfModule(module)) {
      if (!/^register[A-Z]/.test(exported.name)) continue;
      const symbol =
        (exported.flags & ts.SymbolFlags.Alias) !== 0
          ? checker.getAliasedSymbol(exported)
          : exported;
      const declaration = symbol.valueDeclaration;
      // `registerCommand` is an action; registrars accept a Commander program.
      if (!declaration) continue;
      const signature = checker
        .getTypeOfSymbolAtLocation(symbol, declaration)
        .getCallSignatures()[0];
      const firstParameter = signature?.getParameters()[0];
      if (
        !firstParameter ||
        checker.getTypeOfSymbolAtLocation(firstParameter, declaration).getSymbol()?.name !==
          'Command'
      )
        continue;
      if (!reachable.has(symbol))
        missing.add(`${file.fileName.slice(directory.length + 1)}:${exported.name}`);
    }
  }
  return [...missing].sort();
}

describe('COMMAND_MANIFEST integrity', () => {
  it('has non-empty, unique command names', () => {
    const names = COMMAND_MANIFEST.map((entry) => entry.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((name) => name.trim().length > 0)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
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

  it('wires every exported registrar, including nested commands, through the manifest', async () => {
    const entries = await readdir(COMMANDS_DIR, { recursive: true, withFileTypes: true });
    const files = entries
      .filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith('.ts') && !entry.parentPath.includes('__tests__')
      )
      .map((entry) => join(entry.parentPath, entry.name));
    const program = ts.createProgram(files, {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
    });
    expect(unwiredRegistrars(program, join(COMMANDS_DIR, 'manifest.ts'), COMMANDS_DIR)).toEqual([]);
  });

  it('does not count comments or unused registrar references as registration', () => {
    const file = '/virtual/commands.ts';
    const source = `
      declare class Command { command(name: string): Command }
      export function registerLive(program: Command) { program.command('live') }
      export function registerMissing(program: Command) { program.command('missing') }
      export const registerArrow = (program: Command) => { program.command('arrow') };
      // registerMissing is mentioned but never registered.
      const unused = { register: registerMissing };
      export const COMMAND_MANIFEST = [{ register: registerLive }];
    `;
    const host = ts.createCompilerHost({ noLib: true });
    host.getSourceFile = (path) =>
      path === file ? ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true) : undefined;
    const program = ts.createProgram([file], { noLib: true }, host);
    expect(unwiredRegistrars(program, file, '/virtual')).toEqual([
      'commands.ts:registerArrow',
      'commands.ts:registerMissing',
    ]);
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
