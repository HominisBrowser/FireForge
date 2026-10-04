// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { classifyHarnessRun, formatFireforgeVerdictLine } from '../test-harness-crash.js';
import { stampPerfHost } from '../test-host-state.js';
import {
  cleanupProfileFiles,
  PROFILE_MERGE_PYTHON,
  stageProfileFiles,
} from '../test-profile-files.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ff-profile-regression-')));
  roots.push(root);
  return root;
}

describe('profile overlays', () => {
  it('merges chrome files into an existing profile without relaxing unrelated copytree operations', async () => {
    const root = await temp();
    await writeFile(join(root, 'sheet.css'), ':root { color: red; }');
    const staged = await stageProfileFiles(root, ['sheet.css=chrome/userChrome.css']);
    roots.push(staged.root);
    const profile = join(root, 'profile/chrome');
    await mkdir(profile, { recursive: true });
    await writeFile(join(profile, 'preserve'), 'existing profile data');
    const external = join(root, 'external');
    await mkdir(external);
    await writeFile(join(external, 'unrelated'), 'must not be merged');
    const script =
      PROFILE_MERGE_PYTHON +
      '\nimport sys\nshutil.copytree(sys.argv[1], sys.argv[2])\ntry:\n    shutil.copytree(sys.argv[3], sys.argv[2])\n    raise AssertionError("unrelated source unexpectedly merged")\nexcept FileExistsError:\n    pass\n';
    await run('python3', ['-c', script, join(staged.root, 'chrome'), profile, external], {
      env: { ...process.env, ...staged.env },
    });
    expect(await readFile(join(profile, 'userChrome.css'), 'utf8')).toContain('color: red');
    expect(await readFile(join(profile, 'preserve'), 'utf8')).toBe('existing profile data');
    expect(staged.args).toEqual([`--extra-profile-file=${join(staged.root, 'chrome')}`]);
  });

  it.each([
    'sheet.css=../escape',
    'sheet.css=/escape',
    'sheet.css=chrome/../../escape',
    'sheet.css=chrome\\..\\escape',
    'sheet.css',
    '=chrome/file',
    'sheet.css=C:/escape',
  ])('refuses malformed/traversing destination %s', async (entry) => {
    await expect(stageProfileFiles(await temp(), [entry])).rejects.toThrow(
      /requires source=relative/
    );
  });

  it('classifies a profile collision as a harness argument failure even with a zero-check summary', () => {
    const output =
      'Traceback (most recent call last):\n  copyExtraFilesToProfile(options)\nFileExistsError: chrome\nPassed: 0\nFailed: 0\n';
    const verdict = classifyHarnessRun(1, output, ['browser_perf.js']);
    expect(verdict.kind).toBe('harness-arguments');
    expect(formatFireforgeVerdictLine(verdict)).toContain('reason=harness-arguments');
    expect(verdict.note).toContain('--profile-file');
  });
});

describe('perf power evidence', () => {
  it('preserves sample fields and stamps the charging AC source; marks battery transitions', async () => {
    const root = await temp();
    const artifact = join(root, 'sample.json');
    const start = { load: 1, power: 'ac' as const };
    const end = {
      load: 7,
      power: 'battery' as const,
      topProcess: { command: '/System/ANECompilerService', cpu: 97 },
    };
    await writeFile(artifact, '{"schema":1,"metrics":{"duration":42}}');
    expect(await stampPerfHost({ HOMINIS_PERF_SAMPLE_JSON: artifact }, start, end)).toBe(true);
    expect(JSON.parse(await readFile(artifact, 'utf8'))).toEqual({
      schema: 1,
      metrics: { duration: 42 },
      fireforgeHost: { start, end, powerSourceChanged: true },
    });
    expect(await stampPerfHost({ HOMINIS_PERF_SAMPLE_JSON: artifact }, start, start)).toBe(false);
  });

  it('detects transitions even when the producer failed to write its sample, and tolerates unknown sources', async () => {
    const env = { HOMINIS_PERF_SAMPLE_JSON: join(await temp(), 'absent.json') };
    expect(await stampPerfHost(env, { load: 0, power: 'ac' }, { load: 0, power: 'battery' })).toBe(
      true
    );
    expect(await stampPerfHost(env, { load: 0, power: 'unknown' }, { load: 0, power: 'ac' })).toBe(
      false
    );
    expect(
      await stampPerfHost(undefined, { load: 0, power: 'ac' }, { load: 0, power: 'battery' })
    ).toBe(false);
  });
});

it('isolates malformed perf artifacts and annotates every distinct valid output', async () => {
  const root = await temp();
  const bad = join(root, 'bad.json');
  const good = join(root, 'good.json');
  await writeFile(bad, '{');
  await writeFile(good, '{"duration":42}');
  const state = { load: 1, power: 'ac' as const };
  await expect(
    stampPerfHost({ BAD_PERF_SAMPLE_JSON: bad, GOOD_PERF_SAMPLE_JSON: good }, state, state)
  ).resolves.toBe(false);
  expect(await readFile(bad, 'utf8')).toBe('{');
  expect(JSON.parse(await readFile(good, 'utf8'))).toMatchObject({
    duration: 42,
    fireforgeHost: { powerSourceChanged: false },
  });
});

it('does not let failed profile cleanup override the original staging error', async () => {
  const spy = vi.mocked(rm).mockRejectedValueOnce(new Error('cleanup denied'));
  try {
    await expect(stageProfileFiles(await temp(), ['invalid-input'])).rejects.toThrow(
      '--profile-file requires'
    );
  } finally {
    const leakedRoot = spy.mock.calls.at(-1)?.[0];
    if (typeof leakedRoot === 'string') await rm(leakedRoot, { recursive: true, force: true });
  }
});

it('reports a failed profile removal without changing a completed harness result', async () => {
  const root = await temp();
  const spy = vi.mocked(rm).mockRejectedValueOnce(new Error('cleanup denied'));
  try {
    await expect(cleanupProfileFiles(root)).resolves.toBeUndefined();
  } finally {
    spy.mockClear();
  }
});
