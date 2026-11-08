// SPDX-License-Identifier: EUPL-1.2
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { ConfigError } from '../errors/config.js';
import { getNodeErrorCode, toError } from '../utils/errors.js';
import { isObject } from '../utils/validation.js';
import { assertExecutorCommand, coordinatorNamespace } from './jobs/guard.js';

type Policy = 'legacy-only' | 'editor' | 'executor' | 'conditional';
type Access = 'read' | 'editor' | 'executor' | 'refused';

/** Every top-level command is classified; additions default-deny until this policy is reviewed. */
export const SOURCE_COMMAND_POLICIES: Readonly<Record<string, Policy>> = {
  setup: 'legacy-only',
  source: 'legacy-only',
  authored: 'conditional',
  host: 'conditional',
  slot: 'conditional',
  job: 'conditional',
  prove: 'conditional',
  download: 'legacy-only',
  bootstrap: 'legacy-only',
  import: 'legacy-only',
  resolve: 'legacy-only',
  build: 'executor',
  run: 'executor',
  status: 'executor',
  reset: 'legacy-only',
  discard: 'legacy-only',
  export: 'legacy-only',
  'export-all': 'legacy-only',
  're-export': 'legacy-only',
  park: 'legacy-only',
  patch: 'legacy-only',
  rebase: 'legacy-only',
  package: 'executor',
  watch: 'legacy-only',
  test: 'executor',
  tree: 'conditional',
  config: 'conditional',
  doctor: 'conditional',
  register: 'editor',
  wire: 'editor',
  token: 'conditional',
  lint: 'executor',
  typecheck: 'executor',
  verify: 'executor',
  check: 'executor',
  furnace: 'conditional',
};

interface GuardInput {
  subcommands: readonly string[];
  options: Readonly<Record<string, unknown>>;
  args: readonly unknown[];
}

/** Explicit leaf operations prevent a new nested mutator inheriting a read-only parent's access. */
export const SOURCE_SUBCOMMAND_ACCESS: Readonly<Record<string, Readonly<Record<string, Access>>>> =
  {
    authored: {
      delta: 'read',
      validate: 'read',
      status: 'editor',
      capture: 'editor',
      lint: 'editor',
      typecheck: 'editor',
      verify: 'editor',
      override: 'editor',
      'restore-upstream': 'editor',
      'merge-driver': 'editor',
      'merge-install': 'editor',
      migrate: 'editor',
      'export-queue': 'editor',
      materialize: 'editor',
      refresh: 'editor',
      prune: 'editor',
      'pristine fetch': 'editor',
    },
    host: { init: 'editor' },
    slot: {
      list: 'read',
      audit: 'editor',
      create: 'editor',
      prepare: 'editor',
      remove: 'editor',
      restore: 'editor',
      'qualify-native': 'editor',
      'refresh-deps': 'editor',
    },
    job: {
      status: 'read',
      logs: 'read',
      wait: 'read',
      list: 'read',
      submit: 'editor',
      run: 'editor',
      cancel: 'editor',
      'host-clear': 'editor',
    },
    prove: {
      run: 'editor',
      plan: 'editor',
      status: 'editor',
      accept: 'editor',
      waive: 'editor',
      publish: 'editor',
      'measure-tools': 'read',
    },
    tree: { list: 'read', create: 'refused', remove: 'refused', exec: 'refused' },
    token: {
      '': 'read',
      list: 'read',
      show: 'read',
      lint: 'read',
      coverage: 'read',
      add: 'editor',
    },
    furnace: {
      '': 'read',
      status: 'read',
      scan: 'refused',
      list: 'read',
      diff: 'read',
      validate: 'read',
      create: 'editor',
      override: 'refused',
      init: 'editor',
      remove: 'editor',
      rename: 'editor',
      refresh: 'refused',
      'chrome-doc create': 'editor',
      'chrome-doc remove': 'editor',
      apply: 'executor',
      deploy: 'executor',
      sync: 'executor',
      types: 'editor',
      preview: 'refused',
    },
  };

