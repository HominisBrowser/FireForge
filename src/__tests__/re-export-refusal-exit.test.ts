// SPDX-License-Identifier: EUPL-1.2
/**
 * Spawned-CLI pin for the refusal exit code: a `re-export` in which every
 * selected patch is refused under `--refuse-foreign-drift` must print
 * "Re-export refused" AND exit 1, in every variant (plain, --dry-run,
 * --skip-lint). A consumer gate observing exit 0 is reading the shell
 * PIPELINE's status (`… | tee` reports tee's 0 without `pipefail`), so this
 * pins the process-boundary contract that gate depends on rather than
 * leaving it to in-process assertions.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  writeFiles,
  writeFireForgeConfig,
} from '../test-utils/index.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const binEntry = join(repoRoot, 'bin', 'fireforge.ts');

const FILE_A = 'comp/a.js';
const FILE_B = 'comp/b.js';

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runFireforge(cwd: string, args: string[]): Promise<CliResult> {
  const child = spawn(process.execPath, [tsxCli, binEntry, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  return new Promise<CliResult>((resolve) => {
    child.on('exit', (code) => {
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

describe('re-export full-refusal exit code across the process boundary', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-refusal-exit-');
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(join(projectRoot, 'engine'), {
      [FILE_A]: 'line1\nline2\nline3\n',
      [FILE_B]: 'line1\nline2\nline3\n',
    });
    await writeFiles(projectRoot, {
      'patches/patches.json': `${JSON.stringify(
        {
          version: 1,
          patches: [
            {
              filename: '001-ui-a.patch',
              order: 1,
              category: 'ui',
              name: 'a',
              description: '',
              createdAt: '2026-01-01T00:00:00.000Z',
              sourceEsrVersion: '140.9.0esr',
              filesAffected: [FILE_A],
            },
            {
              filename: '002-ui-b.patch',
              order: 2,
              category: 'ui',
              name: 'b',
              description: '',
              createdAt: '2026-01-01T00:00:00.000Z',
              sourceEsrVersion: '140.9.0esr',
              filesAffected: [FILE_B],
            },
          ],
        },
        null,
        2
      )}\n`,
      'patches/001-ui-a.patch': `diff --git a/${FILE_A} b/${FILE_A}\n`,
      'patches/002-ui-b.patch': `diff --git a/${FILE_B} b/${FILE_B}\n`,
    });
    await writeFiles(join(projectRoot, 'engine'), {
      [FILE_A]: 'line1\nline2\npatched a\nline3\n',
      [FILE_B]: 'line1\nline2\npatched b\nline3\n',
    });
    // Materialize real old bodies, then introduce foreign drift in both.
    const materialize = await runFireforge(projectRoot, ['re-export', '--all']);
    expect(materialize.exitCode).toBe(0);
    await writeFiles(join(projectRoot, 'engine'), {
      [FILE_A]: 'line1\nforeign X\nline2\npatched a\nline3\n',
      [FILE_B]: 'line1\nforeign Y\nline2\npatched b\nline3\n',
    });
  }, 60_000);

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('a fully-refused run prints the refusal and the PROCESS exits 1', async () => {
    const result = await runFireforge(projectRoot, [
      're-export',
      '--all',
      '--refuse-foreign-drift',
    ]);

    expect(result.exitCode).toBe(1);
    const combined = result.stdout + result.stderr;
    expect(combined).toContain('Refused 2 patch(es)');
    expect(combined).toContain('001-ui-a.patch');
    expect(combined).toContain('002-ui-b.patch');
  }, 60_000);

  it('a fully-refused --dry-run also exits 1', async () => {
    const result = await runFireforge(projectRoot, [
      're-export',
      '--all',
      '--refuse-foreign-drift',
      '--dry-run',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('Refused 2 patch(es)');
  }, 60_000);
});
