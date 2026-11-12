// SPDX-License-Identifier: EUPL-1.2
/** `typecheck`: the whole-project type check of `fireforge typecheck`. */
import { type Infer, s } from '../../kernel/schema.js';
import { projectPath, severity } from './common.js';

const typecheckObject = s.object({
  projects: s
    .array(projectPath, { min: 1 })
    .describe('Project-relative jsconfig or tsconfig files checked as whole projects'),
  extraShim: projectPath
    .describe('Project-relative .d.ts added to the Firefox globals shim of every project')
    .optional(),
  projectOverrides: s
    .record(s.union(s.literal(null), projectPath))
    .describe(
      'Per project (keyed as in projects): another .d.ts instead of extraShim, or null for none'
    )
    .optional(),
  undefinedIdentifiers: severity
    .describe('How undefined identifiers are reported')
    .default('warning'),
  litTypes: s.boolean().describe('Type Lit in the shim with closed member lists').default(false),
});

/** The validated `typecheck` section. */
export type TypecheckConfig = Infer<typeof typecheckObject>;

/** The `typecheck` section. */
export const typecheckSection = typecheckObject
  .refine(({ projects, projectOverrides }) => {
    const stray = Object.keys(projectOverrides ?? {}).find((key) => !projects.includes(key));
    return stray === undefined
      ? undefined
      : `overrides "${stray}", which is not one of its projects`;
  })
  .describe('Whole-project type checking');
