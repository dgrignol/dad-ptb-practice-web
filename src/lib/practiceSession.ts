/**
 * File: src/lib/practiceSession.ts
 *
 * Purpose:
 *   Session assembly helpers that keep behavioral and metadata outputs aligned
 *   with run planning, trial provenance, and PTB-like summary fields.
 *
 * Usage example:
 *   const session = createSessionSkeleton(...);
 *   const updated = appendTrialResult(session, trialResult);
 */

import type {
  PracticeConfig,
  PracticeSessionResult,
  PracticeTrialPlan,
  SessionSummary,
  TrialRuntimeResult,
} from '../types';
import { summarizeSession } from './analytics';

interface CreateSessionArgs {
  sessionId: string;
  participantNumber: number;
  startedAtIso: string;
  browserUserAgent: string;
  detectedRefreshHz: number;
  refreshMeasurementSamples: number;
  refreshDetectionMethod: 'raf_median' | 'override';
  targetInputFps: number;
  selectedInputDatasetId: string;
  selectedInputDatasetVersion: string;
  selectedInputDatasetHash: string;
  config: PracticeConfig;
  run1Plan: PracticeTrialPlan[];
  run2Plan: PracticeTrialPlan[];
}

/**
 * Initialize a session with full static metadata and run plans.
 */
export function createSessionSkeleton(args: CreateSessionArgs): PracticeSessionResult {
  return {
    sessionId: args.sessionId,
    participantNumber: args.participantNumber,
    startedAtIso: args.startedAtIso,
    endedAtIso: args.startedAtIso,
    browserUserAgent: args.browserUserAgent,
    detectedRefreshHz: args.detectedRefreshHz,
    refreshMeasurementSamples: args.refreshMeasurementSamples,
    refreshDetectionMethod: args.refreshDetectionMethod,
    targetInputFps: args.targetInputFps,
    selectedInputDatasetId: args.selectedInputDatasetId,
    selectedInputDatasetVersion: args.selectedInputDatasetVersion,
    selectedInputDatasetHash: args.selectedInputDatasetHash,
    config: args.config,
    runPlans: {
      run1: args.run1Plan,
      run2: args.run2Plan,
    },
    runPlannedVsCompleted: {
      run1Planned: args.run1Plan.length,
      run1Completed: 0,
      run2Planned: args.run2Plan.length,
      run2Completed: 0,
    },
    trials: [],
    summary: {
      byRunAndCatch: [],
    },
  };
}

/**
 * Append one trial result and update per-run completion counters.
 */
export function appendTrialResult(
  session: PracticeSessionResult,
  trialResult: TrialRuntimeResult,
): PracticeSessionResult {
  const nextTrials = [...session.trials, trialResult];
  const run1Completed = nextTrials.filter((trial) => trial.runIndex === 1).length;
  const run2Completed = nextTrials.filter((trial) => trial.runIndex === 2).length;

  return {
    ...session,
    trials: nextTrials,
    runPlannedVsCompleted: {
      ...session.runPlannedVsCompleted,
      run1Completed,
      run2Completed,
    },
  };
}

/**
 * Finalize session timestamps and summary metrics.
 */
export function finalizeSession(
  session: PracticeSessionResult,
  endedAtIso: string,
): PracticeSessionResult {
  const summary: SessionSummary = summarizeSession(session.trials);
  return {
    ...session,
    endedAtIso,
    summary,
  };
}
