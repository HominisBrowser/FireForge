// SPDX-License-Identifier: EUPL-1.2
import { listUntrackedFilesInDirs, resolveMaxUntrackedFilesPerDir } from '../core/git-status.js';
import type { StatusFile } from '../core/status-classify.js';
import { warn } from '../utils/logger.js';

/** Classification consumes the entire inventory; output limits never hide a gate input. */
export async function expandStatusInventory(
  files: StatusFile[],
  engine: string
): Promise<StatusFile[]> {
  const collapsed = files.filter((entry) => entry.file.endsWith('/') && entry.status.includes('?'));
  const listed = await listUntrackedFilesInDirs(
    engine,
    collapsed.map((entry) => entry.file)
  );
  const collapsedPaths = new Set(collapsed.map((entry) => entry.file));
  return files.flatMap((entry) =>
    collapsedPaths.has(entry.file)
      ? (listed.get(entry.file) ?? []).map((file) => ({ status: '??', file }))
      : [entry]
  );
}

/** Bound human output by top-level untracked directory, after complete classification. */
export function limitStatusDisplay<T extends StatusFile>(files: T[]): T[] {
  const cap = resolveMaxUntrackedFilesPerDir(),
    counts = new Map<string, number>();
  let hidden = 0;
  const truncated = new Set<string>();
  const shown = files.filter((entry) => {
    if (!entry.status.includes('?') || !entry.file.includes('/')) return true;
    const dir = entry.file.split('/')[0] ?? '',
      count = (counts.get(dir) ?? 0) + 1;
    counts.set(dir, count);
    if (count <= cap) return true;
    truncated.add(`${dir}/`);
    hidden++;
    return false;
  });
  if (hidden > 0)
    warn(
      `Status output is truncated: ${hidden} untracked file(s) in ${[...truncated].join(', ')} are not shown; only the first ${cap} per directory are listed. Classification and --check still evaluate every file. Use --json for the complete inventory.`
    );
  return shown;
}
