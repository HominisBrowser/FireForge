// SPDX-License-Identifier: EUPL-1.2
/**
 * The per-test-file checkJs pass builds one small program per test script.
 * Those programs share their parsed lib declarations, shim and head.js
 * helpers, and must report exactly what isolated, unshared programs do.
 * Real TypeScript and real files throughout.
 */
import { rm } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { createTempProject, initCommittedRepo } from '../../test-utils/index.js';
import { runCheckJsGrouped, runCheckJsTestFilesGrouped } from '../patch-lint-checkjs.js';
import { TEST_HARNESS_SHIM } from '../typecheck-shim.js';

const TESTS = [
  'browser/components/demo/test/browser/browser_a.js',
  'browser/components/demo/test/browser/browser_b.js',
  'browser/components/demo/test/browser/browser_c.js',
];
const HEAD = 'browser/components/demo/test/browser/head.js';

describe('runCheckJsTestFilesGrouped source-file sharing', () => {
  let root: string;

  beforeEach(async () => {
    root = await createTempProject('ff-checkjs-sharing-');
    await initCommittedRepo(root, {
      [HEAD]: '/** @returns {number} */\nfunction helperCount() {\n  return 1;\n}\n',
      // a: a real error, through the head.js helper's type.
      [TESTS[0] ?? '']: '/** @type {string} */\nvar fromHead = helperCount();\n',
      // b: clean.
      [TESTS[1] ?? '']: 'var total = helperCount() + 1;\n',
      // c: an error of its own.
      [TESTS[2] ?? '']: '/** @type {number} */\nvar wrong = "text";\n',
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('parses TypeScript lib declarations once for the whole pass', async () => {
    const ts = await import('typescript');
    const readFile = vi.spyOn(ts.sys, 'readFile');
    try {
      await runCheckJsTestFilesGrouped(root, new Set([...TESTS, HEAD]), { checkJs: true }, root);
      const libReads = readFile.mock.calls.filter(([path]) => /[/\\]lib\.es5\.d\.ts$/.test(path));
      // One program per test file (four, head.js included); 0.47.1 read
      // and parsed the lib files once per program.
      expect(libReads).toHaveLength(1);
    } finally {
      readFile.mockRestore();
    }
  });

  it('reports exactly what one isolated program per test file reports', async () => {
    const shared = await runCheckJsTestFilesGrouped(
      root,
      new Set([...TESTS, HEAD]),
      { checkJs: true },
      root
    );

    for (const file of [...TESTS, HEAD]) {
      const isolated = await runCheckJsGrouped({
        repoDir: root,
        resolutionOwned: new Set(file === HEAD ? [file] : [file, HEAD]),
        projectRoot: root,
        mode: { strict: false },
        builtinShimSuffix: TEST_HARNESS_SHIM,
      });
      expect(shared.byFile.get(file) ?? []).toEqual(isolated.byFile.get(file) ?? []);
    }
    expect(shared.byFile.get(TESTS[0] ?? '')?.length).toBeGreaterThan(0);
    expect(shared.byFile.get(TESTS[1] ?? '')).toBeUndefined();
    expect(shared.byFile.get(TESTS[2] ?? '')?.length).toBeGreaterThan(0);
  });
});
