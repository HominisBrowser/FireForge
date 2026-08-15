// SPDX-License-Identifier: EUPL-1.2
import type { BuildBaseline } from '../core/build-baseline-types.js';
import { isFileRegistered, matchesRegistrablePattern } from '../core/manifest-rules.js';
import type { ClassifiedFile, StatusFile } from '../core/status-classify.js';
import { getPrimaryStatusCode } from '../core/status-classify.js';
import { GeneralError } from '../errors/base.js';
import { info, outro, warn } from '../utils/logger.js';

const STATUS_DESCRIPTIONS: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'unmerged',
  '?': 'untracked',
  '!': 'ignored',
};

export interface ClassifiedBuckets {
  conflict: ClassifiedFile[];
  unmanaged: ClassifiedFile[];
  patchBacked: ClassifiedFile[];
  patchOwnedDrift: ClassifiedFile[];
  branding: ClassifiedFile[];
  furnace: ClassifiedFile[];
  binaryUnsupported: ClassifiedFile[];
}

function getStatusDescription(code: string): string {
  return STATUS_DESCRIPTIONS[code] ?? 'changed';
}

function isNewFileStatus(status: string): boolean {
  const code = getPrimaryStatusCode(status);
  return code === '?' || code === 'A';
}

function groupFilesByStatus(files: StatusFile[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const { status, file } of files) {
    const code = getPrimaryStatusCode(status);
    const existing = grouped.get(code) ?? [];
    existing.push(file);
    grouped.set(code, existing);
  }
  return grouped;
}

function printStatusGroups(files: StatusFile[]): void {
  const grouped = groupFilesByStatus(files);
  for (const [status, fileList] of grouped) {
    warn(`${getStatusDescription(status)}:`);
    for (const file of fileList) info(`  ${file}`);
  }
}

async function printUnregisteredWarnings(
  files: StatusFile[],
  projectRoot: string,
  binaryName: string
): Promise<void> {
  const newFiles = files.filter((f) => isNewFileStatus(f.status));
  if (newFiles.length === 0) return;

  const registrableFiles = newFiles.filter((f) => matchesRegistrablePattern(f.file, binaryName));
  const registrationChecks = await Promise.all(
    registrableFiles.map(async (f) => {
      try {
        return {
          file: f.file,
          registered: await isFileRegistered(projectRoot, f.file),
          manifestMissing: false as const,
          manifestMissingMessage: undefined as string | undefined,
        };
      } catch (err: unknown) {
        if (err instanceof GeneralError && /^Manifest not found:/i.test(err.message)) {
          return {
            file: f.file,
            registered: false,
            manifestMissing: true as const,
            manifestMissingMessage: err.message,
          };
        }
        throw err;
      }
    })
  );
  const unregistered = registrationChecks.filter((f) => !f.registered && !f.manifestMissing);
  const manifestMissing = registrationChecks.filter((f) => f.manifestMissing);

  if (unregistered.length > 0) {
    info('');
    warn('Potentially unregistered files:');
    for (const f of unregistered) info(`  ${f.file} — run 'fireforge register ${f.file}'`);
  }

  if (manifestMissing.length > 0) {
    info('');
    warn('Files whose registration manifest does not exist yet:');
    for (const f of manifestMissing) {
      info(`  ${f.file} — ${f.manifestMissingMessage}`);
      info(`    Create the parent manifest, then run 'fireforge register ${f.file}'.`);
    }
  }
}

/** Renders the unmanaged-only status view and registration hints. */
export async function renderUnmanagedOnly(
  unmanagedFiles: ClassifiedFile[],
  totalModified: number,
  projectRoot: string,
  binaryName: string
): Promise<void> {
  info(
    `${unmanagedFiles.length} unmanaged file${unmanagedFiles.length === 1 ? '' : 's'} (${totalModified} total modified):\n`
  );
  if (unmanagedFiles.length > 0) {
    printStatusGroups(unmanagedFiles);
    await printUnregisteredWarnings(unmanagedFiles, projectRoot, binaryName);
  } else {
    info('No unmanaged changes');
  }
  outro(
    unmanagedFiles.length === 0
      ? 'No unmanaged changes'
      : `${unmanagedFiles.length} unmanaged change${unmanagedFiles.length === 1 ? '' : 's'}`
  );
}

/** Renders the cross-patch ownership conflict section. */
function renderConflictSection(conflict: ClassifiedFile[]): void {
  warn('Cross-patch ownership conflicts (same file claimed by multiple patches):');
  printStatusGroups(conflict);
  for (const entry of conflict) {
    if (entry.claimedBy && entry.claimedBy.length > 0) {
      info(`  ${entry.file} — claimed by ${entry.claimedBy.join(', ')}`);
    }
  }
  info(
    'Run "fireforge status --ownership" for the full conflict table, then repartition with "fireforge re-export --files <paths> <patch>".'
  );
}

