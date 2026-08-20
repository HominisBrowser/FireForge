// SPDX-License-Identifier: EUPL-1.2
/**
 * Project-specific patch queue policy evaluation.
 *
 * The policy is opt-in via `fireforge.json#patchPolicy`. Callers feed this
 * module either the current manifest (`verify`, `lint --per-patch`) or a
 * projected manifest assembled before a mutation commits (`export`,
 * `patch reorder`, etc.).
 */

import { InvalidArgumentError } from '../errors/base.js';
import type { PatchesManifest, PatchMetadata } from '../types/commands/index.js';
import type { FireForgeConfig, PatchPolicyConfig, PatchPolicyRange } from '../types/config.js';
import { warn } from '../utils/logger.js';
import { PATCH_CATEGORIES } from '../utils/validation.js';
import { rewriteStagedDependencyOwners } from './patch-manifest-io.js';

/** Default patch filename contract used when a policy omits `filenamePattern`. */
const DEFAULT_PATCH_POLICY_FILENAME_PATTERN =
  '^(?<order>\\d{3})-(?<category>[a-z][a-z0-9-]*)-(?<slug>[a-z0-9-]+)\\.patch$';

/** Stable issue codes returned by patch policy evaluation. */
export type PatchPolicyIssueCode =
  | 'filename-pattern'
  | 'filename-captures'
  | 'filename-metadata-mismatch'
  | 'order-collision'
  | 'category-range'
  | 'reserved-range'
  | 'reserved-documentation'
  | 'reserved-files'
  | 'description-required'
  | 'numeric-gap';

/** A single patch policy validation finding. */
export interface PatchPolicyIssue {
  code: PatchPolicyIssueCode;
  filename: string;
  message: string;
  severity: 'error' | 'warning';
}

/** Input for enforcing policy during mutating commands. */
export interface PatchPolicyEnforcementInput {
  config: FireForgeConfig;
  manifest: PatchesManifest;
  command: string;
  forceUnsafe?: boolean;
  /**
   * Per-issue-code remediation lines appended to matching details, so a
   * refusal can name the exact flag or command that fixes it on the
   * command it was raised from (e.g. `--description` on
   * `patch move-files --create`).
   */
  hints?: Partial<Record<PatchPolicyIssueCode, string>>;
}

function policy(config: FireForgeConfig): PatchPolicyConfig | undefined {
  return config.patchPolicy;
}

function mutationMode(config: FireForgeConfig): 'error' | 'warn' | 'force' {
  return policy(config)?.mutationMode ?? 'error';
}

function issueSeverity(config: FireForgeConfig): 'error' | 'warning' {
  return mutationMode(config) === 'warn' ? 'warning' : 'error';
}

/** Returns true when the loaded config includes an opt-in patch policy. */
function hasPatchPolicy(config: FireForgeConfig): boolean {
  return policy(config) !== undefined;
}

/** Returns valid categories for prompts and CLI validation under the config. */
export function getPatchPolicyCategories(config: FireForgeConfig): string[] {
  const cfg = policy(config);
  if (!cfg) return [...PATCH_CATEGORIES];
  return Array.from(new Set(cfg.ranges.map((range) => range.category))).sort((a, b) =>
    a.localeCompare(b)
  );
}

/** Checks whether a category is accepted by legacy defaults or the policy ranges. */
export function isCategoryAllowedByConfig(config: FireForgeConfig, category: string): boolean {
  if (!/^[a-z][a-z0-9-]*$/.test(category)) return false;
  const cfg = policy(config);
  if (!cfg) return (PATCH_CATEGORIES as readonly string[]).includes(category);
  return cfg.ranges.some((range) => range.category === category);
}

function rangeLabel(range: { from: number; to: number }): string {
  return `${String(range.from).padStart(3, '0')}-${String(range.to).padStart(3, '0')}`;
}

/**
 * Human-readable label for a category's configured ranges, e.g. `300-399`.
 * Exported for the forward-import hint, which must render the
 * range it found no legal ordinal in.
 */
export function categoryRangeLabel(ranges: readonly PatchPolicyRange[], category: string): string {
  const matches = ranges.filter((range) => range.category === category);
  if (matches.length === 0) return '(no configured range)';
  return matches.map(rangeLabel).join(', ');
}

function reservedRangeForOrder(
  cfg: PatchPolicyConfig,
  order: number
): NonNullable<PatchPolicyConfig['reservedRanges']>[number] | null {
  return cfg.reservedRanges?.find((range) => order >= range.from && order <= range.to) ?? null;
}

