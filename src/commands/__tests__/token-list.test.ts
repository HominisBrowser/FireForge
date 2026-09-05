// SPDX-License-Identifier: EUPL-1.2
/**
 * `token list` / `token show`: the report that makes `token add --category`
 * usable without hand-parsing a banner out of the tokens CSS. The `--json`
 * arms are pinned against the envelope contract in docs/machine-output.md:
 * exactly one document on stdout, `schemaVersion` first, and a parseable
 * refusal rather than a bare non-zero exit.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn(() => Promise.resolve({ binaryName: 'mybrowser' })),
  getProjectPaths: vi.fn((root: string) => ({ engine: join(root, 'engine') })),
}));
vi.mock('../../core/token-manager.js', () => ({
  getTokensCssPath: vi.fn(() => 'tokens.css'),
}));
vi.mock('../../utils/logger.js', () => createLoggerMock());

import { info, setMachineOutputMode, setStdoutSealed } from '../../utils/logger.js';
import { tokenListCommand, tokenShowCommand } from '../token-list.js';

const TOKENS_CSS = `:root {
  /* = Colors = */
  --mybrowser-canvas: #fff;

  /* = Spacing = */
  --mybrowser-gap: 8px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --mybrowser-canvas: #000;
  }
}
`;

let projectRoot: string;
let stdout: string[];
let restoreStdout: () => void;

beforeEach(async () => {
  vi.clearAllMocks();
  projectRoot = await mkdtemp(join(tmpdir(), 'ff-token-list-'));
  stdout = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown): boolean => {
    stdout.push(String(chunk));
    return true;
  };
  restoreStdout = (): void => {
    process.stdout.write = original;
  };
});

afterEach(async () => {
  restoreStdout();
  await rm(projectRoot, { recursive: true, force: true });
});

/** Seeds `engine/tokens.css` under the temp project. */
async function seedTokens(content = TOKENS_CSS): Promise<void> {
  await mkdir(join(projectRoot, 'engine'), { recursive: true });
  await writeFile(join(projectRoot, 'engine', 'tokens.css'), content);
}

describe('tokenListCommand', () => {
  it('reports every category with its tokens in file order', async () => {
    await seedTokens();
    await tokenListCommand(projectRoot);
    const printed = vi.mocked(info).mock.calls.flat().join('\n');
    expect(printed).toContain('Colors');
    expect(printed).toContain('--mybrowser-canvas');
    expect(printed).toContain('Spacing');
    expect(printed).toContain('--mybrowser-gap');
  });

  it('filters to one category', async () => {
    await seedTokens();
    await tokenListCommand(projectRoot, { category: 'Spacing' });
    const printed = vi.mocked(info).mock.calls.flat().join('\n');
    expect(printed).toContain('--mybrowser-gap');
    expect(printed).not.toContain('--mybrowser-canvas');
  });

  it('refuses an unknown category by naming the ones that exist', async () => {
    // A filter that printed nothing would read as "this category is empty",
    // which is a different fact from "this category does not exist".
    await seedTokens();
    await expect(tokenListCommand(projectRoot, { category: 'Colours' })).rejects.toThrow(
      /Available categories: "Colors", "Spacing"/
    );
  });

  it('--json writes exactly one schemaVersion-first document and seals stdout', async () => {
    await seedTokens();
    await tokenListCommand(projectRoot, { json: true });
    expect(stdout).toHaveLength(1);
    const parsed: unknown = JSON.parse(stdout[0] ?? '');
    expect(Object.keys(parsed as object)[0]).toBe('schemaVersion');
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      categories: [
        { category: 'Colors', tokens: [{ name: '--mybrowser-canvas', value: '#fff' }] },
        { category: 'Spacing', tokens: [{ name: '--mybrowser-gap', value: '8px' }] },
      ],
    });
    expect(setMachineOutputMode).toHaveBeenCalledWith(true);
    expect(setStdoutSealed).toHaveBeenCalledWith(true);
  });

  it('--json emits a parseable refusal instead of a bare non-zero exit', async () => {
    // No tokens.css seeded.
    await expect(tokenListCommand(projectRoot, { json: true })).rejects.toThrow();
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0] ?? '')).toMatchObject({
      schemaVersion: 1,
      code: 'token-list-failed',
    });
  });
});

describe('tokenShowCommand', () => {
  it('names the owning category and every declaring block', async () => {
    await seedTokens();
    await tokenShowCommand(projectRoot, '--mybrowser-canvas');
    const printed = vi.mocked(info).mock.calls.flat().join('\n');
    expect(printed).toContain('category: Colors');
    expect(printed).toContain(':root: #fff');
    expect(printed).toContain('@media (prefers-color-scheme: dark) > :root: #000');
  });

  it('accepts a bare name without the leading --', async () => {
    // Commander reads a leading `--` as an option, so the bare spelling is
    // the one an operator reaches for first.
    await seedTokens();
    await tokenShowCommand(projectRoot, 'mybrowser-gap', { json: true });
    expect(JSON.parse(stdout[0] ?? '')).toMatchObject({ name: '--mybrowser-gap' });
  });

  it('refuses an undeclared token and points at token list', async () => {
    await seedTokens();
    await expect(tokenShowCommand(projectRoot, '--nope')).rejects.toThrow(
      /is not declared .*fireforge token list/s
    );
  });
});
