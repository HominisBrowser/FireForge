// SPDX-License-Identifier: EUPL-1.2
// Stamps dist/build-info.json with the source commit and dirty state so a
// tarball's identity is more than its semver: three distinct builds shipped
// as "0.41.0" before this existed (FORGE K2), one of them from an entirely
// uncommitted tree that no commit can reproduce (FORGE K3).
//
// `--loud` (used by prepack) additionally prints a prominent stderr banner
// when the tree is dirty; FIREFORGE_PACK_STRICT=1 turns that banner into a
// refusal for consumers that want the hard gate. Plain builds stay quiet
// and NEVER fail on git problems — a git-less staging directory must still
// build (the wrapper smoke test packs from one).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const rootUrl = new URL('../', import.meta.url);
const distUrl = new URL('./dist/', rootUrl);

function git(args) {
  return execFileSync('git', args, {
    cwd: rootUrl,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    // `git diff HEAD` over a large uncommitted wave exceeds the 1 MB
    // default and would silently null out the whole identity (ENOBUFS).
    maxBuffer: 512 * 1024 * 1024,
  });
}

const { version } = JSON.parse(await readFile(new URL('./package.json', rootUrl), 'utf8'));

function readGitIdentity() {
  try {
    const commit = git(['rev-parse', 'HEAD']).trim();
    const status = git(['status', '--porcelain']);
    const dirty = status.length > 0;
    // Distinguishes two dirty packs from the same HEAD: same uncommitted
    // content -> same hash, different content -> different identity.
    const dirtyHash = dirty
      ? createHash('sha256')
          .update(status)
          .update(git(['diff', 'HEAD']))
          .digest('hex')
          .slice(0, 8)
      : null;
    return { commit, dirty, dirtyHash };
  } catch {
    // Not a git checkout (staging dir, tarball rebuild): identity fields
    // stay null and --version falls back to the plain semver.
    return { commit: null, dirty: null, dirtyHash: null };
  }
}

const { commit, dirty, dirtyHash } = readGitIdentity();
const shortCommit = commit === null ? null : commit.slice(0, 12);
const buildInfo = {
  schemaVersion: 1,
  version,
  commit,
  shortCommit,
  dirty,
  dirtyHash,
  buildTime: new Date().toISOString(),
};

await mkdir(distUrl, { recursive: true });
await writeFile(new URL('./build-info.json', distUrl), `${JSON.stringify(buildInfo, null, 2)}\n`);

if (process.argv.includes('--loud') && dirty === true) {
  const identity = `${version}+g${shortCommit}.dirty`;
  const strict =
    process.env.FIREFORGE_PACK_STRICT === '1' || process.env.FIREFORGE_PACK_STRICT === 'true';
  const banner = [
    '='.repeat(72),
    `  Packing from a DIRTY working tree: this build is ${identity}`,
    `  (dirty content hash ${dirtyHash}). No commit reproduces these bytes;`,
    '  the identity above is recorded in dist/build-info.json and reported',
    '  by `fireforge --version`.',
    strict ? '  FIREFORGE_PACK_STRICT is set: refusing to pack.' : null,
    '='.repeat(72),
  ].filter((line) => line !== null);
  process.stderr.write(`${banner.join('\n')}\n`);
  if (strict) {
    process.exit(1);
  }
}
