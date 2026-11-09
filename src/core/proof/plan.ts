// SPDX-License-Identifier: EUPL-1.2
import { posix } from 'node:path';

import { GeneralError } from '../../errors/base.js';
import type { ProofAcceptanceConfig, ProofConfig, ProofLaneConfig } from '../../types/config.js';
import { matchesAnyGlob } from '../../utils/path-glob.js';
import { digest } from '../authored/git.js';
import type { FullCheckContract } from '../jobs/check-types.js';
import type { JobStep } from '../jobs/schema.js';
import { stepTraits } from '../jobs/step-traits.js';
import type { ManifestFile } from '../test-manifest-support.js';
import { assertSampleTier, consumerPattern, drawSample, sampleField } from './plan-consumers.js';
import { declaredFields, stepFingerprint, type StepShape, testStep } from './plan-steps.js';
import { assertRunnableNamed, servedConsumers, servedTests } from './plan-support.js';
import { type PlanTypecheck, typesObligation } from './plan-typecheck.js';
import { isJsTestPath, isTestPath, type RuntimeRoute } from './route.js';
import type {
  ChangedPath,
  Obligation,
  ObligationKind,
  PlanBase,
  PlanCarry,
  ProofPlan,
  ProofTier,
  RemovedTest,
} from './types.js';

const DEFAULT_CONSUMER_LIMIT = 12;
/** What one job can carry; see `validateRequest`. */
const MAX_JOB_STEPS = 100;
/** Routes a UI-only build cannot serve, the same ones the full-build anchor binds. */
const FULL_BUILD_ROUTES: readonly RuntimeRoute[] = ['compiled', 'unknown', 'packaged', 'component'];
/**
 * Execution order: cheap feedback first, the build next, then whatever reads it.
 * A gate's `check` reads only captured source, so it is cheap feedback too.
 */
const KIND_ORDER: readonly ObligationKind[] = [
  'static',
  'check',
  'build',
  'control',
  'test',
  'lane',
  'stress',
  'run',
  'accept',
];

export { stepFingerprint, type StepShape, testStep } from './plan-steps.js';

/** A captured file, with its text when it might mention or be a consumer. */
export interface PlanFile {
  path: string;
  content: string;
}

/** A control a task names on the command line. */
export interface TaskControl {
  diff: string;
  test: string;
  assertions: string[];
}

export interface PlanInput {
  tier: ProofTier;
  source: string;
  base: PlanBase;
  compiled: string;
  changed: ChangedPath[];
  /** Captured test files, which a glob can match and a consumer search reads. */
  tests: PlanFile[];
  /** Changed non-test files still present, which consumers can mention. */
  touched: PlanFile[];
  /** Captured test manifests, whose `support-files`, `head` and `tail` name what their tests read. */
  manifests?: ManifestFile[];
  /** Tests the caller named. They add to the plan and never replace a changed test. */
  named: string[];
  /** The engine path Furnace deploys each changed project-root test to, which is where it runs. */
  deployed?: Readonly<Record<string, string>>;
  /** The declaration this candidate answers to: its base's and its own together. */
  proof?: ProofConfig;
  check?: FullCheckContract;
  /** The project's own line on lint warnings, which `check` and `authored lint` hold too. */
  lintMaxWarnings?: number;
  /** The `typecheck.projects` the gate's check types, which a task types where it changed them. */
  typecheck?: PlanTypecheck;
  control?: TaskControl;
  /** The recipe, when not the default one. */
  mode?: ProofPlan['mode'];
  /** What differs between the base's declaration and this one's, for a person to accept. */
  declarationChanges?: readonly string[];
  /** What differs from the base's declaration, stated in every report. */
  notes?: readonly string[];
  /** The engine paths each captured control diff mutates. */
  controlTargets: Readonly<Record<string, readonly string[]>>;
  /** At a gate, the verified commit whose evidence carries to everything but `check`. */
  carry?: PlanCarry;
  /** At task tier, how many consumers over the limit a recorded sample runs. */
  sample?: number;
}

