// SPDX-License-Identifier: EUPL-1.2
import { resolve } from 'node:path';

import type { Command } from 'commander';

import { wantsMachineOutput } from '../cli-usage-error.js';
import { digest } from '../core/authored/git.js';
import { captureAuthoredSnapshot } from '../core/authored/index.js';
import { authenticateAuthoredSnapshot } from '../core/authored/provider.js';
import type { AuthoredSnapshot } from '../core/authored/types.js';
import { loadConfig } from '../core/config.js';
import { ownerLabel, submitJob, waitForJob } from '../core/jobs/client.js';
import { coordinatorNamespace } from '../core/jobs/guard.js';
import { type JobView, normalizeRequest } from '../core/jobs/schema.js';
import type { SlotRecord } from '../core/jobs/slot-types.js';
import { readSlots } from '../core/jobs/slots.js';
import {
  obligationMeaning,
  type ObligationStatus,
  type ProofDecision,
  type ProofStatus,
  writeDecision,
} from '../core/proof/evidence.js';
import { measureTools } from '../core/proof/identity.js';
import { composeProofJob, namedObligation } from '../core/proof/job.js';
import {
  advanceVerified,
  commitTree,
  publicationRecords,
  retainedSnapshotsOfTree,
} from '../core/proof/publish.js';
import { declaredInputs, planCapturedSource } from '../core/proof/snapshot.js';
import { cleanGateProbe, currentStatus } from '../core/proof/status.js';
import type { ProofPlan, ProofTier } from '../core/proof/types.js';
import { CommandError, GeneralError, InvalidArgumentError } from '../errors/base.js';
import { ExitCode } from '../errors/codes.js';
import { UnknownSlotError } from '../errors/job.js';
import type { CommandContext } from '../types/cli.js';
import {
  assertSourceMode,
  exitWithState,
  jobAction,
  output,
  printJob,
  pristineDonor,
} from './job-support.js';
import { assertComplete, met, printStatus, short } from './prove-report.js';

interface PlanOptions {
  tier: string;
  base?: string;
  test?: string[];
  path?: string[];
  mode?: string;
  control?: string;
  controlTest?: string;
  expect?: string[];
  namespace?: string;
  /** `run` and `plan` only: one gate obligation to run alone. */
  lane?: string;
  /** `run` and `plan` only: the slot every job goes to, as `job run --slot` names one. */
  slot?: string;
}

interface ProofContext {
  namespace: string;
  root: string;
  snapshot: AuthoredSnapshot;
  plan: ProofPlan;
}

function tierOf(value: string): ProofTier {
  if (value !== 'task' && value !== 'gate')
    throw new InvalidArgumentError(`--tier must be task or gate, not ${value}`, '--tier');
  return value;
}

function modeOf(value: string | undefined): ProofPlan['mode'] {
  if (value === undefined) return undefined;
  if (value !== 'dev' && value !== 'debug' && value !== 'release')
    throw new InvalidArgumentError(`--mode must be dev, debug or release, not ${value}`, '--mode');
  return value;
}

function controlOf(
  options: PlanOptions
): { diff: string; test: string; assertions: string[] } | undefined {
  const { control, controlTest, expect } = options;
  if (control === undefined && controlTest === undefined && expect === undefined) return undefined;
  if (control === undefined || controlTest === undefined || !expect?.length)
    throw new InvalidArgumentError(
      '--control, --control-test and --expect go together: a mutation, the test it reddens and the assertions that have to fail',
      '--control'
    );
  return { diff: control, test: controlTest, assertions: expect };
}

const namespaceOf = (options: { namespace?: string }): string =>
  resolve(options.namespace ?? coordinatorNamespace());

