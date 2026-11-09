// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { getNodeErrorCode, toError } from '../../utils/errors.js';
import { digest } from '../authored/git.js';
import { assertCheckOperation, assertFullCheckEvidence } from '../jobs/check-contract.js';
import type { StepEvidence } from '../jobs/schema.js';
import { readJson, writeDurable } from '../jobs/store.js';
import { withCarried } from './carry.js';
import type { BlockedRow, EvidenceRow, EvidenceStore, ToolIdentity } from './evidence-store.js';
import type { CurrentIdentity } from './identity.js';
import type { Obligation, ObligationKind, ProofPlan, ProofTier } from './types.js';

export { type EvidenceStore, readEvidence } from './evidence-store.js';

export type ObligationState =
  'passed' | 'accepted' | 'waived' | 'red' | 'stale' | 'blocked' | 'running' | 'outstanding';

/** A person's decision about one obligation of one source. Never machine evidence. */
export interface ProofDecision {
  kind: 'accepted' | 'waived';
  source: string;
  obligation: string;
  /** The tier and meaning it was made for: an obligation that comes to mean something else has none. */
  tier: ProofTier;
  meaning: string;
  /** The jobs whose outputs an acceptance was made on. */
  evidence?: Array<{ obligation: string; job: string }>;
  note: string;
  by: string;
  at: string;
}

/** The evidence and acceptances of the verified source a plan carries from. */
export interface CarriedEvidence {
  store: EvidenceStore;
  decisions: ReadonlyMap<string, ProofDecision>;
}

export interface ObligationStatus {
  id: string;
  kind: ObligationKind;
  state: ObligationState;
  reason: string;
  detail?: string;
  job?: string;
  /** Where the step that decided this wrote its captures or census. */
  output?: string;
  /** Reds this exact step has had on this source, the deciding one included. A later pass does not erase them. */
  reds: number;
  decision?: ProofDecision;
  /** The verified commit whose evidence or acceptance met it. */
  carried?: string;
  /** Only a slot holding this source can say whether its evidence is current. */
  needsSlot?: true;
}

export interface ProofStatus {
  complete: boolean;
  obligations: ObligationStatus[];
  /** Machine obligations met by a person's waiver rather than by running them. */
  waived: string[];
  failures: EvidenceStore['failures'];
  finished: number;
}

const decisionDirectory = (namespace: string, source: string): string =>
  join(namespace, 'proof-decisions', source);

/** Every decision recorded for a source at a tier, by obligation. */
export async function readDecisions(
  namespace: string,
  source: string,
  tier: ProofTier
): Promise<Map<string, ProofDecision>> {
  const directory = decisionDirectory(namespace, source);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return new Map();
    throw error;
  }
  const decisions = await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson<ProofDecision>(join(directory, name)))
  );
  return new Map(
    decisions
      .filter((decision) => decision.tier === tier)
      .map((decision) => [decision.obligation, decision])
  );
}

/** One decision per obligation of a source at a tier; a later one replaces it. */
export async function writeDecision(namespace: string, decision: ProofDecision): Promise<void> {
  await writeDurable(
    join(
      decisionDirectory(namespace, decision.source),
      `${digest({ tier: decision.tier, obligation: decision.obligation })}.json`
    ),
    decision
  );
}

/** What an obligation asks, so a decision about it lapses when it comes to ask something else. */
export const obligationMeaning = (tier: ProofTier, obligation: Obligation): string =>
  digest({
    tier,
    id: obligation.id,
    kind: obligation.kind,
    fingerprints: [...obligation.fingerprints].sort(),
    repeat: obligation.repeat ?? 1,
    always: obligation.always ?? false,
    ...(obligation.kind === 'accept'
      ? { reason: obligation.reason, evidence: obligation.evidence ?? [] }
      : {}),
  });

const RUNTIME_KINDS: readonly ObligationKind[] = [
  'build',
  'test',
  'lane',
  'stress',
  'control',
  'run',
];

type ToolPart = keyof ToolIdentity;

/**
 * Which tools reach which result, at task tier, so upgrading one re-runs only what
 * it can change. Lint and types are decided by the quality tools, which include
 * FireForge, Node and Git. A project check also runs the project's own scripts in
 * this locale. A browser test reads a package and the host, so ESLint cannot reach
 * it, and FireForge still decides what its log counts as. A build is bound by its
 * own identity and the toolchain, whatever ran it.
 */
