// SPDX-License-Identifier: EUPL-1.2
/**
 * The unified diff as git writes it (`git diff --binary`, `git diff-tree -p`):
 * a {@link Patch} of per-file {@link FileDiff} sections, parsed from bytes and
 * written back to the same bytes.
 *
 * Bytes and strings: a patch is bytes. {@link parsePatch} decodes it once, as
 * UTF-8 when the whole input is valid UTF-8 and as Latin-1 (one character per
 * byte) otherwise, and records the choice in `encoding`. {@link formatPatch}
 * encodes every string back the same way, so parse then format is the
 * identity on any input. Patches FireForge generates are always valid UTF-8,
 * because the generator turns a file that is not into a binary section; the
 * Latin-1 reading exists for patches written elsewhere, and for those it
 * reads a Latin-1 file's lines as the right characters.
 *
 * Every line is kept verbatim (headers, hunk headers, `\ No newline` markers,
 * binary payloads, lines that belong to nothing), so a section of real git
 * output never loses a byte. The parsed fields are a reading of those lines.
 */
import { unquoteC } from '../kernel/text.js';

/** How a patch's bytes map to the strings of its model. */
export type PatchEncoding = 'utf8' | 'latin1';

/** One `@@` hunk. */
export interface Hunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  /** The `@@ -a,b +c,d @@ heading` line as written. */
  readonly header: string;
  /**
   * Body lines with their ` `, `-` or `+` marker, including any
   * `\ No newline at end of file` line, which annotates the line before it.
   */
  readonly lines: readonly string[];
  /** Lines after the body that belong to no hunk. Empty for git output. */
  readonly trailing: readonly string[];
}

/** How a section changes its file. */
export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied';

/** One `diff --git` section. */
export interface FileDiff {
  /** The `a/` side, unquoted. */
  readonly oldPath: string;
  /** The `b/` side, unquoted. */
  readonly newPath: string;
  /** The path the section is about: `oldPath` for a deletion, `newPath` otherwise. */
  readonly path: string;
  readonly status: FileStatus;
  readonly oldMode?: string;
  readonly newMode?: string;
  /** Blob ids from the `index` line, as written (abbreviated or full). */
  readonly oldHash?: string;
  readonly newHash?: string;
  /**
   * `patch` for a `GIT binary patch`, whose payload recreates the bytes;
   * `stub` for `Binary files … differ`, which records a change and carries none
   * of it. Absent for a text section.
   */
  readonly binary?: 'patch' | 'stub';
  /** The `diff --git` line and every line up to the first hunk or binary payload. */
  readonly header: readonly string[];
  readonly hunks: readonly Hunk[];
  /** From `GIT binary patch` to the end of the section, as written. */
  readonly binaryPatch: readonly string[];
  readonly encoding: PatchEncoding;
}

