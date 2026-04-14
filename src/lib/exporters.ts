/**
 * File: src/lib/exporters.ts
 *
 * Purpose:
 *   Build and download session export artifacts:
 *   - one behavioral output file (RT + accuracy),
 *   - one metadata log in JSON,
 *   - one metadata log in CSV,
 *   - one trajectory export in JSON/CSV with per-frame x/y and source path ids.
 *
 * Usage example:
 *   const artifacts = buildExportArtifacts(session);
 *   downloadTextFile('practice_session_001.json', artifacts.behaviorJson);
 */

import type {
  ExportArtifacts,
  PracticeSessionResult,
  SharedInputDataset,
  TrialRuntimeResult,
} from '../types';

/**
 * Build output payloads required by practice and downstream analysis.
 */
export function buildExportArtifacts(
  session: PracticeSessionResult,
  dataset: SharedInputDataset | null,
): ExportArtifacts {
  const behaviorPayload = {
    sessionId: session.sessionId,
    participantNumber: session.participantNumber,
    startedAtIso: session.startedAtIso,
    endedAtIso: session.endedAtIso,
    runPlannedVsCompleted: session.runPlannedVsCompleted,
    trials: session.trials.map((trial) => ({
      runIndex: trial.runIndex,
      executedTrialIndex: trial.executedTrialIndex,
      catchTypeCode: trial.catchTypeCode,
      responseCode: trial.catchResponseCode,
      responseLabel: trial.catchResponseLabel,
      responseCorrect: trial.catchResponseCorrect,
      responseRtMs: trial.catchResponseRtMs,
      timedOut: trial.catchTimedOut,
    })),
    summary: session.summary,
  };

  const metadataPayload = {
    ...session,
  };

  const trajectoryRows = buildTrajectoryRows(session, dataset);

  return {
    behaviorJson: JSON.stringify(behaviorPayload, null, 2),
    metadataJson: JSON.stringify(metadataPayload, null, 2),
    metadataCsv: buildMetadataCsv(session),
    trajectoryJson: JSON.stringify(
      {
        sessionId: session.sessionId,
        participantNumber: session.participantNumber,
        inputDatasetId: session.selectedInputDatasetId,
        trials: trajectoryRows,
      },
      null,
      2,
    ),
    trajectoryCsv: buildTrajectoryCsv(trajectoryRows),
  };
}

/**
 * Trigger text download in browser.
 */
export function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function buildMetadataCsv(session: PracticeSessionResult): string {
  const header = [
    'session_id',
    'participant_number',
    'timestamp_start_iso',
    'timestamp_end_iso',
    'browser_user_agent',
    'detected_refresh_hz',
    'target_input_fps',
    'input_dataset_id',
    'input_dataset_version',
    'input_dataset_hash',
    'run_index',
    'executed_trial_index',
    'source_trial_id',
    'source_index',
    'sequence_id',
    'source_condition_label',
    'source_path_id',
    'catch_type_code',
    'catch_type_label',
    'catch_expected_response_code',
    'catch_branch_changed_path',
    'catch_disappear_frame',
    'catch_reappear_frame',
    'catch_alt_source_index',
    'catch_alt_path_id',
    'included_base_slots',
    'excluded_base_slots',
    'run_planned_trials',
    'run_completed_trials_at_record',
    'response_code',
    'response_label',
    'response_correct',
    'response_rt_ms',
    'timeout_flag',
  ];

  const rows = session.trials.map((trial) => {
    const trialPlan = findPlanForTrial(session, trial);

    return [
      session.sessionId,
      String(session.participantNumber),
      session.startedAtIso,
      session.endedAtIso,
      session.browserUserAgent,
      String(session.detectedRefreshHz),
      String(session.targetInputFps),
      session.selectedInputDatasetId,
      session.selectedInputDatasetVersion,
      session.selectedInputDatasetHash,
      String(trial.runIndex),
      String(trial.executedTrialIndex),
      trial.sourceTrialId,
      String(trial.sourceIndex),
      String(trialPlan?.sequenceId ?? ''),
      trial.sourceConditionLabel,
      trial.sourcePathId,
      String(trial.catchTypeCode),
      trial.catchTypeLabel,
      String(trial.catchExpectedResponseCode),
      toCsvScalar(trial.catchBranchChangedPath),
      toCsvScalar(trial.catchDisappearFrame),
      toCsvScalar(trial.catchReappearFrame),
      toCsvScalar(trial.catchAltSourceIndex),
      toCsvScalar(trial.catchAltPathId),
      toCsvScalar(trialPlan?.includedBaseSlots.join('|') ?? ''),
      toCsvScalar(trialPlan?.excludedBaseSlots.join('|') ?? ''),
      String(trial.plannedRunTrials),
      String(trial.completedRunTrialsAtRecord),
      String(trial.catchResponseCode),
      trial.catchResponseLabel,
      toCsvScalar(trial.catchResponseCorrect),
      toCsvScalar(trial.catchResponseRtMs),
      String(trial.catchTimedOut ? 1 : 0),
    ];
  });

  return [header.join(','), ...rows.map((row) => row.map(csvEscape).join(','))].join('\n');
}