/**
 * Expands declared paths: a glob against captured tests, a literal as stated. Empty
 * is a mistake at a gate, which would run it, and nothing a task has to answer for.
 */
function expandFiles(
  lane: ProofLaneConfig,
  captured: readonly string[],
  label: string,
  strict: boolean
): string[] {
  const files = new Set<string>();
  for (const pattern of lane.files) {
    if (!/[*?]/.test(pattern)) {
      files.add(pattern);
      continue;
    }
    const matched = captured.filter((path) => matchesAnyGlob(path, [pattern]));
    if (matched.length === 0 && strict)
      throw new GeneralError(`proof-empty-lane: ${label} pattern ${pattern} matches no test`);
    matched.forEach((path) => files.add(path));
  }
  const kept = [...files].filter((path) => !matchesAnyGlob(path, lane.exclude ?? [])).sort();
  if (kept.length === 0 && strict)
    throw new GeneralError(`proof-empty-lane: ${label} excludes every file`);
  return kept;
}

const declaredLanes = (input: PlanInput): Array<{ lane: ProofLaneConfig; files: string[] }> =>
  (input.proof?.gate?.lanes ?? []).map((lane) => ({
    lane,
    files: expandFiles(
      lane,
      input.tests.map((file) => file.path),
      `lane ${lane.id}`,
      input.tier === 'gate'
    ),
  }));

/** What a control's mutation may touch: code the change altered, not its tests or its documents. */
const controlPaths = (changed: readonly ChangedPath[]): string[] =>
  changed
    .filter(
      (change) => change.tree === 'engine' && change.route !== 'test' && change.route !== 'none'
    )
    .map((change) => change.path);

/** The acceptances this candidate has to answer to, which keep the lanes they look at. */
function retainedAcceptance(input: PlanInput): ProofAcceptanceConfig[] {
  if (input.tier !== 'gate') return [];
  const changed = input.changed.map((change) => change.path);
  return (input.proof?.gate?.acceptance ?? []).filter(
    ({ owns }) =>
      owns === undefined ||
      changed.length === 0 ||
      changed.some((path) => matchesAnyGlob(path, owns))
  );
}

/**
 * Builds the plan as a pure function of the candidate, its base and the project's
 * declaration, which is the base's and the candidate's together. The only thing
 * that narrows it is a named base, which the plan records.
 */
class PlanBuilder {
  readonly obligations: Obligation[] = [];
  readonly notes: string[];
  private sample: ProofPlan['sample'];
  private readonly lanes: ReturnType<typeof declaredLanes>;
  private readonly tests: Set<string>;
  private readonly changedPaths: string[];
  private readonly acceptance: ProofAcceptanceConfig[];
  /** Obligations an acceptance looks at, which run whatever changed. */
  private readonly required: Set<string>;
  /** The tests each changed support file serves. */
  private readonly served: ReadonlyMap<string, readonly string[]>;

  constructor(private readonly input: PlanInput) {
    this.notes = [...(input.notes ?? [])];
    this.lanes = declaredLanes(input);
    this.tests = new Set(input.tests.map((file) => file.path));
    this.changedPaths = input.changed.map((change) => change.path);
    this.acceptance = retainedAcceptance(input);
    this.required = new Set(this.acceptance.flatMap((entry) => entry.evidence ?? []));
    this.served = servedTests(input.changed, this.tests, input.manifests ?? []);
  }

  private add(
    id: string,
    kind: ObligationKind,
    reason: string,
    step?: JobStep,
    extra: Pick<Obligation, 'repeat' | 'always' | 'evidence' | 'sampled'> = {}
  ): void {
    if (this.obligations.some((obligation) => obligation.id === id)) return;
    this.obligations.push({
      id,
      kind,
      reason,
      ...(step === undefined ? {} : { step }),
      fingerprints: step === undefined ? [] : [stepFingerprint(step)],
      ...extra,
    });
  }

