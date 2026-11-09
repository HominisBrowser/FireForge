// SPDX-License-Identifier: EUPL-1.2
import { writeFile } from 'node:fs/promises';

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

  it('keeps a --force-written schema path when a known key is set afterwards', async () => {
    await configCommand(projectRoot, 'check.timeouts.lint', '30', { force: true });
    await configCommand(projectRoot, 'build.jobs', '8');

    const config = JSON.parse(await readProjectText(projectRoot, 'fireforge.json')) as {
      check?: { timeouts?: { lint?: number } };
      build?: { jobs?: number };
    };
    expect(config.build?.jobs).toBe(8);
    expect(config.check?.timeouts?.lint).toBe(30);
  });

  it('still rejects structurally invalid values for known keys after the raw-document change', async () => {
    await expect(configCommand(projectRoot, 'firefox.version', '')).rejects.toThrow(
      /Invalid value for "firefox\.version"/
    );
  });

  it('does not mislabel non-validation failures as invalid values', async () => {
    // A concurrent writer holding the config lock must surface as a lock
    // timeout, not as `Invalid value for "<key>"`. The old catch wrapped
    // everything from the locked round-trip in InvalidArgumentError,
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

  it('rejects unknown keys even with force, leaving fireforge.json untouched', async () => {
    const before = await readProjectText(projectRoot, 'fireforge.json');
    await expect(configCommand(projectRoot, 'custom.key', '1', { force: true })).rejects.toThrow(
      /unknown key "custom"/
    );
    await expect(
      configCommand(projectRoot, 'patchLint.prettir', '"error"', { force: true })
    ).rejects.toThrow(/Did you mean "prettier"\?/);
    expect(await readProjectText(projectRoot, 'fireforge.json')).toBe(before);
  });

  it('validates schema-known keys that were missing from the known-path list', async () => {
    await expect(
      configCommand(projectRoot, 'patchLint.prettier', 'banana', { force: true })
    ).rejects.toThrow('Invalid value for "patchLint.prettier"');
    await configCommand(projectRoot, 'patchLint.prettier', 'error');
    const config = JSON.parse(await readProjectText(projectRoot, 'fireforge.json')) as {
      patchLint?: { prettier?: string };
    };
    expect(config.patchLint?.prettier).toBe('error');
  });

  it('still rejects invalid values for known keys even with force', async () => {
    await expect(
      configCommand(projectRoot, 'build.jobs', '"oops"', { force: true })
    ).rejects.toThrow('Invalid value for "build.jobs"');

    const config = JSON.parse(await readProjectText(projectRoot, 'fireforge.json')) as {
      build?: { jobs?: number };
    };
    expect(config.build?.jobs).not.toBe('oops');
  });

  it('rejects prototype-pollution attempts even with --force', async () => {
    // `--force` must never be allowed to walk into `__proto__`,
    // `constructor`, or `prototype`. Those segments are filtered in
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
    // Defensive cleanup via `Reflect.deleteProperty`. The guard should
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
    // before-state. A real rewrite would still update mtime by at
    // least one millisecond on every supported filesystem.

    vi.mocked(info).mockClear();
    await configCommand(projectRoot, 'firefox.version', '140.9.0esr');
    const afterStat = await stat(`${projectRoot}/fireforge.json`);

    // mtimeMs must be equal, showing the file was not rewritten.
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(info).toHaveBeenCalledWith('firefox.version = 140.9.0esr (unchanged)');
  });

  it('detects no-op writes for forced schema paths', async () => {
    // The short-circuit also covers --force writes: re-setting a
    // previously forced key to its current value must not rewrite the
    // file or duplicate the success line.
    await configCommand(projectRoot, 'check.timeouts.lint', '5', { force: true });
    const { stat } = await import('node:fs/promises');
    const beforeStat = await stat(`${projectRoot}/fireforge.json`);

    vi.mocked(info).mockClear();
    await configCommand(projectRoot, 'check.timeouts.lint', '5', { force: true });
    const afterStat = await stat(`${projectRoot}/fireforge.json`);

    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(info).toHaveBeenCalledWith('check.timeouts.lint = 5 (unchanged)');
  });

  it('changes only the set key and keeps compact sections on one line', async () => {
    const compact = [
      '{',
      '  "name": "Test Browser", "vendor": "Test", "appId": "org.test.browser",',
      '  "binaryName": "testbrowser",',
      '  "firefox": { "version": "140.0esr", "product": "firefox-esr" },',
      '  "patchLint": { "rawColorAllowlist": ["a.css", "b.css"] }',
      '}',
      '',
    ].join('\n');
    await writeFile(`${projectRoot}/fireforge.json`, compact);

    await configCommand(projectRoot, 'build.jobs', '8');
    await configCommand(projectRoot, 'patchLint.rawColorAllowlist', '["a.css","b.css","c.css"]');

    expect(await readProjectText(projectRoot, 'fireforge.json')).toBe(
      compact
        .replace('"b.css"]', '"b.css", "c.css"]')
        .replace('] }\n}', '] },\n  "build": {\n    "jobs": 8\n  }\n}')
    );
  });

  it('keeps earlier forced schema paths when later --force writes land', async () => {
    await configCommand(projectRoot, 'check.timeouts.lint', '5', { force: true });
    await configCommand(projectRoot, 'check.timeouts.verify', '7', { force: true });

    const config = JSON.parse(await readProjectText(projectRoot, 'fireforge.json')) as {
      check?: { timeouts?: Record<string, number> };
    };
    expect(config.check?.timeouts).toEqual({ lint: 5, verify: 7 });
  });
});
