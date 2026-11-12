// SPDX-License-Identifier: EUPL-1.2
/**
 * The previous format of `fireforge.json`, and its conversion to the current
 * one. This file is the only place that knows the previous keys.
 *
 * {@link upgradeConfig} is a pure function of the document. Every key it
 * rewrites or drops is reported with its path and the reason, and whatever
 * it cannot convert without a decision is a blocker: the caller then writes
 * nothing. A document already in the current format converts to itself with
 * nothing reported.
 */
import { isRecord, type JsonObject, type JsonValue, omitKeys } from '../kernel/json.js';
import { CHECK_STEPS } from './schema/check.js';
import { ARTIFACTS_PLACEHOLDER } from './schema/gate.js';
import { configSchema } from './schema/index.js';

/** One thing a conversion did, or could not do, to one key. */
export interface UpgradeNote {
  /** The key as the previous format spells it, such as `proof.gate.lanes[2].owns`. */
  readonly key: string;
  readonly message: string;
}

/** The result of converting a document. */
export interface ConfigUpgrade {
  /** The document in the current format. Not to be written while `blockers` holds anything. */
  readonly document: JsonObject;
  /** Keys rewritten to their current spelling, value kept. */
  readonly converted: readonly UpgradeNote[];
  /** Keys dropped because nothing reads them, each with what takes their place. */
  readonly removed: readonly UpgradeNote[];
  /** Converted keys a person must still look at, each with what to check. */
  readonly manual: readonly UpgradeNote[];
  /** Keys that need a decision before the document can be converted. */
  readonly blockers: readonly UpgradeNote[];
}

/** The license a project without a `license` key had. */
const PREVIOUS_DEFAULT_LICENSE = 'MPL-2.0';

class Conversion {
  readonly converted: UpgradeNote[] = [];
  readonly removed: UpgradeNote[] = [];
  readonly manual: UpgradeNote[] = [];
  readonly blockers: UpgradeNote[] = [];

  convert(key: string, message: string): void {
    this.converted.push({ key, message });
  }

  remove(key: string, message: string): void {
    this.removed.push({ key, message });
  }

  review(key: string, message: string): void {
    this.manual.push({ key, message });
  }

  block(key: string, message: string): void {
    this.blockers.push({ key, message });
  }

  /** Drops the listed keys of an object that are present, each with its reason. */
  drop(object: JsonObject, at: string, reasons: Readonly<Record<string, string>>): JsonObject {
    const kept: JsonObject = {};
    for (const [key, value] of Object.entries(object)) {
      const reason = reasons[key];
      if (reason === undefined || value === undefined) kept[key] = value;
      else this.remove(`${at}.${key}`, reason);
    }
    return kept;
  }
}

function objects(value: JsonValue | undefined): JsonObject[] | undefined {
  const isObject = (entry: JsonValue): entry is JsonObject => isRecord(entry);
  return Array.isArray(value) && value.every(isObject) ? value : undefined;
}

