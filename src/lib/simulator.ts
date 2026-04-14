/**
 * File: src/lib/simulator.ts
 *
 * Purpose:
 *   Lightweight deterministic simulator used by automated verification and
 *   optional test mode to validate run flow and output schemas without manual
 *   keyboard interaction.
 *
 * Usage example:
 *   const simulated = simulateSessionFlow(sessionSkeleton);
 */

import type { PracticeSessionResult, PracticeTrialPlan, TrialRuntimeResult } from '../types';
import { appendTrialResult, finalizeSession } from './practiceSession';

export interface SimulatedSessionOutput {
  session: PracticeSessionResult;
  flowEvents: string[];
}

/**
 * Simulate run1 -> transition -> run2 with deterministic responses.
 */
export function simulateSessionFlow(session: PracticeSessionResult): SimulatedSessionOutput {
  const flowEvents: string[] = [];
  let current = session;

  flowEvents.push('run1_start');
  current = playRun(current, 1, current.runPlans.run1);
  flowEvents.push('run1_end');

  flowEvents.push('run1_to_run2_transition');

  flowEvents.push('run2_start');
  current = playRun(current, 2, current.runPlans.run2);
  flowEvents.push('run2_end');

  current = finalizeSession(current, new Date().toISOString());
  flowEvents.push('session_end');

  return {
    session: current,
    flowEvents,
  };
}

function playRun(
  session: PracticeSessionResult,
  runIndex: 1 | 2,
  plans: PracticeTrialPlan[],
): PracticeSessionResult {
  let next = session;
  const runPlanned = plans.length;

  for (const plan of plans) {
    const response = deterministicResponse(plan.executedTrialIndex, plan.catchExpectedResponseCode);

    const correct =
      response.code > 0
        ? Number(response.code === plan.catchExpectedResponseCode) as 0 | 1
        : null;

    const trialResult: TrialRuntimeResult = {
      runIndex,
      executedTrialIndex: plan.executedTrialIndex,
      sourceIndex: plan.sourceIndex,
      sourceTrialId: plan.sourceTrialId,
      sourceConditionLabel: plan.sourceConditionLabel,
      sourcePathId: plan.sourcePathId,
      catchTypeCode: plan.catchTypeCode,
      catchTypeLabel: plan.catchTypeLabel,
      catchExpectedResponseCode: plan.catchExpectedResponseCode,
      catchResponseCode: response.code,
      catchResponseLabel: response.label,
      catchResponseCorrect: correct,
      catchResponseRtMs: response.rtMs,
      catchTimedOut: response.code === 0,
      catchBranchChangedPath: plan.catchBranchChangedPath,
      catchDisappearFrame: plan.catchDisappearFrame,
      catchReappearFrame: plan.catchReappearFrame,
      catchAltSourceIndex: plan.catchAltSourceIndex,
      catchAltPathId: plan.catchAltPathId,
      plannedRunTrials: runPlanned,
      completedRunTrialsAtRecord: plan.executedTrialIndex,
      startedAtIso: new Date().toISOString(),
      endedAtIso: new Date().toISOString(),
    };

    next = appendTrialResult(next, trialResult);
  }

  return next;
}

function deterministicResponse(
  trialIndex: number,
  expectedCode: 1 | 2,
): { code: 0 | 1 | 2; label: 'none' | 'yes' | 'no'; rtMs: number | null } {
  // Every 5th trial times out to exercise timeout logging.
  if (trialIndex % 5 === 0) {
    return {
      code: 0,
      label: 'none',
      rtMs: null,
    };
  }

  // Every 3rd non-timeout trial intentionally answers incorrectly.
  const shouldBeWrong = trialIndex % 3 === 0;
  const code = shouldBeWrong ? ((expectedCode === 1 ? 2 : 1) as 1 | 2) : expectedCode;

  return {
    code,
    label: code === 1 ? 'yes' : 'no',
    rtMs: 420 + trialIndex * 17,
  };
}
