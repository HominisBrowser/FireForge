// SPDX-License-Identifier: EUPL-1.2
/** Stands for a step's private output directory. It keeps a declared value portable across jobs. */
export const OUTPUT_PLACEHOLDER = '{artifacts}';

/** Whether a value names a path outside the frozen slot. */
export const escapesSlot = (value: string): boolean =>
  value.startsWith('/') ||
  value.startsWith('~') ||
  /=\//.test(value) ||
  /(^|[=\\/])\.\.([\\/]|$)/.test(value);

/**
 * What judges a step's output once its harness has exited clean: an argument
 * vector, never a shell line, which the executor runs in the same phase. Its
 * nonzero exit is the step's red.
 */
export interface StepValidator {
  /** `node <script> ...`, or a captured script by its path. `{artifacts}` expands in any argument. */
  command: string[];
  /** The host resources it uses at its peak, when more than the step's own. */
  footprint?: { cpu?: number; memory?: number };
}

const positive = (value: unknown): boolean =>
  value === undefined || (Number.isSafeInteger(value) && Number(value) > 0);

/** Refuses anything but a closed command: Node or a captured script, with arguments that stay in the job. */
export function assertStepValidator(raw: unknown): asserts raw is StepValidator {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Step validate must be an object with a command');
  const { command, footprint, ...unknown } = raw as Record<string, unknown>;
  if (Object.keys(unknown).length > 0)
    throw new Error(`Step validate does not take ${Object.keys(unknown).join(', ')}`);
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((arg) => typeof arg !== 'string' || arg === '' || arg.includes('\0'))
  )
    throw new Error('Step validate command must be a non-empty argument array');
  const args = command as string[];
  if (args.some((arg) => escapesSlot(arg.replaceAll(OUTPUT_PLACEHOLDER, 'output'))))
    throw new Error(
      `Step validate names a path outside the job. Use a path relative to the slot, or ${OUTPUT_PLACEHOLDER}`
    );
  const program = args[0] ?? '';
  if (program !== 'node' && !program.includes('/'))
    throw new Error('Step validate runs node or a captured script by its path, not a program name');
  if (program === 'node' && (args[1] === undefined || args[1].startsWith('-')))
    throw new Error('Step validate runs node on a captured script: node <script> [arguments]');
  if (footprint !== undefined) {
    if (footprint === null || typeof footprint !== 'object' || Array.isArray(footprint))
      throw new Error('Step validate footprint must be an object');
    const { cpu, memory, ...others } = footprint as Record<string, unknown>;
    if (Object.keys(others).length > 0 || !positive(cpu) || !positive(memory))
      throw new Error('Step validate footprint takes a positive cpu and memory');
  }
}

/** The captured script a validator runs, which a capture has to hold beside its source. */
export const validatorScript = (validator: StepValidator): string | undefined =>
  validator.command[0] === 'node' ? validator.command[1] : validator.command[0];

const expand = (value: string, output: string | undefined): string =>
  output === undefined ? value : value.replaceAll(OUTPUT_PLACEHOLDER, output);

/** The process to run for a validator: `node` is the Node this phase runs on, so the CLI hook qualifies it. */
export function validatorInvocation(
  validator: StepValidator,
  output: string | undefined
): { command: string; args: string[] } {
  const [program = '', ...args] = validator.command.map((arg) => expand(arg, output));
  return { command: program === 'node' ? process.execPath : program, args };
}

/** The options of each adapter that name a file or directory the step writes. */
const OUTPUT_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  test: ['--perf-samples', '--keep-log', '--coverage', '--pgid-file'],
  run: ['--capture-console', '--screenshot'],
};

const outputOption = (command: string, option: string | undefined): boolean =>
  option !== undefined && (OUTPUT_OPTIONS[command] ?? []).includes(option);

/** The values a step's output options name. */
export const outputOptionValues = (command: string, args: readonly string[]): string[] =>
  args.flatMap((arg, index) =>
    outputOption(command, args[index - 1])
      ? [arg]
      : outputOption(command, arg.split('=')[0]) && arg.includes('=')
        ? [arg.slice(arg.indexOf('=') + 1)]
        : []
  );

/** `--capture-console {artifacts}/x` writes where the job reports, not into the slot's private state. */
export function expandOutputOptions(
  command: string,
  args: readonly string[],
  output: string | undefined
): string[] {
  return args.map((arg, index) =>
    outputOption(command, args[index - 1]) ||
    (outputOption(command, arg.split('=')[0]) && arg.includes('='))
      ? expand(arg, output)
      : arg
  );
}
