/**
 * File: src/lib/inputGeneration.ts
 *
 * Purpose:
 *   Deterministic browser-side generation and caching of shared practice input
 *   datasets, mirroring the PTB practice intent:
 *   - one shared input for all participants,
 *   - refresh-aware fps variants,
 *   - run base orders aligned to v21 schedule model,
 *   - frame scaling where 60 Hz has half samples of 120 Hz.
 *
 * Usage example:
 *   const { dataset, wasGenerated } = getOrCreateSharedInputForFps({
 *     fps: 60,
 *     sharedInputSubjectId: 91,
 *     sharedRandomSeed: 9101,
 *   });
 */

import {
  BASE_FIXED_DEVIANCE_FRAME,
  BASE_FIXED_OCCLUSION_END_FRAME,
  BASE_GENERATION_FPS,
  DATASET_VERSION,
  TRIAL_DURATION_SEC,
  TRIALS_PER_CONDITION,
} from '../config/practiceConfig';
import type { ConditionLabel, Point2D, SharedInputDataset, SourceTrial } from '../types';
import { fnv1aHash } from './hash';
import { createSeededRng, sampleInt, shuffleInPlace } from './seededRandom';

interface InputSelectionArgs {
  fps: number;
  sharedInputSubjectId: number;
  sharedRandomSeed: number;
}

interface InputSelectionResult {
  dataset: SharedInputDataset;
  wasGenerated: boolean;
  storageKey: string;
}

const STORAGE_PREFIX = 'dadPracticeInput';

/**
 * Resolve and cache the shared deterministic dataset for one target fps.
 */
export function getOrCreateSharedInputForFps(args: InputSelectionArgs): InputSelectionResult {
  const fps = Math.max(30, Math.min(240, Math.round(args.fps)));
  const storageKey = `${STORAGE_PREFIX}::${DATASET_VERSION}::${fps}Hz`;

  const existing = tryReadDataset(storageKey);
  if (existing && existing.datasetVersion === DATASET_VERSION && existing.fps === fps) {
    return {
      dataset: existing,
      wasGenerated: false,
      storageKey,
    };
  }

  const generated = generateSharedDataset({
    fps,
    sharedInputSubjectId: args.sharedInputSubjectId,
    sharedRandomSeed: args.sharedRandomSeed,
  });

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(generated));
  } catch {
    // Ignore cache write failures (private mode/storage limits) and proceed.
  }

  return {
    dataset: generated,
    wasGenerated: true,
    storageKey,
  };
}

/**
 * Build deterministic source trajectories and run base schedule for one fps.
 */
