// SPDX-License-Identifier: EUPL-1.2
/**
 * What a source-mode checkout runs instead of each command it refuses. An
 * executor command launches or writes the shared mutable `engine/`, so it runs
 * only inside a slot; a legacy command works on a patch queue or a mutable
 * engine this project no longer has. Each refusal names the form that works.
 */

/** How a refused command's work gets done. */
type RemedyForm = 'job run' | 'here' | 'git' | 'none';

export interface SourceRemedy {
  form: RemedyForm;
  /** Each FireForge command the remedy names, as a person types it. Every one of them parses. */
  commands: readonly string[];
  /** The sentences the refusal carries, naming those commands. */
  detail: string;
}

const STATIC_FEEDBACK =
  '"fireforge authored lint", "fireforge authored typecheck" and "fireforge authored verify" give static feedback without one.';

const CAPTURE = 'fireforge authored capture --out <file>';
const FETCH = 'fireforge authored pristine fetch --out <dir>';
const REFRESH =
  'fireforge authored refresh --snapshot <file> --new-pin <file> --new-pristine-repository <dir> --out <dir>';

/** Every executor command, by the command chain the source guard sees. */
export const EXECUTOR_REMEDIES: Readonly<Record<string, SourceRemedy>> = {
  run: {
    form: 'job run',
    commands: ['fireforge job run --run'],
    detail:
      'Use "fireforge job run --run": it builds what changed, opens the browser on this checkout in a slot and streams its output until the window closes or Ctrl-C cancels it. --profile <dir> keeps a profile between runs.',
  },
  test: {
    form: 'job run',
    commands: ['fireforge job run --test <path>'],
    detail: `Use "fireforge job run --test <path>": it builds what changed and runs the tests in a slot, taking --headed, --repeat <n>, --shuffle <seed>, and --coverage, --perf-samples and --keep-log, which write into the job's artifacts. ${STATIC_FEEDBACK}`,
  },
  build: {
    form: 'job run',
    commands: ['fireforge job run --build ui', 'fireforge job run --build full'],
    detail:
      'Use "fireforge job run --build ui" over a slot that has a full build, or "fireforge job run --build full" for a fresh slot.',
  },
  check: {
    form: 'job run',
    commands: ['fireforge job run --check'],
    detail: `Use "fireforge job run --check": it runs the whole project check in a slot. ${STATIC_FEEDBACK}`,
  },
  package: {
    form: 'job run',
    commands: ['fireforge job run --release'],
    detail:
      'Use "fireforge job run --release": it builds and packages the release recipe in a slot, in its own object directory.',
  },
  lint: {
    form: 'here',
    commands: ['fireforge authored lint'],
    detail:
      'Use "fireforge authored lint": it lints a snapshot of this checkout without a slot. "fireforge job run --check" runs the whole check in one.',
  },
  typecheck: {
    form: 'here',
    commands: ['fireforge authored typecheck'],
    detail:
      'Use "fireforge authored typecheck": it typechecks a snapshot of this checkout without a slot. "fireforge job run --check" runs the whole check in one.',
  },
  verify: {
    form: 'here',
    commands: ['fireforge authored verify'],
    detail:
      'Use "fireforge authored verify": it verifies a snapshot of this checkout without a slot.',
  },
  status: {
    form: 'here',
    commands: ['fireforge status', 'fireforge authored status'],
    detail:
      '"fireforge status" reads a snapshot of this checkout, and "fireforge authored status" reports that snapshot.',
  },
  'furnace apply': {
    form: 'job run',
    commands: ['fireforge job run --test <path>', 'fireforge job run --check'],
    detail:
      'A job applies the components itself: "fireforge job run --test <path>" applies them before its build, and "fireforge job run --check" validates them.',
  },
  'furnace deploy': {
    form: 'job run',
    commands: ['fireforge job run --test <path>', 'fireforge job run --check'],
    detail:
      'A job deploys the components itself: "fireforge job run --test <path>" applies them before its build, and "fireforge job run --check" validates them.',
  },
  'furnace sync': {
    form: 'job run',
    commands: ['fireforge job run --test <path>', 'fireforge job run --check'],
    detail:
      'A job syncs the components itself: "fireforge job run --test <path>" applies them before its build, and "fireforge job run --check" validates them.',
  },
  'furnace validate': {
    form: 'none',
    commands: ['fireforge furnace validate', 'fireforge job run --check'],
    detail:
      'A fix rewrites files, and a slot is immutable. "fireforge job run --check" validates the components in a slot; make the fix in tracked source. "fireforge furnace validate" without --fix refuses here too, since engine/ is only the pristine donor.',
  },
};

