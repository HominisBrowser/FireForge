// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import * as api from '../index.js';
import { PUBLIC_API_EXPORTS } from '../test-utils/public-api.js';

describe('public package API', () => {
  it('exports only the supported runtime surface', () => {
    expect(Object.keys(api).sort()).toEqual(PUBLIC_API_EXPORTS);
    expect(api).not.toHaveProperty('createProgram');
    expect(api).not.toHaveProperty('installBrokenPipeHandler');
    expect(api).not.toHaveProperty('main');
    expect(api).not.toHaveProperty('withErrorHandling');
  });

  it('exposes stable runtime shapes for exported errors and exit codes', () => {
    expect(api.ExitCode).toMatchObject({
      SUCCESS: 0,
      GENERAL_ERROR: 1,
      INVALID_ARGUMENT: 8,
      RESOLUTION_ERROR: 10,
    });

    const generalError = new api.GeneralError('boom');
    expect(generalError).toBeInstanceOf(Error);
    expect(generalError).toBeInstanceOf(api.FireForgeError);
    expect(generalError.name).toBe('GeneralError');
    expect(generalError.code).toBe(api.ExitCode.GENERAL_ERROR);
    expect(generalError.userMessage).toBe('boom');

    const invalidArgumentError = new api.InvalidArgumentError('bad flag', '--flag');
    expect(invalidArgumentError).toBeInstanceOf(api.FireForgeError);
    expect(invalidArgumentError.code).toBe(api.ExitCode.INVALID_ARGUMENT);
    expect(invalidArgumentError.userMessage).toContain('--flag');

    const resolutionError = new api.ResolutionError('needs manual fix');
    expect(resolutionError.code).toBe(api.ExitCode.RESOLUTION_ERROR);

    const commandError = new api.CommandError(api.ExitCode.GENERAL_ERROR);
    expect(commandError).toBeInstanceOf(Error);
    expect(commandError.name).toBe('CommandError');
    expect(commandError.exitCode).toBe(api.ExitCode.GENERAL_ERROR);
  });

  it('exposes the supported runtime entrypoints as callable functions', () => {
    expect(api.validateConfig).toBeTypeOf('function');
    expect(api.loadConfig).toBeTypeOf('function');
    expect(api.validateFurnaceConfig).toBeTypeOf('function');
    expect(api.loadFurnaceConfig).toBeTypeOf('function');
    expect(api.ensureFurnaceConfig).toBeTypeOf('function');
    expect(api.loadFurnaceState).toBeTypeOf('function');
    expect(api.saveFurnaceState).toBeTypeOf('function');
    expect(api.getTokensCssPath).toBeTypeOf('function');
    expect(api.validateTokenAdd).toBeTypeOf('function');
    expect(api.addToken).toBeTypeOf('function');
    expect(api.validateComponent).toBeTypeOf('function');
    expect(api.validateAllComponents).toBeTypeOf('function');
    expect(api.applyAllComponents).toBeTypeOf('function');
  });
});
