// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/process.js', () => ({ exec: vi.fn() }));
vi.mock('../marionette-port.js', () => ({ probeMarionettePort: vi.fn() }));

import { probeMarionettePort } from '../marionette-port.js';
import {
  DEFAULT_MOCHITEST_SERVER_PORT,
  describeMochitestServerRefusal,
  ensureMochitestServerPortAvailable,
  isMochitestServerHolder,
} from '../mochitest-server-port.js';

const HARNESS_HTTPD = {
  pid: 4242,
  command: 'xpcshell',
  commandLine:
    '/project/engine/obj-debug/dist/bin/xpcshell -g /x -f /project/engine/obj-debug/_tests/testing/mochitest/server.js',
};

beforeEach(() => {
  vi.mocked(probeMarionettePort).mockReset();
});

describe('isMochitestServerHolder', () => {
  it('recognizes the harness httpd by server.js plus objdir/xpcshell provenance', () => {
    expect(isMochitestServerHolder(HARNESS_HTTPD)).toBe(true);
  });

  it('does NOT claim an unrelated Node service that merely runs a server.js', () => {
    // `server.js` is one of the most common filenames there is. Matching on
    // it alone would offer a developer's own service up for termination.
    expect(
      isMochitestServerHolder({
        pid: 900,
        command: 'node',
        commandLine: '/usr/local/bin/node /Users/dev/app/server.js --port 8888',
      })
    ).toBe(false);
  });
});

describe('ensureMochitestServerPortAvailable', () => {
  it('is a no-op when the port is free', async () => {
    vi.mocked(probeMarionettePort).mockResolvedValue({ inUse: false });
    await expect(ensureMochitestServerPortAvailable()).resolves.toBeUndefined();
  });

  it('is a no-op when the port cannot be probed at all', async () => {
    // probeMarionettePort reports an unprobeable port as free, so a host
    // without lsof must run exactly as it did before this preflight existed.
    vi.mocked(probeMarionettePort).mockResolvedValue({ inUse: false });
    await expect(
      ensureMochitestServerPortAvailable(DEFAULT_MOCHITEST_SERVER_PORT)
    ).resolves.toBeUndefined();
  });

  it('refuses a recognized stale harness httpd and offers the flag', async () => {
    vi.mocked(probeMarionettePort).mockResolvedValue({ inUse: true, holder: HARNESS_HTTPD });
    await expect(ensureMochitestServerPortAvailable()).rejects.toThrow(/--kill-stale-marionette/);
  });

  it('refuses an UNRECOGNIZED listener without offering to kill it', async () => {
    vi.mocked(probeMarionettePort).mockResolvedValue({
      inUse: true,
      holder: { pid: 900, command: 'node', commandLine: '/usr/bin/node /app/server.js' },
    });
    await expect(ensureMochitestServerPortAvailable()).rejects.toThrow(/will not offer to kill it/);
  });

  it('terminates a recognized holder only when the operator opted in', async () => {
    vi.mocked(probeMarionettePort).mockResolvedValue({ inUse: true, holder: HARNESS_HTTPD });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      await expect(
        ensureMochitestServerPortAvailable(undefined, { killStaleServer: true })
      ).resolves.toBeUndefined();
      expect(kill).toHaveBeenCalledWith(HARNESS_HTTPD.pid, 'SIGTERM');
    } finally {
      kill.mockRestore();
    }
  });

  it('never terminates an unrecognized holder even under the opt-in flag', async () => {
    vi.mocked(probeMarionettePort).mockResolvedValue({
      inUse: true,
      holder: { pid: 900, command: 'node', commandLine: '/usr/bin/node /app/server.js' },
    });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      await expect(
        ensureMochitestServerPortAvailable(undefined, { killStaleServer: true })
      ).rejects.toThrow(/will not offer to kill it/);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it('still refuses when the kill fails, rather than pretending the port is free', async () => {
    vi.mocked(probeMarionettePort).mockResolvedValue({ inUse: true, holder: HARNESS_HTTPD });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('EPERM');
    });
    try {
      await expect(
        ensureMochitestServerPortAvailable(undefined, { killStaleServer: true })
      ).rejects.toThrow(/mochitest server port/);
    } finally {
      kill.mockRestore();
    }
  });
});

describe('describeMochitestServerRefusal', () => {
  it('names the stall it prevents, so the message is recognizable from a past bisect', () => {
    const message = describeMochitestServerRefusal(8888, HARNESS_HTTPD, true);
    expect(message).toContain('Ran 0 checks');
    expect(message).toContain('PID 4242');
    expect(message).toContain('server.js');
  });

  it('gives the one-line diagnostic for an unrecognized holder', () => {
    const message = describeMochitestServerRefusal(
      8888,
      { pid: 900, command: 'node', commandLine: '/usr/bin/node /app/server.js' },
      false
    );
    expect(message).toContain('lsof -nP -iTCP:8888');
  });
});
