// SPDX-License-Identifier: EUPL-1.2
/** `test`: how `fireforge test` treats the host and reads harness output. */
import { s } from '../../kernel/schema.js';
import { validRegExp } from './common.js';

/** The `test` section. Every key is optional. */
export const testSection = s
  .object({
    mochitestPorts: s
      .enum(['fixed', 'auto'])
      .describe(
        'auto lets a run proceed while another workspace holds the Marionette port or, where the harness can move, a mochitest server port'
      )
      .default('fixed'),
    harnessFailurePatterns: s
      .array(s.string({ min: 1 }).refine(validRegExp), { min: 1 })
      .describe(
        'Regular expressions of output lines meaning the browser failed before any test ran; such a run reads crash, not no-tests'
      )
      .optional(),
  })
  .describe('Test command settings');
