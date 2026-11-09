// SPDX-License-Identifier: EUPL-1.2
import type { CoordinatorConfig } from './schema.js';

/** The optional settings a run states or an earlier initialization kept. */
const CARRIED_SETTINGS = [
  'releaseSecrets',
  'quietLoad',
  'replicateDepth',
  'diskLowGib',
  'artifactMaxGib',
  'artifactMaxAgeDays',
  'steadyHost',
] as const satisfies readonly (keyof CoordinatorConfig)[];

type CarriedSetting = (typeof CARRIED_SETTINGS)[number];

/**
 * Each optional setting this run states, else the one an earlier initialization kept.
 *
 * @param options - What this initialization states
 * @param existing - The configuration already stored, if any
 * @returns The settings to keep, with unset ones left out
 */
export function carriedSettings(
  options: Partial<Pick<CoordinatorConfig, CarriedSetting>>,
  existing: Partial<CoordinatorConfig> | undefined
): Partial<CoordinatorConfig> {
  const carried: Partial<Record<CarriedSetting, unknown>> = {};
  for (const key of CARRIED_SETTINGS) {
    const value = options[key] ?? existing?.[key];
    if (value !== undefined) carried[key] = value;
  }
  return carried as Partial<CoordinatorConfig>;
}