function commandAccess(command: string, input: GuardInput): Access {
  const policy = SOURCE_COMMAND_POLICIES[command];
  if (policy === 'editor' || policy === 'executor') return policy;
  if (policy !== 'conditional') return 'refused';
  if (command === 'config') {
    const args = input.args.filter((arg): arg is string => typeof arg === 'string');
    if (args.length <= 1) return 'read';
    return /^(?:firefox|sources)(?:\.|$)/.test(args[0]?.trim() ?? '') ? 'refused' : 'editor';
  }
  if (command === 'doctor')
    return Object.keys(input.options).some(
      (key) =>
        /^(?:repair|clear)|^fix$/.test(key) &&
        input.options[key] !== undefined &&
        input.options[key] !== false
    )
      ? 'refused'
      : 'read';
  if (command === 'furnace' && input.subcommands[0] === 'validate' && input.options['fix'] === true)
    return 'executor';
  if (command === 'furnace' && input.subcommands[0] === 'types' && input.options['check'] === true)
    return 'read';
  return SOURCE_SUBCOMMAND_ACCESS[command]?.[input.subcommands.join(' ')] ?? 'refused';
}

interface SlotIdentity {
  root: string;
  id: string;
  valid: boolean;
}
interface Context {
  root?: string;
  source: boolean;
  slot?: SlotIdentity;
}

async function optionalFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(getNodeErrorCode(error) ?? '')) return undefined;
    throw error;
  }
}

/** Canonicalize existing ancestors without creating output paths or coordinator state. */
async function physicalPath(path: string): Promise<string> {
  let current = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      return join(await realpath(current), ...suffix.reverse());
    } catch (error) {
      if (getNodeErrorCode(error) !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.push(basename(current));
      current = parent;
    }
  }
}

async function ownedPrivate(path: string, file = false): Promise<boolean> {
  const metadata = await lstat(path);
  return (
    !metadata.isSymbolicLink() &&
    (file ? metadata.isFile() : metadata.isDirectory()) &&
    metadata.uid === process.getuid?.() &&
    (metadata.mode & 0o077) === 0
  );
}

/** Slot state lives outside captured inputs; aliases and malformed records cannot grant editor access. */
async function slotAt(root: string): Promise<SlotIdentity | undefined> {
  const directory = dirname(root),
    marker = join(directory, 'slot.json');
  const fallback = { root, id: basename(directory), valid: false };
  const reserved = basename(dirname(directory)) === 'slots' && basename(root) === 'root';
  let metadata;
  try {
    metadata = await lstat(marker);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(getNodeErrorCode(error) ?? '')) return undefined;
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) return reserved ? fallback : undefined;
  const bytes = await optionalFile(marker);
  if (bytes === undefined) return reserved ? fallback : undefined;
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    return reserved ? fallback : undefined;
  }
  if (!isObject(value) || value['root'] === undefined) return reserved ? fallback : undefined;
  // An adjacent record for another child is not a marker for this directory.
  if (typeof value['root'] !== 'string') return reserved ? fallback : undefined;
  if ((await physicalPath(value['root'])) !== root) return reserved ? fallback : undefined;
  const valid =
    value['schemaVersion'] === 1 &&
    value['id'] === basename(directory) &&
    (await ownedPrivate(marker, true)) &&
    (await ownedPrivate(directory)) &&
    (await ownedPrivate(dirname(directory))) &&
    (await ownedPrivate(dirname(dirname(directory)))) &&
    (await ownedPrivate(root));
  return valid || reserved ? { root, id: basename(directory), valid } : undefined;
}

