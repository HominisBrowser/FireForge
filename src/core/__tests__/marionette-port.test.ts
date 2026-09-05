// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit tests for the Marionette port probe.
 *
 * The probe runs `lsof` (macOS/Linux) or PowerShell (Windows) to detect
 * listeners on the Marionette control port. The exec helper and platform
 * selector are mocked so the tests are deterministic and do not depend on
 * the host having a real listener.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
  describeRunningBundleRefusal,
  ensureLaunchableBrowserNotRunning,
  ensureMarionettePortAvailable,
  extractForwardedMarionettePort,
  forwardedMachArgsIncludeMarionetteClient,
  hasExplicitXpcshellFlavor,
  parseProcessList,
  probeMarionettePort,
  shouldAutoForwardMarionettePortToMach,
} from '../marionette-port.js';

const mockExec = vi.mocked(exec);
const mockGetPlatform = vi.mocked(getPlatform);

function lsofOutput(pid: number, command: string): string {
  // `lsof -Fpcn` emits one record per line, prefixed with the field
  // code (p, c, n).
  return `p${pid}\nc${command}\nn*:2828\n`;
}

// These modules branch on `process.platform` directly (not the mockable
// `getPlatform()`), so the POSIX expectations below only hold when the
// branch is forced. Pin it here instead of inheriting the runner's OS.
const originalPlatform = process.platform;

function stubPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPlatform.mockReturnValue('darwin');
  stubPlatform('darwin');
});