async function loadProof(
  ctx: CommandContext,
  options: PlanOptions,
  retain: boolean
): Promise<ProofContext> {
  const tier = tierOf(options.tier);
  const mode = modeOf(options.mode);
  const control = controlOf(options);
  const namespace = namespaceOf(options);
  const root = ctx.getProjectRoot();
  await assertSourceMode(root);
  const donor = await pristineDonor(namespace, root);
  const snapshot = await captureAuthoredSnapshot({
    projectRoot: root,
    intendedPaths: [
      ...(options.path ?? []),
      ...(options.control === undefined ? [] : [options.control]),
      ...declaredInputs((await loadConfig(root)).proof),
    ],
    pristineRepository: donor,
    retain,
    onNotice: (message) => {
      process.stderr.write(`${message}\n`);
    },
  });
  const plan = await planCapturedSource({
    root,
    snapshot,
    tier,
    cleanGate: cleanGateProbe(namespace, root, donor),
    ...(options.base === undefined ? {} : { base: options.base }),
    ...(options.test === undefined ? {} : { tests: options.test }),
    ...(control === undefined ? {} : { control }),
    ...(mode === undefined ? {} : { mode }),
  });
  return { namespace, root, snapshot, plan };
}

function planOptions(command: Command): Command {
  return command
    .option('--tier <tier>', 'task or gate', 'task')
    .option('--base <ref>', 'Compare with this commit rather than the default base')
    .option('--test <path...>', 'Further tests to run; adds to what the change requires')
    .option('--path <path...>', 'Further paths to capture beside the source and project inputs')
    .option('--mode <mode>', 'The build recipe evidence has to be of: dev, debug or release')
    .option('--control <diff>', 'A mutation this change has to be caught by')
    .option('--control-test <path>', 'The test that has to catch it')
    .option('--expect <assertion...>', 'The assertions it has to redden')
    .option('--namespace <path>', 'Private coordinator namespace');
}

/**
 * Project and quality tools live in a slot's root, and only a slot holding this source
 * can say they changed. Any job brings one to it, so a cheap one saves rerunning what
 * may well still be current. Its result does not matter: only that the slot now holds this source.
 */
async function bringSlotToSource(
  namespace: string,
  snapshot: AuthoredSnapshot,
  plan: ProofPlan,
  finished: number,
  slot: string | undefined
): Promise<JobView> {
  const request = normalizeRequest(
    {
      key: `prove-measure-${digest({ plan: plan.id, finished, ...named(slot) }).slice(0, 40)}`,
      steps: [{ command: 'status', args: ['--raw'] }],
      ...named(slot),
    },
    snapshot.id
  );
  const job = await submitJob(namespace, request, snapshot);
  process.stderr.write(`Job ${job.id} brings a slot to this source, to measure its tools\n`);
  return job;
}

const named = (slot: string | undefined): { slot?: string } => (slot === undefined ? {} : { slot });

/**
 * The slots a proof job may go to: the one `--slot` names, so the job is composed
 * for what that slot holds, or every slot for the scheduler to choose from.
 *
 * @throws When the named slot does not exist
 */
async function proofSlots(namespace: string, slot: string | undefined): Promise<SlotRecord[]> {
  const slots = await readSlots(namespace);
  if (slot === undefined) return slots;
  const found = slots.filter((entry) => entry.id === slot);
  if (found.length === 0)
    throw new UnknownSlotError(
      `Slot ${slot} does not exist; fireforge slot list shows what exists`
    );
  return found;
}

/** Waits for jobs already running this plan's steps, which a second run would only repeat. */
async function waitForLive(namespace: string, obligations: ObligationStatus[]): Promise<void> {
  const live = new Set(
    obligations.flatMap((entry) =>
      entry.state === 'running' && entry.job !== undefined ? [entry.job] : []
    )
  );
  for (const job of live) {
    process.stderr.write(`Waiting for job ${job}, which runs this plan's steps\n`);
    await waitForJob(namespace, job, Number.POSITIVE_INFINITY);
  }
}

