// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { createProgram } from '../cli.js';

describe('CLI help output', () => {
  it('documents kebab-case setup flags and choice-limited categories', () => {
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
    expect(exportHelp).toContain('"infra"');
  });
});
