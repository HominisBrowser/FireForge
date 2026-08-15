// SPDX-License-Identifier: EUPL-1.2
/**
 * Build identity (FORGE K2/K3/L8): `--version` reports
 * `<semver>+g<short-sha>[.dirty[.<content-hash>]]` from live git in a
 * checkout or from the stamped dist/build-info.json in an installed
 * package — and must degrade to the plain semver (never throw) on any
 * misread.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  formatVersionWithIdentity,
  getCliVersion,
  readBuildInfoFile,
  readGitBuildIdentity,
} from '../build-info.js';

describe('readBuildInfoFile', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ff-build-info-'));
    await mkdir(join(root, 'dist'), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function stamp(content: string): Promise<void> {
    await writeFile(join(root, 'dist', 'build-info.json'), content);
  }

  it('reads a clean stamped identity', async () => {
    await stamp(JSON.stringify({ schemaVersion: 1, shortCommit: 'abc123def456', dirty: false }));
    expect(readBuildInfoFile(root)).toEqual({ shortCommit: 'abc123def456', dirty: false });
  });

  it('reads a dirty stamped identity', async () => {
    await stamp(JSON.stringify({ schemaVersion: 1, shortCommit: 'abc123def456', dirty: true }));
    expect(readBuildInfoFile(root)).toEqual({ shortCommit: 'abc123def456', dirty: true });
  });

  it('carries the dirty content hash when the stamp recorded one (FORGE L8)', async () => {
    await stamp(
      JSON.stringify({
        schemaVersion: 1,
        shortCommit: 'abc123def456',
        dirty: true,
        dirtyHash: '85e595d7',
      })
    );
    expect(readBuildInfoFile(root)).toEqual({
      shortCommit: 'abc123def456',
      dirty: true,
      dirtyHash: '85e595d7',
    });
  });

  it('omits a null dirtyHash rather than carrying it as a field', async () => {
    await stamp(
      JSON.stringify({
        schemaVersion: 1,
        shortCommit: 'abc123def456',
        dirty: false,
        dirtyHash: null,
      })
    );
    expect(readBuildInfoFile(root)).toEqual({ shortCommit: 'abc123def456', dirty: false });
  });

  it('returns null for a missing file', () => {
    expect(readBuildInfoFile(root)).toBeNull();
  });

  it('returns null for malformed JSON', async () => {
    await stamp('{not json');
    expect(readBuildInfoFile(root)).toBeNull();
  });

  it('returns null for an unknown schemaVersion', async () => {
    await stamp(JSON.stringify({ schemaVersion: 2, shortCommit: 'abc123def456', dirty: false }));
    expect(readBuildInfoFile(root)).toBeNull();
  });

  it('returns null when the stamp recorded no commit (git-less staging build)', async () => {
    await stamp(JSON.stringify({ schemaVersion: 1, shortCommit: null, dirty: null }));
    expect(readBuildInfoFile(root)).toBeNull();
  });
});

describe('readGitBuildIdentity', () => {
  it('derives short commit and clean state from git output', () => {
    const identity = readGitBuildIdentity((args) =>
      args[0] === 'rev-parse' ? 'abc123def4567890abcdef1234567890abcdef12\n' : ''
    );
    expect(identity).toEqual({ shortCommit: 'abc123def456', dirty: false });
  });

  it('reports dirty when porcelain status is non-empty', () => {
    const identity = readGitBuildIdentity((args) =>
      args[0] === 'rev-parse' ? 'abc123def4567890abcdef1234567890abcdef12\n' : ' M src/cli.ts\n'
    );
    expect(identity).toEqual({ shortCommit: 'abc123def456', dirty: true });
  });

  it('returns null when git throws', () => {
    expect(
      readGitBuildIdentity(() => {
        throw new Error('not a git repository');
      })
    ).toBeNull();
  });

  it('returns null when rev-parse yields something that is not a sha', () => {
    expect(readGitBuildIdentity(() => 'HEAD\n')).toBeNull();
  });
});

describe('getCliVersion', () => {
  it('reports semver plus live git identity when running from the repo checkout', () => {
    // The test process runs inside the FireForge git checkout, so the
    // git-first precedence path resolves a real identity. Shape only —
    // the sha and dirty state vary by checkout.
    expect(getCliVersion()).toMatch(
      /^\d+\.\d+\.\d+(\+g[0-9a-f]{7,40}(\.dirty(\.[0-9a-f]{8})?)?)?$/
    );
  });
});

describe('formatVersionWithIdentity', () => {
  it('formats clean, dirty, and unknown identities', () => {
    expect(formatVersionWithIdentity('0.41.0', { shortCommit: 'abc123def456', dirty: false })).toBe(
      '0.41.0+gabc123def456'
    );
    expect(formatVersionWithIdentity('0.41.0', { shortCommit: 'abc123def456', dirty: true })).toBe(
      '0.41.0+gabc123def456.dirty'
    );
    expect(formatVersionWithIdentity('0.41.0', null)).toBe('0.41.0');
  });

  it('appends the content hash so two dirty packs from one HEAD differ (FORGE L8)', () => {
    const base = { shortCommit: 'abc123def456', dirty: true };
    expect(formatVersionWithIdentity('0.41.0', { ...base, dirtyHash: '85e595d7' })).toBe(
      '0.41.0+gabc123def456.dirty.85e595d7'
    );
    expect(formatVersionWithIdentity('0.41.0', { ...base, dirtyHash: 'ad7170b0' })).not.toBe(
      formatVersionWithIdentity('0.41.0', { ...base, dirtyHash: '85e595d7' })
    );
  });

  it('never appends a content hash to a CLEAN identity', () => {
    // A released build has no uncommitted content to hash; a stray value
    // must not leak into the identity a consumer pins.
    expect(
      formatVersionWithIdentity('0.41.0', {
        shortCommit: 'abc123def456',
        dirty: false,
        dirtyHash: '85e595d7',
      })
    ).toBe('0.41.0+gabc123def456');
  });
});
