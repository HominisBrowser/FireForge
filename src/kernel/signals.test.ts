// SPDX-License-Identifier: EUPL-1.2
import { afterEach, describe, expect, it } from 'vitest';

import * as log from './log.js';
import {
  installSignalHandlers,
  isShuttingDown,
  onForceExit,
  onShutdown,
  resetShutdown,
  runShutdown,
  type ShutdownPhase,
} from './signals.js';
import { sleep } from './time.js';

const cleanups: (() => void)[] = [];
let previousLog: log.LogConfig | undefined;

function register(
  phase: ShutdownPhase,
  handler: Parameters<typeof onShutdown>[1],
  timeoutMs?: number
): void {
  cleanups.push(onShutdown(phase, handler, timeoutMs === undefined ? {} : { timeoutMs }));
}

function captureLog(): string[] {
  const lines: string[] = [];
  previousLog = log.configureLog({ write: (text) => lines.push(text) });
  return lines;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  resetShutdown();
  if (previousLog !== undefined) log.configureLog(previousLog);
  previousLog = undefined;
});

describe('runShutdown', () => {
  it('announces synchronously, then runs the phases in order, each after the previous finished', async () => {
    const events: string[] = [];
    register('finish', () => void events.push('finish'));
    register('release', async () => {
      await sleep(5);
      events.push('release');
    });
    register('restore', () => void events.push('restore'));
    register('rollback', async () => {
      await sleep(10);
      events.push('rollback');
    });
    register('stop', async () => {
      await sleep(15);
      events.push('stop');
    });
    register('announce', (signal) => void events.push(`announce ${signal}`));
    const done = runShutdown('SIGTERM');
    expect(events).toEqual(['announce SIGTERM']);
    expect(isShuttingDown()).toBe(true);
    await done;
    expect(events).toEqual([
      'announce SIGTERM',
      'stop',
      'rollback',
      'restore',
      'release',
      'finish',
    ]);
  });

  it('runs the handlers of one phase in parallel', async () => {
    const events: string[] = [];
    register('stop', async () => {
      await sleep(30);
      events.push('slow');
    });
    register('stop', () => void events.push('fast'));
    await runShutdown('SIGINT');
    expect(events).toEqual(['fast', 'slow']);
  });

  it('survives a handler that throws or rejects, and still runs the rest', async () => {
    const lines = captureLog();
    const events: string[] = [];
    register('announce', () => {
      throw new Error('announce failed');
    });
    register('rollback', () => Promise.reject(new Error('disk full')));
    register('release', () => void events.push('release'));
    await expect(runShutdown('SIGTERM')).resolves.toBeUndefined();
    expect(events).toEqual(['release']);
    expect(lines.join('')).toContain('A rollback step failed after SIGTERM: disk full');
  });

  it('gives up on a handler that exceeds its bound, and then releases nothing', async () => {
    const lines = captureLog();
    const events: string[] = [];
    register('rollback', () => new Promise<void>(() => undefined), 20);
    register('release', () => void events.push('release'));
    register('finish', () => void events.push('finish'));
    await runShutdown('SIGTERM');
    // An undo that may still be writing keeps every lock until the process is gone.
    expect(events).toEqual(['finish']);
    expect(lines.join('')).toContain('did not finish within 20 ms');
  });

  it('skips the undo while a child may still be writing', async () => {
    const events: string[] = [];
    register('stop', () => new Promise<void>(() => undefined), 20);
    register('rollback', () => void events.push('rollback'));
    register('finish', () => void events.push('finish'));
    captureLog();
    await runShutdown('SIGINT');
    expect(events).toEqual(['finish']);
  });

  it('joins a pipeline that is already running instead of starting a second', async () => {
    let runs = 0;
    register('stop', async () => {
      runs += 1;
      await sleep(10);
    });
    await Promise.all([runShutdown('SIGINT'), runShutdown('SIGINT')]);
    expect(runs).toBe(1);
  });

  it('does not run a handler that was removed', async () => {
    let ran = false;
    const remove = onShutdown('finish', () => {
      ran = true;
    });
    remove();
    await runShutdown('SIGTERM');
    expect(ran).toBe(false);
  });
});

describe('installSignalHandlers', () => {
  /** Delivers a signal to this process's listeners only: nothing is sent to the process. */
  const deliver = (signal: NodeJS.Signals): boolean => process.emit(signal, signal);

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 143],
  ] as const)('runs the pipeline on %s and exits %i', async (signal, code) => {
    const events: string[] = [];
    register('announce', (received) => void events.push(`announce ${received}`));
    register('release', () => void events.push('release'));
    const exited = new Promise<number>((resolve) => {
      cleanups.push(installSignalHandlers({ exit: resolve, forceExit: resolve }));
    });
    expect(deliver(signal)).toBe(true);
    expect(await exited).toBe(code);
    expect(events).toEqual([`announce ${signal}`, 'release']);
  });

  it('exits at once on a second signal, after the force handlers', async () => {
    const events: string[] = [];
    let finish = (): void => undefined;
    const stopping = new Promise<void>((started) => {
      register('stop', () => {
        started();
        return new Promise<void>((resolve) => (finish = resolve));
      });
    });
    cleanups.push(onForceExit(() => void events.push('force')));
    cleanups.push(
      onForceExit(() => {
        throw new Error('a force handler that fails');
      })
    );
    const exits: string[] = [];
    cleanups.push(
      installSignalHandlers({
        exit: (code) => void exits.push(`exit ${code}`),
        forceExit: (code) => void exits.push(`force ${code}`),
      })
    );
    deliver('SIGTERM');
    expect(isShuttingDown()).toBe(true);
    deliver('SIGINT');
    expect(events).toEqual(['force']);
    expect(exits).toEqual(['force 130']);
    await stopping;
    finish();
    await runShutdown('SIGTERM');
  });

  it('stops listening once removed', () => {
    const before = process.listenerCount('SIGHUP');
    const remove = installSignalHandlers({ exit: () => undefined, forceExit: () => undefined });
    expect(process.listenerCount('SIGHUP')).toBe(before + 1);
    remove();
    expect(process.listenerCount('SIGHUP')).toBe(before);
  });
});
