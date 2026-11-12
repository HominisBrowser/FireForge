// SPDX-License-Identifier: EUPL-1.2
/** `check`: the policy and project steps of the composed static check. */
import { type Infer, s } from '../../kernel/schema.js';
import { positive, projectPath, text, uniqueBy } from './common.js';

/** The built-in steps of `fireforge check`, in table order. */
export const CHECK_STEPS = [
  'status',
  'verify',
  'lint',
  'typecheck',
  'furnace-validate',
  'token-coverage',
  'token-lint',
] as const;

/** One built-in step. */
export type CheckStep = (typeof CHECK_STEPS)[number];

const isBuiltin = (name: string): boolean => CHECK_STEPS.some((step) => step === name);

const extraStep = s.object({
  name: s
    .string({
      pattern: /^[a-z0-9][a-z0-9-]*$/,
      format: 'lowercase letters, digits and dashes, such as "policy-audit"',
    })
    .refine((name) => (isBuiltin(name) ? `must not reuse the built-in step "${name}"` : undefined))
    .describe('Step name shown in the report'),
  command: s
    .array(text, { min: 1 })
    .describe('Argument vector run from the project root; the step passes on exit 0'),
  timeout: positive.describe('Seconds before the step is killed and fails').default(600),
  engine: s
    .boolean()
    .describe('The step reads the engine: it runs holding the workspace, with FIREFORGE_ENGINE set')
    .default(false),
  after: s.array(text).describe('Steps that must finish first, whatever their outcome').optional(),
});

type ExtraStep = Infer<typeof extraStep>;

/** Every `after` names a known step, and the ordering has no cycle (whose steps would wait forever). */
function orderingProblem(steps: ExtraStep[]): string | undefined {
  const extras = new Map(steps.map((step) => [step.name, step]));
  for (const step of steps) {
    for (const dependency of step.after ?? []) {
      if (dependency === step.name) return `orders step "${step.name}" after itself`;
      if (!isBuiltin(dependency) && !extras.has(dependency)) {
        return `orders step "${step.name}" after unknown step "${dependency}"`;
      }
    }
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const cycle = (name: string, path: readonly string[]): string | undefined => {
    if (state.get(name) === 'done') return undefined;
    if (state.get(name) === 'visiting') return [...path, name].join(' -> ');
    state.set(name, 'visiting');
    for (const dependency of extras.get(name)?.after ?? []) {
      const found = extras.has(dependency) ? cycle(dependency, [...path, name]) : undefined;
      if (found !== undefined) return found;
    }
    state.set(name, 'done');
    return undefined;
  };
  for (const step of steps) {
    const found = cycle(step.name, []);
    if (found !== undefined) return `orders its steps in a cycle: ${found}`;
  }
  return undefined;
}

const unique = uniqueBy((step: ExtraStep) => step.name, 'step name');

/** The `check` section. Every key is optional. */
export const checkSection = s
  .object({
    skip: s
      .array(s.enum(CHECK_STEPS))
      .describe('Built-in steps this project never runs')
      .optional(),
    status: s
      .object({
        failOn: s
          .array(text)
          .describe('Status codes that fail the status step; every code when unset')
          .optional(),
        allow: s.array(text).describe('Status codes the status step accepts').optional(),
      })
      .describe("The status step's policy")
      .optional(),
    maxWarnings: s
      .object({
        lint: s.int({ min: 0 }).describe('Warnings the lint step tolerates').optional(),
        furnace: s
          .int({ min: 0 })
          .describe('Warnings the furnace-validate step tolerates')
          .optional(),
      })
      .describe('Warning ceilings of the lint and furnace-validate steps')
      .optional(),
    extraSteps: s
      .array(extraStep)
      .refine((steps) => unique(steps) ?? orderingProblem(steps))
      .describe('Project commands run as further steps')
      .optional(),
    minTokenCoverage: s
      .int({ min: 0, max: 100 })
      .describe('Percentage below which the token-coverage step fails')
      .optional(),
    failOnSkipped: s
      .boolean()
      .describe('Fail when a built-in step is skipped for having nothing to run')
      .default(false),
    lintReport: projectPath
      .describe('Project-relative path the lint step writes its JSON report to')
      .optional(),
  })
  .describe('The composed static check');

/** One `check.extraSteps` entry. */
export type CheckExtraStep = ExtraStep;
