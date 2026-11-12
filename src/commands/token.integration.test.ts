// SPDX-License-Identifier: EUPL-1.2
/** `token` through the CLI against a project whose engine is a real git checkout. */
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { runCli } from '../testing/cli.js';
import { initRepo } from '../testing/git.js';
import { readTree, useTempDir, writeTree } from '../testing/temp.js';
import { TOKENS_CSS } from '../testing/tokens.js';

const dir = useTempDir();
const TOKEN_FILE = 'browser/themes/shared/acme-tokens.css';

const CONFIG = {
  name: 'Acme',
  vendor: 'Example Vendor',
  appId: 'org.example.acme',
  binaryName: 'acme',
  firefox: {
    version: '153.7.0esr',
    product: 'firefox-esr',
    sha256: '7f8715ee7de2cf36a156216a9b1c7f26d1653010e65793bb2fce66e12edb6ea0',
    candidate: 'build1',
  },
};

async function tokenFile(): Promise<string> {
  return readFile(join(dir(), 'engine', TOKEN_FILE), 'utf8');
}

beforeEach(async () => {
  await writeTree(dir(), { 'fireforge.json': `${JSON.stringify(CONFIG)}\n` });
  await initRepo(join(dir(), 'engine'), { 'browser/base/content/browser.js': '// upstream\n' });
  await writeTree(join(dir(), 'engine'), { [TOKEN_FILE]: TOKENS_CSS });
});

describe('fireforge token add', () => {
  it('adds a bare name with the default prefix and writes the file', async () => {
    const result = await runCli(
      ['token', 'add', '--category', 'Spacing', '--mode', 'static', 'tight', '2px'],
      { cwd: dir() }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Added --acme-tight to ${TOKEN_FILE}`);
    expect(await tokenFile()).toContain('--acme-tight: 2px; /* static, fork-specific */');
  });

  it('reads the prefix from furnace.json and accepts a --name after the -- separator', async () => {
    await writeTree(dir(), {
      'furnace.json': JSON.stringify({ componentPrefix: 'moz-', tokenPrefix: '--brand-' }),
    });
    const bare = await runCli(
      ['token', 'add', '--category', 'Spacing', '--mode', 'static', 'wide', '3px'],
      { cwd: dir() }
    );
    expect(bare.stdout).toContain('Added --brand-wide');
    const full = await runCli(
      ['token', 'add', '--category', 'Spacing', '--mode', 'static', '--', '--brand-wider', '4px'],
      { cwd: dir() }
    );
    expect(full.exitCode).toBe(0);
    expect(await tokenFile()).toContain('--brand-wider: 4px;');
  });

  it('previews under --dry-run without writing, and reports an existing token as unchanged', async () => {
    const dry = await runCli(
      [
        'token',
        'add',
        '--category',
        'Spacing',
        '--mode',
        'static',
        '--dry-run',
        '--json',
        'tight',
        '2px',
      ],
      { cwd: dir() }
    );
    expect(JSON.parse(dry.stdout)).toMatchObject({
      token: '--acme-tight',
      changed: true,
      dryRun: true,
    });
    expect(await tokenFile()).toBe(TOKENS_CSS);
    const again = await runCli(
      ['token', 'add', '--category', 'Spacing', '--mode', 'static', 'gap', '8px'],
      { cwd: dir() }
    );
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain('already declared in category "Spacing" (line 10); unchanged');
  });

  it('requires --mode and refuses an unknown category with the known ones', async () => {
    const noMode = await runCli(['token', 'add', '--category', 'Spacing', 'x', '1px'], {
      cwd: dir(),
    });
    expect(noMode.exitCode).toBe(8);
    const unknown = await runCli(
      ['token', 'add', '--category', 'Nope', '--mode', 'static', 'x', '1px'],
      { cwd: dir() }
    );
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain('"Colors", "Spacing"');
  });

  it('adds an override to the dark and theme blocks', async () => {
    const result = await runCli(
      [
        'token',
        'add',
        '--category',
        'Colors',
        '--mode',
        'override',
        '--dark-value',
        '#000',
        'tint',
        '#fff',
      ],
      { cwd: dir() }
    );
    expect(result.stdout).toContain('also written to :root[data-theme="dark"]');
    const shown = await runCli(['token', 'show', 'tint'], { cwd: dir() });
    expect(shown.stdout.split('\n').filter(Boolean)).toHaveLength(4);
  });

  it('names the token file when it is missing', async () => {
    await rm(join(dir(), 'engine', TOKEN_FILE));
    const result = await runCli(['token', 'add', '--category', 'A', '--mode', 'static', 'x', '1'], {
      cwd: dir(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Token file not found: ${TOKEN_FILE}`);
  });
});

describe('fireforge token list and show', () => {
  it('lists categories and tokens, optionally one category', async () => {
    const all = await runCli(['token', 'list'], { cwd: dir() });
    expect(all.stdout).toContain(
      'Colors (2)\n  --acme-ink\n  --acme-paper\nSpacing (1)\n  --acme-gap'
    );
    const one = await runCli(['token', 'list', '--category', 'Spacing', '--json'], { cwd: dir() });
    expect((JSON.parse(one.stdout) as { categories: unknown[] }).categories).toHaveLength(1);
    const missing = await runCli(['token', 'list', '--category', 'Nope'], { cwd: dir() });
    expect(missing.exitCode).toBe(1);
  });

  it('shows every block a token is declared in', async () => {
    const result = await runCli(['token', 'show', '--', '--acme-gap'], { cwd: dir() });
    expect(result.stdout).toContain('8px  (:root, line 10)');
    expect(result.stdout).toContain('4px  (:root[data-skin="plain"]');
    expect((await runCli(['token', 'show', 'nothing'], { cwd: dir() })).exitCode).toBe(1);
  });
});

describe('fireforge token lint and coverage', () => {
  it('fails lint on a themed-only token and reports every finding under --json', async () => {
    const clean = await runCli(['token', 'lint'], { cwd: dir() });
    expect(clean.exitCode).toBe(0);
    await writeTree(join(dir(), 'engine'), {
      [TOKEN_FILE]: `${TOKENS_CSS}:root[data-x] {\n  --acme-orphan: 1;\n}\n`,
      'toolkit/a.css': 'a { color: var(--acme-missing); background: #fff; }\n',
    });
    const result = await runCli(['token', 'lint', '--json'], { cwd: dir() });
    expect(result.exitCode).toBe(1);
    const report = JSON.parse(result.stdout) as { findings: { token: string }[] };
    expect(report.findings.map((f) => f.token).sort()).toEqual(['--acme-missing', '--acme-orphan']);
  });

  it('measures coverage of changed stylesheets and fails below --min', async () => {
    await writeTree(join(dir(), 'engine'), {
      'toolkit/a.css': 'a { color: var(--acme-ink); background: #fff; }\n',
    });
    const result = await runCli(['token', 'coverage'], { cwd: dir() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      'toolkit/a.css  tokens 1 | allowlisted 0 | unknown 0 | raw colors 1'
    );
    expect(result.stdout).toContain('Token coverage 50%');
    const strict = await runCli(['token', 'coverage', '--min', '80'], { cwd: dir() });
    expect(strict.exitCode).toBe(1);
    expect(strict.stderr).toContain('below 80%');
  });

  it('leaves the engine untouched', async () => {
    const before = await readTree(join(dir(), 'engine'));
    await runCli(['token', 'lint'], { cwd: dir() });
    await runCli(['token', 'coverage'], { cwd: dir() });
    expect(await readTree(join(dir(), 'engine'))).toEqual(before);
  });
});
