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

Migration 20260929430000. Every guard is false for snapshot-v1 companies, and sits at the start of the function,
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
instead of the company row. The design comes from a second read-only inventory (2026-09-29, 1,468 live definitions).

### 5.1 What today's run check does, and why it cannot simply move to `KEY SHARE`

`qorpera_native_tool_locked_run` (NTLR) runs under every runtime tool call: 29 SQL callers, plus 21 through
`qorpera_describe_native_tool_authority`. Each call takes:
- the job `FOR UPDATE` three times: its own lock, the lease validation's, and `runner_broker_locked_job`'s;
- the company row `FOR UPDATE` and the legacy admission fence, through the gc fence in the lease validation;
- the routine, staff and room rows `FOR SHARE NOWAIT`, out of rank order, in `wake_authorized`.

Two facts shape the `folder-v2` version:
- **Nested job locks.** With the job at `KEY SHARE`, every legacy helper that later takes the job `FOR UPDATE` becomes
  a lock upgrade, and two effects of one run would deadlock. The sites are receipt begin and complete, the transcript
  append, both send functions, and the lease validation. The `folder-v2` paths never call them.
- **The job lock is today's per-run mutual exclusion.** Several callers check, then write, relying on it:
  - receipt begin: "one unresolved operation", which has no unique index;
  - the send: its public-send budget, acknowledgement counts and "already final" check;
  - `begin_native_company_execution_v2`: reconciliation, then the launch upsert;
  - `record_native_context_view`: ordinal and replay, whose unique keys would turn a race into 23505;
  - `record_action_review`;
  - `add_agent_review_rule`, which serializes on the company row.

### 5.2 The run mutex

The run's budget row, `qorpera_execution_run_budgets` (one per sponsored run, primary key `run_id`), taken
`FOR UPDATE` **before the job**, as a commit claims its operation key before the job (core §3 step 1).
- Only four functions touch that row, all same-run effects: the transcript append, receipt begin, the runner's file
  object check, and the reservation that inserts it. No lease-ending path touches it (completion, requeue, cancel,
  handoff, re-claim), and neither does renewal. So nothing takes the job and then the budget row on a `folder-v2` path,
  and the order cannot invert.
- Before the job, not after: a tool call that arrives while completion holds the job waits at the mutex, then finds the
  run ended and refuses. It never takes the job `KEY SHARE` beside a waiting completion, so completion is not starved.
- A run without its budget row refuses (42501).
- Folder commits and releases do not take it: disjoint saves of one run stay parallel.

### 5.3 New functions

- **`qorpera_folder_tool_run(p_binding jsonb, p_targets jsonb default '[]')`**, the `folder-v2` NTLR. The steps, in
  order:
  1. the host authority check, as today;
  2. the stop check (§5.5), as a plain read;
  3. the run mutex;
  4. `qorpera_folder_run_enter` with the caller's targets: the job `KEY SHARE`, the fence `KEY SHARE` with the stop
     re-read, then ranks 0 to 5;
  5. `qorpera_folder_native_lease_current`: a plain check of the native lease tuple (lease against run, job, runner,
     assignment, capsule and identity), the runner's recovery epoch, lease and assignment expiry, the connection,
     capsule and policy, and sponsor availability, plus the existing plain `qorpera_runner_broker_job`. The save check
     (C1B §2) leaves the lease and the sponsor out; model-facing tool calls keep them.

  It returns the resolved run actor and the run row. The binding's ids are normalized (`::uuid::text`).
- **`qorpera_folder_run_enter(env, profile, actor, p_targets)`**, an overload. It merges the caller's targets into the
  run's own, validated as C1b-3a's commit validates them: rank 0 is only this company's row `KEY SHARE`, ranks 6 and 7
  are `KEY SHARE` only, and the stronger mode wins. It locks them in rank order.
- **`qorpera_company_run_actor(env, p_binding, p_targets default '[]')`**, the new entry point.
  - snapshot-v1: it returns `qorpera_company_path_actor(...)` unchanged;
  - `folder-v2`, run: the legacy field names callers read (`companyId`, `environmentId`, `userId`, `staffAgentId`,
    `runId`, `jobId`, `assignmentId`, `audience`, `audienceUserId`, `sponsorBindingId`, `sponsorVersion`,
    `runtimeBundleId`), plus `core: 'folder-v2'` and `folder: {actor, resolved}`;
  - `folder-v2`, member: a plain membership read.
- **The `assert_context` dispatch.** With `actor ->> 'core' = 'folder-v2'` it calls `qorpera_folder_run_reads_current`
  at rank 10, and never falls through to the legacy loop. A `folder-v2` run has no rows in
  `company_run_read_paths`, so that loop would pass vacuously. `wake_authorized`'s agent branch has the same trap.
