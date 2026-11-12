// SPDX-License-Identifier: EUPL-1.2
/**
 * Host hygiene. The predicates are tables; leftovers and strays are real
 * processes, started with the command lines and environments harness
 * helpers have, so every assertion is about who really got signalled.
 */
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isProcessAlive } from '../kernel/process/index.js';
import { useMachSandbox } from '../testing/engine.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import {
  carriesMarker,
  ENGINE_MARKER,
  freePort,
  harnessFallsBack,
  isHarnessCommand,
  parseLsofPids,
  reapLeftovers,
  RUN_MARKER,
  sweepRun,
} from './host.js';

const dir = useTempDir();
const logged = useMachSandbox();
const run = promisify(execFile);
const OBJ = '/Users/u/fork/engine/obj-fireforge';
const started: number[] = [];

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

describe('isHarnessCommand', () => {
  it.each([
    `/Users/u/.mozbuild/x/_virtualenvs/common/bin/python ${OBJ}/_tests/testing/mochitest/pywebsocket_wrapper.py -H 0.0.0.0 -p 9988`,
    `/Users/u/.mozbuild/node/bin/node ${OBJ}/_tests/testing/mochitest/xpcshell/moz-http2/moz-http2.js`,
    `${OBJ}/dist/bin/xpcshell -g ${OBJ}/dist/bin -f ${OBJ}/_tests/testing/mochitest/server.js`,
    `${OBJ}/dist/bin/ssltunnel /var/folders/x/ssltunnel.cfg`,
    `python3.12 ${OBJ}/_tests/testing/mochitest/websocketprocessbridge/websocketprocessbridge.py --port 8191`,
    `${OBJ}/dist/bin/http3server /tmp/db`,
    `${OBJ}/dist/Fork.app/Contents/MacOS/fork -marionette -foreground -profile /tmp/x`,
    `${OBJ}/dist/bin/fork -profile /tmp/tmpab12/mochitest-profile`,
  ])('recognizes %s', (command) => {
    expect(isHarnessCommand(command)).toBe(true);
  });

  it.each([
    `/bin/zsh -c python3 -c 'import time; time.sleep(9)' ${OBJ}/_tests/testing/mochitest/server.js &`,
    `vim ${OBJ}/_tests/testing/mochitest/server.js`,
    `grep -rn server.js ${OBJ}/_tests`,
    `/opt/homebrew/bin/python3 -c import time ${OBJ}/_tests/testing/mochitest/server.js`,
    `python3.12 ${OBJ}/../mach mochitest browser/x.js`,
    `${OBJ}/dist/Fork.app/Contents/MacOS/fork`,
  ])('does not take a bystander for one: %s', (command) => {
    expect(isHarnessCommand(command)).toBe(false);
  });
});

describe('carriesMarker', () => {
  it('matches a whole NAME=value token only', () => {
    const listing = `node /x/server.js TERM=xterm ${RUN_MARKER}=abc HOME=/u`;
    expect(carriesMarker(listing, RUN_MARKER, 'abc')).toBe(true);
    expect(carriesMarker(`node x ${RUN_MARKER}=abc`, RUN_MARKER, 'abc')).toBe(true);
    expect(carriesMarker(`node x ${RUN_MARKER}=abcd`, RUN_MARKER, 'abc')).toBe(false);
    expect(carriesMarker(`node x X${RUN_MARKER}=abc`, RUN_MARKER, 'abc')).toBe(false);
    expect(carriesMarker('node x', RUN_MARKER, 'abc')).toBe(false);
  });
});

describe('ports', () => {
  it('reads listener pids from lsof field output', () => {
    expect(parseLsofPids('p123\nf7\np456\np123\n')).toEqual([123, 456]);
    expect(parseLsofPids('')).toEqual([]);
  });

  it("reads whether the engine's harness moves busy ports by itself", () => {
    const source = [
      'log.info("%s port %d already in use, falling back to port %d")',
      'for name, port in (("httpPort", 8888),): if self._port_in_use(port):',
      'if self._port_in_use(marionette_port):',
    ].join('\n');
    expect(harnessFallsBack(source)).toEqual({ servers: true, marionette: true });
    expect(harnessFallsBack('nothing here')).toEqual({ servers: false, marionette: false });
    expect(harnessFallsBack(undefined)).toEqual({ servers: false, marionette: false });
  });

  it('picks a free loopback port', async () => {
    const port = await freePort();
    expect(port).toBeGreaterThan(1024);
  });
});

