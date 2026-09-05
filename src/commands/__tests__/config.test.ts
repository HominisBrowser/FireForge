// SPDX-License-Identifier: EUPL-1.2
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  readProjectText,
  removeTempProject,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { createLoggerMock } from '../../test-utils/module-mocks.js';
import { configCommand } from '../config.js';

/**
 * Per-test override for withConfigFileLock. Undefined → real locking.
 * Lets the error-classification test simulate a lock timeout without
 * waiting out the real 30 s acquisition window.
 */
let lockOverride: (() => Promise<never>) | undefined;

vi.mock('../../core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/config.js')>();
  return {
    ...actual,
    withConfigFileLock: vi.fn((root: string, operation: () => Promise<unknown>) =>
      lockOverride ? lockOverride() : actual.withConfigFileLock(root, operation)
    ),
  };
});

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { info, warn } from '../../utils/logger.js';

describe('configCommand', () => {
  let projectRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectRoot = await createTempProject();
    await writeFireForgeConfig(projectRoot);
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('sets and gets build.jobs without force', async () => {
    await configCommand(projectRoot, 'build.jobs', '16');
    await configCommand(projectRoot, 'build.jobs');

    const config = JSON.parse(await readProjectText(projectRoot, 'fireforge.json')) as {
      build?: { jobs?: number };
    };
    expect(config.build?.jobs).toBe(16);
    expect(info).toHaveBeenCalledWith('build.jobs = 16');
  });

  it('sets and gets wire.subscriptDir without force', async () => {
    // String-typed keys are stored as-is (no JSON.parse), so no wrapping quotes needed
    await configCommand(projectRoot, 'wire.subscriptDir', 'browser/components/custom');
    await configCommand(projectRoot, 'wire.subscriptDir');

    const config = JSON.parse(await readProjectText(projectRoot, 'fireforge.json')) as {
      wire?: { subscriptDir?: string };
    };
    expect(config.wire?.subscriptDir).toBe('browser/components/custom');
    expect(info).toHaveBeenCalledWith('wire.subscriptDir = browser/components/custom');
  });

  it('preserves --force-written keys when a known key is set afterwards', async () => {
    // Round-tripping the ordinary set branch through loadConfig →
    // validateConfig, whose typed clone contains only known schema fields,
    // makes ANY normal `config <key> <value>` silently delete every
    // previously --force-written key. Both branches mutate the raw document.
    await configCommand(projectRoot, 'myext.flag', 'true', { force: true });
    await configCommand(projectRoot, 'build.jobs', '8');

    const config = JSON.parse(await readProjectText(projectRoot, 'fireforge.json')) as {
      myext?: { flag?: boolean };
      build?: { jobs?: number };
    };
    expect(config.build?.jobs).toBe(8);
    expect(config.myext?.flag).toBe(true);
  });

  it('still rejects structurally invalid values for known keys after the raw-document change', async () => {
    await expect(configCommand(projectRoot, 'firefox.version', '')).rejects.toThrow(
      /Invalid value for "firefox\.version"/
    );
  });

  it('does not mislabel non-validation failures as invalid values', async () => {
    // A concurrent writer holding the config lock must surface as a lock
    // timeout, not as `Invalid value for "<key>"` — the old catch wrapped
    // EVERYTHING from the locked round-trip in InvalidArgumentError,
    // pointing diagnosis at the value and returning the wrong exit-code
    // class when the actual problem was lock contention.
    lockOverride = () => Promise.reject(new Error('Timed out waiting to update fireforge.json.'));

    try {
      const rejection = expect(configCommand(projectRoot, 'build.jobs', '4')).rejects;
      await rejection.toThrow(/Timed out waiting/);
      await expect(configCommand(projectRoot, 'build.jobs', '4')).rejects.not.toThrow(
        /Invalid value/
      );
    } finally {
      lockOverride = undefined;
    }
  });

  it('keeps string-typed Firefox versions as strings without requiring JSON quoting', async () => {
    await configCommand(projectRoot, 'firefox.version', '140.9.0esr');

    const config = JSON.parse(await readProjectText(projectRoot, 'fireforge.json')) as {
      firefox?: { version?: string };
    };
    expect(config.firefox?.version).toBe('140.9.0esr');
  });

  it('sets firefox.sha256 without force', async () => {
    const digest = 'b'.repeat(64);

    await configCommand(projectRoot, 'firefox.sha256', digest);
    await configCommand(projectRoot, 'firefox.sha256');

    const config = JSON.parse(await readProjectText(projectRoot, 'fireforge.json')) as {
      firefox?: { sha256?: string };
    };
    expect(config.firefox?.sha256).toBe(digest);
    expect(info).toHaveBeenCalledWith(`firefox.sha256 = ${digest}`);
  });

  it('prints not set for absent supported optional keys', async () => {
    await configCommand(projectRoot, 'firefox.sha256');

    expect(info).toHaveBeenCalledWith('firefox.sha256 = (not set)');
  });

  it('warns when JSON parsing would coerce the stored value to a non-string type', async () => {
    await configCommand(projectRoot, 'build.jobs', '16');

    expect(warn).toHaveBeenCalledWith(
      `Value "16" was interpreted as number. Use '"16"' for a string.`
    );
  });

  it('rejects reads for unknown keys', async () => {
    await expect(configCommand(projectRoot, 'firefox.channel')).rejects.toThrow(
      'Unknown config key: firefox.channel'
    );
  });

  it('fails cleanly when no project config exists', async () => {
    await removeTempProject(projectRoot);
    projectRoot = await createTempProject();

    await expect(configCommand(projectRoot, 'build.jobs')).rejects.toThrow(
      'No fireforge.json found. Run "fireforge setup" to create a project.'
    );
  });

  it('rejects unknown top-level keys without force', async () => {
    await expect(configCommand(projectRoot, 'custom.key', '1')).rejects.toThrow(
      'Unknown config key prefix: "custom"'
    );
  });

  it('rejects unknown nested keys without force', async () => {
    await expect(configCommand(projectRoot, 'firefox.channel', '"nightly"')).rejects.toThrow(
      'Unknown config key: "firefox.channel"'
    );
  });

  it('rejects invalid values for known keys without force', async () => {
    await expect(configCommand(projectRoot, 'build.jobs', '"oops"')).rejects.toThrow(
      'Invalid value for "build.jobs"'
    );
  });

  it('accepts unknown top-level keys with force', async () => {
    await configCommand(projectRoot, 'custom.key', '1', { force: true });

    const config = JSON.parse(await readProjectText(projectRoot, 'fireforge.json')) as {
      custom?: { key?: number };
    };
    expect(config.custom?.key).toBe(1);
  });

  it('still rejects invalid values for known keys even with force', async () => {
    // --force is intended as an escape hatch for *unknown* keys. It must
    // not also let the user write a structurally invalid value for a
    // known key — that bypass would silently corrupt fireforge.json so
    // the next loadConfig fails with no breadcrumb back to this write.
    await expect(
      configCommand(projectRoot, 'build.jobs', '"oops"', { force: true })
    ).rejects.toThrow('Invalid value for "build.jobs"');

    const config = JSON.parse(await readProjectText(projectRoot, 'fireforge.json')) as {
      build?: { jobs?: number };
    };
    // The original value remains untouched.
    expect(config.build?.jobs).not.toBe('oops');
  });

  it('reads keys that were persisted via --force (raw-document fallback)', async () => {
    // A value written with `fireforge config foo bar --force` is readable on
    // disk, but a read path that consults the validated config throws
    // `Unknown config key` because `validateConfig` strips it from the typed
    // result. The get branch reads the raw JSON document so forced keys
    // round-trip.
    await configCommand(projectRoot, 'totallyUnknown', 'forced-value', { force: true });

    vi.mocked(info).mockClear();
    await configCommand(projectRoot, 'totallyUnknown');

    expect(info).toHaveBeenCalledWith('totallyUnknown = forced-value');
  });

  it('rejects prototype-pollution attempts even with --force', async () => {
    // `--force` must never be allowed to walk into `__proto__`,
    // `constructor`, or `prototype` — those segments are filtered in
    // `mutateConfig` so the descent cannot rewrite Object.prototype
    // process-wide. The guard surfaces as a ConfigError, which the
    // command wraps into an InvalidArgumentError.
    const pollutionProbeKey = 'fireforgeCliPollutionProbe';

    await expect(
      configCommand(projectRoot, `__proto__.${pollutionProbeKey}`, '1', { force: true })
    ).rejects.toThrow(/reserved segment "__proto__"/);

    await expect(configCommand(projectRoot, 'constructor', '1', { force: true })).rejects.toThrow(
      /reserved segment "constructor"/
    );

    await expect(
      configCommand(projectRoot, `nested.prototype.${pollutionProbeKey}`, '1', { force: true })
    ).rejects.toThrow(/reserved segment "prototype"/);

    expect(({} as Record<string, unknown>)[pollutionProbeKey]).toBeUndefined();
    // Defensive cleanup via `Reflect.deleteProperty` — the guard should
    // have rejected every attempt, but we strip the probe key regardless
    // so a future regression can't leak pollution into sibling tests.
    Reflect.deleteProperty(Object.prototype, pollutionProbeKey);
  });

  it('skips the file rewrite when the value is unchanged', async () => {
    // `fireforge config <key> <current-value>` must not run loadConfig →
    // mutateConfig → writeConfig, which round-trips the file through
    // `JSON.stringify` and reorders top-level keys (license, markerComment,
    // …) on every harmless re-set, producing diff churn on a no-op. The
    // short-circuit keeps the file untouched (mtime stays equal) and
    // surfaces an explicit "(unchanged)" marker in the success log.
    const { stat } = await import('node:fs/promises');
    await configCommand(projectRoot, 'firefox.version', '140.9.0esr');
    const beforeStat = await stat(`${projectRoot}/fireforge.json`);
    // Synthetic delay would matter only if mtime resolution masks the
    // before-state; a real rewrite would still update mtime by at
    // least one millisecond on every supported filesystem.

    vi.mocked(info).mockClear();
    await configCommand(projectRoot, 'firefox.version', '140.9.0esr');
    const afterStat = await stat(`${projectRoot}/fireforge.json`);

    // mtimeMs must be equal — the file was not rewritten.
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(info).toHaveBeenCalledWith('firefox.version = 140.9.0esr (unchanged)');
  });

  it('detects no-op writes for forced unknown keys', async () => {
    // The short-circuit also covers --force writes: re-setting a
    // previously forced key to its current value must not rewrite the
    // file or duplicate the success line.
    await configCommand(projectRoot, 'arbitraryUnknown', 'one', { force: true });
    const { stat } = await import('node:fs/promises');
    const beforeStat = await stat(`${projectRoot}/fireforge.json`);

    vi.mocked(info).mockClear();
    await configCommand(projectRoot, 'arbitraryUnknown', 'one', { force: true });
    const afterStat = await stat(`${projectRoot}/fireforge.json`);

    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(info).toHaveBeenCalledWith('arbitraryUnknown = one (unchanged)');
  });

  it('preserves earlier forced keys when subsequent --force writes land', async () => {
    // Seeding the `--force` write path from `loadConfig`, which strips
    // unknowns, makes writing a second forced key silently drop every
    // earlier forced key. The mutation is seeded from the raw document when
    // the key is unknown.
    await configCommand(projectRoot, 'firstUnknown', 'one', { force: true });
    await configCommand(projectRoot, 'secondUnknown', 'two', { force: true });

    const config = JSON.parse(await readProjectText(projectRoot, 'fireforge.json')) as Record<
      string,
      unknown
    >;
    expect(config['firstUnknown']).toBe('one');
    expect(config['secondUnknown']).toBe('two');
  });
});