- The send family, the receipts, the completion lane and the wake admission (§5.6).

### 5.4 Dispatch on core

As in C1c-1, a line inserted at the start of each function sends `folder-v2` to its new body. The snapshot-v1 text
after that line stays byte-identical, and its digest is checked at migration time.

| Function | `folder-v2` |
| --- | --- |
| `native_tool_locked_run` | `folder_tool_run(binding)`, returning the run row |
| `validate_native_provider_execution_lease` (also called directly by the runtime) | `folder_native_lease_current` plus the stop check |
| `run_wake_authorized` | `folder_wake_authorized` plus the policy kind (its other callers include `assert_wake_work_allowed` and `handoff_run_sponsor`) |
| `company_path_assert_context` | `run_reads_current`, never the loop |
| the five "unchanged" callers (§3) | their actor call becomes `company_run_actor`; `begin_native_company_execution_v2` also takes the run mutex |
| the read-type branches: `describe_company_run_context` (company name from `qorpera_folder_company_index`; session read plain), the presence functions (a folder `presence_path_routes` on `qorpera_folder_path_resource` and `folder_actor_allowed`; a refusal is 42501, which `native_presence_subject` reads as "absent"), `native_company_object_actor`, `member_file_export_source` (no gc fence) | their `folder-v2` body |
| `send_native_agent_message`, `send_runner_agent_message`, `append_native_interaction_request` | the folder send (§5.6) |
| `append_runner_transcript_event` (the runner broker's bypass of the send path) | refuses 0A000 |
| `begin_`, `complete_native_tool_operation` | the folder receipts |
| `enforce_company_context_send` | requires the marker the folder send sets; refuses without it |
| `pin_wake_occurrence`, `routine_occurrence_lifecycle` | the folder admission mode (§5.6) |
| `complete_runner_job_v6` | the folder completion lane, in place of C1c-1's guard |
| `native_office_start`, `_start_descriptor`, `_capture`, `_file_export`, `native_shared_file_export_source`, `self_approve_organization_proposal` | refuse 0A000 until C1c-3: they take the gc fence or a legacy proposal lock after the run check |

### 5.5 The stop check includes deletions

The folder functions (`run_enter`, the commit, `record_release`, `read_actor`) read only
`qorpera_company_execution_pauses`. A company under deletion is paused for today's NTLR (`company_execution_paused`
reads pauses and deletions), but would not be for the folder core. C1c-2a switches every folder function to
`qorpera_company_execution_paused`.

### 5.6 Effects, wakes and completion

- **The folder send** (both send functions and the interaction request), in order:
  1. the stop check;
  2. the run mutex;
  3. the job `KEY SHARE`, then the fence with the stop re-read;
  4. **rank 0**, then ranks 1, 2, 4 and 5;
  5. the plain lease check;
  6. the recheck at rank 10;
  7. the session `FOR UPDATE`;
  8. the marker, then the insert (the trigger checks the marker), then the transcript append, with no broker job lock.

  Rank 0 is needed until C1c-3: legacy posting, `answer_interaction`, `get_email_draft` and `retry_room_delivery` take
  the company row, then the session. A send takes the session, then the company row through the operation clock's
  foreign key.
- **Receipts** (`qorpera_folder_begin_run_receipt`, `_complete_run_receipt`): under the run mutex, with no broker job
  lock. A receipt that "requires a company revision" is completed by a folder commit carrying it: the commit writes
  `qorpera_folder_commits.receipt_id`, which nothing writes today.
- **`record_native_context_view`:** each output's `readId` is a release in `qorpera_folder_run_releases` and its
  `readSha256` the read record's `output_sha256`, instead of `company_read_confirmations`. The run mutex orders the
  ordinal and the replay. The v149 marker stays.
- **`add_agent_review_rule`:** the requester's member row `FOR NO KEY UPDATE` at rank 1 (merged with the run's
  `KEY SHARE`, so no upgrade), plus rank 0 and the recheck. It no longer takes the company row.
