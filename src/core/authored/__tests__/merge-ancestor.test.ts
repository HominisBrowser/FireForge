// SPDX-License-Identifier: EUPL-1.2
/** Which commit the merge driver's ancestor came from, for every label and every operation state Git can leave. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sourceGit } from '../git.js';
import { ancestorAbsent } from '../merge-ancestor.js';
import { commitFixture, writeAt } from './fixtures.js';

const PATH = 'tracked.txt';
const IDENTITY = ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=Fixture'];
const directories: string[] = [];
const environmentKeys: string[] = [];

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('GITHEAD_')) Reflect.deleteProperty(process.env, key);
  }
});

afterEach(async () => {
  for (const key of environmentKeys.splice(0)) Reflect.deleteProperty(process.env, key);
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function rev(root: string, revision: string): Promise<string> {
  return (await sourceGit(root, ['rev-parse', revision])).toString('utf8').trim();
}

interface Repo {
  root: string;
  /** Has no PATH. */
  first: string;
  /** Adds PATH. */
  second: string;
  /** Edits PATH; HEAD. */
  third: string;
}

async function repository(): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), 'fireforge-merge-ancestor-'));
  directories.push(root);
  await sourceGit(root, ['init', '-q']);
  await writeAt(root, 'other.txt', 'other\n');
  await commitFixture(root);
  const first = await rev(root, 'HEAD');
  await writeAt(root, PATH, 'one\n');
  await commitFixture(root);
  const second = await rev(root, 'HEAD');
  await writeAt(root, PATH, 'two\n');
  await commitFixture(root);
  return { root, first, second, third: await rev(root, 'HEAD') };
}

