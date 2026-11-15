// SPDX-License-Identifier: EUPL-1.2
/**
 * `token add`, `register` and `wire` run from inside a linked git worktree
 * of a source-mode project: the worktree's branch was rebased, it holds
 * uncommitted edits, and the main checkout may since have moved to another
 * commit. The commands write into the worktree's own source root and never
 * touch the main checkout's.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { hostPaths } from '../project/index.js';
import { runCli } from '../testing/cli.js';
import { makeSourceProject, seedPristine, useMachSandbox } from '../testing/engine.js';
import { commitAll, git } from '../testing/git.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { TOKENS_CSS } from '../testing/tokens.js';

const dir = useTempDir();
useMachSandbox();

const PANEL = 'browser/base/content/panel.js';
const FEATURE = 'browser/base/content/feature.js';
const MAIN_JS = 'browser/base/content/browser-main.js';
const JAR = 'browser/base/jar.mn';
const TOKEN_FILE = 'browser/themes/shared/testbrowser-tokens.css';
const BROWSER_MAIN =
  'var main = {\n  load() {\n    try {\n      Services.scriptloader.loadSubScript("chrome://browser/content/browser.js", this);\n    } catch (e) {\n      console.error(e);\n    }\n  },\n};\n';

/** A main checkout and a linked worktree whose branch was rebased onto the main branch. */
interface Scenario {
  main: string;
  worktree: string;
  env: Record<string, string>;
}

/**
 * Builds the situation of the report: a source-mode project, a worktree on a
 * new branch with a commit of its own, a commit on the main branch, the
 * worktree's branch rebased onto it, and uncommitted edits in the worktree.
 */
async function rebasedWorktree(): Promise<Scenario> {
  const home = join(dir(), 'home');
  await seedPristine(hostPaths({ FIREFORGE_HOME: home }), { [MAIN_JS]: BROWSER_MAIN });
  const project = await makeSourceProject(dir(), {
    files: {
      [`src/${PANEL}`]: '// panel\n',
      [`src/${FEATURE}`]: '// feature\n',
      [`src/${TOKEN_FILE}`]: TOKENS_CSS.replaceAll('--acme-', '--testbrowser-'),
    },
  });
  const main = project.root;
  const worktree = join(dir(), 'project-sidebar');
  await git(main, ['worktree', 'add', '--quiet', worktree, '-b', 'sidebar']);

  await writeTree(worktree, { 'src/browser/base/content/sidebar.js': '// sidebar\n' });
  await commitAll(worktree, 'sidebar work');
  await writeTree(main, { 'src/browser/base/content/upstream-move.js': '// moved on\n' });
  await commitAll(main, 'main moves on');
  await git(worktree, ['rebase', 'main']);

  // Uncommitted edits: one to a committed file, one new file.
  await writeTree(worktree, {
    [`src/${PANEL}`]: '// panel, edited in the worktree\n',
    'src/browser/base/content/scratch.js': '// scratch\n',
  });
  return { main, worktree, env: { FIREFORGE_HOME: home } };
}

/** Sends the main checkout to a commit the worktree's branch does not descend from. */
async function moveMainElsewhere({ main }: Scenario): Promise<void> {
  await git(main, ['reset', '--hard', '--quiet', 'HEAD~1']);
  await writeTree(main, { 'src/browser/base/content/elsewhere.js': '// elsewhere\n' });
  await commitAll(main, 'a different commit');
}

const cli = (
  cwd: string,
  env: Record<string, string>,
  ...args: string[]
): ReturnType<typeof runCli> => runCli(args, { cwd, env });

const read = (root: string, path: string): Promise<string> =>
  readFile(join(root, 'src', path), 'utf8');

async function present(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}

/** Runs the three editing commands from the worktree and checks where they wrote. */
async function editFromWorktree({ main, worktree, env }: Scenario): Promise<void> {
  const mainTokens = await read(main, TOKEN_FILE);

  const token = await cli(
    worktree,
    env,
    ...['token', 'add', '--category', 'Spacing', '--mode', 'static', 'tight', '2px']
  );
  expect(token.stderr).not.toContain('ls-tree');
  expect(token.exitCode).toBe(0);
  expect(await read(worktree, TOKEN_FILE)).toContain('--testbrowser-tight: 2px;');

  const registered = await cli(worktree, env, 'register', `src/${PANEL}`);
  expect(registered.exitCode).toBe(0);
  expect(registered.stdout).toContain(`Registered ${PANEL} in ${JAR}`);
  expect(await read(worktree, JAR)).toContain('(content/panel.js)');

  const wired = await cli(worktree, env, 'wire', 'feature', '--json');
  expect(wired.exitCode).toBe(0);
  expect(await read(worktree, MAIN_JS)).toContain('wire-subscript feature');
  expect(await read(worktree, JAR)).toContain('content/browser/feature.js');

  // The uncommitted edits are still there, and the first touches were declared in the worktree.
  expect(await read(worktree, PANEL)).toBe('// panel, edited in the worktree\n');
  expect(await present(join(worktree, 'upstream/overrides', `${JAR}.json`))).toBe(true);
  expect(await present(join(worktree, 'upstream/overrides', `${MAIN_JS}.json`))).toBe(true);

  // Nothing reached the main checkout.
  expect(await read(main, TOKEN_FILE)).toBe(mainTokens);
  expect(await present(join(main, 'src', JAR))).toBe(false);
  expect(await present(join(main, 'src', MAIN_JS))).toBe(false);
  expect(await present(join(main, 'upstream/overrides'))).toBe(false);
  expect(await git(main, ['status', '--porcelain'])).toBe('');
}

describe('the editing commands in a linked git worktree', () => {
  it('write into the worktree after its branch was rebased, with uncommitted edits present', async () => {
    await editFromWorktree(await rebasedWorktree());
  });

  it('write into the worktree when the main checkout has moved to a different commit', async () => {
    const scenario = await rebasedWorktree();
    await moveMainElsewhere(scenario);
    await editFromWorktree(scenario);
  });

  it('read the owned changes of the worktree, not those of the main checkout', async () => {
    const scenario = await rebasedWorktree();
    await moveMainElsewhere(scenario);
    const { worktree, main, env } = scenario;
    const inWorktree = await cli(worktree, env, 'status', '--json');
    const inMain = await cli(main, env, 'status', '--json');
    for (const result of [inWorktree, inMain]) {
      expect(result.stderr).not.toContain('ls-tree');
      expect(() => {
        JSON.parse(result.stdout);
      }).not.toThrow();
    }
    const paths = (result: { stdout: string }): string[] =>
      (JSON.parse(result.stdout) as { owned: { path: string }[] }).owned.map((entry) => entry.path);
    expect(paths(inWorktree)).toContain('browser/base/content/sidebar.js');
    expect(paths(inWorktree)).toContain('browser/base/content/scratch.js');
    expect(paths(inMain)).toContain('browser/base/content/elsewhere.js');
    expect(paths(inMain)).not.toContain('browser/base/content/sidebar.js');
  });
});
