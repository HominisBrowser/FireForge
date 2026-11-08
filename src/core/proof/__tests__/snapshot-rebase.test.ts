// SPDX-License-Identifier: EUPL-1.2
/** What a gate plans when a pin refresh only rebases an override record. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { FireForgeConfig } from '../../../types/config.js';
import { commitFixture, writeAt } from '../../authored/__tests__/fixtures.js';
import { digest, sourceGit } from '../../authored/git.js';
import type { AuthoredSnapshot, UpstreamDeclaration } from '../../authored/types.js';
import { planCapturedSource } from '../snapshot.js';

const TEST = 'browser/components/asrouter/tests/chrome/test_menu_message.html';
const RECORD = `.fireforge-sources/overrides/${TEST}.json`;
const ADR = 'docs/adr/0001-menu-message.md';
const OLD = { commit: '1'.repeat(40), blob: 'b'.repeat(40) };
const NEW = { commit: '2'.repeat(40), blob: 'b'.repeat(40) };

const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
});

function config(version: string): FireForgeConfig {
  return {
    name: 'Fixture',
    vendor: 'Example',
    binaryName: 'fixture',
    appId: 'invalid.example.fixture',
    firefox: { version, product: 'firefox-esr', sha256: 'a'.repeat(64) },
    sources: {
      schemaVersion: 1,
      mode: 'authored',
      root: 'src',
      metadataRoot: '.fireforge-sources',
      pristineCommit: OLD.commit,
    },
    proof: { gate: { lanes: [{ id: 'smoke', files: ['browser/base/test/browser_smoke.js'] }] } },
  };
}

function record(
  from: FireForgeConfig,
  base: { commit: string; blob: string },
  extra: Partial<UpstreamDeclaration> = {}
): UpstreamDeclaration {
  return {
    schemaVersion: 1,
    kind: 'override',
    path: TEST,
    base: { pin: digest({ firefox: from.firefox, commit: base.commit }), ...base, mode: '100644' },
    component: 'asrouter',
    classification: 'exception',
    adr: ADR,
    ...extra,
  };
}

const rev = async (root: string, spec: string): Promise<string> =>
  (await sourceGit(root, ['rev-parse', spec])).toString('utf8').trim();

/**
 * A main branch overriding an upstream test, and a task branch on top that moves the
 * pin and whatever else `change` writes, captured the way a gate reads it.
 */
async function refreshed(
  change: (root: string, next: FireForgeConfig) => Promise<void>
): Promise<AuthoredSnapshot> {
  const directory = await mkdtemp(join(tmpdir(), 'fireforge-proof-rebase-'));
  directories.push(directory);
  const root = join(directory, 'project');
  const before = config('153.6.0esr');
  await sourceGit(directory, ['init', '-q', '-b', 'main', root]);
  await writeAt(root, 'fireforge.json', JSON.stringify(before));
  await writeAt(root, ADR, '# Menu message\n');
  await writeAt(root, `src/${TEST}`, '<!doctype html><title>menu</title>\n');
  await writeAt(root, RECORD, JSON.stringify(record(before, OLD), null, 2));
  await commitFixture(root);
  await sourceGit(root, ['checkout', '-q', '-b', 'task']);
  const next = config('153.7.0esr');
  await writeAt(root, 'fireforge.json', JSON.stringify(next));
  await change(root, next);
  await commitFixture(root);
  const tree = await rev(root, 'HEAD^{tree}');
  const blob = async (path: string): Promise<string> => rev(root, `HEAD:${path}`);
  const declaration = JSON.parse(
    (await sourceGit(root, ['show', `HEAD:${RECORD}`])).toString('utf8')
  ) as UpstreamDeclaration;
  return {
    schemaVersion: 1,
    id: digest({ tree }),
    repository: root,
    tree,
    objectFormat: 'sha1',
    pin: { firefox: next.firefox, commit: NEW.commit, digest: declaration.base.pin },
    config: next,
    inputs: [
      { path: 'fireforge.json', blob: await blob('fireforge.json'), mode: '100644' },
      { path: ADR, blob: await blob(ADR), mode: '100644' },
    ],
    files: [
      {
        path: TEST,
        kind: 'override',
        blob: await blob(`src/${TEST}`),
        mode: '100644',
        declaration,
      },
    ],
  };
}

const gate = (snapshot: AuthoredSnapshot): ReturnType<typeof planCapturedSource> =>
  planCapturedSource({ root: snapshot.repository, snapshot, tier: 'gate' });

describe.concurrent('planCapturedSource after a pin refresh', () => {
  it('does not count an override record that only rebased onto the new pin as a changed test', async () => {
    const snapshot = await refreshed(async (root, next) => {
      await writeAt(root, RECORD, JSON.stringify(record(next, NEW), null, 2));
    });
    const plan = await gate(snapshot);
    expect(plan.changed.map((change) => change.path)).toEqual(['fireforge.json']);
    // The pin still forces the full build and the gate's lanes.
    expect(plan.changed[0]?.route).toBe('unknown');
    const ids = plan.obligations.map((obligation) => obligation.id);
    expect(ids).toEqual(expect.arrayContaining(['build', 'lane:smoke', 'check']));
    expect(plan.obligations.find(({ id }) => id === 'build')?.step).toEqual({
      command: 'build',
      args: [],
    });
    expect(ids).not.toContain('accept:proof-config');
  });

  it('still refuses a rebased record whose test bytes changed too', async () => {
    const snapshot = await refreshed(async (root, next) => {
      await writeAt(root, RECORD, JSON.stringify(record(next, NEW), null, 2));
      await writeAt(root, `src/${TEST}`, '<!doctype html><title>menu, changed</title>\n');
    });
    await expect(gate(snapshot)).rejects.toThrow(`proof-unclassified-test: ${TEST}`);
  });

  it('still counts a rebased record whose classification changed', async () => {
    const snapshot = await refreshed(async (root, next) => {
      await writeAt(
        root,
        RECORD,
        JSON.stringify({ ...record(next, NEW), classification: 'registration', adr: undefined })
      );
    });
    await expect(gate(snapshot)).rejects.toThrow(`proof-unclassified-test: ${TEST}`);
  });

  it('still counts a rebased record whose component changed', async () => {
    const snapshot = await refreshed(async (root, next) => {
      await writeAt(root, RECORD, JSON.stringify(record(next, NEW, { component: 'messaging' })));
    });
    await expect(gate(snapshot)).rejects.toThrow(`proof-unclassified-test: ${TEST}`);
  });
});
