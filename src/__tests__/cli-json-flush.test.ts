// SPDX-License-Identifier: EUPL-1.2
/**
 * Spawned-CLI regression for the `status --json --fail-on` refusal path
 * (FORGE I1). Both halves of the defect are only visible across a real
 * process boundary with a real pipe:
 *
 * - a >64 KiB JSON payload written to a PIPED stdout was truncated at
 *   exactly the kernel pipe buffer when the refusal exited non-zero
 *   (`process.exit` before Node's async stdout drained — a file redirect
 *   or an exit-0 run delivered everything);
 * - the styled refusal line landed on stdout AFTER the JSON instead of
 *   the stderr the 0.40.0 changelog promised.
 *
 * The slow reader is a real shell pipeline (`… | { sleep; cat; }`): while
 * `sleep` runs, NOTHING consumes the pipe, so the payload genuinely backs
 * up in the 64 KiB kernel buffer. (A merely-paused Node stream is not a
 * slow reader — the parent process eagerly buffers the whole payload
 * internally and defeats the backpressure this test depends on.)
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

/** Enough unmanaged files that the JSON payload clears 64 KiB comfortably. */
const UNMANAGED_FILE_COUNT = 600;

describe('status --json --fail-on refusal through a real pipe (FORGE I1)', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-json-flush-');
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'browser/base/content/app.js': 'content\n',
    });
    const unmanaged: Record<string, string> = {};
    for (let i = 0; i < UNMANAGED_FILE_COUNT; i++) {
      const n = String(i).padStart(4, '0');
      unmanaged[
        `engine/browser/components/deeply/nested/generated/subsystem-${n}/unmanaged-file-${n}.js`
      ] = `// unmanaged ${n}\n`;
    }
    await writeFiles(projectRoot, {
      'patches/patches.json': '{"version":1,"patches":[]}\n',
      ...unmanaged,
    });
  }, 30_000);

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('delivers the complete JSON on stdout and the refusal on stderr at exit 1', async () => {
    // `set -o pipefail` makes the pipeline's exit code fireforge's own
    // (not cat's 0); the pipeline exit code is what the consumer's gate
    // keys on. During the sleep the pipe has NO reader at all, so the
    // pre-fix CLI exits before Node flushes past the kernel buffer and
    // stdout truncates at exactly 65 536 bytes.
    const pipeline = [
      'set -o pipefail',
      `"${process.execPath}" "${tsxCli}" "${binEntry}" status --json --fail-on unmanaged | { sleep 0.5; cat; }`,
    ].join('\n');
    const child = spawn('bash', ['-c', pipeline], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    const [exitCode] = await Promise.all([
      new Promise<number>((resolve) => {
        child.on('exit', (code) => {
          resolve(code ?? -1);
        });
      }),
      new Promise<void>((resolve) => child.stdout.on('close', resolve)),
      new Promise<void>((resolve) => child.stderr.on('close', resolve)),
    ]);

    const stdout = Buffer.concat(stdoutChunks).toString('utf8');
    const stderr = Buffer.concat(stderrChunks).toString('utf8');

    expect(exitCode).toBe(1);
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(65_536);

    const payload = JSON.parse(stdout) as {
      schemaVersion: number;
      summary: { byClassification: Record<string, number> };
    };
    expect(payload.schemaVersion).toBe(1);
    expect(payload.summary.byClassification['unmanaged']).toBe(UNMANAGED_FILE_COUNT);

    expect(stderr).toMatch(/status --check failed/);
    expect(stdout).not.toContain('status --check failed');
  }, 60_000);
});
