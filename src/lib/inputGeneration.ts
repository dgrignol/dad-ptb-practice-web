/**
 * File: src/lib/inputGeneration.ts
 *
 * Purpose:
 *   Deterministic browser-side generation and caching of shared practice input
 *   datasets, with geometry and timing behavior aligned more closely to the
 *   PTB V28/v21 practice stack:
 *   - strict 10x10 deg arena occupancy (no boundary bounce),
 *   - paired nondeviant/deviant trajectory generation with shared feasible
 *     placement,
 *   - fixed-frame deviance/occlusion anchors scaled by fps,
 *   - path-band pre/post metadata for occlusion trials.
 *
 * Usage example:
 *   const { dataset } = getOrCreateSharedInputForFps({
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

interface PathbandMetadata {
  preXY: Point2D[];
  postXY: Point2D[];
  widthDeg: number;
  halfWidthDeg: number;
  preAnchorFrame: number;
  postAnchorFrame: number;
  postDeactivateFrame: number;
  terminalStyle: 'round' | 'straight';
}

interface OcclusionTiming {
  occlusionStartFrame: number;
  occlusionCompleteFrame: number;
  occlusionEndFrame: number;
  occlusionEndCompleteFrame: number;
}

interface TrajectoryPair {
  nondeviant: Point2D[];
  deviant: Point2D[];
}

const STORAGE_PREFIX = 'dadPracticeInput';

// Section: geometric constants aligned with PTB config values.
const DOT_WIDTH_DEG = 0.51442;
const DOT_RADIUS_DEG = DOT_WIDTH_DEG / 2;
const ARENA_SIZE_DEG = 10;
const ARENA_HALF_SIZE_DEG = ARENA_SIZE_DEG / 2;
const ARENA_MIN_DOT_CENTER = -ARENA_HALF_SIZE_DEG + DOT_RADIUS_DEG;
const ARENA_MAX_DOT_CENTER = ARENA_HALF_SIZE_DEG - DOT_RADIUS_DEG;

const PATH_BAND_WIDTH_MULTIPLIER = 1.1;
const PATH_BAND_MIN_MARGIN_DEG = 0.005;
const PATH_BAND_WIDTH_DEG = Math.max(
  DOT_WIDTH_DEG * PATH_BAND_WIDTH_MULTIPLIER,
  DOT_WIDTH_DEG + PATH_BAND_MIN_MARGIN_DEG,
);

const INITIAL_CURVATURE_WINDOWS: Array<[number, number]> = [
  [-0.8, -0.3755],
  [0.3755, 0.8],
];

const DEVIANT_TURN_WINDOWS_DEG: Array<[number, number]> = [
  [-81, -10],
  [10, 81],
];

const TURN_RESCUE_SCALE_GRID = [1.0, 0.85, 0.7, 0.55, 0.4, 0.25, 0.1, 0.0];
const MAX_TRAJECTORY_ATTEMPTS = 60000;

/**
 * Resolve and cache the shared deterministic dataset for one target fps.
 */
