// SPDX-License-Identifier: EUPL-1.2
/** A check is the most parallel work there is, so a declared footprint has to keep it that way. */
import { describe, expect, it } from 'vitest';

import { ConfigError } from '../../../errors/config.js';
import { validateConfig } from '../../config-validate.js';
import { planAdmission } from '../admission.js';
import { derivedResources, hostCapacity, type JobRecord, type ResourceVector } from '../schema.js';

const capacity: ResourceVector = { cpu: 14, memory: 28, build: 1, browser: 1, display: 1 };
const check = { command: 'check' as const, args: [] };

/** Hominis's nine project steps, as `fireforge.json` declares them with footprints. */
const nine = { cpu: 6 + 9, memory: 2 };

function job(id: string, ticket: number, vector: ResourceVector, active = false): JobRecord {
  return {
    schemaVersion: 1,
    id,
    owner: 'x',
    state: active ? 'running' : 'queued',
    epoch: 1,
    submittedAt: '',
    updatedAt: '',
    cancellationRequested: false,
    stepResources: [vector],
    slot: id,
    phase: { index: 0, active, ticket },
    request: {
      schemaVersion: 1,
      key: id,
      slot: id,
      sourceId: 's',
      steps: [check],
      quiet: false,
    },
  };
}

describe('a check with static footprints', () => {
  it('claims a quarter of the host, enough to stay parallel and to fit beside a build', () => {
    const vector = derivedResources(check, capacity, undefined, nine);
    expect(vector.cpu).toBe(4);
    expect(vector.build + vector.browser + vector.display).toBe(0);
    const build = derivedResources({ command: 'build', args: [] }, capacity);
    expect(build.cpu + vector.cpu).toBeLessThanOrEqual(capacity.cpu);
  });

  it('never claims more than its steps can use, and at least two', () => {
    expect(derivedResources(check, capacity, undefined, { cpu: 3, memory: 0 }).cpu).toBe(3);
    expect(derivedResources(check, capacity, undefined, { cpu: 1, memory: 0 }).cpu).toBe(2);
    expect(derivedResources(check, { ...capacity, cpu: 4 }, undefined, nine).cpu).toBe(2);
  });

  it('takes the largest memory any step declared', () => {
    expect(derivedResources(check, capacity, undefined, { cpu: 8, memory: 6 }).memory).toBe(6);
  });

  it('admits beside a peer’s browser test and a peer’s build, and is not quiet', () => {
    const vector = derivedResources(check, capacity, undefined, nine);
    const test = job(
      'test',
      1,
      derivedResources({ command: 'test', args: ['--headless', 'a.js'] }, capacity),
      true
    );
    const build = job('build', 2, derivedResources({ command: 'build', args: [] }, capacity), true);
    const waiting = job('check', 3, vector);
    const plan = planAdmission([test, waiting], { config: { capacity } });
    expect(plan.admit.map((entry) => entry.job.id)).toEqual(['check']);
    const beside = planAdmission([build, waiting], { config: { capacity } });
    expect(beside.admit.map((entry) => entry.job.id)).toEqual(['check']);
  });
});

describe('the footprint in configuration', () => {
  const config = (extra: unknown): unknown => ({
    name: 'Fixture',
    vendor: 'Example',
    binaryName: 'fixture',
    appId: 'invalid.example.fixture',
    firefox: { version: '153.6.0esr', product: 'firefox-esr', sha256: 'a'.repeat(64) },
    check: { extraSteps: [{ name: 'audit', command: 'true', ...(extra as object) }] },
  });

  it('accepts a typed footprint and keeps it', () => {
    const parsed = validateConfig(config({ footprint: { static: true, cpu: 2, memory: 3 } }));
    expect(parsed.check?.extraSteps?.[0]?.footprint).toEqual({ static: true, cpu: 2, memory: 3 });
  });

  it.each([
    [{ footprint: 'static' }],
    [{ footprint: { cpu: 2 } }],
    [{ footprint: { static: 'yes' } }],
    [{ footprint: { static: true, cpu: 0 } }],
    [{ footprint: { static: true, memory: 1.5 } }],
    [{ footprint: { static: true, disk: 1 } }],
  ])('refuses %j', (extra) => {
    expect(() => validateConfig(config(extra))).toThrow(ConfigError);
  });

  it('host capacity stays what the host has', () => {
    expect(hostCapacity().cpu).toBeGreaterThan(0);
  });
});
