// SPDX-License-Identifier: EUPL-1.2
/**
 * Random sequences of queue operations on a small queue whose patches
 * overlap: after every operation the queue verifies clean, an operation that
 * only moves work around leaves the produced tree identical, and a refused
 * operation leaves the queue byte for byte as it was.
 */
import { describe, expect, it } from 'vitest';

import { FireForgeError } from '../kernel/errors.js';
import type { PatchProject } from '../project/index.js';
import { createPatchProject } from '../testing/patch-project.js';
import { readTree, useTempDir } from '../testing/temp.js';
import {
  compactQueue,
  deletePatch,
  moveFiles,
  type Placement,
  type QueuePatch,
  renamePatch,
  reorderPatch,
  replayQueue,
  setPatchMeta,
  splitPatch,
  verifyQueue,
} from './index.js';
import { loadQueue } from './queue.js';

const dir = useTempDir();
const A = 'browser/components/a/a.mjs';
const A_CSS = 'browser/components/a/a.css';
const B = 'browser/components/b/b.mjs';
const C = 'browser/components/c/c.mjs';
const BROWSER = 'browser/base/content/browser.js';

/** Refusals an operation may legitimately end in. */
const REFUSALS = new Set([
  'queue-operation-conflict',
  'patch-split-all',
  'patch-has-dependents',
  'invalid-argument',
]);

const lines = (edit: (copy: string[]) => void): string => {
  const copy = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
  edit(copy);
  return `${copy.join('\n')}\n`;
};

/** A small deterministic generator (mulberry32). */
function random(seed: number): (below: number) => number {
  let state = seed;
  return (below) => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * below);
  };
}

interface Step {
  readonly label: string;
  /** Moves work around only, so the produced tree must not change. */
  readonly preserving: boolean;
  run(project: PatchProject): Promise<unknown>;
}

function pick<T>(next: (below: number) => number, items: readonly T[]): T {
  const item = items[next(items.length)];
  if (item === undefined) throw new Error('pick from an empty list');
  return item;
}

function placementFor(next: (below: number) => number, others: readonly QueuePatch[]): Placement {
  const kind = next(3);
  if (kind === 0 || others.length === 0) return { order: 1 + next(12) };
  const anchor = pick(next, others).name;
  return kind === 1 ? { before: anchor } : { after: anchor };
}

function stepFor(next: (below: number) => number, patches: readonly QueuePatch[], n: number): Step {
  const patch = pick(next, patches);
  const others = patches.filter((other) => other !== patch);
  switch (next(9)) {
    case 0:
      return {
        label: `rename ${patch.name}`,
        preserving: true,
        run: (project) => renamePatch(project, patch.name, `ui-r${n}`),
      };
    case 1: {
      const placement = placementFor(next, others);
      return {
        label: `reorder ${patch.name} ${JSON.stringify(placement)}`,
        preserving: true,
        run: (project) => reorderPatch(project, patch.name, placement),
      };
    }
    case 2: {
      const file = pick(next, patch.files);
      const placement = next(2) === 0 ? undefined : placementFor(next, others);
      return {
        label: `split ${file} out of ${patch.name} ${JSON.stringify(placement)}`,
        preserving: true,
        run: (project) =>
          splitPatch(project, patch.name, {
            files: [file],
            name: `ui-s${n}`,
            ...(placement === undefined ? {} : { placement }),
          }),
      };
    }
    case 3:
    case 4:
    case 5: {
      const file = pick(next, patch.files);
      const target = others.length === 0 ? patch : pick(next, others);
      return {
        label: `move ${file} from ${patch.name} to ${target.name}`,
        preserving: true,
        run: (project) => moveFiles(project, patch.name, target.name, [file]),
      };
    }
    case 6:
      return { label: 'compact', preserving: true, run: (project) => compactQueue(project) };
    case 7:
      return {
        label: `describe ${patch.name}`,
        preserving: true,
        run: (project) => setPatchMeta(project, patch.name, { description: `step ${n}` }),
      };
    default:
      return {
        label: `delete ${patch.name}`,
        preserving: false,
        run: (project) => deletePatch(project, patch.name),
      };
  }
}

describe('random queue operations', () => {
  it.each([7, 1234])(
    'keep the queue sound and the result unchanged (seed %i)',
    async (seed) => {
      const fixture = await createPatchProject(dir());
      await fixture.addPatch('ui-a', { [A]: lines(() => undefined), [A_CSS]: '.a {}\n' });
      await fixture.addPatch('ui-b', {
        [A]: lines((copy) => (copy[24] = 'b')),
        [B]: 'export const b = 1;\n',
      });
      await fixture.addPatch('ui-c', {
        [C]: 'export const c = 1;\n',
        [BROWSER]: 'export const browserTitle = "c";\n',
      });
      await fixture.addPatch('ui-d', {
        [A]: lines((copy) => {
          copy[2] = 'd';
          copy[24] = 'b';
        }),
        [C]: 'export const c = 2;\n',
      });
      const next = random(seed);
      const project = await fixture.project();
      const log: string[] = [];
      for (let n = 0; n < 16; n++) {
        const patches = (await loadQueue(project)).patches;
        if (patches.length < 2) break;
        const step = stepFor(next, patches, n);
        const before = await readTree(fixture.patches);
        const tree = await replayQueue(fixture.engine, 'HEAD', fixture.patches);
        try {
          await step.run(project);
          log.push(`ok ${step.label}`);
        } catch (error: unknown) {
          if (!(error instanceof FireForgeError) || !REFUSALS.has(error.code)) throw error;
          log.push(`refused ${step.label}: ${error.code}`);
          expect(await readTree(fixture.patches), log.join('\n')).toEqual(before);
          continue;
        }
        expect((await verifyQueue(project)).problems, log.join('\n')).toEqual([]);
        if (step.preserving) {
          expect(await replayQueue(fixture.engine, 'HEAD', fixture.patches), log.join('\n')).toBe(
            tree
          );
        }
      }
      expect(log.some((entry) => entry.startsWith('ok'))).toBe(true);
    },
    240_000
  );
});
