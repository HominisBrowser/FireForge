// SPDX-License-Identifier: EUPL-1.2
/**
 * The real entry point across a real process boundary: exit codes, the
 * stdout/stderr split, and the shape of `--json` output.
 */
import { describe, expect, it } from 'vitest';

import { runCli, spawnCli } from '../testing/cli.js';
import { useTempDir } from '../testing/temp.js';

const dir = useTempDir();

describe('fireforge', () => {
  it('prints its version and exits 0', async () => {
    const result = await spawnCli(['--version'], { cwd: dir() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+(\+g[0-9a-f]{12}(\.dirty)?)?\n$/);
    expect(result.stderr).toBe('');
  }, 30_000);

  it('answers a usage error with exit code 8 and, under --json, one failure document', async () => {
    const result = await spawnCli(['version', '--bogus', '--json'], { cwd: dir() });
    expect(result.exitCode).toBe(8);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      error: "unknown option '--bogus'",
      code: 'invalid-argument',
    });
    expect(result.stderr).toContain("unknown option '--bogus'");
  }, 30_000);

  it('reports the same version from the version command, as text and as JSON', async () => {
    const flag = await runCli(['--version'], { cwd: dir() });
    const text = await runCli(['version'], { cwd: dir() });
    const json = await runCli(['version', '--json'], { cwd: dir() });
    expect(text.stdout).toBe(flag.stdout);
    expect(JSON.parse(json.stdout)).toEqual({
      schemaVersion: 1,
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/) as string,
      build: flag.stdout.trim(),
      node: process.version,
    });
  });

  it('lists the version command in the root help', async () => {
    const help = await runCli(['--help'], { cwd: dir() });
    expect(help.stdout).toMatch(/Diagnostics:\n\s+version/);
  });
});
