// SPDX-License-Identifier: EUPL-1.2
import type { FullCheckContract } from '../jobs/check-types.js';
import type { JobStep } from '../jobs/schema.js';
import type { RuntimeRoute } from './route.js';

export type ProofTier = 'task' | 'gate';
export type ObligationKind =
  'static' | 'build' | 'test' | 'lane' | 'stress' | 'control' | 'run' | 'check' | 'accept';

/** One path that differs between the base and the candidate, by where it lives. */
export interface ChangedPath {
  path: string;
  tree: 'engine' | 'root';
  route: RuntimeRoute;
  /** Gone from the candidate, so nothing can read or run it. */
  deleted: boolean;
}

/** What the candidate was compared against. The tree is what the plan binds. */
export interface PlanBase {
  commit: string;
  tree: string;
  /** Where it came from, for the reader: `merge-base with main`, `refs/fireforge/verified`, `--base x`. */
  label: string;
  /** Excludes commits the default base would cover, so this plan cannot claim completion. */
  narrowed: boolean;
}

/** Something a candidate has to show. A readable ID, stable across sources. */
export interface Obligation {
  id: string;
  kind: ObligationKind;
  reason: string;
  /** The step that discharges it. A human decision has none. */
  step?: JobStep;
  /** Step fingerprints whose evidence discharges it. */
  fingerprints: string[];
  repeat?: number;
  /** A control the project requires whatever changed, so its mutation need not touch the change. */
  always?: boolean;
  /** Obligations whose outputs an acceptance looks at, which have to pass before it can be made. */
  evidence?: string[];
  /** The carried source's evidence meets it as well as this source's own. */
  carried?: true;
}

/**
 * A verified commit whose evidence meets this candidate's obligations other than
 * `check`: every path between them is a document no build, test or judge reads.
 */
export interface PlanCarry {
  commit: string;
  tree: string;
  /** That tree's source under this candidate's pin, which its evidence is keyed by. */
  source: string;
}

/** A test gone from this candidate, and the rosters that held it. */
export interface RemovedTest {
  path: string;
  /** The declared lanes and stress groups whose rosters held it. */
  from: string[];
}

export interface ProofPlan {
  schemaVersion: 1;
  id: string;
  tier: ProofTier;
  source: string;
  base: PlanBase;
  /** The compiled inputs and recipe a build has to be of, so its evidence counts. */
  compiled: string;
  /** The recipe, when not the default one. */
  mode?: 'dev' | 'debug' | 'release';
  /** Engine paths a control's mutation has to touch. */
  controlPaths: string[];
  changed: ChangedPath[];
  obligations: Obligation[];
  check?: FullCheckContract;
  /** What was left out and why, so an omission is never silent. */
  notes: string[];
  /** Tests deleted relative to the base. A deleted test can only ever be disclosed, never run. */
  removedTests: RemovedTest[];
  carry?: PlanCarry;
}
