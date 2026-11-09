// SPDX-License-Identifier: EUPL-1.2
import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitReporter } from '../../../commands/job-support.js';
import type { JobProgress } from '../job-progress.js';
import type { JobView } from '../schema.js';
import { waitProgress } from '../wait-progress.js';

const labels = ['check', 'lane:tiles', 'lane:menus'];

function view(
  step: number,
  running: boolean,
  states: JobProgress['results'],
  blockedBy?: string
): JobView {
  return {
    id: 'job-1',
    state: running ? 'running' : 'queued',
    ...(blockedBy === undefined ? {} : { blockedBy }),
    progress: {
      step,
      steps: labels.length,
      label: labels[step] ?? 'sealing',
      running,
      ...(running ? { stepSeconds: 64 * 60 } : {}),
      elapsedSeconds: 3_840,
      results: states,
    },
  } as unknown as JobView;
}
const done = (step: number, state: 'passed' | 'red'): JobProgress['results'][number] => ({
  step,
  label: labels[step] ?? '',
  state,
});

describe('waitProgress', () => {
  it('says a step once and each finished step once, as the job moves', () => {
    const lines: string[] = [];
    const report = waitProgress((line) => lines.push(line));
    report(view(0, true, []));
    report(view(0, true, []));
    report(view(1, true, [done(0, 'red')]));
    report(view(1, true, [done(0, 'red')]));
    report(view(2, true, [done(0, 'red'), done(1, 'passed')]));
    expect(lines).toEqual([
      'step 1/3 check, running 1h04m, 1h04m in',
      'step 1/3 check: red',
      'step 2/3 lane:tiles, running 1h04m, 1h04m in, passed 0 red 1 blocked 0',
      'step 2/3 lane:tiles: passed',
      'step 3/3 lane:menus, running 1h04m, 1h04m in, passed 1 red 1 blocked 0',
    ]);
  });

  it('does not replay steps finished before the wait began', () => {
    const lines: string[] = [];
    const report = waitProgress((line) => lines.push(line));
    report(view(2, true, [done(0, 'passed'), done(1, 'passed')]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('step 3/3 lane:menus');
  });

  it('leaves a queued step to its blocked reason, and says it once that clears', () => {
    const lines: string[] = [];
    const report = waitProgress((line) => lines.push(line));
    report(view(1, false, [done(0, 'passed')], 'slot a is busy'));
    expect(lines).toEqual([]);
    report(view(1, false, [done(0, 'passed')]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('waiting');
  });

  it('says nothing for a job with no progress', () => {
    const lines: string[] = [];
    waitProgress((line) => lines.push(line))({ id: 'job-1', state: 'queued' } as JobView);
    expect(lines).toEqual([]);
  });
});

describe('waitReporter', () => {
  const argv = process.argv;
  afterEach(() => {
    process.argv = argv;
    vi.restoreAllMocks();
  });

  it('writes plain lines to stderr with no carriage returns', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    waitReporter()?.(view(0, true, []));
    expect(write).toHaveBeenCalledTimes(1);
    const text = String(write.mock.calls[0]?.[0]);
    expect(text).toMatch(/^step 1\/3 check.*\n$/);
    expect(text).not.toContain('\r');
  });

  it('is absent under --json and --raw', () => {
    process.argv = [...argv, '--json'];
    expect(waitReporter()).toBeUndefined();
    process.argv = [...argv, '--raw'];
    expect(waitReporter()).toBeUndefined();
  });
});
