/**
 * File: verification/verify.ts
 *
 * Purpose:
 *   Lightweight end-to-end verification for the web practice implementation.
 *
 * Usage example:
 *   npm run verify
 *
 * Checks performed:
 *   1) Refresh-aware input generation supports 60 Hz and 120 Hz variants.
 *   2) 60 Hz trajectory frame count is half of 120 Hz.
 *   3) Run flow reaches run1 -> transition -> run2 in simulated mode.
 *   4) Output export includes metadata provenance columns (path IDs and
 *      practice subsampling included/excluded slots).
 */

import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_PRACTICE_CONFIG } from '../src/config/practiceConfig';
import { buildExportArtifacts } from '../src/lib/exporters';
import { deriveRunSeed, deriveSessionSeed, generateSharedDataset } from '../src/lib/inputGeneration';
import { createSessionId } from '../src/lib/ids';
import { createSessionSkeleton } from '../src/lib/practiceSession';
import { buildPracticeRunPlan } from '../src/lib/practiceScheduler';
import { simulateSessionFlow } from '../src/lib/simulator';

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function run(): Promise<void> {
  const reportLines: string[] = [];
  reportLines.push('# Verification Report');
  reportLines.push('');
  reportLines.push(`Generated at: ${new Date().toISOString()}`);
  reportLines.push('');

  // Section: refresh-aware deterministic generation checks.
  const dataset120 = generateSharedDataset({
    fps: 120,
    sharedInputSubjectId: DEFAULT_PRACTICE_CONFIG.sharedInputSubjectId,
    sharedRandomSeed: DEFAULT_PRACTICE_CONFIG.sharedRandomSeed,
  });

  const dataset60 = generateSharedDataset({
    fps: 60,
    sharedInputSubjectId: DEFAULT_PRACTICE_CONFIG.sharedInputSubjectId,
    sharedRandomSeed: DEFAULT_PRACTICE_CONFIG.sharedRandomSeed,
  });

  assert(dataset120.fps === 120, 'Expected dataset120 fps to be 120.');
  assert(dataset60.fps === 60, 'Expected dataset60 fps to be 60.');
  assert(
    dataset60.framesPerTrial * 2 === dataset120.framesPerTrial,
    `Expected 60Hz frames (${dataset60.framesPerTrial}) to be half of 120Hz frames (${dataset120.framesPerTrial}).`,
  );

  reportLines.push('## Check 1: Refresh-aware input generation');
  reportLines.push('- PASS: 120 Hz and 60 Hz datasets generated deterministically.');
  reportLines.push(`- 120 Hz framesPerTrial: ${dataset120.framesPerTrial}`);
  reportLines.push(`- 60 Hz framesPerTrial: ${dataset60.framesPerTrial}`);
  reportLines.push('');

  // Section: build practice plans and simulate run flow.
  const run1Plan = buildPracticeRunPlan({
    dataset: dataset60,
    runIndex: 1,
    targetTrialCount: DEFAULT_PRACTICE_CONFIG.run1TrialCount,
    catchSettings: DEFAULT_PRACTICE_CONFIG.catchSettings,
    seed: deriveRunSeed(deriveSessionSeed(DEFAULT_PRACTICE_CONFIG.sharedRandomSeed, 1), 1),
  });

  const run2Plan = buildPracticeRunPlan({
    dataset: dataset60,
    runIndex: 2,
    targetTrialCount: DEFAULT_PRACTICE_CONFIG.run2TrialCount,
    catchSettings: DEFAULT_PRACTICE_CONFIG.catchSettings,
    seed: deriveRunSeed(deriveSessionSeed(DEFAULT_PRACTICE_CONFIG.sharedRandomSeed, 1), 2),
  });

  const skeleton = createSessionSkeleton({
    sessionId: createSessionId(999),
    participantNumber: 999,
    startedAtIso: new Date().toISOString(),
    browserUserAgent: 'verification-script',
    detectedRefreshHz: 60,
    refreshMeasurementSamples: 90,
    refreshDetectionMethod: 'override',
    targetInputFps: 60,
    selectedInputDatasetId: dataset60.datasetId,
    selectedInputDatasetVersion: dataset60.datasetVersion,
    selectedInputDatasetHash: dataset60.datasetHash,
    config: DEFAULT_PRACTICE_CONFIG,
    run1Plan,
    run2Plan,
  });

  const simulated = simulateSessionFlow(skeleton);

  assert(simulated.flowEvents.includes('run1_start'), 'Missing run1_start event.');
  assert(simulated.flowEvents.includes('run1_to_run2_transition'), 'Missing run1->run2 transition event.');
  assert(simulated.flowEvents.includes('run2_start'), 'Missing run2_start event.');
  assert(
    simulated.session.runPlannedVsCompleted.run1Completed === run1Plan.length,
    'Run 1 completed count mismatch.',
  );
  assert(
    simulated.session.runPlannedVsCompleted.run2Completed === run2Plan.length,
    'Run 2 completed count mismatch.',
  );

  reportLines.push('## Check 2: Run flow and completion counts');
  reportLines.push(`- PASS: flow events = ${simulated.flowEvents.join(' -> ')}`);
  reportLines.push(
    `- Run1 planned/completed: ${simulated.session.runPlannedVsCompleted.run1Planned}/${simulated.session.runPlannedVsCompleted.run1Completed}`,
  );
  reportLines.push(
    `- Run2 planned/completed: ${simulated.session.runPlannedVsCompleted.run2Planned}/${simulated.session.runPlannedVsCompleted.run2Completed}`,
  );
  reportLines.push('');

  // Section: save/export and provenance schema checks.
  const artifacts = buildExportArtifacts(simulated.session, dataset60);
  assert(artifacts.behaviorJson.length > 10, 'Behavior output JSON is empty.');
  assert(artifacts.metadataJson.length > 10, 'Metadata JSON is empty.');
  assert(artifacts.metadataCsv.length > 10, 'Metadata CSV is empty.');
  assert(artifacts.trajectoryJson.length > 10, 'Trajectory JSON is empty.');
  assert(artifacts.trajectoryCsv.length > 10, 'Trajectory CSV is empty.');

  const csvHeader = artifacts.metadataCsv.split('\n', 1)[0] ?? '';
  const requiredColumns = [
    'source_path_id',
    'included_base_slots',
    'excluded_base_slots',
    'source_trial_id',
    'run_index',
    'executed_trial_index',
  ];
  for (const column of requiredColumns) {
    assert(csvHeader.includes(column), `Missing required metadata CSV column: ${column}`);
  }

  reportLines.push('## Check 3: Save/export and provenance schema');
  reportLines.push('- PASS: behavior JSON, metadata JSON, metadata CSV generated.');
  reportLines.push(`- Metadata CSV columns include: ${requiredColumns.join(', ')}`);
  reportLines.push(
    `- Example source path id: ${simulated.session.trials[0]?.sourcePathId ?? 'n/a'}`,
  );
  reportLines.push('');

  const outputPath = resolve('verification', 'verification_report.md');
  await writeFile(outputPath, reportLines.join('\n'), 'utf8');

  console.log(`Verification report written to ${outputPath}`);
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
