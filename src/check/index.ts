// SPDX-License-Identifier: EUPL-1.2
/**
 * The two composed judgements. `check` is the static one: status, verify,
 * lint, typecheck, component validation, design tokens and the project's
 * own steps, as one result. `gate` is `check` plus a build and the declared
 * tests on a clean committed tree; a pass moves `refs/fireforge/verified`.
 */
export { checkJson, renderCheck, runCheck } from './check.js';
export { acceptGate, gateFailure, gateStatus, renderGate, runGate } from './gate.js';
export { VERIFIED_REF } from './record.js';
