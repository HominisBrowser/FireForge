// SPDX-License-Identifier: EUPL-1.2
import { detectComposesCycles } from '../../core/furnace-config.js';
import { InvalidArgumentError } from '../../errors/base.js';
import { FurnaceError } from '../../errors/furnace.js';
import type { FurnaceCreateOptions } from '../../types/commands/index.js';
import type { FurnaceConfig } from '../../types/furnace.js';

function checkNameConflict(config: FurnaceConfig, name: string): string | undefined {
  if (name in config.custom) {
    return `A custom component named "${name}" already exists in furnace.json`;
  }
  if (name in config.overrides) {
    return `An override component named "${name}" already exists in furnace.json`;
  }
  return undefined;
}

function validateComposesTargets(
  config: FurnaceConfig,
  componentName: string,
  composes: string[] | undefined
): void {
  if (!composes || composes.length === 0) return;

  const known = new Set([
    ...config.stock,
    ...Object.keys(config.overrides),
    ...Object.keys(config.custom),
  ]);
  for (const tag of composes) {
    if (tag === componentName) {
      throw new FurnaceError(`Component "${componentName}" cannot compose itself.`);
    }
    if (!known.has(tag)) {
      throw new FurnaceError(
        `Cannot compose unknown component "${tag}". ` +
          'The referenced component must be registered as stock, override, or custom.'
      );
    }
  }

  detectComposesCycles({
    ...config.custom,
    [componentName]: {
      description: '',
      targetPath: `toolkit/content/widgets/${componentName}`,
      register: true,
      localized: false,
      composes,
    },
  });
}

/**
 * Validates a proposed custom component against the current furnace config.
 */
export function validateCreateAgainstConfig(
  config: FurnaceConfig,
  componentName: string,
  allowPrefixMismatch: FurnaceCreateOptions['allowPrefixMismatch'],
  composes: string[] | undefined
): void {
  const conflict = checkNameConflict(config, componentName);
  if (conflict) {
    throw new FurnaceError(conflict, componentName);
  }

  if (
    config.componentPrefix &&
    !componentName.startsWith(config.componentPrefix) &&
    !allowPrefixMismatch
  ) {
    throw new InvalidArgumentError(
      `Name "${componentName}" does not start with the configured prefix "${config.componentPrefix}". ` +
        `Use a prefixed name (e.g. "${config.componentPrefix}${componentName}"), update ` +
        '`componentPrefix` in furnace.json, or pass --allow-prefix-mismatch to create the component anyway.',
      'name'
    );
  }

  validateComposesTargets(config, componentName, composes);
}
