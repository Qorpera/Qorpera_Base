# Qorpera's Mini Company — controller audit

**Date:** 2026-08-13
**Company:** `C:\Companies\qorperas-mini-company`
**Base installer under test:** shell `0.18.12` release candidate
**Schedule:** `Company orchestration`, active every 10 minutes

## Company shape exercised

- Four departments: Product & AI Research, Engineering & Reliability,
  Growth & Customer Success, and Operations & Finance.
- Five company substrates projected into five controller surfaces, including
  the executive dashboard and department dashboards.
- Company plans, backlogs, routines, inbox escalation, append-only trails,
  model brokering, autonomous checkpoints, and scheduled-job run history.
- Successful scheduled runs on GPT-5.6 Sol plus intentionally retained failed
  runs, so the Activity page exposes both success and recovery states.

## Issue ledger

| ID | Finding | Status | Evidence / fix |
|---|---|---|---|
| QMC-001 | Initial test used the retired Desktop product instead of the Base company controller. | Resolved | Repeated the test through `Qorpera Base.exe --company <root>`; Desktop remains comparison material only. |
| QMC-002 | Scheduled work was not discoverable or manageable in Base Activity. | Fixed | Activity now lists named jobs, schedule, prompt, state, recent runs, full details, and create/edit/pause/resume/run-now/delete actions. |
| QMC-003 | Reopening an older trail could move the controller and scheduled wakes back to its stale model. | Fixed | Persisted controller model preference is applied to every controller launch; live process verified as `openai-codex/gpt-5.6-sol`. |
| QMC-004 | Founder/inbound wakes could contaminate a scheduled job's failure streak. | Fixed | Scheduled outcome bookkeeping is keyed to the named scheduled job only. |
| QMC-005 | A failed wake prompt send could restart the controller twice and count a false failure. | Fixed | Prompt-send failure now has one teardown/restart path and no scheduled outcome without a sent prompt. |
| QMC-006 | Python validation produced `__pycache__`/bytecode that autonomous checkpoints committed. | Fixed for future checkpoints | Checkpoint path selection excludes `__pycache__`, `.pyc`, and `.pyo`. Historical company commit `fabf873` is retained; history was not rewritten. |
| QMC-007 | While one autonomous run was live, every historical autonomous row said `Running…`. | Fixed | The live row says `Running…`; other temporarily locked rows say `Unavailable` with an exact explanation. Job details also show `Runtime busy` instead of offering a doomed run-now action. |
| QMC-008 | The Windows sandbox account could not run Git in the founder-owned company (`dubious ownership`). | Fixed | Child Git config now marks only the exact authorized company/worktree as safe at command scope, disables inherited Git config/prompts, and passes a real `CodexSandboxOffline` `git status` check. |
| QMC-009 | A Mini Company workflow command parsed the Windows trail path as a POSIX basename, then hit a shell-quoting error while recovering. | Fixed in company tool | `record_workflow_attempt.py` now derives its start time directly from `QORPERA_SESSION_FILE` across Windows/POSIX paths when `--started-at` is omitted. The failed run remains recorded as `Execution`, preserving honest reliability history. |
| QMC-010 | Scheduled wakes require the company runtime to remain open; closing Base provides no headless scheduler. | Outstanding, disclosed | The editor states that jobs run while the company is open and missed intervals coalesce on reopen. A durable headless/service scheduler is a separate architecture change. |
| QMC-011 | Shell packaging reported ASAR disabled, missing package author, duplicate dependency declarations, and Electron `shell:true` deprecation. | Partially fixed | Added package author and invoked electron-builder directly without deprecated `shell:true`. ASAR remains deliberately disabled because the shipped RPC/extensions are real files; electron-builder still reports harmless duplicate transitive references while scanning the deduplicated closure. |
| QMC-012 | `Succeeded` conflated a cleanly settled agent run with business/workflow success, even when the company's own SLI recorded a recovered tool failure. | Fixed | Activity now calls the kernel state `Completed` and labels the detail fact `Last completed outcome`; company-level success/failure remains in its own evidence substrate. |
| QMC-013 | The root check had been narrowed to `packages`, masking nested-worktree configuration errors and other root files. | Fixed | Restored the full-repository check and taught Biome to honor the repository ignore file. |
| QMC-014 | Editing a kernel-suspended job's title, prompt, or interval silently cleared its suspension. | Fixed | Suspension clears only on an explicit `enabled: true` resume operation; regression covered. |
| QMC-015 | Autonomous startup/concurrent product or userland actions could leave the founder controller stopped or create competing writers. | Fixed | Wake startup restores the founder child on failure; inventory restart, restore, merge, and inbound scheduling serialize against a live wake and catch asynchronous failures. |
| QMC-016 | A recent interrupted autonomous trail could be inferred as `Running` after its process no longer existed. | Fixed | The kernel publishes the exact live autonomous trail; recent non-live incomplete sessions render as `Incomplete`. |
| QMC-017 | Controller model preference was global, so one company's selection could change another company's next launch. | Fixed | Model preferences are isolated by normalized company-root hash and legacy global preference is migrated once per company. |
| QMC-018 | Wake state writes were non-atomic, accepted malformed fields, and survived job deletion. | Fixed | Run state now uses atomic replace, validates every persisted field, and is removed with its job. |
| QMC-019 | The installed `0.18.11` runtime could not consume the new named-job contract under live test. | Resolved by release | Testing moved to the exact unpacked release candidate; its process and child command line were verified before resuming the schedule. |
| QMC-020 | Closing Base during a scheduled run left its persisted start without a terminal outcome or failure-streak update. | Fixed | Run state now records the active trail; the next attempted run reconciles an unfinished predecessor as failed, clears the active marker, and applies normal suspension policy. |

