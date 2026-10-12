// SPDX-License-Identifier: EUPL-1.2
/**
 * `--auto-ports` / `test.mochitestPorts: "auto"` in the browser-run
 * preflight: the mochitest-server and Marionette port gates step aside for
 * a holder that is not this checkout's, and only when the engine's harness
 * carries the busy-port fallback. The default path is untouched.
 */
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', async () =>
  (await import('./test-command-mocks.js')).loggerMock()
);
vi.mock('../../core/marionette-port.js', async () =>
  (await import('./test-command-mocks.js')).marionettePortMock()
);
vi.mock('../../core/mochitest-server-port.js', () => ({
  DEFAULT_MOCHITEST_SERVER_PORT: 8888,
  ensureMochitestServerPortAvailable: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../core/harness-orphans.js', () => ({
  reportOrphanedHarnessProcesses: vi.fn(() => Promise.resolve({ reaped: 0 })),
}));

import { assertMarionettePortAvailable, probeMarionettePort } from '../../core/marionette-port.js';
import { ensureMochitestServerPortAvailable } from '../../core/mochitest-server-port.js';
import { createTempProject, removeTempProject, writeFiles } from '../../test-utils/index.js';
import type { TestOptions } from '../../types/commands/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { notice } from '../../utils/logger.js';
import { ensureTestBrowserEnvironment } from '../test-browser-preflight.js';

const RUNTESTS =
  '("httpPort", "HTTP test server"),\nif _port_in_use(port):\n  falling back to port\n' +
  'if _port_in_use(marionette_port):\n  falling back to port\n';

let root: string;
let engineDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  root = await createTempProject('fireforge-auto-ports-');
  engineDir = join(root, 'engine');
  await writeFiles(root, { 'engine/testing/mochitest/runtests.py': RUNTESTS });
});

afterEach(async () => {
  await removeTempProject(root);
});

function holdPorts(commandLine: string): void {
  vi.mocked(probeMarionettePort).mockResolvedValue({
    inUse: true,
    holder: { pid: 77, command: 'peer', commandLine },
  });
}

function prepare(
  options: TestOptions,
  mochitestPorts?: 'fixed' | 'auto',
  xpcshellOnly = false
): ReturnType<typeof ensureTestBrowserEnvironment> {
  const config = {
    binaryName: 'mybrowser',
    test: mochitestPorts === undefined ? {} : { mochitestPorts },
  } as unknown as FireForgeConfig;
  return ensureTestBrowserEnvironment(engineDir, undefined, xpcshellOnly, config, options, 'obj-x');
}

describe('auto ports in the browser preflight', () => {
  it('leaves the default gates in force', async () => {
    holdPorts('/peers/lab/engine/obj-x/dist/bin/xpcshell server.js');
    await prepare({});
    expect(ensureMochitestServerPortAvailable).toHaveBeenCalledTimes(1);
    expect(assertMarionettePortAvailable).toHaveBeenCalledTimes(1);
    expect(probeMarionettePort).not.toHaveBeenCalled();
  });

  it.each([
    ['--auto-ports', { autoPorts: true }, undefined],
    ['test.mochitestPorts: "auto"', {}, 'auto' as const],
  ])("steps aside for a sibling checkout's listeners with %s", async (_label, options, config) => {
    holdPorts('/peers/lab/engine/obj-x/dist/bin/xpcshell server.js');
    await expect(prepare(options, config)).resolves.toEqual({
      forwardedPort: undefined,
      effectivePort: undefined,
    });
    expect(ensureMochitestServerPortAvailable).not.toHaveBeenCalled();
    expect(assertMarionettePortAvailable).not.toHaveBeenCalled();
    expect(probeMarionettePort).toHaveBeenCalledWith(8888);
    expect(probeMarionettePort).toHaveBeenCalledWith(2828);
    expect(notice).toHaveBeenCalledWith(expect.stringMatching(/^Mochitest server port 8888/));
    expect(notice).toHaveBeenCalledWith(expect.stringMatching(/^Marionette port 2828/));
  });

  it("keeps refusing this checkout's own holder", async () => {
    holdPorts(`${engineDir}/obj-x/dist/bin/xpcshell ${engineDir}/_tests/server.js`);
    await prepare({ autoPorts: true });
    expect(ensureMochitestServerPortAvailable).toHaveBeenCalledTimes(1);
    expect(assertMarionettePortAvailable).toHaveBeenCalledTimes(1);
  });

  it('never steps aside for the Marionette port under --doctor', async () => {
    holdPorts('/peers/lab/engine/obj-x/dist/bin/mybrowser -marionette');
    await prepare({ autoPorts: true, doctor: true, marionettePort: 2900 });
    expect(ensureMochitestServerPortAvailable).not.toHaveBeenCalled();
    expect(assertMarionettePortAvailable).toHaveBeenCalledWith(2900, { binaryName: 'mybrowser' });
  });

  it('does nothing for an xpcshell-only run', async () => {
    await prepare({ autoPorts: true }, undefined, true);
    expect(probeMarionettePort).not.toHaveBeenCalled();
    expect(ensureMochitestServerPortAvailable).not.toHaveBeenCalled();
  });
});
