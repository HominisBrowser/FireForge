// SPDX-License-Identifier: EUPL-1.2
/** `firefox`: the pin, which Firefox release the project builds on. */
import { type Infer, s } from '../../kernel/schema.js';

/** The Mozilla products a project can pin. */
export const FIREFOX_PRODUCTS = [
  'firefox',
  'firefox-esr',
  'firefox-beta',
  'firefox-devedition',
] as const;

/** One of {@link FIREFOX_PRODUCTS}. */
export type FirefoxProduct = (typeof FIREFOX_PRODUCTS)[number];

/**
 * Why a version cannot be released as a product, or undefined when they pair:
 * an ESR product takes an `esr` version, beta and Developer Edition take a
 * beta version, and the stable product takes neither.
 *
 * @param version - Such as `153.4.0esr` or `147.0b1`
 * @param product - One of {@link FIREFOX_PRODUCTS}
 */
function productVersionProblem(version: string, product: FirefoxProduct): string | undefined {
  const esr = /esr$/i.test(version);
  const beta = /b\d+$/.test(version);
  if (product === 'firefox-esr' && !esr) {
    return `must pair product firefox-esr with an ESR version such as 128.0esr (got "${version}")`;
  }
  if ((product === 'firefox-beta' || product === 'firefox-devedition') && !beta) {
    return `must pair product ${product} with a beta version such as 147.0b1 (got "${version}")`;
  }
  if (product === 'firefox' && (esr || beta)) {
    const instead = esr ? 'firefox-esr' : 'firefox-beta';
    return `must use product ${instead} for version "${version}"; product firefox takes release versions only`;
  }
  return undefined;
}

/**
 * The product a version is released as, by its shape: an `esr` version is
 * ESR, a beta version is the beta product, anything else the stable one.
 *
 * @param version - Such as `153.4.0esr` or `147.0b1`
 */
export function inferFirefoxProduct(version: string): FirefoxProduct {
  if (/esr$/i.test(version)) return 'firefox-esr';
  return /b\d+$/.test(version) ? 'firefox-beta' : 'firefox';
}

/** The `firefox` section. */
export const firefoxSection = s
  .object({
    version: s
      .string({
        pattern: /^[1-9]\d{0,2}\.\d+(?:b[1-9]\d*|\.\d+(?:esr)?|esr)?$/,
        format: 'a Firefox version such as 153.4.0esr or 147.0b1',
      })
      .describe('Firefox release to build on, such as 153.4.0esr'),
    product: s.enum(FIREFOX_PRODUCTS).describe('Mozilla product the version belongs to'),
    sha256: s
      .string({ pattern: /^[a-f0-9]{64}$/, format: 'a lowercase 64-character SHA-256 digest' })
      .describe('Pinned digest of the source archive; wins over the published SHA256SUMS')
      .optional(),
    allowUnverifiedDownload: s
      .boolean()
      .describe(
        'Accept a download whose published digest cannot be fetched, trusting TLS alone; ignored when sha256 is set'
      )
      .default(false),
    candidate: s
      .string({ pattern: /^build[1-9]\d{0,3}$/, format: 'a candidate directory such as build2' })
      .describe('Release-candidate build directory, for pre-release verification')
      .optional(),
  })
  .refine(({ version, product }) => productVersionProblem(version, product))
  .describe('The Firefox release the project builds on');

/** The validated `firefox` section. */
export type FirefoxConfig = Infer<typeof firefoxSection>;
