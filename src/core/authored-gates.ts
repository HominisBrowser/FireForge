// SPDX-License-Identifier: EUPL-1.2
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import type { PatchLintIssue } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { getNodeErrorCode } from '../utils/errors.js';
import { isObject } from '../utils/validation.js';
import { captureAuthoredSnapshot } from './authored/capture.js';
import { resolveStaticDonor } from './authored/donor.js';
import { prepareFeedbackView } from './authored/feedback.js';
import { generateAuthoredDelta, upstreamDeltasFromDiff } from './authored/generate.js';
import { digest, readSourceBlobs } from './authored/git.js';
import { authenticateAuthoredSnapshot } from './authored/provider.js';
import type { AuthoredFile, AuthoredSnapshot } from './authored/types.js';
import { evaluateAuthoredSourcePolicy } from './authored-policy.js';
import { resolveSourceScope } from './authored-scope.js';
import { applyAuthoredWaivers, authoredWaivers } from './authored-waivers.js';
import { readAdmittedSnapshot } from './jobs/guard.js';
import { writeDurable } from './jobs/store.js';
import { lintExportedPatch, lintPatchSize, measurePatchSize } from './patch-lint.js';
import { lintQualityIdentity } from './patch-lint-cache.js';
import { invokePatchLintCheckJsGrouped, runCheckJsTestFilesGrouped } from './patch-lint-checkjs.js';
import { lintPatchQueue, type PatchQueueContext } from './patch-lint-cross.js';
import { buildModifiedFileAdditionsFromDiff } from './patch-lint-diff.js';
import { isTestScriptFile } from './patch-lint-ownership.js';
import { evaluateAuthoredUpstreamPolicy } from './patch-policy-content.js';

export interface SourceGateContext {
  snapshot: AuthoredSnapshot;
  pristineRepository: string;
  engine: string;
  projectRoot: string;
  phase: string;
}

export interface SourceGateOptions {
  /** A captured handle to judge; otherwise the checkout is captured without retaining refs. */
  snapshot?: unknown;
  pristineRepository?: string;
  allowDirtyRoot?: boolean;
  onNotice?: (message: string) => void;
}

/** The phase of static feedback from a snapshot; results of it are never sealed job evidence. */
const FEEDBACK_PHASE = 'off-slot-feedback';

async function feedbackContext(
  projectRoot: string,
  options: SourceGateOptions
): Promise<SourceGateContext> {
  const pristineRepository = await resolveStaticDonor(projectRoot, options.pristineRepository);
  const snapshot =
    options.snapshot !== undefined
      ? await authenticateAuthoredSnapshot(options.snapshot, pristineRepository)
      : await captureAuthoredSnapshot({
          projectRoot,
          pristineRepository,
          retain: false,
          ...(options.allowDirtyRoot ? { allowDirtyRoot: true } : {}),
          ...(options.onNotice ? { onNotice: options.onNotice } : {}),
        });
  const view = await prepareFeedbackView({ projectRoot, snapshot, pristineRepository });
  return {
    snapshot,
    pristineRepository,
    projectRoot: view,
    engine: join(view, 'engine'),
    phase: FEEDBACK_PHASE,
  };
}

/**
 * Inside a job, the admitted immutable slot. Elsewhere, a private view of a snapshot, so static
 * checks need no slot, job or namespace; only a sealed job produces evidence.
 */
export async function authoredGateContext(
  projectRoot: string,
  options: SourceGateOptions = {}
): Promise<SourceGateContext> {
  if (!process.env['FIREFORGE_JOB_ID']) return feedbackContext(projectRoot, options);
  const context = await readAdmittedSnapshot(projectRoot);
  const snapshot = await authenticateAuthoredSnapshot(context.snapshot, context.pristineRepository);
  return {
    snapshot,
    pristineRepository: context.pristineRepository,
    projectRoot,
    engine: join(projectRoot, 'engine'),
    phase: context.phase,
  };
}

/**
 * What this project wrote: created files and generated ones with no upstream
 * counterpart. An override's postimage is upstream code with a change in it, whose
 * delta the content rules judge; strict typing it would hold upstream to a bar it
 * was never written for.
 */
function createdSourceFiles(snapshot: AuthoredSnapshot): AuthoredFile[] {
  return snapshot.files.filter(
    (file) => file.kind === 'created' || (file.kind === 'generated' && !file.declaration)
  );
}