/** Renders the default classified status buckets. */
export async function renderDefaultStatus(
  totalModified: number,
  buckets: ClassifiedBuckets,
  projectRoot: string,
  binaryName: string
): Promise<void> {
  const {
    conflict,
    unmanaged,
    patchBacked,
    patchOwnedDrift,
    branding,
    furnace,
    binaryUnsupported,
  } = buckets;
  info(`${totalModified} modified file${totalModified === 1 ? '' : 's'}:\n`);

  // Sections render in this fixed order, separated by a blank line
  // whenever an earlier section already printed (the pre-refactor code
  // expressed the same rule as per-section "any earlier bucket
  // non-empty" conditions).
  const sections: { files: ClassifiedFile[]; label: string; render: () => Promise<void> | void }[] =
    [
      {
        files: conflict,
        label: 'conflict',
        render: () => {
          renderConflictSection(conflict);
        },
      },
      {
        files: unmanaged,
        label: 'unmanaged',
        render: async () => {
          warn('Unmanaged changes:');
          printStatusGroups(unmanaged);
          await printUnregisteredWarnings(unmanaged, projectRoot, binaryName);
        },
      },
      {
        files: patchBacked,
        label: 'patch-backed',
        render: () => {
          warn('Patch-backed materialized changes:');
          printStatusGroups(patchBacked);
        },
      },
      {
        files: patchOwnedDrift,
        label: 'patch-owned drift',
        render: () => {
          warn('Patch-owned drift:');
          printStatusGroups(patchOwnedDrift);
          info(
            'These files are claimed by exactly one patch, but engine/ no longer matches that patch output. Re-export the owning patch after reviewing the manual resolution.'
          );
        },
      },
      {
        files: branding,
        label: 'branding',
        render: () => {
          warn('Tool-managed branding changes:');
          printStatusGroups(branding);
        },
      },
      {
        files: furnace,
        label: 'furnace',
        render: () => {
          warn('Furnace-managed component changes:');
          printStatusGroups(furnace);
        },
      },
      {
        files: binaryUnsupported,
        label: 'binary — comparison unsupported',
        render: () => {
          warn('Binary — comparison unsupported:');
          printStatusGroups(binaryUnsupported);
          info(
            'These patch-owned binary files carry no comparable blob hash in their patch body, so durability cannot be verified. Re-export the owning patch with a git binary body to make them comparable.'
          );
        },
      },
    ];

  let printedAny = false;
  for (const section of sections) {
    if (section.files.length === 0) continue;
    if (printedAny) info('');
    await section.render();
    printedAny = true;
  }
  if (!printedAny) {
    info('No changes');
  }

  const parts = sections
    .filter((section) => section.files.length > 0)
    .map((section) => `${section.files.length} ${section.label}`);
  outro(parts.join(', '));
}

/**
 * Renders `fireforge status --test-coverage` (FORGE F11): a READ-ONLY view
 * of the last build baseline's test-packaging coverage. Before this
 * existed, the only way to learn the recorded coverage scope — which
 * concurrent sessions sharing one engine tree overwrite constantly — was
 * to trip the out-of-coverage refusal on a real test run.
 */
export function renderTestCoverageStatus(baseline: BuildBaseline | undefined): void {
  if (baseline === undefined) {
    info(
      'No build baseline recorded (.fireforge/last-build.json missing or unreadable).\n' +
        'Run "fireforge build" to record one.'
    );
    outro('No test-packaging coverage recorded');
    return;
  }

  info(
    `Last build: ${baseline.builtAt}  (binary: ${baseline.binaryName}, ` +
      `engine HEAD: ${baseline.engineHeadSha || '(unborn)'})`
  );
  info(`Recorded by: ${baseline.recordedBy ?? 'unknown'}`);

  const coverage = baseline.testPackagingCoverage;
  if (coverage === undefined) {
    info('Test packaging coverage: full (implicit — baseline predates coverage recording)');
    outro('Coverage: full');
    return;
  }
  if (coverage === 'full') {
    info('Test packaging coverage: full');
    outro('Coverage: full');
    return;
  }
  const list = coverage.map((path) => `  - ${path}`).join('\n');
  info(
    `Test packaging coverage: scoped to ${String(coverage.length)} path(s):\n${list}\n` +
      'A "fireforge test" over paths outside this list will be refused as uncovered.'
  );
  outro(`Coverage: scoped (${String(coverage.length)} paths)`);
}
