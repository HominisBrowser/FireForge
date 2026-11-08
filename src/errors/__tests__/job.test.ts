// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { ExitCode } from '../codes.js';
import {
  InvalidLogRangeError,
  JobCannotRunError,
  JobError,
  jobRefusal,
  UnknownJobError,
  UnknownSlotError,
} from '../job.js';

describe('a refusal that crossed the coordinator socket', () => {
  it.each([
    ['UnknownJobError', UnknownJobError],
    ['UnknownSlotError', UnknownSlotError],
    ['InvalidLogRangeError', InvalidLogRangeError],
    ['JobCannotRunError', JobCannotRunError],
  ])('comes back as %s', (name, kind) => {
    const cause = new Error('over the socket');
    const refusal = jobRefusal(name, 'what to do', cause);
    expect(refusal).toBeInstanceOf(kind);
    expect(refusal.message).toContain('what to do');
    expect(refusal.code).toBe(ExitCode.GENERAL_ERROR);
  });

  it.each([['SomethingElse'], [undefined]])('reads %s as a plain job refusal', (name) => {
    const refusal = jobRefusal(name, 'what to do');
    expect(refusal).toBeInstanceOf(JobError);
    expect(refusal).not.toBeInstanceOf(UnknownJobError);
  });
});
