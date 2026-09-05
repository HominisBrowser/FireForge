// SPDX-License-Identifier: EUPL-1.2
/**
 * The exit-code contract, checked from both ends.
 *
 * Every concrete `FireForgeError` subclass is instantiated and its `code`
 * asserted against the table below; the table is then reconciled against
 * the class -> code rows in `docs/exit-codes.md`, so a class that changes
 * code, a doc row that drifts, or a new class nobody documented all fail
 * here rather than surfacing as a CI script branching on the wrong number.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CancellationError,
  ExecTimeoutError,
  type FireForgeError,
  GeneralError,
  InconclusiveVerdictError,
  InternalInvariantError,
  InvalidArgumentError,
  LockContentionError,
  ParserFallbackError,
  PreflightRefusalError,
  ResolutionError,
} from '../base.js';
import {
  AmbiguousBuildArtifactsError,
  BootstrapError,
  BuildError,
  MachNotFoundError,
  MozconfigError,
  PythonNotFoundError,
  TestFailureError,
} from '../build.js';
import { ExitCode } from '../codes.js';
import { ConfigError, ConfigNotFoundError } from '../config.js';
import {
  ChecksumMismatchError,
  DownloadError,
  EngineExistsError,
  ExtractionError,
  PartialEngineExistsError,
  VersionNotFoundError,
} from '../download.js';
import { FurnaceError } from '../furnace.js';
import {
  GitError,
  GitIndexingTimeoutError,
  GitIndexLockError,
  GitNotFoundError,
  PatchApplyError,
} from '../git.js';
import { PatchError, PatchManifestCorruptError } from '../patch.js';
import {
  CorruptRebaseSessionError,
  NoRebaseSessionError,
  RebaseError,
  RebaseSessionExistsError,
} from '../rebase.js';
import { SmokeRunError } from '../run.js';

interface ContractRow {
  /** Class name, as it appears in `docs/exit-codes.md`. */
  readonly name: string;
  readonly make: () => FireForgeError;
  readonly code: ExitCode;
  /**
   * Name the doc lists this class under when it is covered by a base class
   * row ("`GitError` and subclasses") rather than named outright.
   */
  readonly listedAs?: string;
}

/** Every concrete FireForgeError subclass, with the code it must carry. */
const CONTRACT: readonly ContractRow[] = [
  { name: 'GeneralError', make: () => new GeneralError('x'), code: ExitCode.GENERAL_ERROR },
  {
    name: 'PreflightRefusalError',
    make: () => new PreflightRefusalError('x', 'stale-browser'),
    code: ExitCode.GENERAL_ERROR,
    listedAs: 'GeneralError',
  },
  {
    name: 'ParserFallbackError',
    make: () => new ParserFallbackError('x'),
    code: ExitCode.GENERAL_ERROR,
  },
  {
    name: 'ExecTimeoutError',
    make: () => new ExecTimeoutError('git', ['status'], 1000),
    code: ExitCode.GENERAL_ERROR,
  },
  { name: 'ConfigError', make: () => new ConfigError('x'), code: ExitCode.CONFIG_ERROR },
  {
    name: 'ConfigNotFoundError',
    make: () => new ConfigNotFoundError('fireforge.json'),
    code: ExitCode.CONFIG_ERROR,
    listedAs: 'ConfigError',
  },
  { name: 'DownloadError', make: () => new DownloadError('x'), code: ExitCode.DOWNLOAD_ERROR },
  {
    name: 'ChecksumMismatchError',
    make: () => new ChecksumMismatchError('firefox', 'a', 'b', 'https://x'),
    code: ExitCode.DOWNLOAD_ERROR,
    listedAs: 'DownloadError',
  },
  {
    name: 'ExtractionError',
    make: () => new ExtractionError('/a.tar'),
    code: ExitCode.DOWNLOAD_ERROR,
    listedAs: 'DownloadError',
  },
  {
    name: 'VersionNotFoundError',
    make: () => new VersionNotFoundError('1'),
    code: ExitCode.DOWNLOAD_ERROR,
    listedAs: 'DownloadError',
  },
  {
    name: 'EngineExistsError',
    make: () => new EngineExistsError('/engine'),
    code: ExitCode.DOWNLOAD_ERROR,
    listedAs: 'DownloadError',
  },
  {
    name: 'PartialEngineExistsError',
    make: () => new PartialEngineExistsError('/engine'),
    code: ExitCode.DOWNLOAD_ERROR,
    listedAs: 'DownloadError',
  },
  { name: 'GitError', make: () => new GitError('x'), code: ExitCode.GIT_ERROR },
  {
    name: 'PatchApplyError',
    make: () => new PatchApplyError('/p.patch'),
    code: ExitCode.GIT_ERROR,
    listedAs: 'GitError',
  },
  {
    name: 'GitIndexLockError',
    make: () => new GitIndexLockError('/index.lock'),
    code: ExitCode.GIT_ERROR,
    listedAs: 'GitError',
  },
  {
    name: 'GitIndexingTimeoutError',
    make: () => new GitIndexingTimeoutError('monolithic', 1000, 'X'),
    code: ExitCode.GIT_ERROR,
    listedAs: 'GitError',
  },
  { name: 'BuildError', make: () => new BuildError('x'), code: ExitCode.BUILD_ERROR },
  { name: 'TestFailureError', make: () => new TestFailureError('x'), code: ExitCode.BUILD_ERROR },
  {
    name: 'BootstrapError',
    make: () => new BootstrapError(),
    code: ExitCode.BUILD_ERROR,
    listedAs: 'BuildError',
  },
  {
    name: 'MozconfigError',
    make: () => new MozconfigError('x'),
    code: ExitCode.BUILD_ERROR,
    listedAs: 'BuildError',
  },
  {
    name: 'AmbiguousBuildArtifactsError',
    make: () => new AmbiguousBuildArtifactsError(['a', 'b']),
    code: ExitCode.BUILD_ERROR,
    listedAs: 'BuildError',
  },
  { name: 'PatchError', make: () => new PatchError('x'), code: ExitCode.PATCH_ERROR },
  {
    name: 'PatchManifestCorruptError',
    make: () => new PatchManifestCorruptError('/patches.json'),
    code: ExitCode.PATCH_ERROR,
  },
  { name: 'RebaseError', make: () => new RebaseError('x'), code: ExitCode.PATCH_ERROR },
  {
    name: 'RebaseSessionExistsError',
    make: () => new RebaseSessionExistsError(),
    code: ExitCode.PATCH_ERROR,
    listedAs: 'RebaseError',
  },
  {
    name: 'NoRebaseSessionError',
    make: () => new NoRebaseSessionError(),
    code: ExitCode.PATCH_ERROR,
    listedAs: 'RebaseError',
  },
  {
    name: 'CorruptRebaseSessionError',
    make: () => new CorruptRebaseSessionError('/s.json', 'bad'),
    code: ExitCode.PATCH_ERROR,
    listedAs: 'RebaseError',
  },
  {
    name: 'PythonNotFoundError',
    make: () => new PythonNotFoundError(),
    code: ExitCode.MISSING_DEPENDENCY,
  },
  {
    name: 'GitNotFoundError',
    make: () => new GitNotFoundError(),
    code: ExitCode.MISSING_DEPENDENCY,
  },
  {
    name: 'MachNotFoundError',
    make: () => new MachNotFoundError('/engine'),
    code: ExitCode.MISSING_DEPENDENCY,
  },
  {
    name: 'InvalidArgumentError',
    make: () => new InvalidArgumentError('x'),
    code: ExitCode.INVALID_ARGUMENT,
  },
  { name: 'FurnaceError', make: () => new FurnaceError('x'), code: ExitCode.FURNACE_ERROR },
  {
    name: 'ResolutionError',
    make: () => new ResolutionError('x'),
    code: ExitCode.RESOLUTION_ERROR,
  },
  {
    name: 'InternalInvariantError',
    make: () => new InternalInvariantError('x'),
    code: ExitCode.INTERNAL_ERROR,
  },
  {
    name: 'SmokeRunError',
    make: () => new SmokeRunError('x', ExitCode.SMOKE_EXIT_FAILURE),
    code: ExitCode.SMOKE_EXIT_FAILURE,
  },
  {
    name: 'SmokeRunError',
    make: () => new SmokeRunError('x', ExitCode.SMOKE_LAUNCH_FAILURE),
    code: ExitCode.SMOKE_LAUNCH_FAILURE,
  },
  {
    name: 'InconclusiveVerdictError',
    make: () => new InconclusiveVerdictError('x'),
    code: ExitCode.INCONCLUSIVE,
  },
  {
    name: 'LockContentionError',
    make: () => new LockContentionError('x'),
    code: ExitCode.LOCK_TIMEOUT,
  },
  { name: 'CancellationError', make: () => new CancellationError(), code: ExitCode.USER_CANCELLED },
];

