/**
 * File: src/types.ts
 *
 * Purpose:
 *   Central TypeScript types for the web practice implementation that mirrors
 *   the PTB practice flow (run 1/run 2, catch-only trials, deterministic input,
 *   and provenance-heavy metadata logging).
 *
 * Usage example:
 *   import type { PracticeSessionResult, SharedInputDataset } from './types';
 *
 * Notes:
 *   - These types are intentionally explicit so JSON/CSV export schemas remain
 *     stable and easy to parse in downstream analysis scripts.
 *   - All fields are ASCII and use simple scalar values where possible.
 */

export type ConditionLabel =
  | 'always_visible'
  | 'occluded_nondeviant'
  | 'occluded_deviant';

export interface Point2D {
  x: number;
  y: number;
}

export interface SourceTrial {
  sourceIndex: number;
  sourceTrialId: string;
  sequenceId: number;
  conditionCode: number;
  conditionLabel: ConditionLabel;
  devianceFrame: number;
  occlusionStartFrame: number;
  occlusionCompleteFrame: number;
  occlusionEndFrame: number;
  occlusionEndCompleteFrame: number;
  pathId: string;
  xy: Point2D[];
}

export interface CatchSettings {
  catchType1DisappearRangeSec: [number, number];
  catchType1InvisibleDurationSec: number;
  catchType1ChangedPathProbability: number;
  catchQuestionTimeoutSec: number;
  catchResponseYesCode: 1;
  catchResponseNoCode: 2;
  catchQuestionText: string;
}

export interface SharedInputDataset {
  datasetVersion: string;
  datasetId: string;
  datasetHash: string;
  seed: number;
  fps: number;
  framesPerTrial: number;
  trialDurationSec: number;
  fixedDevianceFrame: number;
  fixedOcclusionEndFrame: number;
  trialsPerCondition: number;
  generatedAtIso: string;
  sourceTrials: SourceTrial[];
  schedule: {
    runsPerBlock: 3;
    runOrdersBase: {
      run1: number[];
      run2: number[];
      run3: number[];
    };
  };
}

export interface PracticeConfig {
  sharedInputSubjectId: number;
  sharedRandomSeed: number;
  run1TrialCount: number;
  run2TrialCount: number;
  catchSettings: CatchSettings;
}

export interface PracticeTrialPlan {
  runIndex: 1 | 2;
  executedTrialIndex: number;
  sourceIndex: number;
  sourceTrialId: string;
  sequenceId: number;
  sourceConditionLabel: ConditionLabel;
  sourcePathId: string;
  catchTypeCode: 1 | 2;
  catchTypeLabel: 'type1_disappear_reappear' | 'type2_occlusion_question';
  catchExpectedResponseCode: 1 | 2;
  catchBranchChangedPath: 0 | 1 | null;
  catchDisappearFrame: number | null;
  catchReappearFrame: number | null;
  catchAltSourceIndex: number | null;
  catchAltPathId: string | null;
  baseRunSourceOrder: number[];
  includedBaseSlots: number[];
  excludedBaseSlots: number[];
}

export interface TrialRuntimeResult {
  runIndex: 1 | 2;
  executedTrialIndex: number;
  sourceIndex: number;
  sourceTrialId: string;
  sourceConditionLabel: ConditionLabel;
  sourcePathId: string;
  catchTypeCode: 1 | 2;
  catchTypeLabel: 'type1_disappear_reappear' | 'type2_occlusion_question';
  catchExpectedResponseCode: 1 | 2;
  catchResponseCode: 0 | 1 | 2;
  catchResponseLabel: 'none' | 'yes' | 'no';
  catchResponseCorrect: 0 | 1 | null;
  catchResponseRtMs: number | null;
  catchTimedOut: boolean;
  catchBranchChangedPath: 0 | 1 | null;
  catchDisappearFrame: number | null;
  catchReappearFrame: number | null;
  catchAltSourceIndex: number | null;
  catchAltPathId: string | null;
  plannedRunTrials: number;
  completedRunTrialsAtRecord: number;
  startedAtIso: string;
  endedAtIso: string;
}

export interface CatchTypeSummary {
  runIndex: 1 | 2;
  catchTypeCode: 1 | 2;
  catchTypeLabel: string;
  nCatchTrials: number;
  nScored: number;
  nAnswered: number;
  nCorrect: number;
  nTimedOut: number;
  accuracyPct: number | null;
  meanRtMs: number | null;
  medianRtMs: number | null;
}

export interface SessionSummary {
  byRunAndCatch: CatchTypeSummary[];
}

export interface PracticeSessionResult {
  sessionId: string;
  participantNumber: number;
  startedAtIso: string;
  endedAtIso: string;
  browserUserAgent: string;
  detectedRefreshHz: number;
  refreshMeasurementSamples: number;
  refreshDetectionMethod: 'raf_median' | 'override';
  targetInputFps: number;
  selectedInputDatasetId: string;
  selectedInputDatasetVersion: string;
  selectedInputDatasetHash: string;
  config: PracticeConfig;
  runPlans: {
    run1: PracticeTrialPlan[];
    run2: PracticeTrialPlan[];
  };
  runPlannedVsCompleted: {
    run1Planned: number;
    run1Completed: number;
    run2Planned: number;
    run2Completed: number;
  };
  trials: TrialRuntimeResult[];
  summary: SessionSummary;
}

export interface ExportArtifacts {
  behaviorJson: string;
  metadataJson: string;
  metadataCsv: string;
}

export interface RefreshDetectionResult {
  detectedRefreshHz: number;
  sampleCount: number;
  method: 'raf_median' | 'override';
}

export interface QueryOverrides {
  testMode: boolean;
  participantNumber: number | null;
  run1TrialCount: number | null;
  run2TrialCount: number | null;
  fpsOverride: number | null;
  autoStart: boolean;
}
