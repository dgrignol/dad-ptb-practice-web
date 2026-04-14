# Verification Report

Generated at: 2026-04-14T14:00:40.506Z

## Check 1: Refresh-aware input generation
- PASS: 120 Hz and 60 Hz datasets generated deterministically.
- 120 Hz framesPerTrial: 320
- 60 Hz framesPerTrial: 160

## Check 2: Run flow and completion counts
- PASS: flow events = run1_start -> run1_end -> run1_to_run2_transition -> run2_start -> run2_end -> session_end
- Run1 planned/completed: 8/8
- Run2 planned/completed: 8/8

## Check 3: Save/export and provenance schema
- PASS: behavior JSON, metadata JSON, metadata CSV generated.
- Metadata CSV columns include: source_path_id, included_base_slots, excluded_base_slots, source_trial_id, run_index, executed_trial_index
- Example source path id: path_e272514d
