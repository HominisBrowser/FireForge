// SPDX-License-Identifier: EUPL-1.2
/**
 * The project's tracked copies of engine files, addressed by engine path.
 * Where the bytes live depends on the mode (the engine checkout itself, or
 * an owned file under the source root behind an override record); a module
 * that edits engine files takes this interface and never asks which.
 */
import type { Transaction } from '../kernel/journal.js';

/**
 * Engine files the project tracks. Writes and removals go through the
 * caller's journal transaction, so an edit of several files lands whole or
 * not at all.
 */
export interface TrackedFiles {
  /** The tracked text of an engine file, or undefined when there is none. */
  read(enginePath: string): Promise<string | undefined>;
  /** Whether the engine has the file, as text or not. */
  exists(enginePath: string): Promise<boolean>;
  /** Writes an engine file's tracked copy as part of `tx`, recording whatever the mode needs. */
  write(tx: Transaction, enginePath: string, content: string): Promise<void>;
  /** Removes an engine file the project added, as part of `tx`. */
  remove(tx: Transaction, enginePath: string): Promise<void>;
  /** The absolute path of the tracked copy, for paths written relative to it. */
  locate(enginePath: string): string;
}
