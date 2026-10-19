// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
import type { PatchMetadata } from '../../types/commands/index.js';
import { info } from '../../utils/logger.js';
import { reExportCommand } from '../re-export.js';
import { planStaleRegistrationDrop } from '../re-export-stale-registrations.js';

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

const STALE = { file: 'jar.mn', line: '  content/gone.mjs (gone.mjs)', creates: 'gone.mjs' };
const LIVE = { file: 'jar.mn', line: '  content/kept.mjs (kept.mjs)', creates: 'kept.mjs' };

function row(
  filename: string,
  order: number,
  filesAffected: string[],
  extra: Partial<PatchMetadata> = {}
): PatchMetadata {
  return {
    filename,
    order,
    category: 'ui',
    name: filename.slice(6, -6),
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected,
    ...extra,
  };
}

interface ManifestShape {
  patches: PatchMetadata[];
}

async function rows(projectRoot: string): Promise<PatchMetadata[]> {
  return (JSON.parse(await readProjectText(projectRoot, 'patches/patches.json')) as ManifestShape)
    .patches;
}

describe('planStaleRegistrationDrop', () => {
  const holder = row('001-ui-jar.patch', 1, ['jar.mn'], {
    stagedDependencies: {
      forwardImports: [
        { file: 'a.mjs', specifier: 'resource:///modules/B.sys.mjs', creates: 'B.sys.mjs' },
      ],
      registrations: [STALE, LIVE],
    },
  });
  const later = row('002-ui-kept.patch', 2, ['kept.mjs']);

  it('drops only registrations whose creates path no patch owns, keeping imports', () => {
    const plan = planStaleRegistrationDrop({ version: 1, patches: [holder, later] }, holder, [
      'jar.mn',
    ]);
    expect(plan?.dropped).toEqual([STALE]);
    expect(plan?.stagedDependencies).toEqual({
      forwardImports: holder.stagedDependencies?.forwardImports,
      registrations: [LIVE],
    });
  });

  it('judges the holder by the file list it will write and returns nothing when all hold', () => {
    const selfCreated = row('001-ui-jar.patch', 1, ['jar.mn', 'gone.mjs'], {
      stagedDependencies: { registrations: [STALE] },
    });
    expect(
      planStaleRegistrationDrop({ version: 1, patches: [selfCreated] }, selfCreated, [
        'jar.mn',
        'gone.mjs',
      ])
    ).toBeUndefined();
    expect(
      planStaleRegistrationDrop({ version: 1, patches: [later] }, later, ['kept.mjs'])
    ).toBeUndefined();
  });
});

describe('re-export drops a staged registration the queue no longer satisfies', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject();
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(join(projectRoot, 'engine'), { 'jar.mn': 'jar\n' });
    await writeFiles(projectRoot, {
      'patches/patches.json': JSON.stringify({
        version: 1,
        patches: [
          row('001-ui-jar.patch', 1, ['jar.mn'], {
            stagedDependencies: { registrations: [STALE] },
          }),
        ],
      }),
      'patches/001-ui-jar.patch': 'diff --git a/jar.mn b/jar.mn\n',
      'engine/jar.mn': 'jar\nmore\n',
    });
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('names the drop in a dry run without writing, then drops and records it', async () => {
    const before = await readProjectText(projectRoot, 'patches/patches.json');
    await reExportCommand(projectRoot, ['001'], { dryRun: true, skipLint: true });
    expect(await readProjectText(projectRoot, 'patches/patches.json')).toBe(before);
    expect(
      vi
        .mocked(info)
        .mock.calls.map((call) => call[0])
        .join('\n')
    ).toContain('would drop staged registration jar.mn "content/gone.mjs (gone.mjs)"');

    await reExportCommand(projectRoot, ['001'], { skipLint: true });
    const [holder] = await rows(projectRoot);
    expect(holder?.stagedDependencies).toBeUndefined();
    const history = await readFile(join(projectRoot, '.fireforge/history.jsonl'), 'utf8');
    expect(history).toContain('"operation":"re-export-staged-prune"');
    expect(history).toContain('"creates":"gone.mjs"');
  });
});