/**
 * Parses the `| code | NAME | meaning | produced by |` table in
 * docs/exit-codes.md into a class-name -> codes map. A class may appear in
 * more than one row (SmokeRunError spans 12 and 13).
 */
function readDocumentedCodes(): Map<string, Set<number>> {
  const doc = readFileSync(join(process.cwd(), 'docs', 'exit-codes.md'), 'utf-8');
  const documented = new Map<string, Set<number>>();
  for (const line of doc.split('\n')) {
    const match = /^\|\s*(\d+)\s*\|(?:[^|]*\|){2}([^|]*)\|/.exec(line);
    if (!match) continue;
    const code = Number(match[1]);
    const producedBy = match[2] ?? '';
    for (const [, name] of producedBy.matchAll(/`([A-Za-z]+)`/g)) {
      if (name === undefined) continue;
      const codes = documented.get(name) ?? new Set<number>();
      codes.add(code);
      documented.set(name, codes);
    }
  }
  return documented;
}

describe('exit-code contract', () => {
  it.each(CONTRACT.map((row) => [row.name, row.code, row] as const))(
    '%s carries exit code %i',
    (_name, code, row) => {
      const error = row.make();
      expect(error.code).toBe(code);
      expect(error.name).toBe(row.name);
    }
  );

  it('matches the class -> code rows in docs/exit-codes.md', () => {
    const documented = readDocumentedCodes();
    expect(documented.size).toBeGreaterThan(0);

    for (const row of CONTRACT) {
      const listedAs = row.listedAs ?? row.name;
      const codes = documented.get(listedAs);
      expect(
        codes,
        `${row.name} (listed as ${listedAs}) is missing from docs/exit-codes.md`
      ).toBeDefined();
      expect(
        codes?.has(row.code),
        `docs/exit-codes.md lists ${listedAs} under ${[...(codes ?? [])].join(',')}, code says ${row.code}`
      ).toBe(true);
    }
  });

  it('documents no class the contract table does not know', () => {
    const documented = readDocumentedCodes();
    const known = new Set(CONTRACT.map((row) => row.name));
    for (const name of documented.keys()) {
      expect(known.has(name), `docs/exit-codes.md names ${name}, which is not in CONTRACT`).toBe(
        true
      );
    }
  });
});
