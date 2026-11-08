// SPDX-License-Identifier: EUPL-1.2
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const script = join(process.cwd(), 'scripts', 'check-coverage-thresholds.mjs');
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function metric(pct: number): { total: number; covered: number; pct: number } {
  return { total: 100, covered: pct, pct };
}

describe('coverage threshold script', () => {
  it('keys unpinned modules by their project-relative path wherever the checkout lives', () => {
    // The checkout sits under a directory that is itself named `src`.
    const root = join(realpathSync(mkdtempSync(join(tmpdir(), 'ff-cov-'))), 'src', 'FireForge');
    directories.push(join(root, '..', '..'));
    mkdirSync(join(root, 'coverage'), { recursive: true });
    const entry = {
      lines: metric(0),
      branches: metric(0),
      functions: metric(0),
      statements: metric(0),
    };
    writeFileSync(
      join(root, 'coverage', 'coverage-summary.json'),
      JSON.stringify({
        total: entry,
        [join(root, 'src', 'unpinned-example.ts')]: entry,
        [join(root, 'runtime', 'unpinned-example.cjs')]: entry,
      })
    );
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('- src/unpinned-example.ts: lines coverage 0.00%');
    expect(result.stderr).toContain('- runtime/unpinned-example.cjs: lines coverage 0.00%');
    expect(result.stderr).not.toMatch(/^- src\/FireForge\//m);
  });
});