/**
 * Returns the configured range that contains `order` for `category`, or
 * null when no such range exists. Exported for the forward-import hint
 *, which suppresses ordinal suggestions the reorder policy
 * would refuse.
 */
export function categoryRangeForOrder(
  cfg: PatchPolicyConfig,
  category: string,
  order: number
): PatchPolicyRange | null {
  return (
    cfg.ranges.find((range) => {
      return range.category === category && order >= range.from && order <= range.to;
    }) ?? null
  );
}

function anyRangeForOrder(cfg: PatchPolicyConfig, order: number): PatchPolicyRange | null {
  return cfg.ranges.find((range) => order >= range.from && order <= range.to) ?? null;
}

function compileFilenamePattern(cfg: PatchPolicyConfig): RegExp {
  return new RegExp(cfg.filenamePattern ?? DEFAULT_PATCH_POLICY_FILENAME_PATTERN);
}

function parseFilenameWithPolicy(
  cfg: PatchPolicyConfig,
  patch: PatchMetadata,
  severity: 'error' | 'warning'
): { order: number; category: string } | PatchPolicyIssue[] {
  if (cfg.filenamePattern === undefined) {
    const defaultMatch = /^(?<order>\d{3})-(?<rest>[a-z0-9-]+)\.patch$/.exec(patch.filename);
    const orderRaw = defaultMatch?.groups?.['order'];
    const rest = defaultMatch?.groups?.['rest'];
    if (!orderRaw || !rest) {
      return [
        {
          code: 'filename-pattern',
          filename: patch.filename,
          severity,
          message:
            `${patch.filename} does not match the default patchPolicy filename pattern ` +
            '(NNN-category-slug.patch).',
        },
      ];
    }
    const categories = Array.from(new Set(cfg.ranges.map((range) => range.category))).sort(
      (a, b) => b.length - a.length
    );
    const category = categories.find((candidate) => rest.startsWith(`${candidate}-`));
    if (!category) {
      return [
        {
          code: 'filename-captures',
          filename: patch.filename,
          severity,
          message: `${patch.filename} does not encode one of the configured patchPolicy categories.`,
        },
      ];
    }
    const slug = rest.slice(category.length + 1);
    if (!/^[a-z0-9-]+$/.test(slug)) {
      return [
        {
          code: 'filename-captures',
          filename: patch.filename,
          severity,
          message: `${patch.filename} does not encode a lowercase slug after category "${category}".`,
        },
      ];
    }
    return { order: Number.parseInt(orderRaw, 10), category };
  }

  const pattern = compileFilenamePattern(cfg);
  const match = pattern.exec(patch.filename);
  if (!match) {
    return [
      {
        code: 'filename-pattern',
        filename: patch.filename,
        severity,
        message:
          `${patch.filename} does not match patchPolicy.filenamePattern ` +
          `(${cfg.filenamePattern ?? DEFAULT_PATCH_POLICY_FILENAME_PATTERN}).`,
      },
    ];
  }

  const groups = match.groups;
  const orderRaw = groups?.['order'];
  const category = groups?.['category'];
  const slug = groups?.['slug'];
  if (!orderRaw || !category || slug === undefined) {
    return [
      {
        code: 'filename-captures',
        filename: patch.filename,
        severity,
        message:
          'patchPolicy.filenamePattern must expose named captures "order", "category", and "slug".',
      },
    ];
  }
  const order = Number.parseInt(orderRaw, 10);
  if (!Number.isInteger(order)) {
    return [
      {
        code: 'filename-captures',
        filename: patch.filename,
        severity,
        message: `${patch.filename} has a non-numeric order capture "${orderRaw}".`,
      },
    ];
  }
  return { order, category };
}

