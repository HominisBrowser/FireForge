// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatMajorVersionHopNotice,
  formatToolchainMismatchMessage,
  readDeclaredToolchainMinimums,
  runToolchainPreflight,
} from '../toolchain-preflight.js';

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: mockExecFile,
  };
});

vi.mock('../../utils/logger.js', () => ({
  verbose: vi.fn(),
}));

/** Registers an execFile behaviour keyed by binary name. */
function mockHostVersions(outputs: Record<string, string | Error>): void {
  mockExecFile.mockImplementation(
    (
      binary: string,
      _args: readonly string[],
      _options: unknown,
      callback: (err: Error | null, stdout: string, stderr: string) => void
    ) => {
      const entry = outputs[binary];
      if (entry === undefined || entry instanceof Error) {
        callback(entry ?? new Error(`spawn ${binary} ENOENT`), '', '');
        return;
      }
      callback(null, entry, '');
    }
  );
}

/** Writes the two in-tree minimum declarations into a fixture engine dir. */
async function writeMinimumFixtures(
  engineDir: string,
  fixtures: { cbindgen?: string; rust?: string }
): Promise<void> {
  if (fixtures.cbindgen !== undefined) {
    const path = join(engineDir, 'build/moz.configure/bindgen.configure');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, fixtures.cbindgen);
  }
  if (fixtures.rust !== undefined) {
    const path = join(engineDir, 'python/mozboot/mozboot/util.py');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, fixtures.rust);
  }
}

// Verbatim shapes from a real Firefox tree (Firefox beta, 2026).
const BINDGEN_CONFIGURE_FIXTURE = [
  'option(env="CBINDGEN", nargs=1, help="Path to cbindgen")',
  '',
  '@imports(_from="textwrap", _import="dedent")',
  'def check_cbindgen_version(cbindgen, fatal=False):',
  '    log.debug("trying cbindgen: %s" % cbindgen)',
  '',
  '    cbindgen_min_version = Version("0.29.4")',
  '',
  '    # cbindgen x.y.z',
  '    version = Version(check_cmd_output(cbindgen, "--version").strip().split(" ")[1])',
].join('\n');

const MOZBOOT_UTIL_FIXTURE = [
  'import os',
  '',
  '# Keep in sync with rust-version in top-level Cargo.toml.',
  'MINIMUM_RUST_VERSION = "1.82.0"',
].join('\n');

describe('formatMajorVersionHopNotice', () => {
  it('returns a notice when the major version changed', () => {
    const notice = formatMajorVersionHopNotice('152.0b7', '153.0b8');
    expect(notice).toContain('152 → 153');
    expect(notice).toContain('fireforge bootstrap');
  });

  it('parses esr-suffixed versions', () => {
    expect(formatMajorVersionHopNotice('140.9.0esr', '145.0.0esr')).toContain('140 → 145');
  });

  it('returns undefined on a same-major re-download', () => {
    expect(formatMajorVersionHopNotice('153.0b7', '153.0b8')).toBeUndefined();
    expect(formatMajorVersionHopNotice('153.0b8', '153.0b8')).toBeUndefined();
  });

  it('returns undefined on a first download (no previous version)', () => {
    expect(formatMajorVersionHopNotice(undefined, '153.0b8')).toBeUndefined();
    expect(formatMajorVersionHopNotice('', '153.0b8')).toBeUndefined();
  });

  it('returns undefined when either version is unparseable', () => {
    expect(formatMajorVersionHopNotice('unknown', '153.0b8')).toBeUndefined();
    expect(formatMajorVersionHopNotice('152.0b7', 'garbage')).toBeUndefined();
  });
});

