// SPDX-License-Identifier: EUPL-1.2
import { ensureSupervisor } from './client.js';
import { type PinnedBuild, readPinnedRuntime } from './pinned-runtime.js';
import { type JobRecord, terminal } from './schema.js';

/**
 * A supervisor's view of the host's pinned build. While the host pins another
 * build than the one running, new jobs are accepted for the pinned build and
 * held: the running supervisor never runs them, goes idle once its own work is
 * done, and starts the pinned build as it closes.
 */
export class BuildSwitch {
  private target: PinnedBuild | undefined;

  constructor(
    private readonly namespace: string,
    private readonly own: () => string,
    private readonly logFault: (context: string, error: unknown) => void
  ) {}

  /** Reads the pinned build again. A read that fails keeps the last answer. */
  async refresh(): Promise<void> {
    try {
      const pinned = (await readPinnedRuntime(this.namespace))?.current;
      this.target =
        pinned !== undefined && pinned.executorDigest !== this.own() ? pinned : undefined;
    } catch (error) {
      this.logFault('Could not read the pinned FireForge runtime', error);
    }
  }

  /** The executor a job accepted now runs on: the pinned build while the host switches to it. */
  executorFor(): string {
    return this.target?.executorDigest ?? this.own();
  }

  /** A job accepted for the build the host is switching to, which this supervisor never runs. */
  holds(job: JobRecord): boolean {
    return (
      this.target !== undefined &&
      !terminal(job.state) &&
      job.executorToolsDigest === this.target.executorDigest
    );
  }

  /** Why a held job waits. */
  get reason(): string {
    return `Waiting for the host to switch to FireForge ${this.target?.version ?? 'its pinned build'}, which it does once the running supervisor goes idle`;
  }

  /** Starts the pinned build after this supervisor closed, when jobs wait for it and no client may be waiting. */
  handOff(jobs: Iterable<JobRecord>): void {
    if (![...jobs].some((job) => this.holds(job))) return;
    void ensureSupervisor(this.namespace).catch((error: unknown) => {
      this.logFault('Could not start the pinned supervisor', error);
    });
  }
}
