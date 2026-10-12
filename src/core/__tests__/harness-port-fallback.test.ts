// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', async () =>
  (await import('../../commands/__tests__/test-command-mocks.js')).loggerMock()
);
vi.mock('../marionette-port.js', () => ({ probeMarionettePort: vi.fn() }));

import { createTempProject, removeTempProject, writeFiles } from '../../test-utils/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { notice } from '../../utils/logger.js';
import {
  autoPortsRequested,
  deferBusyPortToHarness,
  detectHarnessPortFallback,
  isThisCheckoutsHolder,
  resolveAutoPorts,
} from '../harness-port-fallback.js';
import { probeMarionettePort } from '../marionette-port.js';

/** The shape of the upstream fallbacks in testing/mochitest/runtests.py. */
const RUNTESTS = `
    def startServers(self, options, debuggerInfo, public=None):
        port_attrs = [
            ("httpPort", "HTTP test server"),
            ("sslPort", "ssltunnel"),
        ]
        for attr, name in port_attrs:
            port = int(getattr(options, attr))
            if _port_in_use(port):
                self.log.info(f"{name} port {port} already in use, falling back to port {new_port}")
    ...
            if _port_in_use(marionette_port):
                self.log.info("Marionette port already in use, " f"falling back to port {new_port}")
`;

const config = (mochitestPorts?: 'fixed' | 'auto'): FireForgeConfig =>
  ({ test: mochitestPorts === undefined ? {} : { mochitestPorts } }) as unknown as FireForgeConfig;

let root: string;
let engineDir: string;

beforeEach(async () => {
  vi.clearAllMocks();
  root = await createTempProject('fireforge-port-fallback-');
  engineDir = join(root, 'engine');
});

afterEach(async () => {
  await removeTempProject(root);
});

describe('detectHarnessPortFallback', () => {
  it('finds both fallbacks in an engine that carries them', async () => {
    await writeFiles(root, { 'engine/testing/mochitest/runtests.py': RUNTESTS });
    expect(await detectHarnessPortFallback(engineDir)).toEqual({
      serverPorts: true,
      marionettePort: true,
    });
  });

  it('reports neither for an old harness or a missing file', async () => {
    expect(await detectHarnessPortFallback(engineDir)).toEqual({
      serverPorts: false,
      marionettePort: false,
    });
    await writeFiles(root, {
      'engine/testing/mochitest/runtests.py': 'def startServers(): pass\n',
    });
    expect(await detectHarnessPortFallback(engineDir)).toEqual({
      serverPorts: false,
      marionettePort: false,
    });
  });
});

describe('autoPortsRequested / resolveAutoPorts', () => {
  it('is on by flag or by config, off by default', () => {
    expect(autoPortsRequested({}, config())).toBe(false);
    expect(autoPortsRequested({}, config('fixed'))).toBe(false);
    expect(autoPortsRequested({ autoPorts: true }, config())).toBe(true);
    expect(autoPortsRequested({}, config('auto'))).toBe(true);
  });

  it('keeps the default refusal, with a notice, when the engine cannot fall back', async () => {
    expect(await resolveAutoPorts(engineDir, {}, config())).toBeUndefined();
    expect(notice).not.toHaveBeenCalled();
    expect(await resolveAutoPorts(engineDir, { autoPorts: true }, config())).toBeUndefined();
    expect(notice).toHaveBeenCalledWith(expect.stringMatching(/no busy-port fallback/));
  });

  it('returns the engine fallbacks when requested and supported', async () => {
    await writeFiles(root, { 'engine/testing/mochitest/runtests.py': RUNTESTS });
    expect(await resolveAutoPorts(engineDir, {}, config('auto'))).toEqual({
      serverPorts: true,
      marionettePort: true,
    });
  });
});

describe('deferBusyPortToHarness', () => {
  const holder = (
    commandLine: string
  ): { inUse: true; holder: { pid: number; command: string; commandLine: string } } => ({
    inUse: true,
    holder: { pid: 42, command: 'xpcshell', commandLine },
  });

  it('does not step aside for a free port', async () => {
    vi.mocked(probeMarionettePort).mockResolvedValue({ inUse: false });
    expect(await deferBusyPortToHarness(8888, 'Mochitest server', engineDir)).toBe(false);
  });

  it("steps aside for a sibling checkout's live server, naming it", async () => {
    vi.mocked(probeMarionettePort).mockResolvedValue(
      holder('/peers/lab/engine/obj-x/dist/bin/xpcshell /peers/lab/engine/_tests/server.js')
    );
    expect(await deferBusyPortToHarness(8888, 'Mochitest server', engineDir)).toBe(true);
    expect(notice).toHaveBeenCalledWith(
      expect.stringMatching(/Mochitest server port 8888 is held by xpcshell \(PID 42\)/)
    );
  });

  it("keeps the normal preflight for this checkout's own holder", async () => {
    vi.mocked(probeMarionettePort).mockResolvedValue(
      holder(`${engineDir}/obj-x/dist/bin/xpcshell ${engineDir}/_tests/server.js`)
    );
    expect(await deferBusyPortToHarness(8888, 'Mochitest server', engineDir)).toBe(false);
  });

  it('classifies holders by absolute command-line tokens', () => {
    expect(
      isThisCheckoutsHolder({ pid: 1, command: 'x', commandLine: `${engineDir}/obj/x` }, engineDir)
    ).toBe(true);
    expect(
      isThisCheckoutsHolder(
        { pid: 1, command: 'x', commandLine: `${engineDir}-2/obj/x` },
        engineDir
      )
    ).toBe(false);
    expect(
      isThisCheckoutsHolder({ pid: 1, command: 'x', commandLine: 'node srv' }, engineDir)
    ).toBe(false);
  });
});
