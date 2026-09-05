// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';

import type { DoctorCheck } from '../types/commands/index.js';
import { failure, warning } from './doctor-check-core.js';

/** Tags representing distinct issues detected in bootstrap output. */
export type BootstrapIssue = 'sdk-fetch-403' | 'python-traceback' | 'missing-origin-remote';

/**
 * Scans bootstrap output for known failure patterns and returns structured
 * issue tags. A Python traceback paired with an HTTP 403 is collapsed into
 * a single `sdk-fetch-403` tag since the traceback is just the stack trace
 * from the HTTP error.
 */
export function detectBootstrapIssues(output: string): BootstrapIssue[] {
  const normalized = output.replace(/\r\n/g, '\n');
  const issues: BootstrapIssue[] = [];

  const hasTraceback = /traceback \(most recent call last\):/i.test(normalized);
  const has403 =
    /\bhttp(?:\s+error)?\s*403\b/i.test(normalized) || /\b403\b.*forbidden/i.test(normalized);

  if (has403) {
    // The traceback is just the stack trace from the HTTP error, so report
    // it once.
    issues.push('sdk-fetch-403');
  } else if (hasTraceback) {
    issues.push('python-traceback');
  }

  if (
    /no such remote ['"]origin['"]/i.test(normalized) ||
    /remote ['"]origin['"] does not exist/i.test(normalized) ||
    /missing git remote ['"]origin['"]/i.test(normalized)
  ) {
    issues.push('missing-origin-remote');
  }

  return issues;
}

/** Checks whether `xcrun --show-sdk-path` returns a valid macOS SDK path. */
async function hasMacOsSdk(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('xcrun', ['--show-sdk-path'], { timeout: 10_000 }, (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
}

/**
 * Runs targeted post-bootstrap checks based on the detected issues.
 * Returns doctor-compatible check results so the caller can render them
 * with the standard `reportDoctorResults` display.
 */
export async function runPostBootstrapChecks(issues: BootstrapIssue[]): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  for (const issue of issues) {
    switch (issue) {
      case 'sdk-fetch-403': {
        const sdkAvailable = await hasMacOsSdk();
        if (sdkAvailable) {
          checks.push(
            warning(
              'macOS SDK download',
              "SDK download from Apple's CDN failed (HTTP 403), but a macOS SDK was found via Xcode. This is safe to ignore."
            )
          );
        } else {
          checks.push(
            failure(
              'macOS SDK',
              'SDK download failed and no macOS SDK found on your system.',
              'Install Xcode Command Line Tools with "xcode-select --install"'
            )
          );
        }
        break;
      }

      case 'python-traceback':
        checks.push(
          warning(
            'Python traceback',
            'Bootstrap emitted a Python traceback. This may indicate a non-critical issue.',
            'Review the bootstrap output above for details.'
          )
        );
        break;

      case 'missing-origin-remote':
        checks.push(
          failure(
            'Git remote',
            'Bootstrap expected an "origin" git remote in the Firefox source checkout.',
            'Run "git remote add origin <url>" in the engine directory.'
          )
        );
        break;
    }
  }

  return checks;
}
