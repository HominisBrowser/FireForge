// SPDX-License-Identifier: EUPL-1.2
/**
 * `patchLint.fileSizeMetric` and the band wording of `file-too-large`:
 * code lines vs raw lines, the `file-size-unparsed` fallback notice, and a
 * notice that never claims to fail a `--max-warnings 0` gate.
 */
import { rm } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { resolveFileSizeThresholds as fromPublicApi } from '../../index.js';
import { createTempProject, writeFiles } from '../../test-utils/index.js';
import type { PatchLintIssue } from '../../types/commands/index.js';
import type { FireForgeConfig, PatchLintConfig } from '../../types/config.js';
import { lintPatchedJs } from '../patch-lint.js';
import { resolveFileSizeThresholds } from '../patch-lint-file-size.js';

const FILE = 'browser/modules/Big.sys.mjs';

const config = (patchLint?: PatchLintConfig): FireForgeConfig => ({
  name: 'T',
  vendor: 'T',
  appId: 'org.t.t',
  binaryName: 't',
  firefox: { version: '140.9.0esr', product: 'firefox-esr' },
  ...(patchLint ? { patchLint } : {}),
});

/** `code` code lines, each preceded by a two-line JSDoc block and a blank line. */
function documented(code: number): string {
  const out: string[] = [];
  for (let i = 0; i < code; i++)
    out.push('/**', ` * Value ${i}. */`, `export const x${i} = ${i};`, '');
  return out.join('\n');
}

describe('file-too-large metric', () => {
  let root: string;

  beforeEach(async () => {
    root = await createTempProject('ff-file-size-metric-');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function sizeIssues(
    content: string,
    patchLint?: PatchLintConfig,
    file = FILE
  ): Promise<PatchLintIssue[]> {
    await writeFiles(root, { [file]: content });
    const issues = await lintPatchedJs(root, [file], new Set([file]), config(patchLint));
    return issues.filter((i) => i.check === 'file-too-large' || i.check === 'file-size-unparsed');
  }

  it('exports resolveFileSizeThresholds on the public API', () => {
    expect(fromPublicApi).toBe(resolveFileSizeThresholds);
    expect(resolveFileSizeThresholds({ test: { warning: 1300 } }, true)).toEqual({
      notice: 1200,
      warning: 1300,
      error: 1600,
    });
  });

  it('counts raw lines by default and names the unit', async () => {
    // 300 code lines, 1199 raw lines: an error under the raw default.
    const [issue] = await sizeIssues(documented(300));
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toBe(
      'New file has 1199 lines (error threshold: 900). Consider decomposing.'
    );
  });

  it('counts code lines under fileSizeMetric "code"', async () => {
    expect(await sizeIssues(documented(300), { fileSizeMetric: 'code' })).toEqual([]);
    const [issue] = await sizeIssues(documented(600), { fileSizeMetric: 'code' });
    expect(issue?.severity).toBe('notice');
    expect(issue?.message).toBe(
      'New file has 600 code lines, over the design target of 500 ' +
        '(warning threshold: 750, error threshold: 900). Advisory; does not fail --max-warnings 0.'
    );
  });

  it('keeps the gate sentence for the warning band only, with no split hint', async () => {
    const [issue] = await sizeIssues(documented(800), { fileSizeMetric: 'code' });
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('New file has 800 code lines (warning threshold: 750');
    expect(issue?.message).toContain('treats as a failure');
    expect(issue?.message).not.toContain('Consider');
  });

  it('falls back to raw lines with a file-size-unparsed notice when acorn fails', async () => {
    // 150 code lines in 599 raw lines, plus one line acorn cannot tokenize.
    const content = documented(150) + '@@ preprocessor residue\n';
    const issues = await sizeIssues(content, { fileSizeMetric: 'code' });
    expect(issues.map((i) => [i.check, i.severity])).toEqual([
      ['file-size-unparsed', 'notice'],
      ['file-too-large', 'notice'],
    ]);
    expect(issues[0]?.message).toContain('counted its 600 raw lines (the upper bound)');
    expect(issues[1]?.message).toContain('New file has 600 lines,');
  });

  it('does not emit file-size-unparsed under the raw metric', async () => {
    const issues = await sizeIssues('@@\n');
    expect(issues).toEqual([]);
  });
});
