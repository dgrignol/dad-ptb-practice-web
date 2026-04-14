/**
 * File: src/lib/practiceScheduler.ts
 *
 * Purpose:
 *   Reproduce PTB practice-mode run planning in a browser-safe deterministic
 *   way: run trimming + forced catch logic + provenance of included/excluded
 *   source slots.
 *
 * Usage example:
 *   const run1Plan = buildPracticeRunPlan({
 *     dataset,
 *     runIndex: 1,
 *     targetTrialCount: 8,
 *     catchSettings: cfg.catchSettings,
 *     seed: 9101001,
 *   });
 */

import type {
  CatchSettings,
  PracticeTrialPlan,
  SharedInputDataset,
} from '../types';
import { createSeededRng, chooseSortedIndices, sampleInt } from './seededRandom';
import { fallbackAlternateSourceIndex, findMatchingDeviantForSequence, sourceTrialByIndex } from './inputGeneration';

interface BuildPracticeRunPlanArgs {
  dataset: SharedInputDataset;
  runIndex: 1 | 2;
  targetTrialCount: number;
  catchSettings: CatchSettings;
  seed: number;
}

/**
 * Build one run plan with catch-only trials and full provenance annotations.
 */
export function buildPracticeRunPlan(args: BuildPracticeRunPlanArgs): PracticeTrialPlan[] {
  const baseOrder = getBaseRunOrder(args.dataset, args.runIndex);
  const maxTrials = baseOrder.length;
  const nKeep = Math.max(1, Math.min(maxTrials, Math.round(args.targetTrialCount)));

  const rng = createSeededRng(args.seed);
  const selectedSlotsZeroBased = chooseSortedIndices(rng, maxTrials, nKeep);
  const selectedSlotsOneBased = selectedSlotsZeroBased.map((slot) => slot + 1);
  const excludedSlotsOneBased = Array.from({ length: maxTrials }, (_, i) => i + 1).filter(
    (slot) => !selectedSlotsOneBased.includes(slot),
  );

  const selectedSourceIndexes = selectedSlotsZeroBased.map((slot) => baseOrder[slot]);

  return selectedSourceIndexes.map((sourceIndex, i) => {
    const sourceTrial = sourceTrialByIndex(args.dataset, sourceIndex);

    if (args.runIndex === 1) {
      return buildRun1CatchPlan({
        dataset: args.dataset,
        sourceIndex,
        sourceTrial,
        executedTrialIndex: i + 1,
        catchSettings: args.catchSettings,
        rng,
        baseOrder,
        includedSlotsOneBased: selectedSlotsOneBased,
        excludedSlotsOneBased,
      });
    }

    return buildRun2CatchPlan({
      sourceIndex,
      sourceTrial,
      executedTrialIndex: i + 1,
      catchSettings: args.catchSettings,
      baseOrder,
      includedSlotsOneBased: selectedSlotsOneBased,
      excludedSlotsOneBased,
    });
  });
}

function getBaseRunOrder(dataset: SharedInputDataset, runIndex: 1 | 2): number[] {
  if (runIndex === 1) {
    return dataset.schedule.runOrdersBase.run1;
  }
  return dataset.schedule.runOrdersBase.run2;
}

interface Run1PlanArgs {
  dataset: SharedInputDataset;
  sourceIndex: number;
  sourceTrial: ReturnType<typeof sourceTrialByIndex>;
  executedTrialIndex: number;
  catchSettings: CatchSettings;
  rng: () => number;
  baseOrder: number[];
  includedSlotsOneBased: number[];
  excludedSlotsOneBased: number[];
}

