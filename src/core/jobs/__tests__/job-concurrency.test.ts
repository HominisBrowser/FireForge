// SPDX-License-Identifier: EUPL-1.2
/** `--jobs` has one meaning: what submit admits is what is reserved and what the CLI runs with. */
import { describe, expect, it } from 'vitest';

import { adapterJobs, withAdapterJobs } from '../adapter-arguments.js';
import { authorizeRequest } from '../admission.js';
import {
  type CoordinatorConfig,
  derivedResources,
  type JobRequest,
  type JobStep,
  validateRequest,
} from '../schema.js';

const capacity = { cpu: 32, memory: 64, build: 1, browser: 1, display: 1 };
const config: CoordinatorConfig = {
  schemaVersion: 1,
  capacity,
  maxSlots: 1,
  idleMs: 1,
  legacyExcluded: true,
  projects: [],
  runtime: { node: process.execPath, environment: {} },
};

function request(step: JobStep): JobRequest {
  return {
    schemaVersion: 1,
    key: 'k',
    slot: 'a',
    sourceId: 'a'.repeat(64),
    steps: [step],
    quiet: false,
  };
}

const SPELLINGS = [['-j16'], ['-j', '16'], ['--jobs=16'], ['--jobs', '16']];

describe('build --jobs', () => {
  it.each(SPELLINGS)('%s is admitted, reserved and run as 16', (...args) => {
    const step: JobStep = { command: 'build', args };
    expect(adapterJobs(step)).toBe(16);
    expect(() => {
      validateRequest(request(step));
    }).not.toThrow();
    expect(() => {
      authorizeRequest(request(step), config);
    }).not.toThrow();
    expect(derivedResources(step, capacity).cpu).toBe(16);
    expect(withAdapterJobs(step, 4)).toEqual(['--jobs', '16']);
  });

  it('refuses a duplicate at submit, whatever the spelling', () => {
    for (const args of [
      ['--jobs', '2', '--jobs', '16'],
      ['-j2', '--jobs=16'],
      ['-j', '16', '-j16'],
    ]) {
      expect(() => {
        validateRequest(request({ command: 'build', args }));
      }).toThrow(/--jobs is given more than once/);
    }
  });

  it('refuses a value that is no positive whole number', () => {
    for (const args of [['-j=16'], ['--jobs', '0'], ['--jobs=1.5'], ['-jx']])
      expect(() => {
        validateRequest(request({ command: 'build', args }));
      }).toThrow();
  });

  it('refuses more than the host has', () => {
    const step: JobStep = { command: 'build', args: ['-j64'] };
    expect(() => {
      authorizeRequest(request(step), config);
    }).toThrow(/concurrency/);
  });

  it('runs with the granted CPU when none is given', () => {
    const step: JobStep = { command: 'build', args: ['--ui'] };
    expect(adapterJobs(step)).toBeUndefined();
    expect(withAdapterJobs(step, 4)).toEqual(['--ui', '--jobs', '4']);
  });
});

describe('test and check --jobs', () => {
  it('reads a test step’s --jobs the same way', () => {
    expect(adapterJobs({ command: 'test', args: ['--jobs=2', 'a.js'] })).toBe(2);
    expect(() => {
      validateRequest(request({ command: 'test', args: ['--jobs', '1', '--jobs', '2'] }));
    }).toThrow(/--jobs is given more than once/);
  });

  it('reads a check step’s --jobs, and refuses a duplicate', () => {
    expect(adapterJobs({ command: 'check', args: ['--jobs', '3'] })).toBe(3);
    expect(derivedResources({ command: 'check', args: ['--jobs', '3'] }, capacity).cpu).toBe(3);
    expect(withAdapterJobs({ command: 'check', args: ['--jobs=3'] }, 8)).toEqual(['--jobs', '3']);
    expect(() => {
      validateRequest(request({ command: 'check', args: ['--jobs', '1', '--jobs', '1'] }));
    }).toThrow();
  });
});