function strings(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

/** `sources` becomes `mode` and `source`. */
function upgradeSources(document: JsonObject, conversion: Conversion): JsonObject {
  const { sources, ...rest } = document;
  if (sources === undefined) return document;
  if (!isRecord(sources) || sources['schemaVersion'] !== 1 || sources['mode'] !== 'authored') {
    conversion.block(
      'sources',
      'is not a source-mode declaration this version can read (schemaVersion 1, mode "authored")'
    );
    return document;
  }
  conversion.convert('sources', 'is now "mode": "source" and the "source" block');
  return {
    ...rest,
    mode: 'source',
    source: {
      root: sources['root'],
      metadataRoot: sources['metadataRoot'],
      pristineCommit: sources['pristineCommit'],
    },
  };
}

const LANE_REMOVED: Readonly<Record<string, string>> = {
  owns: 'every lane runs in every gate; no lane is selected by the paths a change touches',
  quiet: 'a gate runs its entries one after another in one workspace',
  args: 'a lane takes no further test options; dispatch, headed, env, uploadDir and machArgs remain',
  keepAwake: 'the gate does not manage the host’s sleep',
  holdFront: 'a headed lane holds the display lock for its whole run',
  throttle: 'lanes are not throttled',
};

function upgradeValidator(
  value: JsonValue | undefined,
  at: string,
  conversion: Conversion
): JsonValue | undefined {
  return isRecord(value)
    ? conversion.drop(value, at, { footprint: 'validators are not scheduled by footprint' })
    : value;
}

function upgradeLane(lane: JsonObject, at: string, conversion: Conversion): JsonObject {
  const kept = conversion.drop(lane, at, {
    ...LANE_REMOVED,
    context: 'a stress run takes no context lanes',
  });
  if (kept['validate'] === undefined) return kept;
  const validate = upgradeValidator(kept['validate'], `${at}.validate`, conversion);
  const command = isRecord(validate) ? strings(validate['command']) : undefined;
  if (kept['uploadDir'] === true && command?.some((word) => word.includes(ARTIFACTS_PLACEHOLDER))) {
    conversion.review(
      `${at}.validate.command`,
      `the harness uploads into ${ARTIFACTS_PLACEHOLDER}/upload, not ${ARTIFACTS_PLACEHOLDER}: an argument naming an uploaded file needs that directory`
    );
  }
  return { ...kept, validate };
}

/**
 * A smoke start's argument vector as structured keys: the `fireforge run`
 * options it used, then the browser's own arguments after `--`.
 */
function upgradeRun(run: JsonObject, at: string, conversion: Conversion): JsonObject {
  const kept = conversion.drop(run, at, {
    quiet: 'a gate runs its entries one after another in one workspace',
    env: 'a smoke start takes no environment',
    uploadDir: 'a smoke start writes into its output directory, which {artifacts} names',
    keepAwake: 'the gate does not manage the host’s sleep',
  });
  const args = strings(kept['args']);
  if (args === undefined) return kept;
  const next: JsonObject = omitKeys(kept, 'args');
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    const value = args[index + 1];
    if (arg === '--') {
      index += 1;
      break;
    }
    if (arg === '--headless') {
      next['headless'] = true;
    } else if (arg === '--smoke-exit' && /^[1-9]\d*$/.test(value ?? '')) {
      next['smokeExit'] = Number(value);
      index += 1;
    } else if (arg === '--console-allow-file' && value !== undefined) {
      next['consoleAllowFile'] = value;
      index += 1;
    } else if (arg === '--capture-console' && value === `${ARTIFACTS_PLACEHOLDER}/console.txt`) {
      // Where a smoke start always writes its console.
      index += 1;
    } else {
      conversion.block(
        `${at}.args[${index}]`,
        `"${arg}" has no structured equivalent; a run takes smokeExit, headless, consoleAllowFile and args (the browser's arguments)`
      );
      return kept;
    }
  }
  const browserArgs = args.slice(index);
  if (browserArgs.length > 0) next['args'] = browserArgs;
  if (next['smokeExit'] === undefined) {
    conversion.block(
      `${at}.args`,
      'names no --smoke-exit <seconds>, which a run needs as smokeExit'
    );
    return kept;
  }
  conversion.convert(`${at}.args`, 'is now smokeExit, headless, consoleAllowFile and args');
  if (kept['validate'] !== undefined) {
    next['validate'] = upgradeValidator(kept['validate'], `${at}.validate`, conversion);
  }
  return next;
}

function upgradeEntries(
  gate: JsonObject,
  list: string,
  upgrade: (entry: JsonObject, at: string) => JsonObject
): JsonObject {
  const entries = objects(gate[list]);
  if (entries === undefined) return gate;
  return {
    ...gate,
    [list]: entries.map((entry, index) => upgrade(entry, `proof.gate.${list}[${index}]`)),
  };
}

/** `proof` becomes `gate`. */
function upgradeProof(document: JsonObject, conversion: Conversion): JsonObject {
  const { proof, ...rest } = document;
  if (proof === undefined) return document;
  if (!isRecord(proof)) {
    conversion.block('proof', 'is not an object');
    return document;
  }
  if (rest['gate'] !== undefined) {
    conversion.block('proof', 'stands beside a "gate" section; keep one of them');
    return document;
  }
  conversion.convert('proof', 'is now "gate"');
  const {
    gate: declared,
    noneRoutes,
    ...other
  } = conversion.drop(proof, 'proof', {
    mainBranch: 'the gate judges the checked-out commit, whatever its branch',
    consumerLimit: 'there is no proof ledger to bound',
  });
  for (const key of Object.keys(other)) conversion.block(`proof.${key}`, 'is not a known key');
  let gate: JsonObject = {};
  if (isRecord(declared)) {
    gate = conversion.drop(declared, 'proof.gate', {
      mode: 'the gate builds the development configuration',
      check: 'the gate always runs check first',
    });
    const lane = (entry: JsonObject, at: string): JsonObject => upgradeLane(entry, at, conversion);
    gate = upgradeEntries(gate, 'lanes', lane);
    gate = upgradeEntries(gate, 'stress', lane);
    gate = upgradeEntries(gate, 'controls', (entry, at) =>
      conversion.drop(entry, at, {
        compiled: 'a control builds what its mutation needs',
        always: 'every control runs in every gate',
      })
    );
    gate = upgradeEntries(gate, 'runs', (entry, at) => upgradeRun(entry, at, conversion));
    gate = upgradeEntries(gate, 'acceptance', (entry, at) =>
      conversion.drop(entry, at, {
        owns: 'an acceptance is owed by every gate that is not documents-only',
      })
    );
  } else if (declared !== undefined) {
    conversion.block('proof.gate', 'is not an object');
  }
  if (noneRoutes !== undefined) {
    conversion.convert(
      'proof.noneRoutes',
      'is now gate.documents: a commit touching only these paths still runs check'
    );
    gate = { ...gate, documents: noneRoutes };
  }
  return Object.keys(gate).length === 0 ? rest : { ...rest, gate };
}

