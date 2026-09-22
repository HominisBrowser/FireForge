// SPDX-License-Identifier: EUPL-1.2
/**
 * `filesMeasuredByFileTooLarge` is the `file-too-large` rule's own
 * predicate: exactly the files the rule size-checks in a real lint run.
 */
import { rm } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { filesMeasuredByFileTooLarge as fromPublicApi } from '../../index.js';
import { createTempProject, writeFiles } from '../../test-utils/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { filesMeasuredByFileTooLarge, lintExportedPatch } from '../patch-lint.js';

const BIG = Array.from({ length: 1000 }, (_, i) => `const x${i} = ${i};`).join('\n') + '\n';

function newFile(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    '+const x0 = 0;',
    '',
  ].join('\n');
}

function modified(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    '--- a/' + path,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    '-old',
    '+const x0 = 0;',
    '',
  ].join('\n');
}

describe('filesMeasuredByFileTooLarge', () => {
  let root: string;

  beforeEach(async () => {
    root = await createTempProject('ff-file-too-large-');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('is exactly the set of files the rule measures', async () => {
    const created = 'browser/modules/Big.sys.mjs';
    const createdCss = 'browser/themes/shared/big.css';
    const changed = 'browser/modules/Existing.sys.mjs';
    await writeFiles(root, { [created]: BIG, [createdCss]: BIG, [changed]: BIG });
    const diff = newFile(created) + newFile(createdCss) + modified(changed);

    const measured = filesMeasuredByFileTooLarge(diff);
    expect([...measured]).toEqual([created]);
    expect(fromPublicApi).toBe(filesMeasuredByFileTooLarge);

    const issues = await lintExportedPatch(root, [created, createdCss, changed], diff, {
      name: 'T',
      vendor: 'T',
      appId: 'org.t.t',
      binaryName: 't',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    } satisfies FireForgeConfig);
    const sized = issues.filter((issue) => issue.check === 'file-too-large').map((i) => i.file);
    // Every file the lint sized is in the predicate, and nothing else.
    expect(sized).toEqual([...measured]);
  });
});
