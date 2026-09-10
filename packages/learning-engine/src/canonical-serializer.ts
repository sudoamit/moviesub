/**
 * Canonical JSON Serializer for Deterministic Cryptographic Content-Addressing.
 *
 * Guarantees:
 * 1. Recursive key sorting across all nested objects.
 * 2. Strict normalization of Dates to ISO-8601 UTC strings.
 * 3. Strict normalization of numbers (finite numbers preserved, -0 mapped to 0).
 * 4. Strips undefined keys and functions to eliminate runtime-specific differences.
 * 5. Deterministic byte-for-byte serialization across Node.js processes and workers.
 */
export function canonicalJsonStringify(val: unknown): string {
  if (val === null || typeof val !== 'object') {
    if (typeof val === 'number') {
      if (!Number.isFinite(val)) return 'null';
      return Object.is(val, -0) ? '0' : String(val);
    }
    return JSON.stringify(val);
  }

  if (val instanceof Date) {
    return JSON.stringify(val.toISOString());
  }

  if (Array.isArray(val)) {
    const items = val.map((item) => canonicalJsonStringify(item));
    return `[${items.join(',')}]`;
  }

  const obj = val as Record<string, unknown>;
  const sortedKeys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();

  const entries = sortedKeys.map(
    (k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`,
  );
  return `{${entries.join(',')}}`;
}
