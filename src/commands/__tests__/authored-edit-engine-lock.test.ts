// SPDX-License-Identifier: EUPL-1.2
/**
 * `register`, `wire` and `token add` edit files in engine/ in place, so a run
 * that starts while another command holds the engine-session lock must refuse
 * with the lock message and leave the file as it was. The real lock is used,
 * opted in inside vitest. In source mode the same edits land in the tracked
 * source root, so a held lock does not stop them.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withEngineSessionLock } from '../../core/engine-session-lock.js';
import {
  createTempProject,
  removeTempProject,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { COMMAND_MANIFEST } from '../manifest.js';
import { runUnderEngineLockForAuthoredEdit } from '../with-engine-lock.js';

vi.mock('../../utils/logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/logger.js')>()),
  intro: vi.fn(),
  outro: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

const JAR_MN = [
  'browser.jar:',
  '% content browser %content/browser/',
  '        content/browser/browser-main.js    (content/browser-main.js)',
  '',
].join('\n');
const TOKENS_CSS = ':root {\n  --existing: 1px;\n}\n';

async function run(projectRoot: string, argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  const name = argv[0];
  const entry = COMMAND_MANIFEST.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no manifest entry ${String(name)}`);
  entry.register(program, { getProjectRoot: () => projectRoot, withErrorHandling: (h) => h });
  await program.parseAsync(['node', 'fireforge', ...argv]);
}

describe('register, wire and token add under a held engine-session lock', () => {
  let projectRoot: string;

  beforeEach(async () => {
    vi.stubEnv('FIREFORGE_ENABLE_ENGINE_SESSION_LOCK_IN_TEST', '1');
    projectRoot = await createTempProject();
    await writeFireForgeConfig(projectRoot);
    await writeFiles(join(projectRoot, 'engine'), {
      'browser/base/jar.mn': JAR_MN,
      'browser/base/content/new-widget.js': 'export const widget = true;\n',
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await removeTempProject(projectRoot);
  });

  const cases: Array<{ name: string; argv: string[]; file: string; before: string }> = [
    {
      name: 'register',
      argv: ['register', 'browser/base/content/new-widget.js'],
      file: 'browser/base/jar.mn',
      before: JAR_MN,
    },
    {
      name: 'wire',
      argv: ['wire', 'new-widget'],
      file: 'browser/base/jar.mn',
      before: JAR_MN,
    },
    {
      name: 'token add',
      argv: ['token', 'add', 'x', '1px', '--mode', 'static', '--category', 'Spacing'],
      file: 'browser/themes/shared/fixture-tokens.css',
      before: TOKENS_CSS,
    },
  ];

  it.each(cases)('$name refuses with the lock message and leaves engine/ untouched', async (c) => {
    await writeFiles(join(projectRoot, 'engine'), { [c.file]: c.before });
    await withEngineSessionLock(projectRoot, 'holder', async () => {
      await expect(run(projectRoot, c.argv)).rejects.toThrow(
        /Another FireForge engine-mutating command is already running/
      );
    });
    expect(await readFile(join(projectRoot, 'engine', c.file), 'utf8')).toBe(c.before);
  });

  it('runs the edit once the lock is free', async () => {
    await run(projectRoot, ['register', 'browser/base/content/new-widget.js']);
    expect(await readFile(join(projectRoot, 'engine/browser/base/jar.mn'), 'utf8')).toContain(
      'new-widget.js'
    );
  });

  it('does not take the lock in source mode, where engine/ is not written', async () => {
    await writeFireForgeConfig(projectRoot, {
      test: { reapOrphans: 'owned' },
      sources: {
        schemaVersion: 1,
        mode: 'authored',
        root: 'src',
        metadataRoot: '.fireforge-sources',
        pristineCommit: 'a'.repeat(40),
      },
    });
    const operation = vi.fn(() => Promise.resolve('ran'));
    await withEngineSessionLock(projectRoot, 'holder', async () => {
      await expect(
        runUnderEngineLockForAuthoredEdit(projectRoot, 'register', {}, operation)
      ).resolves.toBe('ran');
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
