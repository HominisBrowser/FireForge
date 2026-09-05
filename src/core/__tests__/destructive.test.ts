// SPDX-License-Identifier: EUPL-1.2
/**
 * Tests for the shared destructive-operation helper. Exercises:
 *   - dry-run never mutates and returns 'dry-run'
 *   - hard refusal with conflicts and no unsafeOverride throws
 *   - --force-unsafe bypasses conflicts
 *   - --yes in non-TTY skips the prompt
 *   - non-TTY without --yes throws
 *   - appendHistory writes one JSONL record per call
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CancellationError, InvalidArgumentError } from '../../errors/base.js';
import { ExitCode } from '../../errors/codes.js';
import {
  createTempProject,
  removeTempProject,
  setInteractiveMode,
} from '../../test-utils/index.js';
import * as logger from '../../utils/logger.js';
import { appendHistory, confirmDestructive, HISTORY_LOG_FILENAME } from '../destructive.js';

/**
 * Stand-in for clack's cancellation sentinel. The real one is
 * `Symbol('clack:cancel')`, module-private inside `@clack/core` and therefore
 * unreachable from a test. `isCancel` is overridden below to recognise this
 * marker too, which is enough to drive the interrupt branch. `utils/logger.ts`
 * imports `* as p from '@clack/prompts'`, so the override reaches
 * `logger.isCancel`, which is what `confirmDestructive` actually calls.
 */
const CANCEL_MARKER = Symbol('test:clack-cancel');

// Mock @clack/prompts so we can control the confirm() return value in
// interactive-path tests without a real stdin.
vi.mock('@clack/prompts', async () => {
  const actual = await vi.importActual<typeof import('@clack/prompts')>('@clack/prompts');
  return {
    ...actual,
    confirm: vi.fn(),
    isCancel: (value: unknown): boolean => value === CANCEL_MARKER || actual.isCancel(value),
  };
});

import { confirm } from '@clack/prompts';

describe('confirmDestructive', () => {
  let projectRoot: string;
  let restoreTTY: () => void = () => undefined;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-destructive-');
    vi.mocked(confirm).mockReset();
  });

  afterEach(async () => {
    restoreTTY();
    await removeTempProject(projectRoot);
  });

  it('dry-run returns "dry-run" and does not prompt', async () => {
    restoreTTY = setInteractiveMode(true);
    const result = await confirmDestructive({
      operation: 'test-op',
      title: 'Test title',
      summary: ['line 1', 'line 2'],
      yes: false,
      dryRun: true,
    });
    expect(result).toBe('dry-run');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('hard refusal: throws when conflicts are present and unsafeOverride is false', async () => {
    restoreTTY = setInteractiveMode(true);
    await expect(
      confirmDestructive({
        operation: 'test-op',
        title: 'Test',
        summary: [],
        yes: true,
        dryRun: false,
        conflicts: { reason: 'boom', details: ['thing exploded'] },
      })
    ).rejects.toBeInstanceOf(InvalidArgumentError);
  });

  it('--force-unsafe bypasses the conflict refusal', async () => {
    restoreTTY = setInteractiveMode(false);
    const warnSpy = vi.spyOn(logger, 'warn');
    const infoSpy = vi.spyOn(logger, 'info');
    const result = await confirmDestructive({
      operation: 'test-op',
      title: 'Test',
      summary: [],
      yes: true,
      dryRun: false,
      unsafeOverride: true,
      conflicts: { reason: 'boom', details: ['thing exploded'] },
    });
    expect(result).toBe('proceed');
    expect(warnSpy).toHaveBeenCalledWith('Refused: boom');
    expect(infoSpy).toHaveBeenCalledWith('  thing exploded');
    expect(infoSpy).toHaveBeenCalledWith('  Proceeding because --force-unsafe was provided.');
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it('yes in non-TTY returns proceed without prompting', async () => {
    restoreTTY = setInteractiveMode(false);
    const result = await confirmDestructive({
      operation: 'test-op',
      title: 'Test',
      summary: [],
      yes: true,
      dryRun: false,
    });
    expect(result).toBe('proceed');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('non-TTY without --yes throws InvalidArgumentError', async () => {
    restoreTTY = setInteractiveMode(false);
    await expect(
      confirmDestructive({
        operation: 'test-op',
        title: 'Test',
        summary: [],
        yes: false,
        dryRun: false,
      })
    ).rejects.toMatchObject({
      argument: '--yes',
    });
  });

  it('interactive with confirm=true returns proceed', async () => {
    restoreTTY = setInteractiveMode(true);
    vi.mocked(confirm).mockResolvedValue(true);
    const result = await confirmDestructive({
      operation: 'test-op',
      title: 'Test',
      summary: ['a change'],
      yes: false,
      dryRun: false,
    });
    expect(result).toBe('proceed');
  });

  it('interactive with confirm=false returns declined (a "no" is not an interrupt)', async () => {
    restoreTTY = setInteractiveMode(true);
    vi.mocked(confirm).mockResolvedValue(false);
    const result = await confirmDestructive({
      operation: 'test-op',
      title: 'Test',
      summary: [],
      yes: false,
      dryRun: false,
    });
    expect(result).toBe('declined');
  });

  it('interactive interrupt (Esc/Ctrl+C) throws CancellationError, which exits 130', async () => {
    // Answering "no" is a successful run that chose not to proceed
    // (exit 0). Esc/Ctrl+C is an interrupt (exit 130 = 128+SIGINT).
    // Collapsing both into one outcome leaves a script unable to tell them
    // apart.
    restoreTTY = setInteractiveMode(true);
    vi.mocked(confirm).mockResolvedValue(CANCEL_MARKER);
    await expect(
      confirmDestructive({
        operation: 'test-op',
        title: 'Test',
        summary: [],
        yes: false,
        dryRun: false,
      })
    ).rejects.toBeInstanceOf(CancellationError);
    expect(new CancellationError().code).toBe(ExitCode.USER_CANCELLED);
  });
});

describe('appendHistory', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-destructive-history-');
    patchesDir = join(projectRoot, 'patches');
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('writes a JSONL record per call', async () => {
    await appendHistory(patchesDir, {
      operation: 'patch-delete',
      args: { filename: '001-ui-foo.patch' },
      result: 'ok',
    });
    await appendHistory(patchesDir, {
      operation: 'patch-reorder',
      args: { from: 1, to: 2 },
      yes: true,
      result: 'ok',
    });

    const content = await readFile(join(patchesDir, HISTORY_LOG_FILENAME), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);

    interface HistoryRecord {
      ts: string;
      operation: string;
      args: { filename?: string };
      yes?: boolean;
      result: string;
    }
    const first = JSON.parse(lines[0] ?? '{}') as HistoryRecord;
    expect(first.operation).toBe('patch-delete');
    expect(first.args.filename).toBe('001-ui-foo.patch');
    expect(first.result).toBe('ok');
    expect(first.ts).toMatch(/\d{4}-\d{2}-\d{2}T/);

    const second = JSON.parse(lines[1] ?? '{}') as HistoryRecord;
    expect(second.operation).toBe('patch-reorder');
    expect(second.yes).toBe(true);
  });
});
