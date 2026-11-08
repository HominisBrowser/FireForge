// SPDX-License-Identifier: EUPL-1.2
/** What FireForge reads from the host before and while it puts a window on the screen. */
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { stepFingerprint, testStep } from '../../proof/plan.js';
import { planAdmission } from '../admission.js';
import { initializeCoordinator } from '../client.js';
import { readDisplayState, sessionRefusal } from '../display-probe.js';
import { type FrontTools, holdFront, isSlotBrowser } from '../hold-front.js';
import type { JobRecord, ResourceVector } from '../schema.js';
import { assertStepDeclaration, throttleArguments } from '../step-environment.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
async function temp(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'fireforge-signals-')));
  directories.push(path);
  return path;
}

function job(id: string, ticket: number, headless: boolean): JobRecord {
  return {
    schemaVersion: 1,
    id,
    owner: 't',
    state: 'queued',
    epoch: 1,
    submittedAt: '',
    updatedAt: '',
    cancellationRequested: false,
    slot: id,
    phase: { index: 0, active: false, ticket },
    request: {
      schemaVersion: 1,
      key: id,
      slot: id,
      sourceId: 'a'.repeat(64),
      quiet: false,
      steps: [{ command: 'test', args: [...(headless ? ['--headless'] : []), 'browser/a.js'] }],
    },
  };
}
const vector = (browser: number): ResourceVector => ({
  cpu: 14,
  memory: 28,
  build: 1,
  browser,
  display: 1,
});

describe('the display at admission', () => {
  // Recorded from a MacBook Pro (M4 Max) with a display attached; its wrangler reports no power state.
  const rootDomain = (lid: 'Yes' | 'No', capabilities = 15): string =>
    `      "IOPowerManagement" = {"ChildrenPowerState"=0,"DevicePowerState"=4,"CurrentPowerState"=4,"CapabilityFlags"=2,"MaxPowerState"=4}\n      "System Capabilities" = ${String(capabilities)}\n      "AppleClamshellCausesSleep" = Yes\n      "AppleClamshellState" = ${lid}\n      "IOPMUserIsActive" = Yes\n`;
  const builtIn =
    '        Color LCD:\n          Display Type: Built-in Liquid Retina XDR Display\n          Resolution: 3456 x 2234 Retina\n          Main Display: Yes\n          Mirror: Off\n          Online: Yes\n          Automatically Adjust Brightness: Yes\n          Connection Type: Internal\n';
  const external =
    '        HP E243i:\n          Resolution: 1920 x 1200 (WUXGA - Widescreen Ultra eXtended Graphics Array)\n          UI Looks like: 1920 x 1200 @ 60.00Hz\n          Mirror: Off\n          Online: Yes\n          Rotation: Supported\n';
  const profile = (...displays: string[]): string =>
    `Graphics/Displays:\n\n    Apple M4 Max:\n\n      Chipset Model: Apple M4 Max\n      Type: GPU\n      Bus: Built-In\n      Total Number of Cores: 32\n      Vendor: Apple (0x106b)\n      Metal Support: Metal 4\n${displays.length === 0 ? '' : `      Displays:\n${displays.join('')}`}\n`;
  const asleep = (display: string): string => `${display}          Display Asleep: Yes\n`;

  it.each([
    ['an open lid and both displays', rootDomain('No'), profile(builtIn, external), 'usable'],
    [
      'a docked laptop: lid closed, external listed',
      rootDomain('Yes'),
      profile(external),
      'usable',
    ],
    [
      'a docked laptop that still lists its panel',
      rootDomain('Yes'),
      profile(builtIn, external),
      'usable',
    ],
    ['a closed lid with only the panel', rootDomain('Yes'), profile(builtIn), 'unavailable'],
    ['a closed lid and no display', rootDomain('Yes'), profile(), 'unavailable'],
    ['the graphics capability off', rootDomain('No', 13), profile(builtIn), 'unavailable'],
    ['a sleeping display', rootDomain('No'), profile(asleep(builtIn)), 'unavailable'],
    ['no display on a machine with no lid', 'no keys here', profile(), 'unknown'],
    ['a closed lid and no display reading', rootDomain('Yes'), undefined, 'unknown'],
    ['nothing readable', undefined, undefined, 'unknown'],
  ])('reads %s', (_name, root, displays, state) => {
    expect(readDisplayState(root, displays).state).toBe(state);
  });

  it('keeps a job with a window queued saying why, and lets everything else through', () => {
    const plan = planAdmission([job('headed', 1, false), job('headless', 2, true)], {
      config: { capacity: vector(1) },
      displayDown: 'display asleep',
    });
    expect(plan.blocked.get('headed')).toBe('display: display asleep');
    expect(plan.admit.map((entry) => entry.job.id)).toEqual(['headless']);
  });

  it('runs a job with a window when nothing says the display is down', () => {
    const plan = planAdmission([job('headed', 1, false)], { config: { capacity: vector(1) } });
    expect(plan.admit.map((entry) => entry.job.id)).toEqual(['headed']);
  });

  it('refuses a window from a session that cannot show one, and only then', () => {
    expect(sessionRefusal('Background\n')).toMatch(/"Background"/);
    expect(sessionRefusal('Aqua\n')).toBeUndefined();
    expect(sessionRefusal(undefined)).toBeUndefined();
  });
});