async function runProof(
  ctx: CommandContext,
  options: PlanOptions & { wait: boolean }
): Promise<void> {
  const { namespace, snapshot, plan } = await loadProof(ctx, options, true);
  const lane = options.lane === undefined ? undefined : namedObligation(plan, options.lane);
  const mine = (entry: ObligationStatus): boolean => lane === undefined || entry.id === lane;
  // A slot that does not exist refuses before anything is submitted.
  if (options.slot !== undefined) await proofSlots(namespace, options.slot);
  let before = await currentStatus(namespace, plan);
  if (before.status.obligations.some((entry) => entry.needsSlot === true)) {
    const measure = await bringSlotToSource(
      namespace,
      snapshot,
      plan,
      before.status.finished,
      options.slot
    );
    if (!options.wait) {
      printJob(measure);
      return;
    }
    await waitForJob(namespace, measure.id, Number.POSITIVE_INFINITY);
    before = await currentStatus(namespace, plan);
  }
  const composed = composeProofJob(
    plan,
    before.status.obligations,
    await proofSlots(namespace, options.slot),
    before.identity.toolchain,
    lane
  );
  let finished: JobView | undefined;
  if (composed.steps.length > 0) {
    const request = normalizeRequest(
      {
        // Equal while nothing finished, so a retry or a second caller attaches; new work after that.
        key: `prove-${digest({ plan: plan.id, steps: composed.steps, finished: before.status.finished, ...named(options.slot) }).slice(0, 40)}`,
        steps: composed.steps,
        ...named(options.slot ?? composed.slot),
        // A gate goes on past a red step, so one run gives every obligation its verdict.
        ...(plan.tier === 'gate' ? { finalGate: true, continueOnFailure: true } : {}),
        ...(plan.mode === undefined
          ? {}
          : { build: { mode: plan.mode, brand: snapshot.config.binaryName } }),
      },
      snapshot.id
    );
    const job = await submitJob(namespace, request, snapshot);
    process.stderr.write(`Job ${job.id} submitted\n`);
    for (const note of composed.notes) process.stderr.write(`  note: ${note}\n`);
    if (!options.wait) {
      printJob(job);
      return;
    }
    finished = await waitForJob(namespace, job.id, Number.POSITIVE_INFINITY, (reason) => {
      process.stderr.write(`Job ${job.id} waiting: ${reason}\n`);
    });
    // A refusal leaves no red row, so this is the one place its reason reaches the caller.
    if (finished.refused === true)
      process.stderr.write(`Job ${job.id} refused: ${finished.reason ?? 'no reason recorded'}\n`);
  }
  if (options.wait)
    await waitForLive(
      namespace,
      (await currentStatus(namespace, plan)).status.obligations.filter(mine)
    );
  const { status } = await currentStatus(namespace, plan);
  printStatus(plan, status, { notes: composed.notes });
  if (finished !== undefined) exitWithState(finished);
  if (lane === undefined ? !status.complete : !status.obligations.filter(mine).every(met))
    throw new CommandError(ExitCode.GENERAL_ERROR);
}

const laneOption = (command: Command): Command =>
  command
    .option(
      '--lane <id>',
      'Run only this gate obligation (a lane ID, or stress:, run:, control: and its ID) and the build it needs'
    )
    .option('--slot <name>', 'Run every job on this slot, rather than where the scheduler picks');

function registerRun(prove: Command, ctx: CommandContext): void {
  laneOption(planOptions(prove.command('run', { isDefault: true })))
    .description('Capture, plan, run what has no evidence yet, and report. The default action.')
    .option('--no-wait', 'Return once the job is submitted; prove status reports it')
    .action(jobAction(ctx, (options: PlanOptions & { wait: boolean }) => runProof(ctx, options)));
}

function registerPlan(prove: Command, ctx: CommandContext): void {
  laneOption(planOptions(prove.command('plan')))
    .description('Show the obligations and the job prove would run, without running it')
    .action(
      jobAction(ctx, async (options: PlanOptions) => {
        const { namespace, plan } = await loadProof(ctx, options, false);
        const lane = options.lane === undefined ? undefined : namedObligation(plan, options.lane);
        const { status, identity } = await currentStatus(namespace, plan);
        const composed = composeProofJob(
          plan,
          status.obligations,
          await proofSlots(namespace, options.slot),
          identity.toolchain,
          lane
        );
        printStatus(plan, status, { steps: composed.steps, notes: composed.notes });
      })
    );
}