export function generateSharedDataset(args: InputSelectionArgs): SharedInputDataset {
  const fps = Math.max(30, Math.min(240, Math.round(args.fps)));
  const framesPerTrial = Math.max(2, Math.round(TRIAL_DURATION_SEC * fps));

  // Section: derive fixed timeline frames by scaling PTB 120 Hz defaults.
  const fixedDevianceFrame = clampFrame(
    Math.round(BASE_FIXED_DEVIANCE_FRAME * (fps / BASE_GENERATION_FPS)),
    framesPerTrial,
  );
  const fixedOcclusionEndFrame = clampFrame(
    Math.round(BASE_FIXED_OCCLUSION_END_FRAME * (fps / BASE_GENERATION_FPS)),
    framesPerTrial,
  );
  const occlusionStartFrame = clampFrame(
    fixedDevianceFrame - Math.round(0.12 * fps),
    framesPerTrial,
  );
  const occlusionEndCompleteFrame = clampFrame(
    fixedOcclusionEndFrame + Math.round(0.22 * fps),
    framesPerTrial,
  );

  // Section: deterministic base trajectory generation (shared across participants).
  const trajectoryRng = createSeededRng(args.sharedInputSubjectId);
  const sourceTrials: SourceTrial[] = [];

  for (let sequenceId = 1; sequenceId <= TRIALS_PER_CONDITION; sequenceId += 1) {
    const speedPerFrame = 3.73 / fps;

    // Keep headings mostly rightward to match practice motion readability.
    const baseHeadingRad = toRad(sampleRange(trajectoryRng, -20, 20));
    const curvatureDeg = sampleSignedInWindows(trajectoryRng, [
      [-0.8, -0.3755],
      [0.3755, 0.8],
    ]);
    const curvatureRad = toRad(curvatureDeg);

    const devTurnDeg = sampleSignedInWindows(trajectoryRng, [
      [-81, -10],
      [10, 81],
    ]);
    const devTurnRad = toRad(devTurnDeg);

    const startX = sampleRange(trajectoryRng, -4.5, -2.0);
    const startY = sampleRange(trajectoryRng, -2.5, 2.5);

    const nondeviant = generateTrajectory({
      framesPerTrial,
      startX,
      startY,
      baseHeadingRad,
      curvatureRad,
      speedPerFrame,
      devianceFrame: fixedDevianceFrame,
      devTurnRad: 0,
    });

    const deviant = generateTrajectory({
      framesPerTrial,
      startX,
      startY,
      baseHeadingRad,
      curvatureRad,
      speedPerFrame,
      devianceFrame: fixedDevianceFrame,
      devTurnRad,
    });

    const alwaysVisible = makeSourceTrial({
      sourceIndex: sequenceId,
      sequenceId,
      conditionCode: -1,
      conditionLabel: 'always_visible',
      xy: nondeviant,
      devianceFrame: fixedDevianceFrame,
      occlusionStartFrame,
      occlusionCompleteFrame: fixedDevianceFrame,
      occlusionEndFrame: fixedOcclusionEndFrame,
      occlusionEndCompleteFrame,
    });

    const occludedNondeviant = makeSourceTrial({
      sourceIndex: TRIALS_PER_CONDITION + sequenceId,
      sequenceId,
      conditionCode: 0,
      conditionLabel: 'occluded_nondeviant',
      xy: nondeviant,
      devianceFrame: fixedDevianceFrame,
      occlusionStartFrame,
      occlusionCompleteFrame: fixedDevianceFrame,
      occlusionEndFrame: fixedOcclusionEndFrame,
      occlusionEndCompleteFrame,
    });

    const occludedDeviant = makeSourceTrial({
      sourceIndex: 2 * TRIALS_PER_CONDITION + sequenceId,
      sequenceId,
      conditionCode: 45,
      conditionLabel: 'occluded_deviant',
      xy: deviant,
      devianceFrame: fixedDevianceFrame,
      occlusionStartFrame,
      occlusionCompleteFrame: fixedDevianceFrame,
      occlusionEndFrame: fixedOcclusionEndFrame,
      occlusionEndCompleteFrame,
    });

    sourceTrials.push(alwaysVisible, occludedNondeviant, occludedDeviant);
  }

  // Section: deterministic v21-style base run schedule (before practice forcing).
  const scheduleRng = createSeededRng(args.sharedRandomSeed);
  const always = sourceTrials
    .filter((t) => t.conditionLabel === 'always_visible')
    .map((t) => t.sourceIndex);
  const nondev = sourceTrials
    .filter((t) => t.conditionLabel === 'occluded_nondeviant')
    .map((t) => t.sourceIndex);
  const dev = sourceTrials
    .filter((t) => t.conditionLabel === 'occluded_deviant')
    .map((t) => t.sourceIndex);

  shuffleInPlace(always, scheduleRng);
  shuffleInPlace(nondev, scheduleRng);
  shuffleInPlace(dev, scheduleRng);

  const half = Math.floor(TRIALS_PER_CONDITION / 2);
  const run2Pool = [...nondev.slice(0, half), ...dev.slice(0, half)];
  const run3Pool = [...nondev.slice(half), ...dev.slice(half)];
  shuffleInPlace(run2Pool, scheduleRng);
  shuffleInPlace(run3Pool, scheduleRng);

  const datasetCore = {
    datasetVersion: DATASET_VERSION,
    seed: args.sharedRandomSeed,
    fps,
    framesPerTrial,
    trialDurationSec: TRIAL_DURATION_SEC,
    fixedDevianceFrame,
    fixedOcclusionEndFrame,
    trialsPerCondition: TRIALS_PER_CONDITION,
    sourceTrials,
    run1: always,
    run2: run2Pool,
    run3: run3Pool,
  };

  const datasetHash = fnv1aHash(JSON.stringify(datasetCore));
  const datasetId = `MovDot_Sub${String(args.sharedInputSubjectId).padStart(2, '0')}_${DATASET_VERSION}_${fps}Hz_${datasetHash}`;

  return {
    datasetVersion: DATASET_VERSION,
    datasetId,
    datasetHash,
    seed: args.sharedRandomSeed,
    fps,
    framesPerTrial,
    trialDurationSec: TRIAL_DURATION_SEC,
    fixedDevianceFrame,
    fixedOcclusionEndFrame,
    trialsPerCondition: TRIALS_PER_CONDITION,
    generatedAtIso: new Date().toISOString(),
    sourceTrials,
    schedule: {
      runsPerBlock: 3,
      runOrdersBase: {
        run1: always,
        run2: run2Pool,
        run3: run3Pool,
      },
    },
  };
}

