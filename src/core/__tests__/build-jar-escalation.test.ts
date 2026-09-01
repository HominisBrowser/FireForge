// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readText } from '../../utils/fs.js';
import {
  evaluateJarManifestEscalation,
  formatJarEscalationNotice,
} from '../build-jar-escalation.js';
import { getUntrackedFilesInDir } from '../git-status.js';

vi.mock('../git-status.js', () => ({
  getUntrackedFilesInDir: vi.fn(() => Promise.resolve([] as string[])),
}));

vi.mock('../../utils/fs.js', () => ({
  readText: vi.fn(() => Promise.resolve('browser.jar:\n  content/browser/a.js (a.js)\n')),
}));

vi.mock('../../utils/logger.js', () => ({
  verbose: vi.fn(),
}));

const DEFAULT_MANIFEST =
  'browser.jar:\n% content browser %content/browser/\n  content/browser/a.js (a.js)\n';

describe('evaluateJarManifestEscalation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
    vi.mocked(readText).mockResolvedValue(DEFAULT_MANIFEST);
  });

  it('ignores non-jar.mn paths entirely', async () => {
    const decision = await evaluateJarManifestEscalation(
      '/engine',
      ['browser/base/moz.build', 'browser/base/content/foo.js'],
      undefined
    );
    expect(decision).toEqual({ escalate: false, causes: [], cleared: [] });
    expect(getUntrackedFilesInDir).not.toHaveBeenCalled();
  });

  // The experiment this narrowing came from: entries added to an EXISTING
  // dist/bin manifest were installed by `mach build faster` both times.
  it('clears an entry added to an existing default-destination manifest', async () => {
    const decision = await evaluateJarManifestEscalation(
      '/engine',
      ['browser/base/jar.mn'],
      undefined
    );
    expect(decision.escalate).toBe(false);
    expect(decision.cleared).toEqual(['browser/base/jar.mn']);
  });

  it('escalates for a manifest untracked in the engine repo (a NEW jar.mn)', async () => {
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue(['browser/new/jar.mn']);
    const decision = await evaluateJarManifestEscalation(
      '/engine',
      ['browser/new/jar.mn'],
      undefined
    );
    expect(decision.escalate).toBe(true);
    expect(decision.causes[0]?.reason).toContain('new jar.mn');
    // The file is never read: newness alone settles it.
    expect(readText).not.toHaveBeenCalled();
  });

  it('escalates for a bracketed base-directory prefix', async () => {
    vi.mocked(readText).mockResolvedValue('[localization] toolkit.jar:\n  en-US/x.ftl (x.ftl)\n');
    const decision = await evaluateJarManifestEscalation('/engine', ['toolkit/jar.mn'], undefined);
    expect(decision.escalate).toBe(true);
    expect(decision.causes[0]?.reason).toContain('redirects the install base directory');
  });

  // Indented `foo.jar:` inside a section is CONTENT, not a declaration —
  // treating it as one would escalate on ordinary manifests.
  it('does not read an indented jar-looking line as a declaration', async () => {
    vi.mocked(readText).mockResolvedValue('browser.jar:\n  [skin] something.jar:\n');
    const decision = await evaluateJarManifestEscalation('/engine', ['browser/jar.mn'], undefined);
    expect(decision.escalate).toBe(false);
  });

  // The narrowing must never turn an unanswerable question into a fast
  // build: both probes fail closed.
  it('escalates when the newness probe throws', async () => {
    vi.mocked(getUntrackedFilesInDir).mockRejectedValue(new Error('no git'));
    const decision = await evaluateJarManifestEscalation('/engine', ['browser/jar.mn'], undefined);
    expect(decision.escalate).toBe(true);
    expect(decision.causes[0]?.reason).toContain('could not determine');
  });

  it('escalates when the manifest cannot be read', async () => {
    vi.mocked(readText).mockRejectedValue(new Error('ENOENT'));
    const decision = await evaluateJarManifestEscalation('/engine', ['browser/jar.mn'], undefined);
    expect(decision.escalate).toBe(true);
    expect(decision.causes[0]?.reason).toContain('could not be read');
  });

  it('reports each cause with its manifest in the notice', async () => {
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue(['a/jar.mn']);
    const decision = await evaluateJarManifestEscalation('/engine', ['a/jar.mn'], undefined);
    const notice = formatJarEscalationNotice(decision);
    expect(notice).toContain('engine/a/jar.mn');
    expect(notice).toContain('new jar.mn');
    expect(notice).toContain('no longer escalates');
  });
});
