// SPDX-License-Identifier: EUPL-1.2
/** `externalToolchains`: project-specific tools `fireforge doctor` probes for. */
import { s } from '../../kernel/schema.js';
import { text } from './common.js';

const tool = s.object({
  name: text.describe('Tool name, and the PATH or xcrun lookup key when no path is set'),
  path: text.describe('Absolute or project-relative executable path').optional(),
  xcrun: s.boolean().describe('Resolve with xcrun -find instead of PATH').optional(),
  required: s.boolean().describe('A missing tool is an error rather than a warning').default(true),
});

/** The `externalToolchains` section. */
export const toolchainsSection = s
  .array(
    s.object({
      name: text.describe('Toolchain name, such as "seasonal-branding"'),
      tools: s.array(tool, { min: 1 }).describe('The tools it needs'),
    })
  )
  .describe('Named groups of external tools the project needs');
