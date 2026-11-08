// SPDX-License-Identifier: EUPL-1.2
import { assertFullCheckArguments } from './check-arguments.js';

interface AdapterArguments {
  command: string;
  args: string[];
}

interface AdapterOptions {
  boolean: readonly string[];
  valued: readonly string[];
  /** Options whose value may be absent. */
  optional?: readonly string[];
  /** Accepts one positional, or rejects with a reason. */
  positional: (arg: string) => boolean;
}

const anyPath = (): boolean => true;
const noPositional = (): boolean => false;
const FURNACE_ACTIONS = ['apply', 'deploy', 'sync', 'validate', 'status', 'list', 'scan', 'diff'];

/** Options every adapter understands and that say nothing about what the step does. */
const UNIVERSAL_BOOLEAN = ['--json'];
const UNIVERSAL_VALUED = ['--wait-lock'];

/**
 * The closed option set of every adapter. A receipt stating that a command
 * passed has to mean it did the work: `--help`, stale-build bypasses, foreign
 * logs and arbitrary mach inputs never reach a step.
 */
const ADAPTERS: Readonly<Record<string, AdapterOptions>> = {
  'qualify-native': { boolean: [], valued: [], positional: noPositional },
  test: {
    boolean: [
      '--headless',
      '--full-output',
      '--build',
      '--build-only',
      '--refuse-unexported-drift',
      '--no-shard',
      '--restart-between-tests',
      '--auto-ports',
      '--extend-coverage',
      '--no-furnace-apply',
    ],
    valued: [
      '--repeat',
      '--negative-control',
      '--jobs',
      '--shard-size',
      '--harness-retries',
      '--furnace-apply',
      '--coverage',
      '--keep-log',
      '--pgid-file',
      '--perf-samples',
      '--marionette-port',
      '--profile-file',
    ],
    optional: ['--wait-browser', '--wait-port', '--shuffle'],
    positional: anyPath,
  },
  run: {
    boolean: [
      '--headless',
      '--temp-profile',
      '--no-purge-caches',
      '-marionette',
      '-remote-allow-system-access',
      '-no-remote',
    ],
    valued: [
      '--smoke-exit',
      '--console-allow',
      '--console-allow-file',
      '--capture-console',
      '--profile',
      '--screenshot',
      '--window-size',
    ],
    positional: (arg) => /^(?:about:|chrome:\/\/|resource:\/\/)/.test(arg),
  },
  build: {
    boolean: ['--ui', '--rewrite-mozinfo', '--refuse-unexported-drift'],
    valued: ['--jobs', '-j', '--brand', '--keep-log'],
    optional: ['--wait-browser'],
    positional: noPositional,
  },
  package: { boolean: [], valued: ['--brand', '--recipe'], positional: noPositional },
  lint: {
    boolean: ['--only-introduced', '--per-patch', '--no-cache'],
    valued: ['--since', '--patches', '--max-warnings', '--report', '--notices'],
    positional: anyPath,
  },
  typecheck: {
    boolean: [],
    valued: ['--project', '--source-files', '--explain'],
    positional: anyPath,
  },
  verify: { boolean: [], valued: ['--patches'], positional: anyPath },
  status: {
    boolean: [
      '--raw',
      '--lock',
      '--unmanaged',
      '--ownership',
      '--test-coverage',
      '--summary',
      '--include-ownership',
      '--check',
      '--fail-on-unknown',
    ],
    valued: ['--fail-on', '--allow', '--patches'],
    positional: noPositional,
  },
  furnace: {
    boolean: ['--force', '--skip-validate', '--dry-run', '--deep'],
    valued: ['--max-warnings'],
    positional: anyPath,
  },
};

/**
 * The one form of `--mach-arg` a job can hold: a pref, with a value that is no path.
 * It is all a real project's gate forwards. Any other Mach argument can select a
 * log, a profile, an environment or a test set behind the roster's back. Marionette's
 * prefs stay out because the executor allocates its port.
 */
