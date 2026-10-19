// SPDX-License-Identifier: EUPL-1.2
/**
 * A move that leaves a shared manifest's lines dangling writes every
 * declaration it proposes into one report, and the one `--from` call that
 * report names discharges them all, so the move then goes through.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  setInteractiveMode,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { PatchesManifest, PatchLintIssue, PatchMetadata } from '../../types/commands/index.js';
import { ensureDir } from '../../utils/fs.js';
import * as logger from '../../utils/logger.js';
import { withDeclarationsReport, writeDeclarationsReport } from '../declarations-report.js';
import { patchMoveFilesCommand } from '../patch/move-files.js';
import { splitDeclarationRenamer } from '../patch/split-plan.js';
import { patchStagedDependencyCommand } from '../patch/staged-dependency.js';

const MANIFEST = 'browser/t/test/browser.toml';
const ONE = 'browser/t/test/file_one.html';
const TWO = 'browser/t/test/file_two.html';
const OTHER = 'browser/t/other.js';
const MANIFEST_LINES = [
  '[DEFAULT]',
  'support-files = [',
  '  "file_one.html",',
  '  "file_two.html",',
  ']',
  '',
  '["browser_t.js"]',
];

function createFileDiff(path: string, lines: readonly string[]): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

function meta(filename: string, order: number, filesAffected: string[]): PatchMetadata {
  return {
    filename,
    order,
    category: 'ui',
    name: filename.replace(/^\d+-\w+-|\.patch$/g, ''),
    description: 'd',
    createdAt: '2026-10-19T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected,
  };
}

describe('one --from-ready declaration report', () => {
  let projectRoot: string;
  let restoreTTY: () => void = () => undefined;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-decl-report-');
    await writeFireForgeConfig(projectRoot);
    restoreTTY = setInteractiveMode(false);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    restoreTTY();
    vi.restoreAllMocks();
    await removeTempProject(projectRoot);
  });

  it('writes nothing for findings that propose no declaration', async () => {
    const issue: PatchLintIssue = {
      check: 'forward-import',
      file: 'a.mjs',
      message: 'm',
      severity: 'error',
    };
    await expect(writeDeclarationsReport(projectRoot, [issue])).resolves.toBeUndefined();
    await expect(
      withDeclarationsReport(null, { projectRoot, regressions: [issue] })
    ).resolves.toBeNull();
    const conflicts = { reason: 'r', details: ['d'] };
    await expect(
      withDeclarationsReport(conflicts, { projectRoot, regressions: [issue] })
    ).resolves.toBe(conflicts);
  });

  it('maps a split projection back onto the current queue names', () => {
    const rename = splitDeclarationRenamer({
      placement: {
        newFilename: '006-ui-new.patch',
        renameMap: new Map([['006-ui-old.patch', { newFilename: '007-ui-old.patch' }]]),
      },
    } as unknown as Parameters<typeof splitDeclarationRenamer>[0]);
    const base = { kind: 'registration' as const, file: 'f', line: 'l', creates: 'c' };
    expect(rename({ ...base, patch: '007-ui-old.patch', owner: '006-ui-new.patch' })).toEqual({
      ...base,
      patch: '006-ui-old.patch',
    });
    expect(rename({ ...base, patch: '001-ui-a.patch', owner: '007-ui-old.patch' })).toEqual({
      ...base,
      patch: '001-ui-a.patch',
      owner: '006-ui-old.patch',
    });
  });

  it('move-files names one --from call that discharges every dangling manifest line', async () => {
    const engineDir = join(projectRoot, 'engine');
    const patchesDir = join(projectRoot, 'patches');
    await initCommittedRepo(engineDir, { 'README.txt': 'engine\n' });
    await writeFiles(engineDir, {
      [MANIFEST]: `${MANIFEST_LINES.join('\n')}\n`,
      [ONE]: '<!doctype html>\n',
      [TWO]: '<!doctype html>\n',
      [OTHER]: 'export {};\n',
    });
    await ensureDir(patchesDir);
    await writeFile(
      join(patchesDir, '101-ui-tests.patch'),
      [
        createFileDiff(MANIFEST, MANIFEST_LINES),
        createFileDiff(ONE, ['<!doctype html>']),
        createFileDiff(TWO, ['<!doctype html>']),
      ].join('')
    );
    await writeFile(join(patchesDir, '301-ui-later.patch'), createFileDiff(OTHER, ['export {};']));
    const manifest: PatchesManifest = {
      version: 1,
      patches: [
        meta('101-ui-tests.patch', 101, [MANIFEST, ONE, TWO]),
        meta('301-ui-later.patch', 301, [OTHER]),
      ],
    };
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));

    const reportPath = join(projectRoot, 'declarations.json');
    const info = vi.spyOn(logger, 'info');
    const move = (): Promise<void> =>
      patchMoveFilesCommand(projectRoot, '101', '301', {
        file: [ONE, TWO],
        yes: true,
        skipLint: true,
        declarationsOut: reportPath,
      });

    await expect(move()).rejects.toThrow(/Refusing to run "patch-move-files"/);
    const printed = info.mock.calls.map((call) => call[0]).join('\n');
    expect(printed).toContain(`All 2 declaration(s) this refusal proposes are in ${reportPath}`);
    expect(printed).toContain(
      `fireforge patch staged-dependency 101-ui-tests.patch --add --from ${reportPath}`
    );
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as {
      queueIssues: { check: string; stagedDeclarations: { creates: string }[] }[];
    };
    expect(
      report.queueIssues.flatMap((issue) => issue.stagedDeclarations.map((d) => d.creates)).sort()
    ).toEqual([ONE, TWO]);

    await patchStagedDependencyCommand(projectRoot, '101', {
      add: true,
      from: reportPath,
      reason: 'fixtures move to the later patch',
    });
    await move();
    const after = JSON.parse(
      await readFile(join(patchesDir, 'patches.json'), 'utf8')
    ) as PatchesManifest;
    expect(after.patches.find((p) => p.order === 301)?.filesAffected).toEqual(
      expect.arrayContaining([ONE, TWO])
    );
  });
});
