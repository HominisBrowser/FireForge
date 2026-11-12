// SPDX-License-Identifier: EUPL-1.2
/**
 * A lint run: every rule over the owned changes, then the groups' waivers,
 * then one sorted report. The strict typing pass is also offered alone, for
 * `typecheck`, judged and waived the same way.
 */
import type { FireForgeConfig } from '../config/index.js';
import type { ChangeSet } from '../project/index.js';
import { type CheckJsInput, checkOwnedJs, explainOwnedJs, type OwnedTypesView } from './checkjs.js';
import { loadOwnedFiles } from './input.js';
import type { LintReport } from './report.js';
import {
  type EngineReader,
  type Finding,
  type Rule,
  type RuleContext,
  runRule,
  type TokenPolicy,
} from './rule.js';
import { cssRules } from './rules/css.js';
import { javascriptRules } from './rules/javascript.js';
import { licenseRules } from './rules/license.js';
import { policyRules } from './rules/policy.js';
import { registrationRules } from './rules/registration.js';
import { sizeRules } from './rules/size.js';
import { applyWaivers } from './waivers.js';

function checkJsInput(context: RuleContext): CheckJsInput {
  return {
    owned: context.owned,
    engine: context.engine,
    lint: context.config.patchLint,
    projectRoot: context.projectRoot,
    cacheDir: context.cacheDir,
    complete: context.complete,
    selected: context.selected,
  };
}

const checkJs: Rule = {
  id: 'checkjs-type-error',
  severity: 'error',
  description: 'Created modules (and with checkJsTestFiles, test scripts) type-check',
  check(context) {
    return context.config.patchLint.checkJs ? checkOwnedJs(checkJsInput(context)) : [];
  },
};

/** Every rule, in report order within a path. */
export const RULES: readonly Rule[] = [
  ...licenseRules,
  ...javascriptRules,
  ...cssRules,
  ...sizeRules,
  ...registrationRules,
  checkJs,
  ...policyRules,
];

/** What {@link runLint} needs besides the changes, the reader and the configuration. */
export interface LintOptions {
  /** Absolute project root: shims and policy documents are project-relative. */
  readonly projectRoot: string;
  /**
   * The groups apply one after another (a patch queue), so a group must not
   * reference a file a later group creates.
   */
  readonly sequential?: boolean;
  /** Design-token naming for `token-prefix-violation`. */
  readonly tokens?: TokenPolicy;
  /** Engine-relative paths (files or directories) to report on; findings about groups always surface. */
  readonly paths?: readonly string[];
  /** Directory of the TypeScript result cache; without it nothing is cached. */
  readonly cacheDir?: string;
  /**
   * Engine paths of deployed component files whose sources `furnace
   * validate` judges for the content rules both would otherwise run.
   */
  readonly components?: readonly string[];
}

/** Whether a path is one of `paths` or lies under one. */
function under(paths: readonly string[]): (path: string) => boolean {
  const prefixes = paths.map((path) => path.replace(/\/+$/, ''));
  return (path) => prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

async function contextFor(
  changes: ChangeSet,
  engine: EngineReader,
  config: FireForgeConfig,
  options: LintOptions
): Promise<RuleContext> {
  return {
    changes,
    owned: await loadOwnedFiles(changes),
    engine,
    config,
    projectRoot: options.projectRoot,
    sequential: options.sequential ?? false,
    tokens: options.tokens,
    cacheDir: options.cacheDir,
    selected:
      options.paths === undefined || options.paths.length === 0 ? () => true : under(options.paths),
    complete: options.paths === undefined || options.paths.length === 0,
    component: under(options.components ?? []),
  };
}

function compare(a: Finding, b: Finding): number {
  const key = (finding: Finding): string =>
    [
      finding.group ?? '',
      finding.path ?? '',
      String(finding.line ?? 0).padStart(8, '0'),
      finding.rule,
    ].join('\0');
  return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
}

/** Applies `patchLint.rules` to the waiver notices, which no rule's run produced. */
function configured(config: FireForgeConfig, finding: Finding): Finding[] {
  const severity = config.patchLint.rules?.['lint-ignore-removable'];
  if (finding.rule !== 'lint-ignore-removable' || severity === undefined) return [finding];
  return severity === 'off' ? [] : [{ ...finding, severity }];
}

/**
 * Runs every rule over the owned changes and applies the groups' waivers.
 *
 * @param changes - The owned changes, from either mode
 * @param engine - Reads engine files around them
 * @param config - The project configuration
 * @param options - See {@link LintOptions}
 * @throws FireForgeError when checkJs is on and TypeScript or a configured shim is missing
 */
export async function runLint(
  changes: ChangeSet,
  engine: EngineReader,
  config: FireForgeConfig,
  options: LintOptions
): Promise<LintReport> {
  const context = await contextFor(changes, engine, config, options);
  const findings: Finding[] = [];
  for (const rule of RULES) findings.push(...(await runRule(rule, context)));
  const outcome = applyWaivers(changes, findings);
  return {
    findings: outcome.kept.flatMap((finding) => configured(config, finding)).sort(compare),
    suppressed: outcome.suppressed.sort(compare),
    waivers: outcome.waivers,
  };
}

/**
 * The strict typing pass alone (`checkjs-type-error`), with the severity
 * and waivers `lint` applies to it. Nothing when `patchLint.checkJs` is off.
 *
 * @param changes - The owned changes
 * @param engine - Reads the targets of a reviewed `paths` mapping
 * @param config - The project configuration
 * @param options - The project root and cache directory
 * @throws FireForgeError when TypeScript or a configured shim is missing
 */
export async function checkOwnedTypes(
  changes: ChangeSet,
  engine: EngineReader,
  config: FireForgeConfig,
  options: Pick<LintOptions, 'projectRoot' | 'cacheDir'>
): Promise<Finding[]> {
  const context = await contextFor(changes, engine, config, options);
  const findings = await runRule(checkJs, context);
  return applyWaivers(changes, findings)
    .kept.filter((finding) => finding.rule === checkJs.id)
    .sort(compare);
}

/**
 * How the strict typing pass sees one file, without checking anything.
 *
 * @param changes - The owned changes
 * @param engine - Reads the targets of a reviewed `paths` mapping
 * @param config - The project configuration
 * @param options - The project root
 * @param path - Engine-relative path of the file
 */
export async function explainOwnedTypes(
  changes: ChangeSet,
  engine: EngineReader,
  config: FireForgeConfig,
  options: Pick<LintOptions, 'projectRoot'>,
  path: string
): Promise<OwnedTypesView> {
  const context = await contextFor(changes, engine, config, options);
  return explainOwnedJs(checkJsInput(context), path);
}
