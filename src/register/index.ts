// SPDX-License-Identifier: EUPL-1.2
/**
 * Build-manifest registration and chrome subscript wiring. Both plan their
 * edits over `TrackedFiles` and change nothing until `applyEdits` runs.
 */
export { applyEdits, type PlanStep } from './files.js';
export { elementJarEntry, type JarFile, planRegister } from './register.js';
export { planWire } from './wire.js';
