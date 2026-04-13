// SPDX-License-Identifier: EUPL-1.2
import { FurnaceError } from '../errors/furnace.js';
import type { CustomComponentConfig, FurnaceConfig } from '../types/furnace.js';

/** Throws a {@link FurnaceError} if the composes graph among custom components contains a cycle. */
export function detectComposesCycles(custom: FurnaceConfig['custom']): void {
  const visited = new Set<string>();
  const stack = new Set<string>();

  function visit(name: string, path: string[]): void {
    if (stack.has(name)) {
      const cycle = [...path.slice(path.indexOf(name)), name];
      throw new FurnaceError(
        `Furnace config: circular composes dependency detected: ${cycle.join(' → ')}`
      );
    }
    if (visited.has(name)) return;

    stack.add(name);
    path.push(name);

    const deps = custom[name]?.composes;
    if (deps) {
      for (const dep of deps) {
        if (dep in custom) {
          visit(dep, path);
        }
      }
    }

    path.pop();
    stack.delete(name);
    visited.add(name);
  }

  for (const name of Object.keys(custom)) {
    visit(name, []);
  }
}

/** Validates that every `composes` reference in custom components points to a known component. */
export function validateComposesReferences(
  stock: string[],
  overrides: FurnaceConfig['overrides'],
  custom: FurnaceConfig['custom']
): void {
  const known = new Set([...stock, ...Object.keys(overrides), ...Object.keys(custom)]);

  for (const [name, config] of Object.entries(custom)) {
    if (!config.composes) continue;
    for (const ref of config.composes) {
      if (!known.has(ref)) {
        throw new FurnaceError(
          `Furnace config: custom "${name}" composes unknown component "${ref}". ` +
            'The referenced component must be registered as stock, override, or custom.'
        );
      }
    }
  }
}

/**
 * Returns custom component names in topological order so that components
 * depended upon via `composes` are applied before those that compose them.
 * Falls back to insertion order when there are no composes edges.
 */
export function topologicalSortCustom(custom: Record<string, CustomComponentConfig>): string[] {
  const names = Object.keys(custom);
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const name of names) {
    inDegree.set(name, 0);
    dependents.set(name, []);
  }

  for (const [name, config] of Object.entries(custom)) {
    if (!config.composes) continue;
    for (const dep of config.composes) {
      if (dep in custom) {
        inDegree.set(name, (inDegree.get(name) ?? 0) + 1);
        dependents.get(dep)?.push(name);
      }
    }
  }

  const queue = names.filter((n) => (inDegree.get(n) ?? 0) === 0);
  const sorted: string[] = [];

  while (queue.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by while condition
    const current = queue.shift()!;
    sorted.push(current);
    for (const dep of dependents.get(current) ?? []) {
      const newDegree = (inDegree.get(dep) ?? 1) - 1;
      inDegree.set(dep, newDegree);
      if (newDegree === 0) {
        queue.push(dep);
      }
    }
  }

  // If a cycle was somehow missed by config validation, fall back to insertion order
  // for any nodes not reached.
  if (sorted.length < names.length) {
    for (const name of names) {
      if (!sorted.includes(name)) {
        sorted.push(name);
      }
    }
  }

  return sorted;
}
