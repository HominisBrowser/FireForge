// SPDX-License-Identifier: EUPL-1.2
/**
 * In-memory change sets for tests of code that reads owned changes: steps
 * written as before/after text, a diff provider that produces real unified
 * diffs (one hunk per file, every unchanged line as context), and an engine
 * reader over a file table.
 */
import {
  type ChangeGroup,
  type ChangeSet,
  createChangeSet,
  type OwnedChange,
} from '../project/index.js';

/** One step: a create without `before`, a delete without `after`, else a modify. */
export interface TextStep {
  readonly path: string;
  readonly group?: string;
  readonly before?: string | undefined;
  readonly after?: string | undefined;
}

const encoder = new TextEncoder();
const reader = (text: string) => () => Promise.resolve(encoder.encode(text));

function step(spec: TextStep): OwnedChange {
  const base = {
    path: spec.path,
    binary: false,
    meta: {},
    ...(spec.group === undefined ? {} : { group: spec.group }),
  };
  if (spec.before === undefined) {
    return { ...base, kind: 'create', after: reader(spec.after ?? ''), mode: '100644' };
  }
  if (spec.after === undefined) {
    return { ...base, kind: 'delete', before: reader(spec.before), previousMode: '100644' };
  }
  return {
    ...base,
    kind: 'modify',
    before: reader(spec.before),
    after: reader(spec.after),
    previousMode: '100644',
    mode: '100644',
  };
}

function lines(text: string): string[] {
  return text === '' ? [] : text.replace(/\n$/, '').split('\n');
}

/** A line diff by longest common subsequence: `' '`, `'-'` or `'+'` per line. */
function lineDiff(old: string[], next: string[]): string[] {
  const table = Array.from({ length: old.length + 1 }, () =>
    new Array<number>(next.length + 1).fill(0)
  );
  for (let i = old.length - 1; i >= 0; i--) {
    for (let j = next.length - 1; j >= 0; j--) {
      const row = table[i] ?? [];
      row[j] =
        old[i] === next[j]
          ? (table[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(table[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: string[] = [];
  let [i, j] = [0, 0];
  while (i < old.length || j < next.length) {
    if (i < old.length && j < next.length && old[i] === next[j]) {
      out.push(` ${old[i++] ?? ''}`);
      j++;
    } else if (
      j < next.length &&
      (i === old.length || (table[i]?.[j + 1] ?? 0) >= (table[i + 1]?.[j] ?? 0))
    ) {
      out.push(`+${next[j++] ?? ''}`);
    } else {
      out.push(`-${old[i++] ?? ''}`);
    }
  }
  return out;
}

async function text(read: () => Promise<Uint8Array>): Promise<string> {
  return new TextDecoder().decode(await read());
}

/** A unified diff of one change, as a provider would produce it. */
async function unifiedDiff(change: OwnedChange): Promise<string> {
  const before = change.kind === 'create' ? '' : await text(change.before);
  const after = change.kind === 'delete' ? '' : await text(change.after);
  const [old, next] = [lines(before), lines(after)];
  const header = [`diff --git a/${change.path} b/${change.path}`];
  if (change.kind === 'create') header.push('new file mode 100644');
  if (change.kind === 'delete') header.push('deleted file mode 100644');
  header.push(change.kind === 'create' ? '--- /dev/null' : `--- a/${change.path}`);
  header.push(change.kind === 'delete' ? '+++ /dev/null' : `+++ b/${change.path}`);
  const range = (count: number): string => `${count === 0 ? 0 : 1},${count}`;
  return [
    ...header,
    `@@ -${range(old.length)} +${range(next.length)} @@`,
    ...lineDiff(old, next),
    '',
  ].join('\n');
}

/**
 * A change set from text steps, with a diff provider.
 *
 * @param steps - The steps
 * @param groups - Group IDs, or full groups, in application order
 */
export function textChangeSet(
  steps: readonly TextStep[],
  groups: readonly (string | ChangeGroup)[] = []
): ChangeSet {
  return createChangeSet({
    groups: groups.map((group) => (typeof group === 'string' ? { id: group, meta: {} } : group)),
    changes: steps.map(step),
    diff: unifiedDiff,
  });
}

/** An engine reader over a table of engine-relative paths and their text. */
export function engineFiles(files: Readonly<Record<string, string>> = {}): {
  read(path: string): Promise<Uint8Array | undefined>;
} {
  return {
    read: (path) =>
      Promise.resolve(Object.hasOwn(files, path) ? encoder.encode(files[path]) : undefined),
  };
}
