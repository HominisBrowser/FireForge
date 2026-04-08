// SPDX-License-Identifier: EUPL-1.2
/**
 * Filters an object to only include keys whose values are not undefined.
 * Designed for use with exactOptionalPropertyTypes — the result can be
 * spread into typed option objects without assigning undefined to optional properties.
 */
export function pickDefined<T extends Record<string, unknown>>(
  obj: T
): { [K in keyof T]+?: Exclude<T[K], undefined> } {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result as { [K in keyof T]+?: Exclude<T[K], undefined> };
}
