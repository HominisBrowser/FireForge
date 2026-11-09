// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { JobView } from '../../core/jobs/schema.js';
import { InvalidArgumentError } from '../../errors/base.js';
import {
  artifactArguments,
  artifactLocations,
  artifactPath,
  namesArtifacts,
} from '../job-artifacts.js';

describe('what a job run writes', () => {
  it('puts each written file inside the step’s artifacts', () => {
    expect(artifactPath('--coverage', 'cov')).toBe('{artifacts}/cov');
    expect(artifactPath('--coverage', '{artifacts}/cov/js')).toBe('{artifacts}/cov/js');
    expect(artifactPath('--keep-log', 'logs/a.log/')).toBe('{artifacts}/logs/a.log');
    expect(
      artifactArguments({
        coverage: 'cov',
        perfSamples: 'perf.json',
        keepLog: 'harness.log',
        profileFile: ['tools/sheet.css=chrome/userChrome.css'],
      })
    ).toEqual([
      '--coverage',
      '{artifacts}/cov',
      '--perf-samples',
      '{artifacts}/perf.json',
      '--keep-log',
      '{artifacts}/harness.log',
      '--profile-file',
      'tools/sheet.css=chrome/userChrome.css',
    ]);
    expect(artifactArguments({})).toEqual([]);
    expect(namesArtifacts({})).toBe(false);
    expect(namesArtifacts({ profileFile: [] })).toBe(true);
  });

  it('refuses a path that leaves where it is put', () => {
    for (const value of ['/tmp/cov', '~/cov', '../cov', 'a/../../b', '', '.', 'a\\b', 'a//b'])
      expect(() => artifactPath('--coverage', value), value).toThrow(InvalidArgumentError);
    expect(() => artifactPath('--coverage', '{artifacts}/../x')).toThrow(/plain relative path/);
    for (const pair of ['sheet.css', 'a=b=c', '/abs.css=chrome/a.css', 'a.css=../a.css', 'a.css='])
      expect(() => artifactArguments({ profileFile: [pair] }), pair).toThrow(InvalidArgumentError);
  });

  it('says where each artifact landed', () => {
    const job = {
      id: 'job-1',
      request: {
        steps: [
          { command: 'build', args: ['--ui'] },
          {
            command: 'test',
            args: ['--headless', '--keep-log', '{artifacts}/harness.log', '--coverage=cov', 'a.js'],
          },
        ],
      },
      outputs: [
        { step: 1, path: '/ns/artifacts/job-1/step-1-output' },
        { step: 7, path: '/ns/elsewhere' },
      ],
    } as unknown as JobView;
    expect(artifactLocations(job)).toEqual([
      'Job job-1 --keep-log: /ns/artifacts/job-1/step-1-output/harness.log',
    ]);
    expect(artifactLocations({ ...job, outputs: undefined } as unknown as JobView)).toEqual([]);
  });
});
