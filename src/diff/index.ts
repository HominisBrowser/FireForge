// SPDX-License-Identifier: EUPL-1.2
/**
 * The unified diff model: parse a patch into per-file sections, write it back
 * byte for byte, ask it questions, and apply a section to content in memory.
 * Pure: no git, no filesystem. Producing a patch from a tree is `git/`'s job.
 *
 * Encoding: a patch is decoded once, as UTF-8 when valid and as Latin-1
 * otherwise, and written back the same way (see `model.ts`), so
 * `formatPatch(parsePatch(bytes))` equals `bytes` for any input.
 *
 * Slicing: a patch of some of a patch's sections is
 * `formatPatch({ ...patch, preamble: [], files })`.
 */
export { applyFileDiff } from './apply.js';
export { type FileDiff, formatPatch, type Hunk, parsePatch, type Patch } from './model.js';
export { addedLines, affectedPaths, hunkSides } from './query.js';
