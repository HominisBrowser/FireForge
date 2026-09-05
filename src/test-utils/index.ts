// SPDX-License-Identifier: EUPL-1.2
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants as osConstants, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { GitStatusEntry } from '../core/git-base.js';
import type { PatchesManifest, PatchMetadata } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import type { ProjectPaths } from '../types/config.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_CONFIG: FireForgeConfig = {
  name: 'MyBrowser',
  vendor: 'My Company',
  appId: 'org.example.mybrowser',
  binaryName: 'mybrowser',
  firefox: {
    version: '140.9.0esr',
    product: 'firefox-esr',
  },
  license: 'EUPL-1.2',
};

/**
 * Renders a POSIX-written fixture path in the host's native separator form.
 *
 * Assertions compare against values the code built with `join`/`resolve`, so a
 * literal `'/project/engine'` only matches on POSIX. On Windows the code
 * produces `\project\engine` and the expectation is the only thing that is
 * wrong. Wrapping the literal keeps it readable while making the comparison
 * separator-correct on every platform. Only ever wrap the expected side: a
 * value derived from the code under test must never be laundered through this.
 */
export function nativePath(posixPath: string): string {
  return posixPath.replace(/\//g, sep);
}

/**
 * Renders a POSIX-written *absolute* fixture path the way the code under test
 * renders it after a `resolve`.
 *
 * {@link nativePath} only swaps separators, which is not enough for a value
 * the code passed through `resolve`: on Windows `resolve('/project/x')` also
 * prefixes the current drive, so the expectation has to be `D:\\project\\x`
 * rather than `\\project\\x`. Use this wrapper whenever the asserted value
 * came out of `resolve`. {@link nativePath} stays correct for values built
 * with plain `join`. Only ever wrap the expected side.
 */
export function nativeAbsPath(posixPath: string): string {
  return resolve(posixPath);
}

/** Creates a temporary project root for integration-style tests. */
export async function createTempProject(prefix = 'fireforge-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Removes a temporary test project and all of its contents. */
export async function removeTempProject(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

/** Writes a map of relative file paths into a test project root. */
export async function writeFiles(
  root: string,
  files: Record<string, string | Buffer>
): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
  }
}

/** Writes a fireforge.json file using the default test config plus overrides. */
export async function writeFireForgeConfig(
  root: string,
  overrides: Partial<FireForgeConfig> = {}
): Promise<void> {
  const config = {
    ...DEFAULT_CONFIG,
    ...overrides,
    firefox: {
      ...DEFAULT_CONFIG.firefox,
      ...overrides.firefox,
    },
  } satisfies FireForgeConfig;

  await writeFiles(root, {
    'fireforge.json': `${JSON.stringify(config, null, 2)}\n`,
  });
}

/**
 * Writes a synthetic mach objdir (`<engineDir>/<objDirName>`) with the
 * artifacts the tree/with-objdir machinery consumes: a `dist/`
 * completeness sentinel, a `mozinfo.json` carrying absolute
 * topsrcdir/topobjdir/mozconfig paths (defaulting to the engine's own,
 * i.e. a consistent primary build), a `_virtualenvs` entry standing in
 * for mach's venvs, and `config.status`/`backend.mk` embedding the
 * topsrcdir path the way real configure output does. That is the state the
 * post-configure relocation check exists to catch when a clone's
 * reconfigure did not actually regenerate them.
 */
export async function writeSyntheticObjdir(
  engineDir: string,
  objDirName: string,
  overrides: {
    topsrcdir?: string | null;
    topobjdir?: string | null;
    mozconfig?: string | null;
  } = {}
): Promise<void> {
  const field = (override: string | null | undefined, fallback: string): string | undefined =>
    override === null ? undefined : (override ?? fallback);
  const mozinfo = {
    topsrcdir: field(overrides.topsrcdir, engineDir),
    topobjdir: field(overrides.topobjdir, join(engineDir, objDirName)),
    mozconfig: field(overrides.mozconfig, join(engineDir, 'mozconfig')),
  };
  const srcdirLine = mozinfo.topsrcdir ?? engineDir;
  await writeFiles(join(engineDir, objDirName), {
    'dist/bin/.gitkeep': '',
    'mozinfo.json': `${JSON.stringify(mozinfo, null, 2)}\n`,
    '_virtualenvs/venv/bin/python': '#!/usr/bin/env python3\n',
    'config.status': `topsrcdir = "${srcdirLine}"\n`,
    'backend.mk': `topsrcdir := ${srcdirLine}\n`,
  });
}

/** Runs a git command in the given repository and returns stdout. */
export async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

/**
 * Builds a `PatchMetadata` fixture.
 *
 * @param filename - Patch filename, e.g. `001-ui-toolbar.patch`
 * @param overrides - Fields to override on the default metadata
 * @returns A complete `PatchMetadata`
 */
export function makePatch(filename: string, overrides: Partial<PatchMetadata> = {}): PatchMetadata {
  return {
    filename,
    order: Number.parseInt(filename.split('-')[0] ?? '0', 10) || 1,
    category: 'infra',
    name: 'p',
    description: '',
    createdAt: '2025-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected: [],
    ...overrides,
  };
}

/**
 * Builds a `PatchesManifest` fixture around the supplied entries.
 *
 * @param patches - Patch metadata entries, in queue order
 * @returns A version-1 manifest
 */
export function makeManifest(patches: PatchMetadata[] = []): PatchesManifest {
  return { version: 1, patches };
}

/** Builds a synthetic ProjectPaths object rooted at the supplied directory. */
export function makeProjectPaths(root = '/project'): ProjectPaths {
  return {
    root,
    engine: join(root, 'engine'),
    config: join(root, 'fireforge.json'),
    fireforgeDir: join(root, '.fireforge'),
    state: join(root, '.fireforge', 'state.json'),
    patches: join(root, 'patches'),
    configs: join(root, 'configs'),
    src: join(root, 'src'),
    componentsDir: join(root, 'components'),
  };
}

/** Creates a Git status entry with sensible defaults for tests. */
export function makeGitStatusEntry(overrides: Partial<GitStatusEntry> = {}): GitStatusEntry {
  return {
    status: ' M',
    indexStatus: ' ',
    worktreeStatus: 'M',
    file: 'tracked.txt',
    isUntracked: false,
    isRenameOrCopy: false,
    isDeleted: false,
    ...overrides,
  };
}

/** Initializes a git repository with committed seed files for tests. */
export async function initCommittedRepo(
  repoDir: string,
  files: Record<string, string | Buffer>
): Promise<void> {
  await writeFiles(repoDir, files);
  await runGit(repoDir, ['init']);
  await runGit(repoDir, ['config', 'user.email', 'fireforge@example.test']);
  await runGit(repoDir, ['config', 'user.name', 'FireForge Tests']);
  // Pin line endings: on a Windows host the global `core.autocrlf=true`
  // rewrites LF to CRLF on checkout, which changes the blob hashes and the
  // exact bytes every patch round-trip asserts on.
  await runGit(repoDir, ['config', 'core.autocrlf', 'false']);
  await runGit(repoDir, ['config', 'core.eol', 'lf']);
  await runGit(repoDir, ['add', '-A']);
  await runGit(repoDir, ['commit', '-m', 'initial']);
}

/** Reads a project file under `root` and normalizes newlines for stable assertions. */
export async function readProjectText(root: string, relativePath: string): Promise<string> {
  const content = await readFile(join(root, relativePath), 'utf8');
  return content.replace(/\r\n/g, '\n');
}

/** Creates a tar.xz archive from a synthetic extracted directory tree. */
export async function makeTarXzArchive(
  root: string,
  archiveName: string,
  extractedDirName: string,
  files: Record<string, string | Buffer>
): Promise<string> {
  const sourceRoot = join(root, 'archive-source', extractedDirName);
  await writeFiles(sourceRoot, files);

  const archivePath = join(root, archiveName);
  await execFileAsync(
    'tar',
    ['-cJf', archivePath, '-C', join(root, 'archive-source'), extractedDirName],
    { cwd: root }
  );

  return archivePath;
}

/** Temporarily overrides stdin/stdout TTY flags and returns a restore callback. */
export function setInteractiveMode(isInteractive: boolean): () => void {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value: isInteractive,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value: isInteractive,
  });

  return () => {
    if (stdinDescriptor) {
      Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    }
    if (stdoutDescriptor) {
      Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
    }
  };
}

