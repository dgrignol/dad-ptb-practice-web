/**
 * File: src/lib/hash.ts
 *
 * Purpose:
 *   Provide stable lightweight hashes for dataset/version identification and
 *   export provenance fields.
 *
 * Usage example:
 *   const hash = fnv1aHash(JSON.stringify(payload));
 */

/**
 * 32-bit FNV-1a hash represented as 8-char hex.
 */
export function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