/** A sleeping helper whose command line names `script`. */
const SLEEPER = 'setInterval(() => {}, 1000);\n';

async function helperScript(root: string, relative: string): Promise<string> {
  await writeTree(root, { [relative]: SLEEPER });
  return join(root, relative);
}

/** Starts `node script` as an orphan: its shell parent exits at once. */
async function startOrphan(script: string, env: Record<string, string> = {}): Promise<number> {
  const { stdout } = await run(
    '/bin/sh',
    ['-c', `"${process.execPath}" "${script}" >/dev/null 2>&1 & echo $!`],
    {
      env: { ...process.env, ...env },
    }
  );
  const pid = Number(stdout.trim());
  started.push(pid);
  return pid;
}

/** Starts `node script` in a session of its own, still a child of this process. */
function startDetached(script: string, env: Record<string, string>): number {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ...env },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const pid = child.pid ?? 0;
  started.push(pid);
  return pid;
}

const visible = async (pid: number): Promise<void> => {
  await vi.waitFor(
    async () => {
      const { stdout } = await run('/bin/ps', ['-o', 'ppid=,command=', '-p', String(pid)]);
      if (!stdout.includes('node')) throw new Error('not running node yet');
    },
    { timeout: 10_000, interval: 50 }
  );
};

describe.skipIf(process.platform === 'win32')('leftovers of earlier runs', () => {
  it("terminates this workspace's orphaned helpers and marked processes, never another workspace's", async () => {
    const mine = join(dir(), 'mine', 'engine');
    const theirs = join(dir(), 'theirs', 'engine');
    const orphan = await startOrphan(
      await helperScript(mine, 'obj-fireforge/_tests/testing/mochitest/server.js')
    );
    const marked = startDetached(await helperScript(dir(), 'elsewhere/tool.js'), {
      [ENGINE_MARKER]: mine,
    });
    const foreign = await startOrphan(
      await helperScript(theirs, 'obj-fireforge/_tests/testing/mochitest/server.js')
    );
    const foreignMarked = startDetached(await helperScript(dir(), 'elsewhere/other.js'), {
      [ENGINE_MARKER]: theirs,
    });
    const bystander = await startOrphan(await helperScript(mine, 'tools/notes.js'));
    for (const pid of [orphan, marked, foreign, foreignMarked, bystander]) await visible(pid);

    const reaped = await reapLeftovers({ engineDir: mine, objDir: join(mine, 'obj-fireforge') });

    // The orphan check needs a parent of 1, which hosts with a subreaper do not give.
    const { stdout } = await run('/bin/ps', ['-o', 'ppid=', '-p', String(orphan)]).catch(() => ({
      stdout: '',
    }));
    const orphanReparentedToInit = stdout.trim() === '1' || !isProcessAlive(orphan);
    expect(reaped).toBe(orphanReparentedToInit ? 2 : 1);
    await vi.waitFor(() => {
      expect(isProcessAlive(marked)).toBe(false);
    });
    if (orphanReparentedToInit) expect(isProcessAlive(orphan)).toBe(false);
    expect(isProcessAlive(foreign)).toBe(true);
    expect(isProcessAlive(foreignMarked)).toBe(true);
    expect(isProcessAlive(bystander)).toBe(true);
    expect(logged()).toContain('an earlier test run of this workspace left behind');
  });
});

describe.skipIf(process.platform === 'win32')('the sweep after a run', () => {
  it('terminates what this run started that names the workspace, and leaves the rest', async () => {
    const engine = join(dir(), 'engine');
    const helper = await helperScript(
      engine,
      'obj-fireforge/_tests/xpcshell/moz-http2/moz-http2.js'
    );
    const stray = startDetached(helper, { [RUN_MARKER]: 'run-1' });
    const otherRun = startDetached(helper, { [RUN_MARKER]: 'run-2' });
    const unanchored = startDetached(await helperScript(dir(), 'outside/helper.js'), {
      [RUN_MARKER]: 'run-1',
    });
    for (const pid of [stray, otherRun, unanchored]) await visible(pid);

    const { reaped, survivors } = await sweepRun(
      { engineDir: engine, objDir: join(engine, 'obj-fireforge') },
      'run-1'
    );

    expect(reaped).toBe(1);
    expect(isProcessAlive(stray)).toBe(false);
    expect(isProcessAlive(otherRun)).toBe(true);
    expect(survivors.map((entry) => entry.pid)).toEqual([unanchored]);
  });
});
