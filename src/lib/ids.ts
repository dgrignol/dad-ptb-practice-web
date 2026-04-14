/**
 * File: src/lib/ids.ts
 *
 * Purpose:
 *   Deterministic-friendly ID and timestamp helpers for session/export naming.
 */

/**
 * Create a compact session identifier.
 */
export function createSessionId(participantNumber: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `sub${String(participantNumber).padStart(3, '0')}_${stamp}`;
}