export function getOrCreateSharedInputForFps(args: InputSelectionArgs): InputSelectionResult {
  const fps = Math.max(30, Math.min(240, Math.round(args.fps)));
  const storageKey = `${STORAGE_PREFIX}::${DATASET_VERSION}::${fps}Hz`;

  const existing = tryReadDataset(storageKey);
  if (existing && isValidCachedDataset(existing, fps)) {
    return {
      dataset: existing,
      wasGenerated: false,
      storageKey,
    };
  }
  if (existing) {
    tryRemoveDataset(storageKey);
  }

  const generated = generateSharedDataset({
    fps,
    sharedInputSubjectId: args.sharedInputSubjectId,
    sharedRandomSeed: args.sharedRandomSeed,
  });

  try {
    window.localStorage.setItem(storageKey, JSON.stringify(generated));
  } catch {
    // Ignore cache write failures and keep runtime behavior functional.
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

  // Section: scale fixed V28 anchors from 120 Hz reference.
  const fixedDevianceFrame = clampFrame(
    Math.round(BASE_FIXED_DEVIANCE_FRAME * (fps / BASE_GENERATION_FPS)),
    framesPerTrial,
  );
  const fixedOcclusionEndFrame = clampFrame(
    Math.round(BASE_FIXED_OCCLUSION_END_FRAME * (fps / BASE_GENERATION_FPS)),
    framesPerTrial,
  );

  // Section: deterministic source generation using subject seed.
  const trajectoryRng = createSeededRng(args.sharedInputSubjectId);
  const sourceTrials: SourceTrial[] = [];

  for (let sequenceId = 1; sequenceId <= TRIALS_PER_CONDITION; sequenceId += 1) {
    const pair = generatePairedTrajectories({
      rng: trajectoryRng,
      fps,
      framesPerTrial,
      devianceFrame: fixedDevianceFrame,
    });

    const nondevPathband = buildPathbandMetadata({
      xyPre: pair.nondeviant,
      xyPost: pair.nondeviant,
      devianceFrame: fixedDevianceFrame,
      holdEndFrame: fixedOcclusionEndFrame,
      framesPerTrial,
    });

    const devPathband = buildPathbandMetadata({
      xyPre: pair.nondeviant,
      xyPost: pair.deviant,
      devianceFrame: fixedDevianceFrame,
      holdEndFrame: fixedOcclusionEndFrame,
      framesPerTrial,
    });

    const timingNondev = derivePathbandOcclusionTiming({
      trialXY: pair.nondeviant,
      pathband: nondevPathband,
      devianceFrame: fixedDevianceFrame,
      fps,
      fallbackOcclusionEndFrame: fixedOcclusionEndFrame,
      framesPerTrial,
    });

    const timingDev = derivePathbandOcclusionTiming({
      trialXY: pair.deviant,
      pathband: devPathband,
      devianceFrame: fixedDevianceFrame,
      fps,
      fallbackOcclusionEndFrame: fixedOcclusionEndFrame,
      framesPerTrial,
    });

    const alwaysVisible = makeSourceTrial({
      sourceIndex: sequenceId,
      sequenceId,
      conditionCode: -1,
      conditionLabel: 'always_visible',
      occlusionEnabled: false,
      xy: pair.nondeviant,
      timing: timingNondev,
      pathband: nondevPathband,
    });

    const occludedNondeviant = makeSourceTrial({
      sourceIndex: TRIALS_PER_CONDITION + sequenceId,
      sequenceId,
      conditionCode: 0,
      conditionLabel: 'occluded_nondeviant',
      occlusionEnabled: true,
      xy: pair.nondeviant,
      timing: timingNondev,
      pathband: nondevPathband,
    });

    const occludedDeviant = makeSourceTrial({
      sourceIndex: 2 * TRIALS_PER_CONDITION + sequenceId,
      sequenceId,
      conditionCode: 45,
      conditionLabel: 'occluded_deviant',
      occlusionEnabled: true,
      xy: pair.deviant,
      timing: timingDev,
      pathband: devPathband,
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

interface PairedTrajectoryArgs {
  rng: () => number;
  fps: number;
  framesPerTrial: number;
  devianceFrame: number;
}

function generatePairedTrajectories(args: PairedTrajectoryArgs): TrajectoryPair {
  const speedPerFrame = 3.73 / args.fps;

  // Match V28 geometric floor logic for curvature feasibility.
  const maxTurnRadiusDeg = (ARENA_SIZE_DEG - DOT_WIDTH_DEG) / 2;
  const minAbsCurvatureDeg = toDeg(speedPerFrame / maxTurnRadiusDeg);

  for (let attempt = 1; attempt <= MAX_TRAJECTORY_ATTEMPTS; attempt += 1) {
    const initialDirectionDeg = sampleRange(args.rng, -180, 180);
    let baselineCurvatureDeg = sampleSignedInWindows(args.rng, INITIAL_CURVATURE_WINDOWS);
    if (Math.abs(baselineCurvatureDeg) < minAbsCurvatureDeg) {
      baselineCurvatureDeg =
        baselineCurvatureDeg === 0
          ? minAbsCurvatureDeg * (args.rng() < 0.5 ? -1 : 1)
          : Math.sign(baselineCurvatureDeg) * minAbsCurvatureDeg;
    }

    const sampledTurnDeg = sampleSignedInWindows(args.rng, DEVIANT_TURN_WINDOWS_DEG);

    for (const turnScale of TURN_RESCUE_SCALE_GRID) {
      const devTurnDeg = sampledTurnDeg * turnScale;

      const relNondev = integrateRelativeTrajectory({
        framesPerTrial: args.framesPerTrial,
        speedPerFrame,
        initialDirectionDeg,
        curvatureDeg: baselineCurvatureDeg,
        devianceFrame: args.devianceFrame,
        devTurnDeg: 0,
      });

      const relDev = integrateRelativeTrajectory({
        framesPerTrial: args.framesPerTrial,
        speedPerFrame,
        initialDirectionDeg,
        curvatureDeg: baselineCurvatureDeg,
        devianceFrame: args.devianceFrame,
        devTurnDeg,
      });

      const sharedOffset = sampleFeasibleSharedOffset(relNondev, relDev, args.rng);
      if (!sharedOffset) {
        continue;
      }

      const nondeviant = translatePath(relNondev, sharedOffset.x, sharedOffset.y);
      const deviant = translatePath(relDev, sharedOffset.x, sharedOffset.y);

      if (!pathWithinBounds(nondeviant) || !pathWithinBounds(deviant)) {
        continue;
      }

      return {
        nondeviant,
        deviant,
      };
    }
  }

  throw new Error(
    `Failed to generate feasible paired trajectories inside ${ARENA_SIZE_DEG}x${ARENA_SIZE_DEG} deg arena.`,
  );
}

interface RelativeTrajectoryArgs {
  framesPerTrial: number;
  speedPerFrame: number;
  initialDirectionDeg: number;
  curvatureDeg: number;
  devianceFrame: number;
  devTurnDeg: number;
}

function integrateRelativeTrajectory(args: RelativeTrajectoryArgs): Point2D[] {
  const points: Point2D[] = [];
  let x = 0;
  let y = 0;
  let headingRad = toRad(args.initialDirectionDeg);
  const curvatureRad = toRad(args.curvatureDeg);
  const devTurnRad = toRad(args.devTurnDeg);

  for (let frame = 1; frame <= args.framesPerTrial; frame += 1) {
    points.push({ x, y });

    if (frame >= args.framesPerTrial) {
      continue;
    }

    headingRad += curvatureRad;
    if (frame === args.devianceFrame) {
      headingRad += devTurnRad;
    }

    x += args.speedPerFrame * Math.cos(headingRad);
    y += args.speedPerFrame * Math.sin(headingRad);
  }

  return points;
}

function sampleFeasibleSharedOffset(
  pathA: Point2D[],
  pathB: Point2D[],
  rng: () => number,
): Point2D | null {
  const aBounds = pathBounds(pathA);
  const bBounds = pathBounds(pathB);

  const xMin = Math.max(ARENA_MIN_DOT_CENTER - aBounds.minX, ARENA_MIN_DOT_CENTER - bBounds.minX);
  const xMax = Math.min(ARENA_MAX_DOT_CENTER - aBounds.maxX, ARENA_MAX_DOT_CENTER - bBounds.maxX);
  const yMin = Math.max(ARENA_MIN_DOT_CENTER - aBounds.minY, ARENA_MIN_DOT_CENTER - bBounds.minY);
  const yMax = Math.min(ARENA_MAX_DOT_CENTER - aBounds.maxY, ARENA_MAX_DOT_CENTER - bBounds.maxY);

  if (xMax < xMin || yMax < yMin) {
    return null;
  }

  return {
    x: sampleRange(rng, xMin, xMax),
    y: sampleRange(rng, yMin, yMax),
  };
}

function translatePath(path: Point2D[], offsetX: number, offsetY: number): Point2D[] {
  return path.map((point) => ({
    x: point.x + offsetX,
    y: point.y + offsetY,
  }));
}

function pathBounds(path: Point2D[]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const point of path) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  return { minX, maxX, minY, maxY };
}

function pathWithinBounds(path: Point2D[]): boolean {
  return path.every(
    (point) =>
      point.x >= ARENA_MIN_DOT_CENTER &&
      point.x <= ARENA_MAX_DOT_CENTER &&
      point.y >= ARENA_MIN_DOT_CENTER &&
      point.y <= ARENA_MAX_DOT_CENTER,
  );
}

interface BuildPathbandArgs {
  xyPre: Point2D[];
  xyPost: Point2D[];
  devianceFrame: number;
  holdEndFrame: number;
  framesPerTrial: number;
}

function buildPathbandMetadata(args: BuildPathbandArgs): PathbandMetadata {
  const preXY = buildPathbandPolyline(args.xyPre, args.devianceFrame, args.holdEndFrame, args.framesPerTrial);
  const postXY = buildPathbandPolyline(args.xyPost, args.devianceFrame, args.holdEndFrame, args.framesPerTrial);

  return {
    preXY,
    postXY,
    widthDeg: PATH_BAND_WIDTH_DEG,
    halfWidthDeg: PATH_BAND_WIDTH_DEG / 2,
    preAnchorFrame: clampFrame(args.devianceFrame, args.framesPerTrial),
    postAnchorFrame: clampFrame(args.devianceFrame, args.framesPerTrial),
    postDeactivateFrame: args.framesPerTrial,
    terminalStyle: 'straight',
  };
}

function buildPathbandPolyline(
  xy: Point2D[],
  startFrame: number,
  endFrame: number,
  framesPerTrial: number,
): Point2D[] {
  const startIdx = clampFrame(startFrame, framesPerTrial) - 1;
  let endIdx = clampFrame(endFrame, framesPerTrial) - 1;

  if (endIdx <= startIdx) {
    endIdx = Math.min(framesPerTrial - 1, startIdx + 1);
  }

  const slice = xy.slice(startIdx, endIdx + 1);
  if (slice.length >= 2) {
    return slice;
  }

  // Fallback for pathological short ranges.
  const i0 = Math.max(0, startIdx - 1);
  const i1 = Math.min(framesPerTrial - 1, i0 + 1);
  return [xy[i0], xy[i1]];
}

interface DeriveTimingArgs {
  trialXY: Point2D[];
  pathband: PathbandMetadata;
  devianceFrame: number;
  fps: number;
  fallbackOcclusionEndFrame: number;
  framesPerTrial: number;
}

function derivePathbandOcclusionTiming(args: DeriveTimingArgs): OcclusionTiming {
  const invis: boolean[] = [];
  const fullVisible: boolean[] = [];

  for (let frame = 1; frame <= args.framesPerTrial; frame += 1) {
    const point = args.trialXY[frame - 1];

    const preActive = frame < args.devianceFrame;
    const postActive = frame >= args.devianceFrame && frame <= args.pathband.postDeactivateFrame;

    let d = Number.POSITIVE_INFINITY;
    if (preActive) {
      d = Math.min(d, distancePointToPolyline(point, args.pathband.preXY));
    }
    if (postActive) {
      d = Math.min(d, distancePointToPolyline(point, args.pathband.postXY));
    }

    const invisible = d <= args.pathband.halfWidthDeg - DOT_RADIUS_DEG;
    const fullyVisible = d >= args.pathband.halfWidthDeg + DOT_RADIUS_DEG;
    invis.push(invisible);
    fullVisible.push(fullyVisible);
  }

  const firstPartialIdx = fullVisible.findIndex((v) => !v);
  const firstInvisibleIdx = invis.findIndex((v) => v);
  const lastInvisibleIdx = lastIndexWhere(invis, (v) => v);

  const fallbackStart = clampFrame(args.devianceFrame - Math.round(0.25 * args.fps), args.framesPerTrial);
  const fallbackComplete = clampFrame(args.devianceFrame, args.framesPerTrial);
  const fallbackEnd = clampFrame(args.fallbackOcclusionEndFrame, args.framesPerTrial);

  const occlusionStartFrame = firstPartialIdx >= 0 ? firstPartialIdx + 1 : fallbackStart;
  const occlusionCompleteFrame = firstInvisibleIdx >= 0 ? firstInvisibleIdx + 1 : fallbackComplete;
  const occlusionEndFrame =
    lastInvisibleIdx >= 0
      ? Math.max(occlusionCompleteFrame, lastInvisibleIdx + 1)
      : Math.max(occlusionCompleteFrame, fallbackEnd);

  let occlusionEndCompleteFrame = args.framesPerTrial;
  for (let i = occlusionEndFrame; i < args.framesPerTrial; i += 1) {
    if (fullVisible[i]) {
      occlusionEndCompleteFrame = i + 1;
      break;
    }
  }

  return {
    occlusionStartFrame: clampFrame(occlusionStartFrame, args.framesPerTrial),
    occlusionCompleteFrame: clampFrame(occlusionCompleteFrame, args.framesPerTrial),
    occlusionEndFrame: clampFrame(occlusionEndFrame, args.framesPerTrial),
    occlusionEndCompleteFrame: clampFrame(occlusionEndCompleteFrame, args.framesPerTrial),
  };
}

function distancePointToPolyline(point: Point2D, polyline: Point2D[]): number {
  if (polyline.length < 2) {
    return Number.POSITIVE_INFINITY;
  }

  let minDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const a = polyline[i];
    const b = polyline[i + 1];
    minDist = Math.min(minDist, distancePointToSegment(point, a, b));
  }
  return minDist;
}

function distancePointToSegment(p: Point2D, a: Point2D, b: Point2D): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;

  const ab2 = abx * abx + aby * aby;
  if (ab2 <= 1e-12) {
    return Math.hypot(apx, apy);
  }

  const t = clamp((apx * abx + apy * aby) / ab2, 0, 1);
  const cx = a.x + t * abx;
  const cy = a.y + t * aby;
  return Math.hypot(p.x - cx, p.y - cy);
}

function lastIndexWhere<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i])) {
      return i;
    }
  }
  return -1;
}

