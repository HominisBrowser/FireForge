// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { ExitCode } from '../codes.js';
import {
  ConfigError,
  ConfigNotFoundError,
  InvalidFieldError,
  MissingFieldError,
} from '../config.js';

describe('config errors', () => {
  it('formats ConfigError with field details and recovery steps', () => {
    const error = new ConfigError('Something is wrong', 'firefox.version');

    expect(error.code).toBe(ExitCode.CONFIG_ERROR);
    expect(error.userMessage).toContain('Configuration Error: Something is wrong');
    expect(error.userMessage).toContain('Field: firefox.version');
    expect(error.userMessage).toContain('Run "fireforge setup" to create a new configuration');
  });

  it('formats ConfigNotFoundError for non-project directories', () => {
    const error = new ConfigNotFoundError('/tmp/fireforge.json');

    expect(error.userMessage).toContain('Configuration file not found: /tmp/fireforge.json');
    expect(error.userMessage).toContain(
      'This directory does not appear to be a FireForge project.'
    );
    expect(error.userMessage).toContain('Run "fireforge setup" to initialize a new project');
  });

  it('captures missing field details', () => {
    const error = new MissingFieldError('vendor');

    expect(error.field).toBe('vendor');
    expect(error.message).toBe('Required field "vendor" is missing from fireforge.json');
  });

  it('captures invalid field type expectations', () => {
    const error = new InvalidFieldError('build.jobs', 'number', 'many');

    expect(error.field).toBe('build.jobs');
    expect(error.expectedType).toBe('number');
    expect(error.actualValue).toBe('many');
    expect(error.message).toBe('Field "build.jobs" has invalid value. Expected number, got string');
  });
});