async function locateContext(path: string): Promise<Context> {
  let current = await physicalPath(path);
  const context: Context = { source: false };
  for (let depth = 0; depth < 50; depth++) {
    if (context.slot === undefined) {
      const slot = await slotAt(current);
      if (slot !== undefined) context.slot = slot;
    }
    if (context.root === undefined) {
      const bytes = await optionalFile(join(current, 'fireforge.json'));
      if (bytes !== undefined) {
        let document: unknown;
        try {
          document = JSON.parse(bytes.toString('utf8'));
        } catch (error) {
          throw new ConfigError(
            `Cannot establish source mode from ${join(current, 'fireforge.json')}`,
            undefined,
            toError(error)
          );
        }
        if (!isObject(document))
          throw new ConfigError(
            'fireforge.json must be an object before command policy can be established'
          );
        context.root = current;
        context.source = Object.hasOwn(document, 'sources');
      }
    }
    const parent = dirname(current);
    if (parent === current) return context;
    current = parent;
  }
  throw new GeneralError('Cannot establish source/slot command boundary within 50 ancestors');
}

const LEGACY_ALTERNATIVE =
  'Use ordinary Git on tracked source, "fireforge authored capture" to freeze it and "fireforge authored delta" to review it. First upstream edits use "authored override"; restoring pristine content uses "authored restore-upstream". Importing a legacy queue uses "authored migrate" into a separate reviewed migration checkout. Pristine donors come from "authored pristine fetch", and pin changes use the disposable "authored refresh" proposal, never a legacy downloader over source mode. Legacy-only runtime commands have no supported authored executor adapter.';

/** Static checks of captured source: in an editing checkout they run from a private snapshot view. */
const OFF_SLOT_COMMANDS: ReadonlySet<string> = new Set(['status', 'lint', 'typecheck', 'verify']);

function checkReadDescendant(command: string, input: GuardInput): boolean {
  if (process.env['FIREFORGE_ADAPTER_COMMAND'] !== 'check') return false;
  if (
    Object.keys(input.options).some(
      (key) => /^(?:repair|clear)|^fix$/.test(key) && input.options[key] === true
    )
  )
    return false;
  if (['status', 'verify', 'lint', 'typecheck'].includes(command)) return true;
  return (
    command === 'furnace' && input.subcommands.length === 1 && input.subcommands[0] === 'validate'
  );
}

async function admitExecutor(
  command: string,
  root: string,
  slot: SlotIdentity,
  input: GuardInput
): Promise<void> {
  if (
    !slot.valid ||
    (process.env['FIREFORGE_ADAPTER_COMMAND'] !== command && !checkReadDescendant(command, input))
  )
    throw new GeneralError(
      'immutable-execution-slot: a positive slot identity and exact executor command capability are required; submit a captured job from the editing checkout.'
    );
  // This always authenticates by live RPC; no environment-only or unconfigured-host fallback exists.
  await assertExecutorCommand(command, root);
}

/** Options whose value names a file a command writes, by top-level command. */
export const SOURCE_OUTPUT_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  prove: ['namespace'],
  slot: ['namespace'],
  test: ['results', 'coverage', 'keepLog', 'pgidFile', 'perfSamples', 'profileFile'],
  run: ['profile', 'captureConsole'],
  build: ['keepLog'],
  lint: ['report'],
  check: ['lintReport'],
  patch: ['mapOut', 'declarationsOut'],
  're-export': ['declarationsOut'],
};

function destinationKeys(command: string, input: GuardInput): string[] {
  if (command === 'authored')
    return input.subcommands[0] === 'materialize'
      ? ['engine', 'ledger']
      : ['capture', 'refresh', 'migrate', 'export-queue', 'pristine'].includes(
            input.subcommands[0] ?? ''
          )
        ? ['out']
        : [];
  if (command === 'job') return ['namespace'];
  return [...(SOURCE_OUTPUT_OPTIONS[command] ?? [])];
}

