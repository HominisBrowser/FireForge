// SPDX-License-Identifier: EUPL-1.2
import { afterEach, describe, expect, it } from 'vitest';

import * as log from '../kernel/log.js';
import { resetShutdown, runShutdown } from '../kernel/signals.js';
import { formatVerdict, Output } from './output.js';

function capture(json: boolean): { out: Output; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  previousLog = log.configureLog({ write: (text) => stderr.push(text) });
  return { out: new Output((text) => stdout.push(text), json), stdout, stderr };
}

let previousLog: log.LogConfig | undefined;
afterEach(() => {
  if (previousLog !== undefined) log.configureLog(previousLog);
  previousLog = undefined;
  resetShutdown();
});

describe('formatVerdict', () => {
  it.each([
    [true, undefined, 'FIREFORGE-VERDICT: PASS'],
    [
      false,
      { reason: 'test-failures', failed: 3 },
      'FIREFORGE-VERDICT: FAIL reason=test-failures failed=3',
    ],
    [
      true,
      { steps: 4, skipped: 0, selection: undefined },
      'FIREFORGE-VERDICT: PASS steps=4 skipped=0',
    ],
    [
      false,
      { reason: 'preflight', log: '/tmp/my logs/run 100%.log' },
      'FIREFORGE-VERDICT: FAIL reason=preflight log=/tmp/my%20logs/run%20100%25.log',
    ],
  ])('renders pass=%s with %j', (pass, fields, expected) => {
    expect(formatVerdict(pass, fields)).toBe(expected);
  });
});

describe('Output without --json', () => {
  it('writes result lines and raw text to stdout and ignores the JSON document', () => {
    const { out, stdout } = capture(false);
    out.line('3 patches');
    out.line();
    out.write('diff --git a/x b/x\n');
    out.json({ patches: 3 });
    expect(stdout).toEqual(['3 patches\n', '\n', 'diff --git a/x b/x\n']);
  });

  it('seals stdout behind the verdict: later lines go to stderr, a second verdict nowhere', () => {
    const { out, stdout, stderr } = capture(false);
    out.line('running');
    out.verdict(false, { reason: 'test-failures' });
    out.line('see the log');
    out.verdict(true);
    expect(stdout).toEqual(['running\n', 'FIREFORGE-VERDICT: FAIL reason=test-failures\n']);
    expect(stderr).toEqual(['see the log\n']);
  });

  it('owes a failing verdict when the run expected one and failed before writing it', () => {
    const { out, stdout } = capture(false);
    out.expectVerdict();
    out.fail({ message: 'Timed out', code: 'lock-timeout' });
    out.close();
    expect(stdout).toEqual(['FIREFORGE-VERDICT: FAIL reason=lock-timeout\n']);
  });

  it('writes nothing to stdout for a failure of a command without a verdict', () => {
    const { out, stdout } = capture(false);
    out.fail({ message: 'No engine', code: 'engine-missing' });
    expect(stdout).toEqual([]);
  });

  it('says "killed" first when a run that expects a verdict is interrupted', async () => {
    const { out, stdout } = capture(false);
    out.expectVerdict();
    const pipeline = runShutdown('SIGTERM');
    expect(stdout).toEqual(['FIREFORGE-VERDICT: FAIL reason=killed signal=SIGTERM\n']);
    await pipeline;
    out.fail({ message: 'mach exited 143', code: 'build-failed' });
    expect(stdout).toHaveLength(1);
  });

  it('stops listening for interrupts once closed', async () => {
    const { out, stdout } = capture(false);
    out.expectVerdict();
    out.verdict(true);
    out.close();
    await runShutdown('SIGINT');
    expect(stdout).toEqual(['FIREFORGE-VERDICT: PASS\n']);
  });
});

describe('Output with --json', () => {
  it('writes exactly the one document, with schemaVersion first, and no human lines or verdict', () => {
    const { out, stdout } = capture(true);
    out.line('3 patches');
    out.write('raw');
    out.json({ patches: 3, names: ['a'] });
    out.verdict(true);
    expect(stdout).toEqual(['{"schemaVersion":1,"patches":3,"names":["a"]}\n']);
    expect(() => {
      out.json({ again: true });
    }).toThrow(expect.objectContaining({ code: 'internal' }) as Error);
  });

  it('writes the failure envelope, unless the command already wrote its document', () => {
    const failed = capture(true);
    failed.out.fail({ message: 'No engine', code: 'engine-missing', hint: 'Run setup' });
    expect(failed.stdout).toEqual([
      '{"schemaVersion":1,"error":"No engine","code":"engine-missing","hint":"Run setup"}\n',
    ]);
    const refused = capture(true);
    refused.out.json({ dirty: 2 });
    refused.out.fail({ message: 'Dirty tree', code: 'dirty' });
    expect(refused.stdout).toEqual(['{"schemaVersion":1,"dirty":2}\n']);
  });
});