const SAFE_MACH_ARGUMENT = /^--setpref=([A-Za-z][A-Za-z0-9_.-]*)=[A-Za-z0-9_.:+,@%-]*$/;

function assertSafeMachArgument(value: string | undefined): void {
  const pref = SAFE_MACH_ARGUMENT.exec(value ?? '')?.[1];
  if (pref === undefined || pref.startsWith('marionette.'))
    throw new Error(
      `Unsupported immutable-job option: --mach-arg ${value ?? ''}; only --setpref=<name>=<value> is admitted, outside marionette.*`
    );
}

/** Whether the option takes a value, given the adapter's table. */
function optionKind(
  table: AdapterOptions,
  option: string
): 'boolean' | 'valued' | 'optional' | undefined {
  if (table.boolean.includes(option) || UNIVERSAL_BOOLEAN.includes(option)) return 'boolean';
  if (table.valued.includes(option) || UNIVERSAL_VALUED.includes(option)) return 'valued';
  if (table.optional?.includes(option)) return 'optional';
  return undefined;
}

/** Walks an adapter's arguments, yielding each positional. Throws on any option outside the table. */
function* walkArguments(step: AdapterArguments, table: AdapterOptions): Generator<string> {
  for (let index = 0; index < step.args.length; index += 1) {
    const arg = step.args[index] ?? '';
    if (!arg.startsWith('-')) {
      yield arg;
      continue;
    }
    if (arg === '--' && step.command === 'run') continue;
    if (/^-j\d+$/.test(arg) && table.valued.includes('-j')) continue;
    const option = arg.split('=')[0] ?? '';
    if (option === '--mach-arg' && step.command === 'test') {
      assertSafeMachArgument(arg === option ? step.args[++index] : arg.slice(option.length + 1));
      continue;
    }
    const kind = optionKind(table, option);
    if (kind === undefined)
      throw new Error(
        `Unsupported immutable-job option: ${arg}; use a typed captured input/adapter instead`
      );
    if (arg.includes('=') || kind === 'boolean') continue;
    if (kind === 'optional') {
      if (/^\d+$/.test(step.args[index + 1] ?? '')) index += 1;
      continue;
    }
    const value = step.args[++index];
    if (!value || value.startsWith('--'))
      throw new Error(`Missing admitted option value: ${option}`);
  }
}

/** Closed adapter flags exclude stale-build bypasses, arbitrary mach inputs and foreign raw logs. */
export function validateAdapterArguments(step: AdapterArguments): void {
  if (step.command === 'check') {
    assertFullCheckArguments(step.args);
    return;
  }
  const table = ADAPTERS[step.command];
  if (table === undefined) throw new Error(`Unsupported job adapter: ${step.command}`);
  let first = true;
  for (const positional of walkArguments(step, table)) {
    if (step.command === 'furnace' && first && !FURNACE_ACTIONS.includes(positional))
      throw new Error(`Unsupported furnace job action: ${positional}`);
    if (!table.positional(positional))
      throw new Error(
        step.command === 'run'
          ? 'Run positional inputs require a typed captured adapter'
          : `Unsupported positional argument for ${step.command}: ${positional}`
      );
    first = false;
  }
  if (step.command === 'furnace' && first)
    throw new Error(`A furnace job names its action: ${FURNACE_ACTIONS.join(', ')}`);
  if (adapterOptionValues(step, '--recipe').some((recipe) => recipe !== 'release'))
    throw new Error('The only package recipe is release');
}

/** The positional arguments of a step, never mistaking an option's value for one. */
export function adapterPositionals(step: AdapterArguments): string[] {
  const table = ADAPTERS[step.command];
  return table === undefined ? [] : [...walkArguments(step, table)];
}

/** Extract repeatable values without confusing source=destination with --option=value. */
export function adapterOptionValues(step: AdapterArguments, option: string): string[] {
  return step.args.flatMap((arg, index) =>
    arg === option
      ? [step.args[index + 1] ?? '']
      : arg.startsWith(`${option}=`)
        ? [arg.slice(option.length + 1)]
        : []
  );
}
