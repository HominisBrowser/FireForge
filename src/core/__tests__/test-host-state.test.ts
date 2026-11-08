// SPDX-License-Identifier: EUPL-1.2
/**
 * What the verdict line says about the machine a run ran on. Only the spawned
 * tools are stubbed, with the output they print.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/process.js', () => ({ exec: vi.fn() }));

const host = vi.hoisted(() => ({ loads: [] as number[] }));
vi.mock('node:os', async (original) => {
  const actual = await original<typeof import('node:os')>();
  // Each read takes the next queued one-minute load; an empty queue reads the real one.
  return { ...actual, loadavg: () => [host.loads.shift() ?? actual.loadavg()[0] ?? 0, 0, 0] };
});

import { exec } from '../../utils/process.js';
import {
  type HostVerdictAttribute,
  mergeHostAttributes,
  parseDisplaySleepState,
  sampleTestHost,
  type TestHostState,
  watchForHostSleep,
  watchHostLoad,
} from '../test-host-state.js';

const ASLEEP = `Graphics/Displays:\n  Displays:\n    Built-in:\n      Online: Yes\n      Display Asleep: Yes\n`;
const AWAKE = `Graphics/Displays:\n  Displays:\n    Built-in:\n      Online: Yes\n`;

function stubTools(tools: Record<string, string>): void {
  vi.mocked(exec).mockImplementation((command: string) =>
    command in tools
      ? Promise.resolve({ stdout: tools[command] ?? '', stderr: '', exitCode: 0 })
      : Promise.reject(new Error(`${command} is not installed`))
  );
}

const realPlatform = process.platform;
const asPlatform = (platform: string): void => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
};

// The display reading is cached for 30 s by wall clock, so each test starts a
// minute after the previous one and never inherits its reading.
let clock = 1_800_000_000_000;

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime((clock += 60_000));
  asPlatform('darwin');
});

afterEach(() => {
  asPlatform(realPlatform);
  vi.useRealTimers();
});

describe('parseDisplaySleepState', () => {
  it.each([
    [ASLEEP, 'asleep'],
    [AWAKE, 'awake'],
    ['Graphics/Displays:\n  Chipset Model: Apple M3\n', 'unknown'],
    ['', 'unknown'],
  ])('reads %j as %s', (stdout, state) => {
    expect(parseDisplaySleepState(stdout)).toBe(state);
  });
});

describe('sampleTestHost', () => {
  it('measures the display and the power source together', async () => {
    stubTools({
      ps: ' 12.0 node\n',
      pmset: "Now drawing from 'Battery Power'\n",
      system_profiler: ASLEEP,
    });
    expect(await sampleTestHost()).toMatchObject({
      power: 'battery',
      display: 'asleep',
      topProcess: { cpu: 12, command: 'node' },
    });
  });

  it('serves one display reading across a burst of dispatches', async () => {
    stubTools({ ps: '', pmset: '', system_profiler: AWAKE });
    await sampleTestHost();
    await sampleTestHost();
    const profilerRuns = vi
      .mocked(exec)
      .mock.calls.filter(([command]) => command === 'system_profiler');
    expect(profilerRuns).toHaveLength(1);
  });

  it('says unknown, never a guess, when the tools are missing or the OS has none', async () => {
    stubTools({});
    expect(await sampleTestHost()).toMatchObject({ power: 'unknown', display: 'unknown' });
    asPlatform('linux');
    vi.mocked(exec).mockClear();
    expect(await sampleTestHost()).toMatchObject({ power: 'unknown', display: 'unknown' });
    expect(vi.mocked(exec)).not.toHaveBeenCalledWith(
      'system_profiler',
      expect.anything(),
      expect.anything()
    );
  });
});

describe('watchForHostSleep', () => {
  it('stays quiet across a run that merely took its time', () => {
    vi.useFakeTimers();
    const stop = watchForHostSleep();
    vi.advanceTimersByTime(10 * 60_000);
    expect(stop()).toBe(false);
  });

  it('notices a wall-clock gap, as a machine waking from sleep leaves behind', () => {
    vi.useFakeTimers();
    const stop = watchForHostSleep();
    vi.advanceTimersByTime(10_000);
    // Timers do not run while suspended, so the clock jumps with no tick.
    vi.setSystemTime(Date.now() + 20 * 60_000);
    vi.advanceTimersByTime(5_000);
    vi.advanceTimersByTime(10_000);
    expect(stop()).toBe(true);
  });

  it('notices a sleep the last tick has not yet seen', () => {
    vi.useFakeTimers();
    const stop = watchForHostSleep();
    vi.setSystemTime(Date.now() + 20 * 60_000);
    expect(stop()).toBe(true);
  });
});

describe('watchHostLoad', () => {
  it('sees a rise between a suite’s edges, and when', () => {
    vi.useFakeTimers();
    const started = Date.now();
    host.loads = [2, 3, 41.237, 12, 2];
    const stop = watchHostLoad();
    vi.advanceTimersByTime(90_000);
    expect(stop()).toEqual({ load: 41.237, at: started + 60_000 });
  });

  it('measures nothing on Windows, whose load average reads zero', () => {
    asPlatform('win32');
    host.loads = [9];
    expect(watchHostLoad()()).toBeUndefined();
    host.loads = [];
  });
});

describe('mergeHostAttributes', () => {
  const sample = (overrides: Partial<TestHostState> = {}): TestHostState => ({
    load: 1,
    power: 'ac',
    display: 'awake',
    ...overrides,
  });
  const merge = (
    previous: Partial<Record<HostVerdictAttribute, string>>,
    samples: TestHostState[],
    warned = false,
    slept = false
  ): ReturnType<typeof mergeHostAttributes> =>
    mergeHostAttributes((key) => previous[key], samples, warned, slept);

  it('stamps display and power on every run, measured or not', () => {
    expect(merge({}, [sample({ power: 'unknown', display: 'unknown' })])).toEqual({
      'host-load': '1.00',
      display: 'unknown',
      'power-source': 'unknown',
    });
  });

  it('keeps the worst of a dispatch and of the dispatches before it', () => {
    expect(
      merge({ 'host-load': '7.50', display: 'asleep', 'power-source': 'battery' }, [sample()])
    ).toEqual({
      'host-load': '7.50',
      display: 'asleep',
      'power-source': 'battery',
      'power-changed': 'true',
    });
  });

  it('keeps the flags an earlier dispatch raised', () => {
    expect(merge({ 'host-cpu-warning': 'true', 'host-slept': 'true' }, [sample()])).toMatchObject({
      'host-cpu-warning': 'true',
      'host-slept': 'true',
    });
    expect(merge({}, [sample()], true, true)).toMatchObject({
      'host-cpu-warning': 'true',
      'host-slept': 'true',
    });
    expect(merge({}, [sample()])).not.toHaveProperty('host-slept');
  });

  it('keeps the highest load peak of every dispatch, when it came, and warns for it', () => {
    const peaked = mergeHostAttributes(() => undefined, [sample()], false, false, {
      load: 38.204,
      atSeconds: 412,
    });
    expect(peaked).toMatchObject({
      'host-load': '1.00',
      'host-load-peak': '38.20',
      'host-load-peak-at': '412',
      'host-cpu-warning': 'true',
    });
    // A later, quieter shard leaves the earlier peak standing.
    const later = mergeHostAttributes((key) => peaked[key], [sample()], false, false, {
      load: 3,
      atSeconds: 900,
    });
    expect(later).not.toHaveProperty('host-load-peak');
    expect(later).toMatchObject({ 'host-cpu-warning': 'true' });
    expect(
      mergeHostAttributes(() => undefined, [sample()], false, false, { load: 3.99, atSeconds: 5 })
    ).not.toHaveProperty('host-cpu-warning');
  });

  it('names a power change within one dispatch', () => {
    expect(merge({}, [sample({ power: 'ac' }), sample({ power: 'battery' })])).toMatchObject({
      'power-source': 'battery',
      'power-changed': 'true',
    });
  });
});
