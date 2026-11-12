// SPDX-License-Identifier: EUPL-1.2
/**
 * The machine contract as documented equals the one declared: the commands
 * `docs/machine-output.md` lists for `--json` and for the verdict line are
 * exactly those whose `defineCommand` says so, and `docs/exit-codes.md`
 * tables exactly the `ExitCode` values.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Command } from '../cli/command.js';
import { ExitCode } from '../kernel/errors.js';
import { REPO_ROOT } from '../testing/script.js';
import { commands } from './index.js';

const doc = (name: string): Promise<string> => readFile(join(REPO_ROOT, 'docs', name), 'utf8');

/** Every runnable command with its full name, in help order. */
function runnable(list: readonly Command[], prefix = 'fireforge'): [string, Command][] {
  return list.flatMap((command): [string, Command][] => {
    const name = `${prefix} ${command.name}`;
    return [
      ...(command.run === undefined ? [] : [[name, command] as [string, Command]]),
      ...runnable(command.subcommands, name),
    ];
  });
}

/** The list between a section's markers, as the documentation writes it. */
function listed(text: string, section: string): string[] {
  const block = new RegExp(`<!-- ${section} -->\\n([\\s\\S]*?)\\n<!-- /${section} -->`).exec(text);
  return (block?.[1] ?? '').split('\n').filter((line) => line.trim() !== '');
}

const declared = (pick: (command: Command) => boolean): string[] =>
  runnable(commands)
    .filter(([, command]) => pick(command))
    .map(([name]) => `- \`${name}\``);

describe('docs/machine-output.md', () => {
  it('lists exactly the commands that declare --json', async () => {
    expect(listed(await doc('machine-output.md'), 'json-commands')).toEqual(
      declared((command) => command.json)
    );
  });

  it('lists exactly the commands that end with a verdict line', async () => {
    expect(listed(await doc('machine-output.md'), 'verdict-commands')).toEqual(
      declared((command) => command.verdict)
    );
  });
});

describe('docs/exit-codes.md', () => {
  it('tables exactly the exit codes of kernel/errors.ts', async () => {
    const rows = [...(await doc('exit-codes.md')).matchAll(/^\| +(\d+) \| `([A-Z_]+)` +\|/gm)];
    expect(Object.fromEntries(rows.map((row) => [row[2], Number(row[1])]))).toEqual(ExitCode);
  });
});
