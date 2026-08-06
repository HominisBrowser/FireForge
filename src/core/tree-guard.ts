// SPDX-License-Identifier: EUPL-1.2
/**
 * Read-only guard for verification trees (FORGE G15).
 *
 * A tree is a snapshot: its `patches/` and `components/` are copies with
 * no merge-back model, so any command that mutates project or engine
 * state must run in the primary tree. Enforcement is DEFAULT-DENY via an
 * explicit verdict table over every top-level command — a newly added
 * command is refused inside trees until its author classifies it (the
 * drift test in `tree-guard.test.ts` fails otherwise) — and lives in ONE
 * commander `preAction` hook installed by `createProgram()`, so the
 * guard fires no matter how the cwd ended up inside a tree (`tree exec`
 * or a plain `cd`).
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { readTreeMarker, type TreeMarker } from './tree-store.js';

/**
 * Per-command verdicts. `allowed` runs unconditionally; `refused` never
 * runs in a tree; `conditional` consults `TREE_CONDITIONAL_CHECKS` with
 * the invoked subcommand chain and parsed options.
 */
export const TREE_COMMAND_VERDICTS: Readonly<
  Record<string, 'allowed' | 'refused' | 'conditional'>
> = {
  setup: 'refused',
  source: 'refused',
  download: 'refused',
  bootstrap: 'refused',
  import: 'refused',
  resolve: 'refused',
  build: 'refused',
  run: 'refused',
  status: 'allowed',
  reset: 'refused',
  discard: 'refused',
  export: 'conditional',
  'export-all': 'conditional',
  're-export': 'refused',
  patch: 'refused',
  rebase: 'refused',
  package: 'refused',
  watch: 'refused',
  // Deferred with the objdir clone: obj-* embeds absolute primary paths.
  test: 'refused',
  config: 'conditional',
  doctor: 'conditional',
  register: 'refused',
  wire: 'refused',
  token: 'refused',
  lint: 'allowed',
  typecheck: 'allowed',
  verify: 'allowed',
  furnace: 'refused',
  // No nesting; `tree list` inside a tree is pointless but harmless — the
  // subcommand check below allows only `list`.
  tree: 'conditional',
};

/** The command set named in refusal messages. */
const ALLOWED_SUMMARY =
  'Verification trees support: status, lint, typecheck, verify, doctor (read-only), ' +
  'config (read), export --dry-run, and export-all --dry-run.';

interface ConditionalInput {
  /** Subcommand chain below the top-level command (e.g. ['staged-dependency']). */
  subcommands: readonly string[];
  /** Merged options of the ACTION command (leaf). */
  options: Readonly<Record<string, unknown>>;
  /** Positional args of the action command. */
  args: readonly unknown[];
}

const TREE_CONDITIONAL_CHECKS: Readonly<Record<string, (input: ConditionalInput) => boolean>> = {
  // Exports write patches/ + patches.json; only the dry-run preview is a read.
  export: ({ options }) => options['dryRun'] === true,
  'export-all': ({ options }) => options['dryRun'] === true,
  // `config` with no positional value prints; with a value it writes.
  config: ({ args }) => args.filter((a) => typeof a === 'string').length <= 1,
  // Doctor reads unless a repair flag is set.
  doctor: ({ options }) => options['repairFurnace'] !== true && options['fix'] !== true,
  // No tree lifecycle inside a tree; `tree list` is the only read.
  tree: ({ subcommands }) => subcommands[0] === 'list',
};

/**
 * Throws when `commandName` (with its subcommand chain and options) must
 * not run inside the tree described by `marker`. Exported for the
 * preAction hook in cli.ts and for the guard tests.
 */
export function enforceTreeGuard(
  marker: TreeMarker,
  commandName: string,
  input: ConditionalInput
): void {
  const verdict = TREE_COMMAND_VERDICTS[commandName] ?? 'refused';
  if (verdict === 'allowed') return;
  const conditional = TREE_CONDITIONAL_CHECKS[commandName];
  if (verdict === 'conditional' && conditional && conditional(input)) return;

  throw new GeneralError(
    `This is a FireForge verification tree ("${marker.name}", created from ${marker.primaryRoot}). ` +
      `"${[commandName, ...input.subcommands].join(' ')}" mutates project or engine state and must run in the primary tree. ` +
      ALLOWED_SUMMARY
  );
}

/**
 * Commander preAction hook body: locates the enclosing tree (if any) and
 * enforces the verdict table for the invoked command chain.
 */
export async function runTreeGuardHook(
  rootCommandName: string | undefined,
  actionCommand: {
    name: () => string;
    optsWithGlobals: () => Record<string, unknown>;
    args: unknown[];
    parent: { name: () => string; parent: unknown } | null;
  }
): Promise<void> {
  // Resolve the top-level command and subcommand chain from the action
  // command's parent links (commander nests subcommands).
  const chain: string[] = [];
  let node: { name: () => string; parent: unknown } | null = actionCommand;
  while (node && node.parent) {
    chain.unshift(node.name());
    node = node.parent as { name: () => string; parent: unknown } | null;
  }
  const [commandName, ...subcommands] = chain;
  if (commandName === undefined || commandName === rootCommandName) return;

  const marker = await (async () => {
    let current = resolve(process.cwd());
    for (let depth = 0; depth < 50; depth++) {
      if (existsSync(join(current, 'fireforge.json'))) {
        return readTreeMarker(current);
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return undefined;
  })();
  if (!marker) return;

  enforceTreeGuard(marker, commandName, {
    subcommands,
    options: actionCommand.optsWithGlobals(),
    args: actionCommand.args,
  });
}