interface MakeSourceTrialArgs {
  sourceIndex: number;
  sequenceId: number;
  conditionCode: number;
  conditionLabel: ConditionLabel;
  occlusionEnabled: boolean;
  xy: Point2D[];
  timing: OcclusionTiming;
  pathband: PathbandMetadata;
}

function makeSourceTrial(args: MakeSourceTrialArgs): SourceTrial {
  const pathFingerprint = `${args.conditionLabel}|${args.sequenceId}|${args.xy
    .slice(0, 4)
    .map((p) => `${p.x.toFixed(4)}:${p.y.toFixed(4)}`)
    .join('|')}|${args.xy[args.xy.length - 1].x.toFixed(4)}:${args.xy[
    args.xy.length - 1
  ].y.toFixed(4)}|${args.pathband.widthDeg.toFixed(4)}`;

  return {
    sourceIndex: args.sourceIndex,
    sourceTrialId: `trial_${String(args.sourceIndex).padStart(3, '0')}`,
    sequenceId: args.sequenceId,
    conditionCode: args.conditionCode,
    conditionLabel: args.conditionLabel,
    occlusionEnabled: args.occlusionEnabled,
    devianceFrame: args.pathband.preAnchorFrame,
    occlusionStartFrame: args.timing.occlusionStartFrame,
    occlusionCompleteFrame: args.timing.occlusionCompleteFrame,
    occlusionEndFrame: args.timing.occlusionEndFrame,
    occlusionEndCompleteFrame: args.timing.occlusionEndCompleteFrame,
    pathbandPreXY: args.pathband.preXY,
    pathbandPostXY: args.pathband.postXY,
    pathbandWidthDeg: args.pathband.widthDeg,
    pathbandHalfWidthDeg: args.pathband.halfWidthDeg,
    pathbandPreAnchorFrame: args.pathband.preAnchorFrame,
    pathbandPostAnchorFrame: args.pathband.postAnchorFrame,
    pathbandPostDeactivateFrame: args.pathband.postDeactivateFrame,
    pathbandTerminalStyle: args.pathband.terminalStyle,
    pathId: `path_${fnv1aHash(pathFingerprint)}`,
    xy: args.xy,
  };
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

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
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

function tryRemoveDataset(storageKey: string): void {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // Ignore cache cleanup failures.
  }
}

