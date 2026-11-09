// SPDX-License-Identifier: EUPL-1.2
import { toError } from '../../utils/errors.js';
import type { SlotView } from './admission.js';
import { type HeldGroup, holdHostGroup } from './host-quarantine.js';
import {
  ClaimReplacedError,
  markSlotForAudit,
  quarantineSlot,
  slotMetadataUnreadable,
} from './slot-lock.js';

/** What a slot's disk has to say before anything else may run there. */
export interface SlotMark {
  /** Why the slot cannot be trusted. Absent, the next admission only has to audit it. */
  quarantine?: string;
  /** Process groups that outlived the phase. */
  holds?: readonly HeldGroup[];
}

interface Pending {
  quarantine?: string;
  audit: boolean;
  holds: HeldGroup[];
  release?: () => Promise<void>;
}

const FULL_DISK_REASON = 'its state could not be written, and this is retried';

/**
 * Marks that have not reached the disk yet, which a full disk makes realistic.
 * Until one lands the slot stays out of the scheduler's reach here, and its lock
 * stays held so no other process takes it either. A crash loses this memory, and
 * the journal row of the job behind it is held back until the mark lands, so a
 * restarted supervisor finds a job that was running and quarantines its slot.
 */
export class SlotCondemnations {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly namespace: string,
    private readonly logFault: (context: string, error: unknown) => void
  ) {}

  get size(): number {
    return this.pending.size;
  }

  isPending(slot: string | undefined): boolean {
    return slot !== undefined && this.pending.has(slot);
  }

  /** The scheduler's view, with a slot whose mark has not landed read as quarantined whatever its disk says. */
  overlay(slots: ReadonlyMap<string, SlotView>): ReadonlyMap<string, SlotView> {
    if (this.pending.size === 0) return slots;
    const views = new Map(slots);
    for (const [slot, entry] of this.pending) {
      const view = views.get(slot);
      if (view !== undefined)
        views.set(slot, {
          ...view,
          quarantined: `${entry.quarantine ?? 'It needs an audit'}; ${FULL_DISK_REASON}`,
        });
    }
    return views;
  }

  /**
   * Writes a mark, and remembers it when that fails.
   *
   * @returns Whether it reached the disk
   */
  async record(slot: string, mark: SlotMark): Promise<boolean> {
    const entry = this.pending.get(slot) ?? { audit: false, holds: [] };
    if (mark.quarantine === undefined) entry.audit = true;
    else entry.quarantine ??= mark.quarantine;
    entry.holds.push(...(mark.holds ?? []));
    this.pending.set(slot, entry);
    return this.land(slot, entry);
  }

  /** Keeps a lock until what is pending on its slot lands, or until it can be let go of at all. */
  keepLock(slot: string, release: () => Promise<void>): void {
    const entry = this.pending.get(slot) ?? { audit: false, holds: [] };
    entry.release = release;
    this.pending.set(slot, entry);
  }

  /** Tries everything again. @returns Whether any slot came free */
  async retry(): Promise<boolean> {
    let landed = false;
    for (const [slot, entry] of [...this.pending]) if (await this.land(slot, entry)) landed = true;
    return landed;
  }

  private async land(slot: string, entry: Pending): Promise<boolean> {
    try {
      // The slot first: a hold that will not land must not keep its quarantine off the disk.
      await this.writeSlotMark(slot, entry);
      for (const held of entry.holds) await holdHostGroup(this.namespace, held);
      entry.holds = [];
      await entry.release?.();
    } catch (error) {
      if (!(error instanceof ClaimReplacedError)) {
        this.logFault(`Slot ${slot} could not be marked`, toError(error).message);
        return false;
      }
    }
    this.pending.delete(slot);
    return true;
  }

  private async writeSlotMark(slot: string, entry: Pending): Promise<void> {
    try {
      if (entry.quarantine !== undefined)
        await quarantineSlot(this.namespace, slot, entry.quarantine);
      else if (entry.audit) await markSlotForAudit(this.namespace, slot);
    } catch (error) {
      // Metadata nothing can read already reads as quarantined, so there is nothing left to say.
      if (!slotMetadataUnreadable(error)) throw error;
    }
  }
}