function evaluatePatchMetadata(
  cfg: PatchPolicyConfig,
  patch: PatchMetadata,
  severity: 'error' | 'warning'
): PatchPolicyIssue[] {
  const issues: PatchPolicyIssue[] = [];
  const parsed = parseFilenameWithPolicy(cfg, patch, severity);
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (parsed.order !== patch.order || parsed.category !== patch.category) {
    issues.push({
      code: 'filename-metadata-mismatch',
      filename: patch.filename,
      severity,
      message:
        `${patch.filename} encodes order/category ${parsed.order}/${parsed.category}, ` +
        `but patches.json records ${patch.order}/${patch.category}.`,
    });
  }

  if (cfg.requireDescription === true && patch.description.trim() === '') {
    issues.push({
      code: 'description-required',
      filename: patch.filename,
      severity,
      message: `${patch.filename} has an empty description, but patchPolicy.requireDescription is true.`,
    });
  }

  const reserved = reservedRangeForOrder(cfg, patch.order);
  if (reserved) {
    const allowed = reserved.allowed.find((entry) => entry.filename === patch.filename);
    if (!allowed) {
      issues.push({
        code: 'reserved-range',
        filename: patch.filename,
        severity,
        message:
          `${patch.filename} is in reserved range ${rangeLabel(reserved)}. ` +
          'Reserved ranges require an exact patchPolicy.reservedRanges[].allowed filename exception.',
      });
      return issues;
    }
    if (!allowed.adr && !allowed.documentation) {
      issues.push({
        code: 'reserved-documentation',
        filename: patch.filename,
        severity,
        message:
          `${patch.filename} is allowlisted for reserved range ${rangeLabel(reserved)}, ` +
          'but the allowlist entry must include either "adr" or "documentation".',
      });
    }
    if (allowed.files !== undefined) {
      const allowedFiles = new Set(allowed.files);
      const extraFiles = patch.filesAffected.filter((file) => !allowedFiles.has(file));
      if (extraFiles.length > 0) {
        issues.push({
          code: 'reserved-files',
          filename: patch.filename,
          severity,
          message:
            `${patch.filename} is allowlisted for reserved range ${rangeLabel(reserved)}, ` +
            `but touches file(s) outside its reserved allowlist: ${extraFiles.join(', ')}.`,
        });
      }
    }
    return issues;
  }

  const matchingRange = categoryRangeForOrder(cfg, patch.category, patch.order);
  if (!matchingRange) {
    const owner = anyRangeForOrder(cfg, patch.order);
    const expected = categoryRangeLabel(cfg.ranges, patch.category);
    const actual =
      owner !== null
        ? `${String(patch.order).padStart(3, '0')} is configured for ${owner.category} (${rangeLabel(owner)})`
        : `${String(patch.order).padStart(3, '0')} is outside all configured ranges`;
    issues.push({
      code: 'category-range',
      filename: patch.filename,
      severity,
      message:
        `${patch.category} patches must use ${expected}; ${actual}. ` +
        `Choose a ${patch.category} order in ${expected} or configure an explicit reserved-range exception.`,
    });
  }

  return issues;
}

function evaluateGaps(
  cfg: PatchPolicyConfig,
  patches: readonly PatchMetadata[],
  severity: 'error' | 'warning'
): PatchPolicyIssue[] {
  if (cfg.allowGaps !== false) return [];
  const issues: PatchPolicyIssue[] = [];
  for (const range of cfg.ranges) {
    const occupied = patches
      .filter((patch) => {
        return (
          patch.category === range.category &&
          patch.order >= range.from &&
          patch.order <= range.to &&
          reservedRangeForOrder(cfg, patch.order) === null
        );
      })
      .map((patch) => patch.order)
      .sort((a, b) => a - b);
    if (occupied.length <= 1) continue;
    const occupiedSet = new Set(occupied);
    const first = occupied[0] as number;
    const last = occupied[occupied.length - 1] as number;
    const missing: number[] = [];
    for (let order = first; order <= last; order++) {
      if (!occupiedSet.has(order) && reservedRangeForOrder(cfg, order) === null) {
        missing.push(order);
      }
    }
    if (missing.length > 0) {
      issues.push({
        code: 'numeric-gap',
        filename: `${range.category}:${rangeLabel(range)}`,
        severity,
        message:
          `${range.category} range ${rangeLabel(range)} has numeric gap(s): ` +
          missing.map((order) => String(order).padStart(3, '0')).join(', ') +
          '. patchPolicy.allowGaps is false.',
      });
    }
  }
  return issues;
}

function evaluateOrderCollisions(
  patches: readonly PatchMetadata[],
  severity: 'error' | 'warning'
): PatchPolicyIssue[] {
  const byOrder = new Map<number, PatchMetadata[]>();
  for (const patch of patches) {
    const matches = byOrder.get(patch.order) ?? [];
    matches.push(patch);
    byOrder.set(patch.order, matches);
  }

  const issues: PatchPolicyIssue[] = [];
  for (const [order, matches] of [...byOrder.entries()].sort((a, b) => a[0] - b[0])) {
    if (matches.length <= 1) continue;
    const filenames = matches.map((patch) => patch.filename).sort((a, b) => a.localeCompare(b));
    issues.push({
      code: 'order-collision',
      filename: String(order).padStart(3, '0'),
      severity,
      message:
        `patchPolicy requires unique numeric orders; order ${String(order).padStart(3, '0')} ` +
        `is used by: ${filenames.join(', ')}.`,
    });
  }
  return issues;
}

