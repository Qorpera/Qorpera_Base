# Qorpera's Mini Company — controller audit

**Date:** 2026-08-13
**Company:** `C:\Companies\qorperas-mini-company`
**Base installer under test:** shell `0.18.12`, published release
**Schedule:** `Company orchestration`, active every 10 minutes

## Company shape exercised

- Four teams: Product & AI, Engineering, Growth & Customers, and Operations.
- An Executive page that should tell the founder what matters now, why, and
  what to do next.
- Company plans, team work, decisions, scheduled jobs, and a complete history
  of what the controller tried.
- Both successful and failed scheduled runs, so Activity can be tested as a
  real recovery tool rather than a success-only demo.

## Issue ledger

| ID | Finding | Status | Evidence / fix |
|---|---|---|---|
| QMC-001 | Initial test used the retired Desktop product instead of the Base company controller. | Resolved | Repeated the test through `Qorpera Base.exe --company <root>`; Desktop remains comparison material only. |
| QMC-002 | Scheduled work was not discoverable or manageable in Base Activity. | Fixed | Activity now lists named jobs, schedule, prompt, state, recent runs, full details, and create/edit/pause/resume/run-now/delete actions. |
| QMC-003 | Reopening an older trail could move the controller and scheduled wakes back to its stale model. | Fixed | Persisted controller model preference is applied to every controller launch; live process verified as `openai-codex/gpt-5.6-sol`. |
| QMC-004 | Founder/inbound wakes could contaminate a scheduled job's failure streak. | Fixed | Scheduled outcome bookkeeping is keyed to the named scheduled job only. |
| QMC-005 | A failed wake prompt send could restart the controller twice and count a false failure. | Fixed | Prompt-send failure now has one teardown/restart path and no scheduled outcome without a sent prompt. |
| QMC-006 | Python validation produced `__pycache__`/bytecode that autonomous checkpoints committed. | Fixed for future checkpoints | Checkpoint path selection excludes `__pycache__`, `.pyc`, and `.pyo`. Historical company commit `fabf873` is retained; history was not rewritten. |
| QMC-007 | While one autonomous run was live, every historical autonomous row said `Running…`. | Fixed | Only the exact live trail is marked live. Every autonomous row now remains inspectable through the read-only run panel, including while another run owns the controller. |
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
| QMC-021 | A stale installed `0.18.11` instance needed to discover the new release through the production updater path. | Verified | The installed app downloaded `0.18.12` and displayed “restart to apply”; the exact unpacked release reported `v0.18.12` and “up to date.” |
| QMC-022 | The released manual “Run now” path, duplicate-run guard, and interrupted-run marker needed end-to-end verification. | Verified | The confirmation showed the exact company, title, schedule, and prompt; authorization started one GPT-5.6 Sol child, disabled duplicate execution, persisted `activeTrailFile`, cleared it on completion, restored the founder child, and projected the completed run immediately. |
| QMC-023 | The founder could not tell what the company did from the Executive or Product surfaces. | Fixed in the Mini Company; platform gap remains | Reworked the canonical state and both surfaces so they state the product, target customer, painful workflow, current stage, next 30-day outcome, proven evidence, assumptions, financial boundary, and decisions/blockers. A new company still has no required founder-overview contract or onboarding check. |
| QMC-024 | A terminated controller turn checkpointed four new substrate schemas before updating their consuming surfaces, leaving blank Executive panels and hidden canonical fields. | Repaired in the Mini Company; platform guard outstanding | Partial checkpoint `8390e9c` changed executive, product, operations, and pipeline state. `af20dd9` repaired `executive.html` and `product.html`. The kernel still lacks a transaction/publish boundary for coupled substrate-and-surface changes. |
| QMC-025 | The company validator passed structurally valid state while the published surfaces were semantically broken. | Outstanding | `validate_controller.py` checks JSON, projection, entry existence, and static substrate references, but not field contracts or rendered section coverage. The blank panels were discoverable only through the real controller UI. |
| QMC-026 | Founder runs failed with upstream connection refusal, `kernel model request denied`, and later `terminated`, without a retry control, partial-change summary, or recovery guidance. | Fixed in source | Failed turns now keep the first useful cause, explain what to do next, show what completed before the stop, identify known changed files, and offer Retry. Restored conversations show one recovery card per failed turn instead of repeating later generic symptoms. |
| QMC-027 | A due scheduled wake can take the controller while the founder is composing a repair, blocking send with only a transient `controller is busy` toast. | Outstanding | The draft is preserved, but the controller still does not name the active job or offer `Run when free`. A founder must leave chat, find Activity, and manage the recurring job manually. |
| QMC-028 | The failed scheduled wake reverted an already approved authority gate back to `pending`. | Outstanding | Checkpoint `d2a2fee` changed `inbox/gate-4ee5598e.md` from `approved` to `pending`, reopening a resolved cleanup request. I denied the redundant request after validating with `python -B` to avoid another cache-producing cycle. |
| QMC-029 | The Inbox mixed an implementation-cleanup gate with two overlapping, obsolete founder requests, obscuring the actual business decision. | Mitigated in the Mini Company; UX gap remains | Denied the repeated cache gate and settled both completed foundation notices. The Inbox now says nothing needs the founder, but it has no priority, deduplication, supersession, or stale-request model. |
| QMC-030 | Opening an incomplete scheduled run could produce an empty main view. | Fixed and UI-verified | Autonomous rows now open a populated read-only run inspector, never a chat composer. The tested failed conception run showed cause, next action, start time, status, duration, model, job, technical detail, and partial-work summary. |
| QMC-031 | Activity exposed failure status but not the actionable failure cause. | Fixed and UI-verified | Failed Activity rows now state the useful cause inline. Run details add recovery guidance and the full technical error; scheduled-job details link directly to the failed run and can retry a named job as a new run. |
| QMC-032 | Opening an incomplete run mutated its historical trail and changed the displayed run timestamp. | Fixed and UI-verified | Inspection no longer resumes the autonomous session. Activity uses the session-header start time. The tested trail kept SHA-256 `FC74628120527877894ED4751DDA5805F8391B5EFB8BE3026EA9FA44087D3332`, length 9,767, and its original modification time before and after inspection. |
| QMC-033 | The Add Department wizard creates organization structure but does not guide a founder through creating a company. | Outstanding | The three-step flow covers type, name, and setup. Company Interface offers scratch, Financial Operations, Customer Support, or People & Culture; it does not establish mission, customer, product hypothesis, milestones, authority, or a founder home. |
| QMC-034 | Opening a founder conversation in the patched development controller fell back to the base shell and left the controller unavailable. | Recovered; UX cause outstanding | The main view said `your evolved app failed to load — running the base chrome (kernel fallback)`. The draft was preserved, but the toast incorrectly said autonomous work was busy. A clean restart recovered the company, its GPT-5.6 Sol controller, and the one active 10-minute job. The fallback still needs a specific cause and guided reconnect action. |
| QMC-035 | The founder controller could create new surface files but could not overwrite the two published surface files. | Outstanding | `write`, `edit`, append, and atomic replacement of `executive.html` / `product.html` returned `EPERM` even though the files were not read-only and the sandbox ACL had Modify. The controller recovered by creating `*-founder.html` files and switching the projection, but a simple wording change took 31 steps and left the old pages in place. |

