// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createProgram } from '../../cli.js';
import {
  enforceSourceGuard,
  SOURCE_COMMAND_POLICIES,
  SOURCE_SUBCOMMAND_ACCESS,
} from '../source-guard.js';
import {
  EXECUTOR_REMEDIES,
  executorRemedy,
  LEGACY_REMEDIES,
  legacyRemedy,
} from '../source-remedies.js';

vi.mock('../jobs/guard.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../jobs/guard.js')>()),
  assertExecutorCommand: vi.fn(),
}));

/** Every command chain the policy gives `access`, read from the policy itself. */
function classified(policy: string, access: string): string[] {
  const top = Object.entries(SOURCE_COMMAND_POLICIES)
    .filter(([, value]) => value === policy)
    .map(([command]) => command);
  const nested = Object.entries(SOURCE_SUBCOMMAND_ACCESS).flatMap(([command, leaves]) =>
    Object.entries(leaves)
      .filter(([, value]) => value === access)
      .map(([leaf]) => (leaf === '' ? command : `${command} ${leaf}`))
  );
  return [...top, ...nested];
}

const executorChains = (): string[] => classified('executor', 'executor');

/**
 * Every refused legacy chain: legacy-only commands, refused leaves, and the
 * conditional commands with no leaf table, which refuse by their options.
 */
const legacyChains = (): string[] => [
  ...classified('legacy-only', 'refused'),
  ...Object.entries(SOURCE_COMMAND_POLICIES)
    .filter(
      ([command, policy]) => policy === 'conditional' && !(command in SOURCE_SUBCOMMAND_ACCESS)
    )
    .map(([command]) => command),
];

/** Placeholders a remedy names, as a person would fill them in. */
const FILLED: Readonly<Record<string, string>> = {
  '<path>': 'browser/base/content/test/browser_x.js',
  '<request>': 'request.json',
  '<file>': 'snapshot.json',
  '<name>': 'a',
  '<dir>': '/tmp/fireforge-remedy',
};

/**
 * Parses a command line through the real program without running it: the
 * command chain resolves, every option is one the leaf declares with its value
 * given, and every required argument is there.
 */
function dryParse(line: string): void {
  const words = line.split(' ').map((word) => FILLED[word] ?? word);
  expect(words.shift()).toBe('fireforge');
  let command: Command = createProgram();
  for (;;) {
    const child = command.commands.find((entry) => entry.name() === words[0]);
    if (child === undefined) break;
    command = child;
    words.shift();
  }
  expect(command.commands, `${line} names a command with subcommands`).toEqual([]);
  const parsed = command.parseOptions(words);
  expect(parsed.unknown, line).toEqual([]);
  const required = command.registeredArguments.filter((argument) => argument.required).length;
  expect(parsed.operands.length, line).toBeGreaterThanOrEqual(required);
  for (const option of command.options) {
    const value: unknown = command.getOptionValue(option.attributeName());
    if (option.required && command.getOptionValueSource(option.attributeName()) === 'cli')
      expect(typeof value === 'string' || Array.isArray(value), `${line}: ${option.flags}`).toBe(
        true
      );
  }
  for (const option of command.options.filter((entry) => entry.mandatory))
    expect(
      command.getOptionValue(option.attributeName()),
      `${line}: ${option.flags}`
    ).toBeDefined();
}

