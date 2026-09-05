// SPDX-License-Identifier: EUPL-1.2
import { FireForgeError, remedies } from './base.js';
import { ExitCode } from './codes.js';

/**
 * Error thrown when a build operation fails.
 */
export class BuildError extends FireForgeError {
  readonly code: ExitCode = ExitCode.BUILD_ERROR;

  constructor(
    message: string,
    public readonly command?: string,
    cause?: Error
  ) {
    super(message, cause);
  }

  override get userMessage(): string {
    return (
      `Build Error: ${this.message}` +
      (this.command ? `\n\nCommand: ${this.command}` : '') +
      remedies([
        'Check the build output above for specific errors',
        'Ensure all dependencies are installed with "fireforge bootstrap"',
        'Try a clean build by deleting obj-* directories',
      ])
    );
  }
}

/**
 * A test SUITE went red — assertions failed, or sharded runs did not all
 * pass. Distinct from its {@link BuildError} parent only in what it TELLS
 * the operator, deliberately not in its exit code: `docs/exit-codes.md`
 * documents 5 as "a suite that FAILED", and consumers key CI on it.
 *
 * The parent's remedies are all build remedies — "check the build output",
 * "fireforge bootstrap", "delete obj-* directories" — and none of them apply
 * to a failing assertion. Worse, the first points at the wrong half of the
 * log, which is exactly the half a `tail` keeps. Ground truth for a test red
 * is the harness's own output, so the remedies here name the failing tests,
 * the `FIREFORGE-VERDICT:` line, and the run log that survives a pipe.
 *
 * Note that `machineErrorCode` derives the `--json` error code from the class
 * name, so this reports as `test-failure` rather than `build`.
 */
export class TestFailureError extends BuildError {
  constructor(
    message: string,
    command?: string,
    /** Rendered TEST-UNEXPECTED blocks, when the verdict carried any. */
    public readonly failureBlocks?: string,
    /** The run's complete raw log, when one was opened. */
    public readonly logPath?: string
  ) {
    super(message, command);
  }

  override get userMessage(): string {
    return (
      `Test Failure: ${this.message}` +
      (this.command ? `\n\nCommand: ${this.command}` : '') +
      (this.failureBlocks ? `\n\n${this.failureBlocks}` : '') +
      remedies([
        this.failureBlocks
          ? 'Fix the failing assertions listed above, then re-run just those test paths'
          : 'Find the TEST-UNEXPECTED-FAIL lines in the output above — they name what broke',
        'Read the "FIREFORGE-VERDICT:" line for the run\'s ground truth (checks, unexpected)',
        this.logPath !== undefined
          ? `The complete raw output is at ${this.logPath} — it survives a piped/tailed terminal`
          : 'Re-run without piping the output, so the failure lines are not cut off by "tail"',
      ])
    );
  }
}

/**
 * Error thrown when mach is not available.
 */
export class MachNotFoundError extends BuildError {
  override readonly code = ExitCode.MISSING_DEPENDENCY;

  constructor(public readonly engineDir: string) {
    super(`mach not found in ${engineDir}`);
  }

  override get userMessage(): string {
    return (
      'Build Error: Firefox build system (mach) not found.\n\n' +
      `Expected location: ${this.engineDir}/mach\n\n` +
      'To fix this:\n' +
      '  1. Run "fireforge download" to download Firefox source\n' +
      '  2. Ensure the engine/ directory contains the Firefox source'
    );
  }
}

/**
 * Error thrown when python is not available.
 */
export class PythonNotFoundError extends BuildError {
  override readonly code = ExitCode.MISSING_DEPENDENCY;

  constructor(
    public readonly minVersion: string = '3.8',
    public readonly maxVersion: string = '3.12'
  ) {
    super(
      `FireForge could not find a Python interpreter supported by Firefox mach (${minVersion}-${maxVersion}).`
    );
  }

  override get userMessage(): string {
    return (
      `Build Error: Python ${this.minVersion}-${this.maxVersion} is required but not found.\n\n` +
      'Firefox mach declares the supported Python range in engine/mach, and FireForge could not find any interpreter in that range.\n\n' +
      'To fix this:\n' +
      `  1. Install a supported Python version (${this.minVersion}-${this.maxVersion}) from https://python.org/\n` +
      '  2. Ensure that interpreter is in your PATH (for example as python3.12 or python3)\n' +
      '  3. Re-run "fireforge doctor" to confirm FireForge can see it'
    );
  }
}

/**
 * Error thrown when bootstrap fails.
 */
export class BootstrapError extends BuildError {
  constructor(cause?: Error) {
    super('Bootstrap failed', 'python3 mach bootstrap', cause);
  }

  override get userMessage(): string {
    return (
      'Build Error: Bootstrap failed.\n\n' +
      'The Firefox build dependencies could not be installed. This often happens if the Python interpreter selected for mach is missing or misconfigured.\n\n' +
      'To fix this:\n' +
      '  1. Check the error output above\n' +
      '  2. Ensure you have sufficient permissions\n' +
      '  3. Try running bootstrap manually:\n' +
      '     cd engine && python3 mach bootstrap'
    );
  }
}

/**
 * Error thrown when mozconfig generation fails.
 */
export class MozconfigError extends BuildError {
  override get userMessage(): string {
    return (
      `Build Error: ${this.message}\n\n` +
      'To fix this:\n' +
      '  1. Check that configs/ directory exists\n' +
      '  2. Ensure platform-specific mozconfig exists\n' +
      '  3. Run "fireforge setup" to regenerate configs'
    );
  }
}

/**
 * Error thrown when multiple build output directories exist and FireForge cannot
 * safely choose one.
 */
export class AmbiguousBuildArtifactsError extends BuildError {
  constructor(
    public readonly objDirs: string[],
    /**
     * Objdir the active mozconfig declared, when one was declared and did
     * not resolve to exactly one candidate. Reported because a declaration
     * that names something the scan cannot see is the diagnosis, not noise.
     */
    public readonly declaredObjDir?: string
  ) {
    super(`Multiple build artifact directories found: ${objDirs.join(', ')}`);
  }

  override get userMessage(): string {
    const declared =
      this.declaredObjDir !== undefined
        ? `The mozconfig declares MOZ_OBJDIR=${this.declaredObjDir}, which does not match exactly one of these candidates — so it could not settle the choice.\n\n`
        : '';
    return (
      'Build Error: Multiple build artifact directories were found.\n\n' +
      `Candidates: ${this.objDirs.join(', ')}\n\n` +
      declared +
      'FireForge will not guess which build output to use.\n\n' +
      'To fix this:\n' +
      '  1. Remove stale obj-* directories you no longer need\n' +
      '  2. Keep only the active build output directory, or name it with MOZ_OBJDIR in the mozconfig\n' +
      '  3. Run the command again'
    );
  }
}
