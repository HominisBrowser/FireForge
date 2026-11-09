// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FireForgeConfig } from '../../types/config.js';
import { lintExportedPatch } from '../patch-lint.js';
import type { PatchQueueContext } from '../patch-lint-cross.js';
import { invokePatchLintPrettier } from '../patch-lint-prettier.js';

vi.mock('../patch-lint-prettier.js', () => ({ invokePatchLintPrettier: vi.fn(() => []) }));

const config = {
  name: 'Fixture',
  vendor: 'Example',
  binaryName: 'fixture',
  appId: 'invalid.example.fixture',
  firefox: { version: '153.6.0esr', product: 'firefox-esr', sha256: 'a'.repeat(64) },
  patchLint: { prettier: 'error' },
} as unknown as FireForgeConfig;

function entry(
  filename: string,
  order: number,
  created: string[]
): PatchQueueContext['entries'][number] {
  return {
    filename,
    order,
    metadata: null,
    diff: created
      .map(
        (file) =>
          `diff --git a/${file} b/${file}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,1 @@\n+export const x = 1;\n`
      )
      .join(''),
    newFiles: new Map(created.map((file) => [file, 'export const x = 1;\n'])),
    createdFiles: new Set(created),
    modifiedFileAdditions: new Map(),
  };
}

const queue: PatchQueueContext = {
  entries: [
    entry('001-a.patch', 1, ['modules/a.sys.mjs']),
    entry('002-b.patch', 2, ['modules/b.sys.mjs']),
  ],
};

const diffOf = (file: string): string =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`;

describe('lintExportedPatch prettier scope', () => {
  beforeEach(() => {
    vi.mocked(invokePatchLintPrettier).mockClear();
  });

  it('does not format queue modules for a patch that touches none of them', async () => {
    await lintExportedPatch('/engine', ['other.txt'], diffOf('other.txt'), config, {
      patchQueueCtx: queue,
    });
    const files = vi.mocked(invokePatchLintPrettier).mock.calls.flatMap((call) => call[2]);
    expect(files).toEqual([]);
  });

  it('formats only the owned modules the patch touches', async () => {
    await lintExportedPatch(
      '/engine',
      ['modules/b.sys.mjs', 'other.txt'],
      diffOf('modules/b.sys.mjs'),
      config,
      { patchQueueCtx: queue }
    );
    expect(invokePatchLintPrettier).toHaveBeenCalledTimes(1);
    expect(vi.mocked(invokePatchLintPrettier).mock.calls[0]?.[2]).toEqual(['modules/b.sys.mjs']);
  });
});