  /** A file under the shape its lane declares, since that is how the file can pass. */
  private addTest(path: string, reason: string, extra: { sampled?: true } = {}): void {
    this.add(`test:${path}`, 'test', reason, testStep([path], this.shapeOf(path)), extra);
  }

  private shapeOf(path: string): StepShape {
    const owner = this.lanes.find(({ files }) => files.includes(path))?.lane;
    if (owner === undefined) return {};
    return {
      ...(owner.headed === undefined ? {} : { headed: owner.headed }),
      ...(owner.dispatch === 'standalone' ? { dispatch: owner.dispatch } : {}),
      ...(owner.args === undefined ? {} : { args: owner.args }),
      ...(owner.machArgs === undefined ? {} : { machArgs: owner.machArgs }),
      ...declaredFields(owner),
    };
  }

  /**
   * A lane with no `owns` always applies. An unscoped candidate has nothing to scope it by.
   * A changed support file owns the lanes holding a test it serves.
   */
  private owned(lane: ProofLaneConfig, files: readonly string[]): boolean {
    if (lane.owns === undefined || this.changedPaths.length === 0) return true;
    const deployed = this.input.deployed ?? {};
    return this.changedPaths.some(
      (path) =>
        matchesAnyGlob(path, lane.owns ?? []) ||
        files.includes(path) ||
        files.includes(deployed[path] ?? path) ||
        (this.served.get(path) ?? []).some((test) => files.includes(test))
    );
  }

  /** Declared lanes this candidate retains, each a whole roster dispatched as declared. */
  private addLanes(): string[] {
    const retained: string[] = [];
    for (const { lane, files } of this.lanes) {
      if (!this.required.has(`lane:${lane.id}`) && !this.owned(lane, files)) {
        this.notes.push(`Lane ${lane.id} is not owned by this change.`);
        continue;
      }
      retained.push(...files);
      this.add(
        `lane:${lane.id}`,
        'lane',
        `Declared lane of ${String(files.length)} tests.`,
        testStep(files, lane)
      );
    }
    return retained;
  }

  private addStress(): void {
    for (const stress of this.input.proof?.gate?.stress ?? []) {
      const files = expandFiles(stress, [...this.tests], `stress ${stress.id}`, true);
      if (!this.required.has(`stress:${stress.id}`) && !this.owned(stress, files)) {
        this.notes.push(`Stress ${stress.id} is not owned by this change.`);
        continue;
      }
      const context = stress.context ?? [];
      const shape: StepShape =
        context.length > 0 && stress.dispatch === undefined
          ? { ...stress, dispatch: 'one-browser' }
          : stress;
      this.add(
        `stress:${stress.id}`,
        'stress',
        `${String(stress.repeat)} complete repeats${context.length > 0 ? ` after ${String(context.length)} context files` : ''}.`,
        testStep([...context, ...files], shape, ['--repeat', String(stress.repeat)]),
        { repeat: stress.repeat }
      );
    }
  }

  private addControl(
    id: string,
    reason: string,
    control: TaskControl,
    options: { compiled?: boolean; always?: boolean } = {}
  ): void {
    this.add(
      id,
      'control',
      reason,
      {
        ...testStep([control.test], { quiet: true }, [
          '--negative-control',
          control.diff,
          ...(options.compiled === true ? ['--build'] : []),
        ]),
        controlAssertions: control.assertions,
      },
      options.always === true ? { always: true } : {}
    );
  }

  private touchesChange(diff: string): boolean {
    const targets = this.input.controlTargets[diff] ?? [];
    return controlPaths(this.input.changed).some((path) => targets.includes(path));
  }

