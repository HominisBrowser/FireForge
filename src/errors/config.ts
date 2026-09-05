// SPDX-License-Identifier: EUPL-1.2
import { FireForgeError, remedies } from './base.js';
import { ExitCode } from './codes.js';

/**
 * Error thrown when configuration is missing or invalid.
 */
export class ConfigError extends FireForgeError {
  readonly code = ExitCode.CONFIG_ERROR;

  constructor(
    message: string,
    public readonly field?: string,
    cause?: Error
  ) {
    super(message, cause);
  }

  override get userMessage(): string {
    return (
      `Configuration Error: ${this.message}` +
      (this.field ? `\n\nField: ${this.field}` : '') +
      remedies([
        'Check your fireforge.json file for errors',
        'Run "fireforge setup" to create a new configuration',
        'See the documentation for the expected format',
      ])
    );
  }
}

/**
 * Error thrown when fireforge.json is not found.
 */
export class ConfigNotFoundError extends ConfigError {
  constructor(configPath: string) {
    super(`Configuration file not found: ${configPath}`);
  }

  override get userMessage(): string {
    return (
      `Configuration Error: ${this.message}\n\n` +
      'This directory does not appear to be a FireForge project.' +
      remedies([
        'Navigate to your project root directory',
        'Run "fireforge setup" to initialize a new project',
      ])
    );
  }
}
