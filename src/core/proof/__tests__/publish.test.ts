// SPDX-License-Identifier: EUPL-1.2
/**
 * Publication records beside the verified ref: carried-from records are written
 * with the commit, cleared by a publication on the commit's own evidence, and
 * never produced for waived obligations.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ObligationStatus, ProofStatus } from '../evidence.js';
import { advanceVerified, publicationRecords } from '../publish.js';
import type { ProofPlan } from '../types.js';
import { readCarryRecord, readWaiverRecord } from '../verified.js';

let root: string;
const git = (...args: string[]): string =>
  execFileSync(
    'git',
    ['-C', root, '-c', 'user.email=f@example.invalid', '-c', 'user.name=f', ...args],
    { encoding: 'utf8' }
  ).trim();

function commit(message: string): string {
  git('commit', '-q', '--allow-empty', '-m', message);
  return git('rev-parse', 'HEAD');
}

const obligation = (id: string, extra: Partial<ObligationStatus> = {}): ObligationStatus => ({
  id,
  kind: 'test',
  state: 'passed',
  reason: '',
  reds: 0,
  ...extra,
});
const statusOf = (...obligations: ObligationStatus[]): ProofStatus => ({
  complete: true,
  obligations,
  waived: [],
  failures: [],
  finished: obligations.length,
});
const planWith = (carry: boolean, from = 'f'.repeat(40)): ProofPlan =>
  ({ ...(carry ? { carry: { commit: from } } : {}) }) as unknown as ProofPlan;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fireforge-publish-'));
  git('init', '-q');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('publicationRecords', () => {
  it('records the carried obligations and the commit they came from', () => {
    const records = publicationRecords(
      planWith(true, 'a'.repeat(40)),
      statusOf(obligation('x', { carried: 'a'.repeat(40) }), obligation('y')),
      'note',
      'me'
    );
    expect(records.carry).toMatchObject({ from: 'a'.repeat(40), carried: ['x'], by: 'me' });
    expect(records.waivers).toBeUndefined();
  });

  it('records nothing for carry without carried obligations or without a carry plan', () => {
    expect(publicationRecords(planWith(true), statusOf(obligation('y')), 'n', 'me')).toEqual({});
    expect(
      publicationRecords(planWith(false), statusOf(obligation('x', { carried: 'a' })), 'n', 'me')
    ).toEqual({});
  });

  it('records waivers and never carries a waived obligation', () => {
    const records = publicationRecords(
      planWith(true),
      statusOf(
        obligation('w', {
          state: 'waived',
          decision: { note: 'why', by: 'p', at: 't' } as NonNullable<ObligationStatus['decision']>,
        }),
        obligation('x', { carried: 'a'.repeat(40) })
      ),
      'note',
      'me'
    );
    expect(records.waivers?.waived).toEqual([{ obligation: 'w', note: 'why', by: 'p', at: 't' }]);
    expect(records.carry?.carried).toEqual(['x']);
  });

  it('fills blanks for a waiver without a decision', () => {
    const records = publicationRecords(
      planWith(false),
      statusOf(obligation('w', { state: 'waived' })),
      'n',
      'me'
    );
    expect(records.waivers?.waived).toEqual([{ obligation: 'w', note: '', by: '', at: '' }]);
  });
});

describe('advanceVerified carry records', () => {
  it('writes the carry record, then clears it when published on its own evidence', async () => {
    const first = commit('one');
    const second = commit('two');
    const carry = { from: first, carried: ['x'], by: 'me', at: 't' };

    await advanceVerified(root, first, false);
    const result = await advanceVerified(root, second, false, { carry });
    expect(result).toMatchObject({ commit: second, previous: first, rewritten: false });
    expect(await readCarryRecord(root, second)).toEqual({ ...carry, commit: second });

    await advanceVerified(root, second, false);
    expect(await readCarryRecord(root, second)).toBeUndefined();
  });

  it('keeps carry and waiver records independent and clears waivers on a clean publication', async () => {
    const first = commit('one');
    await advanceVerified(root, first, false, {
      waivers: { note: 'n', by: 'me', at: 't', waived: [] },
      carry: { from: first, carried: ['x'], by: 'me', at: 't' },
    });
    expect(await readWaiverRecord(root, first)).toBeDefined();
    expect(await readCarryRecord(root, first)).toBeDefined();

    await advanceVerified(root, first, false, {
      carry: { from: first, carried: ['x'], by: 'me', at: 't' },
    });
    expect(await readWaiverRecord(root, first)).toBeUndefined();
    expect(await readCarryRecord(root, first)).toBeDefined();
  });
});
