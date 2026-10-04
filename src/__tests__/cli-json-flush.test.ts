// SPDX-License-Identifier: EUPL-1.2
/**
 * Spawned-CLI regression for the `status --json --fail-on` refusal path.
 * Both halves of the defect are only visible across a real process boundary
 * with a real pipe:
 *
 * - a >64 KiB JSON payload written to a piped stdout is truncated at exactly
 *   the kernel pipe buffer when the refusal exits non-zero (`process.exit`
 *   runs before Node's async stdout drains, while a file redirect or an
 *   exit-0 run delivers everything).
 * - The styled refusal line must land on stderr, not on stdout after the
 *   JSON.
 *
 * The slow reader is a real shell pipeline (`… | { sleep; cat; }`): while
 * `sleep` runs, nothing consumes the pipe, so the payload genuinely backs up
 * in the 64 KiB kernel buffer. A merely-paused Node stream is not a slow
 * reader: the parent process eagerly buffers the whole payload internally
 * and defeats the backpressure this test depends on.
 */
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTempProject,
  FIREFORGE_BIN_ENTRY,
  initCommittedRepo,
  removeTempProject,
  TSX_CLI,
  writeFiles,
  writeFireForgeConfig,
} from '../test-utils/index.js';
import { runCapturedProcess } from '../test-utils/spawned-process.js';

/** Enough unmanaged files that the JSON payload clears 64 KiB comfortably. */
const UNMANAGED_FILE_COUNT = 600;

describe('status --json --fail-on refusal through a real pipe', () => {
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
    // `set -o pipefail` makes the pipeline's exit code fireforge's own (not
    // cat's 0). The pipeline exit code is what the consumer's gate keys on.
    // During the sleep the pipe has no reader at all, so a CLI that exits
    // before Node flushes past the kernel buffer truncates stdout at exactly
    // 65 536 bytes. Paths travel as positional parameters, never as script text.
    const loader = pathToFileURL(join(dirname(TSX_CLI), 'loader.mjs')).href;
    const pipeline = [
      'set -o pipefail',
      '"$1" --import "$2" "$3" status --json --fail-on unmanaged | { sleep 0.5; cat; }',
    ].join('\n');
    const { exitCode, stdout, stderr } = await runCapturedProcess(
      'bash',
      ['-c', pipeline, 'bash', process.execPath, loader, FIREFORGE_BIN_ENTRY],
      { cwd: projectRoot, timeoutMs: 55_000 }
    );

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
