# DAD PTB Practice Web (Isolated)

## Purpose
This repository is a standalone browser implementation of the PTB practice flow from the DAD project.

It mirrors the requested PTB practice behavior while staying isolated from the original MATLAB/PTB pipelines:
- Run 1 and Run 2 only.
- Catch-only practice trials.
- Tunable trial counts for run 1/run 2.
- Explicit run1->run2 transition gate.
- Repeatable practice attempt from UI button and keyboard shortcut.
- Deterministic shared input generation for all participants.

## What It Mirrors From PTB
The implementation mirrors the logic of:
- `run_practice_occlusion_v1.m`
- `MoveDot1_experiment_occlusion_v18_rescueTraject.m`
- `stimuli_generation_V28_rescueTraject.m`
- `CreateInputFiles_v21_rescueTraject.m`

Mapped behaviors:
- Refresh-aware input selection/generation.
- Practice-mode run trimming and catch forcing.
- Run 1 type-1 catch behavior (disappear/reappear with optional changed path).
- Run 2 type-2 catch behavior (path-band occlusion question with pre/post segments).
- Catch question timing, timeout handling, yes/no keyboard response mapping.
- Per-run and per-catch-type summary metrics.
- Strict 10x10 deg stimulus arena for trajectory generation/render mapping (no boundary bounce).

## Stack
- Vite + React + TypeScript
- Static hosting compatible (GitHub Pages)

## Run Locally
```bash
npm install
npm run dev
```

## Test Mode (Safe Non-Interactive)
Test mode bypasses manual participant entry and auto-completes a deterministic session.

Example:
```text
http://localhost:5173/?testMode=1&participant=999&run1=4&run2=4&autoStart=1
```

Query params:
- `testMode=1`: enable test mode.
- `participant=<int>`: participant number override.
- `run1=<int>`: run 1 trial count override.
- `run2=<int>`: run 2 trial count override.
- `fps=<int>`: refresh/fps override for deterministic input selection.
- `autoStart=1`: auto-launch from setup screen.

## Practice Config Example
Default config is in `src/config/practiceConfig.ts`.

Example values:
- `run1TrialCount = 8`
- `run2TrialCount = 8`
- `catchType1ChangedPathProbability = 0.5`
- `catchQuestionTimeoutSec = 4.0`

## Refresh-Aware Input Selection/Generation
At session start:
1. Browser refresh is estimated via `requestAnimationFrame` median interval.
2. Target input fps is derived by rounding/clamping to `[30, 240]`.
3. Shared deterministic input dataset for that fps is loaded from local cache.
4. If missing, it is generated on the fly and cached.

Important frame-scaling rule (preserved):
- `framesPerTrial = round(2.67 * fps)`
- Therefore 60 Hz has half samples of 120 Hz.

## Spatial/Occlusion Fidelity Notes
- Trajectory generation keeps dot centers inside a strict `[-5,+5]` x `[-5,+5]` deg arena with dot-size margin, so paths stay fully inside a 10x10 deg square.
- No boundary bounce is used; infeasible trajectories are rejected and regenerated deterministically.
- Run 2 renders path-band occluders with frame-wise activation:
  - Pre-deviance segment active before deviance anchor.
  - Post-deviance segment active from deviance anchor onward.
- Dot visibility in run 2 uses the same full-occlusion geometric threshold used to derive occlusion timing metadata.

## Keyboard Mapping (Robust Across Browsers)
Mappings use `KeyboardEvent.code` (not layout-dependent key names):
- YES: `ArrowRight`, `Digit8`, `Numpad8`, `KeyY`
- NO: `ArrowLeft`, `Digit1`, `Numpad1`, `KeyN`
- Continue transition: `Digit1`, `Digit8`, `Numpad1`, `Numpad8`, `Space`, `Enter`
- Repeat practice: `KeyR`, `Digit8`, `Numpad8`

## Outputs
At session end, UI exposes three downloads:
1. `practice_session_<sessionId>.json` (behavior output, RT + accuracy summary)
2. `practice_metadata_<sessionId>.json` (full metadata/provenance log)
3. `practice_metadata_<sessionId>.csv` (metadata/provenance in tabular form)

### Behavioral Output (`practice_session_*.json`)
Contains:
- Session identifiers and participant number.
- Planned/completed counts for run 1 and run 2.
- Trial-level response metrics (`responseCode`, `responseCorrect`, `responseRtMs`, `timedOut`).
- Summary by run and catch type (accuracy and RT stats).

### Metadata Log Schema (`practice_metadata_*.json` and CSV)
Includes required provenance fields:
- Participant/session:
  - `participantNumber`, `sessionId`, `startedAtIso`, `endedAtIso`, `browserUserAgent`.
- Display/input selection:
  - `detectedRefreshHz`, `targetInputFps`,
  - `selectedInputDatasetId`, `selectedInputDatasetVersion`, `selectedInputDatasetHash`.
- Run/trial identifiers:
  - `runIndex`, `executedTrialIndex`, `sourceTrialId`, `sourceIndex`, `sequenceId`.
- Path/trajectory provenance:
  - `sourcePathId`, `catchAltPathId`, `catchAltSourceIndex`.
- Practice subsampling provenance:
  - `includedBaseSlots`, `excludedBaseSlots`.
- Planned/completed tracking:
  - `plannedRunTrials`, `completedRunTrialsAtRecord`,
  - plus run-level planned/completed totals in session object.
- Catch response outcome:
  - `catchTypeCode`, `catchExpectedResponseCode`,
  - `catchResponseCode`, `catchResponseCorrect`, `catchResponseRtMs`, `catchTimedOut`.

## Verification
Run verification script:
```bash
npm run verify
```

It generates:
- `verification/verification_report.md`

Checks include:
- Run flow: run1 -> transition -> run2.
- Save/output artifact generation.
- Metadata includes trial/path/subsampling provenance columns.
- Refresh-aware input generation for multiple fps values.
- 60 Hz frame count equals half of 120 Hz.

## Build
```bash
npm run build
```

## GitHub Pages Deploy
This repo includes `.github/workflows/deploy-pages.yml`.

After pushing to GitHub:
1. Enable Pages in repository settings using GitHub Actions.
2. Workflow builds and publishes static `dist/`.

The expected URL pattern is:
- `https://<owner>.github.io/<repo>/`

(For private repos, access depends on GitHub Pages/private visibility settings.)
