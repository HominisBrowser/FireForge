// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isSourceText, sourceGitStatus } from './git.js';
import type { SourceFileMode } from './types.js';

export interface RefreshImage {
  bytes: Buffer;
  mode: SourceFileMode;
}
export type RefreshMerge =
  | { ok: true; image?: RefreshImage }
  /** `markers` holds the text merge with its conflict markers, when one could be made. */
  | { ok: false; reason: string; markers?: Buffer };
export interface MergeLabels {
  local: string;
  base: string;
  other: string;
}
const DEFAULT_LABELS: MergeLabels = { local: 'local', base: 'old pristine', other: 'new pristine' };

function same(a: RefreshImage | undefined, b: RefreshImage | undefined): boolean {
  return a === undefined || b === undefined
    ? a === b
    : a.mode === b.mode && a.bytes.equals(b.bytes);
}

/** Three-way refresh never resolves delete/edit, binary or mode conflicts by choosing a side. */
export async function mergeRefreshImages(
  base: RefreshImage | undefined,
  local: RefreshImage | undefined,
  upstream: RefreshImage | undefined,
  labels: MergeLabels = DEFAULT_LABELS
): Promise<RefreshMerge> {
  if (same(local, upstream)) return { ok: true, ...(local ? { image: local } : {}) };
  if (same(base, local)) return { ok: true, ...(upstream ? { image: upstream } : {}) };
  if (same(base, upstream)) return { ok: true, ...(local ? { image: local } : {}) };
  if (!base || !local || !upstream) return { ok: false, reason: 'delete-edit-conflict' };
  const mode =
    local.mode === upstream.mode
      ? local.mode
      : local.mode === base.mode
        ? upstream.mode
        : upstream.mode === base.mode
          ? local.mode
          : undefined;
  if (!mode) return { ok: false, reason: 'mode-conflict' };
  if (local.bytes.equals(upstream.bytes)) return { ok: true, image: { bytes: local.bytes, mode } };
  if (local.bytes.equals(base.bytes)) return { ok: true, image: { bytes: upstream.bytes, mode } };
  if (upstream.bytes.equals(base.bytes)) return { ok: true, image: { bytes: local.bytes, mode } };
  if (![local, base, upstream].every((image) => isSourceText(image.bytes)))
    return { ok: false, reason: 'binary-conflict' };
  const temporary = await mkdtemp(join(tmpdir(), 'fireforge-refresh-merge-'));
  try {
    const paths = [local, base, upstream].map((_, index) => join(temporary, String(index)));
    for (const [index, image] of [local, base, upstream].entries())
      await writeFile(paths[index] ?? '', image.bytes);
    // --stdout is deliberately avoided: text transports must not normalize binary/CRLF output.
    const merged = await sourceGitStatus(temporary, [
      'merge-file',
      '--diff-algorithm=myers',
      '-L',
      labels.local,
      '-L',
      labels.base,
      '-L',
      labels.other,
      ...paths,
    ]);
    // Git exits with the conflict count, capped at 127; anything above that is a failure.
    if (merged.code > 127) return { ok: false, reason: 'content-conflict' };
    const bytes = await readFile(paths[0] ?? '');
    return merged.code === 0
      ? { ok: true, image: { bytes, mode } }
      : { ok: false, reason: 'content-conflict', markers: bytes };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
