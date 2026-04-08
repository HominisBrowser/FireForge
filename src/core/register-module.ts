// SPDX-License-Identifier: EUPL-1.2
/**
 * Module registration in browser/modules/{binaryName}/moz.build.
 */

import { join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { findAlphabeticalMozBuildPosition, findAlphabeticalPosition } from './manifest-helpers.js';
import type { RegisterResult } from './manifest-register.js';
import { tokenizeMozBuildList } from './manifest-tokenizers.js';
import { withParserFallback } from './parser-fallback.js';

/**
 * Tokenizer-based implementation for module registration.
 */
function registerFireForgeModuleTokenized(
  content: string,
  fileName: string,
  entry: string
): { result: string; previousEntry: string | undefined } {
  const lines = content.split('\n');
  const listResult = tokenizeMozBuildList(lines, /EXTRA_JS_MODULES/);

  if (!listResult) {
    throw new GeneralError('Could not find EXTRA_JS_MODULES in moz.build');
  }

  const { insertIndex, previousEntry } = findAlphabeticalMozBuildPosition(
    listResult.tokens,
    fileName
  );

  lines.splice(insertIndex, 0, entry);
  return { result: lines.join('\n'), previousEntry };
}

/**
 * Legacy line-based implementation preserved as fallback.
 */
function legacyRegisterFireForgeModule(
  content: string,
  fileName: string,
  entry: string,
  moduleDir: string
): { result: string; previousEntry: string | undefined } {
  const lines = content.split('\n');

  const extractKey = (line: string): string | undefined => {
    const match = /^\s+"([^"]+\.sys\.mjs)"/.exec(line);
    return match?.[1];
  };

  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (/^\s+"[^"]+\.sys\.mjs"/.test(line)) {
      if (sectionStart === -1) sectionStart = i;
      sectionEnd = i + 1;
    }
  }

  if (sectionStart === -1) {
    throw new GeneralError(`Could not find module list section in ${moduleDir}/moz.build`);
  }

  const { insertIndex, previousEntry } = findAlphabeticalPosition(
    lines,
    sectionStart,
    sectionEnd,
    fileName,
    extractKey
  );

  lines.splice(insertIndex, 0, entry);
  return { result: lines.join('\n'), previousEntry };
}

/**
 * Registers a module in browser/modules/{binaryName}/moz.build.
 *
 * Entry format:
 *     "{name}.sys.mjs",
 */
export async function registerFireForgeModule(
  engineDir: string,
  fileName: string,
  moduleDir: string,
  dryRun = false
): Promise<RegisterResult> {
  const manifest = `${moduleDir}/moz.build`;
  const manifestPath = join(engineDir, manifest);

  if (!(await pathExists(manifestPath))) {
    throw new GeneralError(`Manifest not found: ${manifest}`);
  }

  const entry = `    "${fileName}",`.replace(/\\/g, '/');

  const content = await readText(manifestPath);

  // Idempotency check
  if (content.includes(`"${fileName}"`)) {
    return { manifest, entry, skipped: true };
  }

  const { value } = withParserFallback(
    () => registerFireForgeModuleTokenized(content, fileName, entry),
    () => legacyRegisterFireForgeModule(content, fileName, entry, moduleDir),
    manifest
  );

  if (!dryRun) {
    await writeText(manifestPath, value.result);
  }
  return { manifest, entry, previousEntry: value.previousEntry, skipped: false };
}
