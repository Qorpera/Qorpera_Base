# Company pace: follow-ups and spread start times

Status: source and tests (runtime + migration `20260930570000_routine_follow_ups.sql`, SQL test 570). Folder-v2 only.

## 1. The problem

Four live test companies, 4 November 2026: the last founder message was at 16:28 UTC, all work ended by 17:16, and
nothing ran for about 16 hours. All 23 routines in the four companies woke at exactly 2026-11-05 09:00 UTC. Every new
agent picked "daily at 09:00" as its default ("Daglig opfølgning er mit udgangspunkt … næste tjek 5. november kl. 09
UTC"): 19 dynamic routines with their next run at 09:00 the next morning, most set up the same afternoon, and 4
weekday plans at 09:00. Two agents still had open todos that waited for nobody (Legal's source checks, Lærdom's
Strategist's first assignment).

Two halves:

* (a) a run that ends with open work that needs no member should be followed by the next run within minutes to a few
  hours, not the next morning;
* (b) a company's agents should not all start at the same minute.

## 2. Follow-ups (a)

A mechanism in the folder tick, plus pacing words in the prompts.

### 2.1 The mechanism

When an agent's own open work moved and nothing else will wake it soon, the next run of its dynamic routine comes
early. All of these must hold:

| Condition | Why |
|---|---|
| The agent has open todos (state `open`, not `blocked`) that changed since the routine last ran, or since it was set up | open work it can move, and something moved; a todo that did not change brings nothing forward |
| No worker of the todo is active, and none was stopped by a member; the todo was not last saved by a run a member stopped | a worker's report wakes the agent by itself; a member's Stop stays a stop |
| The todos have been quiet for the wait: 30 minutes plus the agent's offset (§3) | the run that changed them has ended, and the next one is not a hot loop |
| The agent runs nothing (no queued or leased job of its own) and has nothing else queued before this routine's run | another run is coming anyway |
| The routine is the agent's dynamic routine without `after`, active, and its queued run is further away than the wait | the run the agent chose comes soon anyway; a listener already waits for its own todo |
| The routine's latest run was not stopped by a member | as the restore pauses such a routine |

Then the folder tick (`qorpera_folder_dynamic_routines_due`, every 30 s) lists the routine, and
`qorpera_folder_restore_dynamic_routine_run` cancels the queued run (`Brought forward: open todos of the agent changed
and are still open`) and inserts the next attempt of the same version now, in the same subtransaction as the admission:
if the kernel refuses the run, both are undone and the routine is suspended as before. The run's payload carries
`followUp: { step, todos }` (up to 5 todo paths). The run is an ordinary dynamic run and decides next or concludes.

The steps: after a run that was brought forward, the next follow-up waits twice as long (30 minutes, 1 hour, 2, 4, 8,
...). A run the agent's own time brought resets it. So:

* a run that changes nothing ends the follow-ups (nothing moved since it ran);
* a todo that keeps changing comes back less and less often, and after a few steps the wait is longer than the
  agent's own next run, so nothing more is brought forward.

No run limit is added: a follow-up is an ordinary routine run, the provider's limits apply to it, and a run that stops
at the limit changes no todo, so it brings nothing forward either.

Kept as before: paused, concluded and expired routines, a paused company, an archived agent, a member's Stop of the
routine's latest run, quiet hours (the insert's lifecycle trigger holds the run until the window ends) and the
routine's end.

Cost: the due list evaluates the check for each active dynamic routine with a queued run (26 in production on 5
November 2026). The reads are indexed: the routine's occurrences, the agent's open todos
(`qorpera_runtime_agent_todos_open`; test 570 checks the plan), their workers (by todo) and commits (by id), the
company's queued and leased jobs (`qorpera_runner_jobs_queue`) and queued wakes (`qorpera_wake_occurrences_company_queue`).

### 2.2 The prompts

Pacing only, so the reporting rework in the same files merges cleanly:

* `manage_routine`: start dense while a responsibility is new: while you can move it without a member, the next run is
  minutes to a few hours away, not the next morning; times on the hour or half hour move a few minutes per agent. The
  description stays within its 4096-byte cap (two clauses shortened: routineKey's length, which the refusal still
  says, and the thread-default effort note).
* `decide_routine`: minutes to a few hours ahead while you can move the work without a member or a reply is due; the
  next day only when it all waits for someone or is quiet.
* The dynamic routine wake: the same choice, and what `wake.payload.followUp` means (move those todos on first, mark a
  todo blocked while it waits for a person).

The hire overlays and the Standing work section are unchanged.

### 2.3 Not covered

* An agent without a dynamic routine (only weekly or every routines, as the Co-Founder's daily plan) gets no
  follow-up: a schedule routine's next run is a cursor slot, which cannot move. Most agents set up a dynamic routine
  in their first run (19 of 23 routines in the test companies).
* Open work that is not a todo (a responsibility the agent drives through its routine) is paced by the prompts only.

## 3. Spread start times (b)

In the runtime, at the tool boundary (`packages/runtime/src/cloud-routine-pace.ts`):

* Each agent has an offset of 1 to 20 minutes: the first 32 bits of the md5 of its lowercase id, modulo 20, plus 1. The
  SQL function `qorpera_routine_agent_offset_minutes` computes the same (tests pin the same ids on both sides).
* A start time the agent sets on the hour or half hour moves that much later: `manage_routine`'s weekly `localTime`
  (within its hour), any `firstRunAt`, a `when_done` `latestAt`, and `decide_routine`'s `at` (the decision writer
  applies it, since it knows the routine's end). An instant already passed ("right away") is kept, and so is one the
  move would take to or past the routine's end.
* The routine file holds the moved time, so the file, the tool result and the web's next run all say when it runs.
  The offset is the same in every save, so a repeated save is the same request and keeps its schedule position.
* Member saves in the web are not moved: a member's time is meant.

Why the runtime and not SQL: weekly routines are scheduled by the orchestrator from the file's time of day, so moving
the time where it is written covers every trigger kind in one place and keeps the file truthful.

## 4. Deploy order

Either order. The migration only changes the folder tick; an older runtime reads `followUp` as data. The runtime's
spread needs no SQL. Existing routine files keep their round times until the agent saves them again.
