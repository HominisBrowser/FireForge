// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { validateRequest } from '../schema.js';
import { stepOutputDirectory } from '../step-environment.js';
import { expandOutputOptions, validatorInvocation, validatorScript } from '../step-validate.js';

const request = (step: Record<string, unknown>): unknown => ({
  schemaVersion: 1,
  key: 'k',
  sourceId: 'a'.repeat(64),
  quiet: false,
  steps: [step],
});

describe('a step validator', () => {
  const test = { command: 'test', args: ['browser_a.js'], expected: { files: ['browser_a.js'] } };

  it('is admitted on a test, and refused anywhere a build would run under it', () => {
    const validate = { command: ['node', 'tools/v.mjs', '{artifacts}/census.json'] };
    expect(() => {
      validateRequest(request({ ...test, validate }));
    }).not.toThrow();
    expect(() => {
      validateRequest(request({ command: 'build', args: [], validate }));
    }).toThrow(/no build/);
    expect(() => {
      validateRequest(request({ ...test, args: ['--build', 'browser_a.js'], validate }));
    }).toThrow(/no build/);
    for (const command of ['sh', '/bin/sh', '../x', '~/x'])
      expect(() => {
        validateRequest(request({ ...test, validate: { command: [command, 'x'] } }));
      }).toThrow(/Step validate/);
    expect(() => {
      validateRequest(request({ ...test, validate: { command: 'node x' } }));
    }).toThrow(/argument array/);
    for (const command of [
      ['node'],
      ['node', '-e', 'process.exit(0)'],
      ['node', '--eval=process.exit(0)'],
      ['node', '-p', '1'],
      ['node', '--import', 'x', 'tools/v.mjs'],
    ])
      expect(() => {
        validateRequest(request({ ...test, validate: { command } }));
      }).toThrow(/node on a captured script/);
  });

  it('runs node as this phase runs it, and expands the output directory everywhere', () => {
    const validator = { command: ['node', 'tools/v.mjs', '--from={artifacts}/a', '{artifacts}'] };
    expect(validatorInvocation(validator, '/out')).toEqual({
      command: process.execPath,
      args: ['tools/v.mjs', '--from=/out/a', '/out'],
    });
    expect(validatorScript(validator)).toBe('tools/v.mjs');
    const script = { command: ['tools/v.sh', 'x'] };
    expect(validatorInvocation(script, undefined).command).toBe('tools/v.sh');
    expect(validatorScript(script)).toBe('tools/v.sh');
  });

  it('gives a step that names its output a directory, whichever field names it', () => {
    const directory = (step: Record<string, unknown>): string | undefined =>
      stepOutputDirectory('/n', 'j', 0, { command: 'test', args: [], ...step });
    expect(directory({})).toBeUndefined();
    expect(directory({ validate: { command: ['node', 'x'] } })).toBeUndefined();
    expect(directory({ validate: { command: ['node', 'x', '{artifacts}/y'] } })).toBe(
      '/n/artifacts/j/step-0-output'
    );
    expect(directory({ args: ['--perf-samples', '{artifacts}/p.json'] })).toBe(
      '/n/artifacts/j/step-0-output'
    );
  });

  it('expands a perf sample path and no other argument', () => {
    expect(
      expandOutputOptions(
        'test',
        ['--perf-samples', '{artifacts}/p.json', '{artifacts}', 'a'],
        '/out'
      )
    ).toEqual(['--perf-samples', '/out/p.json', '{artifacts}', 'a']);
    expect(expandOutputOptions('test', ['--perf-samples={artifacts}/p'], '/out')).toEqual([
      '--perf-samples=/out/p',
    ]);
  });

  it('expands every path a run or test writes, and only for the adapter that writes it', () => {
    expect(
      expandOutputOptions(
        'run',
        ['--capture-console', '{artifacts}/console.txt', '--screenshot={artifacts}/s.png'],
        '/out'
      )
    ).toEqual(['--capture-console', '/out/console.txt', '--screenshot=/out/s.png']);
    expect(
      expandOutputOptions(
        'test',
        [
          '--keep-log',
          '{artifacts}/t.log',
          '--coverage={artifacts}/lcov',
          '--pgid-file',
          '{artifacts}/g',
        ],
        '/out'
      )
    ).toEqual(['--keep-log', '/out/t.log', '--coverage=/out/lcov', '--pgid-file', '/out/g']);
    // An input stays as written, and a run has no --perf-samples.
    expect(
      expandOutputOptions(
        'run',
        ['--console-allow-file', '{artifacts}/a', '--perf-samples', '{artifacts}/p'],
        '/out'
      )
    ).toEqual(['--console-allow-file', '{artifacts}/a', '--perf-samples', '{artifacts}/p']);
    const directory = (args: string[]): string | undefined =>
      stepOutputDirectory('/n', 'j', 0, { command: 'run', args });
    expect(directory(['--smoke-exit', '20', '--capture-console', '{artifacts}/c.txt'])).toBe(
      '/n/artifacts/j/step-0-output'
    );
    expect(directory(['--capture-console', 'c.txt'])).toBeUndefined();
  });
});
