/**
 * File: src/lib/analytics.ts
 *
 * Purpose:
 *   Compute PTB-style catch summaries by run and catch type from trial-level
 *   runtime results.
 *
 * Usage example:
 *   const summary = summarizeSession(trials);
 */

import type { CatchTypeSummary, SessionSummary, TrialRuntimeResult } from '../types';

export function summarizeSession(trials: TrialRuntimeResult[]): SessionSummary {
  const rows: CatchTypeSummary[] = [];

  const runIndexes: Array<1 | 2> = [1, 2];
  const catchTypeCodes: Array<1 | 2> = [1, 2];

  for (const runIndex of runIndexes) {
    for (const catchTypeCode of catchTypeCodes) {
      const subset = trials.filter(
        (trial) => trial.runIndex === runIndex && trial.catchTypeCode === catchTypeCode,
      );

      if (subset.length === 0) {
        continue;
      }

      const scored = subset.filter((trial) => trial.catchExpectedResponseCode > 0);
      const answered = scored.filter((trial) => trial.catchResponseCode > 0);
      const correct = scored.filter((trial) => trial.catchResponseCorrect === 1);
      const timedOut = scored.filter((trial) => trial.catchTimedOut);
      const rtValues = answered
        .map((trial) => trial.catchResponseRtMs)
        .filter((rt): rt is number => typeof rt === 'number' && Number.isFinite(rt) && rt >= 0);

      rows.push({
        runIndex,
        catchTypeCode,
        catchTypeLabel:
          catchTypeCode === 1 ? 'type1_disappear_reappear' : 'type2_occlusion_question',
        nCatchTrials: subset.length,
        nScored: scored.length,
        nAnswered: answered.length,
        nCorrect: correct.length,
        nTimedOut: timedOut.length,
        accuracyPct: scored.length > 0 ? (100 * correct.length) / scored.length : null,
        meanRtMs: rtValues.length > 0 ? mean(rtValues) : null,
        medianRtMs: rtValues.length > 0 ? median(rtValues) : null,
      });
    }
  }

  return {
    byRunAndCatch: rows,
  };
}

function mean(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}