/** The written paths an option value names: repeatable values, and `source=destination` pairs. */
function destinationValues(key: string, value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => {
    if (typeof entry !== 'string') return [];
    return key === 'profileFile' ? [entry.slice(entry.indexOf('=') + 1)] : [entry];
  });
}

/** Enforce source editor and immutable runtime boundaries independently of host initialization. */
export async function enforceSourceGuard(
  projectPath: string,
  command: string,
  input: GuardInput
): Promise<void> {
  const context = await locateContext(projectPath);
  const access = commandAccess(command, input);
  for (const key of destinationKeys(command, input)) {
    const value = input.options[key] ?? (key === 'namespace' ? coordinatorNamespace() : undefined);
    for (const destination of destinationValues(key, value)) {
      const target = await locateContext(resolve(destination));
      if (
        target.slot !== undefined &&
        (access !== 'executor' || context.slot?.root !== target.slot.root)
      )
        throw new GeneralError(
          `immutable-execution-slot: --${key} targets slot ${target.slot.id}; write artifacts outside its immutable root.`
        );
      if (command === 'authored' && key === 'engine' && target.source)
        throw new GeneralError(
          'authored materialize requires an explicitly isolated disposable engine outside the source editor; submit a slot job for managed execution.'
        );
      if (
        command === 'authored' &&
        key === 'out' &&
        ['refresh', 'migrate', 'export-queue', 'pristine'].includes(input.subcommands[0] ?? '') &&
        target.root === context.root &&
        context.root !== undefined
      )
        throw new GeneralError(
          'Authored migration, refresh, exported queues and pristine donors require an external disposable directory outside the editing checkout; adoption is a separate reviewed Git operation.'
        );
    }
  }
  if (context.slot !== undefined) {
    if (access === 'read' && checkReadDescendant(command, input))
      return admitExecutor(command, context.root ?? context.slot.root, context.slot, input);
    if (access === 'read') return;
    if (access === 'executor')
      return admitExecutor(command, context.root ?? context.slot.root, context.slot, input);
    throw new GeneralError(
      `immutable-execution-slot: "${[command, ...input.subcommands].join(' ')}" cannot mutate a frozen execution slot. Edit tracked source in its ordinary Git worktree, capture it, and submit a new job.`
    );
  }
  // Legacy projects retain their command set; environment variables alone never make one a slot.
  if (!context.source) return;
  if (access === 'read' || access === 'editor' || OFF_SLOT_COMMANDS.has(command)) return;
  if (access === 'executor')
    throw new GeneralError(
      `authored-proof-needs-slot: "${[command, ...input.subcommands].join(' ')}" requires an admitted immutable execution slot. Use "job run" from this editing checkout; "authored lint", "authored typecheck" and "authored verify" give static feedback without one.`
    );
  throw new GeneralError(
    `source-mode-command-refused: "${[command, ...input.subcommands].join(' ')}" uses legacy mutable engine/queue state. ${LEGACY_ALTERNATIVE}`
  );
}

/** Root CLI preAction hook; its caller uses the normal withErrorHandling machine boundary. */
export async function runSourceGuardHook(
  rootCommandName: string | undefined,
  actionCommand: {
    name: () => string;
    // eslint-disable-next-line fireforge/no-untyped-json-document -- structural Commander OptionValues boundary, identical to the tree guard hook
    optsWithGlobals: () => Record<string, unknown>;
    args: unknown[];
    parent: { name: () => string; parent: unknown } | null;
  }
): Promise<void> {
  const chain: string[] = [];
  let node: { name: () => string; parent: unknown } | null = actionCommand;
  while (node?.parent) {
    chain.unshift(node.name());
    node = node.parent as { name: () => string; parent: unknown } | null;
  }
  const [command, ...subcommands] = chain;
  if (command === undefined || command === rootCommandName) return;
  await enforceSourceGuard(process.cwd(), command, {
    subcommands,
    options: actionCommand.optsWithGlobals(),
    args: actionCommand.args,
  });
}
