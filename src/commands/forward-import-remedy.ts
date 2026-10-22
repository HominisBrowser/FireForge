// SPDX-License-Identifier: EUPL-1.2
/**
 * The remedy printed under a forward-import refusal from `re-export`
 * (plain refresh and `--scan` adoption alike): the earliest order the files
 * can take as their own later patch, and the exact `patch staged-dependency
 * --add` commands that declare the edges instead.
 *
 * Both the order number and every flag of the declaration are spelled out,
 * so the operator does not have to work them out from the finding text.
 */

import { STAGED_DEPENDENCY_REASON_PLACEHOLDER } from '../core/patch-lint-staged-registration.js';
import { earliestLegalOrderAfter } from '../core/patch-order-legal.js';
import { formatPatchOrder } from '../core/patch-parse.js';
import type {
  PatchesManifest,
  PatchLintIssue,
  PatchLintStagedDeclaration,
} from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';

/** Inputs to {@link formatForwardImportRemedy}. */
export interface ForwardImportRemedyInput {
  /** What to do after the fix, e.g. "re-running the scan". */
  reRunHint: string;
  /** The refusal's findings; only `forward-import` and `forward-registration` ones are read. */
  issues: readonly PatchLintIssue[];
  /** Current manifest (null when unavailable: the order is then not named). */
  manifest: PatchesManifest | null;
  /** Project config; only `patchPolicy` is read. */
  config?: Pick<FireForgeConfig, 'patchPolicy'>;
  /** Category the files would be exported under (the refused patch's). */
  category?: string;
}

function quoteArg(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function declarationCommand(declaration: PatchLintStagedDeclaration): string {
  const anchor =
    declaration.kind === 'import'
      ? `--specifier ${quoteArg(declaration.specifier ?? '')}`
      : `--kind registration --line ${quoteArg(declaration.line ?? '')}`;
  return (
    `fireforge patch staged-dependency ${declaration.patch} --add --file ${declaration.file} ` +
    `${anchor} --creates ${declaration.creates} --owner ${declaration.owner} ` +
    STAGED_DEPENDENCY_REASON_PLACEHOLDER
  );
}

/**
 * Renders the remedy lines. Falls back to the generic sentence when the
 * findings carry no structured declarations.
 *
 * @param input - See {@link ForwardImportRemedyInput}
 */
export function formatForwardImportRemedy(input: ForwardImportRemedyInput): string {
  const declarations = input.issues
    .filter((issue) => issue.check === 'forward-import' || issue.check === 'forward-registration')
    .flatMap((issue) => issue.stagedDeclarations ?? []);

  const ownerOrders = declarations
    .map(
      (declaration) =>
        input.manifest?.patches.find((patch) => patch.filename === declaration.owner)?.order
    )
    .filter((order): order is number => order !== undefined);
  const latestOwner = ownerOrders.length > 0 ? Math.max(...ownerOrders) : undefined;
  const legalOrder =
    latestOwner !== undefined && input.manifest !== null && input.category !== undefined
      ? earliestLegalOrderAfter(input.config ?? {}, input.manifest, input.category, latestOwner)
      : null;

  const orderText =
    legalOrder !== null
      ? `"fireforge export <files> --order ${formatPatchOrder(legalOrder)}"; ` +
        `${formatPatchOrder(legalOrder)} is the earliest legal order after the latest creator ` +
        `(${formatPatchOrder(latestOwner ?? legalOrder)})`
      : '"fireforge export --order <n>"';
  const lines = [
    `Export those files as their own later patch (${orderText}; or ` +
      '"fireforge patch split --order <n>"), or declare the intentional dependency with ' +
      `"fireforge patch staged-dependency --add" before ${input.reRunHint}` +
      (declarations.length > 0 ? ':' : '.'),
  ];
  const seen = new Set<string>();
  for (const declaration of declarations) {
    const command = declarationCommand(declaration);
    if (seen.has(command)) continue;
    seen.add(command);
    lines.push(`  ${command}`);
  }
  return lines.join('\n');
}