const SHELL_SYNTAX = /[|&;<>()$`\\"'*?[\]{}~#!\n]/;

/** A shell line as an argument vector: split on blanks when it is plain words, else run by `sh -c`. */
function commandVector(line: string): string[] {
  return SHELL_SYNTAX.test(line) ? ['sh', '-c', line] : line.trim().split(/\s+/);
}

function upgradeExtraStep(
  step: JsonObject,
  at: string,
  conversion: Conversion
): JsonObject | undefined {
  const name = typeof step['name'] === 'string' ? step['name'] : '';
  const command = step['command'];
  if (typeof command !== 'string') return step;
  const vector = commandVector(command);
  if (CHECK_STEPS.some((builtin) => builtin === name)) {
    const builtinCommand = name.split('-');
    const runsBuiltin =
      /(^|\/)fireforge$/.test(vector[0] ?? '') &&
      vector.slice(1).join(' ') === builtinCommand.join(' ');
    if (runsBuiltin) {
      conversion.remove(at, `"${name}" is a built-in step of check`);
      return undefined;
    }
    conversion.block(`${at}.name`, `"${name}" is the name of a built-in step; rename this step`);
    return step;
  }
  if (step['cwd'] !== undefined && step['cwd'] !== '.') {
    conversion.block(
      `${at}.cwd`,
      'extra steps run from the project root; move the directory change into the command'
    );
    return step;
  }
  conversion.convert(
    `${at}.command`,
    vector[0] === 'sh' && vector[1] === '-c'
      ? 'is now an argument vector; it uses shell syntax, so it runs through sh -c'
      : 'is now an argument vector'
  );
  const kept = conversion.drop(step, at, {
    cwd: 'extra steps run from the project root',
    footprint:
      'steps are not scheduled by footprint; set "engine": true on a step that reads engine files',
  });
  return { ...kept, command: vector };
}

function upgradeCheck(document: JsonObject, conversion: Conversion): JsonObject {
  const check = document['check'];
  if (!isRecord(check)) return document;
  let next = conversion.drop(check, 'check', {
    timeout: 'built-in steps have no timeout; an extra step has its own, 600 seconds by default',
    timeouts: 'built-in steps have no timeout',
  });
  if (isRecord(next['status'])) {
    next = {
      ...next,
      status: conversion.drop(next['status'], 'check.status', {
        failOnUnknown: 'an unknown status code is refused by the schema',
      }),
    };
  }
  const steps = objects(next['extraSteps']);
  if (steps !== undefined) {
    const upgraded = steps.flatMap((step, index) => {
      const result = upgradeExtraStep(step, `check.extraSteps[${index}]`, conversion);
      return result === undefined ? [] : [result];
    });
    next = upgraded.length === 0 ? omitKeys(next, 'extraSteps') : { ...next, extraSteps: upgraded };
    if (upgraded.some((step) => Array.isArray(step['command']) && step['engine'] === undefined)) {
      conversion.review(
        'check.extraSteps',
        'a step that reads engine files needs "engine": true: it then runs holding a workspace, with FIREFORGE_ENGINE naming the engine'
      );
    }
  }
  return { ...document, check: next };
}

const LINT_SWITCHES: Readonly<Record<string, string>> = {
  jsdocClassMethods: 'jsdoc-class-method',
  chromeScriptJsDoc: 'chrome-script-jsdoc',
  testAssertionFloor: 'test-needs-assertion',
};

function upgradeLint(document: JsonObject, conversion: Conversion): JsonObject {
  const lint = document['patchLint'];
  if (!isRecord(lint)) return document;
  const declared = isRecord(lint['rules']) ? lint['rules'] : {};
  const rules: JsonObject = { ...declared };
  const kept: JsonObject = {};
  for (const [key, value] of Object.entries(lint)) {
    const rule = LINT_SWITCHES[key];
    if (rule === undefined) {
      kept[key] = value;
    } else if (rules[rule] !== undefined && rules[rule] !== value) {
      conversion.block(`patchLint.${key}`, `disagrees with patchLint.rules["${rule}"]; keep one`);
      kept[key] = value;
    } else {
      rules[rule] = value;
      conversion.convert(`patchLint.${key}`, `is now patchLint.rules["${rule}"]`);
    }
  }
  const next = conversion.drop(kept, 'patchLint', {
    forwardRegistration:
      'forward-registration always judges a patch queue; set its severity in patchLint.rules',
    prettier: 'formatting is not a lint rule; run Prettier as a check.extraSteps entry',
  });
  return {
    ...document,
    patchLint: Object.keys(rules).length === 0 ? next : { ...next, rules },
  };
}

function upgradePolicy(document: JsonObject, conversion: Conversion): JsonObject {
  const policy = document['patchPolicy'];
  if (!isRecord(policy)) return document;
  let next: JsonObject = policy;
  if (policy['mutationMode'] === 'force') {
    conversion.convert(
      'patchPolicy.mutationMode',
      '"force" is now "error": queue operations refuse a policy problem they would add'
    );
    next = { ...next, mutationMode: 'error' };
  }
  const rules = objects(policy['scopeRules']);
  if (rules !== undefined) {
    const scopeRules = rules.map((rule, index) => {
      const at = `patchPolicy.scopeRules[${index}]`;
      const { category, filenamePattern, ...rest } = rule;
      if (category === undefined && filenamePattern === undefined) return rule;
      if (category !== undefined && filenamePattern !== undefined) {
        conversion.block(
          at,
          'selects by category and filenamePattern; write one "group" expression'
        );
        return rule;
      }
      if (typeof category === 'string') {
        conversion.convert(`${at}.category`, 'is now "group", an expression over group IDs');
        return { group: `^\\d+-${category}-`, ...rest };
      }
      conversion.convert(`${at}.filenamePattern`, 'is now "group", an expression over group IDs');
      return { group: filenamePattern, ...rest };
    });
    next = { ...next, scopeRules };
  }
  return next === policy ? document : { ...document, patchPolicy: next };
}

function upgradeRest(document: JsonObject, conversion: Conversion): JsonObject {
  let next = conversion.drop(document, '', {
    slots: 'workspaces replace slots; nothing is cloned into a workspace besides the engine',
    history: 'queue operations keep no history log',
  });
  if (isRecord(next['test'])) {
    const removed = 'tests run in the foreground in one workspace, which reaps its own leftovers';
    const test = conversion.drop(next['test'], 'test', {
      canaryPath: 'no canary runs before a test',
      canaryTimeoutSeconds: 'no canary runs before a test',
      reapOrphans: removed,
      lockMode: removed,
      furnaceApply: 'components are always deployed before a test',
    });
    next = Object.keys(test).length === 0 ? omitKeys(next, 'test') : { ...next, test };
  }
  if (next['license'] === undefined) {
    conversion.convert(
      'license',
      `was unset, which meant "${PREVIOUS_DEFAULT_LICENSE}"; it is now written out`
    );
    next = { ...next, license: PREVIOUS_DEFAULT_LICENSE };
  }
  return next;
}

/** `drop` reports top-level keys as `.key`; a note names them without the dot. */
function tidy(notes: readonly UpgradeNote[]): UpgradeNote[] {
  return notes.map((note) => ({ ...note, key: note.key.replace(/^\./, '') }));
}

/**
 * Converts a `fireforge.json` document of the previous format.
 *
 * @param document - The document as parsed, in either format
 * @returns The current-format document and what was done; a document
 *   already current is returned with nothing reported
 */
export function upgradeConfig(document: JsonObject): ConfigUpgrade {
  const conversion = new Conversion();
  if (configSchema.validate(document).ok) {
    return { document, converted: [], removed: [], manual: [], blockers: [] };
  }
  let next = upgradeSources(document, conversion);
  next = upgradeProof(next, conversion);
  next = upgradeCheck(next, conversion);
  next = upgradeLint(next, conversion);
  next = upgradePolicy(next, conversion);
  next = upgradeRest(next, conversion);
  if (conversion.blockers.length === 0) {
    const result = configSchema.validate(next);
    if (!result.ok) {
      for (const issue of result.issues) conversion.block(issue.path, issue.message);
    }
  }
  return {
    document: next,
    converted: tidy(conversion.converted),
    removed: tidy(conversion.removed),
    manual: tidy(conversion.manual),
    blockers: tidy(conversion.blockers),
  };
}
