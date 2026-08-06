// SPDX-License-Identifier: EUPL-1.2
import { FireForgeError } from './base.js';
import { ExitCode } from './codes.js';

/**
 * Error thrown when a git operation fails.
 */
export class GitError extends FireForgeError {
  readonly code = ExitCode.GIT_ERROR;

  constructor(
    message: string,
    public readonly command?: string,
    cause?: Error
  ) {
    super(message, cause);
  }

  override get userMessage(): string {
    let msg = `Git Error: ${this.message}`;

    if (this.command) {
      msg += `\n\nCommand: git ${this.command}`;
    }

    msg += '\n\nTo fix this:\n';
    msg += '  1. Ensure git is installed and in your PATH\n';
    msg += '  2. Check if the repository is in a valid state\n';
    msg += '  3. Try running "fireforge reset" to start fresh';

    return msg;
  }
}

/**
 * Error thrown when git is not installed.
 */
export class GitNotFoundError extends GitError {
  constructor() {
    super('Git is not installed or not found in PATH');
  }

  override get userMessage(): string {
    return (
      'Git Error: Git is not installed or not found in PATH.\n\n' +
      'To fix this:\n' +
      '  1. Install git from https://git-scm.com/\n' +
      '  2. Ensure git is in your system PATH\n' +
      '  3. Restart your terminal and try again'
    );
  }
}

/**
 * Error thrown when applying a patch fails.
 */
export class PatchApplyError extends GitError {
  constructor(
    public readonly patchPath: string,
    cause?: Error
  ) {
    super(`Failed to apply patch: ${patchPath}`, 'apply', cause);
  }

  override get userMessage(): string {
    return (
      `Git Error: Failed to apply patch.\n\n` +
      `Patch: ${this.patchPath}\n\n` +
      'This usually means the patch conflicts with existing changes.\n\n' +
      'To fix this:\n' +
      '  1. Check if the Firefox version matches the patch\n' +
      '  2. Use "fireforge reset" to start with clean source\n' +
      '  3. Update the patch to match the current Firefox version'
    );
  }
}

/**
 * Error thrown when the repository is in a dirty state.
 */
export class DirtyRepositoryError extends GitError {
  constructor() {
    super('Repository has uncommitted changes');
  }

  override get userMessage(): string {
    return (
      'Git Error: The Firefox source has uncommitted changes.\n\n' +
      'To fix this:\n' +
      '  1. Export your changes with "fireforge export"\n' +
      '  2. Use "fireforge reset" to restore clean state\n' +
      '  3. Then run "fireforge import" to reapply patches'
    );
  }
}

/**
 * Error thrown when a stale git index lock blocks repository initialization.
 */
export class GitIndexLockError extends GitError {
  constructor(
    public readonly lockPath: string,
    public readonly ageMs?: number
  ) {
    super(`Git index is locked: ${lockPath}`, 'add -A');
  }

  override get userMessage(): string {
    const ageDescription =
      this.ageMs === undefined
        ? ''
        : `\nApproximate lock age: ${Math.max(1, Math.round(this.ageMs / 60000))} minute(s)\n`;

    return (
      'Git Error: Firefox source indexing is blocked by an existing git index lock.\n\n' +
      `Lock file: ${this.lockPath}${ageDescription}\n` +
      'This usually means a previous git or FireForge process was interrupted while indexing the engine tree.\n\n' +
      'To fix this:\n' +
      '  1. Make sure no other git process is still running inside engine/\n' +
      `  2. Remove "${this.lockPath}" if it is stale\n` +
      '  3. Re-run "fireforge download --force"'
    );
  }
}

/**
 * Detects transient git `index.lock` contention — an external git process
 * holding `.git/index.lock` while we stage or diff. Mirrors the message
 * heuristics `core/git.ts` uses when wrapping stale-lock failures during
 * download, but lives here so command modules can consult it without
 * importing (frequently vi.mocked) core git internals.
 */
export function isGitIndexLockConflict(error: unknown): boolean {
  if (error instanceof GitIndexLockError) {
    return true;
  }
  if (!(error instanceof GitError)) {
    return false;
  }
  return (
    /index\.lock/i.test(error.message) &&
    /(unable to create|another git process seems to be running|file exists|locked)/i.test(
      error.message
    )
  );
}

/**
 * Error thrown when `git add` (monolithic or chunked) exceeds the
 * configured timeout while indexing the Firefox source tree.
 *
 * 2026-04-24 eval Finding 10: a 140.10.0esr bump on a previously-working
 * 140.9.0esr workspace aborted after ~854s with a generic
 * `AbortError: The operation was aborted`. The root cause was the
 * `git add` timeout firing, but the surfaced error was indistinguishable
 * from any other AbortError and gave the operator no actionable
 * direction. This typed error carries the elapsed budget and the
 * environment-variable override so the recovery path is
 * self-documenting.
 */
export class GitIndexingTimeoutError extends GitError {
  constructor(
    public readonly phase: 'monolithic' | 'chunked',
    public readonly timeoutMs: number,
    public readonly envVar: string,
    cause?: Error
  ) {
    super(
      `Git ${phase} indexing exceeded the ${Math.round(timeoutMs / 1000)}s timeout`,
      'add -A',
      cause
    );
  }

  override get userMessage(): string {
    const minutes = Math.max(1, Math.round(this.timeoutMs / 60_000));
    const phaseDescription =
      this.phase === 'monolithic'
        ? 'the monolithic `git add -A` pass'
        : 'one of the chunked `git add -- <dir>` passes';
    return (
      `Git Error: ${phaseDescription} exceeded the ${minutes}-minute timeout while indexing the Firefox source tree.\n\n` +
      'Common triggers:\n' +
      '  - Slow or loaded disk (an external volume, encrypted filesystem, or heavily-used SSD under load).\n' +
      '  - A Firefox source tree that has grown beyond what the default timeout accommodates.\n' +
      '  - A background process (antivirus, backup, indexing) holding the working directory.\n\n' +
      'To recover:\n' +
      `  1. Extend the timeout via the ${this.envVar} environment variable (milliseconds; e.g. "export ${this.envVar}=1800000" for 30 minutes).\n` +
      '  2. Re-run "fireforge download --force" — the resume path resumes from the partial initialisation, so the repeat pass is not wasted work.\n' +
      '  3. If the problem persists, check disk throughput and free space; Firefox source indexing on a cold SSD typically completes in 1–3 minutes.'
    );
  }
}
