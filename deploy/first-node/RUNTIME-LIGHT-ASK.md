# Light asks

Status: design, 14 November 2026. Not built yet. Owner: the light-ask lane (branch `feat/light-ask`).

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

What it changes in existing functions, each an exact-text patch as P31's were:

1. `qorpera_wake_occurrences_source_kind_check`: one more kind.
2. `qorpera_pin_wake_occurrence()`: a `light-ask` branch that takes everything from the marker row.
3. `qorpera_folder_wake_authorized(...)`: a `light-ask` branch (its marker, no parent).
4. `qorpera_runtime_wake_policy_internal(uuid)`: an agent source that never replies.
5. `qorpera_folder_read_wake(jsonb)`: the payload is the kind and its input, from the marker row.
6. `qorpera_folder_materialize_company(uuid, integer)`: a light ask's payer need not allow unattended use (the member
   is there), as a room post's need not.

New: the marker table, the member's two RPCs (ask, read), and the run's one call that stores the answer.

## 3. The run

The runtime sees a wake whose source is `light-ask`. It then:

1. admits the run as any run (`qorpera_begin_native_company_execution_v3`);
2. starts Codex with the member's login, offers no tools, composes no context;
3. opens one side thread on the small model at low effort, with the kind's instructions, sends the input, and reads
   the reply;
4. stores the answer (or that there is none) through the run's call;
5. ends silent, as a routine with nothing to say ends.

A usage limit, a refusal or an empty reply stores "no answer". The run never retries the model by itself.

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

## 6. Open points (to settle while building, each checked against the code)

- The run has no conversation. Silent routines already run that way; every function on the run's path must take a
  null `session_id` for an agent wake too (the pin trigger, `qorpera_folder_read_wake`, completion, the memory tree).
- The lock ranks of an authenticated call that inserts a wake (`qorpera_folder_post_room_message` is the model).
- Which call stores the answer: a new native host call (`NATIVE_HOST_CALLS` is pinned) or the run's result.
- The contract: §8's five entrypoints stay five; a light ask is an agent wake with a new source. A dated amendment
  says so, and that §17's "a member's login pays only for work that member started" holds for it by construction.
- Release: it changes the runtime, so it rides a runtime release the coordinator cuts. The web part detects a cloud
  without the RPC and asks nothing.
