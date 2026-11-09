// SPDX-License-Identifier: EUPL-1.2
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readTemplate } from '../../jobs/slot-template.js';
import { resolveStaticDonor } from '../donor.js';

vi.mock('../../jobs/slot-template.js', async (original) => ({
  ...(await original<typeof import('../../jobs/slot-template.js')>()),
  readTemplate: vi.fn(),
}));

describe('the donor a command finds without being told', () => {
  let project: string;
  beforeEach(async () => {
    project = await realpath(await mkdtemp(join(tmpdir(), 'fireforge-donor-')));
    for (const repository of ['engine', 'named', 'environment']) {
      await mkdir(join(project, repository));
      execFileSync('git', ['-C', join(project, repository), 'init', '-q']);
    }
    vi.stubEnv('FIREFORGE_PRISTINE_REPOSITORY', undefined);
    vi.stubEnv('FIREFORGE_COORDINATOR', join(project, 'coordinator'));
    vi.mocked(readTemplate).mockReset();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(project, { recursive: true, force: true });
  });
  const declare = (config: string): Promise<void> =>
    writeFile(join(project, 'fireforge.json'), config);
  const ENGINE = (): string => join(project, 'engine');

  it('takes what it was told over anything it could find', async () => {
    await declare(JSON.stringify({ sources: { pristineCommit: 'pin' } }));
    const named = join(project, 'named');
    expect(await resolveStaticDonor(project, named)).toBe(named);
    expect(readTemplate).not.toHaveBeenCalled();
    const environment = join(project, 'environment');
    vi.stubEnv('FIREFORGE_PRISTINE_REPOSITORY', environment);
    expect(await resolveStaticDonor(project)).toBe(environment);
  });

  it("uses the template this host keeps for the project's pin", async () => {
    await declare(JSON.stringify({ sources: { pristineCommit: 'pin' } }));
    vi.mocked(readTemplate).mockResolvedValue({ repository: '/template' } as never);
    expect(await resolveStaticDonor(project)).toBe('/template');
    expect(readTemplate).toHaveBeenCalledWith(join(project, 'coordinator'), 'pin');
  });

  it("falls back to the checkout's engine with no template, or one it cannot read", async () => {
    await declare(JSON.stringify({ sources: { pristineCommit: 'pin' } }));
    vi.mocked(readTemplate).mockResolvedValue(undefined);
    expect(await resolveStaticDonor(project)).toBe(ENGINE());
    vi.mocked(readTemplate).mockRejectedValue(new Error('damaged'));
    expect(await resolveStaticDonor(project)).toBe(ENGINE());
  });

  it('looks for no template with no pin to look under, however the file reads', async () => {
    expect(await resolveStaticDonor(project)).toBe(ENGINE());
    await declare('{not json');
    expect(await resolveStaticDonor(project)).toBe(ENGINE());
    await declare('{}');
    expect(await resolveStaticDonor(project)).toBe(ENGINE());
    expect(readTemplate).not.toHaveBeenCalled();
  });

  it('refuses a configuration it cannot reach for any other reason', async () => {
    await mkdir(join(project, 'fireforge.json'));
    await expect(resolveStaticDonor(project)).rejects.toThrow(/EISDIR/);
  });
});