describe('what a refused executor command says to run instead', () => {
  it('has an entry for every command the policy classifies as executor or refuses as legacy', () => {
    const executor = executorChains();
    expect(executor.length).toBeGreaterThan(5);
    expect(executor.filter((chain) => EXECUTOR_REMEDIES[chain] === undefined)).toEqual([]);
    const legacy = legacyChains();
    expect(legacy).toEqual(expect.arrayContaining(['download', 'tree create', 'config', 'doctor']));
    expect(legacy.filter((chain) => LEGACY_REMEDIES[chain] === undefined)).toEqual([]);
  });

  it('names commands that parse, each one in the sentence it carries', () => {
    for (const [chain, remedy] of [
      ...Object.entries(EXECUTOR_REMEDIES),
      ...Object.entries(LEGACY_REMEDIES),
    ]) {
      if (remedy.form === 'job run' || remedy.form === 'here')
        expect(remedy.commands.length, chain).toBeGreaterThan(0);
      for (const line of remedy.commands) {
        expect(remedy.detail, chain).toContain(line);
        dryParse(line);
      }
    }
  });

  it('says plainly where no equivalent exists', () => {
    expect(legacyRemedy('watch')).toMatch(/^Use "fireforge job watch": .*on every save/);
    expect(legacyRemedy('furnace scan')).toMatch(/^No source-mode equivalent exists\./);
    expect(legacyRemedy('park')).toContain('Git branch');
    expect(legacyRemedy('patch rename')).toContain('authored export-queue');
    expect(legacyRemedy('source set')).toContain('authored pristine fetch');
    expect(legacyRemedy('furnace future-writer')).toBeUndefined();
  });

  it('points at job run only where job run can do the work', () => {
    expect(executorRemedy('run')).toContain('"fireforge job run --run"');
    expect(executorRemedy('test')).toContain('"fireforge job run --test <path>"');
    expect(executorRemedy('build')).toContain('"fireforge job run --build ui"');
    expect(executorRemedy('package')).toContain('"fireforge job run --release"');
    expect(executorRemedy('check')).toContain('"fireforge job run --check"');
    for (const chain of ['furnace apply', 'furnace deploy', 'furnace sync'])
      expect(executorRemedy(chain)).toMatch(/^A job .* itself: "fireforge job run --test <path>"/);
    expect(executorRemedy('test')).toContain('--coverage, --perf-samples and --keep-log');
    expect(executorRemedy('furnace validate')).toMatch(/^No job form exists for it\./);
    expect(executorRemedy('lint')).toMatch(/^It needs no slot\. Use "fireforge authored lint"/);
    // A command nobody listed says so rather than guessing.
    expect(executorRemedy('mystery')).toMatch(/^No job form exists for it\./);
  });

  it('a dry parse rejects what the program would reject', () => {
    expect(() => {
      dryParse('fireforge job run --bogus');
    }).toThrow();
    expect(() => {
      dryParse('fireforge job submit');
    }).toThrow();
  });
});

describe('the refusal in an editing checkout', () => {
  let directory: string;
  let editor: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fireforge-remedy-'));
    editor = join(directory, 'editor');
    await mkdir(editor);
    await writeFile(
      join(editor, 'fireforge.json'),
      JSON.stringify({ sources: { schemaVersion: 1, mode: 'authored' } })
    );
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const input = (
    subcommands: string[] = [],
    options: Record<string, unknown> = {}
  ): Parameters<typeof enforceSourceGuard>[2] => ({
    subcommands,
    options: { namespace: join(directory, 'jobs'), ...options },
    args: [],
  });

  it('names the working command for each refused one', async () => {
    const said = async (
      command: string,
      subcommands: string[] = [],
      options: Record<string, unknown> = {}
    ): Promise<string> =>
      enforceSourceGuard(editor, command, input(subcommands, options)).then(
        () => '',
        (error: unknown) => (error as Error).message
      );
    expect(await said('run')).toContain(
      'authored-proof-needs-slot: "run" requires an admitted immutable execution slot. Use "fireforge job run --run"'
    );
    expect(await said('test')).toContain('fireforge job run --test <path>');
    expect(await said('package')).toContain('fireforge job run --release');
    expect(await said('furnace', ['apply'])).toContain('fireforge job run --test <path>');
    expect(await said('download')).toContain(
      'source-mode-command-refused: "download" uses legacy mutable engine/queue state. Use "fireforge authored pristine fetch --out <dir>"'
    );
    expect(await said('tree', ['exec'])).toContain('fireforge job run --slot <name>');
    expect(await said('doctor', [], { repairFilesAffected: true })).toContain(
      'fireforge job host-clear'
    );
    expect(await said('furnace', ['future-writer'])).toContain(
      'Use ordinary Git on tracked source'
    );
    expect(await said('furnace', ['validate'], { fix: true })).toContain(
      'No job form exists for it.'
    );
    for (const command of ['run', 'test', 'build', 'check', 'package'])
      expect(await said(command)).not.toContain('Use "job run" from this editing checkout');
  });
});
