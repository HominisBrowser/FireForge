// SPDX-License-Identifier: EUPL-1.2
/**
 * Registration-only patch policy: the `patchPolicy` rules that need the
 * patch bodies, not just the manifest.
 *
 * - `upstreamAllowlist`: which upstream files (files no patch in the queue
 *   creates) a non-reserved patch may modify.
 * - `addOnly` allowlist entries: for shared registration files, a patch may
 *   only add lines, and each non-blank added line must carry the marker.
 * - `scopeRules`: limit a class of patch (a category, or a filename pattern
 *   such as `-tests\.patch$`) to the files its globs name.
 * - `verifyDocumentPaths`: every reserved allowlist entry's `adr` /
 *   `documentation` path must exist.
 *
 * Every rule is opt-in, and none can be evaluated from `patches.json`
 * alone, which is why they live apart from `patch-policy.ts`: that module
 * answers synchronously over a (possibly projected) manifest, this one reads
 * patch bodies and the filesystem. `verify` and `lint --per-patch` run both.
 */

import { join } from 'node:path';

import type { PatchesManifest } from '../types/commands/index.js';
import type {
  FireForgeConfig,
  PatchPolicyConfig,
  PatchPolicyUpstreamAllowEntry,
} from '../types/config.js';
import { pathExists } from '../utils/fs.js';
import { matchesAnyGlob } from '../utils/path-glob.js';
import { buildPatchQueueContext, type PatchQueueEntry } from './patch-lint-cross.js';
import { parseDiffSections } from './patch-parse.js';
import type { PatchPolicyIssue } from './patch-policy.js';

/** True when the policy sets any rule this module evaluates. */
export function hasPatchPolicyContentRules(config: FireForgeConfig): boolean {
  const cfg = config.patchPolicy;
  return (
    cfg !== undefined &&
    (cfg.upstreamAllowlist !== undefined ||
      cfg.scopeRules !== undefined ||
      cfg.verifyDocumentPaths === true)
  );
}

function normalizeAllowEntry(
  entry: string | PatchPolicyUpstreamAllowEntry
): PatchPolicyUpstreamAllowEntry {
  return typeof entry === 'string' ? { path: entry } : entry;
}

function isReservedOrder(cfg: PatchPolicyConfig, order: number): boolean {
  return (cfg.reservedRanges ?? []).some((range) => order >= range.from && order <= range.to);
}

/** Per-file edit summary of one patch body. */
interface FileEdit {
  added: string[];
  removed: string[];
  deleted: boolean;
  binary: boolean;
}

/**
 * The upstream files a patch body edits, keyed by path: every section that
 * does not create its file, minus paths some patch in the queue creates. A
 * rename counts against both of its paths.
 */
function collectUpstreamEdits(
  diff: string,
  queueCreated: ReadonlySet<string>
): Map<string, FileEdit> {
  const edits = new Map<string, FileEdit>();
  for (const section of parseDiffSections(diff)) {
    if (section.isNewFile) continue;
    const paths = new Set([section.sourcePath, section.targetPath]);
    for (const path of paths) {
      if (queueCreated.has(path)) continue;
      const edit = edits.get(path) ?? { added: [], removed: [], deleted: false, binary: false };
      edit.deleted ||= section.isDeletedFile;
      edit.binary ||= section.isBinary;
      for (const hunk of section.hunks) {
        for (const line of hunk.lines) {
          if (line.startsWith('+')) edit.added.push(line.slice(1));
          else if (line.startsWith('-')) edit.removed.push(line.slice(1));
        }
      }
      edits.set(path, edit);
    }
  }
  return edits;
}

/**
 * Why an add-only file's edit breaks the mode, or undefined when it holds.
 * Blank lines are free in both directions: they carry no registration.
 */
function addOnlyViolation(edit: FileEdit, marker: string): string | undefined {
  if (edit.deleted) return 'deletes the file';
  if (edit.binary) return 'carries a binary change';
  const removed = edit.removed.filter((line) => line.trim() !== '');
  if (removed.length > 0) {
    return `removes ${String(removed.length)} line(s), first: ${JSON.stringify(removed[0])}`;
  }
  const needle = marker.toLowerCase();
  const unmarked = edit.added.filter(
    (line) => line.trim() !== '' && !line.toLowerCase().includes(needle)
  );
  if (unmarked.length > 0) {
    return (
      `adds ${String(unmarked.length)} line(s) without the "${marker}" marker, ` +
      `first: ${JSON.stringify(unmarked[0])}`
    );
  }
  return undefined;
}

