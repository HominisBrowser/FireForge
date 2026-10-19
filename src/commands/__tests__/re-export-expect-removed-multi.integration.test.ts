// SPDX-License-Identifier: EUPL-1.2
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  readProjectText,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { reExportCommand } from '../re-export.js';

vi.mock('../../utils/logger.js', () => ({
  isVerbose: vi.fn(() => false),
  isStdoutSealed: vi.fn(() => false),
  setStdoutSealed: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  verbose: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  spinner: vi.fn(() => ({ message: vi.fn(), stop: vi.fn(), error: vi.fn() })),
}));

function newFileDiff(path: string, line: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    `+${line}`,
    '',
  ].join('\n');
}

function row(filename: string, order: number, filesAffected: string[]): Record<string, unknown> {
  return {
    filename,
    order,
    category: 'ui',
    name: filename.slice(6, -6),
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected,
  };
}

interface ManifestShape {
  patches: { filename: string; filesAffected: string[] }[];
}

describe('re-export --expect-removed across several selected patches', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject();
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(`${projectRoot}/engine`, { 'a.txt': 'a\n', 'b.txt': 'b\n' });
    await writeFiles(projectRoot, {
      'patches/patches.json': JSON.stringify({
        version: 1,
        patches: [
          row('001-ui-first.patch', 1, ['a.txt', 'one.svg']),
          row('002-ui-second.patch', 2, ['b.txt', 'two.svg']),
        ],
      }),
      'patches/001-ui-first.patch': newFileDiff('one.svg', '<svg/>'),
      'patches/002-ui-second.patch': newFileDiff('two.svg', '<svg/>'),
      'engine/a.txt': 'a\nmore\n',
      'engine/b.txt': 'b\nmore\n',
    });
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('retires each path from its own owner in one run, belts armed', async () => {
    const options = {
      expectRemoved: ['one.svg', 'two.svg'],
      refuseForeignDrift: true,
      refuseAdjacentUnmanaged: true,
      expect: ['a.txt', 'b.txt'],
    };
    await reExportCommand(projectRoot, ['001', '002'], { ...options, dryRun: true });
    await reExportCommand(projectRoot, ['001', '002'], options);
    const manifest = JSON.parse(
      await readProjectText(projectRoot, 'patches/patches.json')
    ) as ManifestShape;
    expect(manifest.patches.map((patch) => patch.filesAffected)).toEqual([['a.txt'], ['b.txt']]);
    expect(await readProjectText(projectRoot, 'patches/001-ui-first.patch')).not.toContain(
      'one.svg'
    );
    expect(await readProjectText(projectRoot, 'patches/002-ui-second.patch')).not.toContain(
      'two.svg'
    );
  });

  it('refuses a path no selected patch owns and names its unselected owner', async () => {
    await expect(
      reExportCommand(projectRoot, ['001'], { expectRemoved: ['one.svg', 'two.svg'] })
    ).rejects.toThrow(/two\.svg .*owned by 002-ui-second\.patch, which this run did not select/);
  });
});
