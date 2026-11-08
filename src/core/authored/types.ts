// SPDX-License-Identifier: EUPL-1.2
import type { FireForgeConfig, FirefoxConfig } from '../../types/config.js';
export type { AuthoredSourceConfig } from '../../types/config.js';

export type SourceFileMode = '100644' | '100755';
export type SourceObjectFormat = 'sha1' | 'sha256';

/** An authenticated declaration for a path which exists in pristine upstream. */
export interface UpstreamDeclaration {
  schemaVersion: 1;
  kind: 'override' | 'delete';
  path: string;
  base: { pin: string; commit: string; blob: string; mode: SourceFileMode };
  component: string;
  classification: 'registration' | 'exception';
  adr?: string;
}

/** Immutable, content-addressed root input. Paths are relative to the project root. */
export interface CapturedInput {
  path: string;
  blob: string;
  mode: SourceFileMode;
}

/** A source-provider entry. A tombstone has no postimage blob. */
export interface AuthoredFile {
  path: string;
  kind: 'created' | 'override' | 'delete' | 'generated';
  blob?: string;
  mode: SourceFileMode;
  declaration?: UpstreamDeclaration;
}

/** Persistable handle to objects retained in a project Git object database. */
export interface AuthoredSnapshot {
  schemaVersion: 1;
  id: string;
  repository: string;
  tree: string;
  objectFormat: SourceObjectFormat;
  generatedTree?: string;
  pin: { firefox: FirefoxConfig; commit: string; digest: string };
  config: FireForgeConfig;
  inputs: CapturedInput[];
  files: AuthoredFile[];
}

export interface UpstreamDelta {
  path: string;
  declaration: UpstreamDeclaration;
  diff: string;
}

/** The object database may be a read-only donor shared by source-only worktrees. */
export interface CaptureAuthoredOptions {
  projectRoot: string;
  /** Extra inputs beyond the source, metadata and project roots that are always captured. */
  intendedPaths?: readonly string[];
  pristineRepository?: string;
  /** Capture with tracked edits outside the selection left out, reporting them as notices. */
  allowDirtyRoot?: boolean;
  /** Leave no refs behind: for feedback that is not submitted as a job. */
  retain?: boolean;
  /** Receives human-readable notices about what was left out or specially included. */
  onNotice?: (message: string) => void;
}

export interface MaterializeAuthoredOptions {
  snapshot: AuthoredSnapshot;
  engineDir: string;
  ledgerPath: string;
  pristineRepository?: string;
}

export interface MaterializationResult {
  snapshotId: string;
  changed: string[];
  removed: string[];
  restored: string[];
}