describe('objdir browser process preflight', () => {
  const binary = '/project/engine/obj-debug/dist/Hominis.app/Contents/MacOS/hominis';

  it('matches only the exact built binary and ignores the current process', () => {
    const output =
      `  41 12:30 ${binary} -marionette -profile /tmp/test\n` +
      '  42 01:02 /Applications/Firefox.app/Contents/MacOS/firefox -marionette\n' +
      `  ${process.pid} 00:01 ${binary} --synthetic-current-process\n`;
    expect(parseProcessList(output, binary)).toEqual([
      {
        pid: 41,
        commandLine: `${binary} -marionette -profile /tmp/test`,
        elapsedSeconds: 750,
      },
    ]);
  });

  it('degrades to an unknown age when the listing carries no etime column', () => {
    // A caller that lost the column must still see the process, with the
    // whole field folded back into the command line rather than swallowed.
    const output = `  41 ${binary} -marionette -profile /tmp/test\n`;
    const [row] = parseProcessList(output, binary);
    expect(row?.pid).toBe(41);
    expect(row?.commandLine).toBe(`${binary} -marionette -profile /tmp/test`);
    expect(row?.elapsedSeconds).toBeNaN();
  });

  it('offers --kill-stale-marionette for a harness-driven browser', () => {
    const message = describeRunningBundleRefusal({
      pid: 41,
      commandLine: `${binary} -marionette -profile /tmp/test`,
      elapsedSeconds: 750,
    });
    expect(message).toContain('PID 41 running for 12m30s');
    expect(message).toContain('-marionette -profile /tmp/test');
    expect(message).toContain('--kill-stale-marionette');
  });

  it('never offers --kill-stale-marionette for a BARE launch it cannot attribute', () => {
    // The downstream hazard: on a shared checkout the matched PID can be a
    // peer session's live browser, and the flag would kill their run.
    const message = describeRunningBundleRefusal({
      pid: 54000,
      commandLine: binary,
      elapsedSeconds: 4,
    });
    expect(message).toContain('PID 54000 running for 4s');
    expect(message).toContain('NO harness arguments');
    expect(message).not.toContain('retry with "--kill-stale-marionette"');
  });

  it('omits the age clause entirely when the elapsed time is unknown', () => {
    const message = describeRunningBundleRefusal({
      pid: 41,
      commandLine: `${binary} -marionette`,
      elapsedSeconds: NaN,
    });
    expect(message).toContain('(PID 41)');
    expect(message).not.toContain('running for');
  });

  it('refuses a surviving app even when no Marionette port is listening', async () => {
    mockExec.mockResolvedValue({
      exitCode: 0,
      stdout: `37001 ${binary} -profile /tmp/mochitest\n`,
      stderr: '',
    });

    await expect(ensureLaunchableBrowserNotRunning(binary)).rejects.toThrow(
      /already running \(PID 37001\)/
    );
  });

  it('terminates a surviving app when explicitly requested', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    mockExec.mockResolvedValue({
      exitCode: 0,
      stdout: `37002 ${binary} -profile /tmp/mochitest\n`,
      stderr: '',
    });
    try {
      await expect(
        ensureLaunchableBrowserNotRunning(binary, { killStaleBrowser: true })
      ).resolves.toBeUndefined();
      expect(killSpy).toHaveBeenCalledWith(37002, 'SIGTERM');
    } finally {
      killSpy.mockRestore();
    }
  });
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
        stdout: lsofOutput(7777, 'mybrowser-nightly'),
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '/opt/mybrowser-nightly -random-flag\n',
        stderr: '',
      });

    await expect(
      assertMarionettePortAvailable(DEFAULT_MARIONETTE_PORT, { binaryName: 'mybrowser-nightly' })
    ).rejects.toThrow(/mybrowser-nightly \(PID 7777\)/);
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

  it('probes the supplied port instead of the default when one is given', async () => {
    mockExec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
    await assertMarionettePortAvailable(2838);
    // The first exec call is the lsof probe; verify it targeted 2838 not 2828.
    expect(mockExec.mock.calls[0]?.[1]).toContain('tcp:2838');
    expect(mockExec.mock.calls[0]?.[1]).not.toContain('tcp:2828');
  });

  it('names the supplied port in the browser-holder error message', async () => {
    mockExec
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: `p99\nc firefox\nn*:2838\n`,
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '/usr/bin/firefox -marionette\n',
        stderr: '',
      });

    await expect(assertMarionettePortAvailable(2838)).rejects.toThrow(/port 2838/);
  });

  it('kills a recognized stale browser holder when requested', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    mockExec
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: lsofOutput(4242, 'firefox'),
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '/usr/bin/firefox -marionette\n',
        stderr: '',
      });

    try {
      await expect(
        ensureMarionettePortAvailable(DEFAULT_MARIONETTE_PORT, {
          killStaleBrowser: true,
        })
      ).resolves.toBeUndefined();
      expect(killSpy).toHaveBeenCalledWith(4242, 'SIGTERM');
    } finally {
      killSpy.mockRestore();
    }
  });

  it('refuses to kill an unrelated Marionette port holder', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    mockExec
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: lsofOutput(4243, 'node'),
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '/usr/bin/node server.js\n',
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: lsofOutput(4243, 'node'),
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '/usr/bin/node server.js\n',
        stderr: '',
      });

    try {
      await expect(
        ensureMarionettePortAvailable(DEFAULT_MARIONETTE_PORT, {
          killStaleBrowser: true,
        })
      ).rejects.toThrow(/not a FireForge-launched browser/);
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe('extractForwardedMarionettePort', () => {
  it('returns undefined when no recognised arg is present', () => {
    expect(extractForwardedMarionettePort([])).toBeUndefined();
    expect(extractForwardedMarionettePort(['--headless', '--keep-open'])).toBeUndefined();
  });

  it('parses the equals form', () => {
    expect(extractForwardedMarionettePort(['--marionette-port=2838'])).toBe(2838);
  });

  it('parses the two-token form', () => {
    expect(extractForwardedMarionettePort(['--marionette-port', '2838'])).toBe(2838);
  });

  it('parses the setpref form', () => {
    expect(extractForwardedMarionettePort(['--setpref=marionette.port=2838'])).toBe(2838);
  });

  it('returns undefined for malformed values', () => {
    expect(extractForwardedMarionettePort(['--marionette-port=notaport'])).toBeUndefined();
    expect(extractForwardedMarionettePort(['--marionette-port'])).toBeUndefined();
  });

  it('finds the arg even when surrounded by other args', () => {
    expect(
      extractForwardedMarionettePort([
        '--headless',
        '--app-path=/some/path',
        '--marionette-port=2838',
        '--setpref=foo=bar',
      ])
    ).toBe(2838);
  });
});

describe('forwardedMachArgsIncludeMarionetteClient', () => {
  it('returns false when no marionette client arg is present', () => {
    expect(forwardedMachArgsIncludeMarionetteClient([])).toBe(false);
    expect(forwardedMachArgsIncludeMarionetteClient(['--headless'])).toBe(false);
    expect(forwardedMachArgsIncludeMarionetteClient(['--marionette-port=2838'])).toBe(false);
    expect(forwardedMachArgsIncludeMarionetteClient(['--marionette-port', '2838'])).toBe(false);
  });

  it('returns true for --marionette=host:port', () => {
    expect(forwardedMachArgsIncludeMarionetteClient(['--marionette=127.0.0.1:2912'])).toBe(true);
    expect(
      forwardedMachArgsIncludeMarionetteClient([
        '--headless',
        '--marionette=127.0.0.1:2912',
        '--keep-open',
      ])
    ).toBe(true);
  });

  it('returns true for two-token --marionette host:port', () => {
    expect(forwardedMachArgsIncludeMarionetteClient(['--marionette', '127.0.0.1:2912'])).toBe(true);
  });

  it('does not treat --marionette-port as a client marionette flag', () => {
    expect(
      forwardedMachArgsIncludeMarionetteClient(['--marionette-port=2828', '--setpref=foo=bar'])
    ).toBe(false);
  });

  it('returns false when --marionette is not followed by a host:port token', () => {
    expect(forwardedMachArgsIncludeMarionetteClient(['--marionette'])).toBe(false);
    expect(forwardedMachArgsIncludeMarionetteClient(['--marionette', '--flavor=mochitest'])).toBe(
      false
    );
  });
});

describe('hasExplicitXpcshellFlavor', () => {
  it('returns true for xpcshell flavor mach args', () => {
    expect(hasExplicitXpcshellFlavor(['--flavor=xpcshell'])).toBe(true);
    expect(hasExplicitXpcshellFlavor(['--flavor=xpcshell-tests'])).toBe(true);
    expect(hasExplicitXpcshellFlavor(['--headless', '--flavor=xpcshell'])).toBe(true);
  });

  it('returns false otherwise', () => {
    expect(hasExplicitXpcshellFlavor([])).toBe(false);
    expect(hasExplicitXpcshellFlavor(['--flavor=mochitest'])).toBe(false);
    expect(hasExplicitXpcshellFlavor(['--flavor=browser-chrome'])).toBe(false);
  });
});

describe('shouldAutoForwardMarionettePortToMach', () => {
  it('returns false when xpcshell flavor is explicit', () => {
    expect(shouldAutoForwardMarionettePortToMach(['--flavor=xpcshell'])).toBe(false);
    expect(shouldAutoForwardMarionettePortToMach(['--flavor=xpcshell-tests'])).toBe(false);
  });

  it('returns true for other mach arg shapes', () => {
    expect(shouldAutoForwardMarionettePortToMach([])).toBe(true);
    expect(shouldAutoForwardMarionettePortToMach(['--flavor=mochitest'])).toBe(true);
    expect(shouldAutoForwardMarionettePortToMach(['--headless'])).toBe(true);
  });
});
