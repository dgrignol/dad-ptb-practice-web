/**
 * File: src/lib/keymap.ts
 *
 * Purpose:
 *   Robust browser keyboard mapping using KeyboardEvent.code to avoid layout-
 *   dependent key-name fragility (PTB-style issue mirrored in web context).
 *
 * Usage example:
 *   const response = classifyCatchResponseKey(event.code);
 */

import { RESPONSE_KEYS } from '../config/practiceConfig';

const YES_SET = new Set<string>(RESPONSE_KEYS.yesCodes);
const NO_SET = new Set<string>(RESPONSE_KEYS.noCodes);
const CONTINUE_SET = new Set<string>(RESPONSE_KEYS.continueCodes);
const REPEAT_SET = new Set<string>(RESPONSE_KEYS.repeatCodes);

export function classifyCatchResponseKey(code: string): 0 | 1 | 2 {
  if (YES_SET.has(code)) {
    return 1;
  }
  if (NO_SET.has(code)) {
    return 2;
  }
  return 0;
}

export function isContinueKey(code: string): boolean {
  return CONTINUE_SET.has(code);
}

export function isRepeatKey(code: string): boolean {
  return REPEAT_SET.has(code);
}
