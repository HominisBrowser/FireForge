// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it, vi } from 'vitest';

import type { RebaseSession } from '../../../core/rebase-session.js';
import { createLoggerMock } from '../../../test-utils/module-mocks.js';
import { info } from '../../../utils/logger.js';
import { printSummary } from '../summary.js';

vi.mock('../../../utils/logger.js', () => createLoggerMock());

describe('printSummary', () => {
  it('prints source product context and total patch count', () => {
    const patches = [
      ...Array.from({ length: 72 }, (_, index) => ({
        filename: `${String(index + 1).padStart(3, '0')}-ui-clean.patch`,
        status: 'applied-clean' as const,
      })),
      { filename: '073-ui-manual.patch', status: 'resolved' as const },
      { filename: '074-ui-manual.patch', status: 'resolved' as const },
    ];
    const session: RebaseSession = {
      startedAt: '2026-06-03T00:00:00.000Z',
      fromProduct: 'firefox-esr',
      toProduct: 'firefox-devedition',
      fromVersion: '140.9.0esr',
      toVersion: '152.0b6',
      preRebaseCommit: 'abc123',
      patches,
      currentIndex: patches.length,
    };

    printSummary(session);

    expect(info).toHaveBeenCalledWith(
      'Source Rebase Summary: firefox-esr 140.9.0esr → firefox-devedition 152.0b6'
    );
    expect(info).toHaveBeenCalledWith(
      'Results: 74 total: 72 clean, 0 context-reduced, 2 manually resolved, 0 failed'
    );
  });
});