function registerStatus(prove: Command, ctx: CommandContext): void {
  planOptions(prove.command('status'))
    .description('Report the evidence for this source across every job')
    .option('--complete', 'Refuse unless every obligation is met')
    .option('--allow-waived', 'At a gate, count waived machine obligations as met')
    .action(
      jobAction(
        ctx,
        async (options: PlanOptions & { complete?: boolean; allowWaived?: boolean }) => {
          const { namespace, plan } = await loadProof(ctx, options, false);
          const { status } = await currentStatus(namespace, plan, {
            claim: options.complete === true,
          });
          const claim = (): void => {
            if (options.complete) assertComplete(plan, status, options.allowWaived === true);
          };
          if (wantsMachineOutput()) claim();
          printStatus(plan, status);
          claim();
        }
      )
    );
}

/** What a person is accepting: refused until what they looked at has passed on this very source. */
function acceptanceEvidence(
  obligation: string,
  evidence: readonly string[],
  status: ProofStatus
): { entries: NonNullable<ProofDecision['evidence']>; shown: ObligationStatus[] } {
  const shown = evidence.map((id) => status.obligations.find((entry) => entry.id === id));
  const unmet = evidence.filter((_, index) => shown[index]?.state !== 'passed');
  if (unmet.length > 0)
    throw new GeneralError(
      `proof-accept-evidence: ${obligation} looks at ${unmet.join(', ')}, which has not passed on this source. Run: fireforge prove --tier gate`
    );
  const passed = shown.filter((entry): entry is ObligationStatus => entry !== undefined);
  return {
    shown: passed,
    entries: passed.map((entry) => ({ obligation: entry.id, job: entry.job ?? '' })),
  };
}

function registerDecision(
  prove: Command,
  ctx: CommandContext,
  name: 'accept' | 'waive',
  description: string
): void {
  const command = planOptions(prove.command(`${name} <obligation>`))
    .description(description)
    .requiredOption('--note <text>', 'Why, in words a reviewer can check');
  if (name === 'waive')
    command.option('--allow-machine', 'State that this skips something a machine would prove');
  command.action(
    jobAction(
      ctx,
      async (
        obligation: string,
        options: PlanOptions & { note: string; allowMachine?: boolean }
      ) => {
        const { namespace, plan } = await loadProof(ctx, options, false);
        // A declaration's acceptance has an ID of its own, so `scene` means `accept:scene`.
        const planned = plan.obligations.find(
          (entry) =>
            entry.id === obligation || (name === 'accept' && entry.id === `accept:${obligation}`)
        );
        if (planned === undefined)
          throw new GeneralError(
            `proof-unknown-obligation: ${obligation} is not in this ${plan.tier} plan: ${plan.obligations.map((entry) => entry.id).join(', ')}`
          );
        if (name === 'accept' && planned.kind !== 'accept')
          throw new GeneralError(
            `proof-accept-machine-obligation: ${planned.id} is proved by running it. Run it; a waiver takes waive --allow-machine and reads as one.`
          );
        if (name === 'waive' && planned.kind === 'accept')
          throw new GeneralError(
            `proof-waive-acceptance: ${obligation} is a person's call. Look at it and accept it: nothing else satisfies it.`
          );
        if (name === 'waive' && options.allowMachine !== true)
          throw new GeneralError(
            `proof-waive-machine-obligation: ${obligation} is proved by running it. To skip it anyway, state that with --allow-machine; at a gate, publish then refuses without --allow-waived.`
          );
        if (options.note.trim() === '')
          throw new InvalidArgumentError('--note must say why', '--note');
        const accepted =
          name === 'accept'
            ? acceptanceEvidence(
                planned.id,
                planned.evidence ?? [],
                (await currentStatus(namespace, plan)).status
              )
            : undefined;
        for (const entry of accepted?.shown ?? [])
          process.stderr.write(
            `Accepting on ${entry.id}: job=${entry.job ?? ''}${entry.output === undefined ? '' : ` output=${entry.output}`}\n`
          );
        const decision: ProofDecision = {
          kind: name === 'accept' ? 'accepted' : 'waived',
          source: plan.source,
          obligation: planned.id,
          tier: plan.tier,
          meaning: obligationMeaning(plan.tier, planned),
          ...(accepted === undefined || accepted.entries.length === 0
            ? {}
            : { evidence: accepted.entries }),
          note: options.note,
          by: ownerLabel(),
          at: new Date().toISOString(),
        };
        await writeDecision(namespace, decision);
        printStatus(plan, (await currentStatus(namespace, plan)).status);
      }
    )
  );
}

