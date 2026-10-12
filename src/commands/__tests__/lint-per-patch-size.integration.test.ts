// SPDX-License-Identifier: EUPL-1.2
/**
 * Size rules under `lint --per-patch`: they measure the working tree (the
 * would-be export), so a tier fires while an edit is still in progress, and
 * the `--report` rows name the patch-size metric they counted in.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getLicenseHeader } from '../../core/license-headers.js';
import { FIREFOX_WORKFLOW_SETUP_OPTIONS } from '../../test-utils/firefox-workflow-fixtures.js';
import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
} from '../../test-utils/index.js';
import type { PatchLintConfig } from '../../types/config.js';
import { lintCommand } from '../lint.js';
import { setupCommand } from '../setup.js';

vi.mock('../../utils/logger.js', () => ({
  isVerbose: vi.fn(() => false),
  isStdoutSealed: vi.fn(() => false),
  setStdoutSealed: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  cancel: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
  note: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  spinner: vi.fn(() => ({ message: vi.fn(), stop: vi.fn(), error: vi.fn() })),
}));

const TEST_FILE = 'browser/base/content/test/tiles/browser_tiles.js';
const MODULE = 'browser/modules/mybrowser/Tiles.sys.mjs';
const HEADER = getLicenseHeader('EUPL-1.2', 'js') + '\n';

function tasks(count: number): string {
  return Array.from({ length: count }, (_, i) => `add_task(async function t${i}() { ok(true); });`)
    .join('\n')
    .concat('\n');
}

describe('lint --per-patch size rules', () => {
  let projectRoot: string;
  let engineDir: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject('fireforge-lint-size-');
    await setupCommand(projectRoot, { ...FIREFOX_WORKFLOW_SETUP_OPTIONS, force: true });
    engineDir = join(projectRoot, 'engine');
    await initCommittedRepo(engineDir, { 'browser/base/content/test/tiles/.gitkeep': '' });
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  async function setPatchLint(patchLint: PatchLintConfig): Promise<void> {
    const path = join(projectRoot, 'fireforge.json');
    const config = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...config, patchLint }, null, 2) + '\n');
  }

  async function writeQueue(files: string[]): Promise<void> {
    await writeFiles(projectRoot, {
      'patches/patches.json': JSON.stringify({
        version: 1,
        patches: [
          {
            filename: '001-ui-tiles.patch',
            order: 1,
            category: 'ui',
            name: 'tiles',
            description: '',
            createdAt: '2026-01-01T00:00:00.000Z',
            sourceEsrVersion: '140.9.0esr',
            filesAffected: files,
          },
        ],
      }),
    });
    await writeFile(join(projectRoot, 'patches', '001-ui-tiles.patch'), '# stub\n');
  }

  async function warnings(): Promise<string[]> {
    const { warn } = await import('../../utils/logger.js');
    return vi.mocked(warn).mock.calls.map((call) => call[0]);
  }

  it('measures an owned file on disk, so the tier fires mid-edit', async () => {
    await writeQueue([TEST_FILE]);
    await writeFiles(engineDir, { [TEST_FILE]: HEADER + tasks(1300) });
    await lintCommand(projectRoot, [], { perPatch: true, maxWarnings: 0 });
    expect((await warnings()).some((line) => line.includes('[file-too-large]'))).toBe(false);

    // The edit grows the file past the test warning tier (1400). Nothing is
    // re-exported: the stored patch is still a stub.
    await writeFiles(engineDir, { [TEST_FILE]: HEADER + tasks(1450) });
    await expect(lintCommand(projectRoot, [], { perPatch: true, maxWarnings: 0 })).rejects.toThrow(
      'exceeding --max-warnings 0'
    );
    expect(
      (await warnings()).some(
        (line) =>
          line.includes('[file-too-large] 001-ui-tiles.patch :: ' + TEST_FILE) &&
          line.includes('Test file has 1451 lines')
      )
    ).toBe(true);
  });

  it('writes the metric into --report rows and counts added code per class', async () => {
    await setPatchLint({
      patchSizeMetric: 'addedCode',
      patchSizeRegistrationFiles: ['moz.build'],
      patchSizeThresholds: { general: { lines: { notice: 10, warning: 20, error: 40 } } },
    });
    const moduleSource =
      HEADER +
      Array.from({ length: 15 }, (_, i) => `/** Doc ${i}. */\nexport const x${i} = ${i};`).join(
        '\n'
      ) +
      '\n';
    await writeQueue([MODULE, TEST_FILE, 'browser/modules/mybrowser/moz.build']);
    await writeFiles(engineDir, {
      [MODULE]: moduleSource,
      [TEST_FILE]: HEADER + tasks(30),
      'browser/modules/mybrowser/moz.build': 'EXTRA_JS_MODULES += ["Tiles.sys.mjs"]\n',
    });
    const reportPath = join(projectRoot, 'report.json');
    await lintCommand(projectRoot, [], { perPatch: true, noCache: true, report: reportPath });

    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      patches: Array<{
        metric: string;
        lineCount: number;
        thresholds: { lines: { notice: number } };
        issues: Array<{ check: string; message: string; severity: string }>;
      }>;
    };
    const row = report.patches[0];
    expect(row?.metric).toBe('addedCode');
    // 15 module code lines + 30 test lines; JSDoc, the header comments and
    // moz.build do not count.
    expect(row?.lineCount).toBe(45);
    expect(row?.thresholds.lines.notice).toBe(10);
    const sizes = row?.issues.filter((issue) => issue.check === 'large-patch-lines') ?? [];
    expect(sizes.map((issue) => [issue.severity, issue.message.split(',')[0]])).toEqual([
      ['notice', 'Patch adds 15 code lines in non-test files'],
    ]);
  });
});
