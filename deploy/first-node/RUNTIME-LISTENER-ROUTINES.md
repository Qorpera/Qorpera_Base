# Listener routines: follow up when something is ready

Status: design + first slice (L1, migration `20260930565000_routine_listeners.sql`). Folder-v2 only.

Jonas, 4 November 2026: "Follow-up should be scheduled more direct to when a task is ready for review — such as a
listening schedule for an event, which should really be a new way to set up routines. If a direct event can't
necessarily activate the task, we can put out listeners for a task and activate it 'when x is done' or 'when Y
happens'."

## 1. The problem

In test companies agents follow up by the clock: "next check tomorrow 09:00 UTC". They do it to look at a worker's
result, a coworker's report, a person's human task, or a machine coming up. When the thing is ready at 09:05, it waits
almost a day. When it is not ready at 09:00, the run is wasted.

## 2. What already wakes an agent

| When … | Wakes | How |
|---|---|---|
| my worker reports | the agent that dispatched it | `worker-completion` wake (automatic) |
| a coworker messages me | the recipient | coworker message wake (automatic) |
| a person finishes, declines or is late on a human task I asked for | the asking agent (else the Co-Founder) | `human-task` wake, P31 (automatic) |
| my machine is ready or a command ends | the agent that started it | `machine-event` wake (automatic) |
| a long program keeps a machine busy | the agent that started it | `machine-checkin` wake (automatic) |
| a file or folder changes | the routine's agent | `file_change` routine (`company-file` wake, P29) |
| a hook or mailbox receives an event or an email | the routine's agent | `event` routine (E2) |
| a clock time | the routine's agent | `every`, `weekly`, `dynamic` routines |

What cannot wake an agent today:

| When … | Today |
|---|---|
| a **coworker's** todo is done ("when Product Builder's landing page is done") | guessed clock time — **L1 fixes this** |
| a human task **another agent** asked for is done | guessed clock time — **L1 fixes this** |
| a coworker replies to a specific question (not just any message) | any message wakes; no "only this thread" filter |
| a coworker's or another agent's machine becomes ready | only the starter is woken |
| a site or app link gets its first visitor | nothing |
| a coding session's PR is merged or CI goes green | nothing (the session hand-in wakes only on hand-in) |

Most clock follow-ups in the test companies were for things that already wake the agent by themselves (its own
worker, its own human task). Those need only a better instruction, which L1 adds to Standing work: "no routine waits
for them".

## 3. The design: `when` routines

A listener is a routine that waits for something to happen, with a fallback time so nothing waits forever:

    when <thing> <happens>, or at <latest time>, whichever comes first

* **Thing**: a todo, a human task, a file, an agent's thread, a machine, a site.
* **Happens**: done, changed, replied, ready, visited.
* **Once or repeating**: a once listener is a dynamic routine. When it wakes it decides like any dynamic routine: next
  run (a time, or a new listener) or conclude. A repeating listener is what `file_change` and `event` already are.
* **Fallback**: every once listener has a latest time. The run gets `done: true` when the thing happened and
  `done: false` when the time came first, so it knows whether to review or to chase.

### 3.1 How the agent sets it

`manage_routine` gets one more trigger kind:

    { "kind": "when_done",
      "path": "QorperaOS/agents/product-builder/todos/landing-page.md",
      "latestAt": "2026-11-06T09:00:00+01:00",
      "timeZone": "Europe/Copenhagen",
      "report": "optional" }

`path` is a todo file or a human task file. `.md` may be left out. The run then decides with `decide_routine` as
every dynamic routine does; `decide_routine next` takes an optional `whenDone` path to wait again. Without it, the next
run is a plain time.

Later kinds use the same shape (`when_replied`, `when_ready`, `when_visited`), each with a `latestAt`.

### 3.2 How it is stored

The routine file stays a dynamic routine (`when: once`) with one more key:

    when: once
    at: 2026-11-06T08:00:00Z
    after: QorperaOS/agents/product-builder/todos/landing-page.md
    timezone: Europe/Copenhagen

The index keeps `after` as the folded key in the version's trigger. A new `after` is a new version, like a new `at`.
The save is checked: the path must be a todo or human task file the company has. The first save is reviewed like any
new routine; a decision that sets or drops `after` is a plain decision (no review), like a new `at`.

### 3.3 How the review card reads

* `When the todo “Landing page” of product-builder is done, at the latest 6 Nov 2026 at 09:00 (Europe/Copenhagen)`
* `When the human task “Sign contract” is done, at the latest 6 Nov 2026 at 08:00 (UTC)`

### 3.4 How the platform fires it

No new table and no new writer. The folder tick that starts a dynamic routine's next run (every 30 s,
`qorpera_folder_dynamic_routines_due` then `qorpera_folder_restore_dynamic_routine_run`) holds a listening version's
run back while all of this holds:

* its trigger has `after`, and
* its `at` is still ahead, and
* it has had no run yet, and
* something open is still at `after`: an open or blocked todo, or an open or returned human task.

When that stops holding, the tick starts the run at once. "Nothing open is left" covers done, cancelled, declined,
accepted and deleted. The check is a read of the todo and human-task indexes by environment and folder key; it takes
no lock, and the tick's locks and order are unchanged. The run's payload carries `after` and `done`.

Why polling and not a trigger on the todo row: the todo and task commits must not lock or write wake rows (the folder
lock order), and a wake row's time cannot change once written. The tick already visits every dynamic routine each
pass, so the extra cost is one indexed read per listening routine.

## 4. The slice in this PR (L1)

* Routine file: `after:` on `when: once` (TS parser, writer, SQL shape check, rules, version trigger, trigger check).
* Tick: hold back, then start at once; payload `after` and `done`.
* Tools: `manage_routine` trigger `when_done`; `decide_routine next` `whenDone`.
* Review card and proposal card words.
* Prompt: Standing work prefers a listener over a guessed time, and says which follow-ups already wake the agent.
  The dynamic routine wake explains `wake.payload.done`.
* Tests: SQL 565 (file save and rules, tick), runtime tool, decision writer, parser, review card, prompt pins.

## 5. Next slices

1. **Coworker reply** (`when_replied`): wake when a named coworker posts in a named thread or replies to a message.
   Fires from the coworker message wake path; today every message already wakes the recipient, so this is a filter
   plus a fallback.
2. **Machine ready** (`when_ready`): any agent may wait for a named machine to be up or a command to end.
   The `machine-event` wake today goes only to the starter.
3. **First visitor** (`when_visited`): wake when a site or app link gets its first visit; needs a visit counter on
   company sites.
4. **Web routine list**: show "Waits for the todo … (at the latest …)" instead of "The agent picks each next run".
   The list already reads `after` without breaking.

## 6. Deploy order

The migration first, then the web (its routine list parser, in cloud-client, now takes `after`; the old one refuses a
version that has it), then the runtime, which is the only writer of `after`. The new SQL accepts files with and without
it, so an old runtime keeps working.
