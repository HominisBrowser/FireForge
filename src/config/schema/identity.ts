// SPDX-License-Identifier: EUPL-1.2
/**
 * The browser's identity: the root keys that name, brand and license it.
 * The generated mozconfig is shell-evaluated, so the free-text fields refuse
 * control characters and the executable name is restricted to what cannot
 * carry shell syntax.
 */
import { s } from '../../kernel/schema.js';

/** SPDX identifiers a project can be licensed under. */
export const PROJECT_LICENSES = ['EUPL-1.2', 'MPL-2.0', '0BSD', 'GPL-2.0-or-later'] as const;

/** The license of a project that names none, and the one `setup` proposes. */
export const DEFAULT_LICENSE: (typeof PROJECT_LICENSES)[number] = 'EUPL-1.2';

const PRINTABLE = /^\P{Cc}*[^\s\p{Cc}]\P{Cc}*$/u;

/** The identity keys, spread into the root of the schema. */
export const identityKeys = {
  name: s
    .string({ pattern: PRINTABLE, format: 'a non-empty name without control characters' })
    .describe('Display name of the browser'),
  vendor: s
    .string({ pattern: PRINTABLE, format: 'a non-empty name without control characters' })
    .describe('Vendor or company name'),
  appId: s
    .string({
      pattern: /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/,
      format: 'a reverse-domain identifier such as "org.example.browser"',
    })
    .describe('Application ID in reverse-domain form'),
  binaryName: s
    .string({
      pattern: /^[a-z][a-z0-9-]*$/,
      format: 'a lowercase letter followed by lowercase letters, digits and hyphens',
    })
    .describe('Executable name of the built browser'),
  license: s
    .enum(PROJECT_LICENSES)
    .describe('SPDX identifier of the project license')
    .default(DEFAULT_LICENSE),
  markerComment: s
    .string({
      pattern: /^(?!\s)(?!.*\*\/)\P{Cc}*[^\s\p{Cc}]$/u,
      format: 'a one-line marker without surrounding whitespace or "*/"',
    })
    .describe(
      'Marker appended as a comment to lines FireForge writes into upstream files, such as "MYBROWSER"'
    )
    .optional(),
};

/**
 * The marker word on the lines FireForge and the fork write into upstream
 * files, such as `MYBROWSER` (lines carry it as `// MYBROWSER:`):
 * `markerComment` when set, else the binary name in upper case.
 *
 * @param config - The project configuration
 */
export function markerComment(config: {
  readonly markerComment?: string | undefined;
  readonly binaryName: string;
}): string {
  return config.markerComment ?? config.binaryName.toUpperCase();
}
