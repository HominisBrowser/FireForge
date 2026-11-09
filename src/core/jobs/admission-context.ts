// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { getNodeErrorCode, toError } from '../../utils/errors.js';
import { oneMinuteLoad } from '../test-host-state.js';
import type { AdmissionContext, SlotView } from './admission.js';
import { probeDisplay } from './display-probe.js';
import { hostQuarantineBlock, observeHost } from './host-quarantine.js';
import type { CoordinatorConfig } from './schema.js';
import type { SlotRecord } from './slot-types.js';
import { diskBlock } from './storage.js';
import { readJson } from './store.js';

/** The namespace's configuration, or a refusal when this version cannot use it. */
export async function readCoordinatorConfig(namespace: string): Promise<CoordinatorConfig> {
  const config = await readJson<
    Partial<Omit<CoordinatorConfig, 'schemaVersion'>> & {
      schemaVersion?: number;
    }
  >(join(namespace, 'config.json'));
  if (
    config.schemaVersion !== 1 ||
    config.capacity === undefined ||
    !Number.isSafeInteger(config.idleMs) ||
    (config.idleMs ?? 0) < 50
  )
    throw new Error('Unsupported coordinator configuration; run: fireforge host init');
  return config as CoordinatorConfig;
}

/** The provisioned slots. One still being provisioned has no metadata and is not in the pool. */
export async function slotViews(namespace: string): Promise<Map<string, SlotView>> {
  const views = new Map<string, SlotView>();
  const names = await readdir(join(namespace, 'slots')).catch(() => [] as string[]);
  for (const name of names.sort()) {
    try {
      const slot = await readJson<Partial<SlotRecord> & { quarantined: string | null }>(
        join(namespace, 'slots', name, 'slot.json')
      );
      const packaged =
        slot.fullBuildAnchor !== undefined &&
        slot.requiresBuild !== true &&
        slot.requiresFullBuild !== true
          ? slot.trustedBuild?.sourceId
          : undefined;
      views.set(name, {
        id: name,
        quarantined: slot.quarantined,
        ...(slot.pin === undefined ? {} : { pin: slot.pin }),
        ...(slot.sourceId === undefined ? {} : { sourceId: slot.sourceId }),
        ...(slot.fullBuildAnchor === undefined
          ? {}
          : { anchorDigest: slot.fullBuildAnchor.digest }),
        ...(slot.requiresFullBuild === true ? { requiresFullBuild: true } : {}),
        ...(packaged === undefined ? {} : { packagedSource: packaged }),
      });
    } catch (error) {
      if (getNodeErrorCode(error) !== 'ENOENT')
        views.set(name, {
          id: name,
          quarantined: `Slot metadata is unreadable: ${toError(error).message}`,
        });
    }
  }
  return views;
}

/** Admission's input, with the configuration it read. */
export type ObservedAdmission = AdmissionContext & { config: CoordinatorConfig };

/**
 * Reads what admission depends on, outside the decision queue. `fault` is a
 * reason the supervisor already knows nothing may start.
 */
export async function observeAdmission(
  namespace: string,
  fault: string | undefined,
  readLoad: () => number | undefined = oneMinuteLoad
): Promise<ObservedAdmission> {
  const config = await readCoordinatorConfig(namespace);
  const host = await observeHost(namespace);
  const blocked = fault ?? host.blocked ?? (await diskBlock(namespace));
  const display = await probeDisplay();
  const hostLoad = readLoad();
  return {
    config,
    slots: await slotViews(namespace),
    held: host.held,
    ...(blocked === undefined ? {} : { blocked }),
    ...(display.state === 'unavailable' ? { displayDown: display.detail } : {}),
    ...(hostLoad === undefined ? {} : { hostLoad }),
  };
}

/**
 * The observation with the host quarantine as recorded now. A pass decides after
 * it observes, and a quarantine written in between still stops what it would admit.
 */
export async function atDecision(
  namespace: string,
  context: ObservedAdmission
): Promise<ObservedAdmission> {
  if (context.blocked !== undefined) return context;
  const blocked = await hostQuarantineBlock(namespace).catch(
    (error: unknown) => `Host state could not be read: ${toError(error).message}`
  );
  return blocked === undefined ? context : { ...context, blocked };
}
