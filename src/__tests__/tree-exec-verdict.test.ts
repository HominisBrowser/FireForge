// SPDX-License-Identifier: EUPL-1.2
/**
 * Spawned-CLI pin for the verdict contract: a composed gate keys its steps
 * on the `FIREFORGE-VERDICT:` line of a build-less in-tree run reached
 * through `tree exec <name> -- test …`. Two subsystems that are otherwise
 * only tested in isolation meet here:
 *
 * - `tree exec` hands stdout to the child with `stdio: 'inherit'`, so the
 *   child's verdict reaches the caller's stdout byte-for-byte;
 * - on a non-zero child exit the parent wraps it in a `GeneralError`. If
 *   that refusal renders on the PARENT's stdout — after the child's verdict
 *   — it breaks the "verdict is the run's last stdout write" guarantee
 *   exactly where a gate reads it. The parent seals stdout once the child
 *   settles, so its refusal goes to stderr.
 *
 * The child is `node <cliEntry>` with no loader of its own, so the spawn
 * carries tsx through `NODE_OPTIONS` for the TypeScript sources; a packed
 * install runs plain JavaScript and needs nothing.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  writeFiles,
  writeFireForgeConfig,
} from '../test-utils/index.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const tsxCli = join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const binEntry = join(repoRoot, 'bin', 'fireforge.ts');
/**
 * Absolute URL, not the bare `tsx` specifier: the grandchild resolves
 * `NODE_OPTIONS` against ITS cwd (the temp tree), where no node_modules
 * exists.
 */
const tsxLoader = new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url).href;

const TREE_NAME = 'shard-a';
const VERDICT_PREFIX = 'FIREFORGE-VERDICT:';

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runFireforge(cwd: string, args: string[]): Promise<CliResult> {
  const child = spawn(process.execPath, [tsxCli, binEntry, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: `--import ${tsxLoader}` },
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  return new Promise<CliResult>((resolve) => {
    child.on('exit', (code) => {
      resolve({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

function verdictLines(stdout: string): string[] {
  return stdout.split('\n').filter((line) => line.includes(VERDICT_PREFIX));
}

function lastNonEmptyLine(stdout: string): string {
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
  return lines.at(-1) ?? '';
}

describe('FIREFORGE-VERDICT through tree exec', () => {
  let projectRoot: string;

  /**
   * Builds a verification tree by hand rather than through `tree create`:
   * a real clone would need a mach objdir. The marker records
   * `clonedObjdir`, which is what the tree guard requires before admitting
   * a build-less in-tree `test`.
   */
  async function writeTree(): Promise<void> {
    const treeRoot = join(projectRoot, '.fireforge', 'trees', TREE_NAME);
    await mkdir(join(treeRoot, '.fireforge'), { recursive: true });
    await writeFireForgeConfig(treeRoot);
    await initCommittedRepo(join(treeRoot, 'engine'), { 'comp/mod.js': 'content\n' });
    await writeFiles(treeRoot, { 'patches/patches.json': '{"version":1,"patches":[]}\n' });
    await writeFile(
      join(treeRoot, '.fireforge', 'tree.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          name: TREE_NAME,
          primaryRoot: projectRoot,
          createdAt: '2026-01-01T00:00:00.000Z',
          engineHead: null,
          patchesFingerprint: null,
          clonedObjdir: 'obj-test',
        },
        null,
        2
      )}\n`
    );
  }

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-tree-exec-verdict-');
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(join(projectRoot, 'engine'), { 'comp/mod.js': 'content\n' });
    await writeFiles(projectRoot, { 'patches/patches.json': '{"version":1,"patches":[]}\n' });
    await writeTree();
  }, 60_000);

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('emits exactly one verdict line, and it is the last stdout line even when the child fails', async () => {
    const result = await runFireforge(projectRoot, ['tree', 'exec', TREE_NAME, '--', 'test']);

    // The in-tree run cannot reach a real harness (no built binary), so it
    // ends at the preflight verdict — the shape a gate step sees on failure.
    expect(verdictLines(result.stdout)).toHaveLength(1);
    expect(lastNonEmptyLine(result.stdout)).toContain(VERDICT_PREFIX);
    expect(result.exitCode).not.toBe(0);
  }, 120_000);

  it("routes tree exec's own refusal to stderr so it cannot displace the verdict", async () => {
    const result = await runFireforge(projectRoot, ['tree', 'exec', TREE_NAME, '--', 'test']);

    expect(result.stderr).toContain('tree exec: fireforge test exited with code');
    expect(result.stdout).not.toContain('tree exec: fireforge test exited with code');
  }, 120_000);

  it('emits no verdict at all for a pre-spawn refusal (no child ever ran)', async () => {
    const result = await runFireforge(projectRoot, ['tree', 'exec', 'no-such-tree', '--', 'test']);

    expect(verdictLines(result.stdout)).toHaveLength(0);
    expect(result.exitCode).not.toBe(0);
  }, 120_000);
});
