/**
 * File: src/App.tsx
 *
 * Purpose:
 *   Browser implementation of PTB practice (run1/run2 catch-only) with
 *   deterministic shared input generation, refresh-aware fps selection,
 *   and full provenance logging for later analysis.
 *
 * Usage example:
 *   Development:
 *     npm run dev
 *
 *   Test mode (bypass manual participant input):
 *     http://localhost:5173/?testMode=1&participant=999&run1=4&run2=4&autoStart=1
 *
 * Data flow summary:
 *   setup -> refresh detect -> input select/generate -> run1 trials ->
 *   run1->run2 transition -> run2 trials -> summary + export files.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { DEFAULT_PRACTICE_CONFIG, RESPONSE_KEYS } from './config/practiceConfig';
import { summarizeSession } from './lib/analytics';
import { buildExportArtifacts, downloadTextFile } from './lib/exporters';
import {
  deriveRunSeed,
  deriveSessionSeed,
  getOrCreateSharedInputForFps,
  sourceTrialByIndex,
} from './lib/inputGeneration';
import { createSessionId } from './lib/ids';
import { classifyCatchResponseKey, isContinueKey, isRepeatKey } from './lib/keymap';
import { createSessionSkeleton, appendTrialResult, finalizeSession } from './lib/practiceSession';
import { buildPracticeRunPlan } from './lib/practiceScheduler';
import { parseQueryOverrides } from './lib/query';
import { detectRefreshHz, mapRefreshToTargetFps } from './lib/refresh';
import { simulateSessionFlow } from './lib/simulator';
import type {
  ExportArtifacts,
  PracticeSessionResult,
  PracticeTrialPlan,
  SharedInputDataset,
  TrialRuntimeResult,
} from './types';

type UiPhase =
  | 'setup'
  | 'initializing'
  | 'trial'
  | 'question'
  | 'feedback'
  | 'transition'
  | 'session_complete'
  | 'error';

type FixationFeedback = 'neutral' | 'correct' | 'incorrect';

const ARENA_X_MIN = -5;
const ARENA_X_MAX = 5;
const ARENA_Y_MIN = -5;
const ARENA_Y_MAX = 5;

const DOT_WIDTH_DEG = 0.51442;
const DOT_RADIUS_DEG = DOT_WIDTH_DEG / 2;
const FEEDBACK_DURATION_MS = 300;

function App() {
  const query = useMemo(() => parseQueryOverrides(window.location.search), []);

  // Section: setup controls and participant/session-level state.
  const [phase, setPhase] = useState<UiPhase>('setup');
  const [statusText, setStatusText] = useState<string>('Enter participant number to start practice.');
  const [attemptIndex, setAttemptIndex] = useState<number>(1);

  const [participantInput, setParticipantInput] = useState<string>(
    query.participantNumber ? String(query.participantNumber) : '',
  );
  const [run1CountInput, setRun1CountInput] = useState<string>(
    query.run1TrialCount ? String(query.run1TrialCount) : String(DEFAULT_PRACTICE_CONFIG.run1TrialCount),
  );
  const [run2CountInput, setRun2CountInput] = useState<string>(
    query.run2TrialCount ? String(query.run2TrialCount) : String(DEFAULT_PRACTICE_CONFIG.run2TrialCount),
  );

  const [detectedRefreshHz, setDetectedRefreshHz] = useState<number | null>(null);
  const [refreshSampleCount, setRefreshSampleCount] = useState<number>(0);
  const [refreshMethod, setRefreshMethod] = useState<'raf_median' | 'override' | null>(null);
  const [targetInputFps, setTargetInputFps] = useState<number | null>(null);
  const [inputDataset, setInputDataset] = useState<SharedInputDataset | null>(null);
  const [inputWasGenerated, setInputWasGenerated] = useState<boolean>(false);

  const [session, setSession] = useState<PracticeSessionResult | null>(null);
  const [exports, setExports] = useState<ExportArtifacts | null>(null);

  // Section: trial-flow pointers and live trial plan references.
  const [currentRunIndex, setCurrentRunIndex] = useState<1 | 2>(1);
  const [currentTrialIndex, setCurrentTrialIndex] = useState<number>(1);
  const [activePlan, setActivePlan] = useState<PracticeTrialPlan | null>(null);
  const [questionPromptText, setQuestionPromptText] = useState<string>('');
  const [fixationFeedback, setFixationFeedback] = useState<FixationFeedback>('neutral');

  // Section: drawing and timing refs used by animation/question logic.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const trialAnimationStartMsRef = useRef<number>(0);
  const questionStartMsRef = useRef<number>(0);
  const trialStartIsoRef = useRef<string>('');
  const trialEndIsoRef = useRef<string>('');
  const activePlanRef = useRef<PracticeTrialPlan | null>(null);

  const hasSession = session !== null;

  const currentSummaryRows = session?.summary.byRunAndCatch ?? [];

  useEffect(() => {
    activePlanRef.current = activePlan;
  }, [activePlan]);

  // Section: auto-start support for safe test mode.
  useEffect(() => {
    if (!query.autoStart) {
      return;
    }
    if (phase !== 'setup') {
      return;
    }
    const participantValue = query.participantNumber ?? 999;
    if (!participantInput) {
      setParticipantInput(String(participantValue));
    }

    const timer = window.setTimeout(() => {
      void initializePracticeSession(participantValue);
    }, 150);

    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.autoStart, phase]);

  /**
   * Initialize session-level state: refresh detect, input select/generate,
   * run-plan build, and skeleton metadata allocation.
   */
  const initializePracticeSession = useCallback(
    async (participantOverride?: number) => {
      try {
        setPhase('initializing');
        setStatusText('Detecting refresh rate and preparing shared input...');

        const participantNumber =
          participantOverride ?? Number.parseInt(participantInput.trim(), 10);
        if (!Number.isFinite(participantNumber) || participantNumber < 1) {
          throw new Error('Participant number must be a positive integer.');
        }

        const run1Count = Number.parseInt(run1CountInput.trim(), 10);
        const run2Count = Number.parseInt(run2CountInput.trim(), 10);
        if (!Number.isFinite(run1Count) || run1Count < 1) {
          throw new Error('Run 1 trial count must be >= 1.');
        }
        if (!Number.isFinite(run2Count) || run2Count < 1) {
          throw new Error('Run 2 trial count must be >= 1.');
        }

        const refresh = await detectRefreshHz(query.fpsOverride);
        const targetFps = mapRefreshToTargetFps(refresh.detectedRefreshHz);

        setDetectedRefreshHz(refresh.detectedRefreshHz);
        setRefreshSampleCount(refresh.sampleCount);
        setRefreshMethod(refresh.method);
        setTargetInputFps(targetFps);

        const selection = getOrCreateSharedInputForFps({
          fps: targetFps,
          sharedInputSubjectId: DEFAULT_PRACTICE_CONFIG.sharedInputSubjectId,
          sharedRandomSeed: DEFAULT_PRACTICE_CONFIG.sharedRandomSeed,
        });

        const dataset = selection.dataset;
        setInputDataset(dataset);
        setInputWasGenerated(selection.wasGenerated);

        const run1Max = dataset.schedule.runOrdersBase.run1.length;
        const run2Max = dataset.schedule.runOrdersBase.run2.length;
        if (run1Count > run1Max) {
          throw new Error(`Run 1 trial count ${run1Count} exceeds available ${run1Max}.`);
        }
        if (run2Count > run2Max) {
          throw new Error(`Run 2 trial count ${run2Count} exceeds available ${run2Max}.`);
        }

        const baseConfig = {
          ...DEFAULT_PRACTICE_CONFIG,
          run1TrialCount: run1Count,
          run2TrialCount: run2Count,
        };

        const sessionSeed = deriveSessionSeed(DEFAULT_PRACTICE_CONFIG.sharedRandomSeed, attemptIndex);

        const run1Plan = buildPracticeRunPlan({
          dataset,
          runIndex: 1,
          targetTrialCount: run1Count,
          catchSettings: baseConfig.catchSettings,
          seed: deriveRunSeed(sessionSeed, 1),
        });

        const run2Plan = buildPracticeRunPlan({
          dataset,
          runIndex: 2,
          targetTrialCount: run2Count,
          catchSettings: baseConfig.catchSettings,
          seed: deriveRunSeed(sessionSeed, 2),
        });

        const sessionId = createSessionId(participantNumber);
        const skeleton = createSessionSkeleton({
          sessionId,
          participantNumber,
          startedAtIso: new Date().toISOString(),
          browserUserAgent: window.navigator.userAgent,
          detectedRefreshHz: refresh.detectedRefreshHz,
          refreshMeasurementSamples: refresh.sampleCount,
          refreshDetectionMethod: refresh.method,
          targetInputFps: targetFps,
          selectedInputDatasetId: dataset.datasetId,
          selectedInputDatasetVersion: dataset.datasetVersion,
          selectedInputDatasetHash: dataset.datasetHash,
          config: baseConfig,
          run1Plan,
          run2Plan,
        });

        // In test mode we can bypass manual trial interaction for CI checks.
        if (query.testMode) {
          const simulated = simulateSessionFlow(skeleton);
          setSession(simulated.session);
          setExports(buildExportArtifacts(simulated.session));
          setCurrentRunIndex(2);
          setCurrentTrialIndex(simulated.session.runPlannedVsCompleted.run2Completed);
          setActivePlan(null);
          setPhase('session_complete');
          setStatusText(
            `Test mode complete: ${simulated.flowEvents.join(' -> ')}`,
          );
          return;
        }

        setSession(skeleton);
        setExports(null);
        setCurrentRunIndex(1);
        setCurrentTrialIndex(1);
        setFixationFeedback('neutral');
        setStatusText('Run 1 started. Keep fixation and answer catch question quickly and accurately.');

        const firstPlan = skeleton.runPlans.run1[0];
        if (!firstPlan) {
          throw new Error('Run 1 plan is empty.');
        }
        setActivePlan(firstPlan);
        setPhase('trial');
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown initialization error.';
        setPhase('error');
        setStatusText(message);
      }
    },
    [attemptIndex, participantInput, query.fpsOverride, query.testMode, run1CountInput, run2CountInput],
  );

  // Section: trial animation loop for the active trial plan.
  useEffect(() => {
    if (phase !== 'trial' || !activePlan || !inputDataset) {
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    const source = sourceTrialByIndex(inputDataset, activePlan.sourceIndex);
    const altSource =
      activePlan.catchAltSourceIndex !== null
        ? sourceTrialByIndex(inputDataset, activePlan.catchAltSourceIndex)
        : null;

    const frameDurationMs = 1000 / inputDataset.fps;
    const totalFrames = inputDataset.framesPerTrial;

    trialAnimationStartMsRef.current = performance.now();
    trialStartIsoRef.current = new Date().toISOString();

    const draw = (nowMs: number) => {
      const elapsedMs = nowMs - trialAnimationStartMsRef.current;
      const frame = Math.min(totalFrames - 1, Math.floor(elapsedMs / frameDurationMs));

      drawTrialFrame({
        context,
        canvas,
        source,
        altSource,
        plan: activePlan,
        runIndex: currentRunIndex,
        frameIndex: frame,
      });

      if (frame >= totalFrames - 1) {
        trialEndIsoRef.current = new Date().toISOString();
        setQuestionPromptText(DEFAULT_PRACTICE_CONFIG.catchSettings.catchQuestionText);
        setPhase('question');
        return;
      }

      rafRef.current = window.requestAnimationFrame(draw);
    };

    rafRef.current = window.requestAnimationFrame(draw);

    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [activePlan, currentRunIndex, inputDataset, phase]);

  // Section: question phase keyboard/timeout handling.
  useEffect(() => {
    if (phase !== 'question' || !activePlan) {
      return;
    }

    questionStartMsRef.current = performance.now();
    let resolved = false;
    let feedbackHandle: number | null = null;

    const commitResponse = (responseCode: 0 | 1 | 2, timedOut: boolean) => {
      if (resolved) {
        return;
      }
      resolved = true;

      const plan = activePlanRef.current;
      if (!plan || !session) {
        return;
      }

      const responseLabel: 'none' | 'yes' | 'no' =
        responseCode === 1 ? 'yes' : responseCode === 2 ? 'no' : 'none';
      const rtMs = responseCode > 0 ? Math.round(performance.now() - questionStartMsRef.current) : null;
      const responseCorrect =
        responseCode > 0 ? (Number(responseCode === plan.catchExpectedResponseCode) as 0 | 1) : null;

      const completedBefore =
        currentRunIndex === 1
          ? session.runPlannedVsCompleted.run1Completed
          : session.runPlannedVsCompleted.run2Completed;

      const trialResult: TrialRuntimeResult = {
        runIndex: currentRunIndex,
        executedTrialIndex: plan.executedTrialIndex,
        sourceIndex: plan.sourceIndex,
        sourceTrialId: plan.sourceTrialId,
        sourceConditionLabel: plan.sourceConditionLabel,
        sourcePathId: plan.sourcePathId,
        catchTypeCode: plan.catchTypeCode,
        catchTypeLabel: plan.catchTypeLabel,
        catchExpectedResponseCode: plan.catchExpectedResponseCode,
        catchResponseCode: responseCode,
        catchResponseLabel: responseLabel,
        catchResponseCorrect: responseCorrect,
        catchResponseRtMs: rtMs,
        catchTimedOut: timedOut,
        catchBranchChangedPath: plan.catchBranchChangedPath,
        catchDisappearFrame: plan.catchDisappearFrame,
        catchReappearFrame: plan.catchReappearFrame,
        catchAltSourceIndex: plan.catchAltSourceIndex,
        catchAltPathId: plan.catchAltPathId,
        plannedRunTrials: currentRunIndex === 1 ? session.runPlans.run1.length : session.runPlans.run2.length,
        completedRunTrialsAtRecord: completedBefore + 1,
        startedAtIso: trialStartIsoRef.current,
        endedAtIso: trialEndIsoRef.current,
      };

      const updated = appendTrialResult(session, trialResult);
      setSession(updated);
      setStatusText(
        timedOut
          ? 'Too slow. Response timed out.'
          : responseCorrect === 1
            ? `Correct (${responseLabel.toUpperCase()}).`
            : `Incorrect (${responseLabel.toUpperCase()}).`,
      );
      const feedback: FixationFeedback = timedOut || responseCorrect !== 1 ? 'incorrect' : 'correct';
      setFixationFeedback(feedback);
      setPhase('feedback');

      const runPlans = currentRunIndex === 1 ? updated.runPlans.run1 : updated.runPlans.run2;
      const nextTrial = plan.executedTrialIndex + 1;

      if (nextTrial <= runPlans.length) {
        feedbackHandle = window.setTimeout(() => {
          setFixationFeedback('neutral');
          setCurrentTrialIndex(nextTrial);
          setActivePlan(runPlans[nextTrial - 1]);
          setPhase('trial');
        }, FEEDBACK_DURATION_MS);
        return;
      }

      if (currentRunIndex === 1) {
        feedbackHandle = window.setTimeout(() => {
          setFixationFeedback('neutral');
          setPhase('transition');
          setCurrentRunIndex(2);
          setCurrentTrialIndex(1);
          setActivePlan(null);
          setStatusText(
            'End of Run 1. Run 2 will start now. Instruction reminder: keep fixation and answer catch question quickly and accurately.',
          );
        }, FEEDBACK_DURATION_MS);
        return;
      }

      feedbackHandle = window.setTimeout(() => {
        setFixationFeedback('neutral');
        const finalized = finalizeSession(updated, new Date().toISOString());
        finalized.summary = summarizeSession(finalized.trials);
        setSession(finalized);
        setExports(buildExportArtifacts(finalized));
        setPhase('session_complete');
        setActivePlan(null);
        setStatusText('Practice complete. Review summary and export files.');
      }, FEEDBACK_DURATION_MS);
    };

    const keyHandler = (event: KeyboardEvent) => {
      const responseCode = classifyCatchResponseKey(event.code);
      if (responseCode === 0) {
        return;
      }
      event.preventDefault();
      commitResponse(responseCode, false);
    };

    const timeoutMs = DEFAULT_PRACTICE_CONFIG.catchSettings.catchQuestionTimeoutSec * 1000;
    const timeoutHandle = window.setTimeout(() => {
      commitResponse(0, true);
    }, timeoutMs);

    window.addEventListener('keydown', keyHandler);

    if (query.testMode) {
      const autoHandle = window.setTimeout(() => {
        // In test mode, respond with expected answer for deterministic checks.
        const plan = activePlanRef.current;
        if (plan) {
          commitResponse(plan.catchExpectedResponseCode, false);
        }
      }, 200);

      return () => {
        window.clearTimeout(autoHandle);
        window.clearTimeout(timeoutHandle);
        if (feedbackHandle !== null) {
          window.clearTimeout(feedbackHandle);
        }
        window.removeEventListener('keydown', keyHandler);
      };
    }

    return () => {
      window.clearTimeout(timeoutHandle);
      if (feedbackHandle !== null) {
        window.clearTimeout(feedbackHandle);
      }
      window.removeEventListener('keydown', keyHandler);
    };
  }, [activePlan, currentRunIndex, phase, query.testMode, session]);

  // Section: feedback phase draws one static end-of-trial frame with colored fixation.
  useEffect(() => {
    if (phase !== 'feedback' || !activePlan || !inputDataset) {
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    const source = sourceTrialByIndex(inputDataset, activePlan.sourceIndex);
    const altSource =
      activePlan.catchAltSourceIndex !== null
        ? sourceTrialByIndex(inputDataset, activePlan.catchAltSourceIndex)
        : null;

    drawTrialFrame({
      context,
      canvas,
      source,
      altSource,
      plan: activePlan,
      runIndex: currentRunIndex,
      frameIndex: Math.max(0, inputDataset.framesPerTrial - 1),
      fixationFeedback,
    });
  }, [activePlan, currentRunIndex, fixationFeedback, inputDataset, phase]);

  // Section: transition gate between run 1 and run 2.
  useEffect(() => {
    if (phase !== 'transition') {
      return;
    }

    const startRun2 = () => {
      if (!session) {
        return;
      }
      const firstRun2Plan = session.runPlans.run2[0];
      if (!firstRun2Plan) {
        setPhase('error');
        setStatusText('Run 2 plan is empty.');
        return;
      }
      setCurrentRunIndex(2);
      setCurrentTrialIndex(1);
      setActivePlan(firstRun2Plan);
      setPhase('trial');
      setStatusText('Run 2 started.');
    };

    const keyHandler = (event: KeyboardEvent) => {
      if (!isContinueKey(event.code)) {
        return;
      }
      event.preventDefault();
      startRun2();
    };

    window.addEventListener('keydown', keyHandler);

    if (query.testMode) {
      const autoHandle = window.setTimeout(() => {
        startRun2();
      }, 150);
      return () => {
        window.clearTimeout(autoHandle);
        window.removeEventListener('keydown', keyHandler);
      };
    }

    return () => {
      window.removeEventListener('keydown', keyHandler);
    };
  }, [phase, query.testMode, session]);

  // Section: keyboard shortcut for repeat on completion.
  useEffect(() => {
    if (phase !== 'session_complete') {
      return;
    }

    const keyHandler = (event: KeyboardEvent) => {
      if (!isRepeatKey(event.code)) {
        return;
      }
      event.preventDefault();
      repeatPractice();
    };

    window.addEventListener('keydown', keyHandler);
    return () => window.removeEventListener('keydown', keyHandler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  /**
   * Repeat practice with the same controls but new deterministic attempt seed.
   */
  const repeatPractice = useCallback(() => {
    setAttemptIndex((prev) => prev + 1);
    setSession(null);
    setExports(null);
    setActivePlan(null);
    setCurrentRunIndex(1);
    setCurrentTrialIndex(1);
    setFixationFeedback('neutral');
    setPhase('setup');
    setStatusText('Ready for a new practice attempt.');
  }, []);

  const downloadBehavior = useCallback(() => {
    if (!session || !exports) {
      return;
    }
    downloadTextFile(`practice_session_${session.sessionId}.json`, exports.behaviorJson);
  }, [exports, session]);

  const downloadMetadataJson = useCallback(() => {
    if (!session || !exports) {
      return;
    }
    downloadTextFile(`practice_metadata_${session.sessionId}.json`, exports.metadataJson);
  }, [exports, session]);

  const downloadMetadataCsv = useCallback(() => {
    if (!session || !exports) {
      return;
    }
    downloadTextFile(`practice_metadata_${session.sessionId}.csv`, exports.metadataCsv);
  }, [exports, session]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>DAD PTB Practice Web</h1>
        <p>
          Browser practice clone of PTB flow: run 1 and run 2 catch-only, deterministic shared input,
          and provenance-ready logging.
        </p>
      </header>

      <section className="panel info-panel">
        <h2>Session Controls</h2>
        <div className="control-grid">
          <label>
            Participant Number
            <input
              type="number"
              min={1}
              value={participantInput}
              onChange={(e) => setParticipantInput(e.target.value)}
              disabled={phase !== 'setup' && phase !== 'error'}
            />
          </label>
          <label>
            Run 1 Trials
            <input
              type="number"
              min={1}
              value={run1CountInput}
              onChange={(e) => setRun1CountInput(e.target.value)}
              disabled={phase !== 'setup' && phase !== 'error'}
            />
          </label>
          <label>
            Run 2 Trials
            <input
              type="number"
              min={1}
              value={run2CountInput}
              onChange={(e) => setRun2CountInput(e.target.value)}
              disabled={phase !== 'setup' && phase !== 'error'}
            />
          </label>
        </div>

        <div className="button-row">
          <button
            type="button"
            onClick={() => {
              void initializePracticeSession();
            }}
            disabled={
              phase === 'initializing' ||
              phase === 'trial' ||
              phase === 'question' ||
              phase === 'feedback'
            }
          >
            {phase === 'initializing' ? 'Preparing...' : 'Start Practice'}
          </button>

          {phase === 'session_complete' && (
            <button type="button" onClick={repeatPractice}>
              Repeat Practice (R or 8)
            </button>
          )}
        </div>

        <p className="status-text">{statusText}</p>

        <div className="meta-grid">
          <div>
            <strong>Attempt</strong>
            <span>{attemptIndex}</span>
          </div>
          <div>
            <strong>Detected Refresh</strong>
            <span>{detectedRefreshHz ? `${detectedRefreshHz} Hz` : '-'}</span>
          </div>
          <div>
            <strong>Refresh Samples</strong>
            <span>{refreshSampleCount || '-'}</span>
          </div>
          <div>
            <strong>Refresh Method</strong>
            <span>{refreshMethod ?? '-'}</span>
          </div>
          <div>
            <strong>Target Input FPS</strong>
            <span>{targetInputFps ?? '-'}</span>
          </div>
          <div>
            <strong>Input Source</strong>
            <span>
              {inputDataset
                ? `${inputDataset.datasetId} (${inputWasGenerated ? 'generated now' : 'cached'})`
                : '-'}
            </span>
          </div>
          <div>
            <strong>Current Run/Trial</strong>
            <span>
              {hasSession ? `Run ${currentRunIndex}, Trial ${currentTrialIndex}` : '-'}
            </span>
          </div>
        </div>
      </section>

      <section className="panel stage-panel">
        <h2>Practice Stage</h2>
        <canvas ref={canvasRef} width={900} height={420} className="practice-canvas" />

        {phase === 'question' && (
          <div className="overlay question-overlay">
            <h3>{questionPromptText}</h3>
            <p>
              NO: Left Arrow / 1 / N | YES: Right Arrow / 8 / Y
            </p>
          </div>
        )}

        {phase === 'transition' && (
          <div className="overlay transition-overlay">
            <h3>End of Run 1</h3>
            <p>Run 2 will now start.</p>
            <p>Instruction reminder: keep central fixation and answer quickly/accurately.</p>
            <p>Press 1 / 8 / Space / Enter or click below.</p>
            <button
              type="button"
              onClick={() => {
                if (session?.runPlans.run2[0]) {
                  setCurrentRunIndex(2);
                  setCurrentTrialIndex(1);
                  setActivePlan(session.runPlans.run2[0]);
                  setPhase('trial');
                  setStatusText('Run 2 started.');
                }
              }}
            >
              Start Run 2
            </button>
          </div>
        )}
      </section>

      {phase === 'session_complete' && session && exports && (
        <section className="panel summary-panel">
          <h2>Summary by Catch Type</h2>
          <SummaryTable rows={currentSummaryRows} />

          <div className="run-counts">
            <div>
              <strong>Run 1 planned/completed:</strong>{' '}
              {session.runPlannedVsCompleted.run1Planned}/{session.runPlannedVsCompleted.run1Completed}
            </div>
            <div>
              <strong>Run 2 planned/completed:</strong>{' '}
              {session.runPlannedVsCompleted.run2Planned}/{session.runPlannedVsCompleted.run2Completed}
            </div>
          </div>

          <div className="button-row">
            <button type="button" onClick={downloadBehavior}>
              Download Behavior Output (JSON)
            </button>
            <button type="button" onClick={downloadMetadataJson}>
              Download Metadata Log (JSON)
            </button>
            <button type="button" onClick={downloadMetadataCsv}>
              Download Metadata Log (CSV)
            </button>
          </div>
        </section>
      )}

      <footer className="app-footer">
        <p>
          Test mode: <code>?testMode=1&amp;participant=999&amp;run1=4&amp;run2=4&amp;autoStart=1</code>
        </p>
        <p>
          Arena mapping is a square 10x10 deg coordinate space (designed for ~60 cm viewing distance assumptions).
        </p>
        <p>
          Key map uses <code>KeyboardEvent.code</code>: YES {`{${RESPONSE_KEYS.yesCodes.join(', ')}}`},
          NO {`{${RESPONSE_KEYS.noCodes.join(', ')}}`}.
        </p>
      </footer>
    </div>
  );
}

interface DrawTrialFrameArgs {
  context: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  source: ReturnType<typeof sourceTrialByIndex>;
  altSource: ReturnType<typeof sourceTrialByIndex> | null;
  plan: PracticeTrialPlan;
  runIndex: 1 | 2;
  frameIndex: number;
  fixationFeedback?: FixationFeedback;
}

/**
 * Draw one animation frame for the currently active trial plan.
 */
function drawTrialFrame(args: DrawTrialFrameArgs): void {
  const { context, canvas, source, altSource, plan, runIndex, frameIndex, fixationFeedback = 'neutral' } = args;
  const frameOneBased = frameIndex + 1;
  const arenaRect = getArenaRect(canvas);

  // Section: background and arena frame.
  context.fillStyle = '#080b12';
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.fillStyle = '#0b1320';
  context.fillRect(arenaRect.x, arenaRect.y, arenaRect.size, arenaRect.size);

  context.strokeStyle = '#1f2937';
  context.lineWidth = 2;
  context.strokeRect(arenaRect.x, arenaRect.y, arenaRect.size, arenaRect.size);

  // Section: precompute run-2 occluder activation and draw it later on top of the dot.
  const drawPreOccluder = runIndex === 2 && source.occlusionEnabled && frameOneBased < source.pathbandPreAnchorFrame;
  const drawPostOccluder =
    runIndex === 2 &&
    source.occlusionEnabled &&
    frameOneBased >= source.pathbandPostAnchorFrame &&
    frameOneBased <= source.pathbandPostDeactivateFrame;

  // Section: resolve active position and visibility according to catch logic.
  let point = source.xy[Math.min(frameIndex, source.xy.length - 1)];
  let visible = true;

  if (runIndex === 1 && plan.catchTypeCode === 1) {
    if (
      plan.catchDisappearFrame !== null &&
      plan.catchReappearFrame !== null &&
      frameOneBased >= plan.catchDisappearFrame &&
      frameOneBased < plan.catchReappearFrame
    ) {
      visible = false;
    }

    if (
      visible &&
      plan.catchBranchChangedPath === 1 &&
      altSource &&
      plan.catchReappearFrame !== null &&
      frameOneBased >= plan.catchReappearFrame
    ) {
      point = altSource.xy[Math.min(frameIndex, altSource.xy.length - 1)];
    }
  }

  if (runIndex === 2 && plan.catchTypeCode === 2 && source.occlusionEnabled) {
    visible = !isPointFullyOccludedByPathband(source, point, frameOneBased);
  }

  // Section: draw dot and fixation.
  if (visible) {
    const px = toCanvas(point, canvas);
    context.fillStyle = runIndex === 1 ? '#38bdf8' : '#22c55e';
    context.beginPath();
    context.arc(px.x, px.y, 8, 0, Math.PI * 2);
    context.fill();
  }

  // Section: render run-2 occluder after dot so it truly occludes stimulus pixels.
  if (drawPreOccluder) {
    drawPathbandPolyline(context, canvas, source.pathbandPreXY, source.pathbandWidthDeg, source.pathbandTerminalStyle);
  }
  if (drawPostOccluder) {
    drawPathbandPolyline(context, canvas, source.pathbandPostXY, source.pathbandWidthDeg, source.pathbandTerminalStyle);
  }

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  context.strokeStyle =
    fixationFeedback === 'correct' ? '#22c55e' : fixationFeedback === 'incorrect' ? '#ef4444' : '#e5e7eb';
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(cx - 10, cy);
  context.lineTo(cx + 10, cy);
  context.moveTo(cx, cy - 10);
  context.lineTo(cx, cy + 10);
  context.stroke();

  context.fillStyle = '#9ca3af';
  context.font = '13px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
  context.fillText(`Run ${runIndex} | Trial ${plan.executedTrialIndex} | Frame ${frameIndex + 1}`, 36, 22);
}

/**
 * Convert one polyline from visual-degree coordinates to canvas coordinates and
 * render it as an occluder path-band.
 */
function drawPathbandPolyline(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  points: Array<{ x: number; y: number }>,
  widthDeg: number,
  terminalStyle: 'round' | 'straight',
): void {
  if (points.length < 2) {
    return;
  }

  context.strokeStyle = '#050505';
  context.lineWidth = Math.max(2, degToCanvasDistance(widthDeg, canvas));
  context.lineCap = terminalStyle === 'round' ? 'round' : 'butt';
  context.lineJoin = 'round';
  context.beginPath();

  for (let i = 0; i < points.length; i += 1) {
    const pt = toCanvas(points[i], canvas);
    if (i === 0) {
      context.moveTo(pt.x, pt.y);
    } else {
      context.lineTo(pt.x, pt.y);
    }
  }

  context.stroke();
}

/**
 * Match run-2 full-occlusion visibility criterion used during source timing
 * derivation: hide the dot only when its center-to-pathband distance implies
 * fully invisible occupancy.
 */
function isPointFullyOccludedByPathband(
  source: ReturnType<typeof sourceTrialByIndex>,
  point: { x: number; y: number },
  frameOneBased: number,
): boolean {
  const preActive = frameOneBased < source.pathbandPreAnchorFrame;
  const postActive =
    frameOneBased >= source.pathbandPostAnchorFrame &&
    frameOneBased <= source.pathbandPostDeactivateFrame;

  let minDistance = Number.POSITIVE_INFINITY;

  if (preActive) {
    minDistance = Math.min(minDistance, distancePointToPolyline(point, source.pathbandPreXY));
  }
  if (postActive) {
    minDistance = Math.min(minDistance, distancePointToPolyline(point, source.pathbandPostXY));
  }

  // Fallback to precomputed frame bounds if geometry cannot be resolved.
  if (!Number.isFinite(minDistance)) {
    return frameOneBased >= source.occlusionCompleteFrame && frameOneBased <= source.occlusionEndFrame;
  }

  return minDistance <= source.pathbandHalfWidthDeg - DOT_RADIUS_DEG;
}

function distancePointToPolyline(point: { x: number; y: number }, polyline: Array<{ x: number; y: number }>): number {
  if (polyline.length < 2) {
    return Number.POSITIVE_INFINITY;
  }

  let minDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const distance = distancePointToSegment(point, polyline[i], polyline[i + 1]);
    minDistance = Math.min(minDistance, distance);
  }

  return minDistance;
}

function distancePointToSegment(
  point: { x: number; y: number },
  segA: { x: number; y: number },
  segB: { x: number; y: number },
): number {
  const abX = segB.x - segA.x;
  const abY = segB.y - segA.y;
  const apX = point.x - segA.x;
  const apY = point.y - segA.y;

  const abSq = abX * abX + abY * abY;
  if (abSq <= 1e-12) {
    return Math.hypot(apX, apY);
  }

  const projection = (apX * abX + apY * abY) / abSq;
  const t = Math.max(0, Math.min(1, projection));
  const closestX = segA.x + t * abX;
  const closestY = segA.y + t * abY;
  return Math.hypot(point.x - closestX, point.y - closestY);
}

interface ArenaRect {
  x: number;
  y: number;
  size: number;
}

function getArenaRect(canvas: HTMLCanvasElement): ArenaRect {
  const inset = 48;
  const usableWidth = canvas.width - inset * 2;
  const usableHeight = canvas.height - inset * 2;
  const size = Math.max(10, Math.min(usableWidth, usableHeight));

  return {
    x: (canvas.width - size) / 2,
    y: (canvas.height - size) / 2,
    size,
  };
}

function degToCanvasDistance(distanceDeg: number, canvas: HTMLCanvasElement): number {
  const arenaRect = getArenaRect(canvas);
  const degreesAcross = ARENA_X_MAX - ARENA_X_MIN;
  return (distanceDeg / degreesAcross) * arenaRect.size;
}

function toCanvas(point: { x: number; y: number }, canvas: HTMLCanvasElement): { x: number; y: number } {
  const arenaRect = getArenaRect(canvas);

  const nx = (point.x - ARENA_X_MIN) / (ARENA_X_MAX - ARENA_X_MIN);
  const ny = (point.y - ARENA_Y_MIN) / (ARENA_Y_MAX - ARENA_Y_MIN);

  return {
    x: arenaRect.x + nx * arenaRect.size,
    y: arenaRect.y + ny * arenaRect.size,
  };
}

interface SummaryTableProps {
  rows: PracticeSessionResult['summary']['byRunAndCatch'];
}

function SummaryTable({ rows }: SummaryTableProps) {
  if (rows.length === 0) {
    return <p>No summary rows available.</p>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Run</th>
            <th>Catch Type</th>
            <th>Correct/Scored</th>
            <th>Accuracy %</th>
            <th>Answered</th>
            <th>Timeouts</th>
            <th>Mean RT (ms)</th>
            <th>Median RT (ms)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.runIndex}-${row.catchTypeCode}`}>
              <td>{row.runIndex}</td>
              <td>{row.catchTypeLabel}</td>
              <td>
                {row.nCorrect}/{row.nScored}
              </td>
              <td>{row.accuracyPct !== null ? row.accuracyPct.toFixed(1) : '-'}</td>
              <td>{row.nAnswered}</td>
              <td>{row.nTimedOut}</td>
              <td>{row.meanRtMs !== null ? row.meanRtMs.toFixed(1) : '-'}</td>
              <td>{row.medianRtMs !== null ? row.medianRtMs.toFixed(1) : '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default App;