describe('browser capacity', () => {
  it('admits two headless browsers at two, and still one window at a time', () => {
    const headless = planAdmission([job('a', 1, true), job('b', 2, true)], {
      config: { capacity: vector(2) },
    });
    expect(headless.admit).toHaveLength(2);
    const one = planAdmission([job('a', 1, true), job('b', 2, true)], {
      config: { capacity: vector(1) },
    });
    expect(one.admit).toHaveLength(1);
    const headed = planAdmission([job('a', 1, false), job('b', 2, false)], {
      config: { capacity: vector(2) },
    });
    expect(headed.admit).toHaveLength(1);
    expect(headed.blocked.get('b')).toMatch(/display/);
  });

  it('is set by init, defaults to one and survives a later init', async () => {
    const namespace = join(await temp(), 'ns');
    expect((await initializeCoordinator(namespace)).capacity.browser).toBe(1);
    expect((await initializeCoordinator(namespace, { browsers: 2 })).capacity).toMatchObject({
      browser: 2,
      display: 1,
    });
    expect((await initializeCoordinator(namespace, { cpu: 3 })).capacity.browser).toBe(2);
  });
});

describe('a throttled step', () => {
  it('has a fixed argument form and its own evidence', () => {
    expect(throttleArguments('background')).toEqual([
      '--mach-arg=--debugger=taskpolicy',
      '--mach-arg=--debugger-args=-b',
    ]);
    expect(throttleArguments('utility')).toEqual([
      '--mach-arg=--debugger=taskpolicy',
      '--mach-arg=--debugger-args=-c utility',
    ]);
    expect(throttleArguments(undefined)).toEqual([]);
    const plain = testStep(['browser/a.js']);
    expect(stepFingerprint({ ...plain, throttle: 'utility' })).not.toBe(stepFingerprint(plain));
    expect(stepFingerprint({ ...plain, throttle: 'utility' })).not.toBe(
      stepFingerprint({ ...plain, throttle: 'background' })
    );
    expect(stepFingerprint({ ...plain, holdFront: true })).not.toBe(stepFingerprint(plain));
  });

  it('refuses another clamp, or a clamp on what is not a test', () => {
    const step = testStep(['browser/a.js']);
    expect(() => {
      assertStepDeclaration({ ...step, throttle: 'idle' as 'utility' });
    }).toThrow(/throttle must be/);
    expect(() => {
      assertStepDeclaration({ command: 'build', args: [], throttle: 'utility' });
    }).toThrow(/applies to a test/);
    expect(() => {
      assertStepDeclaration({ ...step, holdFront: true });
    }).toThrow(/holdFront applies/);
    assertStepDeclaration({ ...testStep(['browser/a.js'], { headed: true }), holdFront: true });
  });
});

