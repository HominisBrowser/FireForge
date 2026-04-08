// SPDX-License-Identifier: EUPL-1.2
import { FireForgeError } from './base.js';
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
    let msg = `Build Error: ${this.message}`;

    if (this.command) {
      msg += `\n\nCommand: ${this.command}`;
    }

    msg += '\n\nTo fix this:\n';
    msg += '  1. Check the build output above for specific errors\n';
    msg += '  2. Ensure all dependencies are installed with "fireforge bootstrap"\n';
    msg += '  3. Try a clean build by deleting obj-* directories';

    return msg;
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
  constructor(public readonly objDirs: string[]) {
    super(`Multiple build artifact directories found: ${objDirs.join(', ')}`);
  }

  override get userMessage(): string {
    return (
      'Build Error: Multiple build artifact directories were found.\n\n' +
      `Candidates: ${this.objDirs.join(', ')}\n\n` +
      'FireForge will not guess which build output to use.\n\n' +
      'To fix this:\n' +
      '  1. Remove stale obj-* directories you no longer need\n' +
      '  2. Keep only the active build output directory\n' +
      '  3. Run the command again'
    );
  }
}