const TASK_BINDINGS: Readonly<Record<ObligationKind, readonly ToolPart[]>> = {
  static: ['quality'],
  check: ['quality', 'project', 'environment'],
  build: [],
  test: ['executor', 'environment'],
  lane: ['executor', 'environment'],
  stress: ['executor', 'environment'],
  control: ['executor', 'environment'],
  run: ['executor', 'environment'],
  accept: [],
};

/** A gate is the claim a commit rests on: every result under one identity, equal to the present one. */
const GATE_BINDING: readonly ToolPart[] = ['executor', 'project', 'quality', 'environment'];

const PART_NAMES: Readonly<Record<ToolPart, string>> = {
  executor: 'FireForge',
  project: "the project's FireForge",
  quality: 'the quality tools (FireForge, Node, Git, TypeScript, ESLint, Prettier, node_modules)',
  environment: 'the platform, kernel or locale',
};

const NO_SLOT_ANSWER =
  'No slot holds this source, so nothing can measure its project and quality tools. Run fireforge prove, which brings one to it.';

/** Why a row's tools are not the present ones, as far as these parts go. */
function toolProblem(
  parts: readonly ToolPart[],
  tools: ToolIdentity | undefined,
  current: CurrentIdentity
): string | undefined {
  if (parts.length === 0) return undefined;
  if (tools === undefined) return 'It has no recorded tools.';
  if (current.unmeasured !== undefined)
    return `The coordinator's tools could not be measured: ${current.unmeasured}`;
  for (const part of ['executor', 'environment'] as const)
    if (parts.includes(part) && tools[part] !== current[part])
      return `${PART_NAMES[part]} changed since it ran.`;
  const fromSlot = (['project', 'quality'] as const).filter((part) => parts.includes(part));
  if (fromSlot.length === 0) return undefined;
  const same = (answer: CurrentIdentity['answers'][number], part: 'project' | 'quality'): boolean =>
    answer[part] === tools[part];
  if (current.answers.some((answer) => fromSlot.every((part) => same(answer, part))))
    return undefined;
  const exact = current.answers.find((answer) => answer.exact);
  if (exact === undefined) return NO_SLOT_ANSWER;
  const changed = fromSlot.filter((part) => !same(exact, part));
  return `${changed.map((part) => PART_NAMES[part]).join(' and ')} changed since it ran.`;
}

/** The rest of the evidence key: what every row has to share to be one proof of this plan. */
interface ProofIdentity {
  /** At a gate, the one tool identity every row has to hold. */
  tools: string | undefined;
  build: string | undefined;
}

function chooseIdentity(
  plan: ProofPlan,
  rows: readonly EvidenceRow[],
  current: CurrentIdentity
): ProofIdentity {
  const planned = new Set(plan.obligations.flatMap((obligation) => obligation.fingerprints));
  const passed = rows.filter((row) => row.status === 'passed' && planned.has(row.fingerprint));
  const tools =
    plan.tier === 'gate'
      ? passed.filter((row) => toolProblem(GATE_BINDING, row.tools, current) === undefined).at(-1)
          ?.tools
      : undefined;
  const build = passed
    .filter(
      (row) =>
        row.build?.compiled === plan.compiled &&
        (current.toolchain === undefined || row.build.toolchain === current.toolchain)
    )
    .at(-1)?.build;
  return {
    tools: tools === undefined ? undefined : digest(tools),
    build: build === undefined ? undefined : digest(build),
  };
}

const sameFiles = (a: readonly string[], b: readonly string[]): boolean =>
  digest([...a].sort()) === digest([...b].sort());

