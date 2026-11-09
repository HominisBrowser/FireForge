// SPDX-License-Identifier: EUPL-1.2
/**
 * Commands a source-mode editing checkout may run that read `engine/`: there
 * `engine/` is at most the pristine donor, so a verdict about what is deployed
 * to it would be wrong. Doctor does not judge a live engine, and the
 * deployed-state queries run in a slot.
 */
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  runGit,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { doctorCommand } from '../doctor.js';
import { furnaceDiffCommand } from '../furnace/diff.js';
import { furnaceValidateCommand } from '../furnace/validate.js';
import { tokenCoverageCommand } from '../token-coverage.js';

const SOURCES = {
  schemaVersion: 1,
  mode: 'authored',
  root: 'src',
  metadataRoot: '.fireforge-sources',
  pristineCommit: 'a'.repeat(40),
} as unknown as NonNullable<FireForgeConfig['sources']>;

const FURNACE = {
  version: 1,
  componentPrefix: 'ff-',
  stock: [],
  overrides: {},
  custom: { 'ff-card': { description: 'card', targetPath: 'toolkit/content/widgets/ff-card' } },
};

describe('source-mode editing checkout', () => {
  let root: string;
  const adapter = process.env['FIREFORGE_ADAPTER_COMMAND'];

  beforeEach(async () => {
    delete process.env['FIREFORGE_ADAPTER_COMMAND'];
    root = await createTempProject('ff-source-queries-');
    await writeFireForgeConfig(root, { sources: SOURCES, test: { reapOrphans: 'owned' } });
    await writeFiles(root, { 'furnace.json': JSON.stringify(FURNACE) });
    await initCommittedRepo(join(root, 'engine'), { 'browser/config/version.txt': '140.9.0\n' });
    await runGit(join(root, 'engine'), ['branch', '-M', 'main']);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (adapter === undefined) delete process.env['FIREFORGE_ADAPTER_COMMAND'];
    else process.env['FIREFORGE_ADAPTER_COMMAND'] = adapter;
    await removeTempProject(root);
  });

  it('doctor does not fail the pristine donor for being on another branch or undeployed', async () => {
    const { checks } = await doctorCommand(root);
    const names = checks.map((check) => check.name);
    for (const live of [
      'Engine branch',
      'Furnace engine state',
      'Furnace component validation',
      'Engine ESLint installed',
      'Watchman available',
    ])
      expect(names).not.toContain(live);
    expect(names).toContain('Engine is git repository');
    expect(
      checks.filter((check) => check.severity === 'error' && /engine/i.test(check.name))
    ).toEqual([]);
  });

  it.each([
    ['token coverage', () => tokenCoverageCommand(root)],
    ['furnace diff', () => furnaceDiffCommand(root)],
    ['furnace validate', () => furnaceValidateCommand(root)],
  ])('%s is judged in a slot, not against the donor', async (_name, run) => {
    await expect(run()).rejects.toThrow(/pristine donor.*fireforge job run --check/s);
  });

  it('a job step may run them: the executor names its command', async () => {
    process.env['FIREFORGE_ADAPTER_COMMAND'] = 'check';
    await expect(tokenCoverageCommand(root)).resolves.toBeUndefined();
  });

  it('a project without sources is unaffected', async () => {
    await writeFireForgeConfig(root);
    await expect(tokenCoverageCommand(root)).resolves.toBeUndefined();
  });
});
