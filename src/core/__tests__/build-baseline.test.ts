// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureDir, writeJson } from '../../utils/fs.js';
import {
  BUILD_BASELINE_FILENAME,
  getBuildBaselinePath,
  readBuildBaseline,
  writeBuildBaseline,
} from '../build-baseline.js';
import { FIREFORGE_DIR } from '../config-paths.js';
import * as git from '../git.js';

describe('build-baseline', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'ff-build-baseline-'));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('resolves the canonical marker path under .fireforge/', () => {
    const path = getBuildBaselinePath('/some/project');
    expect(path).toBe(join('/some/project', FIREFORGE_DIR, BUILD_BASELINE_FILENAME));
  });

  it('returns undefined when no baseline has been written yet', async () => {
    await expect(readBuildBaseline(projectRoot)).resolves.toBeUndefined();
  });

  it('returns undefined on a corrupt marker rather than throwing', async () => {
    const path = getBuildBaselinePath(projectRoot);
    await ensureDir(join(projectRoot, FIREFORGE_DIR));
    const { writeText } = await import('../../utils/fs.js');
    await writeText(path, '{not json');
    await expect(readBuildBaseline(projectRoot)).resolves.toBeUndefined();
  });

  it('persists the engine HEAD SHA, timestamp, and binaryName on write', async () => {
    vi.spyOn(git, 'getHead').mockResolvedValue('deadbeef1234');
    await writeBuildBaseline(projectRoot, '/engine', 'mybrowser');
    const stored = await readBuildBaseline(projectRoot);
    expect(stored).toBeDefined();
    expect(stored?.engineHeadSha).toBe('deadbeef1234');
    expect(stored?.binaryName).toBe('mybrowser');
    expect(() => new Date(stored?.builtAt ?? '').toISOString()).not.toThrow();
  });

  it('writes an empty SHA when the engine has no HEAD yet', async () => {
    const missingHeadError = Object.assign(new Error("ambiguous argument 'HEAD'"), {});
    vi.spyOn(git, 'getHead').mockRejectedValue(missingHeadError);
    await writeBuildBaseline(projectRoot, '/engine', 'mybrowser');
    const stored = await readBuildBaseline(projectRoot);
    expect(stored?.engineHeadSha).toBe('');
  });

  it('propagates non-missing-HEAD git errors rather than writing garbage', async () => {
    const realError = new Error('git executable not found in PATH');
    vi.spyOn(git, 'getHead').mockRejectedValue(realError);
    await expect(writeBuildBaseline(projectRoot, '/engine', 'mybrowser')).rejects.toThrow(
      'git executable not found in PATH'
    );
  });

  it('round-trips a pre-written baseline verbatim', async () => {
    const path = getBuildBaselinePath(projectRoot);
    await ensureDir(join(projectRoot, FIREFORGE_DIR));
    const baseline = {
      engineHeadSha: 'abc123',
      builtAt: '2026-04-18T00:00:00.000Z',
      binaryName: 'mybrowser',
    };
    await writeJson(path, baseline);
    const loaded = await readBuildBaseline(projectRoot);
    expect(loaded).toEqual(baseline);
    const raw = await readFile(path, 'utf8');
    expect(raw).toContain('abc123');
  });
});
