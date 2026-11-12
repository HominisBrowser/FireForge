// SPDX-License-Identifier: EUPL-1.2
/** `wire`: where `fireforge wire` puts chrome subscripts and DOM fragments. */
import { s } from '../../kernel/schema.js';
import { enginePath } from './common.js';

/** The `wire` section. */
export const wireSection = s
  .object({
    subscriptDir: enginePath
      .describe('Engine-relative directory of wired chrome subscripts')
      .default('browser/base/content'),
    domTarget: enginePath
      .describe(
        'Engine-relative top-level chrome document that wired DOM fragments are included into'
      )
      .default('browser/base/content/browser.xhtml'),
  })
  .describe('Chrome subscript wiring');
