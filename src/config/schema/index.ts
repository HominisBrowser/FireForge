// SPDX-License-Identifier: EUPL-1.2
/**
 * The `fireforge.json` schema: the sum of the sections, each declared in its
 * own file by the feature it configures. A section whose keys are all
 * optional is filled with its defaults when absent, so a reader never tests
 * for the block before reading a key.
 */
import { type Infer, s, type Schema } from '../../kernel/schema.js';
import { buildAuditSection, buildSection } from './build.js';
import { checkSection } from './check.js';
import { exportQueueSection } from './export-queue.js';
import { firefoxSection } from './firefox.js';
import { gateSection } from './gate.js';
import { identityKeys } from './identity.js';
import { patchLintSection } from './lint.js';
import { patchPolicySection } from './policy.js';
import { modeKey, modeProblem, sourceSection } from './source.js';
import { testSection } from './test.js';
import { toolchainsSection } from './toolchains.js';
import { typecheckSection } from './typecheck.js';
import { wireSection } from './wire.js';

/** A section that is filled with its own defaults when absent. */
function filled<T>(section: Schema<T>): Schema<T> {
  return section.default(section.parse({}));
}

/** The whole of `fireforge.json`. */
export const configSchema = s
  .object({
    ...identityKeys,
    mode: modeKey,
    source: sourceSection.optional(),
    firefox: firefoxSection,
    build: buildSection.optional(),
    buildAudit: buildAuditSection.optional(),
    test: filled(testSection),
    patchLint: filled(patchLintSection),
    patchPolicy: patchPolicySection.optional(),
    typecheck: typecheckSection.optional(),
    check: filled(checkSection),
    gate: gateSection.optional(),
    exportQueue: filled(exportQueueSection),
    externalToolchains: toolchainsSection.optional(),
    wire: filled(wireSection),
  })
  .refine(modeProblem);

/** A validated `fireforge.json`, defaults applied. */
export type FireForgeConfig = Infer<typeof configSchema>;