/** Adapt pure existing content checks to a single atomic authored source universe. */
async function sourceLintContext(
  context: SourceGateContext,
  diff: string
): Promise<PatchQueueContext> {
  const created = createdSourceFiles(context.snapshot).flatMap((file) =>
    file.blob ? [{ ...file, blob: file.blob }] : []
  );
  const blobs = await readSourceBlobs(
    context.snapshot.repository,
    created.map((file) => file.blob)
  );
  const newFiles = new Map(
    created.flatMap((file) => {
      const bytes = blobs.get(file.blob);
      if (!bytes || bytes.includes(0)) return [];
      try {
        return [
          [
            file.path,
            new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes),
          ] as const,
        ];
      } catch {
        return [];
      }
    })
  );
  const config = context.snapshot.config;
  return {
    entries: [
      {
        filename: 'authored-source',
        order: 0,
        metadata: null,
        diff,
        newFiles,
        createdFiles: new Set(created.map((file) => file.path)),
        modifiedFileAdditions: buildModifiedFileAdditionsFromDiff(diff),
      },
    ],
    ...(config.patchLint?.tokenScales ? { tokenScales: config.patchLint.tokenScales } : {}),
    ...(config.patchLint?.forwardRegistration
      ? { forwardRegistration: config.patchLint.forwardRegistration }
      : {}),
  };
}

/** Strict module/test checking uses authored paths as the complete resolution universe. */
export async function checkAuthoredTypes(
  context: SourceGateContext,
  scope?: ReadonlySet<string>
): Promise<PatchLintIssue[]> {
  if (context.snapshot.config.patchLint?.checkJs !== true) return [];
  const cacheDir = join(context.projectRoot, '.fireforge', 'source-types');
  // Keyed on the captured contents (blob ids), not only the snapshot id, so a
  // changed input can never be answered from another run's result.
  const contents = context.snapshot.files.map((file) => [file.path, file.kind, file.blob ?? null]);
  const cache = join(
    cacheDir,
    `${digest({ source: context.snapshot.id, contents, tools: await lintQualityIdentity(context.projectRoot), phase: context.phase, scope: scope === undefined ? null : [...scope].sort(), adapter: 'source-types-v3' })}.json`
  );
  if (!context.phase) throw new GeneralError('authored-unowned-type-phase');
  try {
    const value: unknown = JSON.parse(await readFile(cache, 'utf8'));
    if (!Array.isArray(value)) throw new GeneralError('authored-invalid-type-cache');
    return value.map((row: unknown): PatchLintIssue => {
      if (
        !isObject(row) ||
        typeof row['file'] !== 'string' ||
        typeof row['check'] !== 'string' ||
        typeof row['message'] !== 'string' ||
        (row['severity'] !== 'error' &&
          row['severity'] !== 'warning' &&
          row['severity'] !== 'notice')
      )
        throw new GeneralError('authored-invalid-type-cache');
      return {
        file: row['file'],
        check: row['check'],
        message: row['message'],
        severity: row['severity'],
      };
    });
  } catch (error) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
  }
  const issues = await computeAuthoredTypes(context, scope);
  await writeDurable(cache, issues);
  await pruneTypeCache(cacheDir, cache);
  return issues;
}

/** Newest type-check results kept per directory. */
const TYPE_CACHE_KEEP = 32;

/** Drops the oldest results beyond {@link TYPE_CACHE_KEEP}, never the one just written. */
async function pruneTypeCache(directory: string, keepFile: string): Promise<void> {
  try {
    const entries = await Promise.all(
      (await readdir(directory))
        .filter((name) => name.endsWith('.json'))
        .map(async (name) => {
          const path = join(directory, name);
          return { path, mtimeMs: (await stat(path)).mtimeMs };
        })
    );
    const stale = entries
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(TYPE_CACHE_KEEP)
      .filter((entry) => entry.path !== keepFile);
    await Promise.all(stale.map((entry) => rm(entry.path, { force: true })));
  } catch {
    // Pruning is housekeeping; a concurrent run removing the same file is fine.
  }
}

async function computeAuthoredTypes(
  context: SourceGateContext,
  scope?: ReadonlySet<string>
): Promise<PatchLintIssue[]> {
  const patchLint = context.snapshot.config.patchLint;
  if (patchLint === undefined) return [];
  const files = createdSourceFiles(context.snapshot).map((file) => file.path);
  const modules = new Set(files.filter((path) => path.endsWith('.sys.mjs')));
  const sys = await invokePatchLintCheckJsGrouped(
    context.engine,
    modules,
    patchLint,
    context.projectRoot,
    scope
  );
  const issues = [...sys.global, ...[...sys.byFile.values()].flat()];
  if (patchLint.checkJsTestFiles === true) {
    const tests = await runCheckJsTestFilesGrouped(
      context.engine,
      new Set(files.filter(isTestScriptFile)),
      patchLint,
      context.projectRoot,
      scope,
      () => new Set(files.filter((path) => /\.(?:mjs|jsm|js)$/.test(path)))
    );
    issues.push(...tests.global, ...[...tests.byFile.values()].flat());
  }
  return issues;
}

