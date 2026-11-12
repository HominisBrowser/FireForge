// SPDX-License-Identifier: EUPL-1.2
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { git, gitBytes, initRepo } from '../testing/git.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { formatPatch, parseGitHeader, parsePatch } from './model.js';

const MULTI_HUNK = [
  'diff --git a/browser/a.js b/browser/a.js',
  '--- a/browser/a.js',
  '+++ b/browser/a.js',
  '@@ -1,2 +1,2 @@',
  ' old-one',
  '-old-two',
  '+new-two',
  '@@ -8,1 +8,2 @@',
  ' context-eight',
  '+new-nine',
  '\\ No newline at end of file',
  'diff --git a/browser/b.css b/browser/b.css',
  '--- a/browser/b.css',
  '+++ b/browser/b.css',
  '@@ -1 +1 @@',
  '-red',
  '+blue',
  '',
].join('\n');

function roundTrips(input: string | Uint8Array): void {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  expect(formatPatch(parsePatch(bytes)).equals(bytes)).toBe(true);
}

describe('parsePatch', () => {
  it('reads sections, hunks and their exact body lines', () => {
    const patch = parsePatch(MULTI_HUNK);
    expect(patch.files.map((file) => [file.path, file.status])).toEqual([
      ['browser/a.js', 'modified'],
      ['browser/b.css', 'modified'],
    ]);
    const [first, second] = patch.files[0]?.hunks ?? [];
    expect(first).toMatchObject({ oldStart: 1, oldCount: 2, newStart: 1, newCount: 2 });
    expect(first?.lines).toEqual([' old-one', '-old-two', '+new-two']);
    expect(second?.lines).toEqual([' context-eight', '+new-nine', '\\ No newline at end of file']);
    // An omitted count is one line.
    expect(patch.files[1]?.hunks[0]).toMatchObject({ oldCount: 1, newCount: 1 });
    roundTrips(MULTI_HUNK);
  });

  it('reads new, deleted, mode-changed, renamed and copied sections', () => {
    const text = [
      'diff --git a/new.js b/new.js',
      'new file mode 100755',
      'index 0000000..1111111',
      '--- /dev/null',
      '+++ b/new.js',
      '@@ -0,0 +1 @@',
      '+created',
      'diff --git a/gone.js b/gone.js',
      'deleted file mode 100644',
      'index 2222222..0000000',
      '--- a/gone.js',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-removed',
      'diff --git a/run.sh b/run.sh',
      'old mode 100644',
      'new mode 100755',
      'diff --git a/old name.js b/new name.js',
      'similarity index 100%',
      'rename from old name.js',
      'rename to new name.js',
      'diff --git a/src.js b/"copy\\303\\274.js"',
      'copy from src.js',
      'copy to "copy\\303\\274.js"',
      '',
    ].join('\n');
    const files = parsePatch(text).files;
    expect(files.map((file) => [file.status, file.oldPath, file.newPath, file.path])).toEqual([
      ['added', 'new.js', 'new.js', 'new.js'],
      ['deleted', 'gone.js', 'gone.js', 'gone.js'],
      ['modified', 'run.sh', 'run.sh', 'run.sh'],
      ['renamed', 'old name.js', 'new name.js', 'new name.js'],
      ['copied', 'src.js', 'copyü.js', 'copyü.js'],
    ]);
    expect(files[0]).toMatchObject({ newMode: '100755', oldHash: '0000000', newHash: '1111111' });
    expect(files[1]?.oldMode).toBe('100644');
    expect(files[2]).toMatchObject({ oldMode: '100644', newMode: '100755', hunks: [] });
    roundTrips(text);
  });

  it('keeps a binary payload opaque, including lines that look like hunk content', () => {
    const text = [
      'diff --git a/icons/logo.png b/icons/logo.png',
      'new file mode 100644',
      'index 0000000000000000000000000000000000000000..fedcba0987654321fedcba0987654321fedcba09',
      'GIT binary patch',
      'literal 5',
      '+K}0e#0ssI2',
      '',
      'literal 0',
      'HcmV?d00001',
      '',
      'diff --git a/res/cert.der b/res/cert.der',
      'index 1d94f88ad7..37ae6960c3 100644',
      'Binary files a/res/cert.der and b/res/cert.der differ',
      'diff --git a/readme.txt b/readme.txt',
      'index abc1234..def5678 100644',
      '--- a/readme.txt',
      '+++ b/readme.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n');
    const [png, stub, readme] = parsePatch(text).files;
    expect(png).toMatchObject({ binary: 'patch', status: 'added', hunks: [] });
    expect(png?.binaryPatch.at(-1)).toBe('');
    expect(png?.newHash).toBe('fedcba0987654321fedcba0987654321fedcba09');
    // The stub carries correct ids but no bytes: `binary` tells them apart.
    expect(stub).toMatchObject({ binary: 'stub', oldHash: '1d94f88ad7', newHash: '37ae6960c3' });
    expect(readme?.binary).toBeUndefined();
    expect(readme).toMatchObject({ oldMode: '100644', newMode: '100644' });
    roundTrips(text);
  });

  it('parses a CRLF-saved patch like its LF twin and writes the CRLF back', () => {
    const crlf = MULTI_HUNK.split('\n').join('\r\n');
    const patch = parsePatch(crlf);
    expect(patch.eol).toBe('\r\n');
    expect(patch.files.map((file) => file.hunks.map((hunk) => hunk.lines))).toEqual(
      parsePatch(MULTI_HUNK).files.map((file) => file.hunks.map((hunk) => hunk.lines))
    );
    roundTrips(crlf);
  });

  it('keeps the carriage return of CRLF content in an LF patch', () => {
    const text =
      'diff --git a/win.txt b/win.txt\n--- a/win.txt\n+++ b/win.txt\n@@ -1 +1 @@\n-old\r\n+new\r\n';
    const patch = parsePatch(text);
    expect(patch.eol).toBe('\n');
    expect(patch.files[0]?.hunks[0]?.lines).toEqual(['-old\r', '+new\r']);
    roundTrips(text);
  });

  it('reads hunk bodies by their counts, so a removed "--- x" line is content', () => {
    const text = [
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '--- looks like a header',
      '+++ also looks like one',
      '',
    ].join('\n');
    const hunk = parsePatch(text).files[0]?.hunks[0];
    expect(hunk?.lines).toEqual([' keep', '--- looks like a header', '+++ also looks like one']);
    expect(hunk?.trailing).toEqual([]);
  });

  it('keeps a preamble, stray lines after a hunk and a missing final newline', () => {
    const text = [
      'From: someone',
      'Subject: a change',
      '',
      'diff --git a/x b/x',
      '--- a/x',
      '+++ b/x',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      '-- ',
      '2.40.0',
    ].join('\n');
    const patch = parsePatch(text);
    expect(patch.preamble).toEqual(['From: someone', 'Subject: a change', '']);
    expect(patch.files[0]?.hunks[0]?.trailing).toEqual(['-- ', '2.40.0']);
    expect(patch.finalNewline).toBe(false);
    roundTrips(text);
    roundTrips('');
  });

  it('decodes a patch that is not UTF-8 as Latin-1 and writes the same bytes back', () => {
    const bytes = Buffer.from(
      'diff --git a/l.properties b/l.properties\n--- a/l.properties\n+++ b/l.properties\n@@ -1 +1 @@\n-caf\xe9\n+caf\xe9!\n',
      'latin1'
    );
    const patch = parsePatch(bytes);
    expect(patch.encoding).toBe('latin1');
    expect(patch.files[0]?.encoding).toBe('latin1');
    expect(patch.files[0]?.hunks[0]?.lines).toEqual(['-café', '+café!']);
    roundTrips(bytes);
  });
});

