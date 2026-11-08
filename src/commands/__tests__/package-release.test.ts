// SPDX-License-Identifier: EUPL-1.2
/**
 * A release's body, in this process, against a real slot directory. It normally runs
 * inside an executor, where coverage cannot see it; the supervised path is in
 * `real-project.integration.test.ts`. Mach, the phase's authorization and its object store are stubbed.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readCoordinatorConfig } from '../../core/jobs/admission-context.js';
import { readAdmittedSnapshot } from '../../core/jobs/guard.js';
import { checkConfiguredObjdir } from '../../core/jobs/native-tools.js';
import { releaseObjdir } from '../../core/jobs/release-recipe.js';
import { stepOutputDirectory } from '../../core/jobs/step-environment.js';
import { runMach } from '../../core/mach.js';
import { BuildError } from '../../errors/build.js';
import { packageRelease } from '../package-release.js';

vi.mock('../../core/build-prepare.js', () => ({
  prepareBuildEnvironment: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../core/authored/git.js', async (original) => ({
  ...(await original<typeof import('../../core/authored/git.js')>()),
  readSourceBlobs: vi.fn(() =>
    Promise.resolve(new Map([['overlay-blob', Buffer.from('overlay\n')]]))
  ),
}));
vi.mock('../../core/mach.js', () => ({ runMach: vi.fn(() => Promise.resolve(0)) }));
vi.mock('../../core/jobs/admission-context.js', () => ({ readCoordinatorConfig: vi.fn() }));
vi.mock('../../core/jobs/guard.js', async (original) => ({
  ...(await original<typeof import('../../core/jobs/guard.js')>()),
  readAdmittedSnapshot: vi.fn(),
}));
vi.mock('../../core/jobs/native-tools.js', () => ({
  checkConfiguredObjdir: vi.fn(() => Promise.resolve()),
  readHostToolchain: vi.fn(() => Promise.resolve({ digest: 'tools' })),
}));

const OVERLAY = 'configs/release.mozconfig';
const JOB = '11111111-1111-1111-1111-111111111111';
let root: string;
let secrets: string;

const admit = (release: unknown): void => {
  vi.mocked(readAdmittedSnapshot).mockResolvedValue({
    snapshot: {
      id: 'source',
      pin: { commit: 'pin' },
      repository: root,
      inputs: [{ path: OVERLAY, blob: 'overlay-blob' }],
      config: { build: { release } },
    },
    execution: { jobId: JOB, index: 0, cpu: 7, args: ['--recipe', 'release'] },
  } as never);
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fireforge-package-release-'));
  secrets = join(root, 'secrets');
  await mkdir(secrets);
  await mkdir(join(root, 'engine'));
  await mkdir(join(root, 'configs'));
  await writeFile(join(root, 'engine', 'mozconfig'), 'generated\n');
  await writeFile(join(root, OVERLAY), 'overlay\n');
  vi.stubEnv('FIREFORGE_JOB_TOKEN', 'token');
  vi.stubEnv('FIREFORGE_COORDINATOR', join(root, 'coordinator'));
  vi.mocked(runMach).mockReset().mockResolvedValue(0);
  vi.mocked(checkConfiguredObjdir).mockClear();
  vi.mocked(readCoordinatorConfig).mockResolvedValue({} as never);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('a release package', () => {
  it('runs only in a job', async () => {
    vi.stubEnv('FIREFORGE_JOB_TOKEN', undefined);
    await expect(packageRelease(root)).rejects.toThrow(/fireforge job run --release/);
    expect(runMach).not.toHaveBeenCalled();
  });

  it('refuses a step with no identity, and a source with no recipe', async () => {
    vi.mocked(readAdmittedSnapshot).mockResolvedValue({ snapshot: {} } as never);
    await expect(packageRelease(root)).rejects.toThrow(/Release step has no identity/);
    admit(undefined);
    await expect(packageRelease(root)).rejects.toThrow(/needs build\.release/);
    expect(runMach).not.toHaveBeenCalled();
  });

  it('builds then packages in its own directory, on one build date, with the overlay last', async () => {
    admit({ overlay: OVERLAY });
    await packageRelease(root);
    const calls = vi.mocked(runMach).mock.calls;
    expect(calls.map(([args]) => args)).toEqual([['build', '-j7'], ['package']]);
    const [first, second] = calls.map(([, , options]) => options?.env);
    expect(first?.['MOZ_BUILD_DATE']).toMatch(/^\d{14}$/);
    expect(second?.['MOZ_BUILD_DATE']).toBe(first?.['MOZ_BUILD_DATE']);
    expect(checkConfiguredObjdir).toHaveBeenCalledOnce();
    expect(await readFile(first?.['MOZCONFIG'] ?? '', 'utf8')).toBe(
      `generated\n\n# Release overlay\noverlay\n\nmk_add_options MOZ_OBJDIR="${releaseObjdir(root)}"\n`
    );
    const output = stepOutputDirectory(join(root, 'coordinator'), JOB, 0, {
      command: 'package',
      args: ['--recipe', 'release'],
    });
    const identity = JSON.parse(await readFile(join(output ?? '', 'release.json'), 'utf8')) as {
      buildDate: string;
    };
    expect(identity).toMatchObject({ recipe: 'release', toolchain: 'tools', secrets: [] });
    expect(identity.buildDate).toBe(first?.['MOZ_BUILD_DATE']);
  });

  it('passes the secrets directory as declared, and only then', async () => {
    const declared = { overlay: OVERLAY, secrets: { variable: 'KEYS', files: ['api.key'] } };
    await writeFile(join(secrets, 'api.key'), 'not in any record\n');
    vi.mocked(readCoordinatorConfig).mockResolvedValue({ releaseSecrets: secrets } as never);
    admit(declared);
    await packageRelease(root);
    expect(vi.mocked(runMach).mock.calls[0]?.[2]?.env?.['KEYS']).toBe(secrets);
  });

  it('stops at the Mach run that failed', async () => {
    admit({ overlay: OVERLAY });
    vi.mocked(runMach).mockResolvedValue(3);
    const refusal = await packageRelease(root).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(BuildError);
    expect((refusal as Error).message).toMatch(/mach build -j7 exited 3/);
    expect(runMach).toHaveBeenCalledOnce();
    expect(checkConfiguredObjdir).not.toHaveBeenCalled();
  });
});