/** Why this passed step does not prove what the obligation asks, if it does not. */
function kindProblem(
  plan: ProofPlan,
  obligation: Obligation,
  row: EvidenceRow,
  evidence: StepEvidence
): string | undefined {
  const { kind, step } = obligation;
  // A final gate reads every tool byte rather than comparing a stat signature.
  if (plan.tier === 'gate' && (kind === 'check' || kind === 'build') && !row.finalGate)
    return 'It ran outside a final gate, so its tools were not re-read.';
  if (kind === 'check') {
    try {
      assertFullCheckEvidence(plan.check, evidence.check, plan.source);
      // A project can skip what its captured configuration says. These two a candidate never skips.
      assertCheckOperation('lint', evidence.check);
      assertCheckOperation('policy', evidence.check);
    } catch (error) {
      return toError(error).message;
    }
    return undefined;
  }
  if (kind === 'control') {
    const targets = evidence.controlProof?.mutations.flatMap((mutation) =>
      mutation.targets.map((target) => target.path.replace(/^engine\//, ''))
    );
    if (evidence.control !== 'caught') return 'The control did not catch its assertions.';
    if (obligation.always === true) return targets?.length ? undefined : 'It mutated nothing.';
    if (!targets?.some((path) => plan.controlPaths.includes(path)))
      return 'The control mutated nothing this change altered.';
    return undefined;
  }
  if (kind === 'test' || kind === 'lane' || kind === 'stress') {
    if (evidence.control !== undefined || evidence.controlProof !== undefined)
      return 'An expected red cannot prove a positive.';
    if (!sameFiles(evidence.selectedFiles, step?.expected?.files ?? []))
      return 'It ran a different roster.';
    const runs = evidence.completedRuns ?? [];
    const repeat = obligation.repeat ?? 1;
    if (runs.length !== repeat || runs.some((run, index) => run !== index + 1))
      return `It completed ${String(runs.length)} of ${String(repeat)} repeats.`;
  }
  return undefined;
}

/** Whether a row counts now, or why not. A row can pass and still not be evidence of this plan. */
function rowProblem(
  plan: ProofPlan,
  obligation: Obligation,
  row: EvidenceRow,
  identity: ProofIdentity,
  current: CurrentIdentity
): string | undefined {
  const gate = plan.tier === 'gate';
  const tools = toolProblem(
    gate ? GATE_BINDING : TASK_BINDINGS[obligation.kind],
    row.tools,
    current
  );
  if (tools !== undefined) return tools;
  if (gate && digest(row.tools) !== identity.tools) return 'Another tool identity is current.';
  const runtime = RUNTIME_KINDS.includes(obligation.kind);
  if ((runtime || gate) && current.toolchainProblem !== undefined) return current.toolchainProblem;
  if (runtime) {
    if (row.build === undefined) return 'It ran without a trusted build.';
    if (row.build.compiled !== plan.compiled)
      return 'It ran on a binary of other compiled inputs or another recipe.';
    if (current.toolchain !== undefined && row.build.toolchain !== current.toolchain)
      return 'The host toolchain changed since it ran.';
    if (digest(row.build) !== identity.build) return 'Another build identity is current.';
  }
  return row.evidence === undefined
    ? 'It has no evidence.'
    : kindProblem(plan, obligation, row, row.evidence);
}

/** A decision counts only for what it was made about: this meaning, at this tier, of the right kind. */
function decisionApplies(
  plan: ProofPlan,
  obligation: Obligation,
  decision: ProofDecision | undefined
): decision is ProofDecision {
  return (
    decision !== undefined &&
    decision.meaning === obligationMeaning(plan.tier, obligation) &&
    decision.kind === (obligation.kind === 'accept' ? 'accepted' : 'waived')
  );
}

/**
 * This source's decision about an obligation, else a person's acceptance on the
 * carried source, which still stands. A waiver there never carries.
 */
function decisionFor(
  plan: ProofPlan,
  obligation: Obligation,
  recorded: ProofDecision | undefined,
  carried: CarriedEvidence | undefined
): { decision?: ProofDecision; inherited?: true } {
  if (decisionApplies(plan, obligation, recorded)) return { decision: recorded };
  const decision = obligation.carried === true ? carried?.decisions.get(obligation.id) : undefined;
  return decision?.kind === 'accepted' && decisionApplies(plan, obligation, decision)
    ? { decision, inherited: true }
    : {};
}

function obligationStatus(
  plan: ProofPlan,
  obligation: Obligation,
  store: EvidenceStore,
  identity: ProofIdentity,
  current: CurrentIdentity,
  decided: { recorded?: ProofDecision; decision?: ProofDecision; inherited?: true }
): ObligationStatus {
  const rows = store.rows.filter(
    (row) =>
      obligation.fingerprints.includes(row.fingerprint) &&
      (row.carried !== true || obligation.carried === true)
  );
  const { recorded, decision, inherited } = decided;
  const from = plan.carry?.commit ?? '';
  const base = {
    id: obligation.id,
    kind: obligation.kind,
    reason: obligation.reason,
    reds: rows.filter((row) => row.status === 'red').length,
    ...(decision === undefined ? {} : { decision }),
  };
  const latest = rows.at(-1);
  const problem = (row: EvidenceRow): string | undefined =>
    rowProblem(plan, obligation, row, identity, current);
  const proved = rows
    .filter((row) => row.status === 'passed')
    .reverse()
    .find((row) => problem(row) === undefined);
  const undecided = (): ObligationStatus => {
    if (latest?.status === 'red')
      return {
        ...base,
        state: 'red',
        job: latest.job,
        ...(latest.output === undefined ? {} : { output: latest.output }),
        ...(latest.reason === undefined ? {} : { detail: latest.reason }),
      };
    let blocked: BlockedRow | undefined;
    for (const print of obligation.fingerprints) {
      const entry = store.blocked.get(print);
      if (entry !== undefined && (blocked === undefined || blocked.at < entry.at)) blocked = entry;
    }
    // Blocked says nothing about the step, so it reads only where nothing newer does.
    if (blocked !== undefined && (latest === undefined || latest.at < blocked.at))
      return { ...base, state: 'blocked', job: blocked.job, detail: blocked.reason };
    if (latest !== undefined) {
      const detail = problem(latest);
      return {
        ...base,
        state: 'stale',
        job: latest.job,
        ...(detail ? { detail } : {}),
        ...(detail === NO_SLOT_ANSWER ? { needsSlot: true as const } : {}),
      };
    }
    const live = obligation.fingerprints.map((print) => store.live.get(print)).find(Boolean);
    if (live !== undefined) return { ...base, state: 'running', job: live };
    return {
      ...base,
      state: 'outstanding',
      ...(recorded !== undefined && decision === undefined
        ? {
            detail: `A decision recorded by ${recorded.by} no longer applies: this obligation asks something else now.`,
          }
        : {}),
    };
  };
  // The newest result decides, so a red after a pass is a red: a pass only ever ends one before it.
  if (proved !== undefined && latest?.status !== 'red')
    return {
      ...base,
      state: 'passed',
      job: proved.job,
      ...(proved.output === undefined ? {} : { output: proved.output }),
      ...(proved.carried === true ? { carried: from } : {}),
    };
  if (decision !== undefined)
    return { ...base, state: decision.kind, ...(inherited === true ? { carried: from } : {}) };
  return undecided();
}

/** An acceptance stands on the runs it was made on: a further run made other outputs nobody looked at. */
function acceptanceProblem(
  decision: ProofDecision,
  statuses: readonly ObligationStatus[]
): string | undefined {
  for (const { obligation, job } of decision.evidence ?? []) {
    const status = statuses.find((entry) => entry.id === obligation);
    if (status?.state !== 'passed' || status.job !== job)
      return `It was accepted on job ${job} of ${obligation}, which is no longer what proves it. Look again and accept.`;
  }
  return undefined;
}

/**
 * Whether a plan is met right now: every obligation by machine evidence under the
 * present identity, or by a person's recorded decision, which stays visible as that.
 *
 * @param plan - The plan, recomputed for this source
 * @param own - The source's evidence
 * @param decisions - Its recorded human decisions at this tier, by obligation
 * @param current - The tools as they are now
 * @param carried - The evidence of the verified source the plan carries from, if it does
 */
export function evaluateProof(
  plan: ProofPlan,
  own: EvidenceStore,
  decisions: ReadonlyMap<string, ProofDecision>,
  current: CurrentIdentity,
  carried?: CarriedEvidence
): ProofStatus {
  const store = withCarried(plan, own, carried);
  const identity = chooseIdentity(plan, store.rows, current);
  const measured = plan.obligations.map((obligation) => {
    const recorded = decisions.get(obligation.id);
    return obligationStatus(plan, obligation, store, identity, current, {
      ...(recorded === undefined ? {} : { recorded }),
      ...decisionFor(plan, obligation, recorded, carried),
    });
  });
  const obligations = measured.map((entry): ObligationStatus => {
    const problem =
      entry.state === 'accepted' && entry.decision !== undefined
        ? acceptanceProblem(entry.decision, measured)
        : undefined;
    return problem === undefined ? entry : { ...entry, state: 'outstanding', detail: problem };
  });
  return {
    complete: obligations.every((entry) => ['passed', 'accepted', 'waived'].includes(entry.state)),
    obligations,
    waived: obligations.filter((entry) => entry.state === 'waived').map((entry) => entry.id),
    failures: store.failures,
    finished: store.finished,
  };
}
