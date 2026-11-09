// SPDX-License-Identifier: EUPL-1.2
import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertComplete, printStatus } from '../../../commands/prove-report.js';
import type { ProofConfig } from '../../../types/config.js';
import type { ProofStatus } from '../evidence.js';
import { createProofPlan, type PlanInput } from '../plan.js';
import { componentDirectory, drawSample } from '../plan-consumers.js';
import { runtimeRoute } from '../route.js';
import type { ChangedPath, ProofPlan } from '../types.js';

const TOKEN = 'toolkit/themes/shared/design-system/tokens.css';
const change = (path: string): ChangedPath => ({
  path,
  tree: 'engine',
  route: runtimeRoute(path),
  deleted: false,
});

/** 500 tests across five directories that all mention the changed file by name. */
const DIRECTORIES = [
  'browser/components/tabs/test/browser',
  'browser/components/sidebar/test/browser',
  'toolkit/content/tests/widgets',
  'toolkit/themes/shared/design-system/tests',
  'browser/base/content/test/general',
];
const consumers = DIRECTORIES.flatMap((directory, at) =>
  Array.from({ length: at === 3 ? 4 : 124 }, (_, index) => ({
    path: `${directory}/browser_${String(index)}.js`,
    content: `// reads tokens.css\n`,
  }))
);

function plan(overrides: Partial<PlanInput> = {}): ProofPlan {
  return createProofPlan({
    tier: 'task',
    source: 'a'.repeat(64),
    base: { commit: 'b'.repeat(40), tree: 'c'.repeat(40), label: 'merge-base', narrowed: false },
    compiled: 'd'.repeat(64),
    changed: [change(TOKEN)],
    tests: consumers,
    touched: [{ path: TOKEN, content: ':root { --space-small: 4px; }\n' }],
    named: [],
    controlTargets: {},
    ...overrides,
  });
}

const sampled = (result: ProofPlan): string[] =>
  result.obligations.filter((entry) => entry.sampled === true).map((entry) => entry.id.slice(5));