interface MakeSourceTrialArgs {
  sourceIndex: number;
  sequenceId: number;
  conditionCode: number;
  conditionLabel: ConditionLabel;
  xy: Point2D[];
  devianceFrame: number;
  occlusionStartFrame: number;
  occlusionCompleteFrame: number;
  occlusionEndFrame: number;
  occlusionEndCompleteFrame: number;
}

function makeSourceTrial(args: MakeSourceTrialArgs): SourceTrial {
  const pathFingerprint = `${args.conditionLabel}|${args.sequenceId}|${args.xy
    .slice(0, 4)
    .map((p) => `${p.x.toFixed(3)}:${p.y.toFixed(3)}`)
    .join('|')}|${args.xy[args.xy.length - 1].x.toFixed(3)}:${args.xy[
    args.xy.length - 1
  ].y.toFixed(3)}`;

  return {
    sourceIndex: args.sourceIndex,
    sourceTrialId: `trial_${String(args.sourceIndex).padStart(3, '0')}`,
    sequenceId: args.sequenceId,
    conditionCode: args.conditionCode,
    conditionLabel: args.conditionLabel,
    devianceFrame: args.devianceFrame,
    occlusionStartFrame: args.occlusionStartFrame,
    occlusionCompleteFrame: args.occlusionCompleteFrame,
    occlusionEndFrame: args.occlusionEndFrame,
    occlusionEndCompleteFrame: args.occlusionEndCompleteFrame,
    pathId: `path_${fnv1aHash(pathFingerprint)}`,
    xy: args.xy,
  };
}

interface TrajectoryArgs {
  framesPerTrial: number;
  startX: number;
  startY: number;
  baseHeadingRad: number;
  curvatureRad: number;
  speedPerFrame: number;
  devianceFrame: number;
  devTurnRad: number;
}

function generateTrajectory(args: TrajectoryArgs): Point2D[] {
  const points: Point2D[] = [];
  let x = args.startX;
  let y = args.startY;
  let heading = args.baseHeadingRad;

  for (let frame = 1; frame <= args.framesPerTrial; frame += 1) {
    points.push({ x, y });

    if (frame >= args.framesPerTrial) {
      continue;
    }

    // Section: evolve heading and apply deviant turn from deviance onward.
    heading += args.curvatureRad;
    if (frame === args.devianceFrame) {
      heading += args.devTurnRad;
    }

    x += args.speedPerFrame * Math.cos(heading);
    y += args.speedPerFrame * Math.sin(heading);

    // Keep trajectories in a compact arena so canvas scaling remains stable.
    if (x < -5 || x > 5) {
      heading = Math.PI - heading;
      x = clamp(x, -5, 5);
    }
    if (y < -3.2 || y > 3.2) {
      heading = -heading;
      y = clamp(y, -3.2, 3.2);
    }
  }

  return points;
}

function sampleRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

function sampleSignedInWindows(
  rng: () => number,
  windows: Array<[number, number]>,
): number {
  const ranges = windows.map(([min, max]) => ({ min, max, len: Math.max(0, max - min) }));
  const total = ranges.reduce((acc, r) => acc + r.len, 0);
  if (total <= 0) {
    return 0;
  }
  let target = rng() * total;
  for (const range of ranges) {
    if (target <= range.len) {
      return range.min + target;
    }
    target -= range.len;
  }
  const last = ranges[ranges.length - 1];
  return last.max;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampFrame(frame: number, framesPerTrial: number): number {
  return Math.max(1, Math.min(framesPerTrial, Math.round(frame)));
}

function tryReadDataset(storageKey: string): SharedInputDataset | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as SharedInputDataset;
  } catch {
    return null;
  }
}

/**
 * Lookup helper used by runtime and verification tooling.
 */
export function sourceTrialByIndex(dataset: SharedInputDataset, sourceIndex: number): SourceTrial {
  const found = dataset.sourceTrials.find((trial) => trial.sourceIndex === sourceIndex);
  if (!found) {
    throw new Error(`Source trial ${sourceIndex} not found in dataset ${dataset.datasetId}`);
  }
  return found;
}

/**
 * Convenience check for 60Hz-vs-120Hz frame scaling expectations.
 */
export function frameCountRatio(fpsA: number, fpsB: number): number {
  const a = Math.round(TRIAL_DURATION_SEC * fpsA);
  const b = Math.round(TRIAL_DURATION_SEC * fpsB);
  return a / b;
}

/**
 * Deterministically derive per-run seed offsets for repeatable practice.
 */
export function deriveRunSeed(baseSeed: number, runIndex: 1 | 2): number {
  return baseSeed * 100 + runIndex;
}

/**
 * Deterministically derive per-session seed offsets for repeat attempts.
 */
export function deriveSessionSeed(baseSeed: number, attemptIndex: number): number {
  return baseSeed * 1000 + attemptIndex;
}

/**
 * Helper for run-level deterministic slot insertion choices.
 */
export function chooseRandomSlotIndexes(seed: number, n: number, k: number): number[] {
  const rng = createSeededRng(seed);
  const slots = Array.from({ length: n }, (_, i) => i);
  shuffleInPlace(slots, rng);
  return slots.slice(0, Math.max(0, Math.min(k, n))).sort((a, b) => a - b);
}

/**
 * Helper to sample one source index from a condition and sequence.
 */
export function findMatchingDeviantForSequence(
  dataset: SharedInputDataset,
  sequenceId: number,
): number | null {
  const match = dataset.sourceTrials.find(
    (trial) =>
      trial.sequenceId === sequenceId &&
      trial.conditionLabel === 'occluded_deviant',
  );
  return match ? match.sourceIndex : null;
}

/**
 * Deterministic fallback trial picker when same-sequence deviant is missing.
 */
export function fallbackAlternateSourceIndex(
  dataset: SharedInputDataset,
  sourceIndex: number,
  rngSeed: number,
): number | null {
  const rng = createSeededRng(rngSeed);
  const candidates = dataset.sourceTrials
    .map((trial) => trial.sourceIndex)
    .filter((idx) => idx !== sourceIndex);
  if (candidates.length === 0) {
    return null;
  }
  const picked = candidates[sampleInt(rng, 0, candidates.length - 1)];
  return picked;
}
