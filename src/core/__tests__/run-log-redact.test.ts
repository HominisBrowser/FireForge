// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { redactRunLogText } from '../run-log-redact.js';

describe('redactRunLogText', () => {
  it('masks env-style assignments whose key names a secret', () => {
    expect(redactRunLogText('GITHUB_TOKEN=ghp_abc123 MOZ_SECRET=s3cr3t')).toBe(
      'GITHUB_TOKEN=<redacted> MOZ_SECRET=<redacted>'
    );
    expect(redactRunLogText('export DB_PASSWORD=hunter2')).toBe('export DB_PASSWORD=<redacted>');
    expect(redactRunLogText('PASSWD=x api_key=y AUTH_HEADER=z')).toBe(
      'PASSWD=<redacted> api_key=<redacted> AUTH_HEADER=<redacted>'
    );
  });

  it('masks a whole quoted value, including embedded spaces', () => {
    expect(redactRunLogText('TOKEN="two words" next=1')).toBe('TOKEN=<redacted> next=1');
    expect(redactRunLogText("SECRET='a b c'")).toBe('SECRET=<redacted>');
  });

  it('leaves unrelated assignments and empty values untouched', () => {
    const line = 'MOZ_OBJDIR=obj-debug MACH_USE_SYSTEM_PYTHON=1 TOKEN= CFLAGS=-O2';
    expect(redactRunLogText(line)).toBe(line);
  });

  it('does not split mid-token, so dotted names are not treated as keys', () => {
    const line = 'set foo.SECRET_TOKEN=1 foo.bar=baz';
    expect(redactRunLogText(line)).toBe(line);
  });

  it('masks the --flag=value and -DNAME=value spellings that argv echoes carry', () => {
    expect(redactRunLogText('configure --token=ghp_abc --password=hunter2 -DAUTH_TOKEN=xyz')).toBe(
      'configure --token=<redacted> --password=<redacted> -DAUTH_TOKEN=<redacted>'
    );
    expect(redactRunLogText('--api_key=k --prefix=/opt CFLAGS=-O2')).toBe(
      '--api_key=<redacted> --prefix=/opt CFLAGS=-O2'
    );
  });

  it('treats a lone carriage return as a line boundary and preserves it', () => {
    expect(redactRunLogText('TOKEN=a\rTOKEN=b\r\nTOKEN=c\n')).toBe(
      'TOKEN=<redacted>\rTOKEN=<redacted>\r\nTOKEN=<redacted>\n'
    );
  });

  it('masks assignments inside JSON-ish or bracketed env dumps', () => {
    expect(redactRunLogText('env: {TOKEN=abc, HOME=/root}')).toBe(
      'env: {TOKEN=<redacted>, HOME=/root}'
    );
  });

  it('masks Authorization header credentials, keeping the scheme word', () => {
    expect(redactRunLogText('> Authorization: Bearer eyJhbGciOi.xxx.yyy')).toBe(
      '> Authorization: Bearer <redacted>'
    );
    expect(redactRunLogText('authorization: basic dXNlcjpwYXNz')).toBe(
      'authorization: basic <redacted>'
    );
    expect(redactRunLogText('Authorization: opaque-credential')).toBe('Authorization: <redacted>');
  });

  it('preserves line structure and every other byte', () => {
    const text = 'line one\nTOKEN=abc trailing\n\nlast line without newline';
    expect(redactRunLogText(text)).toBe(
      'line one\nTOKEN=<redacted> trailing\n\nlast line without newline'
    );
    expect(redactRunLogText('')).toBe('');
  });

  it('does not redact secrets that carry no recognized key or header', () => {
    // Space-separated flag values have no KEY= shape to anchor on.
    const line = 'curl https://x.example/?access=ghp_abc --password hunter2';
    expect(redactRunLogText(line)).toBe(line);
  });
});
