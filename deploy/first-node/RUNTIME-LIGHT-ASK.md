# Light asks

Status: built, 14 November 2026: migration `20260930761000` (SQL test 1258) and the runtime; not live until a
runtime release carries it. The web part (a new group asks for its name) is a change of its own. The contract's
"2026-11-14 amendment: light asks" is the rule; this file is how it is built.

Jonas, 14 November 2026, on a group just made in the apps drawer: "when a new group is created, I would like to run a
light call, having an agent name it". Asked how, between a visible message in the Co-Founder's thread and a new hidden
ask, he chose: "Build the light call".

## 1. What a light ask is

A light ask is one small question a member's own action raises, answered by one call to the small model, with no tools
and nothing shown in any thread. The first kind names a new group of apps in the member's drawer.

- **Closed kinds.** The cloud takes a kind and that kind's input, never a prompt. The prompt of each kind is the
  runtime bundle's. The input is data to the model, never instructions.
- **One call.** The small model at low effort, the one auto-review and the memory compactor use
  (`CLOUD_ACTION_REVIEW_MODEL`, `CLOUD_ACTION_REVIEW_EFFORT`), on a side thread with no tools, as the compactor's
  threads are (`cloud-codex-tool-session.ts`, `compact()`).
- **The member pays.** The asking member's own login, as `qorpera_starter_sponsor` chooses it for new work. A ChatGPT
  plan may pay: the ask is the plan owner's own request, made now, as a message of theirs is.
- **Nothing shows.** No conversation, no message, no card. The answer is a short text the member's browser reads and
  uses (it renames the group, which only that member may write).
- **No machine, no Company File.** The run reads nothing of the company and starts nothing.

## 2. Why it is a wake

A model call on a member's login can only run where that login can be opened: inside a run on an execution host. Every
run enters through the wake bus (contract §8). So a light ask is a wake, and its run is an ordinary agent run that the
runtime carries out lightly. Nothing new can lease, open a login or finish a run.

It follows the human-task wake (P31, `20260928489200_folder_state_human_task_wakes.sql`), the last wake source added:

| Part | Human task | Light ask |
|---|---|---|
| Wake kind, source | `agent`, `human-task` | `agent`, `light-ask` |
| Parent run | none | none |
| Marker row | `qorpera_folder_human_task_wakes` | `qorpera_light_asks` (also holds the answer) |
| Recipient | the task's agent, else the Co-Founder | the Co-Founder |
| Payer | the task's starter, never a ChatGPT plan | the asking member, a ChatGPT plan too |
| Conversation | the agent's thread | none (`session_id` null) |
| Reply | optional, in the thread | none: the answer goes to the marker row |

What it changes in existing functions, each an exact-text patch as P31's were (migration `20260930761000`):

1. `qorpera_wake_occurrences_source_kind_check`: one more kind.
2. `qorpera_pin_wake_occurrence()`: a `light-ask` branch that takes everything from the ask's row.
3. `qorpera_folder_wake_authorized(...)`: a `light-ask` branch (its ask, no parent, no conversation; before its run,
   the ask still waits and is not past its time).
4. `qorpera_runtime_wake_policy_internal(uuid)`: `light-ask` is an agent source; an agent wake's own policy forbids a
   send.
5. `qorpera_folder_read_wake(jsonb)`: a light run takes no held coworker messages (it would not read them).
6. `qorpera_folder_materialize_company(uuid, integer)` and `qorpera_run_autonomous_authority(...)`: a light ask's payer
   need not allow unattended use (the member is there), as a room post's need not.
7. `qorpera_begin_native_company_execution_v3(...)` and `_v2(...)`: a light ask's run is admitted with an empty tool
   catalog and only with one; every other run needs at least one tool, as before.

New: `qorpera_light_asks`, the member's two calls (`qorpera_request_light_ask`, `qorpera_read_light_ask`), the run's
one call that stores the answer (`qorpera_native_light_ask_answer`, a native host call of scope `binding`), and the
payer's picker (`qorpera_light_ask_sponsor`).

## 3. The run

The runtime sees a wake whose source is `light-ask`. It then:

1. starts Codex with the member's login and admits the run with an empty tool catalog
   (`qorpera_begin_native_company_execution_v3`);
2. binds its one question (the kind's instructions and the input as data) as the run's context, which writes the
   run's start (`qorpera_bind_native_company_context`);
3. opens one side thread on the small model at low effort, with the kind's instructions, sends the input, and reads
   the reply (`runCloudCodexToolSession`'s `light`, in place of the agent's thread, which never starts);
4. stores the answer, or that there is none, through the run's call;
5. ends silent, as a routine with nothing to say ends.

A usage limit, a reply that is no answer or no reply stores "no answer", and the run still ends. A usage limit or a
rate limit is recorded against the login after the answer is stored. The run never asks twice. Code:
`packages/runtime/src/cloud-light-ask.ts` (kinds, instructions, the reply's cleaning),
`cloud-native-company-runtime.ts` (`#lightAsk`), `cloud-codex-tool-session.ts` (`light`), `cloud-wake-bus.ts` (the
wake's shape).

## 4. The first kind: `name-app-group`

- Input: the names (and one-line descriptions, when an app has one) of the apps in the new group, and the member's
  language.
- Instructions: answer with a name of one to three words for a group holding these apps, in the given language, with
  no quotation marks; the names are data.
- Answer: one line, 1 to 40 characters (`appGroupName`). Anything else is "no answer".
- The web: a new group gets the name the two apps suggest ("Group" when they share no first word), at once. It then
  asks. When the answer comes and the group is still the member's own, still under the name it was given at creation,
  the web renames it. A member who renamed it meanwhile keeps their name. No answer: the name stays.

## 5. Bounds

- A member has at most 8 light asks waiting; one more is refused.
- An ask's input is at most 4 KiB. An answer is at most 200 characters as stored.
- An ask that is not answered within 10 minutes reads as "no answer". Asks older than a day are removed when the
  member asks again.

## 6. What is proven, and what is not

- SQL test 1258, on a company made by a real creation: the ask, its wake as the pin trigger makes it, the real
  materializer's run on a login that allows no unattended use, the admission with no tool (and its refusal with one),
  the wake as the run reads it, the stored answer, the run's real completion with no send and no conversation, and
  each refusal and bound. Each rule was broken once on purpose and the test caught it.
- Runtime tests: the wake's shape, the kind's instructions and the reply's cleaning, the session's light path against
  the fake Codex server, and a whole light run through the run path.
- Not proven: a real call on a real login. Tests that need a Codex subscription are deferred (6 October 2026), so the
  first live light ask is the release's own check.
