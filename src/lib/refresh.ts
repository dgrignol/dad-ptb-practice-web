/**
 * File: src/lib/refresh.ts
 *
 * Purpose:
 *   Detect nominal display refresh rate in browser via requestAnimationFrame
 *   timing and map it to the target input fps used by deterministic input
 *   selection/generation.
 *
 * Usage example:
 *   const refresh = await detectRefreshHz();
 *   const targetFps = mapRefreshToTargetFps(refresh.detectedRefreshHz);
 */

import type { RefreshDetectionResult } from '../types';

/**
 * Measure refresh rate from animation frame intervals.
 */
export async function detectRefreshHz(overrideHz?: number | null): Promise<RefreshDetectionResult> {
  if (overrideHz && Number.isFinite(overrideHz) && overrideHz > 0) {
    return {
      detectedRefreshHz: Math.round(overrideHz),
      sampleCount: 1,
      method: 'override',
    };
  }

  const deltas: number[] = [];
  const maxSamples = 90;
  let prev: number | null = null;

  await new Promise<void>((resolve) => {
    const step = (timestamp: number) => {
      if (prev !== null) {
        const dt = timestamp - prev;
        if (dt > 0) {
          deltas.push(dt);
        }
      }
      prev = timestamp;
      if (deltas.length >= maxSamples) {
        resolve();
      } else {
        window.requestAnimationFrame(step);
      }
    };
    window.requestAnimationFrame(step);
  });

  const sorted = deltas.slice().sort((a, b) => a - b);
  const medianDt = sorted[Math.floor(sorted.length / 2)] ?? 16.67;
  const hz = Math.max(30, Math.min(240, Math.round(1000 / medianDt)));

  return {
    detectedRefreshHz: hz,
    sampleCount: deltas.length,
    method: 'raf_median',
  };
}

/**
 * PTB-practice-style target fps resolution from detected refresh.
 */
export function mapRefreshToTargetFps(refreshHz: number): number {
  if (!Number.isFinite(refreshHz) || refreshHz <= 0) {
    return 60;
  }
  return Math.max(30, Math.min(240, Math.round(refreshHz)));
}
