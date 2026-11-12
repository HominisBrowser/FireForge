// SPDX-License-Identifier: EUPL-1.2
/**
 * What a smoke start reads from the browser's console: which lines are
 * runtime errors, which of those the project allows, and the judgement over
 * one run's lines. Pure; launching and timing are `run.ts`.
 *
 * Error patterns are anchored at the start of the line: Firefox prints these
 * prefixes at column zero, and the same words inside an unrelated message
 * must not count.
 */
import { ExitCode, FireForgeError, toError } from '../kernel/errors.js';
import { splitLines } from '../kernel/text.js';

const ERROR_PATTERNS: readonly RegExp[] = [
  /^\s*JavaScript error:/i,
  /^\s*console\.error:/i,
  /^\s*\[JavaScript (Error|Warning)\]/i,
  // A fatal IPC assertion in the parent process.
  /^\s*###!!! \[Parent\]/,
  // A chrome:// or resource:// URL that resolves to nothing. Outside
  // automation Gecko only prints this; under a test harness the same defect
  // crashes the process that opened the channel.
  /^\s*Missing chrome or resource URLs?:/,
];

/**
 * Whether a console line is a runtime error of the browser.
 *
 * @param line - One output line
 */
export function isSmokeError(line: string): boolean {
  return ERROR_PATTERNS.some((pattern) => pattern.test(line));
}

/** mach's own log lines carry an elapsed-time prefix; they prove mach ran, not the browser. */
const MACH_LOG_LINE = /^\s*\d+:\d{2}\.\d{2} /;

/**
 * Whether a line is output of the browser rather than of mach.
 *
 * @param line - One output line
 */
export function isBrowserLine(line: string): boolean {
  return line.trim() !== '' && !MACH_LOG_LINE.test(line);
}

/** One pattern of lines that do not count against a smoke start. */
export interface AllowEntry {
  pattern: RegExp;
  /** The pattern as written. */
  source: string;
  /** Where it was written: `allow.txt:12`, or `--console-allow #2`. */
  origin: string;
  /** Most lines the entry may match in one run; more is a flood wearing an allowed shape. */
  maxHits?: number;
}

function invalid(message: string, cause?: unknown): FireForgeError {
  return new FireForgeError('invalid-argument', message, {
    exitCode: ExitCode.INVALID_ARGUMENT,
    ...(cause === undefined ? {} : { cause }),
  });
}

function compile(source: string, origin: string, maxHits: number | undefined): AllowEntry {
  try {
    return {
      pattern: new RegExp(source),
      source,
      origin,
      ...(maxHits === undefined ? {} : { maxHits }),
    };
  } catch (error: unknown) {
    throw invalid(`Invalid allowlist pattern at ${origin}: ${toError(error).message}`, error);
  }
}

/**
 * Compiles allowlist patterns given on the command line.
 *
 * @param sources - Regular expressions
 * @throws `invalid-argument` (exit code 8) naming the pattern that does not compile
 */
export function compileAllowlist(sources: readonly string[]): AllowEntry[] {
  return sources.map((source, index) =>
    compile(source, `--console-allow #${index + 1}`, undefined)
  );
}

const MAX_HITS = /^#\s*max-hits:\s*(\S+)\s*$/i;

/**
 * Parses an allowlist file: one regular expression per line, blank lines and
 * `#` comments skipped. A `# max-hits: N` comment caps the entry that follows
 * it; one that no entry follows is an error, never a silently dropped cap.
 *
 * @param body - The file's text
 * @param path - Its path, for origins and messages
 * @throws `invalid-argument` (exit code 8) naming the line at fault
 */
export function parseAllowlistFile(body: string, path: string): AllowEntry[] {
  const entries: AllowEntry[] = [];
  let pending: { maxHits: number; at: string } | undefined;
  const orphan = (): void => {
    if (pending !== undefined) {
      throw invalid(`The max-hits directive at ${pending.at} is not followed by an entry`);
    }
  };
  for (const [index, raw] of splitLines(body).entries()) {
    const line = raw.trim();
    const at = `${path}:${index + 1}`;
    if (line === '') {
      orphan();
    } else if (line.startsWith('#')) {
      const value = MAX_HITS.exec(line)?.[1];
      if (value === undefined) continue;
      if (!/^[1-9]\d*$/.test(value)) {
        throw invalid(`The max-hits directive at ${at} needs a positive integer (got "${value}")`);
      }
      pending = { maxHits: Number(value), at };
    } else {
      entries.push(compile(line, at, pending?.maxHits));
      pending = undefined;
    }
  }
  orphan();
  return entries;
}

