// SPDX-License-Identifier: EUPL-1.2
/** `exportQueue`: how a source-mode export groups created files into patches. */
import { type Infer, s } from '../../kernel/schema.js';
import { enginePath, positive, uniqueBy } from './common.js';

const tier = s
  .literal('branding')
  .describe('Size tier the group is held to instead of the one its files imply');

const group = s.object({
  name: s
    .string({
      pattern: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
      format: 'lowercase words joined by hyphens, such as "ui-sidebar"',
    })
    .describe('Patch name; its first word is the category'),
  paths: s
    .array(enginePath, { min: 1 })
    .describe('Engine-relative globs; a created file joins the first group it matches'),
  tier: tier.optional(),
});

/** The `exportQueue` section. Every key is optional. */
export const exportQueueSection = s
  .object({
    groups: s
      .array(group)
      .refine(uniqueBy((entry) => entry.name, 'group name'))
      .describe('Named groups of created files, matched in order')
      .optional(),
    componentTiers: s
      .record(tier)
      .describe('Size tier per component of upstream changes')
      .optional(),
    maxGroupBytes: positive
      .describe('Byte budget of a directory group for created files no group matches')
      .default(1_048_576),
  })
  .describe('How an exported patch queue groups created files');

/** The validated `exportQueue` section. */
export type ExportQueueConfig = Infer<typeof exportQueueSection>;
