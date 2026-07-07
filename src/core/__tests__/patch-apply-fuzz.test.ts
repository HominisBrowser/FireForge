// SPDX-License-Identifier: EUPL-1.2
/**
 * Real-git tests for the context-reduction ("fuzz") apply path.
 *
 * These deliberately do NOT mock `exec`. The original implementation
 * passed `--fuzz=N` — a GNU patch(1) flag that `git apply` rejects with a
 * usage error — and the mocked tests simulated `--check --fuzz=1`
 * succeeding, so CI validated behavior real git cannot produce and the
 * feature shipped broken (2026-07-05 review, finding H1). Every
 * escalation scenario here runs against an actual git repository.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  verbose: vi.fn(),
}));

import { applyPatchWithFuzz } from '../patch-apply-fuzz.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

const BASE_LINES = ['ctx1', 'ctx2', 'ctx3', 'target', 'ctx4', 'ctx5', 'ctx6'];

/**
 * Builds a temp git repo containing f.txt, captures a patch that changes
 * `target` → `changed` against the pristine file, then rewrites f.txt via
 * `mutate` to simulate upstream drift. Returns the repo dir and patch path.
 */
async function makeDriftedRepo(
  mutate: (lines: string[]) => string[]
): Promise<{ repo: string; patchPath: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'fireforge-fuzz-'));
  cleanupPaths.push(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@fireforge.invalid');
  git(repo, 'config', 'user.name', 'FireForge Test');

  const file = join(repo, 'f.txt');
  await writeFile(file, BASE_LINES.join('\n') + '\n', 'utf-8');
  git(repo, 'add', 'f.txt');
  git(repo, 'commit', '-qm', 'base');

  await writeFile(
    file,
    BASE_LINES.map((l) => (l === 'target' ? 'changed' : l)).join('\n') + '\n',
    'utf-8'
  );
  const patchPath = join(repo, 'change.patch');
  await writeFile(patchPath, git(repo, 'diff'), 'utf-8');
  git(repo, 'checkout', '-q', '--', 'f.txt');

  await writeFile(file, mutate([...BASE_LINES]).join('\n') + '\n', 'utf-8');
  git(repo, 'add', 'f.txt');
  // --allow-empty: the no-drift scenario mutates nothing.
  git(repo, 'commit', '-qm', 'drift', '--allow-empty');

  return { repo, patchPath };
}

const driftOuterContext = (lines: string[]): string[] =>
  lines.map((l) => (l === 'ctx1' ? 'CTX1-drifted' : l === 'ctx6' ? 'CTX6-drifted' : l));

describe('applyPatchWithFuzz (real git)', () => {
  it('applies cleanly at step 0 when nothing drifted', async () => {
    const { repo, patchPath } = await makeDriftedRepo((lines) => lines);

    const result = await applyPatchWithFuzz(patchPath, repo, 3);

    expect(result.success).toBe(true);
    expect(result.fuzzFactor).toBe(0);
    expect(await readFile(join(repo, 'f.txt'), 'utf-8')).toContain('changed');
  });

  it('escalates to reduced context when outer context lines drifted', async () => {
    // Drift the outermost context lines (ctx1/ctx6): exact apply fails,
    // -C2 succeeds. This is exactly the "Firefox update touched nearby
    // lines" scenario the rebase feature exists for — and exactly what the
    // --fuzz=N implementation could never do against real git.
    const { repo, patchPath } = await makeDriftedRepo(driftOuterContext);

    const result = await applyPatchWithFuzz(patchPath, repo, 3);

    expect(result.success).toBe(true);
    expect(result.fuzzFactor).toBeGreaterThanOrEqual(1);
    expect(result.fuzzFactor).toBeLessThanOrEqual(3);
    const content = await readFile(join(repo, 'f.txt'), 'utf-8');
    expect(content).toContain('changed');
    expect(content).not.toContain('\ntarget\n');
  });

  it('refuses drifted patches at maxFuzz 0 (exact only) without leaving .rej residue behind flags', async () => {
    const { repo, patchPath } = await makeDriftedRepo(driftOuterContext);

    const result = await applyPatchWithFuzz(patchPath, repo, 0);

    expect(result.success).toBe(false);
    expect(result.fuzzFactor).toBe(0);
  });

  it('caps context-reduction steps at git default context for oversized maxFuzz', async () => {
    const { repo, patchPath } = await makeDriftedRepo(driftOuterContext);

    // maxFuzz 10 must clamp to 3 steps (-C0 floor), not build -C-7.
    const result = await applyPatchWithFuzz(patchPath, repo, 10);

    expect(result.success).toBe(true);
    expect(result.fuzzFactor).toBeLessThanOrEqual(3);
  });

  it('falls through to --reject and reports the real .rej files when nothing matches', async () => {
    const { repo, patchPath } = await makeDriftedRepo(() => [
      'totally',
      'different',
      'file',
      'now',
    ]);

    const result = await applyPatchWithFuzz(patchPath, repo, 3);

    expect(result.success).toBe(false);
    // Git's actual --reject phrasing is "Applying patch <file> with N
    // rejects..." — the old GNU-patch-shaped regex ("saving rejects to
    // file X.rej") never matched it, so rejectFiles was always empty and
    // the rebase conflict summary's ".rej files created" hint never fired.
    expect(result.rejectFiles).toEqual(['f.txt.rej']);
    expect(await readFile(join(repo, 'f.txt.rej'), 'utf-8')).toContain('target');
  });

  it.each([Number.NaN, -1, 1.5])(
    'rejects invalid maxFuzz %s before touching git — NaN/negative would skip every apply attempt',
    async (maxFuzz) => {
      await expect(applyPatchWithFuzz('/patch.patch', '/engine', maxFuzz)).rejects.toThrow(
        /maxFuzz must be a non-negative integer/
      );
    }
  );
});
