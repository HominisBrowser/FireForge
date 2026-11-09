// SPDX-License-Identifier: EUPL-1.2
/** What a check step keeps of a chatty child's output: bounded, and still enough to summarize. */
import { describe, expect, it } from 'vitest';

import { type CheckStepPlan, lastOutputLine, summarizeStatus } from '../../core/check/steps.js';
import { runCheckSteps } from '../check-run.js';

const EIGHT_MIB = 8 * 1024 * 1024;

function step(name: string, script: string, overrides: Partial<CheckStepPlan> = {}): CheckStepPlan {
  return {
    name,
    kind: 'extra',
    command: process.execPath,
    args: ['-e', script],
    display: name,
    cwd: process.cwd(),
    after: [],
    summarize: ({ combined, exitCode }) => lastOutputLine(combined, exitCode),
    ...overrides,
  };
}

/** Writes 8 MiB to stdout in 64 KiB lines, then a last line, and exits with `code`. */
const chatty = (last: string, code: number): string =>
  `const line = 'x'.repeat(65535) + '\\n';
   let left = ${String(EIGHT_MIB)} / 65536;
   const write = () => {
     while (left > 0) { left--; if (!process.stdout.write(line)) return process.stdout.once('drain', write); }
     process.stdout.write(${JSON.stringify(`${last}\n`)}, () => process.exit(${String(code)}));
   };
   write();`;

describe('a check step’s retained output', () => {
  it('stays bounded for a child writing 8 MiB, and its summary still works', async () => {
    const seen: Array<{ stdout: number; combined: number }> = [];
    const [result] = await runCheckSteps(
      [
        step('chatty', chatty('the refusal', 3), {
          summarize: ({ stdout, combined, exitCode }) => {
            seen.push({ stdout: stdout.length, combined: combined.length });
            return lastOutputLine(combined, exitCode);
          },
        }),
      ],
      1
    );
    expect(result).toMatchObject({ status: 'fail', exitCode: 3, detail: 'the refusal' });
    expect(seen[0]?.combined).toBeLessThanOrEqual(256 * 1024);
    // A step that reads no document from its stdout keeps none of it.
    expect(seen[0]?.stdout).toBe(0);
  }, 60_000);

  it('keeps a JSON document for a step that reads one, and drops one too large to keep', async () => {
    const document = JSON.stringify({ summary: { total: 2 }, check: { offenders: [] } });
    const [small, large] = await runCheckSteps(
      [
        step('small', `process.stdout.write(${JSON.stringify(document)})`, {
          summarize: summarizeStatus,
          stdoutDocument: true,
        }),
        step('large', chatty('{"broken":', 1), {
          summarize: summarizeStatus,
          stdoutDocument: true,
        }),
      ],
      2
    );
    expect(small?.detail).toBe('2 changed file(s), none failing');
    expect(large).toMatchObject({ status: 'fail', detail: '{"broken":' });
  }, 60_000);
});
