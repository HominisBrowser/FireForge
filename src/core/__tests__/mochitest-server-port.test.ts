// SPDX-License-Identifier: EUPL-1.2
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/process.js', () => ({ exec: vi.fn() }));
vi.mock('../marionette-port.js', () => ({ probeMarionettePort: vi.fn() }));

import { probeMarionettePort } from '../marionette-port.js';
import {
  classifyMochitestServerHolder,
  DEFAULT_MOCHITEST_SERVER_PORT,
  describeHolderObjdir,
  describeMochitestServerRefusal,
  ensureMochitestServerPortAvailable,
  isMochitestServerHolder,
} from '../mochitest-server-port.js';

const ENGINE_DIR = '/project/engine';
const OWN = { engineDir: ENGINE_DIR };

const HARNESS_HTTPD = {
  pid: 4242,
  command: 'xpcshell',
  commandLine:
    '/project/engine/obj-debug/dist/bin/xpcshell -g /x -f /project/engine/obj-debug/_tests/testing/mochitest/server.js',
};

// The same harness, serving a LIVE run in a sibling worktree. Its command
// line is indistinguishable from debris except for whose objdir it names.
const FOREIGN_HTTPD = {
  pid: 71244,
  command: 'xpcshell',
  commandLine:
    '/Users/dev/GitHub/hominis-timemachine-153.2/engine/obj-debug/dist/bin/xpcshell -g /x -f /Users/dev/GitHub/hominis-timemachine-153.2/engine/obj-debug/_tests/testing/mochitest/server.js',
};

const UNRELATED_NODE = { pid: 900, command: 'node', commandLine: '/usr/bin/node /app/server.js' };

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
  vi.mocked(probeMarionettePort).mockReset();
  stubPlatform('darwin');
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

describe('classifyMochitestServerHolder', () => {
  it("classifies a harness httpd under this project's engine dir as this checkout's", () => {
    expect(classifyMochitestServerHolder(HARNESS_HTTPD, ENGINE_DIR)).toBe('this-checkout');
  });

  it('classifies the same harness under another worktree as a foreign checkout', () => {
    expect(classifyMochitestServerHolder(FOREIGN_HTTPD, ENGINE_DIR)).toBe('foreign-checkout');
  });

  it('does not let a prefix-named sibling checkout pass as this one', () => {
    // `/a/hominis/engine` vs `/a/hominis-2/engine`: a substring test would
    // claim it. The comparison is per path token, through isPathInsideRoot.
    const sibling = {
      ...HARNESS_HTTPD,
      commandLine:
        '/a/hominis-2/engine/obj-x/dist/bin/xpcshell -f /a/hominis-2/engine/obj-x/_tests/testing/mochitest/server.js',
    };
    expect(classifyMochitestServerHolder(sibling, '/a/hominis/engine')).toBe('foreign-checkout');
    expect(classifyMochitestServerHolder(sibling, '/a/hominis-2/engine')).toBe('this-checkout');
  });

  it('leaves an unrelated server.js unrecognized regardless of engine dir', () => {
    expect(classifyMochitestServerHolder(UNRELATED_NODE, ENGINE_DIR)).toBe('unrecognized');
  });
});

describe('describeHolderObjdir', () => {
  it('names the objdir the holder is serving from', () => {
    expect(describeHolderObjdir(FOREIGN_HTTPD.commandLine)).toBe(
      '/Users/dev/GitHub/hominis-timemachine-153.2/engine/obj-debug'
    );
  });

  it('falls back to the first absolute path when no obj- segment is present', () => {
    expect(describeHolderObjdir('/opt/x/xpcshell -f /opt/x/_tests/server.js')).toBe(
      '/opt/x/xpcshell'
    );
  });

  it('says so when the command line carries no path at all', () => {
    expect(describeHolderObjdir('xpcshell server.js')).toContain('no path visible');
  });
});

