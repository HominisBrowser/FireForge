// SPDX-License-Identifier: EUPL-1.2
/**
 * What registration and wiring read and write: files addressed by engine
 * path. The caller decides where those bytes live (the engine checkout, or
 * tracked files under `src/`) and runs {@link applyEdits} in its transaction.
 */
import type { Transaction } from '../kernel/journal.js';
import type { TrackedFiles } from '../project/index.js';

/** One file's new content. */
export interface FileEdit {
  /** Engine-relative path. */
  path: string;
  content: string;
  /**
   * The file's text when the plan read it (null: it did not exist), which
   * {@link applyEdits} requires the file to still hold. Absent when the plan
   * did not read the file.
   */
  before?: string | null;
}

/** One thing a plan does (or finds already done). */
export interface PlanStep {
  path: string;
  /** What changes in that file, such as `DIRS += ["foo"]`. */
  change: string;
  /** True when the file already has it. */
  present: boolean;
}

/**
 * A planned change: nothing is written until the edits are applied, so a
 * plan that fails half way has changed nothing.
 */
export interface Plan {
  edits: FileEdit[];
  steps: PlanStep[];
}

/**
 * Reads through the edits made so far, so a plan can change one file in
 * several steps and every step sees the previous one.
 */
export class EditSession {
  private readonly pending = new Map<string, string>();
  private readonly originals = new Map<string, string | null>();

  constructor(private readonly files: TrackedFiles) {}

  /** The file's text as the plan leaves it so far, or undefined when it does not exist. */
  async read(path: string): Promise<string | undefined> {
    const planned = this.pending.get(path);
    if (planned !== undefined) return planned;
    const text = await this.files.read(path);
    if (!this.originals.has(path)) this.originals.set(path, text ?? null);
    return text;
  }

  /** Whether the file exists, counting files the plan creates. */
  async exists(path: string): Promise<boolean> {
    return this.pending.has(path) || this.files.exists(path);
  }

  /** Records a file's new content. */
  set(path: string, content: string): void {
    this.pending.set(path, content);
  }

  /** The edits in the order they were first made. */
  edits(): FileEdit[] {
    return [...this.pending].map(([path, content]) => {
      const before = this.originals.get(path);
      return before === undefined ? { path, content } : { path, content, before };
    });
  }
}

/**
 * Writes the edits in order, as part of the caller's transaction: a plan
 * lands whole or not at all. A file that no longer holds the text its edit
 * was planned over is refused (`tracked-file-moved`) and the transaction
 * rolls back.
 *
 * @param tx - The transaction the writes belong to
 * @param files - Where the files live
 * @param edits - A plan's edits
 */
export async function applyEdits(
  tx: Transaction,
  files: TrackedFiles,
  edits: readonly FileEdit[]
): Promise<void> {
  for (const edit of edits) {
    await files.write(
      tx,
      edit.path,
      edit.content,
      edit.before === undefined ? {} : { expected: edit.before }
    );
  }
}
