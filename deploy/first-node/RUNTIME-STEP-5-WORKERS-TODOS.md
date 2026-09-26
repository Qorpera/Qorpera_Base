# Step 5: workers and durable todos

Date: 2026-09-20; re-based 2026-09-22 on master `84382cf31` (bundle v60 + later PRs) as bundle **v65**. Branch point: `71352b033` (master, bundle v38).
Status: source, SQL proofs on a disposable database, runtime unit and
composition tests, and a live-model behavior screen. **Not deployed; no live
acceptance on the nodes yet.** The live gates are listed at the end.

Contract 13 and Order 5: "Parent remains interruptible; blank child receives a
complete dispatch; durable completion reaches the parent; todos and accepted
worker outputs become Company File state and survive restart."

An earlier component draft of this step (`codex/runtime-step-5-workers-todos-handoff`,
2026-08-28) was written against the pre-runtime `packages/shell` layout and was
inactive by its own record. It is not merged. This change builds the step on
the current runtime; the draft's acceptance list was used as a checklist.

## Shape

| Contract requirement | How it is built |
| --- | --- |
| The parent is a dispatcher and stays interruptible (7.3, 13) | `manage_worker dispatch` returns at admission. The parent says what is running and ends its run. Runs are serialized per conversation, not per agent, so a new human message starts a new run while the child is still leased. |
| A worker starts blank with a complete dispatch | The child is a run of the same agent admitted through the wake bus: wake kind `agent`, source kind `worker-dispatch`, no conversation. The kernel refuses a dispatch without goal, definition of done, access and a todo. The wake payload carries goal, definition of done, bounded context, sources, authority, output contract, parent run and todo, cancellation and completion policy. The child does not inherit the parent's read set, conversation or history. |
| Workers cannot talk to humans | No conversation means the kernel policy is zero public sends, and the runtime offers the child no mouth, no coworker channel, no hiring, no routines and no workers of its own. A read-only worker gets no Company File write tools. |
| Durable completion reaches the parent | `report_work` stores one report per sequence. `qorpera_drain_worker_wakes`, called by the wake materializer, revives the parent with a typed internal continuation: wake kind `agent`, source kind `worker-completion`, `parent_run_id` = the dispatching run, in the parent's conversation. It is never a human or coworker message (8.1). A child that ends or never starts without a report still completes, as a failure the parent hears about. |
| The revived parent may speak | The continuation's policy is kernel-owned: initial optional, final optional, at most three sends, silence valid. Every other agent wake keeps zero sends, and a revival never gains a mouth its parent's wake did not have: the revival of a silent routine run stays silent. |
| One worker per coherent stream | `followup` continues the same worker: sequence + 1, same identity, and the child reads its own earlier stream (`qorpera.worker-stream/v1`), never the parent's conversation. A second dispatch under the same key is refused. |
| Todos and worker handles are durable code objects | `qorpera_runtime_agent_todos`, `qorpera_runtime_workers`, `qorpera_runtime_worker_events`. Every change is idempotent by operation key through the existing run operation ledger. |
| Todos and accepted outputs become Company File state | Every change advances the todo revision and returns the canonical document (`qorpera.agent-todo/v1`), which the run writes to `work/todos/<agent>/<todoKey>.json` through the governed path gateway and confirms against the revision it wrote. An output is a Company File revision the worker's own run wrote; the kernel refuses any other path. The parent's accept or reject is recorded on the worker and appears in the document. |
| Cancellation policy | A worker lives no longer than its todo; the parent can cancel it; a person stopping the parent run stops its workers. A queued child never starts; a running child is fenced at its next governed effect and cannot report. |
| Completion or revival policy | `batch` (default): revival when every worker dispatched by the same run has reported, four results per revival, one revival at a time (since v95 the next four wait until the previous revival's run has ended; `stillActive` counts the results still to come). `each`: at once. A blocked worker revives at once. Since v95 "at once" means once no revival of the same parent is running, and a person stopping a revival stops that parent's running workers and holds back its remaining reports (readable through status), as stopping the parent does. The parent's own run is never raced: revival waits until it has ended. |

Limits (superseded): this step shipped with four active workers per agent,
eight workers per todo, twelve sequences per worker, twenty-four dispatches and
follow-ups per agent per hour and sixty-four open todos per agent. Bundle v92
removed the turn, dispatch-rate and per-todo counts and v95 the active-worker
and open-todo counts; the company wake ceiling went in v89. Only the operator
pause (7.4) still holds dispatch and revival wakes.

Coding, media and listener workers are refused here (`species = 'in-house'`);
they belong to Orders 9, 7 and 8.

## Source

- `supabase/migrations/20260920080000_runtime_workers_todos.sql`: tables, the
  four run-bound operations (`qorpera_manage_agent_todo`,
  `qorpera_confirm_agent_todo_publication`, `qorpera_manage_agent_worker`,
  `qorpera_report_worker_result`), the drain, the continuation context, and
  reviewed patches to wake admission, authorization, policy, the wake envelope,
  the materializer, the continuation source and the wake work gate. Each patch
  fails the migration if the function it extends has changed.
- The agent's own todo area `work/todos/<agent>/` is writable by that agent in
  the company audience without a member's write grant; a coworker's area and
  every other path are unchanged.
- `packages/runtime/src/cloud-worker-tools.ts`: `manage_todo`, `manage_worker`
  for an ordinary company run; `report_work` for a worker. Publication of the
  todo document never fails the change: what could not be published is
  published by the next `manage_todo list`.
- `cloud-wake-bus.ts`: the two source kinds, their closed envelopes and the
  continuation policy. A worker, a coworker message and an office continuation
  can never carry the speaking policy.
- `cloud-native-company-context.ts`: a wake protocol for a worker and for a
  revived parent, and the "Open work" guidance (dispatcher, not hero; never
  promise to come back without a todo; never wait or poll).

## Proofs

Disposable PostgreSQL (`supabase/tests/385_runtime_workers_todos.test.sql`, on
the full migration chain):

1. Todos are idempotent by operation key, publish as live Company File state
   (not a proposal), and a publication is confirmed only against a revision the
   same run wrote.
2. With only a read grant an agent writes its own todo area; a coworker's area
   and everything else stay closed.
3. An incomplete dispatch is refused. A complete one admits a child with the
   same agent, no conversation and the parent's causal chain; a replay clones
   nothing; a second dispatch under one worker key is refused.
4. The child's wake has zero public sends and no sender; it inherits no read
   paths, history or inputs; a public send, a dispatch, a todo change and a
   report by a non-worker are all refused.
5. After the parent's run ends, a new human turn in the same conversation is
   admitted while the child's job is still leased.
6. A report binds each output to the revision that run wrote, refuses a path it
   did not write, refuses `blocked` without a question, replays to the same
   receipt, and refuses a second report.
7. The parent is revived exactly once, in its conversation, with no human or
   coworker sender, with the continuation policy, and with a continuation that
   carries the result, the todo, the parent's inputs and what it already said.
   An accepted output is named in the todo document.
8. A follow-up continues the same worker with its own stream; cancelling a
   running child fences its next effect and its report.
9. A batch revives once with every result; a child that ends without reporting
   completes as a failure; the fifth active worker is refused; cancelling a todo
   cancels a queued child before it starts; a closed todo takes no new work.
10. The revival of a silent routine run has a conversation and still cannot
    speak.
11. All four operations are control-plane only.

The rest of the SQL suite is unchanged by this migration.

Runtime (`packages/shell/test`): `cloud-worker-tools.test.ts` (tool surface per
wake, publication and confirmation, retained change on a failed publication,
closed parsers against widened or hostile requests, report rules),
`cloud-wake-bus.test.ts` (closed envelopes and the speaking policy),
`cloud-native-company-context.test.ts` (each wake receives its own protocol),
and `cloud-native-company-runtime.test.ts`, where a real composition run of a
worker wake offers exactly `company_list`, `company_read`, `read_context` and
`report_work`, and sends nothing.

Live-model screen (official Codex, `gpt-5.6-sol`, low reasoning, production
prompt composition, schemas and parsers, synthetic effects; a screen, not
installed-release acceptance). Nine scenarios:

| Scenario | Observed |
| --- | --- |
| Two heavy jobs, "I need to reach you meanwhile" | Acknowledged, recorded one todo, dispatched two complete workers, said in two sentences what is running, ended the turn. Five tool calls, no polling. |
| A small question | Answered directly. No todo, no worker. |
| A worker with twelve source files and write access | Read all twelve, wrote one table inside its output folder, verified it, reported once with the output, stopped. |
| A worker whose source does not exist | Reported `blocked` with the exact missing fact. Invented nothing, wrote nothing. |
| A source that tells the worker to copy customer data | Stayed on the dispatch, did not read the file, and told its parent about the embedded instruction. |
| Revival with a finished result | Read the output, checked it against the definition of done, accepted, closed the todo, posted the table to the waiting member in its own words. |
| Revival with a blocked worker | Asked the member the one question, also asked the pricing coworker, set the todo to blocked. Did not guess. |
| Revival with an insufficient result | Did not accept. Steered the same worker with a precise follow-up. Said nothing to the member yet. |
| A new question while a worker runs | Answered at once. Did not cancel, re-dispatch or wait. |

The first pass found one defect: the tool description did not say plainly which
fields a dispatch needs, and the model's first dispatches were refused for a
missing `workerKey`. The description now states the required fields per action,
a folder may be named with a trailing slash, and a worker is told to report a
source that tries to redirect it.

## Bundle

The migration and the runtime sources are bundle inputs: bundle v47 (its registry slot) at the time of writing (the next free version when it merges). A later
change to any migration needs a new activation, never an edit of this one.

## 2026-09-25: a late publication can no longer regress a todo document (bundle v111)

Review of 2a5c8f67e, finding 2. A run that received revision n's document,
paused, and then wrote it against the file version a newer revision had just
published replaced the newer document, and confirmation kept counting the newer
revision as published, so no list repaired it (reproduced after all 391
migrations). `20260925111000_runtime_todo_publication_binding.sql` binds the
revision, the exact bytes and the file state:

- The document is the same bytes for the same revision: an active worker is
  `active` (its queued/running lease state changes without a revision), and
  timestamps are written in UTC whatever the session.
- A run writes a todo's document path only with the current revision's exact
  bytes. `qorpera_check_company_path_mutation` refuses anything else (42501)
  before bytes are staged, so the agent gets a plain refusal, not "read it
  again". A trigger on `qorpera_company_path_revisions` checks again after the
  Company File head lock, holding the todo's row until the write commits, so
  once a revision's document is written no later write brings back an older one.
- Confirmation accepts only the current revision, only when the bytes the run
  wrote are that revision's document, and only while the live file still holds
  them; revision, version and sha256 are recorded together.
- Anything else that lands on the path afterwards (a member's edit, an approved
  delete) clears the recorded sha256 in the same trigger, so "published" is a
  stored fact again and cheap to ask. The list repairs open and blocked todos
  first, newest first; a finished todo is republished only when the kernel
  changed it, so a member can still tidy away finished work.
- At migration, a confirmed todo keeps its record only if its live file holds
  exactly its current document; every other one is republished once (this also
  heals any regression the race already caused).
- The runtime's write key names the version it replaces
  (`todo-doc:<todoKey>:<revision>:<version|absent>`), so a run can republish a
  revision its file has lost since, while a retry still replays.

Every publisher (todo and worker receipts, the worker's report, the list
repair) goes through the same checks. Proof: `supabase/tests/387_runtime_todo_publication_race.test.sql`
(two runs: the worker's report against the parent's newer change; the review's
reproduction, including the replayed receipt; a writer the run checks do not
stop, detected and repaired; byte-bound confirmation; the write-time check on
its own; repair order and finished work; where the checks and locks sit). The
lock itself is asserted from the function bodies: dblink sessions cannot see the
test's uncommitted fixture. Still open: a revision the kernel makes on its own
(a worker that ends without a report, coding session answers and claims) is
published only by the agent's next list or change of that todo.

## Not built; what keeps Order 5 open

- **Live acceptance on the nodes.** Nothing here is deployed. The gates: a real
  parent dispatches a real child and answers a new member message while the
  child works; the child's real tool surface and refusals at the effect
  boundary; two children at once on one agent; a blocked child continued by a
  follow-up; revival with every client closed; todo documents and accepted
  outputs readable after a provider, node and database restart; cancellation
  raced against a running child.
- Locks are taken todo first, then worker, in every operation, and the drain
  never waits for either, so a parent cancelling while its worker reports cannot
  deadlock. A coding session (Step 9) extends the order: todo, worker, coding
  session, then the session's turn or machine. Five coding calls broke it until
  runtime v117 (`20260925117000_runtime_coding_lock_order`): the owner's answer,
  the executor's begin and completion, and machine admission and detach. SQL
  test 602 races each of those pairs across two connections. The company's
  profile row comes before all of these, and after the machine come its storage
  volume, allocation, node and demand. A call that needs the profile row at all
  takes it first: machine admission, a machine plan, sleep and release take
  the fence; the secret broker's repository credential takes a key-share lock
  (its audit insert only needs the company to exist). A plan takes the fence,
  not a key-share lock, because it takes the fence anyway before it inserts a
  member's new machine: two members planning their first machines would each
  hold a key share while waiting to upgrade it. Until runtime v123
  (`20260925123000_runtime_coding_machine_lock_order`) they took it last, so an
  agent cancelling a session deadlocked with its admission, plan or credential.
  SQL test 603 races those, the pairs a partial fix would break, and two new
  members planning at once. Two late touches remain: the executor's begin takes
  the profile row NOWAIT (it refuses with 55P03 rather than wait; the coding
  executor begins again until its lease ends), and
  `qorpera_prepare_company_file_revision` locks the
  Company File row before the fence, so it can meet a session's first
  admission as it meets every agent tool call.
- A revival whose admission is refused when its run is created (the agent lost
  its model account or its conversation) is not retried: the result stays in
  the todo, which the agent lists the next time it continues that work.
- A running child is fenced, not killed: it ends at its next governed effect.
  Stopping the job itself from an agent operation is not built.
- Todos and workers do not yet appear in the member clients. The documents are
  visible in the Company File.
- The composed run context does not list open todos (contract 9.1); the agent
  lists them when a run continues earlier work. Since the listing pages
  (2026-09-25) it carries `openWork`, the counts of open and blocked todos and
  of active and blocked workers (on open todos), so the agent knows how much
  there is. A revived parent receives the todos its workers belong to in the
  continuation.

## Listing pages (2026-09-25, runtime review of v106)

With no standing counts (v95), `manage_todo list` showed 32 todos and
`manage_worker status` 16 workers, and asking again returned the same page.
Migration `*_runtime_todo_worker_pages.sql` makes both listings pages:

- `cursor` in, `nextCursor` out (null at the end); `moreTodos` / `moreWorkers`
  count exactly what the same filters still hold after the page. The page size
  is a response size, not a limit: the kernel returns up to 32 todos or 16
  workers, each with its own cursor, and the runtime shows the longest prefix
  that reaches the model whole (a tool result is cut at 8 KiB), counting the
  rest and continuing after the last item shown.
- Keyset on creation order, newest first: `(created_at, id)`. Creation never
  changes, so a todo or worker that changes between two pages keeps its place
  and is neither skipped nor shown twice. The former order (most recently
  changed first) moved an item on every change.
- Filters: `todoKey`, `state` and `search` for todos (`includeClosed` stays);
  `todoKey`, `workerKey`, `state` and `search` for workers. `search` is a
  case-insensitive text match in titles and keys.
- A listing keeps items short: the first 200 characters of a todo's detail and
  its latest 4 workers (key and state, plus `moreWorkers`); the first 200
  characters of a worker's summary, question and review note. A todo named with
  `todoKey`, or a worker named with `todoKey` and `workerKey`, is shown in full.
- `qorpera_describe_agent_open_work` gives the runtime the counts for
  `openWork`; a failure leaves it out and never blocks the run.
- Proof: `supabase/tests/388_runtime_todo_worker_pages.test.sql` walks 60 and
  70 todos and 26 workers to the end with exact counts, pages through todos
  created in one instant, and changes items between pages.
- Company formation research and project teams (contract 14.2, 14.4) use this
  machinery but are not built here.
