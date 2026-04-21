// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit tests for the Marionette port probe (Finding #20).
 *
 * The probe runs `lsof` (macOS/Linux) or PowerShell (Windows) to
 * detect listeners on the Marionette control port. We mock the exec
 * helper + platform selector so the tests are deterministic and do
 * not depend on the host having a real listener.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/process.js', () => ({
  exec: vi.fn(),
}));

vi.mock('../../utils/platform.js', () => ({
  getPlatform: vi.fn(() => 'darwin'),
}));

import { GeneralError } from '../../errors/base.js';
import { getPlatform } from '../../utils/platform.js';
import { exec } from '../../utils/process.js';
import {
  assertMarionettePortAvailable,
  DEFAULT_MARIONETTE_PORT,
  probeMarionettePort,
} from '../marionette-port.js';

const mockExec = vi.mocked(exec);
const mockGetPlatform = vi.mocked(getPlatform);

function lsofOutput(pid: number, command: string): string {
  // `lsof -Fpcn` emits one record per line, prefixed with the field
  // code (p, c, n).
  return `p${pid}\nc${command}\nn*:2828\n`;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPlatform.mockReturnValue('darwin');
});

describe('probeMarionettePort', () => {
  it('reports the port as free when lsof returns no output', async () => {
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
    const result = await probeMarionettePort();
    expect(result.inUse).toBe(false);
    expect(result.holder).toBeUndefined();
  });

  it('parses lsof output into a holder record', async () => {
    mockExec
      // First call: `lsof`
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: lsofOutput(12345, 'forgefresh'),
        stderr: '',
      })
      // Second call: `ps -o args=`
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout:
          '/Applications/ForgeFresh.app/Contents/MacOS/forgefresh -marionette -profile /tmp/prof\n',
        stderr: '',
      });

    const result = await probeMarionettePort();
    expect(result.inUse).toBe(true);
    expect(result.holder?.pid).toBe(12345);
    expect(result.holder?.command).toBe('forgefresh');
    expect(result.holder?.commandLine).toContain('-marionette');
  });

  it('returns inUse=false when lsof is not installed', async () => {
    mockExec.mockRejectedValue(new Error('spawn lsof ENOENT'));
    const result = await probeMarionettePort();
    expect(result.inUse).toBe(false);
  });

  it('tolerates ps missing by falling back to the lsof basename', async () => {
    mockExec
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: lsofOutput(999, 'firefox'),
        stderr: '',
      })
      // `ps` fails — keep the basename.
      .mockRejectedValueOnce(new Error('ps not found'));

    const result = await probeMarionettePort();
    expect(result.holder?.pid).toBe(999);
    expect(result.holder?.commandLine).toBe('firefox');
  });

  it('uses the default port (2828) when no port is supplied', async () => {
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
    await probeMarionettePort();
    expect(mockExec.mock.calls[0]?.[1]).toContain(`tcp:${DEFAULT_MARIONETTE_PORT}`);
  });

  it('uses PowerShell probe on Windows', async () => {
    mockGetPlatform.mockReturnValue('win32');
    mockExec.mockResolvedValue({
      exitCode: 0,
      stdout: 'PID=4321\nNAME=firefox\nCMD=firefox.exe -marionette\n',
      stderr: '',
    });

    const result = await probeMarionettePort();
    expect(mockExec.mock.calls[0]?.[0]).toBe('powershell.exe');
    expect(result.inUse).toBe(true);
    expect(result.holder?.pid).toBe(4321);
    expect(result.holder?.commandLine).toContain('-marionette');
  });
});

describe('assertMarionettePortAvailable', () => {
  it('returns silently when the port is free', async () => {
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
    await expect(assertMarionettePortAvailable()).resolves.toBeUndefined();
  });

  it('raises a browser-specific error when a Firefox-family process holds the port', async () => {
    mockExec
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: lsofOutput(5555, 'forgefresh'),
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '/Applications/ForgeFresh.app/Contents/MacOS/forgefresh -marionette\n',
        stderr: '',
      });

    await expect(assertMarionettePortAvailable()).rejects.toThrow(GeneralError);
    // Reset mocks for the second assertion.
    mockExec.mockClear();
    mockExec
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: lsofOutput(5555, 'forgefresh'),
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '/Applications/ForgeFresh.app/Contents/MacOS/forgefresh -marionette\n',
        stderr: '',
      });
    await expect(assertMarionettePortAvailable()).rejects.toThrow(/PID 5555/);
  });

  it('recognises a fork-branded binary via the provided binaryName', async () => {
    mockExec
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: lsofOutput(7777, 'hominis-nightly'),
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '/opt/hominis-nightly -random-flag\n',
        stderr: '',
      });

    await expect(
      assertMarionettePortAvailable(DEFAULT_MARIONETTE_PORT, { binaryName: 'hominis-nightly' })
    ).rejects.toThrow(/hominis-nightly \(PID 7777\)/);
  });

  it('raises a softer unrelated-listener error when the holder is not a browser', async () => {
    mockExec
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: lsofOutput(8888, 'node'),
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '/usr/local/bin/node my-dev-server.js\n',
        stderr: '',
      });

    await expect(assertMarionettePortAvailable()).rejects.toThrow(
      /not a FireForge-launched browser/
    );
  });

  it('names the kill command in the browser-holder error message', async () => {
    mockExec
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: lsofOutput(12345, 'firefox'),
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '/usr/bin/firefox -marionette\n',
        stderr: '',
      });

    try {
      await assertMarionettePortAvailable();
      throw new Error('expected throw');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toMatch(/kill 12345/);
    }
  });
});
