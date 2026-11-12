// SPDX-License-Identifier: EUPL-1.2
/**
 * License-header rules: the acceptance policy for files the project creates
 * (`missing-license-header`), and the check that an upstream file the
 * project modifies still starts with a recognised header
 * (`modified-file-missing-header`).
 */
import {
  type CommentStyle,
  hasLicenseHeader,
  hasUpstreamMplHeader,
  type License,
  licenseHeader,
  mentionsLicense,
} from '../../project/index.js';
import type { Draft, Rule } from '../rule.js';
import { isJsFile } from '../rule.js';

/**
 * The comment style of a file kind that carries a header, or undefined.
 *
 * @param path - Engine-relative path
 */
function commentStyle(path: string): CommentStyle | undefined {
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.ftl')) return 'hash';
  return isJsFile(path) ? 'js' : undefined;
}

/**
 * Whether a created file's header is acceptable: the project's own header;
 * any recognised header under `browser/branding/` (copied from Firefox's
 * branding template) or in an MPL-2.0 project; or, in a block-comment file
 * kind, the verbatim upstream MPL block header of a file copied from
 * Firefox.
 *
 * @param path - Engine-relative path
 * @param content - File content
 * @param license - The project license
 */
export function acceptsCreatedHeader(path: string, content: string, license: License): boolean {
  const style = commentStyle(path);
  if (style === undefined) return true;
  if (content.startsWith(licenseHeader(license, style))) return true;
  if (
    (path.startsWith('browser/branding/') || license === 'MPL-2.0') &&
    hasLicenseHeader(content, style)
  ) {
    return true;
  }
  return style !== 'hash' && hasUpstreamMplHeader(content);
}

const missingHeader: Rule = {
  id: 'missing-license-header',
  severity: 'error',
  description: 'Files the project creates start with the project license header',
  check(context) {
    const license = context.config.license;
    return context.owned
      .all()
      .filter(
        (file) =>
          file.created &&
          file.text !== undefined &&
          context.selected(file.path) &&
          !acceptsCreatedHeader(file.path, file.text, license)
      )
      .map((file) => ({
        path: file.path,
        line: 1,
        group: file.group,
        message: `The file does not start with the ${license} license header.`,
      }));
  },
};

const modifiedHeader: Rule = {
  id: 'modified-file-missing-header',
  severity: 'warning',
  description: 'Upstream files the project modifies still start with a recognised license header',
  check(context) {
    return context.owned.all().flatMap((file): Draft[] => {
      const style = commentStyle(file.path);
      if (file.created || file.text === undefined || style === undefined) return [];
      if (!context.selected(file.path)) return [];
      const text = file.text;
      const recognised =
        (['js', 'css', 'hash'] as const).some((candidate) => hasLicenseHeader(text, candidate)) ||
        mentionsLicense(text);
      if (recognised) return [];
      return [
        {
          path: file.path,
          line: 1,
          group: file.group,
          message: 'This modified upstream file no longer starts with a recognised license header.',
        },
      ];
    });
  },
};

/** The license-header rules. */
export const licenseRules: readonly Rule[] = [missingHeader, modifiedHeader];
