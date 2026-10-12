// SPDX-License-Identifier: EUPL-1.2
/**
 * `patch staged-dependency --add --from <json-file>`: a lint report (or a
 * plain list) declares many edges in one call, and every call's history
 * record holds only its delta.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_HISTORY_LOG_PATH } from '../../core/history-log-file.js';
import { buildPatchQueueContext, lintPatchQueue } from '../../core/patch-lint.js';
import { STAGED_DEPENDENCY_REASON_PLACEHOLDER } from '../../core/patch-lint-staged-registration.js';
import { InvalidArgumentError } from '../../errors/base.js';
import {
  createTempProject,
  removeTempProject,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { PatchesManifest, PatchLintIssue, PatchMetadata } from '../../types/commands/index.js';
import { ensureDir } from '../../utils/fs.js';
import * as logger from '../../utils/logger.js';
import { writePerPatchLintReport } from '../lint-report.js';
import { patchStagedDependencyCommand } from '../patch/staged-dependency.js';

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

const MANIFEST = 'browser/alpha/test/browser.toml';
const IMPORTER = 'browser/modules/Importer.sys.mjs';
const LATER = 'browser/modules/Later.sys.mjs';
const FIXTURES = ['browser/alpha/test/file_a.html', 'browser/alpha/test/file_b.html'];
const SUPPORT_LINE = 'support-files = ["file_a.html", "file_b.html"]';

function meta(filename: string, order: number, filesAffected: string[]): PatchMetadata {
  return {
    filename,
    order,
    category: 'ui',
    name: filename.replace(/^\d+-\w+-|\.patch$/g, ''),
    description: '',
    createdAt: '2026-09-05T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected,
  };
}

const PATCHES: Array<{ metadata: PatchMetadata; body: string }> = [
  {
    metadata: meta('102-ui-alpha.patch', 102, [MANIFEST]),
    body: createFileDiff(MANIFEST, ['[DEFAULT]', SUPPORT_LINE, '', '["browser_alpha.js"]']),
  },
  {
    metadata: meta('103-ui-importer.patch', 103, [IMPORTER]),
    body: createFileDiff(IMPORTER, [
      'import { L } from "resource:///modules/Later.sys.mjs";',
      'export const I = L;',
    ]),
  },
  {
    metadata: meta('301-ui-fixtures.patch', 301, [...FIXTURES, LATER]),
    body: [
      ...FIXTURES.map((path) => createFileDiff(path, ['<!doctype html>'])),
      createFileDiff(LATER, ['export const L = 1;']),
    ].join(''),
  },
];

interface HistoryRecord {
  operation: string;
  args: Record<string, unknown>;
}

describe('patch staged-dependency --from', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-psd-from-');
    await writeFireForgeConfig(projectRoot);
    patchesDir = join(projectRoot, 'patches');
    await ensureDir(patchesDir);
    for (const patch of PATCHES) {
      await writeFile(join(patchesDir, patch.metadata.filename), patch.body);
    }
    const manifest: PatchesManifest = { version: 1, patches: PATCHES.map((p) => p.metadata) };
    await writeFile(join(patchesDir, 'patches.json'), JSON.stringify(manifest, null, 2));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempProject(projectRoot);
  });

  const lint = async (): Promise<PatchLintIssue[]> =>
    lintPatchQueue(await buildPatchQueueContext(patchesDir));

  // The fixture module is never registered in a moz.build, which is not
  // what these tests are about.
  const errors = (issues: PatchLintIssue[]): PatchLintIssue[] =>
    issues.filter(
      (issue) => issue.severity === 'error' && issue.check !== 'unregistered-system-module'
    );

  const readHistory = async (): Promise<HistoryRecord[]> =>
    (await readFile(join(patchesDir, '..', DEFAULT_HISTORY_LOG_PATH), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as HistoryRecord);

  const readStaged = async (filename: string): Promise<PatchMetadata['stagedDependencies']> =>
    (
      JSON.parse(await readFile(join(patchesDir, 'patches.json'), 'utf8')) as PatchesManifest
    ).patches.find((patch) => patch.filename === filename)?.stagedDependencies;

  it('prints the --reason placeholder and the structured declarations on each finding', async () => {
    const found = errors(await lint());
    expect(found.map((issue) => issue.check).sort()).toEqual([
      'forward-import',
      'forward-registration',
      'forward-registration',
    ]);
    for (const issue of found) {
      expect(issue.message).toContain(STAGED_DEPENDENCY_REASON_PLACEHOLDER);
      expect(issue.stagedDeclarations).toHaveLength(1);
    }
    expect(found.find((issue) => issue.check === 'forward-import')?.stagedDeclarations).toEqual([
      {
        patch: '103-ui-importer.patch',
        kind: 'import',
        file: IMPORTER,
        specifier: 'resource:///modules/Later.sys.mjs',
        creates: LATER,
        owner: '301-ui-fixtures.patch',
      },
    ]);
  });

  it('applies a lint --report patch by patch and clears every finding in one call each', async () => {
    const reportPath = join(projectRoot, 'report.json');
    await writePerPatchLintReport(reportPath, [], [], {}, await lint());

    await patchStagedDependencyCommand(projectRoot, '102-ui-alpha.patch', {
      add: true,
      from: reportPath,
      reason: 'fixtures land with the tests',
    });
    await patchStagedDependencyCommand(projectRoot, '103-ui-importer', {
      add: true,
      from: reportPath,
    });

    expect(errors(await lint())).toEqual([]);
    expect((await lint()).filter((i) => i.check === 'staged-dependency-unused')).toEqual([]);
    expect((await readStaged('102-ui-alpha.patch'))?.registrations).toHaveLength(2);
    expect((await readStaged('102-ui-alpha.patch'))?.registrations?.[0]?.reason).toBe(
      'fixtures land with the tests'
    );

    const history = await readHistory();
    expect(history).toHaveLength(2);
    expect(history[0]?.args).toMatchObject({ filename: '102-ui-alpha.patch', from: reportPath });
    expect(history[0]?.args).not.toHaveProperty('before');
    expect(history[0]?.args).not.toHaveProperty('after');
    expect((history[0]?.args['added'] as { registrations: unknown[] }).registrations).toHaveLength(
      2
    );
  });

  it('accepts a plain list, skips entries for other patches, and de-duplicates', async () => {
    const listPath = join(projectRoot, 'list.json');
    const declaration = {
      file: MANIFEST,
      line: SUPPORT_LINE,
      creates: FIXTURES[0],
      owner: '301-ui-fixtures.patch',
    };
    await writeFile(
      listPath,
      JSON.stringify([
        declaration,
        { ...declaration },
        { ...declaration, creates: FIXTURES[1], patch: '102-ui-alpha.patch' },
        { ...declaration, patch: '103-ui-importer.patch' },
      ])
    );
    const infos: string[] = [];
    vi.spyOn(logger, 'info').mockImplementation((message: string) => {
      infos.push(message);
    });

    await patchStagedDependencyCommand(projectRoot, '102', { add: true, from: listPath });

    expect((await readStaged('102-ui-alpha.patch'))?.registrations).toHaveLength(2);
    const text = infos.join('\n');
    expect(text).toContain('Skipped 1 declaration(s)');
    expect(text).toContain('added 2 of 3 staged declaration(s)');
    expect(text).toContain('(1 already present or repeated)');
  });

  it('--dry-run reports the batch without writing', async () => {
    const listPath = join(projectRoot, 'list.json');
    await writeFile(
      listPath,
      JSON.stringify([{ file: MANIFEST, line: SUPPORT_LINE, creates: FIXTURES[0] }])
    );
    const before = await readFile(join(patchesDir, 'patches.json'), 'utf8');
    await patchStagedDependencyCommand(projectRoot, '102', {
      add: true,
      from: listPath,
      dryRun: true,
    });
    expect(await readFile(join(patchesDir, 'patches.json'), 'utf8')).toBe(before);
  });

  it('reports an empty batch without writing', async () => {
    const listPath = join(projectRoot, 'list.json');
    await writeFile(listPath, JSON.stringify({ schemaVersion: 1, patches: [], queueIssues: [] }));
    const before = await readFile(join(patchesDir, 'patches.json'), 'utf8');
    await patchStagedDependencyCommand(projectRoot, '102', { add: true, from: listPath });
    expect(await readFile(join(patchesDir, 'patches.json'), 'utf8')).toBe(before);
  });

  it.each([
    ['with --remove', { remove: true }, /--from only applies to --add/],
    ['with --file', { add: true, file: MANIFEST }, /drop --file/],
  ])('refuses --from %s', async (_label, extra, pattern) => {
    const listPath = join(projectRoot, 'list.json');
    await writeFile(listPath, '[]');
    await expect(
      patchStagedDependencyCommand(projectRoot, '102', { ...extra, from: listPath })
    ).rejects.toThrow(pattern);
  });

  it.each([
    ['unreadable JSON', '{nope', /could not be read as JSON/],
    ['a scalar', '42', /must hold a JSON array/],
    ['a non-object entry', '[1]', /entry \[0\] must be an object/],
    [
      'a missing creates',
      JSON.stringify([{ file: 'a/b.js', specifier: 'x' }]),
      /missing "creates"/,
    ],
    [
      'an unknown kind',
      JSON.stringify([{ kind: 'other', file: 'a/b.js', creates: 'a/c.js' }]),
      /kind must be "import" or "registration"/,
    ],
    [
      'an import without a specifier',
      JSON.stringify([{ kind: 'import', file: 'a/b.js', creates: 'a/c.js' }]),
      /needs "specifier"/,
    ],
    [
      'a registration without a line',
      JSON.stringify([{ kind: 'registration', file: 'a/b.js', creates: 'a/c.js' }]),
      /needs "line"/,
    ],
    [
      'an empty string field',
      JSON.stringify([{ file: '', creates: 'a/c.js' }]),
      /non-empty string/,
    ],
  ])('refuses a --from file with %s', async (_label, content, pattern) => {
    const listPath = join(projectRoot, 'list.json');
    await writeFile(listPath, content);
    const call = patchStagedDependencyCommand(projectRoot, '102', { add: true, from: listPath });
    await expect(call).rejects.toBeInstanceOf(InvalidArgumentError);
    await expect(
      patchStagedDependencyCommand(projectRoot, '102', { add: true, from: listPath })
    ).rejects.toThrow(pattern);
  });

  it('logs only the delta for single --add and --remove calls', async () => {
    const declaration = {
      kind: 'import',
      file: IMPORTER,
      specifier: 'resource:///modules/Later.sys.mjs',
      creates: LATER,
      owner: '301-ui-fixtures.patch',
    };
    await patchStagedDependencyCommand(projectRoot, '103', { add: true, ...declaration });
    await patchStagedDependencyCommand(projectRoot, '103', { remove: true, ...declaration });

    const [added, removed] = await readHistory();
    expect(added?.args).toEqual({
      filename: '103-ui-importer.patch',
      mode: 'add',
      kind: 'import',
      added: {
        forwardImports: [
          {
            file: IMPORTER,
            specifier: 'resource:///modules/Later.sys.mjs',
            creates: LATER,
            owner: '301-ui-fixtures.patch',
          },
        ],
      },
    });
    expect(removed?.args).toMatchObject({ mode: 'remove' });
    expect(removed?.args).toHaveProperty('removed.forwardImports');
    expect(removed?.args).not.toHaveProperty('added');
  });
});