function registerPublish(prove: Command, ctx: CommandContext): void {
  prove
    .command('publish')
    .description('Move refs/fireforge/verified to a commit whose exact tree has complete evidence')
    .option('--commit <revision>', 'The commit to publish', 'HEAD')
    .option('--allow-rewrite', 'Move it to a commit that does not descend from the current one')
    .option('--allow-waived', 'Publish with waived machine obligations, recorded beside the ref')
    .option('--note <text>', 'Why waived obligations are acceptable; --allow-waived requires it')
    .option('--namespace <path>', 'Private coordinator namespace')
    .action(
      jobAction(
        ctx,
        async (options: {
          commit: string;
          allowRewrite?: boolean;
          allowWaived?: boolean;
          note?: string;
          namespace?: string;
        }) => {
          const note = options.note?.trim();
          if (options.allowWaived === true && !note)
            throw new InvalidArgumentError('--allow-waived needs a --note saying why', '--note');
          const namespace = namespaceOf(options);
          const root = ctx.getProjectRoot();
          await assertSourceMode(root);
          const { commit, tree } = await commitTree(root, options.commit);
          const candidates = await retainedSnapshotsOfTree(namespace, tree);
          if (candidates.length === 0)
            throw new GeneralError(
              `proof-publish-no-evidence: no job ran on ${short(commit)}'s tree ${short(tree)}. Run: fireforge prove --tier gate`
            );
          const donor = await pristineDonor(namespace, root);
          let last: { plan: ProofPlan; status: ProofStatus } | undefined;
          for (const candidate of candidates) {
            const snapshot = await authenticateAuthoredSnapshot(candidate, donor);
            const plan = await planCapturedSource({
              root,
              snapshot,
              tier: 'gate',
              head: commit,
              cleanGate: cleanGateProbe(namespace, root, donor),
            });
            const { status } = await currentStatus(namespace, plan, { claim: true });
            last = { plan, status };
            if (status.complete) break;
          }
          if (last === undefined) return;
          assertComplete(last.plan, last.status, options.allowWaived === true);
          const records = publicationRecords(last.plan, last.status, note ?? '', ownerLabel());
          const { waivers, carry } = records;
          const result = await advanceVerified(
            root,
            commit,
            options.allowRewrite === true,
            records
          );
          printStatus(last.plan, last.status, {
            notes: [
              `refs/fireforge/verified ${result.previous === undefined ? 'created at' : `moved from ${short(result.previous)} to`} ${short(commit)}${result.rewritten ? ' after a history rewrite' : ''}.`,
              ...(waivers === undefined
                ? []
                : [
                    `Published with ${String(waivers.waived.length)} waived, recorded at refs/fireforge/verified-waivers/${commit}. The next gate compares with the last clean commit.`,
                  ]),
              ...(carry === undefined
                ? []
                : [
                    `Published with ${String(carry.carried.length)} carried from ${short(carry.from)}, recorded at refs/fireforge/verified-carries/${commit}.`,
                  ]),
            ],
          });
        }
      )
    );
}

/** One command that captures, plans, runs and reports, and the queries and decisions around it. */
export function registerProve(program: Command, ctx: CommandContext): void {
  const prove = program
    .command('prove')
    .description('Prove a source against what its change requires')
    .option('--json', 'Use machine-readable success and error output');
  registerRun(prove, ctx);
  registerPlan(prove, ctx);
  registerStatus(prove, ctx);
  registerDecision(prove, ctx, 'accept', 'Record a person accepting what only a person can decide');
  registerDecision(
    prove,
    ctx,
    'waive',
    'Record a person skipping a machine obligation, which stays visible and publish refuses'
  );
  registerPublish(prove, ctx);
  prove
    .command('measure-tools [roots...]', { hidden: true })
    .description('Measure this runtime and these slot roots; started by prove itself')
    .action(
      jobAction(ctx, async (roots: string[]) => {
        output(JSON.stringify(await measureTools(roots)));
      })
    );
}
