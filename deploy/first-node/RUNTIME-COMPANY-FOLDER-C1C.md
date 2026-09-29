# Company folder core, C1c: legacy paths and the folder core

C1c is the slice of the folder core (RUNTIME-COMPANY-FOLDER-CORE.md, §1 "One dispatch point" and §11) that decides,
for every legacy path a `folder-v2` company can reach, whether it stays unchanged, gets its own `folder-v2` branch, or
refuses. It also takes the legacy company-row locks off `folder-v2` paths, and orders member removal against runs.

The decisions come from a read-only inventory of the live schema on 2026-09-29 (all 1,477 `qorpera_*` definitions after
every migration up to master 583923c24, C1b-3a and F2-5a). Where this doc says "the inventory", it means that report.

## 1. What the inventory found

- **50 SQL functions call the legacy actor `qorpera_company_path_actor`** (core §1 said 53; three escalation
  callers were dropped in 20260920070000). For a `folder-v2` company the actor raises 55000
  (20260920030500:413-415), and that 55000 is the only refusal in front of most of them.
- **Some legacy paths had no refusal at all** for `folder-v2`:
  - **raw object reads by hash**: the object gateway's `/v1/profile-objects` GET, its read lease, and the Supabase
    Storage read policy. Their only gate is `qorpera_company_uses_path_gateway`, which is false for `folder-v2`. A
    member who can read the company could download any object, bypassing private folders, narrower resources and
    revocation (confirmed by a rollback probe). Raw uploads were admitted too;
  - the member whole-tree lane, the approval and member-command actors (after their company fence), the office
    Company File transfers, the runner broker's whole-tree lane, completion's legacy lane, and the snapshot bootstrap;
  - old writers that still wrote `folder-v2` rows directly: staff (`put_profile_staff`, `delete_profile_staff`),
    provider models, the Co-Founder seed and todo publication confirmations (F2 found the staff writers while building
    F2-1);
  - raw uploads straight into Supabase Storage: its insert policy admits any member with write access, and a trigger
    records the object under the hash in its name without checking the bytes;
  - the runner's revision lane (a run's snapshot, its object graph and verification), marked "refuse".
- **A null `path_gateway_version` reads as "an old snapshot company"** in at least twelve functions (the context-send
  trigger, completion, the runner broker, `member_company_file_mode`, the bootstrap, attachments), while offices
  require it to be 1, so the Company Computer cannot start for `folder-v2` yet.
- **Every runtime tool call locks the whole company:** `qorpera_native_tool_locked_run` takes the job `FOR UPDATE`
  three times, the company row `FOR UPDATE` (the gc fence) and staff, room and routine rows `FOR SHARE NOWAIT`, out of
  rank order. The wake pin trigger takes the company row `FOR UPDATE NOWAIT` on every wake insert.
- **Member removal takes the member's jobs last** (the provider-connection cascade ends the member's paid runs after
  the member row), so it deadlocks with a run's commit or release, which takes the job first.

## 2. The legacy actor keeps refusing

The worst trap is failing open: if the legacy actor ever returned an actor for `folder-v2`, every caller that has not
been given its own branch would run snapshot-v1 code against a `folder-v2` company. The worst case is the native
object download, which would become a raw read by hash.

So **`qorpera_company_path_actor` refuses `folder-v2` for good.** The callers that need a run actor for `folder-v2`
(the "unchanged" and "branches" callers below) move to a new entry point in C1c-2, one caller at a time, each with a
test. A caller left alone stays refused. Paths that never went through the actor get their own explicit refusal
(C1c-1).

## 3. Decisions for the 50 actor callers

- **Refuses (33):** they touch snapshots, revisions, legacy path entries, proposals or member commands, or write
  company state as rows. They stay refused through the actor. `folder-v2` has a replacement for each:
  - read, list, resources and grants: `qorpera_read_company_path`, `_list_company_paths`, `_set_company_path_resource`,
    `_grant_company_path`, `_revoke_company_path` → `qorpera_folder_read`, `_list`, `_set_resource`, `_grant`,
    `_revoke`;
  - mutations and file writes: `check_`, `prepare_`, `commit_company_path_mutation`, `native_company_file_write_source`,
    `native_company_file_write` → `qorpera_folder_commit`;
  - the model's reads and their confirmation: `read_company_path_v2`, `list_company_paths_v2`,
    `confirm_company_path_read` → `qorpera_folder_read` and `qorpera_folder_record_release`;
  - proposals and member commands (`review_`, `get_`, `list_company_path_proposal(s)`,
    `describe_member_company_path_proposal`, `begin_`, `get_`, `list_`, `review_member_company_path_command(s)`,
    `begin_member_company_path_intent`, `begin_member_company_file_upload`, `authorize_member_company_path_object`) →
    member commits and C2's parked proposals, C1d's upload intents and byte check;
  - the snapshot browser (`list_member_company_snapshot_paths`, `read_member_company_snapshot_path`,
    `authorize_member_company_snapshot_object`) → the journal and history views (C4);
  - the dead v1 execution start (`begin_native_company_execution`);
  - row writers of company state (contract 5.6): `manage_agent_routine`, `manage_agent_todo`, `manage_agent_sidebar`
    → routine, todo and section files (F2); `manage_agent_worker` and `report_worker_result` until C3 and F2-5b make
    worker briefs and results files.
