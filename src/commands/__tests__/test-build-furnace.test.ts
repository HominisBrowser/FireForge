// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());
vi.mock('../../core/furnace-staleness.js', () => ({ listStaleFurnaceComponents: vi.fn() }));
vi.mock('../test-verdict.js', () => ({ setVerdictRunAttribute: vi.fn() }));

import { listStaleFurnaceComponents } from '../../core/furnace-staleness.js';
import { notice, verbose } from '../../utils/logger.js';
import { reportPreTestFurnace } from '../test-build-furnace.js';
import { setVerdictRunAttribute } from '../test-verdict.js';

const PREPARED = {
  furnaceApplied: 2,
  reconfigured: false,
  furnaceAppliedNames: ['moz-a', 'moz-b'],
};

describe('reportPreTestFurnace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('names the deployed components on the verdict line and in a notice', async () => {
    await reportPreTestFurnace('/project', PREPARED, false);
    expect(setVerdictRunAttribute).toHaveBeenCalledWith('furnace-applied', 'moz-a,moz-b');
    expect(notice).toHaveBeenCalledWith(
      expect.stringContaining(
        'deployed 2 Furnace component(s) whose components/ source changed since their last deploy: moz-a, moz-b'
      )
    );
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('--no-furnace-apply'));
  });

  it('says nothing when the apply deployed nothing', async () => {
    await reportPreTestFurnace('/project', { furnaceApplied: 0, reconfigured: false }, false);
    expect(setVerdictRunAttribute).not.toHaveBeenCalled();
    expect(notice).not.toHaveBeenCalled();
  });

  it('names the undeployed edits a --no-furnace-apply build leaves out', async () => {
    vi.mocked(listStaleFurnaceComponents).mockResolvedValueOnce(['moz-c']);
    await reportPreTestFurnace('/project', { furnaceApplied: 0, reconfigured: false }, true);
    expect(setVerdictRunAttribute).toHaveBeenCalledWith('furnace-apply', 'skipped');
    expect(notice).toHaveBeenCalledWith(
      'Furnace apply skipped (--no-furnace-apply): engine/ is packaged as it stands. 1 component(s) with undeployed components/ edits are NOT in this build: moz-c.'
    );
  });

  it('degrades a failed pending-edit probe to the plain skip notice', async () => {
    vi.mocked(listStaleFurnaceComponents).mockRejectedValueOnce(new Error('broken furnace.json'));
    await reportPreTestFurnace('/project', { furnaceApplied: 0, reconfigured: false }, true);
    expect(verbose).toHaveBeenCalledWith(expect.stringContaining('broken furnace.json'));
    expect(notice).toHaveBeenCalledWith(
      'Furnace apply skipped (--no-furnace-apply): engine/ is packaged as it stands.'
    );
  });
});
