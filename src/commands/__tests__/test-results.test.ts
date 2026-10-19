// SPDX-License-Identifier: EUPL-1.2
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import {
  collectedTestResults,
  recordTestResults,
  resetTestResults,
  withRawLogDir,
  writeTestResults,
} from '../test-results.js';

describe('test results collector', () => {
  let root: string;
  beforeEach(async () => {
    root = await createTempProject('ff-results-');
    resetTestResults();
  });
  afterEach(async () => {
    await removeTempProject(root);
  });

  it('records every dispatch with its run, shard and log line, and writes the document', async () => {
    recordTestResults(
      [
        {
          test: 'd/browser_a.js',
          status: 'OK',
          expected: 'OK',
          unexpected: false,
          unexpectedSubtests: 0,
          durationMs: 10,
        },
      ],
      ['d/browser_b.js'],
      { run: 2, shard: 'd/', logLine: 41 }
    );
    expect(collectedTestResults()).toEqual({
      schemaVersion: 1,
      files: [
        {
          test: 'd/browser_a.js',
          status: 'OK',
          expected: 'OK',
          unexpected: false,
          unexpectedSubtests: 0,
          durationMs: 10,
          run: 2,
          shard: 'd/',
          logLine: 41,
        },
      ],
      unfinished: [{ test: 'd/browser_b.js', run: 2, shard: 'd/' }],
    });
    const path = join(root, 'out/results.json');
    await writeTestResults(path);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(collectedTestResults());
    resetTestResults();
    expect(collectedTestResults().files).toEqual([]);
  });

  it('removes the raw-log scratch directory even when the body throws', async () => {
    let seen = '';
    await expect(
      withRawLogDir((dir) => {
        seen = dir;
        return Promise.reject(new Error('boom'));
      })
    ).rejects.toThrow('boom');
    await expect(access(seen)).rejects.toThrow();
  });
});
