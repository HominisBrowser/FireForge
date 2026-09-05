// SPDX-License-Identifier: EUPL-1.2
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { createProgram } from '../cli.js';

describe('CLI help output', () => {
  it('documents kebab-case setup flags and configurable categories', () => {
    const program = createProgram();
    const setupHelp = program.commands
      .find((command) => command.name() === 'setup')
      ?.helpInformation();
    const exportHelp = program.commands
      .find((command) => command.name() === 'export')
      ?.helpInformation();
    const reExportHelp = program.commands
      .find((command) => command.name() === 're-export')
      ?.helpInformation();
    // The test epilogue is `addHelpText('after')`, which `helpInformation()`
    // omits — capture it the way a terminal sees it.
    let testHelp = '';
    const test = program.commands.find((command) => command.name() === 'test');
    test?.configureOutput({
      writeOut: (chunk) => {
        testHelp += chunk;
      },
    });
    test?.outputHelp();
    const lint = program.commands.find((command) => command.name() === 'lint');
    const lintHelp = lint?.helpInformation();

    expect(setupHelp).toContain('--app-id <appId>');
    expect(setupHelp).toContain('--binary-name <binaryName>');
    expect(setupHelp).toContain('--firefox-version <version>');
    expect(setupHelp).toContain('--product <product>');
    expect(setupHelp).toContain('"firefox-esr"');
    expect(setupHelp).toContain('"firefox-beta"');
    expect(exportHelp).toContain('--category <category>');
    expect(exportHelp).toContain('Place the new patch at this exact unused order');
    expect(exportHelp).toContain('without renumbering existing patches');
    expect(reExportHelp).toContain('--scan-files <manifest>');
    expect(reExportHelp).toContain('bulk-assign generated files');
    expect(lintHelp).toContain('--no-cache');
    // The epilogue's reason list must stay in step with FireforgeVerdictReason.
    expect(testHelp).toContain('inconclusive|lock-timeout|killed]');
    expect(testHelp).toContain('reason=killed means a signal terminated the run');
  });

  it('exposes the full furnace subcommand set', () => {
    // The per-subcommand flags are pinned by the CLI option inventory
    // snapshot below; this case pins the subcommand set itself so a new
    // subcommand cannot be added (or an old one dropped) unnoticed.
    const program = createProgram();
    const furnace = program.commands.find((command) => command.name() === 'furnace');
    expect(furnace).toBeDefined();

    // Sort subcommands by name so a reordering inside `registerFurnace`
    // does not churn the expected list.
    const subcommands = [...(furnace?.commands ?? [])].sort((left, right) =>
      left.name().localeCompare(right.name())
    );

    // Sanity check: catch the case where a new subcommand is added without
    // also adding a help snapshot by asserting the expected set explicitly.
    const subcommandNames = subcommands.map((command) => command.name());
    expect(subcommandNames).toEqual([
      'apply',
      'chrome-doc',
      'create',
      'deploy',
      'diff',
      'init',
      'list',
      'override',
      'preview',
      'refresh',
      'remove',
      'rename',
      'scan',
      'status',
      'sync',
      'validate',
    ]);
  });

  it('pins the CLI option inventory for every command', () => {
    // A full-text help snapshot re-breaks on every wording tweak and on the
    // terminal-width heuristics in `buildGroupedHelpFormatter`. What is
    // actually a consumer contract is the *set of flags*: an accidentally
    // renamed, removed, or newly shadowed option changes this inventory,
    // while rewrapped prose does not.
    const collect = (command: Command, path: string[]): string[] => {
      const name = [...path, command.name()].join(' ');
      const flags = command.options
        .map((option) => [option.short, option.long].filter(Boolean).join(', '))
        .sort((left, right) => left.localeCompare(right));
      return [
        `${name}: ${flags.join(' | ')}`,
        ...[...command.commands]
          .sort((left, right) => left.name().localeCompare(right.name()))
          .flatMap((child) => collect(child, [...path, command.name()])),
      ];
    };

    expect(collect(createProgram(), []).join('\n')).toMatchSnapshot('cli option inventory');
  });
});