  private addControls(): void {
    const { control } = this.input;
    if (control !== undefined) {
      if (!this.touchesChange(control.diff))
        throw new GeneralError(
          `proof-control-unrelated: ${control.diff} mutates nothing this change altered outside its tests`
        );
      this.addControl(`control:${control.diff}`, 'Declared control of this change.', control);
    }
    for (const declared of this.input.proof?.gate?.controls ?? []) {
      if (this.input.tier !== 'gate') continue;
      const always = declared.always === true || this.required.has(`control:${declared.id}`);
      if (always && (this.input.controlTargets[declared.diff] ?? []).length === 0)
        throw new GeneralError(`proof-control-unrelated: ${declared.diff} mutates nothing`);
      if (!always && !this.touchesChange(declared.diff)) {
        this.notes.push(`Control ${declared.id} mutates nothing this change altered.`);
        continue;
      }
      this.addControl(
        `control:${declared.id}`,
        always
          ? 'Declared expected-red proof the project requires of every gate.'
          : 'Declared expected-red proof of what this change altered.',
        declared,
        { compiled: declared.compiled === true, always }
      );
    }
  }

  private refuseUnmapped(path: string): never {
    throw new GeneralError(
      `proof-unclassified-test: ${path} is a changed test nothing would run. Name what runs it with --test, list it in a proof.gate lane, or, for a file a test reads, in its manifest's support-files.`
    );
  }

  /**
   * Every changed test or test input is either in a retained lane or runs by
   * itself here: a change to a test can never pass without it having run.
   */
  private addChangedTests(covered: readonly string[], consumers: Set<string>): void {
    const named = this.input.named;
    const declared = this.lanes.flatMap(({ files }) => files);
    for (const change of this.input.changed) {
      if (change.deleted || !(change.route === 'test' || isTestPath(change.path))) continue;
      let { path } = change;
      if (change.tree === 'root') {
        // A component's test runs from the engine path Furnace deploys it to, and nowhere else.
        const deployed = this.input.deployed?.[path];
        if (deployed === undefined)
          throw new GeneralError(
            `proof-unclassified-test: ${path} is a changed test Furnace deploys to no engine path, so nothing would run it. Move it into the source tree, or make it a component file Furnace deploys.`
          );
        path = deployed;
      }
      if (isTestPath(path)) {
        if (covered.includes(path)) continue;
        if (!isJsTestPath(path) && !named.includes(path) && !declared.includes(path))
          this.refuseUnmapped(path);
        this.addTest(path, 'Changed test.');
      } else {
        // A support file: whatever runs a test it serves answers for it.
        const users = this.served.get(path) ?? [];
        const answered = (entry: string): boolean =>
          users.includes(entry) || entry.startsWith(`${posix.dirname(path)}/`);
        if (named.some(answered) || covered.some(answered)) continue;
        if (users.length === 0) this.refuseUnmapped(path);
        users.forEach((entry) => consumers.add(entry));
      }
    }
  }

  /** Direct consumers are a task's early feedback. The gate's lanes are its complete roster. */
  private findConsumers(consumers: Set<string>): void {
    const pattern = consumerPattern(this.input);
    if (pattern === undefined) return;
    for (const file of this.input.tests)
      if (!this.changedPaths.includes(file.path) && pattern.test(file.content))
        consumers.add(file.path);
  }