function evaluateUpstreamEdits(
  cfg: PatchPolicyConfig,
  filename: string,
  edits: ReadonlyMap<string, FileEdit>,
  severity: 'error' | 'warning'
): PatchPolicyIssue[] {
  const allowlist = (cfg.upstreamAllowlist ?? []).map(normalizeAllowEntry);
  const issues: PatchPolicyIssue[] = [];
  const outside: string[] = [];
  for (const [path, edit] of [...edits].sort(([a], [b]) => a.localeCompare(b))) {
    const matches = allowlist.filter((entry) => matchesAnyGlob(path, [entry.path]));
    if (matches.length === 0) {
      outside.push(path);
      continue;
    }
    // Strictest wins: any add-only match makes the file add-only.
    const addOnly = matches.find((entry) => entry.addOnly === true);
    if (!addOnly) continue;
    const marker = addOnly.marker ?? cfg.addOnlyMarker ?? '';
    const violation = addOnlyViolation(edit, marker);
    if (violation !== undefined) {
      issues.push({
        code: 'add-only',
        filename,
        severity,
        message:
          `${filename} edits ${path}, which patchPolicy.upstreamAllowlist marks add-only ` +
          `(added lines carrying "${marker}"), but ${violation}.`,
      });
    }
  }
  if (outside.length > 0) {
    issues.push({
      code: 'upstream-allowlist',
      filename,
      severity,
      message:
        `${filename} modifies upstream file(s) outside patchPolicy.upstreamAllowlist: ` +
        `${outside.join(', ')}. Move the change into a fork-owned file, or add a reviewed allowlist entry.`,
    });
  }
  return issues;
}

function evaluateScopeRules(
  cfg: PatchPolicyConfig,
  filename: string,
  category: string,
  files: readonly string[],
  severity: 'error' | 'warning'
): PatchPolicyIssue[] {
  const issues: PatchPolicyIssue[] = [];
  for (const [index, rule] of (cfg.scopeRules ?? []).entries()) {
    if (rule.category !== undefined && rule.category !== category) continue;
    if (rule.filenamePattern !== undefined && !new RegExp(rule.filenamePattern).test(filename)) {
      continue;
    }
    const outside = files.filter((file) => !matchesAnyGlob(file, rule.files));
    if (outside.length === 0) continue;
    issues.push({
      code: 'scope',
      filename,
      severity,
      message:
        `${filename} is scoped by patchPolicy.scopeRules[${String(index)}] to ` +
        `${rule.files.join(', ')}, but touches: ${outside.join(', ')}. ` +
        'Move those files to a patch of the class that owns them.',
    });
  }
  return issues;
}

async function evaluateDocumentPaths(
  cfg: PatchPolicyConfig,
  projectRoot: string,
  severity: 'error' | 'warning'
): Promise<PatchPolicyIssue[]> {
  if (cfg.verifyDocumentPaths !== true) return [];
  const issues: PatchPolicyIssue[] = [];
  for (const range of cfg.reservedRanges ?? []) {
    for (const allowed of range.allowed) {
      for (const [field, path] of [
        ['adr', allowed.adr],
        ['documentation', allowed.documentation],
      ] as const) {
        if (path === undefined || (await pathExists(join(projectRoot, path)))) continue;
        issues.push({
          code: 'reserved-document-missing',
          filename: allowed.filename,
          severity,
          message:
            `${allowed.filename}'s reserved-range allowlist entry names ${field} "${path}", ` +
            'which does not exist. Restore the document or correct the path.',
        });
      }
    }
  }
  return issues;
}

/**
 * Evaluates the body-dependent `patchPolicy` rules over a patch queue.
 *
 * @param config - Project configuration
 * @param projectRoot - Project root, for the document-path check
 * @param manifest - Current manifest (category and order per patch)
 * @param entries - Patch queue entries with their bodies
 * @returns Findings, in the same shape {@link evaluatePatchPolicy} returns
 */
export async function evaluatePatchPolicyContent(
  config: FireForgeConfig,
  projectRoot: string,
  manifest: PatchesManifest,
  entries: readonly PatchQueueEntry[]
): Promise<PatchPolicyIssue[]> {
  const cfg = config.patchPolicy;
  if (!cfg || !hasPatchPolicyContentRules(config)) return [];
  const severity = cfg.mutationMode === 'warn' ? 'warning' : 'error';
  const queueCreated = new Set<string>();
  for (const entry of entries) for (const file of entry.createdFiles) queueCreated.add(file);
  const bodies = new Map(entries.map((entry) => [entry.filename, entry.diff]));

  const issues: PatchPolicyIssue[] = [];
  for (const patch of manifest.patches) {
    const diff = bodies.get(patch.filename);
    if (cfg.upstreamAllowlist !== undefined && diff !== undefined) {
      if (!isReservedOrder(cfg, patch.order)) {
        const edits = collectUpstreamEdits(diff, queueCreated);
        issues.push(...evaluateUpstreamEdits(cfg, patch.filename, edits, severity));
      }
    }
    issues.push(
      ...evaluateScopeRules(cfg, patch.filename, patch.category, patch.filesAffected, severity)
    );
  }
  issues.push(...(await evaluateDocumentPaths(cfg, projectRoot, severity)));
  return issues;
}

/**
 * {@link evaluatePatchPolicyContent} for a caller without a queue context
 * in hand (`verify`): reads the patch bodies only when a body-dependent
 * rule is configured.
 */
export async function evaluatePatchPolicyContentForQueue(
  config: FireForgeConfig,
  projectRoot: string,
  patchesDir: string,
  manifest: PatchesManifest
): Promise<PatchPolicyIssue[]> {
  if (!hasPatchPolicyContentRules(config)) return [];
  const { entries } = await buildPatchQueueContext(patchesDir);
  return evaluatePatchPolicyContent(config, projectRoot, manifest, entries);
}
