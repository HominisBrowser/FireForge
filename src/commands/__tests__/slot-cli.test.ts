// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sourceGit } from '../../core/authored/git.js';
import { captureAuthoredSnapshot } from '../../core/authored/index.js';
import { loadConfig } from '../../core/config.js';
import { qualifySlotNativeTools } from '../../core/jobs/native-qualify.js';
import { assertNativeBootstrapDisabled } from '../../core/jobs/native-tools.js';
import { reviewDetached } from '../../core/jobs/slot-detached.js';
import {
  createSlot,
  refreshSlotDependencies,
  removeSlot,
  restoreSlot,
} from '../../core/jobs/slot-lifecycle.js';
import { pathPresent, readTemplate } from '../../core/jobs/slot-template.js';
import { acquireSlot, auditSlot, prepareSlot, readSlot } from '../../core/jobs/slots.js';
import { readJson } from '../../core/jobs/store.js';
import { registerSlot } from '../slot.js';

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
  readFile: vi.fn(() => Promise.resolve('{"sources":{"pristineCommit":"pin"}}')),
}));
vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn(() => Promise.resolve({ sources: {} })),
}));
vi.mock('../../core/jobs/guard.js', () => ({ coordinatorNamespace: () => '/private/default' }));
vi.mock('../../core/jobs/native-qualify.js', () => ({ qualifySlotNativeTools: vi.fn() }));
vi.mock('../../core/jobs/native-tools.js', async (original) => ({
  ...(await original<typeof import('../../core/jobs/native-tools.js')>()),
  assertNativeBootstrapDisabled: vi.fn(),
}));
vi.mock('../../core/authored/git.js', async (original) => ({
  ...(await original<typeof import('../../core/authored/git.js')>()),
  sourceGit: vi.fn(),
}));
vi.mock('../../core/jobs/slot-lifecycle.js', () => ({
  createSlot: vi.fn(),
  refreshSlotDependencies: vi.fn(),
  removeSlot: vi.fn(),
  restoreSlot: vi.fn(),
}));
vi.mock('../../core/authored/index.js', () => ({
  captureAuthoredSnapshot: vi.fn(),
}));
vi.mock('../../core/jobs/slot-template.js', () => ({
  readTemplate: vi.fn(),
  pathPresent: vi.fn(),
  cloneTree: vi.fn(),
}));
vi.mock('../../core/jobs/slot-detached.js', () => ({ reviewDetached: vi.fn() }));
vi.mock('../../core/jobs/slot-replication.js', () => ({
  readReplicationMarker: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock('../../core/jobs/slots.js', () => ({
  acquireSlot: vi.fn(),
  auditSlot: vi.fn(),
  prepareSlot: vi.fn(),
  readSlot: vi.fn(),
}));
vi.mock('../../core/jobs/store.js', () => ({
  readJson: vi.fn(),
  slotDirectory: (namespace: string, id: string) => `${namespace}/slots/${id}`,
}));

const snapshot = { sourceId: 'frozen-source', pin: { commit: 'pin' }, config: {} };
const record = {
  id: 'one',
  root: '/private/default/slots/one',
  sourceId: 'frozen-source-0123',
  generation: 1,
  quarantined: null,
};
const recordLine = 'one source=frozen-sourc generation=1';
const originalArgv = process.argv;
const qualifyJob = {
  id: 'job',
  state: 'passed',
  owner: 'x',
  slot: 'one',
  request: { steps: [{ command: 'qualify-native', args: [] }] },
};
const release = vi.fn();
let writes: string[];
let errors: string[];

async function run(...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  program.configureOutput({ writeErr: () => undefined });
  registerSlot(program, {
    getProjectRoot: () => '/editor',
    withErrorHandling: (handler) => handler,
  });
  process.argv = ['node', 'fireforge', 'slot', ...args];
  await program.parseAsync(process.argv);
}

beforeEach(() => {
  vi.resetAllMocks();
  writes = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  errors = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errors.push(String(chunk));
    return true;
  });
  vi.mocked(loadConfig).mockResolvedValue({ sources: {} } as never);
  vi.mocked(sourceGit).mockResolvedValue(Buffer.from(''));
  vi.mocked(readJson).mockResolvedValue(snapshot);
  vi.mocked(readTemplate).mockResolvedValue(undefined);
  vi.mocked(createSlot).mockResolvedValue(record as never);
  vi.mocked(readSlot).mockResolvedValue(record as never);
  vi.mocked(acquireSlot).mockResolvedValue(release);
  vi.mocked(prepareSlot).mockResolvedValue(record as never);
  vi.mocked(auditSlot).mockResolvedValue({ clean: true } as never);
});
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

describe('slot CLI isolation and exclusive lease contracts', () => {
  it('qualifies native sites by submitting a job, with no manifest in sight', async () => {
    vi.mocked(qualifySlotNativeTools).mockResolvedValue(qualifyJob as never);
    await run('qualify-native', 'one');
    expect(qualifySlotNativeTools).toHaveBeenCalledExactlyOnceWith('/private/default', 'one');
    expect(writes.join('')).toContain('job passed slot=one');
  });

  it('retains explicit native namespace selection and propagates refusal without positive output', async () => {
    vi.mocked(qualifySlotNativeTools).mockRejectedValue(new Error('No toolchain'));
    await expect(run('qualify-native', 'one', '--namespace', 'explicit')).rejects.toThrow(
      'No toolchain'
    );
    expect(qualifySlotNativeTools).toHaveBeenCalledWith(resolve('explicit'), 'one');
    expect(writes).toEqual([]);
  });

  it('creates from only a snapshot and pristine donor by default', async () => {
    await run('create', 'one', '--snapshot', 'snapshot.json', '--pristine-repository', 'pristine');
    expect(readJson).toHaveBeenCalledWith(resolve('snapshot.json'));
    expect(createSlot).toHaveBeenCalledWith({
      namespace: '/private/default',
      id: 'one',
      snapshot,
      pristineRepository: resolve('pristine'),
      caches: [],
    });
    expect(writes).toEqual([`Slot ${recordLine}\n`]);
  });

  it('forwards only explicitly requested cache settings', async () => {
    await run(
      'create',
      'one',
      '--snapshot',
      'snapshot.json',
      '--pristine-repository',
      'pristine',
      '--namespace',
      '/private/explicit',
      '--cache',
      'node_modules=dependencies',
      '--from',
      'built'
    );
    expect(createSlot).toHaveBeenCalledWith({
      namespace: '/private/explicit',
      id: 'one',
      snapshot,
      pristineRepository: resolve('pristine'),
      from: 'built',
      caches: [{ source: resolve('dependencies'), target: 'node_modules' }],
    });
  });

  it('starts a clone of a built slot on that slot’s own source, taking no trees of its own', async () => {
    await run('create', 'two', '--from', 'built', '--namespace', '/private/explicit');
    expect(readSlot).toHaveBeenCalledWith('/private/explicit', 'built');
    expect(readJson).toHaveBeenCalledWith('/private/explicit/slots/built/snapshot.json');
    expect(createSlot).toHaveBeenCalledWith({
      namespace: '/private/explicit',
      id: 'two',
      snapshot,
      from: 'built',
      caches: [],
    });
  });

  it('captures this checkout when told nothing else, with the donor named', async () => {
    vi.mocked(captureAuthoredSnapshot).mockResolvedValue(snapshot as never);
    await run('create', 'two', '--pristine-repository', 'pristine');
    expect(captureAuthoredSnapshot).toHaveBeenCalledWith({
      projectRoot: '/editor',
      pristineRepository: resolve('pristine'),
    });
  });

  it('refreshes each slot named from this checkout, and says what it replaced', async () => {
    vi.mocked(captureAuthoredSnapshot).mockResolvedValue(snapshot as never);
    vi.mocked(readTemplate).mockResolvedValue({ repository: '/template' } as never);
    vi.mocked(refreshSlotDependencies)
      .mockResolvedValueOnce(['node_modules', 'vendor/py'])
      .mockResolvedValueOnce([]);
    await run('refresh-deps', 'one', 'two');
    expect(refreshSlotDependencies).toHaveBeenCalledWith({
      namespace: '/private/default',
      id: 'one',
      snapshot,
      caches: [],
    });
    expect(writes.join('')).toBe(
      'Slot one: refreshed node_modules, vendor/py\nSlot two: refreshed nothing\n'
    );
  });

  it('refuses a cache this source does not declare before refreshing anything', async () => {
    vi.mocked(captureAuthoredSnapshot).mockResolvedValue(snapshot as never);
    vi.mocked(readTemplate).mockResolvedValue({ repository: '/template' } as never);
    await expect(run('refresh-deps', 'one', '--cache', 'other=/tree')).rejects.toThrow(
      /--cache other names no cache declared/
    );
    expect(refreshSlotDependencies).not.toHaveBeenCalled();
  });

  it('preserves a removal refusal', async () => {
    vi.mocked(removeSlot).mockRejectedValue(new Error('Slot is leased by a live job'));
    await expect(run('remove', 'one')).rejects.toThrow('Slot is leased');
    expect(removeSlot).toHaveBeenCalledWith('/private/default', 'one');
    expect(writes).toEqual([]);
  });

  it('returns the completed removal', async () => {
    vi.mocked(removeSlot).mockResolvedValue({ removed: 'one' });
    await run('remove', 'one', '--namespace', '/private/explicit');
    expect(removeSlot).toHaveBeenCalledWith('/private/explicit', 'one');
    expect(writes).toEqual(['Slot one: removed\n']);
  });

  it('restores a slot through its own lifecycle call', async () => {
    vi.mocked(restoreSlot).mockResolvedValue(record as never);
    await run('restore', 'one');
    expect(restoreSlot).toHaveBeenCalledWith('/private/default', 'one', {
      stopOrphans: false,
      onStopped: expect.any(Function) as unknown,
    });
    expect(writes).toEqual([`Slot ${recordLine}: restored\n`]);
  });

  it('stops orphans first with --stop-orphans and prints each with its command', async () => {
    vi.mocked(restoreSlot).mockImplementation((_namespace, _id, options) => {
      options?.onStopped?.([{ pid: 4242, command: '/bin/sleep 120' }]);
      return Promise.resolve(record as never);
    });
    await run('restore', 'one', '--stop-orphans');
    expect(vi.mocked(restoreSlot).mock.calls[0]?.[2]).toMatchObject({ stopOrphans: true });
    expect(writes).toEqual([`Stopped orphan 4242: /bin/sleep 120\nSlot ${recordLine}: restored\n`]);
  });

  it('reports one unreadable slot without hiding the others', async () => {
    vi.mocked(readdir).mockResolvedValue(['one', 'typo'] as never);
    vi.mocked(readSlot).mockImplementation((_namespace, id) =>
      id === 'one' ? Promise.resolve(record as never) : Promise.reject(new Error('no metadata'))
    );
    await run('list', '--json');
    expect(JSON.parse(writes.join(''))).toEqual({
      schemaVersion: 1,
      slots: [record, { id: 'typo', error: 'no metadata' }],
    });
    writes.length = 0;
    await run('list');
    expect(writes).toEqual([`${recordLine}\ntypo error="no metadata"\n`]);
  });

  it('lists existing owned records without creating a namespace', async () => {
    vi.mocked(readdir).mockResolvedValue(['one', 'two'] as never);
    await run('list');
    expect(readSlot).toHaveBeenNthCalledWith(1, '/private/default', 'one');
    expect(readSlot).toHaveBeenNthCalledWith(2, '/private/default', 'two');
    expect(writes).toEqual([`${recordLine}\n${recordLine}\n`]);
    expect(createSlot).not.toHaveBeenCalled();
  });

  it('treats a missing namespace as empty but propagates access errors', async () => {
    vi.mocked(readdir).mockRejectedValueOnce(
      Object.assign(new Error('missing'), { code: 'ENOENT' })
    );
    await run('list');
    expect(writes).toEqual(['No slots\n']);
    vi.mocked(readdir).mockRejectedValueOnce(
      Object.assign(new Error('denied'), { code: 'EACCES' })
    );
    await expect(run('list')).rejects.toThrow('denied');
    expect(readSlot).not.toHaveBeenCalled();
  });

  it.each(['prepare', 'audit'])(
    'holds the exclusive lease through %s and releases after success',
    async (operation) => {
      await run(
        operation,
        'one',
        ...(operation === 'prepare' ? ['--snapshot', 'snapshot.json'] : [])
      );
      expect(acquireSlot).toHaveBeenCalledWith('/private/default', 'one');
      expect(vi.mocked(acquireSlot).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(readSlot).mock.invocationCallOrder[0] ?? 0
      );
      expect(release).toHaveBeenCalledOnce();
      if (operation === 'prepare')
        expect(prepareSlot).toHaveBeenCalledWith('/private/default', record, snapshot);
      else expect(auditSlot).toHaveBeenCalledWith('/private/default', record);
    }
  );

  it.each(['prepare', 'audit'])(
    'releases the lease when %s fails without printing success',
    async (operation) => {
      vi.mocked(prepareSlot).mockRejectedValue(new Error('dirty boundary'));
      vi.mocked(auditSlot).mockRejectedValue(new Error('dirty boundary'));
      await expect(
        run(operation, 'one', ...(operation === 'prepare' ? ['--snapshot', 'snapshot.json'] : []))
      ).rejects.toThrow('dirty boundary');
      expect(release).toHaveBeenCalledOnce();
      expect(writes).toEqual([]);
    }
  );

  it('looks at what phases left detached in the slot, under the lease, before auditing it', async () => {
    vi.mocked(reviewDetached).mockRejectedValue(
      new Error('process 7 (daemon) left detached by job j, now holds /x')
    );
    await expect(run('audit', 'one')).rejects.toThrow('left detached by job j');
    expect(reviewDetached).toHaveBeenCalledWith('/private/default', record);
    expect(auditSlot).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('does not inspect or prepare a slot when exclusive acquisition is refused', async () => {
    vi.mocked(acquireSlot).mockRejectedValue(new Error('already leased'));
    await expect(run('prepare', 'one', '--snapshot', 'snapshot.json')).rejects.toThrow(
      'already leased'
    );
    expect(readSlot).not.toHaveBeenCalled();
    expect(prepareSlot).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('qualifies a new slot’s native sites when the host has a toolchain, as host init does', async () => {
    vi.mocked(pathPresent).mockImplementation((path) =>
      Promise.resolve(path === '/private/default/toolchain.json')
    );
    vi.mocked(qualifySlotNativeTools).mockResolvedValue(qualifyJob as never);
    await run('create', 'one', '--snapshot', 'snapshot.json', '--pristine-repository', 'pristine');
    expect(assertNativeBootstrapDisabled).toHaveBeenCalledWith(snapshot);
    expect(qualifySlotNativeTools).toHaveBeenCalledExactlyOnceWith(
      '/private/default',
      'one',
      snapshot
    );
    expect(writes.join('')).toBe(`job passed slot=one owner=x\nSlot ${recordLine} qualified\n`);
    writes.length = 0;
    await run('create', 'two', '--from', 'built');
    expect(qualifySlotNativeTools).toHaveBeenLastCalledWith('/private/default', 'two', snapshot);
  });

  it('says loudly why a new slot is not qualified, and how to qualify it', async () => {
    await run('create', 'one', '--snapshot', 'snapshot.json', '--pristine-repository', 'pristine');
    expect(qualifySlotNativeTools).not.toHaveBeenCalled();
    expect(errors.join('')).toBe(
      'warning: Slot one is NOT qualified for native jobs: builds and tests refuse on it. This host has no frozen toolchain; derive one with: fireforge host init --from-engine <engine>. Then run: fireforge slot qualify-native one\n'
    );
    vi.mocked(pathPresent).mockResolvedValue(true);
    vi.mocked(assertNativeBootstrapDisabled).mockRejectedValue(
      new Error('configs/common.mozconfig: add the line "ac_add_options --disable-bootstrap"')
    );
    errors.length = 0;
    writes.length = 0;
    await run('create', 'one', '--from', 'built', '--json');
    expect(qualifySlotNativeTools).not.toHaveBeenCalled();
    expect(errors.join('')).toContain(
      'NOT qualified for native jobs: builds and tests refuse on it. configs/common.mozconfig: add the line'
    );
    expect(JSON.parse(writes.join(''))).toMatchObject({
      slot: record,
      qualified: false,
      unqualified: 'configs/common.mozconfig: add the line "ac_add_options --disable-bootstrap"',
    });
    errors.length = 0;
    await run('create', 'one', '--from', 'built', '--no-qualify');
    expect(assertNativeBootstrapDisabled).toHaveBeenCalledTimes(1);
    expect(errors.join('')).toContain(
      'NOT qualified for native jobs: builds and tests refuse on it. --no-qualify skipped it.'
    );
  });

  it('fails a creation whose qualification went red, naming the command that retries it', async () => {
    vi.mocked(pathPresent).mockResolvedValue(true);
    vi.mocked(qualifySlotNativeTools).mockResolvedValue({
      ...qualifyJob,
      state: 'failed',
      reason: 'mach configure failed',
    } as never);
    await expect(run('create', 'one', '--from', 'built')).rejects.toThrow(
      'Slot one was created, but its native sites did not qualify: mach configure failed. Static jobs can run on it; after fixing that, run: fireforge slot qualify-native one'
    );
  });

  it('refreshes past unrelated dirty paths, taking committed bytes for them', async () => {
    vi.mocked(captureAuthoredSnapshot).mockResolvedValue(snapshot as never);
    vi.mocked(readTemplate).mockResolvedValue({ repository: '/template' } as never);
    vi.mocked(loadConfig).mockResolvedValue({
      sources: { root: 'src' },
      slots: {
        dependencyCaches: [
          { source: 'engine/node_modules', target: 'engine/node_modules' },
          { source: 'tools/kit/node_modules', target: 'tools/kit/node_modules' },
        ],
      },
    } as never);
    vi.mocked(refreshSlotDependencies).mockResolvedValue([]);
    await run('refresh-deps', 'one');
    expect(captureAuthoredSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: '/editor', allowDirtyRoot: true })
    );
    expect(sourceGit).toHaveBeenCalledWith('/editor', [
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=all',
      '--',
      'fireforge.json',
      'package-lock.json',
      'engine/package-lock.json',
      'src/package-lock.json',
      'tools/kit/package-lock.json',
    ]);
    expect(refreshSlotDependencies).toHaveBeenCalledOnce();
  });

  it('still refuses a dirty lockfile or configuration before capturing anything', async () => {
    vi.mocked(sourceGit).mockResolvedValue(
      Buffer.from(' M package-lock.json\0?? fireforge.json\0')
    );
    await expect(run('refresh-deps', 'one', 'two')).rejects.toThrow(
      'Dependency trees follow the committed fireforge.json and lockfiles, and these have uncommitted changes: package-lock.json, fireforge.json. Commit or restore them first'
    );
    expect(captureAuthoredSnapshot).not.toHaveBeenCalled();
    expect(refreshSlotDependencies).not.toHaveBeenCalled();
  });
});