  private addConsumers(consumers: Set<string>): void {
    const limit = this.input.proof?.consumerLimit ?? DEFAULT_CONSUMER_LIMIT;
    const named = this.input.named;
    const remaining = [...consumers].filter((path) => !named.includes(path)).sort();
    if (remaining.length <= limit) {
      remaining.forEach((path) => {
        this.addTest(path, 'Direct consumer of what changed.');
      });
      return;
    }
    if (this.input.sample !== undefined) {
      // A deterministic sample stands for them all, and says what it left out.
      const drawn = drawSample(this.input.sample, remaining, this.input.changed, this.lanes);
      for (const path of drawn.sample.sampled)
        this.addTest(path, 'Sampled consumer of what changed.', { sampled: true });
      this.notes.push(...drawn.notes);
      this.sample = drawn.sample;
      return;
    }
    if (named.length === 0)
      throw new GeneralError(
        `proof-consumer-limit: ${String(remaining.length)} tests consume what changed, over the limit of ${String(limit)} (first: ${remaining.slice(0, 3).join(', ')}). Run a recorded sample of them with --sample <n>, name the ones that prove this change with --test, run --tier gate, or raise proof.consumerLimit.`
      );
    this.notes.push(
      `${String(remaining.length)} direct consumers exceed the limit of ${String(limit)} and are left to the gate; the named tests run instead.`
    );
  }

  private addStatic(): void {
    const { changed } = this.input;
    const paths = changed.filter((change) => change.tree === 'engine' && !change.deleted);
    const structural = changed.some((change) => FULL_BUILD_ROUTES.includes(change.route));
    // One line on warnings, the project's own: this step, `check` and `authored lint` all hold it.
    const { lintMaxWarnings } = this.input;
    const warningLine =
      lintMaxWarnings === undefined ? [] : ['--max-warnings', String(lintMaxWarnings)];
    const step: JobStep = structural
      ? { command: 'lint', args: warningLine }
      : paths.length > 0
        ? { command: 'lint', args: [...paths.map((change) => change.path), ...warningLine] }
        : { command: 'verify', args: [] };
    this.add('static', 'static', 'Lint, types and upstream policy of what changed.', step);
    this.obligations.push(...typesObligation(changed, this.input.typecheck, structural));
  }

  /** A build by route, and whatever a browser step needs to read. */
  private addBuild(): void {
    const { changed, tier, proof } = this.input;
    const runtime = changed.some((change) => change.route !== 'none');
    const browser = this.obligations.some(({ step }) => stepTraits(step).readsPackage);
    if (!runtime && !browser && (tier !== 'gate' || proof?.gate?.build === undefined)) return;
    const full =
      changed.some((change) => FULL_BUILD_ROUTES.includes(change.route)) ||
      (tier === 'gate' && proof?.gate?.build === 'full');
    const fullStep: JobStep = { command: 'build', args: [] };
    this.add(
      'build',
      'build',
      full ? 'What changed needs a full build.' : 'Package what changed.',
      full ? fullStep : { command: 'build', args: ['--ui'] }
    );
    // A full build of this source serves whatever a UI build would.
    if (!full) this.obligations.at(-1)?.fingerprints.push(stepFingerprint(fullStep));
  }

  private addAcceptance(): void {
    for (const entry of this.acceptance) {
      const evidence = (entry.evidence ?? []).filter((id) =>
        this.obligations.some((obligation) => obligation.id === id)
      );
      for (const id of entry.evidence ?? [])
        if (!evidence.includes(id))
          this.notes.push(`Acceptance ${entry.id} looks at ${id}, which is gone with its tests.`);
      this.add(
        `accept:${entry.id}`,
        'accept',
        entry.reason,
        undefined,
        evidence.length === 0 ? {} : { evidence }
      );
    }
    // Nothing narrows a gate unseen: a person answers for its declaration changing.
    const changes = this.input.declarationChanges ?? [];
    if (changes.length > 0)
      this.add(
        'accept:proof-config',
        'accept',
        `What this gate requires differs from its base's: ${changes.join('; ')}.`
      );
  }

  /** Tests gone from the candidate, with the declared rosters that held them. */
  private removedTests(): RemovedTest[] {
    const declared = [
      ...(this.input.proof?.gate?.lanes ?? []).map((lane) => ({ id: `lane:${lane.id}`, lane })),
      ...(this.input.proof?.gate?.stress ?? []).map((lane) => ({ id: `stress:${lane.id}`, lane })),
    ];
    return this.input.changed
      .filter((change) => change.deleted && (change.route === 'test' || isTestPath(change.path)))
      .map(({ path }) => ({
        path,
        from: declared
          .filter(
            ({ lane }) =>
              matchesAnyGlob(path, lane.files) && !matchesAnyGlob(path, lane.exclude ?? [])
          )
          .map(({ id }) => id),
      }));
  }

