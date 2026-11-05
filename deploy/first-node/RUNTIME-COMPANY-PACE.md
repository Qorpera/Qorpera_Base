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

When an agent's open work moved outside its routines and nothing else will wake it soon, the next run of its dynamic
routine comes early. All of these must hold:

| Condition | Why |
|---|---|
| The agent has open todos (state `open`, not `blocked`) that changed since the routine last ran, or since it was set up | open work it can move, and something moved; a todo that did not change brings nothing forward |
| The todo was last saved outside a routine run: by a conversation, a worker's continuation, a first run or a member | a routine run that left a todo open chose its own next run; so a run that only notes "checked, still waiting" brings nothing forward, and two routines of one agent never wake each other |
| No worker of the todo is active, none was stopped by a member, and it has no open or returned human task; it was not last saved by a run a member stopped | a worker's report and a human task's answer wake the agent by themselves; a member's Stop stays a stop |
| The todos have been quiet for the wait: 30 minutes plus the agent's offset (§3) | the run that changed them has ended, and the next one is not a hot loop |
| The agent is active, runs nothing (no queued or leased job of its own) and has nothing else queued before this routine's run | another run is coming anyway |
| The routine is the agent's dynamic routine without `after`, active, outside its quiet hours, its queued run further away than the wait and not itself brought forward | the run the agent chose comes soon anyway; a listener already waits for its own todo; a run brought forward inside quiet hours would only be held to their end; a held run brought forward is never brought forward again |
| The routine's latest run was not stopped by a member | as the restore pauses such a routine |

Then the folder tick (`qorpera_folder_dynamic_routines_due`, every 30 s) lists the routine, and
`qorpera_folder_restore_dynamic_routine_run` cancels the queued run (`Brought forward: open todos of the agent changed
and are still open`) and inserts the run now, in the same subtransaction as the admission: if the kernel refuses the
run, both are undone and the routine is suspended as before. The run that gave way is no attempt: the new run has its
attempt number, and a later retry's wait counts only real attempts (the occurrence key still counts every row). The
run's payload carries `followUp: { step, todos }` (up to 5 todo paths). The run is an ordinary dynamic run and decides
next or concludes.

How it ends:

* A run brought forward that changes nothing ends the follow-ups (nothing moved since it ran), and so does one that
  changes the todo itself: its own saves are a routine run's.
* What can bring the routine forward again is a new change outside the routines, such as a member's message or a
  worker's report the agent acts on. After a run that was brought forward, the next follow-up waits twice as long
  (30 minutes, 1 hour, 2, 4, 8, ...), so a chain of worker reports comes back less and less often, and after a few
  steps the wait is longer than the agent's own next run.

No run limit is added: a follow-up is an ordinary routine run, the provider's limits apply to it, and a run that stops
at the limit changes no todo, so it brings nothing forward either.

Kept as before: paused, concluded and expired routines, a paused company, an archived agent, a member's Stop of the
routine's latest run and the routine's end (SQL test 570 checks each).

Not seen: a member's turn or input still queued for the agent and a wait on the Company Computer are not "runs
something" to the check. At most one early run comes then, and it reads the same open work.

Cost: the due list evaluates the check for each active dynamic routine with a queued run (26 in production on 5
November 2026). The reads go by index: the routine's occurrences, the agent's open todos (shaped for
`qorpera_runtime_agent_todos_open`), their workers (by todo), commits (by id) and the commits' wakes (by run), the
environment's open human tasks (`qorpera_folder_human_task_index_due`), the company's queued and leased jobs
(`qorpera_runner_jobs_queue`) and queued wakes (`qorpera_wake_occurrences_company_queue`).

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
* A routine run that works on a todo, leaves it open and chooses a far next run is not second-guessed: that run chose
  with the todo in front of it, and the prompts carry its pace.

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
