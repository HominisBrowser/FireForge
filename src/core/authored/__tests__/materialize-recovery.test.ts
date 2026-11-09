// SPDX-License-Identifier: EUPL-1.2
/**
 * Recovery of a materialization interrupted while a path turns between one file and a directory,
 * with the failure injected at each step of the transaction's tail.
 */
import * as filesystem from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureAuthoredSnapshot } from '../capture.js';
import { exportPristineTree, materializeAuthoredSnapshot } from '../materialize.js';
import { commitFixture, sourceFixture, writeAt } from './fixtures.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    readFile: vi.fn(original.readFile),
    rename: vi.fn(original.rename),
    rm: vi.fn(original.rm),
  };
});

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => filesystem.rm(path, { recursive: true, force: true }))
  );
});

const AS_FILE = 'export const shape = "file";\n';
const AS_DIRECTORY = 'export const shape = "directory";\n';

/** A project and an engine seeded from its pristine tree, with `browser/dir` in the given shape. */
async function engineWith(shape: 'file' | 'directory'): Promise<{
  root: string;
  engine: string;
  ledgerPath: string;
  materialize: () => Promise<unknown>;
}> {
  const { root, pristine, commit } = await sourceFixture();
  directories.push(dirname(root));
  const engine = join(dirname(root), 'engine');
  const ledgerPath = join(dirname(root), 'ledger.json');
  await exportPristineTree(pristine, commit, engine);
  const materialize = async (): Promise<unknown> => {
    await commitFixture(root).catch(() => undefined);
    return materializeAuthoredSnapshot({
      snapshot: await captureAuthoredSnapshot({ projectRoot: root, pristineRepository: pristine }),
      engineDir: engine,
      ledgerPath,
      pristineRepository: pristine,
    });
  };
  await reshape(root, shape);
  await materialize();
  return { root, engine, ledgerPath, materialize };
}

async function reshape(root: string, shape: 'file' | 'directory'): Promise<void> {
  await filesystem.rm(join(root, 'src/browser/dir'), { recursive: true, force: true });
  if (shape === 'file') await writeAt(root, 'src/browser/dir', AS_FILE);
  else await writeAt(root, 'src/browser/dir/inner.js', AS_DIRECTORY);
}

async function expectShape(engine: string, shape: 'file' | 'directory'): Promise<void> {
  if (shape === 'file')
    expect(await filesystem.readFile(join(engine, 'browser/dir'), 'utf8')).toBe(AS_FILE);
  else
    expect(await filesystem.readFile(join(engine, 'browser/dir/inner.js'), 'utf8')).toBe(
      AS_DIRECTORY
    );
}

/** Fails the ledger's publication once: every engine write has happened, the ledger is old. */
async function failLedgerPublication(ledgerPath: string): Promise<() => boolean> {
  const { rename } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let failed = false;
  vi.mocked(filesystem.rename).mockImplementation(async (from, to) => {
    if (!failed && String(to) === ledgerPath) {
      failed = true;
      throw new Error('injected ledger failure');
    }
    await rename(from, to);
  });
  return () => failed;
}

/** Fails the journal's removal once: the ledger is published, the journal remains. */
async function failJournalCleanup(ledgerPath: string): Promise<void> {
  const { rm } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  let failed = false;
  vi.mocked(filesystem.rm).mockImplementation(async (path, options) => {
    if (!failed && String(path) === `${ledgerPath}.journal`) {
      failed = true;
      throw new Error('injected journal failure');
    }
    await rm(path, options);
  });
}

describe.each([
  { from: 'file', to: 'directory' },
  { from: 'directory', to: 'file' },
] as const)('a $from turning into a $to', ({ from, to }) => {
  it('rolls back when the ledger fails to publish after every engine write', async () => {
    const value = await engineWith(from);
    const ledgerBefore = await filesystem.readFile(value.ledgerPath, 'utf8');
    await reshape(value.root, to);
    await failLedgerPublication(value.ledgerPath);

    await expect(value.materialize()).rejects.toThrow('injected ledger failure');

    await expectShape(value.engine, from);
    expect(await filesystem.readFile(value.ledgerPath, 'utf8')).toBe(ledgerBefore);
    await expect(filesystem.readFile(`${value.ledgerPath}.journal`)).rejects.toThrow();
    vi.mocked(filesystem.rename).mockRestore();
    await value.materialize();
    await expectShape(value.engine, to);
  }, 60_000);

  it('keeps the published ledger when the journal fails to clear', async () => {
    const value = await engineWith(from);
    await reshape(value.root, to);
    await failJournalCleanup(value.ledgerPath);

    await expect(value.materialize()).rejects.toThrow('injected journal failure');

    await expectShape(value.engine, to);
    await expect(filesystem.readFile(`${value.ledgerPath}.journal`)).rejects.toThrow();
    vi.mocked(filesystem.rm).mockRestore();
    await expect(value.materialize()).resolves.toMatchObject({ changed: [], removed: [] });
    await expectShape(value.engine, to);
  }, 60_000);

  it('recovers from the journal of a run that died before publishing its ledger', async () => {
    const value = await engineWith(from);
    const ledgerBefore = await filesystem.readFile(value.ledgerPath, 'utf8');
    await reshape(value.root, to);
    const ledgerFailed = await failLedgerPublication(value.ledgerPath);
    // The process dies there: its own recovery never reads the journal, which stays behind.
    const { readFile } =
      await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let died = false;
    vi.mocked(filesystem.readFile).mockImplementation((async (path: string, options: never) => {
      if (!died && ledgerFailed() && path === `${value.ledgerPath}.journal`) {
        died = true;
        throw new Error('injected crash');
      }
      return readFile(path, options);
    }) as typeof filesystem.readFile);

    await expect(value.materialize()).rejects.toThrow('injected crash');
    await expect(filesystem.readFile(`${value.ledgerPath}.journal`)).resolves.toBeDefined();
    expect(await filesystem.readFile(value.ledgerPath, 'utf8')).toBe(ledgerBefore);

    vi.mocked(filesystem.rename).mockRestore();
    vi.mocked(filesystem.readFile).mockRestore();
    await value.materialize();
    await expectShape(value.engine, to);
    await expect(filesystem.readFile(`${value.ledgerPath}.journal`)).rejects.toThrow();
  }, 60_000);
});