/** Absolute path to the tsx CLI shim the spawned-CLI tests run `bin/` through. */
export const TSX_CLI = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../node_modules/tsx/dist/cli.mjs'
);

/** Absolute path to the real CLI entrypoint (`bin/fireforge.ts`). */
export const FIREFORGE_BIN_ENTRY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../bin/fireforge.ts'
);

/** Captured result of a spawned `fireforge` invocation. */
export interface SpawnedCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the real CLI in a child process and captures its streams.
 *
 * The exit code and the stdout/stderr split are only observable across a real
 * process boundary, which is why these tests spawn instead of calling the
 * command function. `env` extends (never replaces) the parent environment
 * for cases that must inject a loader.
 */
export function runFireforgeCli(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv
): Promise<SpawnedCliResult> {
  const child = spawn(process.execPath, [TSX_CLI, FIREFORGE_BIN_ENTRY, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  return new Promise<SpawnedCliResult>((resolve, reject) => {
    // A spawn failure (tsx shim missing, EACCES) must fail the test with a
    // message rather than leave the promise pending until vitest's timeout.
    child.on('error', reject);
    // 'close', not 'exit': the stdio pipes may still hold the final chunk
    // when 'exit' fires, and the verdict-line assertions read the last line.
    child.on('close', (code, signal) => {
      const signalNumber = signal ? osConstants.signals[signal] : undefined;
      resolve({
        exitCode: code ?? (signalNumber === undefined ? -1 : 128 + signalNumber),
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}