function buildRun1CatchPlan(args: Run1PlanArgs): PracticeTrialPlan {
  const fps = args.dataset.fps;
  const minDisappear = Math.max(
    1,
    Math.round(args.catchSettings.catchType1DisappearRangeSec[0] * fps),
  );
  const maxDisappear = Math.min(
    args.dataset.framesPerTrial - 1,
    Math.round(args.catchSettings.catchType1DisappearRangeSec[1] * fps),
  );
  const invisibleFrames = Math.max(
    1,
    Math.round(args.catchSettings.catchType1InvisibleDurationSec * fps),
  );

  let branchChanged: 0 | 1 = args.rng() < args.catchSettings.catchType1ChangedPathProbability ? 1 : 0;
  let altSourceIndex: number | null = null;
  let altPathId: string | null = null;

  if (branchChanged === 1) {
    const seqMatch = findMatchingDeviantForSequence(args.dataset, args.sourceTrial.sequenceId);
    altSourceIndex = seqMatch;

    if (!altSourceIndex || altSourceIndex === args.sourceIndex) {
      altSourceIndex = fallbackAlternateSourceIndex(
        args.dataset,
        args.sourceIndex,
        args.executedTrialIndex + args.dataset.seed,
      );
    }

    if (!altSourceIndex || altSourceIndex === args.sourceIndex) {
      branchChanged = 0;
      altSourceIndex = null;
    } else {
      altPathId = sourceTrialByIndex(args.dataset, altSourceIndex).pathId;
    }
  }

  const expectedCode =
    branchChanged === 1
      ? args.catchSettings.catchResponseYesCode
      : args.catchSettings.catchResponseNoCode;

  const devianceTarget =
    branchChanged === 1 && altSourceIndex
      ? sourceTrialByIndex(args.dataset, altSourceIndex).devianceFrame
      : null;

  const hiddenWindow = pickHiddenWindow({
    minDisappear,
    maxDisappear,
    invisibleFrames,
    framesPerTrial: args.dataset.framesPerTrial,
    devianceTargetFrame: devianceTarget,
    rng: args.rng,
  });

  return {
    runIndex: 1,
    executedTrialIndex: args.executedTrialIndex,
    sourceIndex: args.sourceIndex,
    sourceTrialId: args.sourceTrial.sourceTrialId,
    sequenceId: args.sourceTrial.sequenceId,
    sourceConditionLabel: args.sourceTrial.conditionLabel,
    sourcePathId: args.sourceTrial.pathId,
    catchTypeCode: 1,
    catchTypeLabel: 'type1_disappear_reappear',
    catchExpectedResponseCode: expectedCode,
    catchBranchChangedPath: branchChanged,
    catchDisappearFrame: hiddenWindow.disappearFrame,
    catchReappearFrame: hiddenWindow.reappearFrame,
    catchAltSourceIndex: altSourceIndex,
    catchAltPathId: altPathId,
    baseRunSourceOrder: args.baseOrder,
    includedBaseSlots: args.includedSlotsOneBased,
    excludedBaseSlots: args.excludedSlotsOneBased,
  };
}

interface Run2PlanArgs {
  sourceIndex: number;
  sourceTrial: ReturnType<typeof sourceTrialByIndex>;
  executedTrialIndex: number;
  catchSettings: CatchSettings;
  baseOrder: number[];
  includedSlotsOneBased: number[];
  excludedSlotsOneBased: number[];
}

function buildRun2CatchPlan(args: Run2PlanArgs): PracticeTrialPlan {
  const expectedCode =
    args.sourceTrial.conditionLabel === 'occluded_deviant'
      ? args.catchSettings.catchResponseYesCode
      : args.catchSettings.catchResponseNoCode;

  return {
    runIndex: 2,
    executedTrialIndex: args.executedTrialIndex,
    sourceIndex: args.sourceIndex,
    sourceTrialId: args.sourceTrial.sourceTrialId,
    sequenceId: args.sourceTrial.sequenceId,
    sourceConditionLabel: args.sourceTrial.conditionLabel,
    sourcePathId: args.sourceTrial.pathId,
    catchTypeCode: 2,
    catchTypeLabel: 'type2_occlusion_question',
    catchExpectedResponseCode: expectedCode,
    catchBranchChangedPath: null,
    catchDisappearFrame: null,
    catchReappearFrame: null,
    catchAltSourceIndex: null,
    catchAltPathId: null,
    baseRunSourceOrder: args.baseOrder,
    includedBaseSlots: args.includedSlotsOneBased,
    excludedBaseSlots: args.excludedSlotsOneBased,
  };
}

interface HiddenWindowArgs {
  minDisappear: number;
  maxDisappear: number;
  invisibleFrames: number;
  framesPerTrial: number;
  devianceTargetFrame: number | null;
  rng: () => number;
}

function pickHiddenWindow(args: HiddenWindowArgs): {
  disappearFrame: number;
  reappearFrame: number;
} {
  let disappear = sampleInt(args.rng, args.minDisappear, args.maxDisappear);

  // For changed-path catches, enforce deviance while hidden when possible.
  if (args.devianceTargetFrame !== null) {
    const target = clampFrame(args.devianceTargetFrame, args.framesPerTrial);

    const constrainedMin = Math.max(args.minDisappear, target - args.invisibleFrames + 1);
    const constrainedMax = Math.min(args.maxDisappear, target);

    if (constrainedMin <= constrainedMax) {
      disappear = sampleInt(args.rng, constrainedMin, constrainedMax);
    } else {
      const relaxedMin = Math.max(1, target - args.invisibleFrames + 1);
      const relaxedMax = Math.min(args.framesPerTrial - 1, target);
      if (relaxedMin <= relaxedMax) {
        disappear = sampleInt(args.rng, relaxedMin, relaxedMax);
      } else {
        disappear = Math.max(1, Math.min(args.framesPerTrial - 1, target));
      }
    }
  }

  let reappear = Math.min(args.framesPerTrial, disappear + args.invisibleFrames);
  if (reappear <= disappear) {
    reappear = Math.min(args.framesPerTrial, disappear + 1);
  }

  if (
    args.devianceTargetFrame !== null &&
    !(disappear <= args.devianceTargetFrame && args.devianceTargetFrame < reappear)
  ) {
    reappear = Math.min(args.framesPerTrial, Math.max(reappear, args.devianceTargetFrame + 1));
  }

  return {
    disappearFrame: disappear,
    reappearFrame: reappear,
  };
}

function clampFrame(frame: number, framesPerTrial: number): number {
  return Math.max(1, Math.min(framesPerTrial, Math.round(frame)));
}
