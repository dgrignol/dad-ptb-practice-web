/**
 * File: src/lib/query.ts
 *
 * Purpose:
 *   Parse URL query overrides, including safe test mode controls for
 *   automated checks and non-interactive runs.
 *
 * Usage example:
 *   const overrides = parseQueryOverrides(window.location.search);
 */

import type { QueryOverrides } from '../types';

function parseOptionalInt(raw: string | null): number | null {
  if (!raw) {
    return null;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    return null;
  }
  return value;
}

export function parseQueryOverrides(search: string): QueryOverrides {
  const params = new URLSearchParams(search);
  const testMode = params.get('testMode') === '1';
  const autoStart = params.get('autoStart') === '1' || testMode;

  return {
    testMode,
    participantNumber: parseOptionalInt(params.get('participant')),
    run1TrialCount: parseOptionalInt(params.get('run1')),
    run2TrialCount: parseOptionalInt(params.get('run2')),
    fpsOverride: parseOptionalInt(params.get('fps')),
    autoStart,
  };
}
