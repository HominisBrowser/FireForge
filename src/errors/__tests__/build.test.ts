// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  AmbiguousBuildArtifactsError,
  BootstrapError,
  BuildError,
  MachNotFoundError,
  MozconfigError,
  PythonNotFoundError,
} from '../build.js';
import { ExitCode } from '../codes.js';

describe('build errors', () => {
  it('formats BuildError with command', () => {
    const error = new BuildError('compilation failed', 'mach build');

    expect(error.code).toBe(ExitCode.BUILD_ERROR);
    expect(error.command).toBe('mach build');
    expect(error.userMessage).toContain('Build Error: compilation failed');
    expect(error.userMessage).toContain('Command: mach build');
  });

  it('formats BuildError without command', () => {
    const error = new BuildError('unknown build failure');

    expect(error.userMessage).not.toContain('Command:');
  });

  it('formats MachNotFoundError with MISSING_DEPENDENCY code', () => {
    const error = new MachNotFoundError('/project/engine');

    expect(error.code).toBe(ExitCode.MISSING_DEPENDENCY);
    expect(error.engineDir).toBe('/project/engine');
    expect(error.userMessage).toContain('/project/engine/mach');
    expect(error.userMessage).toContain('fireforge download');
  });

  it('formats PythonNotFoundError with version range', () => {
    const error = new PythonNotFoundError('3.8', '3.12');

    expect(error.code).toBe(ExitCode.MISSING_DEPENDENCY);
    expect(error.minVersion).toBe('3.8');
    expect(error.maxVersion).toBe('3.12');
    expect(error.userMessage).toContain('3.8-3.12');
    expect(error.userMessage).toContain('python.org');
  });

  it('uses default version range when none provided', () => {
    const error = new PythonNotFoundError();

    expect(error.minVersion).toBe('3.8');
    expect(error.maxVersion).toBe('3.12');
  });

  it('formats BootstrapError', () => {
    const error = new BootstrapError();

    expect(error.code).toBe(ExitCode.BUILD_ERROR);
    expect(error.command).toBe('python3 mach bootstrap');
    expect(error.userMessage).toContain('Bootstrap failed');
  });

  it('formats MozconfigError', () => {
    const error = new MozconfigError('missing template');

    expect(error.code).toBe(ExitCode.BUILD_ERROR);
    expect(error.userMessage).toContain('missing template');
    expect(error.userMessage).toContain('configs/ directory');
  });

  it('formats AmbiguousBuildArtifactsError', () => {
    const error = new AmbiguousBuildArtifactsError(['obj-x86_64', 'obj-aarch64']);

    expect(error.code).toBe(ExitCode.BUILD_ERROR);
    expect(error.objDirs).toEqual(['obj-x86_64', 'obj-aarch64']);
    expect(error.userMessage).toContain('obj-x86_64, obj-aarch64');
    expect(error.userMessage).toContain('Remove stale');
  });
});
