// SPDX-License-Identifier: EUPL-1.2
/**
 * `token lint`: themed-block lockstep and undeclared token references, in
 * the human and `--json` modes.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn(() => Promise.resolve({ binaryName: 'mybrowser' })),
  getProjectPaths: vi.fn((root: string) => ({
    engine: join(root, 'engine'),
    patches: join(root, 'patches'),
  })),
}));
vi.mock('../../core/token-manager.js', () => ({
  getTokensCssPath: vi.fn(() => 'tokens.css'),
}));
vi.mock('../../core/furnace-config.js', () => ({
  furnaceConfigExists: vi.fn(() => Promise.resolve(false)),
  loadFurnaceConfig: vi.fn(),
}));
vi.mock('../../core/patch-manifest.js', () => ({
  loadPatchesManifest: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../../utils/logger.js', () => createLoggerMock());

import { furnaceConfigExists, loadFurnaceConfig } from '../../core/furnace-config.js';
import { loadPatchesManifest } from '../../core/patch-manifest.js';
import type { PatchesManifest } from '../../types/commands/index.js';
import type { FurnaceConfig } from '../../types/furnace.js';
import { info, setStdoutSealed, success, warn } from '../../utils/logger.js';
import { tokenLintCommand } from '../token-lint.js';

const CLEAN_TOKENS = `:root {
  --mybrowser-canvas: #fff;
  --mybrowser-gap: var(--mybrowser-space);
  --mybrowser-space: 8px;
}

@media (prefers-color-scheme: dark) {
  :root {
    --mybrowser-canvas: #000;
    --moz-platform-override: 1px;
  }
}
`;

let projectRoot: string;
let stdout: string[];
let restoreStdout: () => void;

beforeEach(async () => {
  vi.clearAllMocks();
  projectRoot = await mkdtemp(join(tmpdir(), 'ff-token-lint-'));
  await mkdir(join(projectRoot, 'engine', 'browser'), { recursive: true });
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

async function seed(tokens: string, files: Record<string, string> = {}): Promise<void> {
  await writeFile(join(projectRoot, 'engine', 'tokens.css'), tokens);
  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(projectRoot, 'engine', file), content);
  }
  const manifest: PatchesManifest = {
    version: 1,
    patches: [
      {
        filename: '001-ui-a.patch',
        order: 1,
        category: 'ui',
        name: 'a',
        description: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        sourceEsrVersion: '140.9.0esr',
        filesAffected: ['tokens.css', ...Object.keys(files), 'browser/missing.css', 'x.js'],
      },
    ],
  };
  vi.mocked(loadPatchesManifest).mockResolvedValue(manifest);
}

describe('tokenLintCommand', () => {
  it('passes a lockstep token file whose references all resolve', async () => {
    await seed(CLEAN_TOKENS, {
      'browser/panel.css': '.a { --local: 1; gap: var(--mybrowser-gap); width: var(--local); }\n',
    });

    await tokenLintCommand(projectRoot);

    expect(warn).not.toHaveBeenCalled();
    expect(vi.mocked(info).mock.calls.flat().join('\n')).toContain(
      '2 CSS file(s) scanned for --mybrowser-* tokens'
    );
    expect(success).toHaveBeenCalled();
  });

  it('fails on a themed-only token and on an undeclared reference, naming file and line', async () => {
    await seed(
      `${CLEAN_TOKENS}
:root[data-skin="precision"] {
  --mybrowser-canvas: #eee;
  --mybrowser-precision-only: 2px;
}
`,
      {
        'browser/panel.css':
          '/* var(--mybrowser-in-comment) */\n.a {\n  gap: var(--mybrowser-gapp);\n  margin: var(--mybrowser-gapp);\n}\n',
      }
    );

    await expect(tokenLintCommand(projectRoot)).rejects.toThrow('token lint found 2 finding(s).');

    const warnings = vi.mocked(warn).mock.calls.map((call) => call[0]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(
      /^tokens\.css:16 \[token-lockstep\] --mybrowser-precision-only is declared in :root\[data-skin="precision"\] but not in the base :root block/
    );
    expect(warnings[1]).toMatch(
      /^browser\/panel\.css:3 \[token-undeclared\] var\(--mybrowser-gapp\) names a token/
    );
  });

  it('honours the furnace prefix and its allowlisted / runtime names', async () => {
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      tokenPrefix: '--mb-',
      tokenAllowlist: ['--mb-allowed'],
      runtimeVariables: ['--mb-runtime'],
    } as FurnaceConfig);
    await seed(':root {\n  --mb-a: 1px;\n}\n', {
      'browser/panel.css':
        '.a { gap: var(--mb-allowed); top: var(--mb-runtime); left: var(--mybrowser-x); }\n',
    });

    await expect(tokenLintCommand(projectRoot)).resolves.toBeUndefined();
  });

  it('falls back to the default prefix when furnace.json cannot be loaded', async () => {
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
    vi.mocked(loadFurnaceConfig).mockRejectedValue(new Error('broken'));
    await seed(':root {\n  --mybrowser-a: 1px;\n}\n.b { gap: var(--mybrowser-b); }\n');

    await expect(tokenLintCommand(projectRoot)).rejects.toThrow('token lint found 1 finding(s).');
    expect(vi.mocked(warn).mock.calls[0]?.[0]).toContain('Could not load furnace.json');
  });

  it('--json writes the report first, then exits non-zero on findings', async () => {
    await seed(':root {\n  --mybrowser-a: 1px;\n}\n.b { gap: var(--mybrowser-b); }\n');

    await expect(tokenLintCommand(projectRoot, { json: true })).rejects.toThrow(
      'token lint found 1 finding(s).'
    );

    expect(stdout).toHaveLength(1);
    const parsed = JSON.parse(stdout[0] ?? '') as Record<string, unknown>;
    expect(Object.keys(parsed)[0]).toBe('schemaVersion');
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      tokensCssPath: 'tokens.css',
      tokenPrefix: '--mybrowser-',
      filesScanned: 1,
      findings: [
        { check: 'token-undeclared', file: 'tokens.css', line: 4, token: '--mybrowser-b' },
      ],
    });
    expect(setStdoutSealed).toHaveBeenCalledWith(true);
  });

  it('--json passes cleanly, and refuses a missing tokens CSS with an error envelope', async () => {
    await seed(CLEAN_TOKENS);
    await expect(tokenLintCommand(projectRoot, { json: true })).resolves.toBeUndefined();
    expect(JSON.parse(stdout[0] ?? '')).toMatchObject({ findings: [] });

    await rm(join(projectRoot, 'engine', 'tokens.css'));
    stdout = [];
    await expect(tokenLintCommand(projectRoot, { json: true })).rejects.toThrow();
    expect(JSON.parse(stdout[0] ?? '')).toMatchObject({ code: 'token-lint-failed' });
  });
});
