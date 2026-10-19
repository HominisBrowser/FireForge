// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { ConfigError } from '../../errors/config.js';
import { DEFAULT_CONFIG } from '../../test-utils/index.js';
import { validateConfig } from '../config-validate.js';
import { parseCheckConfig } from '../config-validate-check.js';

describe('parseCheckConfig', () => {
  it('accepts a full block', () => {
    const block = {
      skip: ['token-coverage'],
      status: { failOn: ['unmanaged'], allow: ['patch-backed'], failOnUnknown: true },
      maxWarnings: { lint: 0, furnace: 3 },
      extraSteps: [
        { name: 'policy-audit', command: 'npm run audit', cwd: 'tools', timeout: 120 },
        { name: 'invariants', command: 'node tools/check.mjs' },
      ],
    };
    expect(parseCheckConfig(block)).toEqual(block);
  });

  it('accepts timeouts, failOnSkipped, lintReport and ordered extra steps', () => {
    const block = {
      timeout: 900,
      timeouts: { lint: 120, typecheck: 300 },
      failOnSkipped: true,
      lintReport: '.fireforge/check/lint.json',
      extraSteps: [
        { name: 'policy', command: 'x', after: ['lint'] },
        { name: 'report', command: 'y', after: ['policy', 'typecheck'] },
      ],
    };
    expect(parseCheckConfig(block)).toEqual(block);
  });

  it.each<[string, unknown, RegExp]>([
    ['a zero timeout', { timeout: 0 }, /"check.timeout" must be a positive number/],
    ['an unknown timeouts step', { timeouts: { nope: 1 } }, /has unknown key "nope"/],
    ['a non-object timeouts', { timeouts: 3 }, /"check.timeouts" must be a plain object/],
    ['a non-boolean failOnSkipped', { failOnSkipped: 1 }, /failOnSkipped" must be a boolean/],
    ['an escaping lintReport', { lintReport: '../x.json' }, /must be a project-relative path/],
    [
      'an unknown after step',
      { extraSteps: [{ name: 'a', command: 'x', after: ['nope'] }] },
      /names unknown step "nope"/,
    ],
    [
      'an after naming itself',
      { extraSteps: [{ name: 'a', command: 'x', after: ['a'] }] },
      /names the step itself/,
    ],
    [
      'an ordering cycle',
      {
        extraSteps: [
          { name: 'a', command: 'x', after: ['b'] },
          { name: 'b', command: 'y', after: ['a'] },
        ],
      },
      /in a cycle: a -> b -> a/,
    ],
  ])('refuses %s', (_label, raw, message) => {
    expect(() => parseCheckConfig(raw)).toThrow(message);
  });

  it('is reached from validateConfig', () => {
    const config = validateConfig({ ...DEFAULT_CONFIG, check: { skip: ['typecheck'] } });
    expect(config.check).toEqual({ skip: ['typecheck'] });
  });

  it.each<[string, unknown, RegExp]>([
    ['a non-object block', [], /"check" must be a plain object/],
    ['an unknown key', { extra: 1 }, /"check" has unknown key "extra"/],
    ['an unknown skip step', { skip: ['nope'] }, /names unknown step "nope"/],
    [
      'a non-string skip entry',
      { skip: [1] },
      /"check.skip" must be an array of non-empty strings/,
    ],
    ['a non-object status', { status: 'x' }, /"check.status" must be a plain object/],
    ['an unknown status key', { status: { failon: [] } }, /"check.status" has unknown key/],
    [
      'a non-boolean failOnUnknown',
      { status: { failOnUnknown: 'yes' } },
      /failOnUnknown" must be a boolean/,
    ],
    ['a non-list allow', { status: { allow: 'x' } }, /"check.status.allow" must be an array/],
    ['a non-object maxWarnings', { maxWarnings: 1 }, /"check.maxWarnings" must be a plain object/],
    [
      'a negative warning budget',
      { maxWarnings: { lint: -1 } },
      /"check.maxWarnings.lint" must be a non-negative integer/,
    ],
    ['an unknown maxWarnings key', { maxWarnings: { tsc: 1 } }, /has unknown key "tsc"/],
    ['a non-array extraSteps', { extraSteps: {} }, /"check.extraSteps" must be an array/],
    ['a non-object step', { extraSteps: ['x'] }, /must be a plain object with "name"/],
    [
      'a bad step name',
      { extraSteps: [{ name: 'Bad Name', command: 'x' }] },
      /\.name" must be lowercase letters/,
    ],
    [
      'a built-in step name',
      { extraSteps: [{ name: 'lint', command: 'x' }] },
      /"lint" is a built-in step name/,
    ],
    [
      'an empty command',
      { extraSteps: [{ name: 'a', command: ' ' }] },
      /\.command" must be a non-empty string/,
    ],
    [
      'an escaping cwd',
      { extraSteps: [{ name: 'a', command: 'x', cwd: '../up' }] },
      /\.cwd" must be a project-relative path/,
    ],
    [
      'a zero timeout',
      { extraSteps: [{ name: 'a', command: 'x', timeout: 0 }] },
      /\.timeout" must be a positive number of seconds/,
    ],
    [
      'an unknown step key',
      { extraSteps: [{ name: 'a', command: 'x', env: {} }] },
      /has unknown key "env"/,
    ],
    [
      'a repeated step name',
      {
        extraSteps: [
          { name: 'a', command: 'x' },
          { name: 'a', command: 'y' },
        ],
      },
      /repeats the step name "a"/,
    ],
  ])('refuses %s', (_label, raw, message) => {
    expect(() => parseCheckConfig(raw)).toThrow(ConfigError);
    expect(() => parseCheckConfig(raw)).toThrow(message);
  });
});
