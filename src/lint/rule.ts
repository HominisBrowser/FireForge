// SPDX-License-Identifier: EUPL-1.2
/**
 * The rule framework: what a rule is, what it reports, and what it reads.
 *
 * A rule is pure over its {@link RuleContext}: the owned changes, the
 * configuration, and an {@link EngineReader} for the engine files around
 * them. It never asks which mode produced the changes. Rules about a group's
 * own work (patch size, add-only edits, staged dependencies) read
 * `changes.inGroup`; rules about what the engine ends up holding read the
 * net change per path through {@link OwnedFiles}.
 */
import type { FireForgeConfig, LintRuleId } from '../config/index.js';
import type { ChangeSet } from '../project/index.js';
import type { OwnedFiles } from './input.js';

/** How much a finding matters. Only `error` fails a run; `warning` fails under `--max-warnings`. */
export type Severity = 'error' | 'warning' | 'notice';

/** The share of a group's lines a size finding measures, under the `addedCode` metric. */
export type SizeShare = 'product' | 'test';

/** One thing a rule found. */
export interface Finding {
  readonly rule: string;
  readonly severity: Severity;
  readonly message: string;
  /** Engine-relative path, absent for a finding about a group or the configuration. */
  readonly path?: string | undefined;
  /** 1-based line in the path's final content. */
  readonly line?: number | undefined;
  /** The group the finding is attributed to. */
  readonly group?: string | undefined;
  /** What a size rule measured; a lintIgnore ceiling bounds it. */
  readonly measurement?: number | undefined;
  readonly share?: SizeShare | undefined;
}

/** What a rule returns: a finding whose rule and, by default, severity the framework fills in. */
export type Draft = Omit<Finding, 'rule' | 'severity'> & { readonly severity?: Severity };

/**
 * Reads engine files around the owned changes: the engine checkout, or the
 * pristine repository overlaid with the owned files. Paths are
 * engine-relative with forward slashes.
 */
export interface EngineReader {
  /** The file's bytes, or undefined when the engine has no such file. */
  read(path: string): Promise<Uint8Array | undefined>;
}

/**
 * Design-token naming, from the component configuration, for
 * `token-prefix-violation`. Without it the rule does not run.
 */
export interface TokenPolicy {
  /** Custom properties a stylesheet may reference start with this. */
  readonly prefix: string;
  /** Further custom properties accepted by exact name. */
  readonly allowlist: readonly string[];
  /** Runtime state channels accepted by exact name. */
  readonly runtimeVariables: readonly string[];
}

/** Everything a rule reads. */
export interface RuleContext {
  readonly changes: ChangeSet;
  readonly owned: OwnedFiles;
  readonly engine: EngineReader;
  readonly config: FireForgeConfig;
  /** Absolute project root: shims and policy documents are project-relative. */
  readonly projectRoot: string;
  /**
   * The groups apply one after another (a patch queue), so a group must not
   * reference a file a later group creates.
   */
  readonly sequential: boolean;
  readonly tokens: TokenPolicy | undefined;
  /** Directory for the TypeScript result cache, or undefined to keep none. */
  readonly cacheDir: string | undefined;
  /** Whether findings on a path are wanted; group findings are always kept. */
  readonly selected: (path: string) => boolean;
  /** Every path is wanted: the run covers the whole change set. */
  readonly complete: boolean;
  /**
   * Whether a path is a deployed component host file, whose source `furnace
   * validate` judges for raw colours, token prefixes and relative imports,
   * so those rules leave it to Furnace.
   */
  readonly component: (path: string) => boolean;
}

/** A rule: its ID, default severity (`off` until configured), purpose, and check. */
export interface Rule {
  readonly id: LintRuleId;
  readonly severity: Severity | 'off';
  readonly description: string;
  check(context: RuleContext): Promise<readonly Draft[]> | readonly Draft[];
}

/**
 * Runs one rule under the configured severity: `patchLint.rules[id]` turns it
 * off or replaces the severity of every finding; otherwise a finding keeps
 * its own severity (a size band) or takes the rule's default.
 *
 * @param rule - The rule
 * @param context - What it reads
 */
export async function runRule(rule: Rule, context: RuleContext): Promise<Finding[]> {
  const configured = context.config.patchLint.rules?.[rule.id];
  const effective = configured ?? rule.severity;
  if (effective === 'off') return [];
  const drafts = await rule.check(context);
  return drafts.map((draft) => ({
    ...draft,
    rule: rule.id,
    severity:
      configured !== undefined && configured !== 'off' ? configured : (draft.severity ?? effective),
  }));
}

/** True for `.js`, `.mjs`, `.jsm` and `.sys.mjs` files. */
export function isJsFile(path: string): boolean {
  return /\.(?:m?js|jsm)$/.test(path);
}

/**
 * The test class of the size rules and the strict typing of test scripts: a
 * path under `/test/`, or a `browser_`, `test_` or `xpcshell_` `.js` file.
 */
export function isTestFile(path: string): boolean {
  if (path.includes('/test/')) return true;
  return /^(?:browser_|test_|xpcshell_).*\.js$/.test(basename(path));
}

/** The last segment of a forward-slash path. */
export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The directory part of a forward-slash path, with a trailing slash, or `''` at the top. */
export function directoryOf(path: string): string {
  return path.slice(0, path.lastIndexOf('/') + 1);
}