describe('holding the front', () => {
  /** A real process tree: this process, a child, and the browser under the child. */
  async function browserTree(): Promise<{ browser: number; stop: () => void }> {
    const child = spawn('sh', ['-c', 'sleep 30 & echo $!; wait'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
    });
    const pid = await new Promise<number>((settle) => {
      child.stdout.once('data', (data: Buffer) => {
        settle(Number(data.toString().trim()));
      });
    });
    return {
      browser: pid,
      stop: () => {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      },
    };
  }

  const slot = '/ns/slots/a/root';
  const app = `${slot}/engine/obj-x/dist/Fixture.app/Contents/MacOS/fixture -profile /x`;

  function tools(
    browser: number,
    overrides: Partial<FrontTools> & { front?: () => number | undefined } = {}
  ): FrontTools & { raised: number[] } {
    const raised: number[] = [];
    return {
      raised,
      processes: () =>
        Promise.resolve([
          { pid: 500_000, ppid: 1, args: 'root' },
          { pid: browser, ppid: 500_000, args: app },
          {
            pid: browser + 1,
            ppid: browser,
            args: `${slot}/engine/obj-x/dist/Fixture.app/Contents/MacOS/plugin-container.app/Contents/MacOS/x`,
          },
          { pid: 7, ppid: 1, args: app },
        ]),
      frontmost: () => Promise.resolve(overrides.front?.()),
      raise: (pid) => {
        raised.push(pid);
        return overrides.raise?.(pid) ?? Promise.resolve(true);
      },
    };
  }
  const fast = { root: 500_000, slotRoot: slot, pollMs: 2, settleMs: 1 };
  const until = async (test: () => boolean): Promise<void> => {
    for (let index = 0; index < 500 && !test(); index += 1)
      await new Promise((settle) => setTimeout(settle, 2));
  };

  it('recognises only the main executable of an application this slot built', () => {
    expect(isSlotBrowser(app, slot)).toBe(true);
    expect(isSlotBrowser(`python mach test --binary=${app}`, slot)).toBe(false);
    expect(isSlotBrowser(app, '/ns/slots/b/root')).toBe(false);
    expect(
      isSlotBrowser(
        `${slot}/engine/obj-x/dist/Fixture.app/Contents/MacOS/plugin-container.app/Contents/MacOS/x`,
        slot
      )
    ).toBe(false);
  });

  it('raises its own browser and nothing else, and a raise that takes is green', async () => {
    let front: number | undefined = 99;
    const used = tools(4242, {
      front: () => front,
      raise: () => {
        front = 4242;
        return Promise.resolve(true);
      },
    });
    const hold = holdFront(fast, used);
    await until(() => used.raised.length > 0);
    const report = await hold.finish();
    expect(used.raised).toEqual([4242]);
    expect(report).toMatchObject({ browser: 4242, raises: 1, failures: 0 });
    expect(report.failed).toBeUndefined();
  });

  it('is not fooled by a raise the host accepted and did not perform', async () => {
    const used = tools(4242, { front: () => 99 });
    const hold = holdFront(fast, used);
    await until(() => used.raised.length >= 3);
    await new Promise((settle) => setTimeout(settle, 20));
    const report = await hold.finish();
    expect(report.failed).toMatch(/could not be brought to the front/);
    expect(report.failures).toBeGreaterThanOrEqual(3);
  });

  it('forgives a browser still starting', async () => {
    let attempts = 0;
    const used = tools(4242, {
      front: () => (attempts >= 2 ? 4242 : 99),
      raise: () => {
        attempts += 1;
        return Promise.resolve(attempts >= 2);
      },
    });
    const hold = holdFront(fast, used);
    await until(() => attempts >= 2);
    await new Promise((settle) => setTimeout(settle, 20));
    const report = await hold.finish();
    expect(report.failures).toBe(1);
    expect(report.failed).toBeUndefined();
  });

  it('a phase that never showed its browser did not hold anything', async () => {
    const report = await holdFront(fast, {
      processes: () => Promise.resolve([{ pid: 7, ppid: 1, args: app }]),
      frontmost: () => Promise.resolve(7),
      raise: () => Promise.resolve(true),
    }).finish();
    expect(report.failed).toMatch(/No browser of this phase/);
  });

  it('finds a descendant in a real process tree only by its command', async () => {
    const tree = await browserTree();
    try {
      const real = await holdFront(
        { root: process.pid, slotRoot: slot, pollMs: 2, settleMs: 1 },
        {
          processes: async () => {
            const { listProcesses } = await import('../../../utils/process-list.js');
            return listProcesses(['pid', 'ppid', 'args']);
          },
          frontmost: () => Promise.resolve(undefined),
          raise: () => Promise.resolve(false),
        }
      ).finish();
      // A sleep is no application this slot built, however close it sits in the tree.
      expect(real.browser).toBeUndefined();
    } finally {
      tree.stop();
    }
  });
});