function isValidCachedDataset(dataset: SharedInputDataset, expectedFps: number): boolean {
  if (dataset.datasetVersion !== DATASET_VERSION) {
    return false;
  }
  if (!Number.isFinite(dataset.fps) || Math.round(dataset.fps) !== Math.round(expectedFps)) {
    return false;
  }
  if (!Number.isFinite(dataset.framesPerTrial) || dataset.framesPerTrial < 2) {
    return false;
  }
  if (!Array.isArray(dataset.sourceTrials) || dataset.sourceTrials.length === 0) {
    return false;
  }

  const frames = Math.round(dataset.framesPerTrial);

  for (const trial of dataset.sourceTrials) {
    if (!Array.isArray(trial.xy) || trial.xy.length !== frames) {
      return false;
    }
    if (!trial.xy.every(isFinitePoint)) {
      return false;
    }
    if (!Array.isArray(trial.pathbandPreXY) || trial.pathbandPreXY.length < 2) {
      return false;
    }
    if (!Array.isArray(trial.pathbandPostXY) || trial.pathbandPostXY.length < 2) {
      return false;
    }
    if (!trial.pathbandPreXY.every(isFinitePoint) || !trial.pathbandPostXY.every(isFinitePoint)) {
      return false;
    }
    if (typeof trial.pathId !== 'string' || trial.pathId.length === 0) {
      return false;
    }
  }

  return true;
}

function isFinitePoint(point: unknown): point is Point2D {
  if (!point || typeof point !== 'object') {
    return false;
  }
  const maybePoint = point as { x?: unknown; y?: unknown };
  return Number.isFinite(maybePoint.x) && Number.isFinite(maybePoint.y);
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
    (trial) => trial.sequenceId === sequenceId && trial.conditionLabel === 'occluded_deviant',
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