const PIN_CHANGE = `Use "${FETCH}" (with --pin <file> for a new pin) for the new pristine tree, then "${REFRESH}" for a merge proposal you review and adopt.`;
const SET_UP = {
  form: 'here',
  commands: [
    'fireforge host init',
    'fireforge slot create <name>',
    'fireforge slot qualify-native <name>',
  ],
  detail:
    'This project is set up already: "fireforge host init" readies the host and its slots, "fireforge slot create <name>" and "fireforge slot qualify-native <name>" add one more, and fireforge.json changes by a reviewed edit.',
} as const satisfies SourceRemedy;
const MATERIALIZE = {
  form: 'here',
  commands: ['fireforge authored materialize --snapshot <file> --engine <dir>'],
  detail:
    'Use "fireforge authored materialize --snapshot <file> --engine <dir>": it writes the captured source into an isolated engine. Two branches that first-touch one upstream file meet as a Git conflict in src/, which the authored merge driver merges.',
} as const satisfies SourceRemedy;
const RESTORE = {
  form: 'git',
  commands: ['fireforge authored restore-upstream <path>'],
  detail:
    'Use Git in this checkout for owned files, and "fireforge authored restore-upstream <path>" to drop an override of an upstream file.',
} as const satisfies SourceRemedy;
const QUEUE = {
  form: 'here',
  commands: [
    'fireforge authored export-queue --snapshot <file> --out <dir>',
    'fireforge authored delta --snapshot <file>',
    CAPTURE,
  ],
  detail: `The patch queue is generated, never edited: "fireforge authored export-queue --snapshot <file> --out <dir>" writes it, and "fireforge authored delta --snapshot <file>" reviews the change. "${CAPTURE}" makes the snapshot.`,
} as const satisfies SourceRemedy;
const SLOTS = {
  form: 'here',
  commands: [
    'fireforge slot create <name>',
    'fireforge slot prepare <name> --snapshot <file>',
    'fireforge slot remove <name>',
    'fireforge job run --slot <name>',
  ],
  detail:
    'A slot is the isolated tree here: "fireforge slot create <name>", "fireforge slot prepare <name> --snapshot <file>" and "fireforge slot remove <name>" manage one, and "fireforge job run --slot <name>" runs work in it.',
} as const satisfies SourceRemedy;

/** Every legacy command a source-mode checkout refuses, by the command chain the source guard sees. */
export const LEGACY_REMEDIES: Readonly<Record<string, SourceRemedy>> = {
  download: { form: 'here', commands: [FETCH, REFRESH], detail: PIN_CHANGE },
  source: { form: 'here', commands: [FETCH, REFRESH], detail: PIN_CHANGE },
  rebase: { form: 'here', commands: [FETCH, REFRESH], detail: PIN_CHANGE },
  setup: SET_UP,
  bootstrap: SET_UP,
  import: MATERIALIZE,
  resolve: MATERIALIZE,
  reset: RESTORE,
  discard: RESTORE,
  export: QUEUE,
  'export-all': QUEUE,
  're-export': QUEUE,
  patch: QUEUE,
  park: {
    form: 'git',
    commands: [],
    detail: 'Park work on a Git branch: owned source is ordinary tracked files.',
  },
  watch: {
    form: 'here',
    commands: ['fireforge job watch', 'fireforge job watch --test <path>'],
    detail:
      'Use "fireforge job watch": it captures, rebuilds and runs again on every save, in one kept slot; "fireforge job watch --test <path>" retests too.',
  },
  'tree create': SLOTS,
  'tree exec': SLOTS,
  'tree remove': SLOTS,
  'furnace override': {
    form: 'here',
    commands: ['fireforge authored override <path>'],
    detail:
      'Use "fireforge authored override <path>": it takes ownership of an upstream file in tracked source.',
  },
  'furnace refresh': {
    form: 'here',
    commands: [REFRESH],
    detail: `Use "${REFRESH}": it proposes the merge onto a new pin for review.`,
  },
  'furnace scan': {
    form: 'none',
    commands: [],
    detail: 'List the stock components in furnace.json by hand.',
  },
  'furnace preview': {
    form: 'none',
    commands: ['fireforge job run --run'],
    detail:
      'The preview needs a live engine. "fireforge job run --run" opens the browser on this checkout in a slot.',
  },
  config: {
    form: 'here',
    commands: [REFRESH],
    detail: `firefox.* and sources.* change by a reviewed edit of fireforge.json, and a pin change is an adopted proposal from "${REFRESH}".`,
  },
  doctor: {
    form: 'here',
    commands: [
      'fireforge slot audit <name>',
      'fireforge slot restore <name>',
      'fireforge job host-clear',
    ],
    detail:
      'Repairs here are "fireforge slot audit <name>", "fireforge slot restore <name>" and "fireforge job host-clear"; the checkout itself is repaired with Git.',
  },
};

const LEADS: Readonly<Record<RemedyForm, string>> = {
  'job run': '',
  here: 'It needs no slot. ',
  git: '',
  none: 'No job form exists for it. ',
};

/** The remedy for `chain`: its own entry, else its top-level command's. */
const lookup = (
  table: Readonly<Record<string, SourceRemedy>>,
  chain: string
): SourceRemedy | undefined => table[chain] ?? table[chain.split(' ')[0] ?? ''];

/** The sentences an executor refusal of `chain` ends with: what to run instead, or that nothing runs it. */
export function executorRemedy(chain: string): string {
  const remedy = lookup(EXECUTOR_REMEDIES, chain);
  if (remedy === undefined) return `No job form exists for it. ${STATIC_FEEDBACK}`;
  return `${LEADS[remedy.form]}${remedy.detail}`;
}

/** The sentences a legacy refusal of `chain` ends with, or undefined when nothing names one. */
export function legacyRemedy(chain: string): string | undefined {
  const remedy = lookup(LEGACY_REMEDIES, chain);
  if (remedy === undefined) return undefined;
  return `${remedy.form === 'none' ? 'No source-mode equivalent exists. ' : ''}${remedy.detail}`;
}
