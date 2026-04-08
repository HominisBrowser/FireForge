// SPDX-License-Identifier: EUPL-1.2
import { FireForgeError } from './base.js';
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
    let msg = `Configuration Error: ${this.message}`;

    if (this.field) {
      msg += `\n\nField: ${this.field}`;
    }

    msg += '\n\nTo fix this:\n';
    msg += '  1. Check your fireforge.json file for errors\n';
    msg += '  2. Run "fireforge setup" to create a new configuration\n';
    msg += '  3. See the documentation for the expected format';

    return msg;
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
      'This directory does not appear to be a FireForge project.\n\n' +
      'To fix this:\n' +
      '  1. Navigate to your project root directory\n' +
      '  2. Run "fireforge setup" to initialize a new project'
    );
  }
}

/**
 * Error thrown when a required field is missing from config.
 */
export class MissingFieldError extends ConfigError {
  constructor(field: string) {
    super(`Required field "${field}" is missing from fireforge.json`, field);
  }
}

/**
 * Error thrown when a field has an invalid value.
 */
export class InvalidFieldError extends ConfigError {
  constructor(
    field: string,
    public readonly expectedType: string,
    public readonly actualValue: unknown
  ) {
    super(
      `Field "${field}" has invalid value. Expected ${expectedType}, got ${typeof actualValue}`,
      field
    );
  }
}
