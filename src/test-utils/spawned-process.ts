// SPDX-License-Identifier: EUPL-1.2
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';

import { sweepProcessGroup } from '../utils/process-group.js';

export interface CapturedProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Capture a test process and settle only after its owned child tree is closed. */
export function runCapturedProcess(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; graceMs?: number }
): Promise<CapturedProcessResult> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const graceMs = options.graceMs ?? 500;
  const usesProcessGroup = process.platform !== 'win32';
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    detached: usesProcessGroup,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  let primaryError: Error | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let windowsTeardown: Promise<void> | undefined;
  const signalGroup = (signal: NodeJS.Signals): void => {
    // The leader may already have exited while a descendant keeps a pipe
    // open. The owned group remains the teardown target until close.
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  };
  const timeout = setTimeout(() => {
    primaryError = new Error(`Test child exceeded ${timeoutMs} ms: ${command}`);
    if (!usesProcessGroup && child.pid !== undefined) {
      windowsTeardown = new Promise<void>((done) => {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
          timeout: 2_000,
        });
        killer.on('error', () => {
          child.kill('SIGKILL');
        });
        killer.on('close', () => {
          child.kill('SIGKILL');
          done();
        });
      });
      return;
    }
    signalGroup('SIGTERM');
    escalation = setTimeout(() => {
      signalGroup('SIGKILL');
    }, graceMs);
  }, timeoutMs);
  return new Promise((resolve, reject) => {
    child.on('error', (error) => {
      primaryError ??= error;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      const finish = async (): Promise<void> => {
        await windowsTeardown;
        if (usesProcessGroup && child.pid !== undefined) {
          await sweepProcessGroup(child.pid, graceMs);
        }
        if (primaryError) throw primaryError;
        const signalNumber = signal ? osConstants.signals[signal] : undefined;
        resolve({
          exitCode: code ?? (signalNumber === undefined ? -1 : 128 + signalNumber),
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      };
      void finish().catch(reject);
    });
  });
}