  build(): ProofPlan {
    const { input } = this;
    assertSampleTier(input);
    if (input.tier === 'task' && input.changed.length === 0 && input.named.length === 0)
      throw new GeneralError(
        `proof-empty-input: nothing differs from ${input.base.label}. Name a further --base, or the tests to run with --test.`
      );
    input.named.forEach((path) => {
      assertRunnableNamed(path, this.tests, input.manifests ?? []);
    });
    const covered = input.tier === 'gate' ? this.addLanes() : [];
    const consumers = new Set<string>();
    this.addChangedTests(covered, consumers);
    // Support files outside test directories select the tests their manifests list for them.
    servedConsumers(input.changed, this.served, [...input.named, ...covered]).forEach((path) =>
      consumers.add(path)
    );
    input.named
      .filter((path) => !covered.includes(path))
      .forEach((path) => {
        this.addTest(path, 'Named test.');
      });
    if (input.tier === 'task') this.findConsumers(consumers);
    this.addConsumers(consumers);
    this.addControls();
    if (input.tier === 'gate') {
      this.addStress();
      for (const run of input.proof?.gate?.runs ?? [])
        this.add(`run:${run.id}`, 'run', 'A declared browser run has to exit clean.', {
          command: 'run',
          args: run.args,
          ...(run.quiet === true ? { quiet: true } : {}),
          ...declaredFields(run),
          ...(run.validate === undefined ? {} : { validate: run.validate }),
        });
      this.add(
        'check',
        'check',
        'The project check, complete, on the final candidate.',
        input.proof?.gate?.check?.quiet === true
          ? { command: 'check', args: [], quiet: true }
          : { command: 'check', args: [] }
      );
      this.addAcceptance();
    } else this.addStatic();
    this.addBuild();
    if (
      input.tier === 'task' &&
      !this.obligations.some(({ step }) => stepTraits(step).browser) &&
      input.changed.some((change) => change.route !== 'none' && change.route !== 'test')
    )
      this.notes.push('No test runs this change. Name one with --test, or leave it to the gate.');
    // The check reads documents too, so it always runs on this tree.
    const carry = input.tier === 'gate' ? input.carry : undefined;
    if (carry !== undefined) {
      for (const obligation of this.obligations)
        if (obligation.kind !== 'check') obligation.carried = true;
      this.notes.push(
        `Only documents changed since ${carry.commit.slice(0, 12)}, so its gate evidence carries to everything but check.`
      );
    }
    const obligations = [...this.obligations].sort(
      (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.id.localeCompare(b.id)
    );
    const steps = obligations.filter((obligation) => obligation.step !== undefined).length;
    if (steps > MAX_JOB_STEPS)
      throw new GeneralError(
        `proof-step-limit: this plan needs ${String(steps)} steps and a job carries ${String(MAX_JOB_STEPS)}. Declare a lane for the tests it names.`
      );
    const body = {
      schemaVersion: 1 as const,
      tier: input.tier,
      source: input.source,
      base: input.base,
      compiled: input.compiled,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      controlPaths: controlPaths(input.changed),
      changed: input.changed,
      obligations,
      ...(input.tier === 'gate' && input.check !== undefined ? { check: input.check } : {}),
      notes: this.notes,
      removedTests: this.removedTests(),
      ...(carry === undefined ? {} : { carry }),
      ...sampleField(this.sample),
    };
    return { ...body, id: digest(body) };
  }
}

/** The obligations a candidate has to meet, derived and never supplied. */
export function createProofPlan(input: PlanInput): ProofPlan {
  return new PlanBuilder(input).build();
}