## Monitored runs

Trail:
`trail/2026-08-13T19-23-51-442Z_e1cdcf41-a14d-4da6-a3da-2b7efa87b15b.jsonl`

- Triggered from the 10-minute job and ran on GPT-5.6 Sol.
- Added release, rollback, and incident-response controls.
- Encountered and retained three tool errors: timestamp parsing, recovery
  quoting, and sandbox Git ownership.
- Recovered without a kernel crash, validated all five substrates, recorded
  the attempt as an `Execution` failure, and returned to the founder session.
- Reliability substrate then reported 2 eligible attempts, 1 success, 1
  failure, and a 0.5 measured baseline. Failure history was not rewritten as
  success.

Follow-up trail:
`trail/2026-08-13T19-36-54-326Z_75b22176-f436-442f-b4fe-526dc5bbbc5c.jsonl`

- Triggered automatically on the next due interval and ran on GPT-5.6 Sol.
- Its initial sandbox `git status` succeeded with no ownership error.
- The recorder derived `startedAt` from the Windows
  `QORPERA_SESSION_FILE` value without shell parsing or a supplied
  `--started-at` value.
- Completed and documented an interrupted-update recovery drill, validated
  the controller, and recorded a 111.012-second success with zero human
  interventions.
- Reliability now has 3 eligible attempts: 2 successes and 1 retained
  failure (0.6667 measured baseline).

Release-candidate trail:
`trail/2026-08-13T20-01-53-448Z_46c41052-6221-4287-b03d-4377879b7569.jsonl`

- Fired from the exact unpacked Base release candidate after the old installed
  runtime was closed cleanly.
- Ran on GPT-5.6 Sol and completed in about 95 seconds at the kernel layer.
- Added a 12-case pre-pilot workflow evaluation set, reconciled product and
  reliability projections, and passed controller validation.
- Recorded an 83.306-second eligible business-workflow success with zero human
  interventions; measured reliability is now 3 successes from 4 eligible
  attempts, with the earlier failure retained.

No-op discipline trail:
`trail/2026-08-13T20-12-53-445Z_cd740491-fa94-4468-85cd-c73d0de2543d.jsonl`

- Fired exactly once on the next scheduler tick and used GPT-5.6 Sol.
- Found no useful work that was both unblocked and within the company's
  standing authority, so it did not invent a task.
- Recorded a 34.155-second non-eligible no-op with zero human interventions,
  passed controller validation, checkpointed the company, and restored the
  founder controller.
- Persisted the no-op trail as the job's latest completed run with a zero
  failure streak; eligible reliability remains 3 successes from 4 attempts.

## Architecture comparison

| Concern | Qorpera Base | Retired Qorpera Desktop | T3 Code reference |
|---|---|---|---|
| Primary unit | Portable company folder with controller, departments, substrates, projections, inbox, and trail | Central application/service records for operators, workspaces, automations, and worker jobs | Coding sessions/projects with workspace panels |
| Scheduler authority | Kernel-owned named job definition in the company; run state machine-local; single-flight with controller writes | Dedicated automation contract plus worker/cron scheduler; richer central execution infrastructure | No native company scheduler in the referenced repository |
| Activity projection | One company-local view combining jobs and the complete operating trail | Dedicated automation surface/detail panel with mature schedule/target/model controls and run history | Session/task UI patterns are useful, but not a scheduled-work backend |
| Portability | Company files and trails travel together; credentials and standing trust remain machine-local | Product state is coupled to Desktop/cloud services and databases | Repository/workspace-centric, not a portable company operating record |
| Current limitation | No wakes while Base/company runtime is closed | Background worker architecture is stronger for unattended execution | Not applicable |

The Base shape is the correct long-term company-controller architecture. The
Desktop automation UI remains useful prior art, but its service-first state
model should not replace the company folder as Base's source of truth.

## Verification

- `npm run check` passes across 1,070 checked files with no warnings or infos.
- Scheduled-job, wake-scheduler, app-server, controller-model, and checkpoint
  regressions pass (42 focused tests).
- New sandbox Git environment test passes (2 assertions groups).
- Actual sandbox command succeeds as `CodexSandboxOffline` against the Mini
  Company repository.
- Controller validation passes with 5 substrates and `app/projection.json`.
- The exact unpacked release candidate resumed the 10-minute job, persisted a
  completed outcome, and returned to the founder controller process.