/** All content/file/type/registration rules remain; created patch budgets/order do not. */
export async function lintAuthoredSource(
  projectRoot: string,
  selected: readonly string[] = [],
  options: SourceGateOptions = {}
): Promise<PatchLintIssue[]> {
  const context = await authoredGateContext(projectRoot, options);
  const paths = context.snapshot.files.map((file) => file.path);
  const scope =
    selected.length === 0 ? undefined : resolveSourceScope(paths, selected, 'lint path');
  const policyIssues = await evaluateAuthoredSourcePolicy(context.snapshot);
  if (policyIssues.some((issue) => issue.severity === 'error')) return policyIssues;
  const diff = await generateAuthoredDelta(context.snapshot, {
    pristineRepository: context.pristineRepository,
  });
  const config: FireForgeConfig = context.snapshot.config;
  const sourceContext = await sourceLintContext(context, diff);
  const typeIssues = await checkAuthoredTypes(context, scope);
  const issues = await lintExportedPatch(context.engine, paths, diff, config, {
    skipPatchSize: true,
    patchQueueCtx: sourceContext,
    precomputedCheckJs: typeIssues,
  });
  issues.push(...(await verifyAuthoredContext(context, diff, sourceContext, policyIssues)));
  const unwaived = applyAuthoredWaivers(issues, await authoredWaivers(context.snapshot));
  if (scope === undefined) return unwaived;
  // Global failures remain visible even under a focused file view.
  const known = new Set(paths);
  return unwaived.filter((issue) => !known.has(issue.file) || scope.has(issue.file));
}

async function verifyAuthoredContext(
  context: SourceGateContext,
  diff: string,
  sourceContext: PatchQueueContext,
  policyIssues?: readonly PatchLintIssue[]
): Promise<PatchLintIssue[]> {
  const issues = [
    ...lintPatchQueue(sourceContext),
    ...(policyIssues ?? (await evaluateAuthoredSourcePolicy(context.snapshot))),
  ];
  const deltas = upstreamDeltasFromDiff(context.snapshot, diff);
  const upstream = await evaluateAuthoredUpstreamPolicy(
    context.snapshot.config,
    context.projectRoot,
    deltas,
    new Set(createdSourceFiles(context.snapshot).map((file) => file.path))
  );
  issues.push(
    ...upstream.map((issue) => ({
      file: issue.filename,
      check: issue.code,
      severity: issue.severity,
      message: issue.message,
    }))
  );
  const groups = new Map<string, typeof deltas>();
  const waivers = await authoredWaivers(context.snapshot);
  for (const delta of deltas)
    groups.set(delta.declaration.component, [
      ...(groups.get(delta.declaration.component) ?? []),
      delta,
    ]);
  for (const group of groups.values()) {
    const paths = group.map((entry) => entry.path);
    const body = group.map((entry) => entry.diff).join('');
    const component = group[0]?.declaration.component;
    const tier = waivers.find((waiver) => waiver.component === component)?.tier;
    issues.push(
      ...lintPatchSize(
        paths,
        await measurePatchSize(context.engine, body, paths, context.snapshot.config),
        tier,
        context.snapshot.config
      ).map((issue) => ({ ...issue, file: component ?? issue.file }))
    );
  }
  // The source provider represents one atomic universe, with no artificial ordering.
  if (!diff.trim() && context.snapshot.files.length > 0)
    throw new GeneralError(
      'authored-empty-delta: nonempty source snapshot produced no reviewable changes'
    );
  return applyAuthoredWaivers(issues, waivers);
}

/** Verify ownership/policy/registration invariants without regenerating a patch queue. */
export async function verifyAuthoredSource(
  projectRoot: string,
  options: SourceGateOptions = {}
): Promise<PatchLintIssue[]> {
  const context = await authoredGateContext(projectRoot, options);
  const diff = await generateAuthoredDelta(context.snapshot, {
    pristineRepository: context.pristineRepository,
  });
  return verifyAuthoredContext(context, diff, await sourceLintContext(context, diff));
}