## Founder-only operating pass

The test assumes the founder only has the controller. They should not need to
know where files live or how the app is built.

The company in plain language:

> Qorpera's Mini Company tells a small-business founder what needs attention
> next, why it matters, and what to do about it — all in one place.

- **Who it is for:** founders of small software companies who are still
  juggling product, engineering, customers, and money themselves.
- **The problem:** they have to chase updates across several tools before they
  can decide what to do next.
- **What the company is building:** one clear home that shows the most
  important issue, the reason it matters, and the next safe action.
- **Where it is now:** the internal controller works, but there is no customer
  proof yet: 0 researched companies, 0 interviews, 0 design partners, and
  USD 0 revenue.
- **Next milestone:** research 10 matching companies and prepare an outreach
  plan. Do not contact anyone until the founder approves it.
- **Spending rule:** this is still a test company. No external spending is
  approved.

Founder work completed through the controller:

- Set the target customer, geography, spending limit, and no-contact rule.
- Rewrote and published plain-language Executive and Product pages through the
  GPT-5.6 Sol founder controller; checkpoint `a582507` contains the new pages
  and projection update.
- Repaired the Executive and Product pages after an interrupted run left them
  incomplete.
- Checked that all five company data files and controller pages still load.
- Cleared old Inbox requests that no longer needed a decision.
- Paused the 10-minute job during repair, then resumed it unchanged.

The next business task is still blocked: the controller has no approved public
research connection, so it cannot build the 10-company list with source links.
The Executive page says this, but does not yet provide a direct way to connect
the missing research tool.

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

Published-release manual-run trail:
`trail/2026-08-13T20-25-51-104Z_c6652a9c-d381-4778-af1a-c82b4df2bf9a.jsonl`

- Started through Activity’s released “Run now” control after an exact-content
  authorization and ran on GPT-5.6 Sol.
- Persisted the new active-trail marker while running and cleared it on the
  terminal outcome; duplicate run-now execution stayed disabled.
- Recorded a 30.891-second non-eligible no-op with zero human interventions,
  passed controller validation, checkpointed the company, and restored the
  founder controller.

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
- The focused app-server regression passes: 11 tests, including stable run
  time, actionable connection failure, completed-step count, changed-file
  summary, and failed outcome for an aborted autonomous run.
- The patched Activity page shows failure causes inline and opens a populated
  read-only run inspector. The inspected trail's SHA-256, byte length, and
  modification time were identical before and after opening it.
- The founder controller published the plain-language Executive and Product
  pages, preserved the underlying company data files, and passed controller,
  page-content, unique-ID, live-data-reference, and JavaScript checks.
- Scheduled-job, wake-scheduler, app-server, controller-model, and checkpoint
  regressions pass (42 focused tests).
- New sandbox Git environment test passes (2 assertions groups).
- Actual sandbox command succeeds as `CodexSandboxOffline` against the Mini
  Company repository.
- Controller validation passes with 5 substrates and `app/projection.json`.
- The exact unpacked published release resumed the 10-minute job, persisted a
  completed outcome, and returned to the founder controller process.
- Published `v0.18.12` from `3e8d7748e`; source claim `shell-v0.18.12` points to
  the same commit and all updater asset names were read back from GitHub.
- The downloaded published installer matches the locally signed build byte for
  byte by SHA-512.
