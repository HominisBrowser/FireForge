// SPDX-License-Identifier: EUPL-1.2
/**
 * `furnace chrome-doc remove` — the absent/failing half.
 *
 * The command sat at 86.1% line but **51.2% branch, the worst in the repo**.
 * The two existing round-trip cases in `chrome-doc.test.ts` only ever exercise
 * the happy path where every source file and every jar entry is present; every
 * "already gone", "refuses", "cancelled", and "rollback" arm was dark. Those
 * are the arms that matter on a destructive command that deletes engine
 * sources and rewrites three jar manifests.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as config from '../../../core/config.js';
import * as furnaceOperation from '../../../core/furnace-operation.js';
import * as furnaceRollback from '../../../core/furnace-rollback.js';
import { setInteractiveMode } from '../../../test-utils/index.js';
import { ensureDir, pathExists, writeText } from '../../../utils/fs.js';
import { furnaceChromeDocCreateCommand } from '../chrome-doc.js';
import { furnaceChromeDocRemoveCommand } from '../chrome-doc-remove.js';

vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clack/prompts')>()),
  confirm: vi.fn(),
}));

// `isCancel` is FireForge's wrapper in utils/logger.js, not clack's export,
// and clack does not publish its cancel sentinel — so the Ctrl+C arm is
// reached by making the wrapper report a cancellation once.
vi.mock('../../../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/logger.js')>();
  return { ...actual, isCancel: vi.fn(actual.isCancel) };
});

import { confirm } from '@clack/prompts';

import { isCancel } from '../../../utils/logger.js';

const JAR_FILES = [
  'browser/base/jar.mn',
  'browser/themes/shared/jar.inc.mn',
  'browser/locales/jar.mn',
] as const;

describe('furnaceChromeDocRemoveCommand — absent, refused, and failing paths', () => {
  let projectRoot: string;
  let engineDir: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await mkdtemp(join(tmpdir(), 'ff-chrome-doc-rm-'));
    engineDir = join(projectRoot, 'engine');
    vi.spyOn(config, 'loadConfig').mockResolvedValue({
      binaryName: 'mybrowser',
      name: 'MyBrowser',
      vendor: 'Vendor',
      appId: 'com.vendor.mybrowser',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
      license: 'MPL-2.0',
    } as never);
  });

  afterEach(async () => {
    restoreTTY?.();
    restoreTTY = undefined;
    await rm(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /** Builds the engine skeleton the create command needs. */
  async function scaffoldEngine(): Promise<void> {
    await ensureDir(join(engineDir, 'browser/base/content'));
    await ensureDir(join(engineDir, 'browser/themes/shared'));
    await ensureDir(join(engineDir, 'browser/locales/en-US/browser'));
    for (const file of JAR_FILES) {
      await writeText(join(engineDir, file), '# header\n');
    }
  }

  it('refuses when the engine directory does not exist', async () => {
    await expect(
      furnaceChromeDocRemoveCommand(projectRoot, 'mybrowser', { yes: true })
    ).rejects.toThrow(/Engine directory not found\. Run "fireforge download" first/);
  });

  it('refuses an invalid chrome-doc name before touching the engine', async () => {
    await scaffoldEngine();
    await expect(
      furnaceChromeDocRemoveCommand(projectRoot, '../escape', { yes: true })
    ).rejects.toThrow();
    // The jar files must be untouched.
    expect(await readFile(join(engineDir, 'browser/base/jar.mn'), 'utf8')).toBe('# header\n');
  });

  it('throws when a required jar file is missing, before deleting anything', async () => {
    await scaffoldEngine();
    await furnaceChromeDocCreateCommand(projectRoot, 'mybrowser');
    await rm(join(engineDir, 'browser/locales/jar.mn'));

    await expect(
      furnaceChromeDocRemoveCommand(projectRoot, 'mybrowser', { yes: true })
    ).rejects.toThrow(/Required jar file .*browser\/locales\/jar\.mn does not exist/);

    // The refusal comes from plan construction, so no source file is deleted
    // and the surviving jar files keep their entries.
    expect(await pathExists(join(engineDir, 'browser/base/content/mybrowser.xhtml'))).toBe(true);
    expect(await readFile(join(engineDir, 'browser/base/jar.mn'), 'utf8')).toContain('mybrowser');
  });

  it('is idempotent: a second remove reports zero files and zero jar entries', async () => {
    await scaffoldEngine();
    await furnaceChromeDocCreateCommand(projectRoot, 'mybrowser');
    await furnaceChromeDocRemoveCommand(projectRoot, 'mybrowser', { yes: true });

    // Every source file is already gone and no jar file still holds the entry,
    // so both "already absent" arms run. It must not throw.
    await expect(
      furnaceChromeDocRemoveCommand(projectRoot, 'mybrowser', { yes: true })
    ).resolves.toBeUndefined();

    for (const file of JAR_FILES) {
      expect(await readFile(join(engineDir, file), 'utf8')).not.toContain('mybrowser');
    }
  });

  it('preserves the shared xpcshell parent when another doc still has tests', async () => {
    await scaffoldEngine();
    await furnaceChromeDocCreateCommand(projectRoot, 'mybrowser', { withTests: true });
    await furnaceChromeDocCreateCommand(projectRoot, 'otherdoc', { withTests: true });

    await furnaceChromeDocRemoveCommand(projectRoot, 'mybrowser', { yes: true });

    const xpcshellParent = join(engineDir, 'browser/base/content/test/mybrowser-xpcshell');
    expect(await pathExists(join(xpcshellParent, 'mybrowser'))).toBe(false);
    // The parent is NOT empty — otherdoc still lives there — so it stays.
    expect(await pathExists(xpcshellParent)).toBe(true);
    expect(await pathExists(join(xpcshellParent, 'otherdoc'))).toBe(true);
  });

  it('removes the shared xpcshell parent once it is empty', async () => {
    await scaffoldEngine();
    await furnaceChromeDocCreateCommand(projectRoot, 'mybrowser', { withTests: true });
    await furnaceChromeDocRemoveCommand(projectRoot, 'mybrowser', { yes: true });

    expect(await pathExists(join(engineDir, 'browser/base/content/test/mybrowser-xpcshell'))).toBe(
      false
    );
  });

  describe('confirmation gate', () => {
    it('refuses non-interactively without --yes', async () => {
      await scaffoldEngine();
      await furnaceChromeDocCreateCommand(projectRoot, 'mybrowser');
      restoreTTY = setInteractiveMode(false);

      await expect(furnaceChromeDocRemoveCommand(projectRoot, 'mybrowser')).rejects.toThrow(
        /Cannot remove chrome-doc "mybrowser" in non-interactive mode without --yes flag/
      );
      expect(await pathExists(join(engineDir, 'browser/base/content/mybrowser.xhtml'))).toBe(true);
    });

    it('removes when the interactive prompt is confirmed', async () => {
      await scaffoldEngine();
      await furnaceChromeDocCreateCommand(projectRoot, 'mybrowser');
      restoreTTY = setInteractiveMode(true);
      vi.mocked(confirm).mockResolvedValue(true);

      await furnaceChromeDocRemoveCommand(projectRoot, 'mybrowser');

      expect(confirm).toHaveBeenCalledWith({
        message: 'Remove chrome document "mybrowser" and its scaffolded registrations?',
      });
      expect(await pathExists(join(engineDir, 'browser/base/content/mybrowser.xhtml'))).toBe(false);
    });

    it('writes nothing when the prompt is answered no', async () => {
      await scaffoldEngine();
      await furnaceChromeDocCreateCommand(projectRoot, 'mybrowser');
      restoreTTY = setInteractiveMode(true);
      vi.mocked(confirm).mockResolvedValue(false);

      await furnaceChromeDocRemoveCommand(projectRoot, 'mybrowser');

      expect(await pathExists(join(engineDir, 'browser/base/content/mybrowser.xhtml'))).toBe(true);
      expect(await readFile(join(engineDir, 'browser/base/jar.mn'), 'utf8')).toContain('mybrowser');
    });

    it('writes nothing when the prompt is cancelled with Ctrl+C', async () => {
      await scaffoldEngine();
      await furnaceChromeDocCreateCommand(projectRoot, 'mybrowser');
      restoreTTY = setInteractiveMode(true);
      // A cancelled prompt is a distinct arm from a plain `false` answer:
      // clack returns its symbol sentinel rather than a boolean.
      vi.mocked(confirm).mockResolvedValue(Symbol('clack:cancel'));
      vi.mocked(isCancel).mockReturnValueOnce(true);

      await furnaceChromeDocRemoveCommand(projectRoot, 'mybrowser');

      expect(await pathExists(join(engineDir, 'browser/base/content/mybrowser.xhtml'))).toBe(true);
    });
  });

  describe('dry run', () => {
    it('marks entries "not present" when nothing was ever created', async () => {
      await scaffoldEngine();
      await expect(
        furnaceChromeDocRemoveCommand(projectRoot, 'mybrowser', { dryRun: true })
      ).resolves.toBeUndefined();
      // Nothing written.
      expect(await readFile(join(engineDir, 'browser/base/jar.mn'), 'utf8')).toBe('# header\n');
    });

    it('does not require --yes and never prompts', async () => {
      await scaffoldEngine();
      await furnaceChromeDocCreateCommand(projectRoot, 'mybrowser');
      restoreTTY = setInteractiveMode(false);

      await furnaceChromeDocRemoveCommand(projectRoot, 'mybrowser', { dryRun: true });

      expect(confirm).not.toHaveBeenCalled();
      expect(await pathExists(join(engineDir, 'browser/base/content/mybrowser.xhtml'))).toBe(true);
    });
  });

  it('restores every engine file when a mutation fails partway through', async () => {
    await scaffoldEngine();
    await furnaceChromeDocCreateCommand(projectRoot, 'mybrowser', { withTests: true });

    const before = new Map<string, string>();
    for (const file of JAR_FILES) {
      before.set(file, await readFile(join(engineDir, file), 'utf8'));
    }
    const xhtmlPath = join(engineDir, 'browser/base/content/mybrowser.xhtml');
    const xhtmlBefore = await readFile(xhtmlPath, 'utf8');

    // Fail on the LAST jar file so the first two have already been rewritten
    // and the source files already deleted — the journal must undo all of it.
    const fsUtils = await import('../../../utils/fs.js');
    const realWriteText = fsUtils.writeText;
    vi.spyOn(fsUtils, 'writeText').mockImplementation(
      async (path: string, content: string): Promise<void> => {
        if (path.endsWith(join('browser', 'locales', 'jar.mn'))) {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        return realWriteText(path, content);
      }
    );

    await expect(
      furnaceChromeDocRemoveCommand(projectRoot, 'mybrowser', { yes: true })
    ).rejects.toThrow(/EACCES/);

    vi.mocked(fsUtils.writeText).mockRestore();

    // Everything back to its pre-command bytes.
    for (const file of JAR_FILES) {
      expect(await readFile(join(engineDir, file), 'utf8'), file).toBe(before.get(file));
    }
    expect(await readFile(xhtmlPath, 'utf8')).toBe(xhtmlBefore);
    expect(
      await pathExists(join(engineDir, 'browser/base/content/test/mybrowser-xpcshell/mybrowser'))
    ).toBe(true);
  });

  it('records a repair breadcrumb when the rollback itself fails', async () => {
    // Seven sibling mutation sites do this; these two did not, so a failed
    // rollback discarded the original error AND left no marker for
    // `doctor --repair-furnace` to find.
    await scaffoldEngine();
    await furnaceChromeDocCreateCommand(projectRoot, 'mybrowser');

    const fsUtils = await import('../../../utils/fs.js');
    const realWriteText = fsUtils.writeText;
    vi.spyOn(fsUtils, 'writeText').mockImplementation(
      async (path: string, content: string): Promise<void> => {
        if (path.endsWith(join('browser', 'locales', 'jar.mn'))) {
          throw new Error('primary failure');
        }
        return realWriteText(path, content);
      }
    );
    vi.spyOn(furnaceRollback, 'restoreRollbackJournalOrThrow').mockRejectedValue(
      new Error('restore failed too')
    );
    const record = vi.spyOn(furnaceOperation, 'recordFurnaceRollbackFailure').mockResolvedValue();

    await expect(
      furnaceChromeDocRemoveCommand(projectRoot, 'mybrowser', { yes: true })
    ).rejects.toThrow(/restore failed too/);

    expect(record).toHaveBeenCalledWith(
      projectRoot,
      'chrome-doc-rollback',
      expect.stringContaining('chrome-doc "mybrowser": restore failed too')
    );
  });
});
