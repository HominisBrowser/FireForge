// SPDX-License-Identifier: EUPL-1.2
/**
 * A command's result channel. stdout carries results and nothing else:
 *
 *  - Without `--json`: the lines a command writes, optionally ending in one
 *    `FIREFORGE-VERDICT:` line that nothing may follow.
 *  - With `--json`: exactly one JSON document carrying `schemaVersion`. On
 *    failure that document is `{ schemaVersion, error, code }`.
 *
 * Progress and diagnostics go to stderr through `kernel/log.ts`.
 */
import { invariant } from '../kernel/errors.js';
import type { JsonObject } from '../kernel/json.js';
import { info } from '../kernel/log.js';
import { onShutdown } from '../kernel/signals.js';

/** Version of the `--json` envelope. Adding a key keeps it; removing or retyping one raises it. */
const SCHEMA_VERSION = 1;

/** Prefix of the line that ends the stdout of a pass/fail command. */
const VERDICT_PREFIX = 'FIREFORGE-VERDICT:';

/** `key=value` pairs on a verdict line. An undefined value leaves its key out. */
export type VerdictFields = Readonly<Record<string, string | number | boolean | undefined>>;

/** What a command writes its result through (`ctx.out`). */
export interface Out {
  /** Whether `--json` was given. */
  readonly isJson: boolean;
  /**
   * Writes one line of human-readable result. Does nothing under `--json`,
   * so a command can describe its result both ways without branching.
   */
  line(text?: string): void;
  /**
   * Writes result text exactly as given, with no newline added: a patch
   * body, a porcelain stream. Does nothing under `--json`.
   */
  write(text: string): void;
  /**
   * Writes the command's one JSON document, adding `schemaVersion`. Does
   * nothing without `--json`. Call it at most once.
   */
  json(document: JsonObject): void;
  /**
   * Ends stdout with the verdict line: `FIREFORGE-VERDICT: PASS` or
   * `FIREFORGE-VERDICT: FAIL reason=<reason> ...`. Anything written
   * afterwards goes to stderr. Does nothing under `--json`, where the
   * document carries the verdict.
   */
  verdict(pass: boolean, fields?: VerdictFields): void;
}

/**
 * Renders a verdict line. Whitespace and `%` inside a value are
 * percent-encoded, so the line always splits on spaces into `key=value` pairs.
 *
 * @param pass - The judgement
 * @param fields - Further `key=value` pairs, in insertion order
 */
export function formatVerdict(pass: boolean, fields: VerdictFields = {}): string {
  const pairs = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value).replace(/[%\s]/g, encodeURIComponent)}`);
  return [VERDICT_PREFIX, pass ? 'PASS' : 'FAIL', ...pairs].join(' ');
}

/** The {@link Out} of one command run, with the hooks the program needs around it. */
export class Output implements Out {
  private jsonWritten = false;
  private sealed = false;
  private disarm: (() => void) | undefined;

  constructor(
    private readonly stdout: (text: string) => void,
    readonly isJson: boolean
  ) {}

  line(text = ''): void {
    this.write(`${text}\n`);
  }

  write(text: string): void {
    if (this.isJson) return;
    // After the verdict, stdout is closed to everything else.
    if (this.sealed) info(text.replace(/\n$/, ''));
    else this.stdout(text);
  }

  json(document: JsonObject): void {
    if (!this.isJson) return;
    invariant(!this.jsonWritten, 'a command writes one JSON document');
    this.jsonWritten = true;
    this.stdout(`${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...document })}\n`);
  }

  verdict(pass: boolean, fields: VerdictFields = {}): void {
    if (this.isJson || this.sealed) return;
    this.sealed = true;
    this.stdout(`${formatVerdict(pass, fields)}\n`);
  }

  /**
   * Declares that this run ends in a verdict, so an interrupt writes
   * `FAIL reason=killed signal=<signal>` before anything that can stall: a
   * log tail must be able to tell "killed" from "still running".
   */
  expectVerdict(): void {
    this.disarm = onShutdown('announce', (signal) => {
      this.verdict(false, { reason: 'killed', signal });
    });
  }

  /**
   * Reports a failed run on stdout: the failure envelope under `--json`
   * (unless the command already wrote its document), or a failing verdict
   * for a run that owed one and had not written it.
   */
  fail(error: { message: string; code: string; hint?: string | undefined }): void {
    if (this.isJson && !this.jsonWritten) {
      this.json({ error: error.message, code: error.code, hint: error.hint });
    } else if (this.disarm !== undefined) {
      this.verdict(false, { reason: error.code });
    }
  }

  /** Ends the run: stops listening for interrupts. */
  close(): void {
    this.disarm?.();
    this.disarm = undefined;
  }
}
