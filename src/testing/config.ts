// SPDX-License-Identifier: EUPL-1.2
import { configSchema, type FireForgeConfig } from '../config/index.js';

/** The pin every test project builds on. */
export const TEST_PIN = { version: '140.9.0esr', product: 'firefox-esr' } as const;

/** The pin key of {@link TEST_PIN}: the name of its pristine repository on a host. */
export const TEST_PIN_KEY = 'firefox-esr-140.9.0esr';

/** The fewest keys a valid `fireforge.json` holds: what every test project starts from. */
export const MINIMAL_CONFIG = {
  name: 'Mine',
  vendor: 'Example',
  appId: 'org.example.mine',
  binaryName: 'mine',
  firefox: TEST_PIN,
} as const;

/**
 * A validated configuration: the minimal document with `patch` merged into
 * its root, defaults filled.
 *
 * @param patch - Root keys to set
 */
export function testConfig(patch: Readonly<Record<string, unknown>> = {}): FireForgeConfig {
  return configSchema.parse({ ...MINIMAL_CONFIG, ...patch });
}
