// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { createProgram } from '../cli.js';

describe('CLI help output', () => {
  it('documents kebab-case setup flags and configurable categories', () => {
    const program = createProgram();
    const rootHelp = program.helpInformation();
    const setupHelp = program.commands
      .find((command) => command.name() === 'setup')
      ?.helpInformation();
    const exportHelp = program.commands
      .find((command) => command.name() === 'export')
      ?.helpInformation();

    expect(rootHelp).toMatchSnapshot();
    expect(setupHelp).toContain('--app-id <appId>');
    expect(setupHelp).toContain('--binary-name <binaryName>');
    expect(setupHelp).toContain('--firefox-version <version>');
    expect(setupHelp).toContain('--product <product>');
    expect(setupHelp).toContain('"firefox-esr"');
    expect(setupHelp).toContain('"firefox-beta"');
    expect(exportHelp).toContain('--category <category>');
    expect(exportHelp).toContain('Place the new patch at this exact unused order');
    expect(exportHelp).toContain('without renumbering existing patches');
    expect(exportHelp).not.toContain('(choices: "branding", "ui", "privacy", "security", "infra")');
  });

  it('exposes stable help text for every furnace subcommand', () => {
    // Snapshot each `furnace <sub> --help` output so accidental CLI surface
    // changes (renamed flags, dropped descriptions, reshuffled options)
    // break the snapshot instead of silently shipping. The root `furnace`
    // help is covered by `rootHelp` above via the parent program's command
    // list, so we only snapshot the subcommands here.
    const program = createProgram();
    const furnace = program.commands.find((command) => command.name() === 'furnace');
    expect(furnace).toBeDefined();

    // Sort subcommands by name so a reordering inside `registerFurnace`
    // does not churn the snapshot file.
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

    for (const subcommand of subcommands) {
      const help = subcommand.helpInformation();
      expect(help).toMatchSnapshot(`furnace ${subcommand.name()} --help`);
    }
  });

  it('exposes stable help text for patch staged-dependency', () => {
    const program = createProgram();
    const patch = program.commands.find((command) => command.name() === 'patch');
    const moveFiles = patch?.commands.find((command) => command.name() === 'move-files');
    const stagedDependency = patch?.commands.find(
      (command) => command.name() === 'staged-dependency'
    );
    expect(moveFiles).toBeDefined();
    expect(stagedDependency).toBeDefined();
    expect(moveFiles?.helpInformation()).toMatchSnapshot('patch move-files --help');
    expect(stagedDependency?.helpInformation()).toMatchSnapshot('patch staged-dependency --help');
  });
});