- **Branches (12), in C1c-2:**
  - the send and model-request checks: the context-send trigger (`enforce_company_context_send`), which today
    returns early for `folder-v2`; `assert_company_path_reads`; `record_native_context_view` (bound to release ids
    and read records); `send_coworker_message` (the parent read-set check of C1b-2 §4);
  - turn start and end: `read_native_wake` (journal file wakes, the parent's folder read set, `companySeq`),
    `complete_runner_job_v6` (a `folder-v2` lane: job first, the run check, the recheck, receipts checked against
    folder commits), `describe_company_run_context` (the company name from the folder index);
  - presence: `company_presence_scope`, `native_presence_subject` (folder resources instead of the legacy resolver);
  - `native_company_object_actor` (the run actor for office captures; its two object callers refuse, §4),
    `member_file_export_source` (no company fence), and `add_agent_review_rule`: an agent's own "Ask first" rule
    stays a row (core §1), so it must work for `folder-v2`, and today it refuses.
- **Unchanged (5):** `begin_native_company_execution_v2`, `read_company_run_context`, `native_presence_register`,
  `list_member_file_exports`, `describe_agent_open_work`. They need no body change once the shared helpers under them
  (`native_tool_locked_run`, the new entry point, `assert_context`) have their `folder-v2` branches.

## 4. C1c-1: explicit refusals (this slice)

Migration 20260928259430. Every guard is false for snapshot-v1 companies, and sits at the start of the function,
before any lock. The error is 0A000, "This Company File path does not serve folder-v2 companies".

- **Raw objects.** A member's raw download refuses `folder-v2`, and so does the read lease, which calls the same
  check; trusted services keep theirs until C1d. Raw uploads refuse `folder-v2` (C1d's upload intents replace them).
  The native object download and upload refuse, whatever the binding. The Storage read and insert policies exclude
  `folder-v2` objects. A member reads and writes `folder-v2` bytes only through the folder core: C1d's byte check and
  upload intents.
- **The member whole-tree lane:** `prepare_` and `publish_company_file_revision`, `prepare_company_file_proposal`,
  `submit_` and `rebase_company_proposal`. The v149 activation guard only checks that their text still contains the
  company fence, which it does.
- **The approval and member-command actors** (`company_path_approved_actor`, `member_company_path_command_actor`)
  refuse before their company fence.
- **The office's Company File transfers** (`native_office_company_file_source`, `confirm_office_company_file_import`):
  the folder views replace them (C1b-3). The binding names no company, so the guard reads the run's job.
- **The runner broker's whole-tree lane** (`runner_broker_describe`, `runner_broker_authorize_input_object`),
  **completion's legacy lane** (`complete_runner_job_v6`) and **the runner's revision lane**
  (`runner_prepare_company_revision`, `runner_begin_`, `_append_` and `_complete_company_revision_graph`,
  `runner_company_revision_snapshot`, `runner_authorize_` and `_finalize_company_revision_verification`,
  `runner_broker_authorize_company_file_object`). No `folder-v2` run can exist yet (the materializer requires a head).
  C1c-2c **replaces** v6's guard with the `folder-v2` completion lane; it does not add a lane behind it. The describe
  and input-object refusals stay until C3 (§5.8). The runner broker maps 0A000 to 503, so a runner would retry a refused
  `folder-v2` job until its lease ends; none can exist before C1c-2.
- **The snapshot bootstrap:** the worker no longer claims a `folder-v2` company's job, so one job left from before a
  company became `folder-v2` cannot hold the queue; finalizing one refuses; the Co-Founder seed refuses. A `folder-v2`
  company is created by one commit (C2).
- **The legacy pause** refuses: `folder-v2` companies stop through `qorpera_folder_pause`, which drains effects.
- **Old row writers:** `put_profile_staff`, `delete_profile_staff`, `put_staff_provider_model`,
  `confirm_agent_todo_publication`. The binding check reads the run's job, and reads the job id as the run lookup
  does (any spelling uuid input accepts).
- **Left as they are, on purpose:**
  - `upsert_cloud_routine`: F2-6 (#523) decides its `folder-v2` rule. It refuses new routines, but still accepts saves
    of routines that existed as rows before the company became `folder-v2` (test 708);
  - the roster's default-grant trigger (`ensure_default_agent_read_grants`): `folder-v2` agents need its grant on the
    company-shared root to read and write there (test 632 fails without it). F2's concern is how it is written:
    outside the authority journal and after the commit's rank-6 and rank-7 locks. The grant is a widening, so the
    authority check does not need a journal row for it. Writing it through the folder's grant path, in the commit
    that creates the agent, belongs to C2 (creation) and C1c-3 (lock order);
  - `verify_company_path_file` and `_tree`: service-role functions that register uploaded bytes; the folder core has
    no other way to get them until C1d's byte check replaces them. Members have no upload path for `folder-v2` at all
    until C1d's upload intents;
  - `answer_action_review`'s "Always allow", which F2-4 accepts until C3 writes the rule file;
  - `member_company_file_mode`, which still reports `legacy` for `folder-v2` until the web client's branch (C4);
  - `qorpera_company_uses_path_gateway`: the web's Company File page reads it, so its meaning stays; the object
    paths check the core themselves;
  - a snapshot bootstrap job left from before a company became `folder-v2` stays queued (and the company stays hidden
    if the job set `hidden_until_ready`) until C2's creation replaces the old chain.

**Test 646** calls every guarded function on a `folder-v2` company and expects 0A000, with a snapshot-v1 control
for each that must not be refused (the Storage policies and the bootstrap claim included). Each guard was removed in
turn: the test failed for 31 of 34. The other three (`runner_begin_company_revision_graph`, `runner_authorize_` and
`_finalize_company_revision_verification`) call `runner_company_revision_snapshot` first, whose own guard refuses;
they keep theirs in case that call moves.

## 5. C1c-2: run paths on the folder fence

C1c-2 lets a `folder-v2` run make tool calls, send, record its context, start and finish, on the folder core's locks
instead of the company row. The design comes from a second read-only inventory (2026-09-29, 1,468 live definitions)
and one design review round, whose findings are folded in.

### 5.1 What today's run check does, and why it cannot simply move to `KEY SHARE`

`qorpera_native_tool_locked_run` (NTLR) runs under every runtime tool call: 29 SQL callers, plus 21 through
`qorpera_describe_native_tool_authority`. Each call takes:
- the job `FOR UPDATE` three times: its own lock, the lease validation's, and `runner_broker_locked_job`'s;
- the company row `FOR UPDATE` and the legacy admission fence, through the gc fence in the lease validation;
- the routine, staff and room rows `FOR SHARE NOWAIT`, out of rank order, in `wake_authorized`.

Two facts shape the `folder-v2` version:
- **Nested job locks.** With the job at `KEY SHARE`, every legacy helper that later takes the job `FOR UPDATE` becomes
  a lock upgrade, and two effects of one run would deadlock. The sites:
  - receipt begin and complete: `begin_`/`complete_native_tool_operation` and the runner broker's direct
    `begin_`/`complete_run_operation_receipt`;
  - the transcript append;
  - both send functions and the interaction request;
  - the lease validation.

  The `folder-v2` paths never call them. Until C1c-2b replaces them, C1c-2a makes them refuse `folder-v2` (§5.9).
- **The job lock is today's per-run mutual exclusion.** Several callers check, then write, relying on it:
  - receipt begin: "one unresolved operation", which has no unique index;
  - the send: its public-send budget, acknowledgement counts and "already final" check;
  - `begin_native_company_execution_v2`: reconciliation, then the launch upsert;
  - `record_native_context_view`: ordinal and replay, whose unique keys would turn a race into 23505;
  - `record_action_review`;
  - `add_agent_review_rule`, which serializes on the company row.

### 5.2 The run mutex

The run's budget row, `qorpera_execution_run_budgets` (primary key `run_id`, one per run), taken `FOR UPDATE`
**before the job**, as a commit claims its operation key before the job (core §3 step 1).
- **Who touches that row.** Only four functions, all same-run effects:
  - the transcript append;
  - receipt begin (through `begin_native_tool_operation`, or directly from the runner broker);
  - the runner's file object check;
  - the reservation that inserts the row.

  The table has no triggers and no policies. No lease-ending path (completion, requeue, cancel, handoff, re-claim)
  touches it, and neither does renewal. On a `folder-v2` path, every function that would take the job and then that
  row is dispatched to a folder body or refused (§5.4). An activation check keeps it so (§6).
  `purge_company` locks jobs, then budgets, but it runs only after the stop, which refuses tool calls first.
- **Why before the job.** A tool call that arrives while completion holds the job takes the mutex, then waits at the
  job; once completion commits, it finds the run ended and refuses. PostgreSQL grants a new shared locker while an
  exclusive one waits, so without the mutex overlapping tool calls could hold the job `KEY SHARE` without a gap and
  starve completion (and renewal). With it, a second tool call of the run waits at the mutex, never beside the first
  at the job: at most one tool call holds the job at a time. When that call commits, a waiting completion or renewal
  and the next tool call race for the job row. The waiter usually wins, since it only re-reads the row while the next
  call first takes the mutex and runs its checks; at worst it waits for that one call, and it meets the same race,
  with the same head start, at each hand-off. That bound holds per hand-off, not over many: strict first-come order
  would need completion and renewal to take the mutex too, which they do not (test 648 C). The run's own commits,
  releases and views also hold the job `KEY SHARE`, without the mutex, so a waiting completion or renewal waits for
  those too; they are short and never queue behind each other at the job.
- A run without its budget row refuses (42501).
- Folder commits and releases do not take it: disjoint saves of one run stay parallel.

### 5.3 New functions

All are postgres-only, like NTLR (the runtime reaches them through the dispatching legacy functions). Names stay
within 63 characters.

- **`qorpera_folder_tool_run(p_binding jsonb, p_targets jsonb)`**, the `folder-v2` NTLR. The steps, in order:
  1. NTLR's own checks:
     - the host authority;
     - the binding's ten keys and their types;
     - provider `openai` and harness `codex-cli`;
     - later, the run's model match and `required_capability`;
  2. the stop check (§5.5), as a plain read;
  3. the run mutex;
  4. `qorpera_folder_run_enter` with the caller's targets:
     - the job `KEY SHARE`;
     - the fence `KEY SHARE`, with the stop re-read;
     - **rank 0 always** (this company's row, `KEY SHARE`);
     - then ranks 1 to 7 (a caller's resources and grants at 6 and 7).

     Rank 0 on every tool call orders every caller that inserts a row referencing the company (action reviews,
     presence devices, usage signals), and every session lock that follows, before the members, as core §3 requires.
     It reverses C1b-3a's rule that the company row is not taken unconditionally (its starvation point). That is safe
     while the legacy company-row `FOR UPDATE` paths are closed to `folder-v2` (§5.8) and no real `folder-v2` company
     exists; C1c-3 revisits it once those paths take the fence instead. C1e's load test counts the company row's
     multixacts.
  5. `qorpera_folder_native_lease_current`: a plain check of the native lease tuple (lease against run, job, runner,
     assignment, capsule and identity), the runner's recovery epoch, lease and assignment expiry, the connection,
     capsule and policy, and sponsor availability, plus the existing plain `qorpera_runner_broker_job`. The save check
     (C1B §2) leaves the lease and the sponsor out; model-facing tool calls keep them. It is built from the live
     legacy check with its three `FOR SHARE` removed, so the two cannot drift. One lock stays inside it, as in the
     legacy check: for a wake run, sponsor availability asks `qorpera_provider_autonomous_authority`, which takes the
     provider connection `FOR SHARE`. It comes after the company row and the job, the legacy order.

     One caller makes that lock stronger: F2-1b's `qorpera_prepare_routine_login` runs the run check and may then
     take the requester's login `FOR UPDATE` in `qorpera_ensure_unattended_sponsor`. When that login is the wake
     run's own sponsor connection, the transaction goes from `FOR SHARE` to `FOR UPDATE` on one row. Legacy had the
     same upgrade, but its gc fence made two such calls in one company take turns. On `folder-v2` two routine runs
     setting up the same login can meet with 40P01, which F2's writer retries. This is the only such upgrade the
     C1c-2a sweep found (every run-check caller, depth 4, with #534 applied). F2-1b owns it; C1c-3's activation check
     lists it as a known exception until it is removed.

  It returns the resolved run actor and the run row. The binding's ids are normalized (`::uuid::text`).
- **`qorpera_folder_run_enter(env, profile, actor, p_targets jsonb)`**, a four-argument overload with no default, so
  the three-argument calls stay unambiguous. It merges the caller's targets into the run's own, validated as C1b-3a's
  commit validates them:
  - rank 0 is only this company's row, `KEY SHARE`;
  - ranks 6 and 7 are `KEY SHARE` only;
  - the stronger mode wins.

  It locks them in rank order, ranks 0 to 7; vault rows and unique-key claims (8, 9) stay the commit's. The
  three-argument entry is this one with no caller targets.
- **`qorpera_company_run_actor(env, p_binding)`**, the new entry point. It takes none of the run check's locks. For
  a wake run, its lease check still takes the provider connection `FOR SHARE` (step 5's one lock), a single shared
  lock with nothing held before it.
  - snapshot-v1: it returns `qorpera_company_path_actor(...)` unchanged;
  - `folder-v2`, run: `qorpera_folder_run_resolve`, a plain resolve. It returns the legacy field names callers read
    (`companyId`, `environmentId`, `userId`, `staffAgentId`, `runId`, `jobId`, `assignmentId`, `audience`,
    `audienceUserId`, `sponsorBindingId`, `sponsorVersion`, `runtimeBundleId`), plus `core: 'folder-v2'` and
    `folder: {actor, resolved}`;
  - `folder-v2`, member: a plain membership read.

  Callers that need locks run `folder_tool_run` first, and presence stays lock-free (core §6).
- **The `assert_context` dispatch.** It decides by **the company's core**, looked up from the actor's environment, not
  by a field of the actor. For `folder-v2` it calls `qorpera_folder_run_reads_current` at rank 10, and refuses (42501)
  an actor that carries no folder run actor. It never falls through to the legacy loop: a `folder-v2` run has no rows in
  `company_run_read_paths`, so that loop would pass vacuously.
- The send family, the receipts, the card path, the completion lane and the wake admission (§5.6).

### 5.4 Dispatch on core

As in C1c-1, a line inserted at the start of each function sends `folder-v2` to its new body. The snapshot-v1 text
after that line stays byte-identical, and its digest is checked at migration time.

| Function | `folder-v2` | Slice |
| --- | --- | --- |
| `native_tool_locked_run` (its callers include F2-1b's `qorpera_prepare_routine_login`) | `folder_tool_run(binding, '[]')`, returning the run row | 2a |
| `validate_native_provider_execution_lease` (also called directly by the runtime) | `folder_native_lease_current` plus the stop check | 2a |
| `run_wake_authorized`, and `wake_authorized` itself (the materializer calls it directly; its agent branch passes vacuously on `folder-v2`) | `wake_authorized` dispatches to `folder_wake_authorized`; `run_wake_authorized` keeps its text, calls it with the run's wake and compares the policy kind | 2a |
| `company_path_assert_context` | by the company's core: `run_reads_current`, never the loop | 2a |
| the five "unchanged" callers (§3) | a text patch: their actor call becomes `company_run_actor`; `begin_native_company_execution_v2` also takes the run mutex; the digest is of the patched text | 2a |
| the read-type branches: `describe_company_run_context` (company name from `qorpera_folder_company_index`; its session check stays `FOR SHARE`, after rank 10's recheck at the sessions rank of §5.7; and F2's folder facts: `|| case when v_folder is null then '{}' else jsonb_build_object('folder', v_folder) end`, with `v_folder := qorpera_company_state_run_folder(env, staff, <the coworker ids the body lists>)`, called by name at run time so snapshot-v1 never needs it. It is given the same ids the body puts in `coworkers` and names no others, so `folder` never names an unlisted coworker even when a roster change lands between the two statements; a coworker whose folder retired in between is left out, as one without a folder is. From F2-1b's migration 20260929440000 on #534; the runtime's closed parser checks that every coworker in `folder` is listed, and memory and skills then use `agents/<handle>`), the presence functions (a folder `presence_path_routes` on `qorpera_folder_path_resource` and `folder_actor_allowed`; a refusal is 42501, which `native_presence_subject` reads as "absent"), `native_company_object_actor`, `member_file_export_source` (no gc fence) | their `folder-v2` body | 2a |
| `native_office_start`, `_start_descriptor`, `_capture`, `_file_export`, `native_shared_file_export_source`, `self_approve_organization_proposal`, **`native_machine_start`** | refuse 0A000 until C1c-3: after the run check they take the gc fence or a legacy proposal lock. Machine start holds the machine row and then asks for the company row `FOR UPDATE`, the reverse of #419's custody order | 2a |
| `send_native_agent_message`, `send_runner_agent_message`, `append_native_interaction_request`, `append_runner_transcript_event`, `begin_`/`complete_native_tool_operation`, `begin_`/`complete_run_operation_receipt` | 2a: refuse 0A000. 2b-1: the folder receipts (`begin_`/`complete_native_tool_operation`). 2b-2: the folder native send and interaction request. The runner broker's `append_runner_transcript_event`, its send and its direct receipt calls keep refusing (C3) | 2a, 2b |
| `record_action_review` | 2a: under the mutex; its card path refuses through the transcript append. 2b: the folder card path (§5.6) | 2a, 2b |
| `assert_company_path_reads`, `record_native_context_view`, `add_agent_review_rule` | their `folder-v2` body (§5.6) | 2b |
| `enforce_company_context_send` | requires the marker the folder send sets; refuses without it | 2b |
| `pin_wake_occurrence`, `routine_occurrence_lifecycle` | their `folder-v2` modes (§5.6): text patches, each keeping the legacy statement as its `else` branch; the digest is of the patched text with the patch reversed | 2c part 1 |
| `send_coworker_message`, `read_native_wake` | their `folder-v2` bodies (§5.6), by a first line | 2c part 1 |
| the legacy multi-company loops: `materialize_wake_execution_runs`, the drains (`office_activation`, `worker`, `machine`, `company_file` with the dynamic-routine tick), `materialize_session_execution_runs` | skip `folder-v2` companies in the scan's `WHERE` clause, before their first lock. `materialize_session_turn_requests` needs no skip: its scan requires the company's head snapshot, which a `folder-v2` company never has (`qorpera_company_files_core_head`) | 2c part 1 |
| `handoff_run_sponsor`, receipt recovery | their `folder-v2` modes (§5.6, §5.9) | 2c part 2 |
| `complete_runner_job_v6` | the folder completion lane, in place of C1c-1's guard | 2c part 2 |

### 5.5 The stop check

- **Deletion already pauses.** `request_company_deletion` calls `stop_company_work`, which inserts the pause row the
  folder core reads. The exception is when the requester's account is gone: the pause row's foreign key to
  `auth.users` cannot be met.
- **So every folder function reads `qorpera_company_execution_paused`** (pauses and deletions), in C1c-2a:
  - `run_enter` and the commit;
  - `record_release` and `read_actor`;
  - C1b-3a's view functions: `folder_view_resolve`, the view inheritance, and its bodies of `read_actor`,
    `record_release` and the commit.
- **The real gap is the fence.** Deletion never drains the folder fence. It takes the gc fence (the company row
  `FOR UPDATE`), and it fails jobs with `SKIP LOCKED`, so jobs a folder effect holds at `KEY SHARE` are skipped. An
  effect that passed its post-fence re-read before the deletion committed finishes after it. C1c-3 makes deletion run
  the folder pause's second phase for `folder-v2`: the fence `FOR UPDATE` and its revision bump, with no gc fence.

### 5.6 Effects, wakes and completion

- **Sessions and the operation clock.**
  - Every session event, session state change and staff change updates one company-wide row, the operation clock
    (`qorpera_profile_operation_clocks`).
  - On snapshot-v1 the company row `FOR UPDATE` hides the ordering. On `folder-v2` nothing does: a coworker message
    that takes the clock at the pair event and then wants the recipient's thread deadlocks with the recipient's own
    send, which holds that thread and wants the clock (reproduced).
  - Creating a session, and changing its title or status, take the clock too (the session-state trigger fires on
    insert and on those updates), so the rule is about the first session **write**, not the first event:
    1. a `folder-v2` path locks every existing session it will write, `FOR UPDATE` in id order;
    2. then it creates any session that does not exist yet (a first coworker message creates the pair session;
       `ensure_agent_thread_internal` creates a missing thread);
    3. then it writes events.

    After its first session write it locks no further session. Sessions and the clock come after rank 10 and before
    admission (§5.7).
  - A folder commit's session writes come from F2's triggers: an agent's thread, and on archive its pair sessions;
    a group chat's session, on rename, reopen, or the deletion of its folder. **F2's hook names those sessions**, and
    the commit locks them at the sessions rank before it applies. The commit's target check gains that rank (sessions
    only, `FOR UPDATE`).
- **The folder send** (both send functions and the interaction request), in order:
  1. the stop check, the run mutex, the job `KEY SHARE`, the fence with the stop re-read;
  2. rank 0 (the company row: legacy posting, `answer_interaction`, `get_email_draft` and `retry_room_delivery` take it
     `FOR UPDATE` before the session), then ranks 1, 2, 4 and 5;
  3. the plain lease check;
  4. the recheck at rank 10;
  5. the session `FOR UPDATE`;
  6. the marker (bound to the run id, and cleared after the insert), then the insert, which the trigger checks, then the
     transcript append, with no broker job lock.
- **Receipts** (`qorpera_folder_begin_run_receipt`, `_complete_run_receipt`), under the run mutex, with no broker job
  lock. A receipt that "requires a company revision" is satisfied by a folder commit that carries it:
  - The commit takes an optional receipt id, part of its request digest (a retry with another receipt is another change
    set). It locks the receipt `FOR NO KEY UPDATE` as a run-owned row (§5.7) and checks that the receipt belongs to the
    commit's run, is `executing`, and requires a revision. It then writes `qorpera_folder_commits.receipt_id`, which
    gets a unique partial index: one commit per receipt.
  - `_complete_run_receipt` names the commit id. It checks that the commit exists, belongs to the run and carries this
    receipt. Whatever the units' outcomes, the commit satisfies the receipt. The run's disposition comes from the
    outcomes (below).
  - **A receipt is carried once** (decided on #548). Under the receipt lock, before the insert, a commit whose receipt
    another commit already satisfied refuses with 22023 "Run receipt is already satisfied by another commit": a caller
    defect, which clients do not retry. The unique index is only the backstop for a true race. A replay (same key,
    units and receipt) is answered first, since the receipt is part of the digest. A writer's conflict redo completes
    the first receipt with the conflicted commit, begins a new receipt (its own logical key), and commits under a new
    operation key.
  - **One commit signature.** The six-argument commit (with `p_receipt_id`, default null) replaces the five-argument
    one; PostgREST never sees both.
  - Only a run's commit carries a receipt. A view's commit (a desktop, a shell command, a coding session) is not a tool
    call and carries none.
  - The check order under the receipt lock: the run's own receipt (else 42501), then "satisfied by another commit"
    (22023, even once the receipt is completed, so a redo that reuses it is always the defect), then executing and
    requiring a revision (42501).
  - **Sessions bring rank 0.** A commit with rank 11 session targets takes this company's row at rank 0 whatever the hook
    named: its session writes insert company operations, a foreign key on the company row, and legacy posting takes the
    company row `FOR UPDATE` before the session (test 651 E).
  - The legacy `complete_native_tool_operation` names a snapshot or a proposal, never a folder commit. On `folder-v2`
    it takes neither (22023) and completes a receipt that requires no revision; a writer completes its receipt with
    its commit through `qorpera_folder_complete_run_receipt`, which the runtime calls directly.
- **`assert_company_path_reads`** (the runtime's check before every model request): `folder_tool_run`, then the
  recheck at rank 10. It ignores the path list and never writes `company_run_read_paths`: the run's releases already
  carry its reads.
- **`record_native_context_view`:** each output's `readId` is a release in `qorpera_folder_run_releases`, and its
  `readSha256` the read record's `output_sha256`, instead of `company_read_confirmations`. A release that released no
  reads has no read record, so it cannot be cited: the runtime (C3) sends `readId: null` for such an output. The run mutex orders the
  ordinal and the replay. The v149 marker stays.
- **`record_action_review`'s card** (an "ask" in a conversation) is public output: it shows the action's arguments.
  Its folder path runs:
  1. the run mutex, the job, the fence;
  2. rank 0, then the ranks;
  3. the recheck at rank 10;
  4. the session `FOR UPDATE`;
  5. the review row (a new run-owned row);
  6. the folder transcript append.

  The session comes before the review row because the row's foreign keys to the conversation (`session_id`,
  `card_session_id`) take it `KEY SHARE`: a later `FOR UPDATE` would be an upgrade, and two cards of two runs in one
  conversation deadlocked that way (2b part 2 review r1; test 653 H). An "ask" that raises no card takes no session
  lock.
- **`add_agent_review_rule`:** the requester's member row `FOR NO KEY UPDATE` at rank 1 (merged with the run's
  `KEY SHARE`, so no upgrade), plus rank 0 and the recheck. It no longer takes the company row.
- **Wakes.**
  - Every `folder-v2` inserter:
    1. takes the recipient's rows at ranks 1 to 5 (the routine `FOR NO KEY UPDATE`), and the sessions it will write;
    2. calls `qorpera_folder_admit_wakes(profile)`: the folder admission row `FOR NO KEY UPDATE`, last before the folder
       clock (core §3 step 10), and a transaction marker. It takes no fence: every inserter has taken the fence at step
       3 already (C1c-3's legacy inserters take it there too);
    3. inserts.
  - In `folder-v2` mode the pin trigger:
    - takes no lock;
    - keeps today's stop rule (an autonomous wake is cancelled, a human one refused);
    - refuses a wake without the marker, with 55000 "Folder wake admission is required".
  - `routine_occurrence_lifecycle` takes the routine `FOR NO KEY UPDATE`.
  - The legacy admission fence (`qorpera_company_wake_admission_fences`, also today's stop fence) and the folder
    admission row are different tables. `folder-v2` never touches the legacy one.
  - The legacy multi-company loops skip `folder-v2` companies before their first lock, so one company never stops the
    pass for others. The skip sits in each scan's `WHERE` clause: a skip after the select would leave those wakes at
    the head of every pass, and snapshot-v1 wakes would stop materializing. They stay legacy-only (C4).
  - As built (2c part 1, migration 20260929580000):
    - `qorpera_folder_admit_wakes(profile)` updates the admission row (its `admitted` count), which takes it `FOR NO KEY
      UPDATE`, and sets the transaction mark `qorpera.folder_wake_admission` to the company id. A company with no
      admission row (not `folder-v2`) refuses (42501).
    - The pin trigger's `folder-v2` mode: the mark instead of `serialize_wake_admission` (55000 "Folder wake admission
      is required" without it, checked first); the recipient's staff row read without `FOR SHARE`; a routine wake's
      public session from `qorpera_folder_wake_public_session`, today's choice without `FOR SHARE NOWAIT` (a commit
      changing the agent holds the staff row `FOR NO KEY UPDATE`, which `FOR SHARE` waits for, and NOWAIT turns into
      55P03). Everything else, the stop rule included, is today's text.
    - The dynamic-routine tick (`restore_dynamic_routine_runs`, inside the Company File drain) skips `folder-v2` too:
      it is routine firing, which gets its folder mode in C1c-3. The routine expiry sweep does not skip: it inserts no
      wake and takes no company row, and F2-6 relies on it for file routines (its 40P01 against a multi-routine save
      is documented there).
    - The routine scheduler (`list_routine_schedule_heads`, then `enqueue_routine_wake` per routine, which takes the gc
      fence) is routine firing too: C1c-3 moves it (§6). Until then it fails closed on `folder-v2` at the pin trigger.
    - No legacy wake inserter serves `folder-v2` after this: each lacks the mark and refuses (55000).
- **`send_coworker_message`** (`qorpera_folder_send_coworker_message`, 2c part 1):
  1. the run mutex, the job, the fence, rank 0;
  2. ranks 1 and 2 for sender and recipient, rank 3 for the recipient's authority, rank 4 for both agents' thread rooms
     (`FOR UPDATE` when a thread must be created or reopened: `ensure_agent_thread_internal` locks the room that way,
     and the target must not be strengthened later). The targets come from an unlocked read before the run check;
     after it, a thread room that exists and is not held in the mode its thread now needs refuses the message as
     a retryable conflict (QRC01, 409, "Coworker thread changed while the message waited"; test 657 C; never 40001,
     which PostgREST would retry on its own, test 361);
  3. the receipt (run-owned);
  4. the recheck, plus the parent read-set check of C1B-2 §4 (`qorpera_folder_parent_reads_allowed` on the wake the
     message would insert: every row of the run's read set is readable by the requester and the recipient);
  5. the pair lock (`pg_advisory_xact_lock` on the pair key, as `agent_pair_session_internal` takes it);
  6. the existing pair and thread sessions, `FOR UPDATE` in id order (`qorpera_folder_lock_sessions`), then any that
     must be created;
  7. the events;
  8. admission, then the wake (a priority message), or the held message (no wake, no admission).

  A replay returns the first result before the recheck. The legacy digest is kept. The chain budget's fence branch is
  kept as today's text, though `qorpera_coworker_chain` no longer returns null for any hop count.
  Archiving an agent (F2's hook: the staff row `FOR NO KEY UPDATE`, the agent's thread room `FOR UPDATE` at rank 4)
  meets the message at that room, before either writes a conversation (657 G). Removing another member meets it at
  the company row (657 E).
- **`read_native_wake`** (`qorpera_folder_read_wake`, 2c part 1):
  - the wake check comes from `run_resolve`;
  - a company-file wake refuses (C4);
  - the parent's folder read set is inherited into the run as of this call, rechecked under the run's own authority,
    idempotent per wake. As built: one read per path (the parent's latest record of it) goes through
    `qorpera_folder_release_pairs` under the run's own actor, which re-resolves any read whose grant is not this
    agent's; the reads go into the run's read set and are filed as read records under the wake's id. The first call
    that finds parent reads files them, and later calls add nothing. A parent with no folder reads files nothing, so
    a later call looks again. A worker's dispatch never inherits (today's rule). Then the recheck at rank 10;
  - no `companySnapshotId` pin. `companySeq` has no column yet (C4), and the transcript's session pin reads NULL for
    `folder-v2` today, so it is not enforced until then.
- **Completion**, the `complete_runner_job_v6` lane, in order:
  1. the job `FOR UPDATE` (the lease ends);
  2. the run's run box views `FOR UPDATE`, in id order (C1B §4's one order: job, then view);
  3. the fence, rank 0, and the ranks, with the routine `FOR NO KEY UPDATE`;
  4. the recheck;
  5. receipts matched to their commits;
  6. the provider-session owner;
  7. the job update.

  It reuses `complete_runner_job_v4`, v3 and v2 and `bind_execution_provider_session`, and never routes to
  `complete_runner_job_before_path_runtime`. The run-results check forbids `published` and `review_pending` without a
  snapshot, so run results gain a nullable `folder_commit_id`. The check then allows `published` and `review_pending`
  with exactly one of a snapshot and a folder commit (the row names no core, so the check cannot branch on it). A run
  with several commits records its last saving commit (the highest `seq`). The `folder-v2` dispositions:
  - `published` when a commit of the run saved a unit;
  - `unchanged` when its commits saved nothing;
  - `review_pending` when a unit waits for review (C2).

  As built (2c part 2, migration 20260929600000, `qorpera_folder_complete_run_job`, v6's first line in place of
  C1c-1's refusal):
  - The result is the path lane's shape (`runtime: company-path-v1`): the runtime does not name the core. A snapshot
    or artifacts refuse (22023), as on the path lane.
  - Step 3 is `qorpera_folder_run_enter` with rank 0 as a target, so this company's row comes before the requester's
    member row (the usage observation's foreign key would take it later; 659 D). A routine run's routine stays at the
    run check's `KEY SHARE`, not `FOR NO KEY UPDATE` as first planned: completion writes no routine row (the
    authorization outcome trigger acts only on materialized and cancelled wakes). Completion never takes the run
    mutex: the mutex comes before the job, and completion holds the job first. A tool call that arrives meanwhile holds the mutex, waits at the job, and refuses once the job is done
    (659 C).
  - Step 5: no reserved model request, no executing or ambiguous receipt, no job artifact (55000, as today); every
    completed receipt that requires a revision names, in `folder_commit_id`, a commit of this run whose `receipt_id`
    is that receipt (else 55000 "Governed completion omitted a folder commit receipt").
  - The disposition: `review_pending` when a unit of any commit of the run is `waiting_for_review`, naming the latest
    such commit; else `published`, naming the saving commit with the highest `seq`; else `unchanged`. A commit that
    saved nothing keeps its row with no `seq`.
  - The job's `company_file` result: `runtime: folder-v2`, the disposition, `folder_commit_id`, the native binary's
    hash and the receipts that name commits.
  - The run's run box views close with `ended`.
  - `complete_runner_job_v2` skips its source substrate lookup for a `folder-v2` job, which has none once C4 makes
    runs without substrate ids possible, and refuses artifacts there instead. Only v6 is granted to the runtime, so
    v4, v3 and v2 are reached only through a lane.
  - `qorpera_execution_run_results.folder_commit_id` restricts deletes, as `output_snapshot_id` does: the company
    purge finds a result through that key and deletes both in one statement. The new check is added `NOT VALID`
    (every existing row met the old one, which the new one only widens).
- **`handoff_run_sponsor`** refuses a run whose revision receipts have no snapshot. Its `folder-v2` mode accepts
  receipts satisfied by commits (C1c-2c part 2: one more condition, `folder_commit_id is null`, which only
  `folder-v2` receipts can fail).
- **Receipt recovery** (2c part 2). `terminalize_runner_attempt_before_native_start` needs no change: it marks
  executing receipts ambiguous on either core. `resolve_run_operation_receipt` dispatches a `folder-v2` receipt to
  `qorpera_folder_resolve_run_receipt`: `confirmed_completed` records the commit that carries the receipt (one per
  receipt) and refuses a snapshot or proposal, and a revision receipt that no commit carries cannot be confirmed
  completed (22023); `confirmed_not_run` refuses while a commit carries the receipt (55000, "A folder commit carries
  this operation: it ran").

### 5.7 Additions to core §3's order

In step 4, after rank 9:
- **run-owned rows** (receipts, action reviews, context views), then **rank 10's recheck**;
- **sessions**, every one the transaction will write, `FOR UPDATE` in id order;
- **the operation clock**, at the first session write (an insert, a title or status change, or an event).

Admission and the folder clock stay last. The **run mutex** comes after the operation key and before the job (step 2).
The **provider-session owner** is locked in completion after the recheck.

### 5.8 Moved to C3 and C4, and what stays closed

- The runner broker's describe and input-object checks. Their legacy bodies read the substrate and company snapshot,
  and the runner accepts only the two legacy runtimes (`cloud-runner-broker.ts:1042`). C1c-1's refusals stay until C3
  gives `folder-v2` runs their substrate model.
- `companySeq` pins on runs and wakes (C4's schema).
- Renewal's move to `FOR NO KEY UPDATE` stays in C3 (C1B). Until then renewal waits for the one tool call in flight.
- Office-activation and machine-event runs make no tool call: `run_resolve` refuses them (0A000), as offices refuse
  `folder-v2` today.
- **After C1c-2c, legacy wake inserters fail closed on `folder-v2`.** Posting, `answer_interaction`,
  `answer_action_review`, `retry_room_delivery`, routine firing and coding turns stay closed until C1c-3 gives them
  folder modes. So no real `folder-v2` company is created before C1c-3.

### 5.9 Split and tests

Three PRs, in order. Each needs C1b-3a (#497) and C1c-1 (#532) on master first; C1c-2a also needs F2-1b (#534),
whose helper the run context calls. Their migrations sort after `20260929440000` and after #419's patches of the wake
functions.
- **C1c-2a, the fence, the actor and reads:**
  - `folder_native_lease_current`, the targets overload of `run_enter`, `folder_tool_run` with the run mutex, and the
    dispatch in NTLR, the lease validation, `run_wake_authorized` and `wake_authorized`;
  - `company_run_actor` and the `assert_context` dispatch by core; the five swapped callers;
  - the read-type branches, and `record_action_review` under the mutex;
  - the explicit refusals, `native_machine_start` included;
  - **interim refusals** of the legacy effect entry points (the receipts, both sends, the interaction request, the
    transcript append), so no `folder-v2` path takes the job and then the budget row between 2a and 2b;
  - the stop check in every folder function.
- **C1c-2b, effects**, in two PRs:
  - **2b-1** (migration 20260929540000, tests 650 and 651): the folder receipts and the receipt ↔ commit link, the
    commit's single six-argument signature, and the commit's rank 11 (the sessions the hook names, `FOR UPDATE` in id
    order, after rank 10 and before the paths). F2's hook then names its sessions (agent threads, pair sessions,
    group chats) in its own PR.
  - **2b-2**: the send family and its marker, the folder interaction request and transcript append, the card path,
    `assert_company_path_reads`, `record_native_context_view` and `add_agent_review_rule`. The runner broker's
    `send_runner_agent_message`, like its direct receipt calls and transcript append, keeps refusing `folder-v2`: the
    runner broker cannot start a `folder-v2` run before C3 (its describe refuses), and only the native send gets the
    folder body.
  The full list:
  - the send family and its trigger marker, the folder transcript append and interaction request;
  - the sessions rule, with the commit's sessions rank and F2's session targets;
  - `assert_company_path_reads`, `record_native_context_view`, the folder receipts and the receipt ↔ commit link, the
    card path, and `add_agent_review_rule`.
- **C1c-2c, wakes and completion** (also: receipt recovery. `terminalize_runner_attempt_before_native_start` marks
  executing receipts ambiguous, and `resolve_run_operation_receipt` needs a snapshot or proposal for
  `confirmed_completed`. Their `folder-v2` modes: `confirmed_completed` records the commit that carries the receipt,
  and `confirmed_not_run` refuses while a commit carries it):
  in two PRs:
  - **2c part 1** (migration 20260929580000, tests 656 and 657): the admission helper, the pin trigger's and routine
    lifecycle's folder modes, `send_coworker_message` and `read_native_wake`, and the legacy loops skipping
    `folder-v2`. C2's creation commit needs this part.
  - **2c part 2** (migration 20260929600000, tests 658 and 659): `handoff_run_sponsor`, receipt recovery, and the v6
    folder lane with its dispositions. Test 646's v6 case changes from "refused" to "not refused as folder-v2".

Concurrency tests (dblink, with `current_database()`), by slice:
- **C1c-2a:**
  1. Two tool calls of one run: the second waits at the mutex, and nothing deadlocks. (The context views' ordinals
     move to C1c-2b, test 7b: in 2a, `record_native_context_view` refuses `folder-v2` before it writes.)
  2. Renewal waits only for the one tool call in flight.
  3. Stop: the drain waits for a tool call in flight, and a call that waited behind it refuses. A deletion row with no
     pause row also refuses a tool call.
  4. A commit rewriting the agent's `agent.md` runs beside that agent's tool call: no 55P03, no deadlock.
  5. `assert_context` with a revoked read refuses rather than passing, and so does `run_wake_authorized` for a coworker
     wake whose parent's reads are no longer readable.
  6. Every `folder-v2` refusal, a run with no budget row included, and a snapshot-v1 control for every dispatcher, plus
     a digest of each snapshot-v1 body.
- **C1c-2b:**
  7. Concurrent receipt begins leave one `executing` receipt.
  7b. Concurrent context views of one run get ordinals 1 and 2.
  8. A send, an ask card and a coworker send against legacy posting or `answer_interaction` on the same session, both
     orders: no deadlock. Removing rank 0 gives 40P01.
  9. `add_agent_review_rule` twice with the same text leaves one row. Against a role change, no deadlock.
  10. Receipts: a commit carrying the receipt completes it; no commit refuses; another run's commit refuses; two commits
      cannot carry one receipt.
  10b. A commit that renames a group chat and changes an agent, against a send in that group: no deadlock (F2's
      session targets).
- **C1c-2c:**
  11. A coworker message A → B against B's own send into its thread, and a commit archiving A against A's coworker
      send: no deadlock. Also A → B and B → A at the same time, and a **first** message between two agents (the pair
      session is created) against a send into either thread.
  12. Completion waits for a send and for a release in flight. A `folder-v2` job never reaches
      `before_path_runtime`. Each disposition.
  13. A `folder-v2` wake insert without admission refuses. With rank 0 and admission held it never meets 55P03 (C2's
      creation shape). The routine lifecycle at `FOR NO KEY UPDATE` runs beside a routine-file commit and beside the
      routine run's tool call.
  14. A materializer pass with a `folder-v2` wake beside a snapshot-v1 wake: the snapshot-v1 wake materializes, and the
      `folder-v2` company row is never locked.
  15. Removing another member while a run sends: no deadlock. Removing the run's own requester is C1c-3's case.

  Part 1 builds 11 (657 A, B, G: the first message and the recipient's own send, crossed messages, archiving the
  sender; the archiving save is rolled back in its first order, and 647 covers an archived run's agent), 13 (656 §2
  and §3, 657 D; "beside a routine-file commit" is a wait at the routine, then the insert lands), 14 (656 §7 for every
  loop, 657 F with the `folder-v2` company row held `FOR UPDATE` elsewhere) and 15 (657 E), plus the thread that
  changed while a message waited (657 C). Part 2 builds 12 (658 §2–§4 for the dispositions and the lane's checks, 659
  A and B for a send and a release in flight, 659 C for a tool call during completion; a `folder-v2` job never
  reaches `before_path_runtime`, shown by its `company_file.runtime`), plus the handoff (658 §7) and recovery (658
  §6).

## 6. C1c-3: the remaining company-row locks and the activation checks

Needed before any view goes live (C1B §4).

- **Member removal** (remove, leave, role change, and the founder guard), for `folder-v2`:
  1. lock the queued and leased jobs the removal will end, in id order;
  2. close the member's open views (C1B §4's one order: job, then view, then fence and principals);
  3. then the member row, and the delete. A job queued in between is taken with `NOWAIT`, and the removal refuses as
     retryable;
  4. no company row `FOR UPDATE`: a narrower serialization of member management.
  Account deletion cascades from `auth.users` and cannot be reordered: it runs the same prelude when an account
  close function exists, or an operator delete may hit 40P01 once and succeed on retry.
- **The other company-row sites** a `folder-v2` company still uses, moved to the folder fence in their caller's mode
  or to their own row: posting, `append_session_input`, `answer_interaction`, `retry_room_delivery`, `get_email_draft`,
  `answer_action_review`, `save_review_rule` (personal scope), routine firing, coding attach, #419's machine fence
  (`company_machine_fence_briefly`, custody, `admit_executor_machines`), the office paths (which must also serve
  `folder-v2` for C1b-3a's desktop views), member exports and attachments.
- **Personal review rules.** Today `save_review_rule` (a member's own rule) stays in step with an agent's
  `add_agent_review_rule` only through the company row. When it moves off the company row, it takes the member's row
  `FOR NO KEY UPDATE`, as the agent's folder body does (2b part 2).
- **Activation checks** (core §3, §9), requested in the PR body for the release branch:
  - the snapshot-v1 bodies of every function C1c branches keep their text (a digest of each);
  - the `folder-v2` branch of each dispatcher and its callees takes locks in the design's order, never the company row
    `FOR UPDATE` or the gc fence, and never strengthens a lock;
  - every lease-ending function takes the job `FOR UPDATE` (today only test 633 checks this);
  - only the four named functions touch `qorpera_execution_run_budgets`, and every `folder-v2` dispatcher that takes
    the run mutex takes it before the job (C1C §5.2);
  - no deferred constraints or triggers on the folder core's tables.
- **Deletion drains the folder fence** for `folder-v2` (C1C §5.5): the folder pause's second phase, with no gc fence.

## 7. Traps for C1c-2 and C1c-3

- `decide_agent_routine` catches `manage_agent_routine`'s 55000 by its message; keep that refusal as it is.
- The v149 activation markers pin text in `record_native_context_view`, `add_agent_review_rule`,
  `manage_agent_routine`, `check_company_path_mutation`, `pin_wake_occurrence`, `guard_founder_departure` and
  `authorize_coding_machine_run`. An edit that drops a marker, or adds the gc fence to the functions it must stay out
  of, fails the next cut.
- The coding lane goes through the actor (`begin_native_coding_execution`, `record_coding_context_view`), so coding
  turns, and C1b-3a's coding views with a live turn, refuse on `folder-v2` until C1c-2.
- Runner-broker model requests do no Company File recheck at all today.
- No real run can exist on `folder-v2` yet: C1c's branches are tested on hand-made rows, as C1b's were.
- The `folder-v2` run check sets no `lock_timeout`. The legacy direct lease check runs with 25 s, and legacy NTLR's
  gc fence wait happened inside it. The folder path's waits (the mutex, the job, the fence, rank 0 behind a legacy
  company-row holder until C1c-3) have none. C1e's load test watches them against core §9's result fence.
