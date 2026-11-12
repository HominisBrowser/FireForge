// SPDX-License-Identifier: EUPL-1.2
/**
 * `gate`: what `fireforge gate` runs on a clean committed tree besides
 * `check`: a build, declared test lanes, repeated lanes, negative controls,
 * smoke starts of the browser, and the decisions only a person can make. A
 * lane is data, not a shell line, so its environment, arguments and
 * validator are closed.
 */
import { type Infer, s, type Schema } from '../../kernel/schema.js';
import { enginePath, positive, projectPath, text, uniqueBy } from './common.js';

/** Stands for the step's private output directory in a declared value. */
export const ARTIFACTS_PLACEHOLDER = '{artifacts}';

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Whether a value names a path outside the workspace: absolute, home-relative or climbing out. */
function escapesWorkspace(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('~') ||
    /=\//.test(value) ||
    /(^|[=\\/])\.\.([\\/]|$)/.test(value)
  );
}

/**
 * Environment names a declaration never sets: each selects code the run
 * executes, changes how a tool or the build reads, or is owned by FireForge.
 */
const RESERVED_ENV_PREFIXES = [
  'FIREFORGE_',
  'NODE_',
  'NPM_',
  'TSX_',
  'JITI_',
  'MOZ_',
  'MOZBUILD_',
  'MACH',
  'GIT_',
  'PYTHON',
  'PIP_',
  'UV_',
  'VIRTUAL_ENV',
  'CONDA_',
  'DYLD_',
  'LD_',
  'MALLOC',
  'CARGO',
  'RUST',
  'SCCACHE_',
  'CCACHE_',
  'XDG_',
  'LC_',
  'SSH_',
];
const RESERVED_ENV_NAMES = new Set([
  ...['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'OLDPWD', 'IFS', 'ENV', 'BASH_ENV'],
  ...['CDPATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LANGUAGE', 'TZ', 'TERM', 'DISPLAY'],
  ...['WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'MOZCONFIG', 'NODEJS', 'CBINDGEN'],
  ...['CC', 'CXX', 'CPP', 'AR', 'AS', 'LD', 'NM', 'STRIP', 'RANLIB', 'OBJCOPY', 'DSYMUTIL'],
  ...['CFLAGS', 'CXXFLAGS', 'CPPFLAGS', 'LDFLAGS', 'HOST_CC', 'HOST_CXX', 'HOST_AR'],
  ...['CLANG_PATH', 'LIBCLANG_PATH', 'WASI_SYSROOT', 'MACOS_SDK_DIR', 'WASM_CC', 'WASM_CXX'],
  'ONNX_RUNTIME',
]);

function environmentProblem(env: Record<string, string>): string | undefined {
  for (const [name, value] of Object.entries(env)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) {
      return `names ${name}: names are upper case letters, digits and _`;
    }
    if (RESERVED_ENV_NAMES.has(name) || RESERVED_ENV_PREFIXES.some((p) => name.startsWith(p))) {
      const hint = name === 'MOZ_UPLOAD_DIR' ? '; set uploadDir instead' : '';
      return `sets ${name}, which FireForge owns${hint}`;
    }
    if (value.length > 4096 || /[\0\r\n]/.test(value)) {
      return `sets ${name} to more than one line of at most 4096 characters`;
    }
    const inArtifacts =
      value === ARTIFACTS_PLACEHOLDER || value.startsWith(`${ARTIFACTS_PLACEHOLDER}/`);
    const path = inArtifacts ? value.slice(ARTIFACTS_PLACEHOLDER.length + 1) : value;
    if (path.includes(ARTIFACTS_PLACEHOLDER) || escapesWorkspace(path)) {
      return `sets ${name} to a path outside the run: use a workspace-relative path or start it with ${ARTIFACTS_PLACEHOLDER}`;
    }
  }
  return undefined;
}

const environment = s
  .record(s.string())
  .refine(environmentProblem)
  .describe(
    `Environment of the harness; a value starting ${ARTIFACTS_PLACEHOLDER} names a path in the run's output directory`
  );

const validator = s
  .object({
    command: s
      .array(s.string({ pattern: /^[^\0]+$/, format: 'a non-empty argument' }), { min: 1 })
      .describe(
        `Argument vector: node <script> or a committed script; ${ARTIFACTS_PLACEHOLDER} expands`
      ),
  })
  .refine(({ command }) => {
    const [program = '', script] = command;
    if (command.some((arg) => escapesWorkspace(arg.replaceAll(ARTIFACTS_PLACEHOLDER, 'out')))) {
      return `must name no path outside the workspace; use a relative path or ${ARTIFACTS_PLACEHOLDER}`;
    }
    if (program !== 'node' && !program.includes('/')) {
      return 'must run node or a committed script by its path, not a program name';
    }
    return program === 'node' && (script === undefined || script.startsWith('-'))
      ? 'must run node on a committed script: node <script> [arguments]'
      : undefined;
  })
  .describe('Judges what the harness produced, after it exits clean; nonzero reads red');

/** The one form of mach argument a lane holds: a pref whose value names no path. */
const machArgument = s
  .string({
    pattern: /^--setpref=[A-Za-z][A-Za-z0-9_.-]*=[A-Za-z0-9_.:+,@%-]*$/,
    format: '--setpref=<name>=<value> with a value that names no path',
  })
  .refine((arg) =>
    arg.startsWith('--setpref=marionette.') ? 'must not set a marionette.* pref' : undefined
  );

const id = s.string({ pattern: ID_PATTERN, format: 'a lowercase ID such as "tiles"' });
const tests = s.array(enginePath, { min: 1 });

const laneKeys = {
  id: id.describe('Lane ID'),
  files: tests.describe('Engine-relative globs or literal paths of the tests the lane runs'),
  exclude: tests.describe('Tests left out of files').optional(),
  dispatch: s
    .enum(['shards', 'one-browser', 'standalone'])
    .describe('A browser per file, one browser for all, or a restart between files')
    .default('shards'),
  headed: s.boolean().describe('Runs with a visible window, holding the display').default(false),
  env: environment.optional(),
  uploadDir: s
    .boolean()
    .describe("Gives the harness a MOZ_UPLOAD_DIR in the run's output directory")
    .default(false),
  machArgs: s.array(machArgument, { min: 1 }).describe('Mach --setpref arguments').optional(),
  validate: validator.optional(),
};

const laneSchema = s.object(laneKeys);

const stressSchema = s.object({
  ...laneKeys,
  repeat: positive.describe('How many times the lane runs; every repeat must pass'),
});

const controlSchema = s.object({
  id: id.describe('Control ID'),
  diff: projectPath.describe('Committed diff holding the mutation'),
  test: enginePath.describe('Engine-relative test that must catch it'),
  assertions: s
    .array(text, { min: 1 })
    .describe('Labels of the reds it must produce, every one and no other'),
});

const runSchema = s.object({
  id: id.describe('Run ID'),
  smokeExit: positive.describe('Seconds the console is watched before the browser is ended'),
  headless: s.boolean().describe('Starts without a window').default(false),
  args: s.array(text, { min: 1 }).describe('Arguments for the browser').optional(),
  consoleAllowFile: projectPath
    .describe('Committed file of console line patterns the smoke start accepts')
    .optional(),
  validate: validator.optional(),
});

const acceptanceSchema = s.object({
  id: id.describe('Acceptance ID'),
  reason: text.describe('What the person decides'),
  evidence: s
    .array(
      s.string({ pattern: /^(lane|stress|control|run):/, format: 'kind:id, such as lane:captures' })
    )
    .describe('Declared lanes, stress runs, controls or runs whose outputs the person looks at')
    .optional(),
});

const byId = <T extends { id: string }>(schema: Schema<T>, noun: string): Schema<T[]> =>
  s.array(schema).refine(uniqueBy((entry: T) => entry.id, `${noun} ID`));

const gateObject = s.object({
  build: s
    .enum(['ui', 'full'])
    .describe('The build the gate runs; a workspace that needs a full build gets one either way')
    .default('ui'),
  documents: s
    .array(text, { min: 1 })
    .describe(
      'Globs of repository paths that change nothing the gate tests (a pattern without a slash matches a file name at any depth): a commit touching only these needs check alone'
    )
    .optional(),
  lanes: byId(laneSchema, 'lane').describe('Groups of tests run as declared').optional(),
  stress: byId(stressSchema, 'stress').describe('Lanes run repeatedly').optional(),
  controls: byId(controlSchema, 'control')
    .describe('Expected reds: a mutation each test must catch')
    .optional(),
  runs: byId(runSchema, 'run').describe('Smoke starts of the built browser').optional(),
  acceptance: byId(acceptanceSchema, 'acceptance')
    .describe('Decisions only a person can make, recorded by gate accept')
    .optional(),
});

/** The validated `gate` section. */
export type GateConfig = Infer<typeof gateObject>;

/** One declared lane; a stress entry is a lane with `repeat`. */
export type GateLane = Infer<typeof laneSchema> & { repeat?: number };

/** An acceptance can only stand on something the gate declares and runs. */
function evidenceProblem(gate: GateConfig): string | undefined {
  const declared = new Set([
    ...(gate.lanes ?? []).map(({ id }) => `lane:${id}`),
    ...(gate.stress ?? []).map(({ id }) => `stress:${id}`),
    ...(gate.controls ?? []).map(({ id }) => `control:${id}`),
    ...(gate.runs ?? []).map(({ id }) => `run:${id}`),
  ]);
  for (const entry of gate.acceptance ?? []) {
    const missing = (entry.evidence ?? []).find((id) => !declared.has(id));
    if (missing !== undefined) {
      return `has acceptance "${entry.id}" naming ${missing}, which the gate does not declare`;
    }
  }
  return undefined;
}

/** The `gate` section. */
export const gateSection = gateObject
  .refine(evidenceProblem)
  .describe('What fireforge gate runs besides check');