/** Evaluates an entire patch manifest against the configured policy. */
export function evaluatePatchPolicy(
  config: FireForgeConfig,
  manifest: PatchesManifest
): PatchPolicyIssue[] {
  const cfg = policy(config);
  if (!cfg) return [];
  const severity = issueSeverity(config);
  const issues = manifest.patches.flatMap((patch) => evaluatePatchMetadata(cfg, patch, severity));
  issues.push(...evaluateOrderCollisions(manifest.patches, severity));
  issues.push(...evaluateGaps(cfg, manifest.patches, severity));
  return issues;
}

/** Builds a sorted manifest snapshot from projected patch metadata. */
export function buildProjectedManifest(
  current: PatchesManifest | null,
  patches: PatchMetadata[]
): PatchesManifest {
  const next = patches
    .map((patch) => ({ ...patch, filesAffected: [...patch.filesAffected] }))
    .sort((a, b) => a.order - b.order || a.filename.localeCompare(b.filename));
  return {
    version: current?.version ?? 1,
    patches: next,
  };
}

/** Applies a filename/order rename projection to a manifest without mutating it. */
export function applyRenameMapToManifest(
  manifest: PatchesManifest,
  renameMap: ReadonlyMap<string, { newFilename: string; newOrder: number }>
): PatchesManifest {
  const ownerLookup = (oldFilename: string): string | undefined =>
    renameMap.get(oldFilename)?.newFilename;
  return buildProjectedManifest(
    manifest,
    manifest.patches.map((patch) => {
      // Staged-dependency owners reference other patches' filenames, so the
      // projection rewrites them on every row to mirror what
      // renumberPatchesInManifest persists.
      const withOwners = rewriteStagedDependencyOwners(patch, ownerLookup);
      const rename = renameMap.get(patch.filename);
      if (!rename) return withOwners;
      return {
        ...withOwners,
        filename: rename.newFilename,
        order: rename.newOrder,
      };
    })
  );
}

/** Enforces patch policy according to the configured mutation mode. */
export function enforcePatchPolicy(input: PatchPolicyEnforcementInput): void {
  if (!hasPatchPolicy(input.config)) return;
  const issues = evaluatePatchPolicy(input.config, input.manifest);
  if (issues.length === 0) return;

  const mode = mutationMode(input.config);
  const details = issues.map((issue) => {
    const hint = input.hints?.[issue.code];
    return `  [${issue.code}] ${issue.message}${hint ? `\n      → ${hint}` : ''}`;
  });
  if (mode === 'warn') {
    warn(`${input.command}: patch policy warning(s):`);
    for (const detail of details) warn(detail);
    return;
  }

  if (mode === 'force' && input.forceUnsafe === true) {
    warn(
      `${input.command}: bypassing patch policy violation(s) because --force-unsafe was provided:`
    );
    for (const detail of details) warn(detail);
    return;
  }

  const suffix =
    mode === 'force'
      ? '\n\nPass --force-unsafe only if you intentionally accept this policy violation.'
      : '';
  throw new InvalidArgumentError(
    `${input.command} would violate patchPolicy:\n${details.join('\n')}${suffix}`,
    mode === 'force' ? '--force-unsafe' : 'patchPolicy'
  );
}

/** Allocates the next available order inside the configured ranges for a category. */
export function allocatePolicyOrder(
  config: FireForgeConfig,
  patches: readonly PatchMetadata[],
  category: string
): number | null {
  const cfg = policy(config);
  if (!cfg) return null;
  const ranges = cfg.ranges
    .filter((range) => range.category === category)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  if (ranges.length === 0) return null;

  const occupied = new Set(patches.map((patch) => patch.order));
  const highestInRanges = patches.reduce<number | null>((highest, patch) => {
    if (!ranges.some((range) => patch.order >= range.from && patch.order <= range.to)) {
      return highest;
    }
    return highest === null ? patch.order : Math.max(highest, patch.order);
  }, null);

  const start = highestInRanges === null ? ranges[0]?.from : highestInRanges + 1;
  if (start === undefined) return null;
  for (const range of ranges) {
    for (let order = Math.max(start, range.from); order <= range.to; order++) {
      if (!occupied.has(order)) return order;
    }
  }
  return null;
}