interface TrajectoryRow {
  sessionId: string;
  participantNumber: number;
  runIndex: 1 | 2;
  executedTrialIndex: number;
  sourceTrialId: string;
  sourceIndex: number;
  sourcePathId: string;
  sequenceId: number | null;
  frameIndex: number;
  xDeg: number;
  yDeg: number;
}

function buildTrajectoryRows(
  session: PracticeSessionResult,
  dataset: SharedInputDataset | null,
): TrajectoryRow[] {
  if (!dataset) {
    return [];
  }

  const rows: TrajectoryRow[] = [];

  for (const trial of session.trials) {
    const sourceTrial = dataset.sourceTrials.find((source) => source.sourceIndex === trial.sourceIndex);
    const plan = findPlanForTrial(session, trial);
    if (!sourceTrial) {
      continue;
    }

    for (let i = 0; i < sourceTrial.xy.length; i += 1) {
      const point = sourceTrial.xy[i];
      rows.push({
        sessionId: session.sessionId,
        participantNumber: session.participantNumber,
        runIndex: trial.runIndex,
        executedTrialIndex: trial.executedTrialIndex,
        sourceTrialId: trial.sourceTrialId,
        sourceIndex: trial.sourceIndex,
        sourcePathId: trial.sourcePathId,
        sequenceId: plan?.sequenceId ?? null,
        frameIndex: i + 1,
        xDeg: point.x,
        yDeg: point.y,
      });
    }
  }

  return rows;
}

function buildTrajectoryCsv(rows: TrajectoryRow[]): string {
  const header = [
    'session_id',
    'participant_number',
    'run_index',
    'executed_trial_index',
    'source_trial_id',
    'source_index',
    'source_path_id',
    'sequence_id',
    'frame_index',
    'x_deg',
    'y_deg',
  ];

  const csvRows = rows.map((row) => [
    row.sessionId,
    String(row.participantNumber),
    String(row.runIndex),
    String(row.executedTrialIndex),
    row.sourceTrialId,
    String(row.sourceIndex),
    row.sourcePathId,
    toCsvScalar(row.sequenceId),
    String(row.frameIndex),
    String(row.xDeg),
    String(row.yDeg),
  ]);

  return [header.join(','), ...csvRows.map((row) => row.map(csvEscape).join(','))].join('\n');
}

function findPlanForTrial(
  session: PracticeSessionResult,
  trial: TrialRuntimeResult,
): PracticeSessionResult['runPlans']['run1'][number] | undefined {
  const runPlans = trial.runIndex === 1 ? session.runPlans.run1 : session.runPlans.run2;
  return runPlans.find((plan) => plan.executedTrialIndex === trial.executedTrialIndex);
}

function toCsvScalar(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value);
}

function csvEscape(value: string): string {
  if (value.includes(',') || value.includes('"') || value.includes('\n')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
