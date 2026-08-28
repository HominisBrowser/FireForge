// SPDX-License-Identifier: EUPL-1.2
/**
 * Typed `vi.mock` factories for the modules the suite replaces most.
 *
 * Each enumerates the full export surface of its module. The `satisfies`
 * clauses are the point: `tsc --noEmit` fails the moment the real module
 * gains an export the factory does not provide, so the breakage is a compile
 * error in ONE file rather than a runtime "No X export defined on mock" in
 * every suite whose hand-rolled factory happened to omit it.
 *
 * Usage:
 *
 * ```ts
 * vi.mock('../../utils/logger.js', () => createLoggerMock());
 * ```
 *
 * To assert on a call, import the symbol normally and wrap it in `vi.mocked`.
 * To override one behaviour, spread and replace:
 *
 * ```ts
 * vi.mock('../../utils/fs.js', () => ({
 *   ...createFsMock(),
 *   pathExists: vi.fn(() => Promise.resolve(true)),
 * }));
 * ```
 */
import { vi } from 'vitest';

import type { SpinnerHandle } from '../utils/logger.js';

/**
 * The real modules' shapes. The factories below are annotated with these,
 * which is what makes a missing export a compile error here rather than a
 * runtime failure in every consuming suite.
 */
type LoggerModule = typeof import('../utils/logger.js');
type FsModule = typeof import('../utils/fs.js');
type RunLogModule = typeof import('../core/run-log.js');

/** A no-op spinner handle, so a mocked `spinner()` can be used like the real one. */
function makeSpinnerHandle(): SpinnerHandle {
  return {
    start: vi.fn(),
    message: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
  } as unknown as SpinnerHandle;
}

/**
 * Full-surface mock for `src/utils/logger.ts`.
 *
 * Output helpers are inert. The mode accessors return `false` so a suite that
 * does not care about machine mode behaves as if it is off; override them per
 * test when that is the subject.
 *
 * @returns An object providing every export of the real logger module
 */
export function createLoggerMock(): LoggerModule {
  return {
    setVerbose: vi.fn(),
    setMachineOutputMode: vi.fn(),
    isMachineOutputMode: vi.fn(() => false),
    setStdoutSealed: vi.fn(),
    isStdoutSealed: vi.fn(() => false),
    isVerbose: vi.fn(() => false),
    verbose: vi.fn(),
    intro: vi.fn(),
    outro: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    NOTICE_PREFIX: '[FireForge] NOTICE:',
    notice: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
    message: vi.fn(),
    formatSuccessText: vi.fn((text: string) => text),
    formatErrorText: vi.fn((text: string) => text),
    spinner: vi.fn(() => makeSpinnerHandle()),
    cancel: vi.fn(),
    // `isCancel` is a type predicate on the real module; the mock must keep
    // that signature or every non-cancelled branch loses its narrowing.
    isCancel: vi.fn(
      (value: unknown) => typeof value === 'symbol'
    ) as unknown as LoggerModule['isCancel'],
    note: vi.fn(),
  };
}

/**
 * Full-surface mock for `src/utils/fs.ts`.
 *
 * Predicates default to "absent" and readers to empty, which is the safe
 * default for a suite that has not set up a fixture: a test that needs a file
 * to exist must say so, rather than passing because the mock invented one.
 *
 * @returns An object providing every export of the real fs-helper module
 */
export function createFsMock(): FsModule {
  return {
    pathExists: vi.fn(() => Promise.resolve(false)),
    pathExistsStrict: vi.fn(() => Promise.resolve(false)),
    ensureDir: vi.fn(() => Promise.resolve()),
    removeDir: vi.fn(() => Promise.resolve()),
    removeFile: vi.fn(() => Promise.resolve()),
    isSymlink: vi.fn(() => Promise.resolve(false)),
    copyFile: vi.fn(() => Promise.resolve()),
    // `readJson` is generic on the real module; the cast is scoped to this
    // one property so the rest of the object keeps its exhaustiveness check.
    readJson: vi.fn(() => Promise.resolve({})) as unknown as FsModule['readJson'],
    writeJson: vi.fn(() => Promise.resolve()),
    readText: vi.fn(() => Promise.resolve('')),
    writeText: vi.fn(() => Promise.resolve()),
    writeTextIfChanged: vi.fn(() => Promise.resolve(true)),
    writeFileAtomic: vi.fn(() => Promise.resolve()),
    copyDir: vi.fn(() => Promise.resolve()),
    FIREFORGE_TMP_PATH_PATTERN: /\.fireforge-tmp-/,
    checkDiskSpace: vi.fn(() => Promise.resolve(undefined)),
  };
}

/**
 * Full-surface mock for `src/core/run-log.ts`, opening no log at all.
 *
 * A command suite that asserts the `FIREFORGE-VERDICT:` line by exact string
 * needs the run log ABSENT, because the line carries an open log's path as a
 * ` log=<path>` suffix. Those suites used to get that for free: they pass
 * `/project` as the project root, and `mkdir('/project/.fireforge/logs')`
 * fails at the filesystem root on POSIX, so the best-effort open degraded to
 * "no log". On Windows the same path resolves against the current drive, the
 * mkdir SUCCEEDS, and every one of those assertions fails — while the run
 * also leaves real directories behind on the runner's drive root. Saying "no
 * log" here states the precondition instead of inheriting it from a
 * permission error.
 *
 * `teeToRunLog` forwards to its base stream, which is what the real one does
 * when no log is open.
 *
 * @returns An object providing every export of the real run-log module
 */
export function createRunLogMock(): RunLogModule {
  return {
    getRunLogDir: vi.fn((projectRoot: string) => `${projectRoot}/.fireforge/logs`),
    openRunLog: vi.fn(() => Promise.resolve(undefined)),
    setActiveRunLog: vi.fn(),
    getActiveRunLogPath: vi.fn(() => undefined),
    writeToActiveRunLog: vi.fn(),
    closeActiveRunLog: vi.fn(() => Promise.resolve()),
    teeToRunLog: vi.fn((base: NodeJS.WritableStream) => base),
  };
}
