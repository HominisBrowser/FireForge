// SPDX-License-Identifier: EUPL-1.2
/**
 * `re-export`'s lock-free argument checks.
 *
 * An empty patch argument from an unquoted `"$@"` was reported only after a
 * quarter-hour in the engine-lock queue, a changed-file path passed as a
 * positional read as an unknown patch with no pointer at `--expect`, and a
 * path flag left without a value took the next flag (`--dry-run`) as its
 * path, so a "dry run" wrote. These pin that each is refused before the
 * lock is queued for, with a message naming the actual mistake.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import type { CommandContext } from '../../types/cli.js';
import { preflightReExportArguments, readPathListFile } from '../re-export-preflight.js';
import { registerReExport } from '../re-export-register.js';

const withEngineSessionLock = vi.hoisted(() => vi.fn());
vi.mock('../../core/engine-session-lock.js', () => ({ withEngineSessionLock }));

const OWNED = 'browser/base/content/browser.js';
const OTHER = 'browser/base/content/other.js';
const CLEAN = 'browser/base/content/clean.js';

describe('preflightReExportArguments', () => {
  let projectRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await createTempProject('ff-reexport-preflight-');
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(join(projectRoot, 'engine'), {
      [OWNED]: 'a\n',
      [OTHER]: 'a\n',
      [CLEAN]: 'a\n',
    });
    await writeFiles(projectRoot, {
      'patches/patches.json': `${JSON.stringify(
        {
          version: 1,
          patches: [
            {
              filename: '001-ui-shell.patch',
              order: 1,
              category: 'ui',
              name: 'shell',
              description: '',
              createdAt: '2026-01-01T00:00:00.000Z',
              sourceEsrVersion: '140.9.0esr',
              filesAffected: [OWNED],
            },
          ],
        },
        null,
        2
      )}\n`,
    });
    await writeFiles(join(projectRoot, 'engine'), {
      [OWNED]: 'a\nb\n',
      [OTHER]: 'a\nb\n',
      'browser/base/content/new.js': 'new\n',
    });
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('accepts a resolvable patch and changed flag paths', async () => {
    await expect(
      preflightReExportArguments(projectRoot, ['001'], {
        refuseForeignDrift: true,
        expect: [OWNED, `engine/${OTHER}`],
        refuseAdjacentUnmanaged: true,
        expectUnmanaged: ['browser/base/content/new.js'],
      })
    ).resolves.toBeUndefined();
  });

  it('refuses an empty patch argument and names the likely cause', async () => {
    await expect(preflightReExportArguments(projectRoot, ['001', ''], {})).rejects.toThrow(
      /1 empty patch argument\(s\).*unquoted "\$@"/
    );
  });

  it('refuses an unknown patch name with the usual suggestions', async () => {
    await expect(preflightReExportArguments(projectRoot, ['shel'], {})).rejects.toThrow(/shel/);
  });

  it('says so when a positional is an engine file, and points at --expect and --expect-from', async () => {
    await expect(
      preflightReExportArguments(projectRoot, ['001', OTHER], { refuseForeignDrift: true })
    ).rejects.toThrow(
      `"${OTHER}" is a file in engine/, not a patch. re-export takes patch identifiers as ` +
        `positionals. To name a file whose drift this run expects, pass --expect ${OTHER}`
    );
  });

  it('skips positional resolution under --all', async () => {
    await expect(
      preflightReExportArguments(projectRoot, ['anything'], { all: true })
    ).resolves.toBeUndefined();
  });

  it('resolves positionals beside --scan-files and refuses an unknown one', async () => {
    await expect(
      preflightReExportArguments(projectRoot, ['shel'], {
        scan: true,
        scanFilesManifest: 'assignments.json',
      })
    ).rejects.toThrow(/shel/);
    await expect(
      preflightReExportArguments(projectRoot, ['001'], {
        scan: true,
        scanFilesManifest: 'assignments.json',
      })
    ).resolves.toBeUndefined();
  });

  it('runs the option-combination checks before the lock', async () => {
    await expect(
      preflightReExportArguments(projectRoot, ['001'], { expect: ['--dry-run'] })
    ).rejects.toThrow('--expect was given "--dry-run"');
  });

  it('refuses a flag path that names no changed file', async () => {
    await expect(
      preflightReExportArguments(projectRoot, ['001'], {
        refuseForeignDrift: true,
        expect: [OWNED, CLEAN, 'browser/base/content/typo.js'],
      })
    ).rejects.toThrow(
      `--expect names no changed file in engine/: ${CLEAN}, browser/base/content/typo.js.`
    );
  });

  it('refuses an --expect-new path a patch already owns', async () => {
    await expect(
      preflightReExportArguments(projectRoot, ['001'], {
        refuseAdjacentUnmanaged: true,
        expectNew: [OWNED],
      })
    ).rejects.toThrow(
      `--expect-new names a file a patch already owns: ${OWNED} (001-ui-shell.patch)`
    );
  });

  it('checks a --scan-file path behind a patch qualifier', async () => {
    await expect(
      preflightReExportArguments(projectRoot, ['001'], {
        scan: true,
        scanFiles: ['001:browser/base/content/new.js'],
      })
    ).resolves.toBeUndefined();
    await expect(
      preflightReExportArguments(projectRoot, ['001'], {
        scan: true,
        scanFiles: ['001:browser/base/content/missing.js'],
      })
    ).rejects.toThrow('--scan-file names no changed file in engine/');
  });

  it('leaves a missing manifest to the locked run', async () => {
    await writeFiles(projectRoot, { 'patches/patches.json': '{"version":1,"patches":[]}\n' });
    await expect(preflightReExportArguments(projectRoot, ['001'], {})).resolves.toBeUndefined();
  });

  it('leaves an engine that is not a git checkout to the locked run', async () => {
    const bare = await createTempProject('ff-reexport-preflight-bare-');
    try {
      await writeFireForgeConfig(bare);
      await writeFiles(bare, {
        'patches/patches.json': await readFile(join(projectRoot, 'patches/patches.json'), 'utf8'),
        'engine/README': 'x\n',
      });
      await expect(
        preflightReExportArguments(bare, ['001'], {
          refuseForeignDrift: true,
          expect: [OWNED],
        })
      ).resolves.toBeUndefined();
    } finally {
      await removeTempProject(bare);
    }
  });
});

describe('readPathListFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createTempProject('ff-path-list-');
  });

  afterEach(async () => {
    await removeTempProject(dir);
  });

  it('reads one path per line, skipping blank lines and # comments', async () => {
    await writeFiles(dir, {
      'list.txt': `# changed files\n${OWNED}\n\n  ${OTHER}  \r\n# trailing\n`,
    });
    await expect(readPathListFile(join(dir, 'list.txt'), '--expect-from')).resolves.toEqual([
      OWNED,
      OTHER,
    ]);
  });

  it('refuses an unreadable file', async () => {
    await expect(readPathListFile(join(dir, 'missing.txt'), '--expect-from')).rejects.toThrow(
      /--expect-from could not read/
    );
  });

  it('refuses a list with no paths', async () => {
    await writeFiles(dir, { 'empty.txt': '# nothing\n\n' });
    await expect(readPathListFile(join(dir, 'empty.txt'), '--expect-from')).rejects.toThrow(
      /lists no paths/
    );
  });
});

describe('re-export registration', () => {
  let projectRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await createTempProject('ff-reexport-register-');
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(join(projectRoot, 'engine'), { [OWNED]: 'a\n' });
    await writeFiles(projectRoot, {
      'patches/patches.json': `${JSON.stringify({
        version: 1,
        patches: [
          {
            filename: '001-ui-shell.patch',
            order: 1,
            category: 'ui',
            name: 'shell',
            description: '',
            createdAt: '2026-01-01T00:00:00.000Z',
            sourceEsrVersion: '140.9.0esr',
            filesAffected: [OWNED],
          },
        ],
      })}\n`,
    });
    await writeFiles(join(projectRoot, 'engine'), { [OWNED]: 'a\nb\n' });
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  function program(): Command {
    const root = new Command().exitOverride();
    const context: CommandContext = {
      getProjectRoot: () => projectRoot,
      withErrorHandling:
        <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
        (...args: A) =>
          fn(...args),
    };
    registerReExport(root, context);
    return root;
  }

  it('refuses an empty patch argument without queueing for the engine lock', async () => {
    await expect(program().parseAsync(['node', 'fireforge', 're-export', ''])).rejects.toThrow(
      /empty patch argument/
    );
    expect(withEngineSessionLock).not.toHaveBeenCalled();
  });

  it('merges --expect-from into --expect and queues once the arguments check out', async () => {
    await writeFiles(projectRoot, { 'expect.txt': `# mine\n${OWNED}\n` });
    withEngineSessionLock.mockResolvedValue(undefined);

    await program().parseAsync([
      'node',
      'fireforge',
      're-export',
      '001',
      '--refuse-foreign-drift',
      '--expect-from',
      join(projectRoot, 'expect.txt'),
    ]);

    expect(withEngineSessionLock).toHaveBeenCalledTimes(1);
  });

  it('refuses a --expect-from path that names no changed file before the lock', async () => {
    await writeFiles(projectRoot, { 'expect.txt': 'browser/base/content/typo.js\n' });

    await expect(
      program().parseAsync([
        'node',
        'fireforge',
        're-export',
        '001',
        '--refuse-foreign-drift',
        '--expect-from',
        join(projectRoot, 'expect.txt'),
      ])
    ).rejects.toThrow('--expect names no changed file in engine/: browser/base/content/typo.js');
    expect(withEngineSessionLock).not.toHaveBeenCalled();
  });
});