/** A parsed patch. */
export interface Patch {
  /** Lines before the first section (a mail header, commentary). Empty for git output. */
  readonly preamble: readonly string[];
  readonly files: readonly FileDiff[];
  /** How the preamble decodes; each file records its own. */
  readonly encoding: PatchEncoding;
  /**
   * `\r\n` when every line of the input ended so (a patch file saved with CRLF
   * line endings). That `\r` is then part of no line; a `\r` in the content of
   * a CRLF file under an LF patch stays in its line.
   */
  readonly eol: '\n' | '\r\n';
  /** False when the input's last line has no line ending. */
  readonly finalNewline: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function decode(input: Uint8Array): { text: string; encoding: PatchEncoding } {
  try {
    return { text: UTF8.decode(input), encoding: 'utf8' };
  } catch {
    return { text: Buffer.from(input).toString('latin1'), encoding: 'latin1' };
  }
}

/** A path as git wrote it (quoted or bare), decoded from its bytes as UTF-8. */
function headerPath(raw: string, quoted: boolean, encoding: PatchEncoding): string {
  return (quoted ? unquoteC(raw, encoding) : Buffer.from(raw, encoding)).toString('utf8');
}

const QUOTED_HEADER =
  /^(?:"[ab]\/((?:[^"\\]|\\.)*)"|[ab]\/(\S+)) (?:"[ab]\/((?:[^"\\]|\\.)*)"|[ab]\/(.+))$/;

/**
 * Reads the two paths of a `diff --git` line. The quoted form is unquoted;
 * the bare form is split symmetrically first (`a/<p> b/<p>`), which is exact
 * even when `<p>` holds ` b/`, and at the first ` b/` otherwise.
 *
 * @param line - The line
 * @param encoding - How the line's characters map to bytes
 * @returns The paths, or undefined when the line is not a `diff --git` header
 */
export function parseGitHeader(
  line: string,
  encoding: PatchEncoding = 'utf8'
): { oldPath: string; newPath: string } | undefined {
  if (!line.startsWith('diff --git ')) return undefined;
  const body = line.slice('diff --git '.length);
  const quoted = QUOTED_HEADER.exec(body);
  if (quoted && (quoted[1] !== undefined || quoted[3] !== undefined)) {
    return {
      oldPath: headerPath(quoted[1] ?? quoted[2] ?? '', quoted[1] !== undefined, encoding),
      newPath: headerPath(quoted[3] ?? quoted[4] ?? '', quoted[3] !== undefined, encoding),
    };
  }
  if (!body.startsWith('a/') || /[\n\r\u2028\u2029]/.test(body)) return undefined;
  const rest = body.slice(2);
  if ((rest.length - 3) % 2 === 0) {
    const candidate = rest.slice(0, (rest.length - 3) / 2);
    if (rest === `${candidate} b/${candidate}`) {
      const path = headerPath(candidate, false, encoding);
      return { oldPath: path, newPath: path };
    }
  }
  const split = rest.indexOf(' b/', 1);
  if (split === -1 || split + 3 >= rest.length) return undefined;
  return {
    oldPath: headerPath(rest.slice(0, split), false, encoding),
    newPath: headerPath(rest.slice(split + 3), false, encoding),
  };
}

interface SectionFields {
  oldPath: string;
  newPath: string;
  status: FileStatus;
  oldMode?: string;
  newMode?: string;
  oldHash?: string;
  newHash?: string;
  binary?: 'patch' | 'stub';
}

/** Reads one extended header line into `fields`. Unknown lines are ignored. */
function readHeaderLine(line: string, fields: SectionFields, encoding: PatchEncoding): void {
  const match =
    /^(new file mode|deleted file mode|old mode|new mode|rename from|rename to|copy from|copy to) (.+)$/.exec(
      line
    );
  const [, key, value = ''] = match ?? [];
  if (key === 'new file mode') {
    fields.status = 'added';
    fields.newMode = value;
  } else if (key === 'deleted file mode') {
    fields.status = 'deleted';
    fields.oldMode = value;
  } else if (key === 'old mode') fields.oldMode = value;
  else if (key === 'new mode') fields.newMode = value;
  else if (key !== undefined) {
    fields.status = key.startsWith('rename') ? 'renamed' : 'copied';
    const path = headerPath(value, value.startsWith('"'), encoding);
    if (key.endsWith('from')) fields.oldPath = path;
    else fields.newPath = path;
  } else if (/^Binary files .* differ$/.test(line)) fields.binary = 'stub';
  else {
    const index = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?$/.exec(line);
    if (index?.[1] !== undefined && index[2] !== undefined) {
      fields.oldHash = index[1];
      fields.newHash = index[2];
      if (index[3] !== undefined) {
        fields.oldMode ??= index[3];
        fields.newMode ??= index[3];
      }
    }
  }
}

/** A parsed hunk header, or undefined. */
function hunkCounts(
  line: string
): Pick<Hunk, 'oldStart' | 'oldCount' | 'newStart' | 'newCount'> | undefined {
  const match = HUNK_HEADER.exec(line);
  if (!match) return undefined;
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
}

class Walker {
  index = 0;
  constructor(
    readonly lines: readonly string[],
    readonly encoding: PatchEncoding
  ) {}

  get line(): string | undefined {
    return this.lines[this.index];
  }

  atSection(): boolean {
    const line = this.line;
    return line !== undefined && parseGitHeader(line, this.encoding) !== undefined;
  }

  atHunk(): boolean {
    const line = this.line;
    return line !== undefined && HUNK_HEADER.test(line);
  }

  /** Takes lines while `keep` holds, up to the next section. */
  takeWhile(keep: (line: string) => boolean): string[] {
    const taken: string[] = [];
    while (this.line !== undefined && !this.atSection() && keep(this.line)) {
      taken.push(this.line);
      this.index++;
    }
    return taken;
  }
}

/**
 * Reads a hunk body by its header counts, as `git apply` does: a line that
 * does not fit (or the end of the counts) ends it. An empty line inside the
 * counts is an empty context line.
 */
function readHunk(walker: Walker): Hunk {
  const header = walker.line ?? '';
  const counts = hunkCounts(header) ?? { oldStart: 0, oldCount: 0, newStart: 0, newCount: 0 };
  walker.index++;
  const lines: string[] = [];
  let oldLeft = counts.oldCount;
  let newLeft = counts.newCount;
  for (let line = walker.line; line !== undefined; line = walker.line) {
    const marker = line.charAt(0);
    if (marker === '\\') {
      if (lines.length === 0) break;
    } else if (oldLeft <= 0 && newLeft <= 0) break;
    else if (marker === ' ' || line === '') {
      oldLeft--;
      newLeft--;
    } else if (marker === '-') oldLeft--;
    else if (marker === '+') newLeft--;
    else break;
    lines.push(line);
    walker.index++;
  }
  const trailing = walker.takeWhile(() => !walker.atHunk());
  return { ...counts, header, lines, trailing };
}

function readSection(walker: Walker): FileDiff {
  const encoding = walker.encoding;
  const first = walker.line ?? '';
  const paths = parseGitHeader(first, encoding) ?? { oldPath: '', newPath: '' };
  const fields: SectionFields = { ...paths, status: 'modified' };
  walker.index++;
  const header = [
    first,
    ...walker.takeWhile((line) => !walker.atHunk() && line !== 'GIT binary patch'),
  ];
  for (const line of header.slice(1)) readHeaderLine(line, fields, encoding);
  const hunks: Hunk[] = [];
  let binaryPatch: string[] = [];
  if (walker.line === 'GIT binary patch') {
    fields.binary = 'patch';
    binaryPatch = walker.takeWhile(() => true);
  } else {
    while (walker.atHunk()) hunks.push(readHunk(walker));
  }
  return {
    ...fields,
    path: fields.status === 'deleted' ? fields.oldPath : fields.newPath,
    header,
    hunks,
    binaryPatch,
    encoding,
  };
}

/**
 * Parses a patch. Never throws: what it cannot read is kept verbatim as
 * preamble, header or trailing lines.
 *
 * @param input - The patch bytes, or text already decoded (taken as UTF-8)
 */
export function parsePatch(input: string | Uint8Array): Patch {
  const { text, encoding } =
    typeof input === 'string' ? { text: input, encoding: 'utf8' as const } : decode(input);
  const lines = text === '' ? [] : text.split('\n');
  const finalNewline = lines.at(-1) === '' || lines.length === 0;
  if (lines.at(-1) === '') lines.pop();
  const crlf = finalNewline && lines.length > 0 && lines.every((line) => line.endsWith('\r'));
  const walker = new Walker(crlf ? lines.map((line) => line.slice(0, -1)) : lines, encoding);
  const preamble = walker.takeWhile(() => true);
  const files: FileDiff[] = [];
  while (walker.atSection()) files.push(readSection(walker));
  return { preamble, files, encoding, eol: crlf ? '\r\n' : '\n', finalNewline };
}

/** Every line of a section, in order. */
function sectionLines(file: FileDiff): string[] {
  return [
    ...file.header,
    ...file.hunks.flatMap((hunk) => [hunk.header, ...hunk.lines, ...hunk.trailing]),
    ...file.binaryPatch,
  ];
}

/**
 * Writes a patch back to bytes: the exact input of {@link parsePatch} for a
 * parsed patch. A patch assembled from other patches' sections encodes each
 * section by its own `encoding`.
 *
 * @param patch - The patch
 */
export function formatPatch(patch: Patch): Buffer {
  const groups: Array<{ lines: readonly string[]; encoding: PatchEncoding }> = [
    { lines: patch.preamble, encoding: patch.encoding },
    ...patch.files.map((file) => ({ lines: sectionLines(file), encoding: file.encoding })),
  ];
  const chunks = groups
    .filter((group) => group.lines.length > 0)
    .map((group) => Buffer.from(group.lines.join(patch.eol) + patch.eol, group.encoding));
  const bytes = Buffer.concat(chunks);
  return patch.finalNewline || bytes.length === 0
    ? bytes
    : bytes.subarray(0, bytes.length - patch.eol.length);
}
