// SPDX-License-Identifier: EUPL-1.2
/**
 * Domain types for raw JSON documents (fireforge.json, furnace.json).
 *
 * FireForge reads and writes some documents in their raw, unvalidated
 * form. For example, `fireforge config --force` round-trips keys that
 * the validated `FireForgeConfig` schema would strip. These types give that
 * pipeline a concrete value contract: every value is JSON data, never a
 * function, class instance, symbol, or other non-serializable runtime value.
 */

/**
 * Any value representable in a JSON document.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

/**
 * A JSON object node. `undefined` is admitted as a property value (not a
 * `JsonValue`) so in-memory documents can be built field-by-field from
 * optional inputs. `JSON.stringify` drops such properties on write, exactly
 * like an absent key.
 */
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}
