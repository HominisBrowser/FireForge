// SPDX-License-Identifier: EUPL-1.2
/**
 * Pin-vs-checkout reporting.
 *
 * `fireforge source set` writes the pin into fireforge.json beside
 * hand-maintained sections, so a routine `git checkout -- fireforge.json`
 * silently reverts an uncommitted pin. Nothing reported the divergence. The
 * field tell was a gate flipping green with no change that should have made
 * it green. This makes a mismatched tree visible as a report, never a lock.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/firefox.js', () => ({
  getFirefoxVersion: vi.fn(() => Promise.resolve(undefined)),
}));

import { getFirefoxVersion } from '../../core/firefox.js';
import type { DoctorCheck } from '../../types/commands/index.js';
import type { FireForgeConfig, FireForgeState } from '../../types/config.js';
import type { DoctorCheckContext } from '../doctor-check-core.js';
import { SOURCE_PIN_DOCTOR_CHECK } from '../doctor-source-pin.js';

function makeCtx(args: {
  version?: string;
  downloadedVersion?: string;
  engineExists?: boolean;
}): DoctorCheckContext {
  const config =
    args.version === undefined
      ? undefined
      : ({ firefox: { version: args.version, product: 'firefox-esr' } } as FireForgeConfig);
  return {
    projectRoot: '/project',
    paths: { engine: '/project/engine' },
    state: {
      ...(args.downloadedVersion !== undefined
        ? { downloadedVersion: args.downloadedVersion }
        : {}),
    } as FireForgeState,
    options: {},
    engineExists: args.engineExists ?? true,
    config,
    furnaceConfigExists: false,
    furnaceConfig: undefined,
    mutations: [],
  } as unknown as DoctorCheckContext;
}

async function run(ctx: DoctorCheckContext): Promise<DoctorCheck | DoctorCheck[]> {
  return await SOURCE_PIN_DOCTOR_CHECK.run(ctx);
}

describe('source pin doctor check', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getFirefoxVersion).mockResolvedValue(undefined);
  });

  it('is skipped without an engine', () => {
    expect(SOURCE_PIN_DOCTOR_CHECK.skipIf?.(makeCtx({ engineExists: false }))).toBe(true);
  });

  it('passes when the pin matches the engine checkout', async () => {
    vi.mocked(getFirefoxVersion).mockResolvedValue('140.9.0esr');
    const check = await run(makeCtx({ version: '140.9.0esr', downloadedVersion: '140.9.0esr' }));

    expect(check).toMatchObject({ severity: 'ok' });
    expect(JSON.stringify(check)).toContain('140.9.0esr');
  });

  it('warns when a reverted pin no longer matches version.txt', async () => {
    // The field incident: the pin was lost, the checkout was not.
    vi.mocked(getFirefoxVersion).mockResolvedValue('153.2.0esr');
    const check = await run(makeCtx({ version: '140.9.0esr' }));

    expect(check).toMatchObject({ severity: 'warning' });
    expect(JSON.stringify(check)).toContain('153.2.0esr');
    expect(JSON.stringify(check)).toContain('140.9.0esr');
  });

  it('warns when the recorded download disagrees with the pin', async () => {
    const check = await run(makeCtx({ version: '140.9.0esr', downloadedVersion: '153.2.0esr' }));

    expect(check).toMatchObject({ severity: 'warning' });
    expect(JSON.stringify(check)).toContain('last download');
  });

  it('treats a blank version.txt as absent, not as a mismatch against ""', async () => {
    // A truncated write or partial extraction must not read as "the engine is
    // at version empty-string".
    vi.mocked(getFirefoxVersion).mockResolvedValue('   ');
    expect(await run(makeCtx({ version: '140.9.0esr' }))).toMatchObject({ severity: 'ok' });
  });

  it('stays quiet when the config could not be loaded', async () => {
    // Its own check already reported that. A second complaint helps nobody.
    expect(await run(makeCtx({}))).toMatchObject({ severity: 'ok' });
  });

  it('degrades to ok when version.txt cannot be read', async () => {
    vi.mocked(getFirefoxVersion).mockRejectedValue(new Error('EACCES'));
    const check = await run(makeCtx({ version: '140.9.0esr' }));

    expect(check).toMatchObject({ severity: 'ok' });
    expect(JSON.stringify(check)).toContain('EACCES');
  });
});
