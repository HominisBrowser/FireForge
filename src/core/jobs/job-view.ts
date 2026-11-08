// SPDX-License-Identifier: EUPL-1.2
import { type FileHandle, open } from 'node:fs/promises';
import { join } from 'node:path';

import { InvalidLogRangeError } from '../../errors/job.js';
import { getNodeErrorCode } from '../../utils/errors.js';
import type { JobRecord, JobStep, JobView } from './schema.js';

/** What a client sees of a job: never the execution token, plus why it is waiting. */
export function visibleJob(job: JobRecord, blockedBy?: string): JobView {
  const visible: JobRecord = { ...job };
  delete visible.executionToken;
  return blockedBy === undefined ? visible : { ...visible, blockedBy };
}

const MAX_LOG_CHUNK = 1_048_576;

/** The line an executor writes into its job's log before a step's own output. */
const STEP_MARKER = 'FIREFORGE-JOB-STEP: ';

/** The marker line for step `index`, which `job logs --step` finds that step's output by. */
export const stepMarker = (index: number, step: JobStep): string =>
  `${STEP_MARKER}${JSON.stringify({ index, ...step })}\n`;

/** Where one step's latest run starts and ends in its job's log, in bytes. */
interface StepSpan {
  start: number;
  end: number;
}

const SCAN_CHUNK = 1_048_576;
const MARKER_LINE_BYTES = 65_536;

/** The byte offset of every marker line in a log. */
async function markerOffsets(file: FileHandle, size: number): Promise<number[]> {
  const needle = Buffer.from(`\n${STEP_MARKER}`);
  const offsets: number[] = [];
  const head = Buffer.alloc(Math.min(size, STEP_MARKER.length));
  await file.read(head, 0, head.length, 0);
  if (head.toString() === STEP_MARKER) offsets.push(0);
  const buffer = Buffer.alloc(SCAN_CHUNK + needle.length - 1);
  for (let position = 0; position < size; position += SCAN_CHUNK) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    const window = buffer.subarray(0, bytesRead);
    // A match starting past the chunk is found again, whole, at the start of the next one.
    for (
      let at = window.indexOf(needle);
      at >= 0 && at < SCAN_CHUNK;
      at = window.indexOf(needle, at + 1)
    )
      offsets.push(position + at + 1);
  }
  return offsets;
}

/** The step index a marker line names; a marker without one is matched to the request's steps. */
async function markerIndex(
  file: FileHandle,
  offset: number
): Promise<{ index?: number; step: string }> {
  const buffer = Buffer.alloc(MARKER_LINE_BYTES);
  const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
  const line = buffer.subarray(0, bytesRead).toString().split('\n', 1)[0] ?? '';
  try {
    const { index, ...step } = JSON.parse(line.slice(STEP_MARKER.length)) as { index?: unknown };
    return typeof index === 'number' ? { index, step: '' } : { step: JSON.stringify(step) };
  } catch {
    return { step: '' };
  }
}

/**
 * Each step's output in a job's log, by its marker lines. A step that ran again
 * after a requeue keeps its latest run. A marker naming no index is matched to
 * the next request step it equals, since a blocked step writes no marker at all.
 */
async function stepSpans(
  file: FileHandle,
  size: number,
  steps: readonly JobStep[]
): Promise<Map<number, StepSpan>> {
  const offsets = await markerOffsets(file, size);
  const spans = new Map<number, StepSpan>();
  let cursor = -1;
  for (const [position, start] of offsets.entries()) {
    const marker = await markerIndex(file, start);
    let index = marker.index;
    if (index === undefined) {
      const next = steps.findIndex(
        (step, at) => at > cursor && JSON.stringify(step) === marker.step
      );
      index = next >= 0 ? next : Math.max(cursor, 0);
    }
    cursor = index;
    spans.set(index, { start, end: offsets[position + 1] ?? size });
  }
  return spans;
}

/** What a log read can narrow to: one step's output, and its end rather than its start. */
export interface LogSelection {
  /** A step index, from 0 as in `artifacts/<job>/step-<n>-*`. */
  step?: number;
  /** Read the last `limit` bytes, from a line start, rather than from `offset`. */
  tail?: boolean;
  /** The request's steps, which place a marker that names no index. */
  steps?: readonly JobStep[];
}

export interface LogChunk {
  text: string;
  nextOffset: number;
  totalBytes: number;
  /** With a selection: where this chunk starts. Offsets count from the step's start under `step`. */
  offset?: number;
  /** With `step`: the step read. */
  step?: number;
  /** With a selection: every step with output in the log. */
  steps?: number[];
}

/** Bound log transport independently of potentially gigabyte-sized retained campaign logs. */
export async function readLogRange(
  namespace: string,
  jobId: string,
  offset = 0,
  limit = 262_144,
  selection?: LogSelection
): Promise<LogChunk> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LOG_CHUNK
  )
    throw new InvalidLogRangeError(
      `Invalid log range: --offset has to be a whole number from 0, and --limit one from 1 to ${String(MAX_LOG_CHUNK)} (1 MiB)`
    );
  let file;
  try {
    file = await open(join(namespace, 'logs', `${jobId}.log`), 'r');
  } catch (error) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    if (selection?.step !== undefined)
      throw new InvalidLogRangeError(
        `Step ${String(selection.step)} has no output: this job has no log yet`
      );
    return {
      text: '',
      nextOffset: offset,
      totalBytes: 0,
      ...(selection === undefined ? {} : { offset, steps: [] }),
    };
  }
  try {
    const size = (await file.stat()).size;
    if (selection === undefined) {
      const { bytes, ...range } = await readSpan(file, { start: 0, end: size }, offset, limit);
      return { text: bytes.toString(), ...range };
    }
    const spans = await stepSpans(file, size, selection.steps ?? []);
    const steps = [...spans.keys()].sort((a, b) => a - b);
    let span: StepSpan = { start: 0, end: size };
    if (selection.step !== undefined) {
      const found = spans.get(selection.step);
      if (found === undefined)
        throw new InvalidLogRangeError(
          `Step ${String(selection.step)} has no output in this job's log; ${steps.length === 0 ? 'no step has any yet' : `steps with output: ${steps.join(', ')}`}`
        );
      span = found;
    }
    const length = span.end - span.start;
    const from = selection.tail === true ? Math.max(0, length - limit) : offset;
    const chunk = await readSpan(file, span, from, limit);
    // A tail starts at a line, not in the middle of one.
    const cut = from > 0 && selection.tail === true ? chunk.bytes.indexOf(0x0a) + 1 : 0;
    return {
      text: chunk.bytes.subarray(cut).toString(),
      nextOffset: chunk.nextOffset,
      totalBytes: chunk.totalBytes,
      offset: from + cut,
      ...(selection.step === undefined ? {} : { step: selection.step }),
      steps,
    };
  } finally {
    await file.close();
  }
}

/** Up to `limit` bytes of a span, from `offset` within it. */
async function readSpan(
  file: FileHandle,
  span: StepSpan,
  offset: number,
  limit: number
): Promise<{ bytes: Buffer; nextOffset: number; totalBytes: number }> {
  const length = span.end - span.start;
  const wanted = Math.max(0, Math.min(limit, length - offset));
  const buffer = Buffer.alloc(wanted);
  const { bytesRead } =
    wanted === 0 ? { bytesRead: 0 } : await file.read(buffer, 0, wanted, span.start + offset);
  return {
    bytes: buffer.subarray(0, bytesRead),
    nextOffset: offset + bytesRead,
    totalBytes: length,
  };
}
