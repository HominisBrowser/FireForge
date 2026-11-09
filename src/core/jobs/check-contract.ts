// SPDX-License-Identifier: EUPL-1.2
import { relative } from 'node:path';

import type { FireForgeConfig } from '../../types/config.js';
import { digest } from '../authored/git.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { buildCheckPlan, type CheckStepPlan } from '../check/steps.js';
import type {
  CheckPlanEntry,
  FullCheckContract,
  FullCheckEvidence,
  ObservedCheckStep,
} from './check-types.js';

const BUILTINS = ['status', 'verify', 'lint', 'typecheck', 'furnace-validate', 'token-coverage'];
/** Normalize only generated host paths; configured command content and dependencies remain exact. */
export function describeCheckPlan(plans: readonly CheckStepPlan[], root: string): CheckPlanEntry[] {
  return plans.map((plan) => ({
    name: plan.name,
    kind: plan.kind,
    command: plan.display.split(root).join('$PROJECT'),
    cwd: relative(root, plan.cwd) || '.',
    after: [...plan.after],
    ...(plan.timeoutMs === undefined ? {} : { timeoutMs: plan.timeoutMs }),
    ...(plan.skipReason === undefined ? {} : { skipReason: plan.skipReason }),
    ...(plan.skipKind === undefined ? {} : { skipKind: plan.skipKind }),
  }));
}
/** Derive the configured complete gate without depending on the caller's argv or executable location. */
function createFullCheckContract(
  source: string,
  config: FireForgeConfig,
  furnaceConfigured: boolean
): FullCheckContract {
  const root = '/captured-project';
  const body = {
    version: 1 as const,
    source,
    configDigest: digest(config),
    steps: describeCheckPlan(
      buildCheckPlan({
        projectRoot: root,
        config,
        furnaceConfigured,
        invocation: { command: 'qualified-node', prefix: ['qualified-fireforge'] },
      }),
      root
    ),
    failOnSkipped: config.check?.failOnSkipped === true,
  };
  return { ...body, digest: digest(body) };
}
/** Snapshot metadata determines both configuration and whether Furnace is part of the gate. */
export function fullCheckContractForSnapshot(snapshot: AuthoredSnapshot): FullCheckContract {
  return createFullCheckContract(
    snapshot.id,
    snapshot.config,
    snapshot.inputs.some((input) => input.path === 'furnace.json')
  );
}
/** Portable proof plans must contain the immutable configured roster, including every built-in. */
function assertFullCheckContract(
  contract: FullCheckContract | undefined,
  source: string
): asserts contract is FullCheckContract {
  if (
    !contract ||
    contract.version !== 1 ||
    contract.source !== source ||
    !Array.isArray(contract.steps) ||
    contract.steps.length < BUILTINS.length ||
    typeof contract.failOnSkipped !== 'boolean'
  )
    throw new Error('Full check contract is missing from the captured-source plan');
  const { digest: seal, ...body } = contract;
  if (
    !/^[a-f0-9]{64}$/.test(contract.configDigest) ||
    seal !== digest(body) ||
    new Set(contract.steps.map((step) => step.name)).size !== contract.steps.length ||
    BUILTINS.some(
      (name, index) =>
        contract.steps[index]?.name !== name || contract.steps[index].kind !== 'builtin'
    ) ||
    contract.steps.slice(BUILTINS.length).some((step) => step.kind !== 'extra') ||
    !contract.steps.some((step) => step.skipReason === undefined)
  )
    throw new Error('Invalid complete check contract');
}
function validTime(value: string | undefined): boolean {
  return value !== undefined && Number.isFinite(Date.parse(value));
}
/** Every required command must have run; only source-configured skips may replace execution. */
export function assertFullCheckEvidence(
  contract: FullCheckContract | undefined,
  evidence: FullCheckEvidence | undefined,
  source: string
): asserts evidence is FullCheckEvidence {
  assertFullCheckContract(contract, source);
  if (
    !evidence ||
    evidence.version !== 1 ||
    evidence.source !== source ||
    evidence.contract !== contract.digest ||
    !evidence.job ||
    !Number.isSafeInteger(evidence.index) ||
    evidence.index < 0 ||
    !evidence.phase ||
    !Number.isSafeInteger(evidence.jobs) ||
    evidence.jobs < 1 ||
    !validTime(evidence.startedAt) ||
    !validTime(evidence.finishedAt) ||
    Date.parse(evidence.finishedAt) < Date.parse(evidence.startedAt) ||
    !Array.isArray(evidence.steps) ||
    evidence.steps.length !== contract.steps.length ||
    !/^[a-f0-9]{64}$/.test(evidence.resultDigest)
  )
    throw new Error('Missing complete observed check evidence');
  for (const [index, expected] of contract.steps.entries()) {
    assertObservedCheckStep(expected, evidence.steps[index], contract.failOnSkipped, evidence);
  }
  assertCheckOrdering(contract, evidence);
}
function assertCheckOrdering(contract: FullCheckContract, evidence: FullCheckEvidence): void {
  for (const [index, step] of contract.steps.entries()) {
    const actual = evidence.steps[index];
    if (actual?.status !== 'pass') continue;
    for (const name of step.after) {
      const dependency = evidence.steps.find((item) => item.name === name);
      if (
        dependency?.status === 'pass' &&
        Date.parse(actual.startedAt ?? '') < Date.parse(dependency.finishedAt ?? '')
      )
        throw new Error('Observed check dependency completed after its consumer started');
    }
  }
}
function assertObservedCheckStep(
  expected: CheckPlanEntry,
  actual: ObservedCheckStep | undefined,
  failOnSkipped: boolean,
  range: FullCheckEvidence
): void {
  if (
    !actual ||
    actual.name !== expected.name ||
    actual.kind !== expected.kind ||
    actual.command !== expected.command ||
    !Number.isFinite(actual.durationMs) ||
    actual.durationMs < 0
  )
    throw new Error('Observed check roster differs from captured complete gate');
  if (expected.skipReason !== undefined) {
    if (
      actual.status !== 'skipped' ||
      actual.exitCode !== null ||
      actual.skipKind !== expected.skipKind ||
      actual.detail !== expected.skipReason ||
      (failOnSkipped && actual.skipKind !== 'config')
    )
      throw new Error('Check skip is not authorized by captured configuration');
  } else assertExecutedCheckStep(actual, range);
}
function assertExecutedCheckStep(actual: ObservedCheckStep, range: FullCheckEvidence): void {
  const started = Date.parse(actual.startedAt ?? ''),
    finished = Date.parse(actual.finishedAt ?? '');
  if (
    actual.status !== 'pass' ||
    actual.exitCode !== 0 ||
    actual.timedOut ||
    !Number.isFinite(started) ||
    !Number.isFinite(finished) ||
    finished < started ||
    started < Date.parse(range.startedAt) ||
    finished > Date.parse(range.finishedAt) ||
    !actual.artifact ||
    !/^step-\d+-check\/step-\d+\.ndjson$/.test(actual.artifact) ||
    !/^[a-f0-9]{64}$/.test(actual.artifactDigest ?? '')
  )
    throw new Error('Check command lacks observed successful execution/artifact evidence');
}

/** A configured skip can describe the full gate but cannot discharge an independently required validator. */
export function assertCheckOperation(kind: string, evidence: FullCheckEvidence): void {
  const required: Record<string, string> = {
    lint: 'lint',
    typecheck: 'typecheck',
    policy: 'verify',
  };
  const name = required[kind];
  if (
    name &&
    !evidence.steps.some(
      (step) => step.name === name && step.status === 'pass' && step.exitCode === 0
    )
  )
    throw new Error(`Required check step did not execute: ${name}`);
}
