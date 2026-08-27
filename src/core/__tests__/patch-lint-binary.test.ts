// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { BINARY_BODY_CHECK, lintPatchQueueBinaryBodies } from '../patch-lint-binary.js';

const DELTA_BODY = [
  'diff --git a/res/cert.der b/res/cert.der',
  'index 1d94f88ad7bb4e5e1b1a0c9a0f0e6d4c3b2a1908..37ae6960c3aa1b2c3d4e5f60718293a4b5c6d7e8 100644',
  'GIT binary patch',
  'literal 8',
  'PcmZQzWX><iNG$>Y29N?L',
  '',
  'literal 9',
  'QcmZQzWJ=1+ODw7c00^)Gi2wiq',
  '',
].join('\n');

const STUB_BODY = [
  'diff --git a/res/cert.der b/res/cert.der',
  'index 1d94f88ad7..37ae6960c3 100644',
  'Binary files a/res/cert.der and b/res/cert.der differ',
].join('\n');

const TEXT_BODY = [
  'diff --git a/browser/a.js b/browser/a.js',
  'index 1111111..2222222 100644',
  '--- a/browser/a.js',
  '+++ b/browser/a.js',
  '@@ -1 +1 @@',
  '-old',
  '+new',
].join('\n');

const DELETION_STUB_BODY = [
  'diff --git a/res/gone.der b/res/gone.der',
  'deleted file mode 100644',
  'index 1d94f88ad7..0000000000',
  'Binary files a/res/gone.der and /dev/null differ',
].join('\n');

const ctx = (
  entries: Array<{ filename: string; diff: string }>
): { entries: Array<{ filename: string; diff: string }> } => ({ entries });

describe('lintPatchQueueBinaryBodies', () => {
  it('flags a binary section that carries no reconstructable payload', () => {
    const issues = lintPatchQueueBinaryBodies(
      ctx([{ filename: '908-infra-certs.patch', diff: STUB_BODY }])
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      file: 'res/cert.der',
      check: BINARY_BODY_CHECK,
      severity: 'error',
      patches: ['908-infra-certs.patch'],
      fingerprint: `${BINARY_BODY_CHECK}|908-infra-certs.patch|res/cert.der`,
    });
    expect(issues[0]?.message).toContain('cannot recreate the file');
    expect(issues[0]?.message).toContain('fireforge re-export 908-infra-certs.patch');
  });

  it('stays quiet on a real GIT binary patch delta', () => {
    expect(
      lintPatchQueueBinaryBodies(ctx([{ filename: '908-infra-certs.patch', diff: DELTA_BODY }]))
    ).toEqual([]);
  });

  it('stays quiet on text-only bodies', () => {
    expect(
      lintPatchQueueBinaryBodies(ctx([{ filename: '447-ui-icons.patch', diff: TEXT_BODY }]))
    ).toEqual([]);
  });

  it('exempts deletions, which need no bytes to replay', () => {
    expect(
      lintPatchQueueBinaryBodies(
        ctx([{ filename: '500-infra-drop.patch', diff: DELETION_STUB_BODY }])
      )
    ).toEqual([]);
  });

  it('reports one issue per offending file per patch across the queue', () => {
    const issues = lintPatchQueueBinaryBodies(
      ctx([
        { filename: '447-ui-icons.patch', diff: TEXT_BODY },
        { filename: '908-infra-certs.patch', diff: `${STUB_BODY}\n${DELTA_BODY}` },
        { filename: '909-infra-more.patch', diff: STUB_BODY },
      ])
    );
    expect(issues.map((issue) => issue.patches?.[0])).toEqual([
      '908-infra-certs.patch',
      '909-infra-more.patch',
    ]);
  });

  it('does not double-report a file the same patch degrades twice', () => {
    const issues = lintPatchQueueBinaryBodies(
      ctx([{ filename: '908-infra-certs.patch', diff: `${STUB_BODY}\n${STUB_BODY}` }])
    );
    expect(issues).toHaveLength(1);
  });

  it('returns nothing for an empty queue', () => {
    expect(lintPatchQueueBinaryBodies(ctx([]))).toEqual([]);
  });
});
