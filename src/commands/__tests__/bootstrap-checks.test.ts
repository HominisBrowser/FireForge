// SPDX-License-Identifier: EUPL-1.2
/**
 * Direct unit tests for the bootstrap output scanner and the targeted
 * post-bootstrap checks. bootstrap.test.ts mocks this module entirely, so
 * the pattern matching and the SDK-probe branching are pinned here.
 */
import { describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

import { detectBootstrapIssues, runPostBootstrapChecks } from '../bootstrap-checks.js';

type ExecFileCallback = (err: Error | null, stdout: string, stderr: string) => void;

function mockXcrun(err: Error | null, stdout: string): void {
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: object, cb: ExecFileCallback) => {
      cb(err, stdout, '');
    }
  );
}

describe('detectBootstrapIssues', () => {
  it('returns no issues for clean output', () => {
    expect(detectBootstrapIssues('bootstrap completed successfully')).toEqual([]);
  });

  it('detects an HTTP 403 SDK fetch failure', () => {
    expect(detectBootstrapIssues('urllib.error.HTTPError: HTTP Error 403: Forbidden')).toEqual([
      'sdk-fetch-403',
    ]);
    expect(detectBootstrapIssues('request failed: 403 Forbidden')).toEqual(['sdk-fetch-403']);
  });

  it('collapses a traceback caused by the 403 into a single sdk-fetch-403 tag', () => {
    const output =
      'Traceback (most recent call last):\n' +
      '  File "fetch_sdk.py", line 10, in fetch\n' +
      'urllib.error.HTTPError: HTTP Error 403: Forbidden';
    expect(detectBootstrapIssues(output)).toEqual(['sdk-fetch-403']);
  });

  it('reports a standalone Python traceback', () => {
    expect(
      detectBootstrapIssues('Traceback (most recent call last):\n  File "mach", line 1')
    ).toEqual(['python-traceback']);
  });

  it('detects every missing-origin-remote phrasing', () => {
    for (const line of [
      "fatal: no such remote 'origin'",
      'error: remote "origin" does not exist',
      "missing git remote 'origin'",
    ]) {
      expect(detectBootstrapIssues(line)).toEqual(['missing-origin-remote']);
    }
  });

  it('normalizes CRLF output and reports independent issues together', () => {
    const output =
      'Traceback (most recent call last):\r\n' +
      'HTTP Error 403: Forbidden\r\n' +
      "fatal: no such remote 'origin'\r\n";
    expect(detectBootstrapIssues(output)).toEqual(['sdk-fetch-403', 'missing-origin-remote']);
  });
});

describe('runPostBootstrapChecks', () => {
  it('returns no checks for no issues', async () => {
    await expect(runPostBootstrapChecks([])).resolves.toEqual([]);
  });

  it('downgrades sdk-fetch-403 to a warning when xcrun finds an SDK', async () => {
    mockXcrun(null, '/Library/Developer/SDKs/MacOSX.sdk\n');

    const checks = await runPostBootstrapChecks(['sdk-fetch-403']);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: 'macOS SDK download',
      severity: 'warning',
    });
  });

  it('fails sdk-fetch-403 when xcrun errors', async () => {
    mockXcrun(new Error('xcrun not found'), '');

    const checks = await runPostBootstrapChecks(['sdk-fetch-403']);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({
      name: 'macOS SDK',
      severity: 'error',
      fix: 'Install Xcode Command Line Tools with "xcode-select --install"',
    });
  });

  it('fails sdk-fetch-403 when xcrun prints an empty SDK path', async () => {
    mockXcrun(null, '  \n');

    const checks = await runPostBootstrapChecks(['sdk-fetch-403']);
    expect(checks[0]).toMatchObject({ name: 'macOS SDK', severity: 'error' });
  });

  it('reports python-traceback as a warning and missing-origin-remote as a failure', async () => {
    const checks = await runPostBootstrapChecks(['python-traceback', 'missing-origin-remote']);
    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({
      name: 'Python traceback',
      severity: 'warning',
    });
    expect(checks[1]).toMatchObject({
      name: 'Git remote',
      severity: 'error',
    });
  });
});