/** What one smoke start's console held. */
export interface SmokeReport {
  /** Error lines no entry allows, in arrival order. */
  errors: string[];
  /** Error lines an entry allowed. */
  allowedErrors: number;
  /** Lines of the browser itself; none at all means it never reached a window. */
  browserLines: number;
  /** Per entry, how many lines it was the first to match. An entry at zero has gone stale. */
  entries: Array<{ source: string; origin: string; hits: number; maxHits?: number }>;
  /** Entries that matched more lines than their cap. */
  overCap: Array<{ source: string; origin: string; hits: number; maxHits: number }>;
}

/**
 * Starts the scan of one run's console.
 *
 * @param allowlist - The project's allowed patterns
 * @returns `line` for each output line, and `report` for the result so far
 */
export function createSmokeScan(allowlist: readonly AllowEntry[]): {
  line(line: string): void;
  report(): SmokeReport;
} {
  const hits = allowlist.map(() => 0);
  const errors: string[] = [];
  let allowedErrors = 0;
  let browserLines = 0;
  return {
    line(line) {
      if (isBrowserLine(line)) browserLines += 1;
      // The first matching entry is credited, whether or not the line is an
      // error: the count is what an operator tunes a cap against.
      const index = allowlist.findIndex((entry) => entry.pattern.test(line));
      if (index !== -1) hits[index] = (hits[index] ?? 0) + 1;
      if (!isSmokeError(line)) return;
      if (index === -1) errors.push(line);
      else allowedErrors += 1;
    },
    report() {
      const entries = allowlist.map((entry, index) => ({
        source: entry.source,
        origin: entry.origin,
        hits: hits[index] ?? 0,
        ...(entry.maxHits === undefined ? {} : { maxHits: entry.maxHits }),
      }));
      return {
        errors: [...errors],
        allowedErrors,
        browserLines,
        entries,
        overCap: entries.flatMap((entry) =>
          entry.maxHits !== undefined && entry.hits > entry.maxHits
            ? [{ ...entry, maxHits: entry.maxHits }]
            : []
        ),
      };
    },
  };
}

/** How the browser process of a smoke start ended. */
export interface SmokeExit {
  /** It was still running when the window elapsed, and was terminated for it. */
  timedOut: boolean;
  exitCode: number;
}

/**
 * The judgement over a smoke start, or undefined for a pass. Console errors
 * outrank everything: a browser that printed one and then lived out its
 * window still failed. A browser that left before the window elapsed failed
 * to launch, unless it left cleanly having shown a console. A window that
 * elapsed without one line from the browser proves no start either.
 *
 * @param report - What the console held
 * @param exit - How the browser ended
 * @returns `smoke-console-errors` (exit code 12) or `smoke-launch-failed` (exit code 13)
 */
export function smokeFailure(report: SmokeReport, exit: SmokeExit): FireForgeError | undefined {
  if (report.errors.length > 0 || report.overCap.length > 0) {
    const parts = [
      ...(report.errors.length > 0 ? [`${report.errors.length} console error(s)`] : []),
      ...(report.overCap.length > 0
        ? [
            `${report.overCap.length} allowlist entr${report.overCap.length === 1 ? 'y' : 'ies'} over the max-hits cap`,
          ]
        : []),
    ];
    return new FireForgeError(
      'smoke-console-errors',
      `The smoke start saw ${parts.join(' and ')}`,
      {
        exitCode: ExitCode.SMOKE_EXIT_FAILURE,
        hint: 'Fix the errors, or allow an expected line with --console-allow <regex>.',
      }
    );
  }
  if (exit.timedOut) {
    if (report.browserLines > 0) return undefined;
    return new FireForgeError(
      'smoke-launch-failed',
      'The smoke window elapsed without a line from the browser, so nothing shows it started',
      {
        exitCode: ExitCode.SMOKE_LAUNCH_FAILURE,
        hint:
          'mach may still have been preparing (a first run sets up its environment), or the browser ' +
          'is waiting on a dialog such as a locked profile: retry with a longer --smoke-exit, or run ' +
          'without it to watch the window.',
      }
    );
  }
  const clean = exit.exitCode === 0 || exit.exitCode === 130 || exit.exitCode === 143;
  if (clean && report.browserLines > 0) return undefined;
  return new FireForgeError(
    'smoke-launch-failed',
    clean
      ? `The browser exited ${exit.exitCode} before the smoke window elapsed without printing anything`
      : `The browser exited ${exit.exitCode} before the smoke window elapsed`,
    {
      exitCode: ExitCode.SMOKE_LAUNCH_FAILURE,
      hint: clean
        ? 'A silent early exit means the launch never reached a window: look for a locked profile or a startup-crash streak.'
        : 'Read the output above for the crash or startup error.',
    }
  );
}