describe('parseGitHeader', () => {
  it('unquotes quoted paths, decoding octal bytes as UTF-8', () => {
    expect(parseGitHeader('diff --git "a/dir/sp ace.js" "b/dir/sp ace.js"')).toEqual({
      oldPath: 'dir/sp ace.js',
      newPath: 'dir/sp ace.js',
    });
    expect(parseGitHeader('diff --git "a/f\\303\\274r.js" "b/f\\303\\274r.js"')).toEqual({
      oldPath: 'für.js',
      newPath: 'für.js',
    });
  });

  it('splits a bare header symmetrically even when the path holds " b/"', () => {
    expect(parseGitHeader('diff --git a/lib b/x.js b/lib b/x.js')).toEqual({
      oldPath: 'lib b/x.js',
      newPath: 'lib b/x.js',
    });
  });

  it('splits a rename at the first " b/" and refuses what is not a header', () => {
    expect(parseGitHeader('diff --git a/old.js b/new.js')).toEqual({
      oldPath: 'old.js',
      newPath: 'new.js',
    });
    expect(parseGitHeader('diff --git a/x b/')).toBeUndefined();
    expect(parseGitHeader('diff --git a/x b/y\nz')).toBeUndefined();
    expect(parseGitHeader('diff --cc file')).toBeUndefined();
  });

  it('rejects a long header with an embedded line break quickly', () => {
    const line = `diff --git a/${'a b/a'.repeat(50_000)}\n`;
    const started = performance.now();
    expect(parseGitHeader(line)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(500);
  });
});

/** One path segment: ASCII, a space, or non-ASCII characters. */
const segment = fc
  .array(
    fc.oneof(
      { weight: 6, arbitrary: fc.stringMatching(/^[a-z0-9_.-]$/) },
      { weight: 1, arbitrary: fc.constant(' ') },
      { weight: 1, arbitrary: fc.constantFrom('ä', 'ß', 'é', '日', 'ø', '€') }
    ),
    { minLength: 1, maxLength: 8 }
  )
  .map((chars) => chars.join(''))
  .filter((part) => part.trim() === part && part !== '.' && part !== '..');
const filePath = fc.array(segment, { minLength: 1, maxLength: 3 }).map((parts) => parts.join('/'));
const hunkBody = fc.array(
  fc
    .tuple(fc.constantFrom(' ', '+', '-'), fc.stringMatching(/^[a-z ]{0,12}$/))
    .map(([marker, text]) => `${marker}${text}`),
  { minLength: 1, maxLength: 4 }
);

/** git's C quoting under `core.quotePath`. */
function quote(path: string): string {
  let out = '';
  for (const byte of Buffer.from(path, 'utf8')) {
    out +=
      byte < 0x20 || byte >= 0x7f
        ? `\\${byte.toString(8).padStart(3, '0')}`
        : String.fromCharCode(byte);
  }
  return `"${out}"`;
}

describe('parsePatch properties', () => {
  it('recovers generated sections, paths, new-file markers and hunks, LF or CRLF', () => {
    const section = fc.record({
      path: filePath,
      added: fc.boolean(),
      quoted: fc.boolean(),
      hunks: fc.array(hunkBody, { maxLength: 2 }),
    });
    fc.assert(
      fc.property(
        fc.array(section, { minLength: 1, maxLength: 4 }),
        fc.constantFrom('\n', '\r\n'),
        (sections, eol) => {
          const lines = sections.flatMap((s) => [
            s.quoted
              ? `diff --git ${quote(`a/${s.path}`)} ${quote(`b/${s.path}`)}`
              : `diff --git a/${s.path} b/${s.path}`,
            ...(s.added ? ['new file mode 100644'] : []),
            'index 0000000..1111111 100644',
            `--- ${s.added ? '/dev/null' : `a/${s.path}`}`,
            `+++ b/${s.path}`,
            ...s.hunks.flatMap((body) => {
              const oldCount = body.filter((line) => !line.startsWith('+')).length;
              const newCount = body.filter((line) => !line.startsWith('-')).length;
              return [`@@ -1,${oldCount} +1,${newCount} @@`, ...body];
            }),
          ]);
          const text = lines.join(eol) + eol;
          const parsed = parsePatch(text);
          expect(parsed.files.map((file) => file.path)).toEqual(sections.map((s) => s.path));
          expect(parsed.files.map((file) => file.status === 'added')).toEqual(
            sections.map((s) => s.added)
          );
          expect(parsed.files.map((file) => file.hunks.map((hunk) => hunk.lines))).toEqual(
            sections.map((s) => s.hunks)
          );
          roundTrips(text);
        }
      )
    );
  });

  it('writes any input back byte for byte', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        roundTrips(bytes);
      })
    );
    const diffish = fc
      .array(
        fc.oneof(
          fc.constantFrom(
            'diff --git a/x b/x',
            '@@ -1 +1 @@',
            '@@ -0,0 +1,2 @@',
            'GIT binary patch',
            '\\ No newline at end of file',
            ''
          ),
          fc.string({ maxLength: 12 })
        ),
        { maxLength: 30 }
      )
      .map((lines) => lines.join('\n'));
    fc.assert(
      fc.property(diffish, fc.boolean(), (text, crlf) => {
        roundTrips(crlf ? text.split('\n').join('\r\n') : text);
      })
    );
  });

  it('finds sections only at diff --git headers', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }).filter((text) => !text.includes('\r')),
        (text) => {
          const headers = text.split('\n').filter((line) => parseGitHeader(line) !== undefined);
          expect(parsePatch(text).files).toHaveLength(headers.length);
        }
      )
    );
  });
});

