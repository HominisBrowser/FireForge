// SPDX-License-Identifier: EUPL-1.2
/** Stable check identity excludes host-specific CLI launch prefixes and display paths. */
export interface CheckPlanEntry {
  name: string;
  kind: 'builtin' | 'extra';
  command: string;
  cwd: string;
  after: string[];
  timeoutMs?: number;
  skipReason?: string;
  skipKind?: 'config' | 'unavailable';
}
export interface FullCheckContract {
  version: number;
  source: string;
  configDigest: string;
  steps: CheckPlanEntry[];
  failOnSkipped: boolean;
  digest: string;
}
export interface ObservedCheckStep {
  name: string;
  kind: 'builtin' | 'extra';
  command: string;
  status: 'pass' | 'fail' | 'skipped';
  exitCode: number | null;
  durationMs: number;
  detail: string;
  skipKind?: 'config' | 'unavailable';
  timedOut?: true;
  startedAt?: string;
  finishedAt?: string;
  artifact?: string;
  artifactDigest?: string;
}
/** Validated observed execution, carried from owned check files into both sealed receipts. */
export interface FullCheckEvidence {
  version: number;
  source: string;
  contract: string;
  job: string;
  index: number;
  phase: string;
  jobs: number;
  startedAt: string;
  finishedAt: string;
  steps: ObservedCheckStep[];
  resultDigest: string;
}
export interface CheckExecutionDocument extends Omit<FullCheckEvidence, 'resultDigest'> {
  configDigest: string;
  plan: CheckPlanEntry[];
  verdict: { passed: boolean; steps: number; failed: string[]; skipped: string[]; reason?: string };
}
