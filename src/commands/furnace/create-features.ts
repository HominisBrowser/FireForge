// SPDX-License-Identifier: EUPL-1.2
/**
 * Feature-flag resolution for `furnace create`. Extracted from
 * `create.ts` so the authoring command stays under the per-file LOC
 * budget — the flag resolver has grown with each new opt-in (`--xpcshell`,
 * `--test-style`, `--shared-ftl`).
 */

import { multiselect } from '@clack/prompts';

import { InvalidArgumentError } from '../../errors/base.js';
import type { FurnaceCreateOptions } from '../../types/commands/index.js';
import { cancel, isCancel } from '../../utils/logger.js';

/**
 * Resolves the localized and registration feature flags for a new component.
 *
 * `--shared-ftl` implies `localized` and short-circuits the interactive
 * prompt so the operator is not asked to flip a flag we are about to
 * enforce. `--no-localized` combined with `--shared-ftl` is rejected
 * fast-fail; the cross-field check in furnace-config would catch it
 * too, but later and without a clear command-line message.
 *
 * @param isInteractive - Whether interactive prompts are available
 * @param options - CLI-provided feature flags
 * @returns Final feature selections, or null when creation is cancelled
 */
export async function resolveCreateFeatures(
  isInteractive: boolean,
  options: FurnaceCreateOptions
): Promise<{ localized: boolean; register: boolean } | null> {
  let localized = options.localized ?? false;
  let register = options.register ?? true;

  if (options.sharedFtl !== undefined) {
    if (options.localized === false) {
      throw new InvalidArgumentError(
        '--shared-ftl requires localization. Remove --no-localized or drop --shared-ftl.',
        'sharedFtl'
      );
    }
    localized = true;
  }

  const featuresPromptSuppressed = options.sharedFtl !== undefined;

  if (
    isInteractive &&
    options.localized === undefined &&
    options.register === undefined &&
    !featuresPromptSuppressed
  ) {
    const features = await multiselect({
      message: 'Component features:',
      options: [
        { value: 'localized', label: 'Fluent localization (data-l10n-id)' },
        { value: 'register', label: 'Register in customElements.js' },
      ],
      initialValues: ['register'],
    });

    if (isCancel(features)) {
      cancel('Create cancelled');
      return null;
    }

    const selected = features as string[];
    localized = selected.includes('localized');
    register = selected.includes('register');
  }

  return { localized, register };
}
