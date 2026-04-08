// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type { GitStatusEntry } from '../core/git-base.js';
import type { FireForgeConfig } from '../types/config.js';
import type { ProjectPaths } from '../types/config.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_CONFIG: FireForgeConfig = {
  name: 'MyBrowser',
  vendor: 'My Company',
  appId: 'org.example.mybrowser',
  binaryName: 'mybrowser',
  firefox: {
    version: '140.0esr',
    product: 'firefox-esr',
  },
  license: 'EUPL-1.2',
};

/** Creates a temporary project root for integration-style tests. */
export async function createTempProject(prefix = 'fireforge-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Removes a temporary test project and all of its contents. */
export async function removeTempProject(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
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

/** Runs a git command in the given repository and returns stdout. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
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
  await git(repoDir, ['init']);
  await git(repoDir, ['config', 'user.email', 'fireforge@example.test']);
  await git(repoDir, ['config', 'user.name', 'FireForge Tests']);
  await git(repoDir, ['add', '-A']);
  await git(repoDir, ['commit', '-m', 'initial']);
}

/** Reads a project file and normalizes newlines for stable assertions. */
export async function readText(root: string, relativePath: string): Promise<string> {
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
