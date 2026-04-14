/**
 * File: src/config/practiceConfig.ts
 *
 * Purpose:
 *   Store default practice constants aligned to the PTB practice wrapper and
 *   v21/v28 practice settings, while keeping the web implementation isolated.
 *
 * Usage example:
 *   import { DEFAULT_PRACTICE_CONFIG } from './config/practiceConfig';
 *
 * Notes:
 *   - Run counts are intentionally tunable at runtime via UI/query parameters.
 *   - Shared input generation uses one deterministic seed for all participants.
 */

import type { PracticeConfig } from '../types';

export const DEFAULT_PRACTICE_CONFIG: PracticeConfig = {
  sharedInputSubjectId: 91,
  sharedRandomSeed: 9101,
  run1TrialCount: 8,
  run2TrialCount: 8,
  catchSettings: {
    catchType1DisappearRangeSec: [0.3, 1.0],
    catchType1InvisibleDurationSec: 0.5,
    catchType1ChangedPathProbability: 0.5,
    catchQuestionTimeoutSec: 4.0,
    catchResponseYesCode: 1,
    catchResponseNoCode: 2,
    catchQuestionText: 'Has the dot changed its course?',
  },
};

export const DATASET_VERSION = 'web_v2_ptb_v28_v21_practice_pathband';

export const TRIAL_DURATION_SEC = 2.67;
export const TRIALS_PER_CONDITION = 20;
export const BASE_GENERATION_FPS = 120;
export const BASE_FIXED_DEVIANCE_FRAME = 130;
export const BASE_FIXED_OCCLUSION_END_FRAME = 190;

export const RESPONSE_KEYS = {
  yesCodes: ['ArrowRight', 'Digit8', 'Numpad8', 'KeyY'] as const,
  noCodes: ['ArrowLeft', 'Digit1', 'Numpad1', 'KeyN'] as const,
  continueCodes: ['Digit8', 'Numpad8', 'Digit1', 'Numpad1', 'Space', 'Enter'] as const,
  repeatCodes: ['KeyR', 'Digit8', 'Numpad8'] as const,
} as const;
