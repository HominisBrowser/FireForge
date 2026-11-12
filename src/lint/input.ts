// SPDX-License-Identifier: EUPL-1.2
/**
 * The owned changes as rules read them: each live path's final text,
 * decoded once, and each change's added and removed lines, read from the
 * provider's unified diff.
 */
import { addedLines, type FileDiff, parsePatch } from '../diff/index.js';
import type { ChangeSet, CreateChange, ModifyChange, OwnedChange } from '../project/index.js';
import { textContent } from '../project/index.js';

/** A path the project owns that exists after its changes. */
export interface OwnedFile {
  readonly path: string;
  /** The net change: a create or a modify. */
  readonly change: OwnedChange;
  /** The project created the path; otherwise it modifies an upstream file. */
  readonly created: boolean;
  /** Final content as text, or undefined when it is binary. */
  readonly text: string | undefined;
  /** The group that brought the path in. */
  readonly group: string | undefined;
}

/** A line a change adds, numbered in the content after the change. */
export interface AddedLine {
  readonly line: number;
  readonly text: string;
}

/**
 * A unified diff replacing every line, for a provider without a diff
 * function: correct, if larger than the real diff.
 */
function wholeFileDiff(change: OwnedChange, before: string, after: string): string {
  const lines = (text: string): string[] =>
    text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const old = lines(before);
  const next = lines(after);
  const path = change.path;
  return [
    `diff --git a/${path} b/${path}`,
    change.kind === 'create' ? '--- /dev/null' : `--- a/${path}`,
    change.kind === 'delete' ? '+++ /dev/null' : `+++ b/${path}`,
    `@@ -${old.length === 0 ? 0 : 1},${old.length} +${next.length === 0 ? 0 : 1},${next.length} @@`,
    ...old.map((line) => `-${line}`),
    ...next.map((line) => `+${line}`),
    '',
  ].join('\n');
}

async function readText(reader: () => Promise<Uint8Array>): Promise<string> {
  return textContent(await reader()) ?? '';
}

/** The owned changes, indexed for rules. Build one per run with {@link loadOwnedFiles}. */
export class OwnedFiles {
  private readonly byPath: ReadonlyMap<string, OwnedFile>;
  private readonly diffs = new Map<OwnedChange, Promise<FileDiff | undefined>>();

  constructor(
    private readonly changes: ChangeSet,
    files: readonly OwnedFile[]
  ) {
    this.byPath = new Map(files.map((file) => [file.path, file]));
  }

  /** Every live owned path, by path. */
  all(): readonly OwnedFile[] {
    return [...this.byPath.values()];
  }

  /** The live owned path, or undefined when the project does not own it or deletes it. */
  get(path: string): OwnedFile | undefined {
    return this.byPath.get(path);
  }

  /** Whether the project deletes this upstream path. */
  deletes(path: string): boolean {
    return this.changes.final(path)?.kind === 'delete';
  }

  /** The text section of a change's diff, or undefined for a binary change. */
  diff(change: OwnedChange): Promise<FileDiff | undefined> {
    let pending = this.diffs.get(change);
    if (pending === undefined) {
      pending = this.readDiff(change);
      this.diffs.set(change, pending);
    }
    return pending;
  }

  /** The lines a change adds, numbered in its after content. */
  async added(change: OwnedChange): Promise<AddedLine[]> {
    const diff = await this.diff(change);
    return diff === undefined ? [] : addedLines(diff);
  }

  /** The lines a change removes, without their markers. */
  async removed(change: OwnedChange): Promise<string[]> {
    const diff = await this.diff(change);
    return (diff?.hunks ?? []).flatMap((hunk) =>
      hunk.lines.filter((line) => line.startsWith('-')).map((line) => line.slice(1))
    );
  }

  private async readDiff(change: OwnedChange): Promise<FileDiff | undefined> {
    if (change.binary) return undefined;
    const text =
      this.changes.diff === undefined
        ? wholeFileDiff(
            change,
            change.kind === 'create' ? '' : await readText(change.before),
            change.kind === 'delete' ? '' : await readText(change.after)
          )
        : await this.changes.diff(change);
    return parsePatch(text).files.find((file) => file.path === change.path);
  }
}

/**
 * Reads the final text of every live owned path.
 *
 * @param changes - The owned changes
 */
export async function loadOwnedFiles(changes: ChangeSet): Promise<OwnedFiles> {
  const live = changes
    .net()
    .filter((change): change is CreateChange | ModifyChange => change.kind !== 'delete');
  const files = await Promise.all(
    live.map(async (change): Promise<OwnedFile> => {
      const bytes = await change.after();
      return {
        path: change.path,
        change,
        created: change.kind === 'create',
        text: change.binary || change.mode === '120000' ? undefined : textContent(bytes),
        group: change.group,
      };
    })
  );
  return new OwnedFiles(changes, files);
}