describe('real git output', () => {
  const dir = useTempDir();

  it('round-trips byte for byte and names every path', async () => {
    const repo = dir();
    const latin1 = Buffer.from('caf\xe9=Caf\xe9\n', 'latin1');
    await initRepo(repo, {
      'text.js': 'one\ntwo\nthree\n',
      'latin1.properties': latin1,
      'icon.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
      'crlf.txt': 'a\r\nb\r\n',
      'gone.txt': 'bye\n',
      'run.sh': 'echo\n',
      'dir with space/für.js': 'x\n',
    });
    await writeTree(repo, {
      'text.js': 'one\n2\nthree',
      'latin1.properties': Buffer.from('caf\xe9=Caf\xe9!\n', 'latin1'),
      'icon.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]),
      'crlf.txt': 'a\r\nB\r\n',
      'dir with space/für.js': 'y\n',
      'new [1].txt': '',
    });
    await rm(join(repo, 'gone.txt'));
    await git(repo, ['add', '-A']);
    // The mode change is staged directly: not every filesystem has an executable bit.
    await git(repo, ['update-index', '--chmod=+x', 'run.sh']);
    const bytes = await gitBytes(repo, ['diff', '--cached', '--binary', '--no-renames', 'HEAD']);

    roundTrips(bytes);
    const patch = parsePatch(bytes);
    expect(patch.encoding).toBe('latin1');
    expect(patch.files.map((file) => `${file.status} ${file.path}`)).toEqual([
      'modified crlf.txt',
      'modified dir with space/für.js',
      'deleted gone.txt',
      'modified icon.png',
      'modified latin1.properties',
      'added new [1].txt',
      'modified run.sh',
      'modified text.js',
    ]);
    expect(patch.files.find((file) => file.path === 'icon.png')?.binary).toBe('patch');
  });
});
