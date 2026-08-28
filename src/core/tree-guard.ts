// SPDX-License-Identifier: EUPL-1.2
/**
 * Read-only guard for verification trees.
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
import {
  getTreeMarkerPath,
  readTreeMarker,
  type TreeMarker,
  type TreeMarkerRead,
} from './tree-store.js';

/**
 * Per-command verdicts. `allowed` runs unconditionally; `refused` never
 * runs in a tree; `conditional` consults `TREE_CONDITIONAL_CHECKS` with
 * the invoked subcommand chain, parsed options, and the tree marker.
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
  're-export': 'conditional',
  patch: 'refused',
  rebase: 'refused',
  package: 'refused',
  watch: 'refused',
  // Build-less runs only, and only in trees whose marker records a cloned
  // (mozinfo-rewritten) objdir — see the conditional check below.
  test: 'conditional',
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
  'config (read), export --dry-run, export-all --dry-run, re-export --dry-run, and — ' +
  'in trees created with --with-objdir — build-less test.';

interface ConditionalInput {
  /** Subcommand chain below the top-level command (e.g. ['staged-dependency']). */
  subcommands: readonly string[];
  /** Merged options of the ACTION command (leaf). */
  options: Readonly<Record<string, unknown>>;
  /** Positional args of the action command. */
  args: readonly unknown[];
}

const TREE_CONDITIONAL_CHECKS: Readonly<
  Record<string, (input: ConditionalInput, marker: TreeMarker) => boolean>
> = {
  // Exports write patches/ + patches.json; only the dry-run preview is a read.
  export: ({ options }) => options['dryRun'] === true,
  'export-all': ({ options }) => options['dryRun'] === true,
  // Same rule for refreshing existing patches: the dry-run projection is a
  // read (proven side-effect free and runtime-enforced by
  // withDryRunPurityGuard); a real re-export writes patches/.
  're-export': ({ options }) => options['dryRun'] === true,
  // `config` with no positional value prints; with a value it writes.
  config: ({ args }) => args.filter((a) => typeof a === 'string').length <= 1,
  // Doctor reads unless a repair flag is set.
  doctor: ({ options }) => options['repairFurnace'] !== true && options['fix'] !== true,
  // Build-less test needs the objdir the marker records as cloned,
  // mozinfo-rewritten AND reconfigured in-tree; `test --build` rebuilds
  // the engine and stays primary-only (a tree is a snapshot with no
  // merge-back model, so build outputs mutated in-tree go nowhere).
  test: ({ options }, marker) => marker.clonedObjdir !== undefined && options['build'] !== true,
  // No tree lifecycle inside a tree; `tree list` is the only read.
  tree: ({ subcommands }) => subcommands[0] === 'list',
};

/**
 * Command-specific refusal hints appended after the generic sentence —
 * for verdicts where "mutates project or engine state" alone would
 * misdiagnose the actual reason.
 */
const TREE_REFUSAL_HINTS: Readonly<
  Record<string, (input: ConditionalInput, marker: TreeMarker) => string | undefined>
> = {
  test: ({ options }, marker) => {
    if (options['build'] === true) {
      return '"test --build" rebuilds the engine and must run in the primary tree; run build-less "fireforge test" here instead.';
    }
    if (marker.clonedObjdir === undefined) {
      return 'In-tree test requires a tree created with "fireforge tree create <name> --with-objdir".';
    }
    return undefined;
  },
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
  if (verdict === 'conditional' && conditional && conditional(input, marker)) return;

  const hint = TREE_REFUSAL_HINTS[commandName]?.(input, marker);
  throw new GeneralError(
    `This is a FireForge verification tree ("${marker.name}", created from ${marker.primaryRoot}). ` +
      `"${[commandName, ...input.subcommands].join(' ')}" mutates project or engine state and must run in the primary tree. ` +
      (hint === undefined ? '' : `${hint} `) +
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
    // eslint-disable-next-line fireforge/no-untyped-json-document -- structural slice of commander's `Command`; its `optsWithGlobals()` returns the untyped OptionValues bag, mirrored here rather than invented
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

  const options = actionCommand.optsWithGlobals();
  const located = await (async (): Promise<{ root: string; state: TreeMarkerRead } | undefined> => {
    let current = resolve(process.cwd());
    for (let depth = 0; depth < 50; depth++) {
      if (existsSync(join(current, 'fireforge.json'))) {
        return { root: current, state: await readTreeMarker(current) };
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return undefined;
  })();

  if (located === undefined) return;
  const state = located.state;
  if (state.kind === 'absent') return;

  // A marker we cannot read is not evidence that this is not a tree — it is
  // evidence that we cannot tell. Treating it as "not a tree" would grant the
  // full mutating command set to a snapshot on the strength of a file that
  // failed to parse, which is exactly backwards for a default-deny guard.
  // A marker from a NEWER FireForge is not damaged, so the corrupt branch's
  // remedies — recreate the tree, delete the stray marker — are actively
  // wrong for it. Refuse with the upgrade instruction instead, and do NOT
  // offer --ignore-corrupt-tree-marker: proceeding would mean acting on a
  // marker whose fields this build does not understand.
  if (state.kind === 'unsupported') {
    if (TREE_COMMAND_VERDICTS[commandName] === 'allowed') return;
    throw new GeneralError(
      `Refusing "${[commandName, ...subcommands].join(' ')}": ${state.reason}`
    );
  }

  if (state.kind === 'corrupt') {
    if (options['ignoreCorruptTreeMarker'] === true) return;
    // Unconditionally-allowed commands never consult marker fields — their
    // verdict is the same in every tree — so an unreadable marker cannot
    // change their answer. Letting them through keeps read-only diagnostics
    // (status, lint) usable on the very tree the operator needs to inspect.
    // 'conditional' verdicts stay refused: their predicates can write.
    if (TREE_COMMAND_VERDICTS[commandName] === 'allowed') return;
    const markerPath = getTreeMarkerPath(located.root);
    throw new GeneralError(
      `${markerPath} identifies this directory as a FireForge verification tree, but ${state.reason}. ` +
        `Refusing "${[commandName, ...subcommands].join(' ')}" because it cannot be established ` +
        'whether this is a snapshot or the primary tree.\n\n' +
        'Recreate the tree (fireforge tree remove <name> && fireforge tree create <name>), or — if ' +
        'this really is the primary tree — delete the stray marker. ' +
        'Pass --ignore-corrupt-tree-marker to proceed anyway.'
    );
  }

  enforceTreeGuard(state.marker, commandName, {
    subcommands,
    options,
    args: actionCommand.args,
  });
}