describe('a declared sample of consumers over the limit', () => {
  it('names --sample in the refusal it replaces', () => {
    expect(() => plan()).toThrow(/proof-consumer-limit: 500 tests .*--sample <n>/);
  });

  it('runs a recorded sample, says how many of how many, and lists what it left out', () => {
    const result = plan({ sample: 20 });
    expect(result.sample?.of).toBe(500);
    expect(result.sample?.requested).toBe(20);
    expect(result.sample?.sampled).toHaveLength(20);
    expect(result.sample?.unsampled).toHaveLength(480);
    expect(sampled(result)).toEqual(result.sample?.sampled);
    expect([...(result.sample?.sampled ?? []), ...(result.sample?.unsampled ?? [])].sort()).toEqual(
      consumers.map((file) => file.path).sort()
    );
    expect(result.notes.join('\n')).toContain(
      'Sampled 20 of 500 direct consumers; 480 did not run'
    );
  });

  it('always holds the consumers beside what changed, and draws from every directory', () => {
    const result = plan({ sample: 9 });
    const drawn = result.sample?.sampled ?? [];
    for (const index of [0, 1, 2, 3])
      expect(drawn).toContain(
        `toolkit/themes/shared/design-system/tests/browser_${String(index)}.js`
      );
    for (const directory of DIRECTORIES)
      expect(drawn.some((path) => path.startsWith(`${directory}/`))).toBe(true);
  });

  it('draws the same tests for the same change, and others when the change differs', () => {
    const first = plan({ sample: 15 });
    expect(plan({ sample: 15 }).sample).toEqual(first.sample);
    // Editing the same file again keeps the sample: its seed is the changed paths, not their bytes.
    expect(
      plan({ sample: 15, touched: [{ path: TOKEN, content: ':root { --space-small: 6px; }\n' }] })
        .sample?.sampled
    ).toEqual(first.sample?.sampled);
    const other = plan({
      sample: 15,
      changed: [change(TOKEN), change('toolkit/themes/shared/global.css')],
    });
    expect(other.sample?.seed).not.toBe(first.sample?.seed);
    expect(other.sample?.sampled).not.toEqual(first.sample?.sampled);
  });

  it('represents every lane, growing past the size asked for when it has to', () => {
    const proof: ProofConfig = {
      gate: {
        lanes: DIRECTORIES.map((directory, index) => ({
          id: `lane${String(index)}`,
          files: [`${directory}/browser_*.js`],
        })),
      },
    };
    const result = plan({ sample: 2, proof });
    const drawn = result.sample?.sampled ?? [];
    expect(drawn.length).toBeGreaterThan(2);
    for (const directory of DIRECTORIES)
      expect(drawn.some((path) => path.startsWith(`${directory}/`))).toBe(true);
    expect(result.notes.join('\n')).toContain('rather than 2');
  });

  it('leaves named tests out of the pool, where they run anyway', () => {
    const named = `${DIRECTORIES[0] ?? ''}/browser_7.js`;
    const result = plan({ sample: 10, named: [named] });
    expect(result.sample?.of).toBe(499);
    expect(result.sample?.sampled).not.toContain(named);
    expect(
      result.obligations.find((entry) => entry.id === `test:${named}`)?.sampled
    ).toBeUndefined();
  });

  it('draws nothing within the limit, where every consumer runs', () => {
    const result = plan({ sample: 3, tests: consumers.slice(0, 10) });
    expect(result.sample).toBeUndefined();
    expect(result.obligations.filter((entry) => entry.kind === 'test')).toHaveLength(10);
  });

  it('never stands for a gate', () => {
    expect(() => plan({ tier: 'gate', sample: 5, proof: { gate: { lanes: [] } } })).toThrow(
      /proof-sample-gate/
    );
  });

  it('places a test by the directory above its test directory', () => {
    expect(componentDirectory('browser/components/tabs/test/browser/browser_a.js')).toBe(
      'browser/components/tabs'
    );
    expect(componentDirectory('browser/base/browser_a.js')).toBe('browser/base');
    expect(componentDirectory('test/browser_a.js')).toBe('test');
  });

  it('stops when every consumer is drawn', () => {
    const { sample } = drawSample(10, ['a/test/browser_1.js'], [change(TOKEN)], []);
    expect(sample.sampled).toEqual(['a/test/browser_1.js']);
    expect(sample.unsampled).toEqual([]);
  });
});

describe('the report of a sampled plan', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Every obligation of the plan passed. */
  const passed = (result: ProofPlan): ProofStatus => ({
    complete: true,
    obligations: result.obligations.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      state: 'passed',
      reason: entry.reason,
      reds: 0,
    })),
    waived: [],
    failures: [],
    finished: 1,
  });

  it('reads as sampled, names what did not run, and still claims a task complete', () => {
    const result = plan({ sample: 20 });
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    printStatus(result, passed(result));
    const text = lines.join('');
    expect(text).toContain(
      `sampled 20 of 500 consumers (seed ${result.sample?.seed.slice(0, 12) ?? ''}); not run: ${result.sample?.unsampled.slice(0, 20).join(', ') ?? ''} and 460 more (--json lists every one)`
    );
    expect(text).toMatch(/Proof sampled: \d+ of \d+ obligations\n$/);
    expect(() => {
      assertComplete(result, passed(result));
    }).not.toThrow();
  });

  it('lists every test it left out when there are few', () => {
    const result = plan({ sample: 12, tests: consumers.slice(0, 14) });
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    printStatus(result, { ...passed(result), complete: false });
    expect(lines.join('')).toContain(`not run: ${result.sample?.unsampled.join(', ') ?? ''}\n`);
    expect(lines.join('')).toMatch(/Proof incomplete/);
  });
});
