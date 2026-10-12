// SPDX-License-Identifier: EUPL-1.2
/**
 * The built-in test-harness shim declares the mochitest assertion family,
 * so a test that records a known gap with `todo_is`/`todo_isnot` passes the
 * per-test-file checkJs pass. Real TypeScript and real files.
 */
import { rm } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { createTempProject, initCommittedRepo } from '../../test-utils/index.js';
import { runCheckJsTestFilesGrouped } from '../patch-lint-checkjs.js';

const TEST = 'browser/components/demo/test/browser/browser_todo.js';

describe('test-harness shim', () => {
  let root: string;

  beforeEach(async () => {
    root = await createTempProject('ff-harness-shim-');
    await initCommittedRepo(root, {
      [TEST]: [
        'add_task(async function () {',
        '  todo(false, "gap");',
        '  todo_is(1, 2, "known gap");',
        '  todo_isnot(1, 1, "known gap");',
        '  /** @type {number} */',
        '  const wrong = "text";',
        '  info(String(wrong));',
        '});',
        '',
      ].join('\n'),
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('declares todo, todo_is and todo_isnot', async () => {
    const result = await runCheckJsTestFilesGrouped(root, new Set([TEST]), { checkJs: true }, root);
    const messages = (result.byFile.get(TEST) ?? []).map((issue) => issue.message);

    // The deliberate type error proves the file was checked at all.
    expect(messages.some((m) => m.includes("'string' is not assignable"))).toBe(true);
    expect(messages.filter((m) => m.includes('todo'))).toEqual([]);
  });
});