- **Wakes.** Every `folder-v2` inserter takes the recipient's rows at ranks 1 to 5 (the routine `FOR NO KEY UPDATE`),
  then `qorpera_folder_admit_wakes(profile)`: the folder admission row `FOR NO KEY UPDATE`, last before the clock
  (core §3 step 10), which sets a transaction marker. Then it inserts.
  - In `folder-v2` mode the pin trigger takes no lock, and refuses a wake without the marker.
  - `routine_occurrence_lifecycle` takes the routine `FOR NO KEY UPDATE` instead of `FOR UPDATE`.
  - The legacy admission fence (`qorpera_company_wake_admission_fences`, today's stop fence as well) and the folder
    admission row are different tables. `folder-v2` never touches the legacy one.
  - The drains that admit many companies in one transaction stay legacy-only (C4).
- **`send_coworker_message`:** the parent's read-set check of C1B-2 §4, then admission; the recipient's rows are
  targets.
- **`read_native_wake`:**
  - the wake check comes from `run_resolve`;
  - a company-file wake refuses (C4);
  - the parent's folder read set is inherited into the run, idempotent per wake;
  - no `companySnapshotId` pin. `companySeq` has no column yet (C4), and the transcript's session pin reads NULL for
    `folder-v2` today, so it is not enforced until then.
- **Completion**, the `complete_runner_job_v6` lane, in order:
  1. the job `FOR UPDATE` (the lease ends);
  2. the run box views of the run `FOR UPDATE`, in id order (C1B §4's one order: job, then view);
  3. the fence and ranks, with the routine `FOR NO KEY UPDATE`;
  4. the recheck;
  5. receipts matched to folder commits;
  6. the provider-session owner, then the job update.

  It reuses `complete_runner_job_v4`, v3 and v2 and `bind_execution_provider_session`, and never routes to
  `complete_runner_job_before_path_runtime`. The run-results check forbids `published` without a snapshot, so it gains a
  `folder-v2` disposition.

### 5.7 Additions to core §3's order

- **The run mutex:** after the operation key, before the job.
- **Run-owned rows** (receipts, action reviews, context views): after the ranks, before rank 10.
- **Sessions:** after rank 10, before admission.
- **The provider-session owner:** in completion, after the recheck.

### 5.8 Moved to C3 and C4

- The runner broker's describe and input-object checks. Their legacy bodies read the substrate and company snapshot,
  and the runner accepts only the two legacy runtimes (`cloud-runner-broker.ts:1042`). C1c-1's refusals stay until C3
  gives `folder-v2` runs their substrate model.
- `companySeq` pins on runs and wakes (C4's schema).
- Office-activation and machine-event runs make no tool call: `run_resolve` refuses them (0A000), as offices refuse
  `folder-v2` today.

### 5.9 Split and tests

Three PRs, in order. Each needs C1b-3a (#497) and C1c-1 (#532) on master first; their migrations sort after
`20260929430000` and after #419's patches of the wake functions.
- **C1c-2a, the fence, the actor and reads:**
  - `folder_native_lease_current`, the targets overload of `run_enter`, `folder_tool_run` with the run mutex, and the
    dispatch in NTLR, the lease validation and `run_wake_authorized`;
  - `company_run_actor`, the `assert_context` dispatch, and the five swapped callers;
  - the read-type branches, the explicit refusals, the stop check, and `record_action_review` under the mutex.
- **C1c-2b, effects:** the send family and its trigger marker, the folder transcript append and interaction request,
  `assert_company_path_reads`, `record_native_context_view`, the folder receipts and the commit ↔ receipt link, and
  `add_agent_review_rule`.
- **C1c-2c, wakes and completion:** the admission helper, the pin trigger's and routine lifecycle's folder modes,
  `send_coworker_message`, `read_native_wake`, and the v6 folder lane with the run-results disposition. C2's creation
  commit depends on it.

Concurrency tests (dblink, with `current_database()`):
1. Two tool calls of one run: the second waits at the mutex, and nothing deadlocks. Concurrent receipt begins leave
   one `executing` receipt; concurrent context views get ordinals 1 and 2.
2. Renewal (job `FOR NO KEY UPDATE`) is never blocked by a tool call.
3. Stop: the drain waits for a tool call in flight, and a call that waited behind it refuses.
4. A commit rewriting the agent's `agent.md` runs beside that agent's tool call and send: no 55P03, no deadlock.
5. A send against legacy posting or `answer_interaction` on the same session, both orders: no deadlock. Removing rank
   0 gives 40P01.
6. Completion waits for a send and for a release in flight.
7. Coworker sends A → B and B → A at the same time: no deadlock.
8. A `folder-v2` wake insert without admission refuses. With rank 0 and admission held it never meets 55P03 (C2's
   creation shape).
9. `add_agent_review_rule` twice with the same text leaves one row; against a role change, no deadlock.
10. Removing another member while a run sends: no deadlock. Removing the run's own requester is C1c-3's case.
11. A snapshot-v1 control for every dispatcher, and a digest of each snapshot-v1 body after the inserted line.

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
- **Activation checks** (core §3, §9), requested in the PR body for the release branch:
  - the snapshot-v1 bodies of every function C1c branches keep their text (a digest of each);
  - the `folder-v2` branch of each dispatcher and its callees takes locks in the design's order, never the company row
    `FOR UPDATE` or the gc fence, and never strengthens a lock;
  - every lease-ending function takes the job `FOR UPDATE` (today only test 633 checks this);
  - no deferred constraints or triggers on the folder core's tables.

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
