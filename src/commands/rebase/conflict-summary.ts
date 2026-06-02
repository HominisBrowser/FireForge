// SPDX-License-Identifier: EUPL-1.2

import { extractConflictingFiles } from '../../core/patch-parse.js';

export interface RebaseConflictSummary {
  patchFilename: string;
  failedFiles: string[];
  category: string;
  nextCommands: string[];
}

function normalizeRejectFile(file: string): string {
  return file.replace(/\.rej$/, '');
}

function classifyConflict(files: readonly string[]): string {
  if (files.some((file) => file.endsWith('toolkit/content/customElements.js'))) {
    return 'registration context drift';
  }
  if (
    files.some(
      (file) =>
        file.endsWith('jar.mn') ||
        file.endsWith('moz.build') ||
        file.endsWith('browser.toml') ||
        file.endsWith('browser/moz.configure')
    )
  ) {
    return 'manifest context drift';
  }
  return 'patch context drift';
}

/** Builds a concise operator-facing summary for a failed rebase patch. */
export function buildRebaseConflictSummary(args: {
  patchFilename: string;
  error?: string;
  rejectFiles?: string[];
}): RebaseConflictSummary {
  const failedFiles = [
    ...new Set([
      ...extractConflictingFiles(args.error),
      ...(args.rejectFiles ?? []).map(normalizeRejectFile),
    ]),
  ].sort();

  return {
    patchFilename: args.patchFilename,
    failedFiles,
    category: classifyConflict(failedFiles),
    nextCommands: [
      "find engine -name '*.rej'",
      'edit the affected engine/ files',
      'fireforge rebase --continue',
      'fireforge rebase --abort',
    ],
  };
}