/** A state file in the repository's git directory, as an interrupted operation leaves it. */
async function state(root: string, name: string, content: string): Promise<void> {
  const path = join(root, '.git', name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function githead(id: string): void {
  const key = `GITHEAD_${id}`;
  process.env[key] = 'branch';
  environmentKeys.push(key);
}

async function commitOn(root: string, file: string, content: string): Promise<string> {
  await writeAt(root, file, content);
  await sourceGit(root, ['add', '-A']);
  await sourceGit(root, [...IDENTITY, 'commit', '-qm', `edit ${file}`]);
  return rev(root, 'HEAD');
}

describe('ancestorAbsent from the %S label', () => {
  it('reads an abbreviated id as the merge base', async () => {
    const { root, first, second } = await repository();
    expect(await ancestorAbsent(root, PATH, first.slice(0, 10))).toBe(true);
    expect(await ancestorAbsent(root, PATH, second.slice(0, 10))).toBe(false);
  });

  it('reads `parent of <id> (...)` as the picked commit parent', async () => {
    const { root, first, second, third } = await repository();
    expect(await ancestorAbsent(root, PATH, `parent of ${second.slice(0, 10)} (add)`)).toBe(true);
    expect(await ancestorAbsent(root, PATH, `parent of ${third.slice(0, 10)} (edit)`)).toBe(false);
    // A root commit has no parent to name.
    expect(await ancestorAbsent(root, PATH, `parent of ${first.slice(0, 10)} (root)`)).toBe(
      undefined
    );
  });

  it('reads `<id> (...)` as the reverted commit itself', async () => {
    const { root, first, second } = await repository();
    expect(await ancestorAbsent(root, PATH, `${first.slice(0, 10)} (root)`)).toBe(true);
    expect(await ancestorAbsent(root, PATH, `${second.slice(0, 10)} (add)`)).toBe(false);
  });

  it('names nothing for labels that match no commit or no known shape', async () => {
    const { root, second } = await repository();
    for (const label of [
      'deadbeefdead',
      'parent of deadbeefdead (gone)',
      'deadbeefdead (gone)',
      '%S',
      '',
      'merged common ancestors',
      `${second.slice(0, 10)}x`,
      `parent of ${second.slice(0, 10)}`,
    ]) {
      expect(await ancestorAbsent(root, PATH, label), label).toBeUndefined();
    }
  });

  it('names nothing for the parent of a merge commit', async () => {
    const { root, first } = await repository();
    await sourceGit(root, ['branch', 'side', first]);
    await sourceGit(root, ['checkout', '-q', 'side']);
    await commitOn(root, 'side.txt', 'side\n');
    await sourceGit(root, ['checkout', '-q', '-']);
    await sourceGit(root, [...IDENTITY, 'merge', '-q', '--no-ff', '-m', 'merge', 'side']);
    const merged = await rev(root, 'HEAD');
    expect(await ancestorAbsent(root, PATH, `parent of ${merged.slice(0, 10)} (merge)`)).toBe(
      undefined
    );
  });

  it('prefers the label over any operation state', async () => {
    const { root, first, second } = await repository();
    await state(root, 'CHERRY_PICK_HEAD', `${second}\n`);
    expect(await ancestorAbsent(root, PATH, first.slice(0, 10))).toBe(true);
  });

  it('proves absence only from a listing that succeeds', async () => {
    const { root, second } = await repository();
    expect(await ancestorAbsent(root, 'missing.txt', second.slice(0, 10))).toBe(true);
    expect(await ancestorAbsent(root, PATH, second.slice(0, 10))).toBe(false);
    expect(
      await ancestorAbsent(
        await mkdtemp(join(tmpdir(), 'fireforge-not-a-repository-')),
        PATH,
        second.slice(0, 10)
      )
    ).toBe(undefined);
  });
});

describe('ancestorAbsent without a label', () => {
  it('names nothing when no operation is in progress', async () => {
    const { root } = await repository();
    expect(await ancestorAbsent(root, PATH, undefined)).toBeUndefined();
  });

  describe('GITHEAD variables', () => {
    it('uses the merge base of HEAD and the single merged head', async () => {
      const { root, first } = await repository();
      await sourceGit(root, ['branch', 'side', first]);
      await sourceGit(root, ['checkout', '-q', 'side']);
      const head = await commitOn(root, 'side.txt', 'side\n');
      await sourceGit(root, ['checkout', '-q', '-']);
      githead(head);
      expect(await ancestorAbsent(root, PATH, undefined)).toBe(true);
    });

    it('names nothing for several merged heads', async () => {
      const { root, second, third } = await repository();
      githead(second);
      githead(third);
      expect(await ancestorAbsent(root, PATH, undefined)).toBeUndefined();
    });

    it('does not fall through to other state when a head is named', async () => {
      const { root, second } = await repository();
      githead('a'.repeat(40));
      await state(root, 'CHERRY_PICK_HEAD', `${second}\n`);
      expect(await ancestorAbsent(root, PATH, undefined)).toBeUndefined();
    });

    it('names nothing when the head is not a commit Git knows', async () => {
      const { root } = await repository();
      githead('b'.repeat(40));
      expect(await ancestorAbsent(root, PATH, undefined)).toBeUndefined();
    });

    it('names nothing when the histories share no merge base', async () => {
      const { root } = await repository();
      await sourceGit(root, ['checkout', '-q', '--orphan', 'unrelated']);
      await sourceGit(root, ['rm', '-rfq', '.']);
      const orphan = await commitOn(root, 'orphan.txt', 'orphan\n');
      await sourceGit(root, ['checkout', '-q', 'master']).catch(() =>
        sourceGit(root, ['checkout', '-q', 'main'])
      );
      githead(orphan);
      expect(await ancestorAbsent(root, PATH, undefined)).toBeUndefined();
    });

    it('names nothing when the merge bases are several (criss-cross)', async () => {
      const { root, first } = await repository();
      const trunk = (await sourceGit(root, ['rev-parse', '--abbrev-ref', 'HEAD']))
        .toString('utf8')
        .trim();
      await sourceGit(root, ['branch', 'left', first]);
      await sourceGit(root, ['branch', 'right', first]);
      await sourceGit(root, ['checkout', '-q', 'left']);
      const leftTip = await commitOn(root, 'left.txt', 'left\n');
      await sourceGit(root, ['checkout', '-q', 'right']);
      const rightTip = await commitOn(root, 'right.txt', 'right\n');
      await sourceGit(root, [...IDENTITY, 'merge', '-q', '--no-ff', '-m', 'r<-l', leftTip]);
      const crossRight = await rev(root, 'HEAD');
      await sourceGit(root, ['checkout', '-q', 'left']);
      await sourceGit(root, [...IDENTITY, 'merge', '-q', '--no-ff', '-m', 'l<-r', rightTip]);
      expect(crossRight).not.toBe(await rev(root, 'HEAD'));
      githead(crossRight);
      expect(await ancestorAbsent(root, PATH, undefined)).toBeUndefined();
      await sourceGit(root, ['checkout', '-q', trunk]);
    });
  });

  describe('MERGE_HEAD', () => {
    it('uses the merge base with the single merged head', async () => {
      const { root, first } = await repository();
      await sourceGit(root, ['branch', 'side', first]);
      await sourceGit(root, ['checkout', '-q', 'side']);
      const head = await commitOn(root, 'side.txt', 'side\n');
      await sourceGit(root, ['checkout', '-q', '-']);
      await state(root, 'MERGE_HEAD', `${head}\n`);
      expect(await ancestorAbsent(root, PATH, undefined)).toBe(true);
    });

    it('names nothing for an octopus merge', async () => {
      const { root, first, second } = await repository();
      await state(root, 'MERGE_HEAD', `${first}\n${second}\n`);
      expect(await ancestorAbsent(root, PATH, undefined)).toBeUndefined();
    });

    it('names nothing when the head is not a commit', async () => {
      const { root } = await repository();
      await state(root, 'MERGE_HEAD', `${'c'.repeat(40)}\n`);
      expect(await ancestorAbsent(root, PATH, undefined)).toBeUndefined();
    });

    it('ignores an empty file and reads the next state', async () => {
      const { root, second } = await repository();
      await state(root, 'MERGE_HEAD', '\n');
      await state(root, 'CHERRY_PICK_HEAD', `${second}\n`);
      expect(await ancestorAbsent(root, PATH, undefined)).toBe(true);
    });
  });

  describe('rebase-merge/done', () => {
    it('takes the parent of the last picking command', async () => {
      const { root, second, third } = await repository();
      await state(
        root,
        'rebase-merge/done',
        `# comment\n\npick ${third.slice(0, 10)} later\nreword ${second.slice(0, 10)} add\n`
      );
      expect(await ancestorAbsent(root, PATH, undefined)).toBe(true);
    });

    it('names nothing for a command that does not pick', async () => {
      const { root, second } = await repository();
      await state(root, 'rebase-merge/done', `pick ${second.slice(0, 10)} add\nexec true\n`);
      expect(await ancestorAbsent(root, PATH, undefined)).toBeUndefined();
      await state(root, 'rebase-merge/done', `merge ${second.slice(0, 10)} add\n`);
      expect(await ancestorAbsent(root, PATH, undefined)).toBeUndefined();
    });

    it('names nothing for an empty, comment-only or malformed list', async () => {
      const { root } = await repository();
      for (const content of [
        '',
        '# only a comment\n',
        'pick\n',
        'pick zzzz add\n',
        'pick abc add\n',
      ]) {
        await state(root, 'rebase-merge/done', content);
        expect(await ancestorAbsent(root, PATH, undefined), content).toBeUndefined();
      }
    });

    it('names nothing when the step names no commit', async () => {
      const { root } = await repository();
      await state(root, 'rebase-merge/done', 'pick deadbeefdead gone\n');
      expect(await ancestorAbsent(root, PATH, undefined)).toBeUndefined();
    });

    it('treats an unreadable file as absent and reads the next state', async () => {
      const { root, second } = await repository();
      await mkdir(join(root, '.git', 'rebase-merge', 'done'), { recursive: true });
      await state(root, 'CHERRY_PICK_HEAD', `${second}\n`);
      expect(await ancestorAbsent(root, PATH, undefined)).toBe(true);
    });
  });

  describe('rebase-apply', () => {
    it('takes the parent of the original commit', async () => {
      const { root, second } = await repository();
      await state(root, 'rebase-apply/rebasing', '');
      await state(root, 'rebase-apply/original-commit', `${second}\n`);
      expect(await ancestorAbsent(root, PATH, undefined)).toBe(true);
    });

    it('names nothing without a readable or non-empty original commit', async () => {
      const { root, second } = await repository();
      await state(root, 'rebase-apply/rebasing', '');
      await state(root, 'CHERRY_PICK_HEAD', `${second}\n`);
      expect(await ancestorAbsent(root, PATH, undefined)).toBeUndefined();
      await state(root, 'rebase-apply/original-commit', '\n');
      expect(await ancestorAbsent(root, PATH, undefined)).toBeUndefined();
    });
  });

  describe('sequencer/todo', () => {
    it('takes the parent of the first picked commit', async () => {
      const { root, second, third } = await repository();
      await state(
        root,
        'sequencer/todo',
        `# header\npick ${second.slice(0, 10)} add\npick ${third.slice(0, 10)} edit\n`
      );
      expect(await ancestorAbsent(root, PATH, undefined)).toBe(true);
    });

    it('takes the reverted commit itself for a revert', async () => {
      const { root, first, second } = await repository();
      await state(root, 'sequencer/todo', `revert ${second.slice(0, 10)} add\n`);
      expect(await ancestorAbsent(root, PATH, undefined)).toBe(false);
      await state(root, 'sequencer/todo', `revert ${first.slice(0, 10)} root\n`);
      expect(await ancestorAbsent(root, PATH, undefined)).toBe(true);
    });

    it('names nothing for an unknown verb or a malformed list', async () => {
      const { root, second } = await repository();
      for (const content of [
        `label ${second.slice(0, 10)}\n`,
        '',
        '# nothing\n',
        'pick not-an-id\n',
      ]) {
        await state(root, 'sequencer/todo', content);
        expect(await ancestorAbsent(root, PATH, undefined), content).toBeUndefined();
      }
    });
  });

  describe('single-commit pick and revert state', () => {
    it('takes the parent of CHERRY_PICK_HEAD', async () => {
      const { root, second, third } = await repository();
      await state(root, 'CHERRY_PICK_HEAD', `${second}\n`);
      expect(await ancestorAbsent(root, PATH, undefined)).toBe(true);
      await state(root, 'CHERRY_PICK_HEAD', `${third}\n`);
      expect(await ancestorAbsent(root, PATH, undefined)).toBe(false);
    });

    it('takes REVERT_HEAD itself', async () => {
      const { root, first, second } = await repository();
      await state(root, 'REVERT_HEAD', `${second}\n`);
      expect(await ancestorAbsent(root, PATH, undefined)).toBe(false);
      await state(root, 'REVERT_HEAD', `${first}\n`);
      expect(await ancestorAbsent(root, PATH, undefined)).toBe(true);
    });

    it('names nothing for blank or unresolvable files', async () => {
      const { root } = await repository();
      await state(root, 'CHERRY_PICK_HEAD', '\n');
      await state(root, 'REVERT_HEAD', '\n');
      expect(await ancestorAbsent(root, PATH, undefined)).toBeUndefined();
      await state(root, 'REVERT_HEAD', `${'d'.repeat(40)}\n`);
      expect(await ancestorAbsent(root, PATH, undefined)).toBeUndefined();
    });
  });
});