describe('ensureMochitestServerPortAvailable', () => {
  it("refuses a FOREIGN checkout's live httpd without the flag and without a kill hint", async () => {
    vi.mocked(probeMarionettePort).mockResolvedValue({ inUse: true, holder: FOREIGN_HTTPD });
    const thrown = await ensureMochitestServerPortAvailable(undefined, OWN).catch(
      (error: unknown) => error
    );
    const message = (thrown as Error).message;
    expect(message).toContain('ANOTHER checkout');
    expect(message).toContain('/Users/dev/GitHub/hominis-timemachine-153.2/engine/obj-debug');
    expect(message).not.toContain('kill -9');
    expect(message).not.toContain('debris');
    expect(message).toContain('lsof -nP -iTCP:8888');
  });

  it("never terminates a FOREIGN checkout's httpd, even under --kill-stale-marionette", async () => {
    vi.mocked(probeMarionettePort).mockResolvedValue({ inUse: true, holder: FOREIGN_HTTPD });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      await expect(
        ensureMochitestServerPortAvailable(undefined, { ...OWN, killStaleServer: true })
      ).rejects.toThrow(/ANOTHER checkout/);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it('keeps the PowerShell kill for this checkout only', async () => {
    stubPlatform('win32');
    const { exec } = await import('../../utils/process.js');
    vi.mocked(exec).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    vi.mocked(probeMarionettePort).mockResolvedValue({
      inUse: true,
      holder: {
        ...FOREIGN_HTTPD,
        commandLine:
          'C:\\other\\engine\\obj-x\\dist\\bin\\xpcshell.exe -f C:\\other\\engine\\obj-x\\_tests\\server.js',
      },
    });
    await expect(
      ensureMochitestServerPortAvailable(undefined, {
        engineDir: 'C:\\mine\\engine',
        killStaleServer: true,
      })
    ).rejects.toThrow(/ANOTHER checkout/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('is a no-op when the port is free', async () => {
    vi.mocked(probeMarionettePort).mockResolvedValue({ inUse: false });
    await expect(ensureMochitestServerPortAvailable(undefined, OWN)).resolves.toBeUndefined();
  });

  it('is a no-op when the port cannot be probed at all', async () => {
    // probeMarionettePort reports an unprobeable port as free, so a host
    // without lsof must run exactly as it did before this preflight existed.
    vi.mocked(probeMarionettePort).mockResolvedValue({ inUse: false });
    await expect(
      ensureMochitestServerPortAvailable(DEFAULT_MOCHITEST_SERVER_PORT, OWN)
    ).resolves.toBeUndefined();
  });

  it('refuses a recognized stale harness httpd and offers the flag', async () => {
    vi.mocked(probeMarionettePort).mockResolvedValue({ inUse: true, holder: HARNESS_HTTPD });
    await expect(ensureMochitestServerPortAvailable(undefined, OWN)).rejects.toThrow(
      /--kill-stale-marionette/
    );
  });

  it('refuses an UNRECOGNIZED listener without offering to kill it', async () => {
    vi.mocked(probeMarionettePort).mockResolvedValue({
      inUse: true,
      holder: { pid: 900, command: 'node', commandLine: '/usr/bin/node /app/server.js' },
    });
    await expect(ensureMochitestServerPortAvailable(undefined, OWN)).rejects.toThrow(
      /will not offer to kill it/
    );
  });

  it('terminates a recognized holder only when the operator opted in', async () => {
    vi.mocked(probeMarionettePort).mockResolvedValue({ inUse: true, holder: HARNESS_HTTPD });
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      await expect(
        ensureMochitestServerPortAvailable(undefined, { ...OWN, killStaleServer: true })
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
        ensureMochitestServerPortAvailable(undefined, { ...OWN, killStaleServer: true })
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
        ensureMochitestServerPortAvailable(undefined, { ...OWN, killStaleServer: true })
      ).rejects.toThrow(/mochitest server port/);
    } finally {
      kill.mockRestore();
    }
  });
});

describe('describeMochitestServerRefusal', () => {
  it('names the stall it prevents, so the message is recognizable from a past bisect', () => {
    const message = describeMochitestServerRefusal(8888, HARNESS_HTTPD, 'this-checkout');
    expect(message).toContain('Ran 0 checks');
    expect(message).toContain('PID 4242');
    expect(message).toContain('server.js');
  });

  it('gives the one-line diagnostic for an unrecognized holder', () => {
    const message = describeMochitestServerRefusal(8888, UNRELATED_NODE, 'unrecognized');
    expect(message).toContain('lsof -nP -iTCP:8888');
  });
});
