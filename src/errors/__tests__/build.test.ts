// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  AmbiguousBuildArtifactsError,
  BootstrapError,
  BuildError,
  MachNotFoundError,
  MozconfigError,
  PythonNotFoundError,
  TestFailureError,
} from '../build.js';
import { ExitCode } from '../codes.js';

describe('TestFailureError', () => {
  it('keeps exit 5, because docs/exit-codes.md documents it as a failed suite', () => {
    // Consumers key CI on 5 for a test red; only the MESSAGE changes.
    expect(new TestFailureError('Tests failed with exit code 5.').code).toBe(ExitCode.BUILD_ERROR);
  });

  it('reports as `test-failure` rather than `build` in machine output', () => {
    // machineErrorCode derives the --json code from the class name, so the
    // name is a public contract.
    expect(new TestFailureError('x').name).toBe('TestFailureError');
  });

  it('names the failing tests, the verdict line and the run log — never obj-* or bootstrap', () => {
    const error = new TestFailureError(
      'Tests failed with exit code 5.',
      'mach test',
      'Unexpected test failures (first 1):\nTEST-UNEXPECTED-FAIL | browser_foo.js | got 1',
      '.fireforge/logs/test-20260901.log'
    );

    const msg = error.userMessage;
    expect(msg).toContain('Test Failure: Tests failed with exit code 5.');
    expect(msg).toContain('TEST-UNEXPECTED-FAIL | browser_foo.js');
    expect(msg).toContain('FIREFORGE-VERDICT');
    expect(msg).toContain('.fireforge/logs/test-20260901.log');
    // The whole point: none of the build remedies apply to an assertion.
    expect(msg).not.toContain('obj-');
    expect(msg).not.toContain('bootstrap');
    expect(msg).not.toContain('Check the build output');
  });

  it('tells the operator to stop piping when no run log was opened', () => {
    const msg = new TestFailureError('Tests failed with exit code 5.', 'mach test').userMessage;
    expect(msg).toContain('without piping');
    expect(msg).not.toContain('obj-');
  });
});

describe('build errors', () => {
  it('formats BuildError with command', () => {
    const error = new BuildError('compilation failed', 'mach build');

    expect(error.code).toBe(ExitCode.BUILD_ERROR);
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
    expect(error.userMessage).toContain('/project/engine/mach');
    expect(error.userMessage).toContain('fireforge download');
  });

  it('formats PythonNotFoundError with version range', () => {
    const error = new PythonNotFoundError('3.8', '3.12');

    expect(error.code).toBe(ExitCode.MISSING_DEPENDENCY);
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
    expect(error.userMessage).toContain('obj-x86_64, obj-aarch64');
    expect(error.userMessage).toContain('Remove stale');
  });
});
