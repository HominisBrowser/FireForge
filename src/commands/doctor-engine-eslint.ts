// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { pathExists } from '../utils/fs.js';
import type { DoctorCheckDefinition } from './doctor-check-core.js';
import { ok, warning } from './doctor-check-core.js';

/** Surfaces the source-refresh ESLint precondition before an expensive gate/build. */
export const ENGINE_ESLINT_DOCTOR_CHECK: DoctorCheckDefinition = {
  name: 'Engine ESLint installed',
  skipIf: (ctx) => !ctx.engineExists,
  run: async (ctx) =>
    (await pathExists(join(ctx.paths.engine, 'node_modules/eslint/bin/eslint.js')))
      ? ok('Engine ESLint installed')
      : warning(
          'Engine ESLint installed',
          'Engine-local ESLint is missing after source extraction; an engine-eslint ratchet cannot run.',
          // `./mach npm ci` installs only the node dependencies the ratchet
          // runs. `./mach eslint --setup` also builds mach's Python `lint`
          // virtualenv, whose pinned requirements can stop resolving on PyPI
          // and fail the whole step with node_modules still missing.
          'Run "cd engine && ./mach npm ci --no-audit --no-fund" after each source refresh, before building or running the gate. It installs engine/node_modules without the Python lint virtualenv "./mach eslint --setup" also builds.'
        ),
};
