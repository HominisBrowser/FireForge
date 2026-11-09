// SPDX-License-Identifier: EUPL-1.2
/** Data-only execution identities; functional modules must not depend on one another through these types. */
export interface PhaseRuntimeIdentity {
  sourceGeneration: number;
  successfulBuildGeneration: number;
  materializationDigest: string;
  derivedDigest: string;
  buildBaselineDigest?: string;
  /** What the slot's current package is a build of, when it has a trusted one. */
  build?: BuildIdentity;
}
/** Content only, so two builds of one source on two slots compare equal. */
export interface BuildIdentity {
  /** The compiled inputs and recipe of the binary: the full-build anchor. */
  compiled: string;
  /** The toolchain, Mach recipe and site roster the binary was built with. */
  native?: string;
  /** The derived toolchain's own digest, comparable with the host's current one. */
  toolchain?: string;
}
export interface TrustedBuildIdentity {
  sourceId: string;
  materializationDigest: string;
  successfulBuildGeneration: number;
  baselineDigest: string;
  slotGeneration: number;
}
export interface StorageReservation {
  /** Bytes the slot can come to occupy beyond what it shares by cloning. */
  reservedBytes: number;
  memoryBytes: number;
  floorBytes: number;
  /** Bytes its object directory occupied at its last measured full build. */
  consumedBytes?: number;
  /** Bytes its release object directory occupied at its last measured release. */
  releaseBytes?: number;
}
export interface SlotRecord {
  schemaVersion: 1;
  id: string;
  root: string;
  pristineRepository: string;
  pin: string;
  sourceId: string;
  generation: number;
  successfulBuildGeneration: number;
  inputs: string[];
  quarantined: string | null;
  /** A job ended here without sealing, so the next admission audits before trusting the slot. */
  requiresAudit?: boolean;
  buildRecipeDigest?: string;
  storage?: StorageReservation;
  requiresBuild?: boolean;
  requiresFullBuild?: boolean;
  requiresToolchainClean?: boolean;
  /** The toolchain that last touched the object directory, whether or not that build passed. */
  objdirToolsDigest?: string;
  fullBuildAnchor?: {
    digest: string;
    baselineDigest: string;
    sourceId: string;
    buildGeneration: number;
    nativeToolsDigest?: string;
  };
  trustedBuild?: TrustedBuildIdentity;
  /** What the object directory's packaged output looked like when its build finished. */
  packageSignature?: PackageSignature;
}
/** A stat pass over a slot's package. It stays out of {@link BuildIdentity}: it holds this slot's mtimes. */
export interface PackageSignature {
  digest: string;
  /** When it was taken, so a later difference can name what moved. */
  at: number;
}
export interface SlotCache {
  source: string;
  target: string;
}

export interface BuildToolContext {
  nativeToolsDigest: string;
  jobId: string;
  phase: string;
}

/** Tools one host builds with: read-only generations, and what identifies them. */
export interface NativeToolchainManifest {
  schemaVersion: 3;
  platform: string;
  arch: string;
  /** Content identity, the same for the same tools at any path. */
  digest: string;
  /** Stat signature of every root, compared per job instead of reading the bytes. */
  signature: string;
  /** Each root's content digest, compared when the bytes are read. */
  rootDigests: Record<string, string>;
  python: { executable: string; roots: string[]; sites?: string[] };
  native: {
    executables: Record<string, string>;
    roots: string[];
    /** What a job sets so configure finds the frozen copies of non-executable inputs. */
    environment?: Record<string, string>;
    /** The places the deriving configure selected, which a slot's configure has to select too. */
    configured: Record<string, string>;
  };
}

/** Closed expected build-output data. */
export interface BuildDerivedFile {
  sha256: string;
  mode: '100644' | '100755';
}
export interface BuildDerivedLedger {
  sourceId: string;
  generation: number;
  toolsDigest: string;
  provenance: {
    sourceId: string;
    pinCommit: string;
    platform: string;
    generator: string;
    toolVersion: string;
    inputs: string;
  };
  files: Record<string, BuildDerivedFile>;
}
