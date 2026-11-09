// SPDX-License-Identifier: EUPL-1.2
/**
 * A build record whose anchor commit left the repository, against real git:
 * what `fireforge download --force` leaves behind.
 */
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', async () =>
  (await import('../../test-utils/module-mocks.js')).createLoggerMock()
);

import { enforceStaleBuildGate } from '../../commands/test-stale-gate.js';
import { getVerdictRunAttribute } from '../../commands/test-verdict.js';
import { PreflightRefusalError } from '../../errors/base.js';
import { notice } from '../../utils/logger.js';
import { readUsableBuildBaseline } from '../build-baseline-usable.js';
import { assessBuildProvenance } from '../build-provenance.js';
import { BaselineAnchorMissingError, collectChangedEnginePaths } from '../engine-changes.js';
import { missingEngineMessage } from '../engine-precondition.js';
import { checkStaleBuildForTest, checkStaticComponentsStale } from '../test-stale-check.js';

const GONE = '1'.repeat(40);

describe('a baseline anchored to a commit the repository no longer has', () => {
  let root: string;
  let engine: string;
  const baseline = (head: string, more: object = {}): object => ({
    builtAt: '2026-01-01T00:00:00.000Z',
    engineHeadSha: head,
    binaryName: 'testbrowser',
    ...more,
  });
  const writeBaseline = async (value: object): Promise<void> => {
    await writeFile(join(root, '.fireforge', 'last-build.json'), JSON.stringify(value));
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await mkdtemp(join(tmpdir(), 'fireforge-anchor-'));
    engine = join(root, 'engine');
    await mkdir(engine);
    await mkdir(join(root, '.fireforge'));
    const run = (...args: string[]): void => {
      execFileSync('git', args, { cwd: engine, stdio: 'ignore' });
    };
    run('init', '-q');
    await writeFile(join(engine, 'a.js'), 'a\n');
    run('add', '.');
    run('-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-qm', 'fresh download');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('raises a typed refusal naming the commit and the next step', async () => {
    const error = await collectChangedEnginePaths(
      engine,
      baseline(GONE) as never,
      'Auto-configure'
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BaselineAnchorMissingError);
    expect(error).toBeInstanceOf(PreflightRefusalError);
    expect((error as PreflightRefusalError).note).toBe('no-build-baseline');
    expect((error as Error).message).toContain(GONE);
    expect((error as Error).message).toContain('fireforge build');
  });

  it('keeps failing closed on any other git failure', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'fireforge-not-git-'));
    const error = await collectChangedEnginePaths(
      elsewhere,
      baseline(GONE) as never,
      'Audit'
    ).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(BaselineAnchorMissingError);
    expect((error as Error).message).toContain('Audit: cannot establish engine changes');
    await rm(elsewhere, { recursive: true, force: true });
  });

  describe('a commit the store holds but cannot give back', () => {
    const anchor = (): string =>
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: engine }).toString().trim();
    const expectRefusal = async (head: string): Promise<void> => {
      await writeBaseline(baseline(head));
      const error = await collectChangedEnginePaths(engine, baseline(head) as never, 'Audit').catch(
        (e: unknown) => e
      );
      expect(error).not.toBeInstanceOf(BaselineAnchorMissingError);
      expect((error as Error).message).toContain('Audit: cannot establish engine changes');
      // A build keeps the record, so its own collector refuses too: no silent fresh start.
      const usable = await readUsableBuildBaseline(root, engine);
      expect(usable.anchorMissing).toBe(false);
      expect(usable.baseline?.engineHeadSha).toBe(head);
      await expect(checkStaleBuildForTest(root, engine)).rejects.toThrow(
        /cannot establish engine changes/
      );
    };

    it('refuses an emptied loose object', async () => {
      const head = anchor();
      const object = join(engine, '.git', 'objects', head.slice(0, 2), head.slice(2));
      await chmod(object, 0o644);
      await writeFile(object, '');
      await expectRefusal(head);
    });

    it('refuses an unreadable loose object', async () => {
      const head = anchor();
      const object = join(engine, '.git', 'objects', head.slice(0, 2), head.slice(2));
      await chmod(object, 0o000);
      await expectRefusal(head);
      await chmod(object, 0o644);
    });

    it.each(['.idx', '.pack'])(
      'refuses an unreadable %s, which git itself reads as absent',
      async (suffix) => {
        const head = anchor();
        execFileSync('git', ['repack', '-adq'], { cwd: engine });
        const directory = join(engine, '.git', 'objects', 'pack');
        const name = (await readdir(directory)).find((entry) => entry.endsWith(suffix));
        await chmod(join(directory, name as string), 0o000);
        await expectRefusal(head);
        await chmod(join(directory, name as string), 0o644);
      }
    );

    it('refuses a record that names no commit at all', async () => {
      await expectRefusal('not-a-revision');
    });
  });

  it('gives a build no baseline to work from, with a notice', async () => {
    await writeBaseline(baseline(GONE));
    await expect(readUsableBuildBaseline(root, engine)).resolves.toEqual({
      baseline: undefined,
      anchorMissing: true,
    });
    expect(notice).toHaveBeenCalledWith(expect.stringContaining(GONE));
  });

  it('keeps a baseline whose commit exists, without a notice', async () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: engine }).toString().trim();
    await writeBaseline(baseline(head));
    const usable = await readUsableBuildBaseline(root, engine);
    expect(usable.anchorMissing).toBe(false);
    expect(usable.baseline?.engineHeadSha).toBe(head);
    expect(notice).not.toHaveBeenCalled();
  });

  it('leaves the stale gate with no baseline and a refusal to give', async () => {
    await writeBaseline(baseline(GONE));
    const stale = await checkStaleBuildForTest(root, engine);
    expect(stale.stale).toBe(false);
    expect(stale.baseline).toBeUndefined();
    expect(stale.unusableBaseline).toContain(GONE);
    expect(stale.unusableBaseline).toContain('--allow-stale-build');
  });

  it('reads as no recorded build to the package provenance check', async () => {
    await writeBaseline(baseline(GONE));
    const findings = await assessBuildProvenance(root, engine, undefined);
    expect(findings.noBaseline).toContain(GONE);
  });

  it('refuses a build-less test run, and --allow-stale-build proceeds and says so', async () => {
    await writeBaseline(baseline(GONE));
    const refused = await enforceStaleBuildGate(root, engine, {}, ['a/browser_a.js']).catch(
      (error: unknown) => error
    );
    expect(refused).toBeInstanceOf(PreflightRefusalError);
    expect((refused as PreflightRefusalError).note).toBe('no-build-baseline');
    expect((refused as Error).message).toContain(GONE);
    await expect(
      enforceStaleBuildGate(root, engine, { allowStaleBuild: true }, ['a/browser_a.js'])
    ).resolves.toBeUndefined();
    expect(getVerdictRunAttribute('baseline')).toBe('none');
  });

  it('reads a lost full-build anchor as a stale compiled table', async () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: engine }).toString().trim();
    const result = await checkStaticComponentsStale(
      engine,
      baseline(head, {
        staticComponentsBaseline: { engineHeadSha: GONE, fingerprints: {} },
      }) as never
    );
    expect(result.stale).toBe(true);
    expect(result.changedManifests.join()).toContain(GONE);
  });
});

describe('the missing-engine remedy', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fireforge-remedy-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('says to download on a project with a queue', async () => {
    await writeFile(join(root, 'fireforge.json'), '{}');
    await expect(missingEngineMessage(join(root, 'engine'))).resolves.toContain(
      'fireforge download'
    );
  });

  it('says to use a job in a source-mode checkout, where download is refused', async () => {
    await writeFile(join(root, 'fireforge.json'), '{"sources":{"mode":"authored"}}');
    const message = await missingEngineMessage(join(root, 'engine'));
    expect(message).toContain('fireforge job run');
    expect(message).not.toContain('fireforge download');
  });
});
