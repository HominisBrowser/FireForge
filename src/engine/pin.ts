// SPDX-License-Identifier: EUPL-1.2
/** The pin: which Firefox release a project builds on, and the name host state files it under. */
import type { FirefoxConfig } from '../config/index.js';

/** The `firefox` section of a project's configuration. */
export type FirefoxPin = FirefoxConfig;

/**
 * The name host state is filed under for a pin, such as
 * `firefox-esr-153.7.0esr`, or `firefox-esr-153.7.0esr-build2` for a release
 * candidate, whose archive is another source than the release's: the
 * pristine repository's directory, and what a pool workspace records as the
 * Firefox it holds.
 *
 * @param pin - The pin
 */
export function pinKey(pin: Pick<FirefoxPin, 'product' | 'version' | 'candidate'>): string {
  return `${pin.product}-${pin.version}${pin.candidate === undefined ? '' : `-${pin.candidate}`}`;
}