describe('toolchain preflight', () => {
  let engineDir: string;
  let stateDir: string;
  let stateDirCbindgen: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    engineDir = await mkdtemp(join(tmpdir(), 'ff-toolchain-'));
    // Deterministic mach state dir: the probe consults
    // $MOZBUILD_STATE_PATH/cbindgen/cbindgen before PATH, exactly like
    // mach's configure. The execFile mock keys on the binary path, so no
    // real file needs to exist here.
    stateDir = join(engineDir, '.mozbuild-state');
    stateDirCbindgen = join(stateDir, 'cbindgen', 'cbindgen');
    vi.stubEnv('MOZBUILD_STATE_PATH', stateDir);
  });

  afterEach(async () => {
    await rm(engineDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  describe('readDeclaredToolchainMinimums', () => {
    it('parses both minimums from real declaration shapes', async () => {
      await writeMinimumFixtures(engineDir, {
        cbindgen: BINDGEN_CONFIGURE_FIXTURE,
        rust: MOZBOOT_UTIL_FIXTURE,
      });

      const minimums = await readDeclaredToolchainMinimums(engineDir);
      expect(minimums).toEqual({ cbindgen: '0.29.4', rustc: '1.82.0' });
    });

    it('skips tools whose declaration file is missing (fail-soft)', async () => {
      await writeMinimumFixtures(engineDir, { rust: MOZBOOT_UTIL_FIXTURE });

      const minimums = await readDeclaredToolchainMinimums(engineDir);
      expect(minimums).toEqual({ rustc: '1.82.0' });
    });

    it('skips tools whose declaration no longer matches the expected shape (fail-soft)', async () => {
      await writeMinimumFixtures(engineDir, {
        cbindgen: 'cbindgen_minimum = something_else()',
        rust: 'RUST_FLOOR = compute()',
      });

      const minimums = await readDeclaredToolchainMinimums(engineDir);
      expect(minimums).toEqual({});
    });
  });

  describe('runToolchainPreflight', () => {
    it('reports a definitive mismatch when every resolvable candidate is older than the tree minimum', async () => {
      // The drill's exact configuration: cbindgen 0.29.1 on the host
      // PATH (and no state-dir copy), 0.29.4 declared by the
      // freshly-hopped tree.
      await writeMinimumFixtures(engineDir, {
        cbindgen: BINDGEN_CONFIGURE_FIXTURE,
        rust: MOZBOOT_UTIL_FIXTURE,
      });
      mockHostVersions({
        cbindgen: 'cbindgen 0.29.1\n',
        rustc: 'rustc 1.93.0 (254b59607 2026-01-19)\n',
      });

      const mismatches = await runToolchainPreflight(engineDir);
      expect(mismatches).toEqual([
        {
          tool: 'cbindgen',
          minimumVersion: '0.29.4',
          declaredIn: 'build/moz.configure/bindgen.configure',
          candidates: [{ binary: 'cbindgen', version: '0.29.1' }],
        },
      ]);
    });

    it('passes when the mozbuild state-dir copy meets the minimum even though the PATH copy is older (0.35.0 false positive)', async () => {
      // Field configuration: fireforge bootstrap installed 0.29.4 into
      // ~/.mozbuild/cbindgen/cbindgen (which configure tries FIRST), while
      // an old 0.29.1 from ~/.cargo/bin shadowed it on PATH. 0.35.0
      // probed only the PATH copy and blocked a build that succeeds.
      await writeMinimumFixtures(engineDir, { cbindgen: BINDGEN_CONFIGURE_FIXTURE });
      mockHostVersions({
        [stateDirCbindgen]: 'cbindgen 0.29.4\n',
        cbindgen: 'cbindgen 0.29.1\n',
      });

      await expect(runToolchainPreflight(engineDir)).resolves.toEqual([]);
    });

    it('lists every probed candidate when all of them are too old', async () => {
      await writeMinimumFixtures(engineDir, { cbindgen: BINDGEN_CONFIGURE_FIXTURE });
      mockHostVersions({
        [stateDirCbindgen]: 'cbindgen 0.29.0\n',
        cbindgen: 'cbindgen 0.29.1\n',
      });

      const mismatches = await runToolchainPreflight(engineDir);
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]?.candidates).toEqual([
        { binary: stateDirCbindgen, version: '0.29.0' },
        { binary: 'cbindgen', version: '0.29.1' },
      ]);
    });

    it('passes when host versions satisfy the minimums', async () => {
      await writeMinimumFixtures(engineDir, {
        cbindgen: BINDGEN_CONFIGURE_FIXTURE,
        rust: MOZBOOT_UTIL_FIXTURE,
      });
      mockHostVersions({
        cbindgen: 'cbindgen 0.29.4\n',
        rustc: 'rustc 1.82.0 (abcdef 2025-01-01)\n',
      });

      await expect(runToolchainPreflight(engineDir)).resolves.toEqual([]);
    });

    it('passes silently when the host binary is missing (fail-soft — configure owns that failure)', async () => {
      await writeMinimumFixtures(engineDir, {
        cbindgen: BINDGEN_CONFIGURE_FIXTURE,
        rust: MOZBOOT_UTIL_FIXTURE,
      });
      mockHostVersions({});

      await expect(runToolchainPreflight(engineDir)).resolves.toEqual([]);
    });

    it('passes silently when the version output is unparseable (fail-soft)', async () => {
      await writeMinimumFixtures(engineDir, { cbindgen: BINDGEN_CONFIGURE_FIXTURE });
      mockHostVersions({ cbindgen: 'something unexpected\n' });

      await expect(runToolchainPreflight(engineDir)).resolves.toEqual([]);
    });

    it('passes silently on a tree with no recognizable declarations (fail-soft)', async () => {
      const mismatches = await runToolchainPreflight(engineDir);
      expect(mismatches).toEqual([]);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('honours the CBINDGEN env override like mach configure does — the override wins even over a newer state-dir copy', async () => {
      await writeMinimumFixtures(engineDir, { cbindgen: BINDGEN_CONFIGURE_FIXTURE });
      vi.stubEnv('CBINDGEN', '/opt/tools/cbindgen-custom');
      // A satisfying state-dir copy exists, but configure would use the
      // env override anyway — so the preflight must fail on it.
      mockHostVersions({
        '/opt/tools/cbindgen-custom': 'cbindgen 0.29.1\n',
        [stateDirCbindgen]: 'cbindgen 0.29.4\n',
      });

      const mismatches = await runToolchainPreflight(engineDir);
      expect(mismatches).toHaveLength(1);
      expect(mismatches[0]?.candidates).toEqual([
        { binary: '/opt/tools/cbindgen-custom', version: '0.29.1' },
      ]);
      expect(mockExecFile).toHaveBeenCalledWith(
        '/opt/tools/cbindgen-custom',
        ['--version'],
        expect.anything(),
        expect.any(Function)
      );
      // With the override set, no other candidate is probed.
      expect(mockExecFile).not.toHaveBeenCalledWith(
        stateDirCbindgen,
        ['--version'],
        expect.anything(),
        expect.any(Function)
      );
    });

    it('compares component-wise, not lexically', async () => {
      // 0.30 vs 0.29.4: lexical comparison would call "0.30" lower than
      // "0.29.4" only if compared digit-by-digit — pin the numeric path.
      await writeMinimumFixtures(engineDir, { cbindgen: BINDGEN_CONFIGURE_FIXTURE });
      mockHostVersions({ cbindgen: 'cbindgen 0.30\n' });

      await expect(runToolchainPreflight(engineDir)).resolves.toEqual([]);
    });
  });

  describe('formatToolchainMismatchMessage', () => {
    it('names the tool, every probed candidate, the declaring file, and fireforge bootstrap', () => {
      const message = formatToolchainMismatchMessage([
        {
          tool: 'cbindgen',
          minimumVersion: '0.29.4',
          declaredIn: 'build/moz.configure/bindgen.configure',
          candidates: [
            { binary: '/home/u/.mozbuild/cbindgen/cbindgen', version: '0.29.0' },
            { binary: 'cbindgen', version: '0.29.1' },
          ],
        },
      ]);
      expect(message).toContain('0.29.4');
      expect(message).toContain('0.29.0 (/home/u/.mozbuild/cbindgen/cbindgen)');
      expect(message).toContain('0.29.1 (cbindgen)');
      expect(message).toContain('engine/build/moz.configure/bindgen.configure');
      expect(message).toContain('"fireforge bootstrap"');
    });
  });
});
