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
  company fence, which it does. Legacy sweep D2 (20260930331000) dropped them, with the rest of the old proposal lane.
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
  company is created by one commit (C2). Legacy sweep D1 (20260930330000) dropped the old chain: the bootstrap jobs,
  their functions and the seed.
- **The legacy pause** refuses: `folder-v2` companies stop through `qorpera_folder_pause`, which drains effects.
- **Old row writers:** `put_profile_staff`, `delete_profile_staff`, `put_staff_provider_model`,
  `confirm_agent_todo_publication`. The binding check reads the run's job, and reads the job id as the run lookup
  does (any spelling uuid input accepts). Legacy sweep D1 (20260930330000) dropped the two staff writers.
- **Left as they are, on purpose:**
  - `upsert_cloud_routine`: F2-6 (#523) decides its `folder-v2` rule. It refuses new routines, but still accepts saves
    of routines that existed as rows before the company became `folder-v2` (test 708);
  - the roster's default-grant trigger (`ensure_default_agent_read_grants`): `folder-v2` agents need its grant on the
    company-shared root to read and write there (test 632 fails without it). F2's concern is how it is written:
    outside the authority journal and after the commit's rank-6 and rank-7 locks. The grant is a widening, so the
    authority check does not need a journal row for it. Since P15 the follow-up queue writes it after the commit
    that creates the agent, at rank 6 and 7, with one widening journal row, and the trigger skips `folder-v2`
    (STATE-FILES "Plan (P15)");
  - `verify_company_path_file` and `_tree`: service-role functions that register uploaded bytes; the folder core has
    no other way to get them until C1d's byte check replaces them. Members have no upload path for `folder-v2` at all
    until C1d's upload intents;
  - `answer_action_review`'s "Always allow", which F2-4 accepts until C3 writes the rule file;
  - `member_company_file_mode`, which still reports `legacy` for `folder-v2` until the web client's branch (C4);
  - `qorpera_company_uses_path_gateway`: the web's Company File page reads it, so its meaning stays; the object
    paths check the core themselves;
  - a snapshot bootstrap job left from before a company became `folder-v2` stays queued (and the company stays hidden
    if the job set `hidden_until_ready`) until C2's creation replaces the old chain. Legacy sweep D1 (20260930330000)
    dropped the jobs, which it requires to be none.

**Test 646** calls every guarded function on a `folder-v2` company and expects 0A000, with a snapshot-v1 control
for each that must not be refused (the Storage policies and the bootstrap claim included). Each guard was removed in
turn: the test failed for 31 of 34. The other three (`runner_begin_company_revision_graph`, `runner_authorize_` and
`_finalize_company_revision_verification`) call `runner_company_revision_snapshot` first, whose own guard refuses;
they keep theirs in case that call moves. Legacy sweep D1 (20260930330000) removed the bootstrap claim's and the staff
writers' cases with the functions, and legacy sweep D2 (20260930331000) the whole-tree lane's. `folder-v2` proposals
are tested by 926, 927 and 937.

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
  starve completion and the other lease-ending changes. With it, a second tool call of the run waits at the mutex,
  never beside the first at the job: at most one tool call holds the job at a time. When that call commits, a waiting
  lease-ending change and the next tool call race for the job row. The waiter usually wins, since it only re-reads
  the row while the next call first takes the mutex and runs its checks; at worst it waits for that one call, and it
  meets the same race, with the same head start, at each hand-off. That bound holds per hand-off, not over many: strict
  first-come order would need lease-ending changes to take the mutex too, which they do not. The run's own commits,
  releases and views also hold the job `KEY SHARE`, without the mutex, so a waiting lease-ending change waits for
  those too; they are short and never queue behind each other at the job. Renewal waits for none of them: since P23 it
  takes the job `FOR NO KEY UPDATE`, which `KEY SHARE` does not block (§5.8; tests 648 C and 825 A).
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
after that line stays byte-identical, and its digest (the body without the line, or with a text patch reversed) is
checked by each slice's functional test (647, 652, 656, 658). No snapshot-v1 digests since 3 October: legacy sweep A,
#829, removed them from these tests.

| Function | `folder-v2` | Slice |
| --- | --- | --- |
| `native_tool_locked_run` (its callers include F2-1b's `qorpera_prepare_routine_login`) | `folder_tool_run(binding, '[]')`, returning the run row (since legacy sweep F1c, 20260930246000, it only calls it) | 2a |
| `validate_native_provider_execution_lease` (also called directly by the runtime) | `folder_native_lease_current` plus the stop check (since legacy sweep F1c, 20260930246000, it only calls `folder_validate_native_lease`, and the snapshot-v1 check `validate_native_provider_execution_lease_before_recover` is dropped) | 2a |
| `run_wake_authorized`, and `wake_authorized` itself (the materializer calls it directly; its agent branch passes vacuously on `folder-v2`) | `wake_authorized` dispatches to `folder_wake_authorized` (since legacy sweep F1b, 20260930245000, it only calls it); `run_wake_authorized` keeps its text, calls it with the run's wake and compares the policy kind | 2a |
| `company_path_assert_context` | by the company's core: `run_reads_current`, never the loop | 2a |
| the five "unchanged" callers (§3) | a text patch: their actor call becomes `company_run_actor`; `begin_native_company_execution_v2` also takes the run mutex; the digest is of the patched text | 2a |
| the read-type branches: `describe_company_run_context` (company name from `qorpera_folder_company_index`; its session check stays `FOR SHARE`, after rank 10's recheck at the sessions rank of §5.7; and F2's folder facts: `|| case when v_folder is null then '{}' else jsonb_build_object('folder', v_folder) end`, with `v_folder := qorpera_company_state_run_folder(env, staff, <the coworker ids the body lists>)`, called by name at run time so snapshot-v1 never needs it. It is given the same ids the body puts in `coworkers` and names no others, so `folder` never names an unlisted coworker even when a roster change lands between the two statements; a coworker whose folder retired in between is left out, as one without a folder is. From F2-1b's migration 20260929440000 on #534; the runtime's closed parser checks that every coworker in `folder` is listed, and memory and skills then use `agents/<handle>`), the presence functions (a folder `presence_path_routes` on `qorpera_folder_path_resource` and `folder_actor_allowed`; a refusal is 42501, which `native_presence_subject` reads as "absent"), `native_company_object_actor`, `member_file_export_source` (no gc fence) | their `folder-v2` body; legacy sweep F1d (20260930247000) left `describe_company_run_context` only that body | 2a |
| `native_office_start`, `_start_descriptor`, `_capture`, `_file_export`, `native_shared_file_export_source`, `self_approve_organization_proposal`, **`native_machine_start`** | refuse 0A000 until C1c-3: after the run check they take the gc fence or a legacy proposal lock. Machine start holds the machine row and then asks for the company row `FOR UPDATE`, the reverse of #419's custody order (served since 3f, §6.5). The office start and its descriptor serve folder-v2 since 3l (§6.16). The capture serves folder-v2 since P06d part 2 (§6.21), storing nothing (3l part 3 refused screenshots before it, §6.22) | 2a |
| `send_native_agent_message`, `send_runner_agent_message`, `append_native_interaction_request`, `append_runner_transcript_event`, `begin_`/`complete_native_tool_operation`, `begin_`/`complete_run_operation_receipt` | 2a: refuse 0A000. 2b-1: the folder receipts (`begin_`/`complete_native_tool_operation`). 2b-2: the folder native send and interaction request. The runner broker's `append_runner_transcript_event`, its send and its direct receipt calls keep refusing (C3). Legacy sweep F1c (20260930246000) left `begin_`/`complete_native_tool_operation` only their folder receipts, and F1e (20260930248000) `send_native_agent_message` and `append_native_interaction_request` only their folder bodies | 2a, 2b |
| `record_action_review` | 2a: under the mutex; its card path refuses through the transcript append. 2b: the folder card path (§5.6) | 2a, 2b |
| `assert_company_path_reads`, `record_native_context_view`, `add_agent_review_rule` | their `folder-v2` body (§5.6); legacy sweep F1e (20260930248000) left `add_agent_review_rule` only that body | 2b |
| `enforce_company_context_send` | requires the marker the folder send sets; refuses without it | 2b |
| `pin_wake_occurrence`, `routine_occurrence_lifecycle` | their `folder-v2` modes (§5.6): text patches, each keeping the legacy statement as its `else` branch; the digest was of the patched text with the patch reversed (removed since 3 October, as above). Legacy sweep F1a (20260930244000) removed `routine_occurrence_lifecycle`'s `else`, and F1b (20260930245000) `pin_wake_occurrence`'s | 2c part 1 |
| `send_coworker_message`, `read_native_wake` | their `folder-v2` bodies (§5.6), by a first line. Legacy sweep F1b (20260930245000) left `read_native_wake` only that line, and F1e (20260930248000) `send_coworker_message` | 2c part 1 |
| `enqueue_routine_wake` (routine firing) | its `folder-v2` mode in place of the gc fence, after its argument checks (§5.6); moved here from C1c-3 because part 1 closes the legacy path (F2-6's test 709 fires file routines). Legacy sweep F1a (20260930244000) removed the legacy path, here and in `advance_routine_next_due` | 2c part 1 |
| the legacy multi-company loops: `materialize_wake_execution_runs`, the drains (`office_activation`, `worker`, `machine`, `company_file` with the dynamic-routine tick), `materialize_session_execution_runs` | skip `folder-v2` companies in the scan's `WHERE` clause, before their first lock. `materialize_session_turn_requests` needs no skip: its scan requires the company's head snapshot, which a `folder-v2` company never has (`qorpera_company_files_core_head`). Legacy sweep F3b (20260930295000) dropped all of them, the event drain, the Company Proposal review materializer and their helpers included | 2c part 1 |
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
- **Members and the platform stop on deletion only** (slice P01, `20260930001000`). `read_actor` answers them before
  the stop check, so read, list and the feed served them while the company was being
  deleted. Now `read_actor` refuses them with 55000 'Company is being deleted' when the company has a deletion row. A
  pause alone still lets them read. Runs and views keep 'Company execution is paused'.
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
    the head of every pass, and snapshot-v1 wakes would stop materializing. They stay legacy-only (C4). Two limits:
    skipped `folder-v2` wakes are never stamped, so they stay at the head of the scan's order and each pass checks
    them again (none exist before C2; C4 gives them their own drain); and the routine expiry sweep, which does not
    skip (below), can still end a pass with its documented 40P01 against a multi-routine folder save.
  - As built (2c part 1, migration 20260928279580):
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
      is documented there). Legacy sweep F3b (20260930295000) dropped the tick with the drain.
    - Routine firing (`enqueue_routine_wake`, which the scheduler calls per routine after `list_routine_schedule_heads`)
      gets its `folder-v2` mode here, not in C1c-3: part 1 closes the legacy path, and F2-6's test 709 fires file
      routines. `qorpera_folder_enqueue_routine_wake`, after the legacy argument checks, in place of the gc fence: the
      folder fence and this company's row `KEY SHARE`; the version's member, agent and execution authority `KEY SHARE`;
      the routine `FOR NO KEY UPDATE`, then its schedule position `FOR UPDATE` (a routine save holds the routine the
      same way, so the two meet at the routine row); the routine's public session `KEY SHARE` before admission (the
      wake's foreign key takes it, and after admission it could wait on a message that holds that conversation and
      waits for admission: 657 D2); admission; the wake. A session the pin trigger chose differently refuses as a
      retryable conflict. Today's results are kept: the replay, the version and position conflicts, the pause and
      zero-hours deferrals.
    - No legacy wake inserter serves `folder-v2` after this: each lacks the mark and refuses (55000).
    - The scheduler's other step, `advance_routine_next_due`, takes this company's row `KEY SHARE` on `folder-v2`
      instead of the gc fence; its routine `FOR SHARE` and position `FOR UPDATE` follow as today (review r1 S3; 657 D3).
    - A member joining, leaving or changing role fires `qorpera_agent_threads_on_member`, which re-ensures every agent
      thread: a room `FOR UPDATE`, its members, its conversation, one agent after another in scan order. On
      `folder-v2` it first takes every thread room `FOR UPDATE` in id order, then every thread conversation, through
      `qorpera_folder_lock_agent_threads`, so it never holds one room and waits for another that a message holds
      (review r1 S2; 657 E2). The rest of member management (the company row `FOR UPDATE` in removal and role
      change) is C1c-3's.
    - The pin trigger's `folder-v2` mode refuses office-activation and machine-event wakes (0A000): their ancestry
      checks lock rows (`qorpera_office_waiter_authorized` takes the company row `FOR UPDATE NOWAIT`), and neither
      source serves `folder-v2` until C1c-3.
    - Foreign-key `KEY SHARE` locks after admission: a wake insert's keys to the environment, the parent run, the
      requester, the sponsor version, the logical computer and the routine version; and #519's listener sync, which
      locks event listener cursors `FOR UPDATE` when a count limit expires a routine (folder-v2 routines have no event
      cursors before C4). No path locks those rows more strongly in a way that waits for admission today; C1c-3's
      activation check lists them (review r1 N4).
- **`send_coworker_message`** (`qorpera_folder_send_coworker_message`, 2c part 1):
  1. the run mutex, the job, the fence, rank 0;
  2. ranks 1 and 2 for sender and recipient, rank 3 for the recipient's authority, rank 4 for both agents' thread rooms
     (`FOR UPDATE` when a thread must be created or reopened: `ensure_agent_thread_internal` locks the room that way,
     and the target must not be strengthened later). The targets come from an unlocked read before the run check;
     after it, a thread room that exists and is not held in the mode its thread now needs refuses the message as
     a retryable conflict (QRC01, 409, "Coworker thread changed while the message waited"; test 657 C; never 40001,
     which PostgREST would retry on its own, test 361). The same check runs again once the conversations are locked
     (step 6): a member may close a thread holding only its conversation (`qorpera_close_shared_session`), so a
     thread can close after the first check; the helper would then take its room `FOR UPDATE` over this message's
     `KEY SHARE`, an upgrade that deadlocks two crossed messages (review r1 B1; 657 C2). The runtime does not retry
     QRC01 today (C3);
  3. the receipt (run-owned);
  4. the recheck, plus the parent read-set check of C1B-2 §4 (`qorpera_folder_parent_reads_allowed` on the wake the
     message would insert: every row of the run's read set is readable by the requester and the recipient);
  5. the pair lock (`pg_advisory_xact_lock` on the pair key, as `agent_pair_session_internal` takes it), before the
     pair conversation is read: a first message of the pair may be creating it, and a message that read it before
     that commits would lock the pair conversation after the threads, out of id order (review r1 S1; 657 C3);
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
  3. the fence, rank 0, and the ranks (a routine run's routine at the run check's `KEY SHARE`: see "As built");
  4. the native lease check, then the recheck;
  5. receipts matched to their commits;
  6. the provider-session owner;
  7. the job update.

  It reuses `complete_runner_job_v4`, v3 and v2 and `bind_execution_provider_session`, and never routes to
  `complete_runner_job_before_path_runtime` (legacy sweep F1d, 20260930247000, dropped it: `complete_runner_job_v6`
  hands every job to the folder completion). The run-results check forbids `published` and `review_pending` without a
  snapshot, so run results gain a nullable `folder_commit_id`. The check then allows `published` and `review_pending`
  with exactly one of a snapshot and a folder commit (the row names no core, so the check cannot branch on it). A run
  with several commits records its last saving commit (the highest `seq`). The `folder-v2` dispositions:
  - `published` when a commit of the run saved a unit;
  - `unchanged` when its commits saved nothing;
  - `review_pending` when a unit waits for review (C2).

  As built (2c part 2, migration 20260928279600, `qorpera_folder_complete_run_job`, v6's first line in place of
  C1c-1's refusal):
  - The result is the path lane's shape (`runtime: company-path-v1`): the runtime does not name the core. A snapshot
    or artifacts refuse (22023), as on the path lane.
  - Step 3 is `qorpera_folder_run_enter` with rank 0 as a target, so this company's row comes before the requester's
    member row (the provider-session inserts, the runner audit row and the job's second update would take it later
    through foreign keys; 659 D). Then the native lease check (`qorpera_folder_validate_native_lease`, as a tool
    call's run check does): a revoked lease or capsule refuses completion, as on the legacy lane. A routine run's routine stays at the
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
  - `review_pending` reads the units' outcomes, so it is right only while nothing writes folder reviews (C2 decides
    them); the wake still ends `completed`, not `requires_review` (C2).
  - The attempt terminalizer's partial-output check does not look at folder commits: only the native-start guard stops
    a run that already saved from being retried as pristine (C3).
  - `complete_runner_job_v2` skips its source substrate lookup for a `folder-v2` job, which has none once C4 makes
    runs without substrate ids possible, and refuses artifacts there instead. Only v6 is granted to the runtime, so
    v4, v3 and v2 are reached only through a lane.
  - `qorpera_execution_run_results.folder_commit_id` restricts deletes, as `output_snapshot_id` does: the company
    purge finds a result through that key and deletes both in one statement. The new check is added `NOT VALID`
    (every existing row met the old one, which the new one only widens).
- **`handoff_run_sponsor`** refuses a run whose revision receipts have no snapshot. Its `folder-v2` mode accepts
  receipts satisfied by commits (C1c-2c part 2: one more condition, `folder_commit_id is null`, which only
  `folder-v2` receipts can fail). Removed by 20260930059000 (the payer never changes without the member; test 658's
  handoff part went with it).
- **Receipt recovery** (2c part 2). `terminalize_runner_attempt_before_native_start` needs no change: it marks executing
  receipts ambiguous on either core. `resolve_run_operation_receipt` dispatches a `folder-v2` receipt to
  `qorpera_folder_resolve_run_receipt` (every receipt since legacy sweep F1c, 20260930246000): `confirmed_completed`
  records the commit that carries the receipt (one per receipt) and refuses a snapshot or proposal, and a revision
  receipt that no commit carries cannot be confirmed completed (22023); `confirmed_not_run` refuses while a commit
  carries the receipt (55000, "A folder commit carries this operation: it ran").

### 5.7 Additions to core §3's order

In step 4, after rank 9:
- **run-owned rows** (receipts, action reviews, context views), then **rank 10's recheck**;
- **sessions**, every one the transaction will write, `FOR UPDATE` in id order;
- **the operation clock**, at the first session write (an insert, a title or status change, or an event).

Admission and the folder clock stay last. The **run mutex** comes after the operation key and before the job (step 2).
The **provider-session owner** is locked in completion after the recheck.

One exception to "run-owned rows, then sessions": an action-review card, and a member's answer to one, take the
conversation `FOR UPDATE` before the review row, because the review row's foreign keys point at the conversation and a
`KEY SHARE` taken first would have to be strengthened (2b part 2 review r1; 653 H).

### 5.8 Moved to C3 and C4, and what stays closed

- The runner broker's describe and input-object checks. Their legacy bodies read the substrate and company snapshot,
  and the runner accepted only the two legacy runtimes. C3 gives `folder-v2` runs their model (§5.10, P23). The
  input-object check keeps C1c-1's refusal: a `folder-v2` run has no input objects (images refuse since 3a).
- `companySeq` pins on runs and wakes (C4's schema).
- Renewal's move to `FOR NO KEY UPDATE`: done in C3's first part (P23, migration 20260930002200, test 825; 648 C).
  - On `folder-v2`, `qorpera_renew_runner_job` takes the job `FOR NO KEY UPDATE`, and so does the native lease renewal.
    The native renewal does it through `qorpera_folder_renewal_locked_job`, which is `qorpera_runner_broker_locked_job`'s
    text with that lock clause. Since legacy sweep F1c (20260930246000) every native renewal does, and since
    F1d (20260930247000) every job renewal (825 C).
  - Both now run beside the run's tool calls (the job `KEY SHARE`). Every lease-ending change still takes `FOR UPDATE`
    and waits for those calls.
  - The other callers of `locked_job` (acquire, release, model authority) keep `FOR UPDATE`.
- Office-activation and machine-event runs make no tool call: `run_resolve` refuses them (0A000), as offices refuse
  `folder-v2` today.
- **After C1c-2c, legacy wake inserters fail closed on `folder-v2`.** Posting, `answer_interaction`,
  `answer_action_review`, `retry_room_delivery`, the dynamic-routine tick and coding turns stay closed until C1c-3
  gives them folder modes. Scheduled routine firing has its folder mode from 2c part 1. So no real `folder-v2` company is created before C1c-3.

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
  - **2b-1** (migration 20260928279540, tests 650 and 651): the folder receipts and the receipt ↔ commit link, the
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
  - **2c part 1** (migration 20260928279580, tests 656 and 657): the admission helper, the pin trigger's and routine
    lifecycle's folder modes, `send_coworker_message` and `read_native_wake`, and the legacy loops skipping
    `folder-v2`. C2's creation commit needs this part.
  - **2c part 2** (migration 20260928279600, tests 658 and 659): `handoff_run_sponsor`, receipt recovery, and the v6
    folder lane with its dispositions. Test 646's v6 case changes from "refused" to "not refused as folder-v2".

Concurrency tests (dblink, with `current_database()`), by slice:
- **C1c-2a:**
  1. Two tool calls of one run: the second waits at the mutex, and nothing deadlocks. (The context views' ordinals
     move to C1c-2b, test 7b: in 2a, `record_native_context_view` refuses `folder-v2` before it writes.)
  2. Renewal waits only for the one tool call in flight. (Replaced by P23: renewal waits for no tool call, 648 C and
     825 A.)
  3. Stop: the drain waits for a tool call in flight, and a call that waited behind it refuses. A deletion row with no
     pause row also refuses a tool call.
  4. A commit rewriting the agent's `agent.md` runs beside that agent's tool call: no 55P03, no deadlock.
  5. `assert_context` with a revoked read refuses rather than passing, and so does `run_wake_authorized` for a coworker
     wake whose parent's reads are no longer readable.
  6. Every `folder-v2` refusal, a run with no budget row included, and a snapshot-v1 control for every dispatcher, plus
     a digest of each snapshot-v1 body (no snapshot-v1 digests since 3 October: legacy sweep A, #829, removed them).
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
      `before_path_runtime` (legacy sweep F1d, 20260930247000, dropped it). Each disposition.
  13. A `folder-v2` wake insert without admission refuses. With rank 0 and admission held it never meets 55P03 (C2's
      creation shape). The routine lifecycle at `FOR NO KEY UPDATE` runs beside a routine-file commit and beside the
      routine run's tool call.
  14. A materializer pass with a `folder-v2` wake beside a snapshot-v1 wake: the snapshot-v1 wake materializes, and the
      `folder-v2` company row is never locked (legacy sweep F3b, 20260930295000, dropped the materializers and their
      tests, 656 §7's loops and 657 F).
  15. Removing another member while a run sends: no deadlock. Removing the run's own requester is C1c-3's case, and so
      is removing the member who owns the run's sponsor login: that revokes the login, and the cascade ends the run's
      job, which needs the job lock a completion or tool call holds (40P01 today on both lanes; C1c-3's reordered
      removal takes the jobs first).

  Part 1 builds 11 (657 A, B, G: the first message and the recipient's own send, crossed messages, archiving the
  sender; the archiving save is rolled back in its first order, and 647 covers an archived run's agent), 13 (656 §2
  and §3, 657 D; "beside a routine-file commit" is a wait at the routine, then the insert lands), 14 (656 §7 for every
  loop, 657 F with the `folder-v2` company row held `FOR UPDATE` elsewhere, until legacy sweep F3b) and 15 (657 E), plus the thread that
  changed while a message waited (657 C). Part 2 builds 12 (658 §2–§4 for the dispositions and the lane's checks, 659
  A and B for a send and a release in flight, 659 C for a tool call during completion; a `folder-v2` job never
  reaches `before_path_runtime`, shown by its `company_file.runtime`), plus the handoff (658 §7) and recovery (658
  §6).

### 5.10 C3: the runner broker's model of a `folder-v2` run (P23, migration 20260930002210, test 829)

- **The description.** The broker describes a `folder-v2` run in the path lane's shape (`company_runtime:
  'company-path-v1'`: the runtime does not name the core, §5.6) with no substrate anywhere: no version, snapshot,
  proposal snapshot, artifact index or Company File output limits, and null substrate and snapshot ids on the job and
  the run. `qorpera_folder_runner_broker_describe` keeps the legacy body's checks that still apply: the run is the
  job's, the sponsor and the connection are active and the company's, the assignment is accepted. A proposal review
  needs a proposal snapshot and refuses (0A000).
- **No fall-through to the whole-tree lane.** The runtime's parsers accept the absence only as the path lane's, with
  version, snapshot and output limits absent together and no substrate named on the job or the run. Every reader of a
  substrate refuses ("This run has no Company File substrate"): resolve, operations, the output and Company File
  publishers, revisions, and the whole-tree runner itself. The broker names the job's company. An older runner refuses
  such a description at its Company File output limits, before it reads anything else.
- **Lists.** `list_operations` and `list_artifacts` refuse `folder-v2` with 0A000, where a null substrate gave P0002,
  so the reason is named. Over HTTP nothing changes: the broker maps both to 503, which the runner retries for 360 s
  (so does a proposal review's refusal). No runner asks: this runtime refuses before it calls, and an older one
  refuses the description first.
- **Completion needs no change.** The folder lane writes the runner's client substrate id (a deterministic id per job,
  never null) into the results row, never the job's. A result naming no substrate passes its check against a job with
  none, since null is not distinct from null. So a run with no substrate completes once P28 lets one exist (829 shows
  the round trip with today's job).
- **The gate.** Nothing reaches this lane before P28: jobs and runs still require both ids, and the materializer skips
  `folder-v2`. P28's switch-on requires every host to run parsers that read it: the runner orchestrator, the LXD
  providers and the shared execution guests (#709's list), and the runtime and cloud-client builds of this PR.
- **Wakes.** A wake's `pins.companySnapshotId` may be null; C4's `companySeq` replaces it.

## 6. C1c-3: the remaining company-row locks and the activation checks

Needed before any view goes live (C1B §4).

- **Member removal** (remove, leave, role change, and the founder guard), for `folder-v2` (as built: §6.4, which
  supersedes steps 2 and 3: views are not closed, and the `NOWAIT` for a late job moves to 3d):
  1. lock the queued and leased jobs the removal will end, in id order;
  2. close the member's open views (C1B §4's one order: job, then view, then fence and principals);
  3. then the member row, and the delete. A job queued in between is taken with `NOWAIT`, and the removal refuses as
     retryable;
  4. no company row `FOR UPDATE`: a narrower serialization of member management.
  Account deletion cascades from `auth.users` and cannot be reordered: it runs the same prelude when an account
  close function exists, or an operator delete may hit 40P01 once and succeed on retry.
- **The other company-row sites** a `folder-v2` company still uses, moved to the folder fence in their caller's mode
  or to their own row: posting, `append_session_input`, `answer_interaction`, `retry_room_delivery`, `get_email_draft`,
  `answer_action_review`, `save_review_rule` (personal scope), the dynamic-routine tick (`ensure_dynamic_routine_run`;
  scheduled firing moved to 2c part 1), coding attach, #419's machine fence
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

  **Built in slice P13 (SQL test 838; no migration).** The founder's decision of 3 October 2026 drops the snapshot-v1
  digests. The test reads the installed functions, so every hosted-db run checks them, a release branch's included:
  - no function of the folder core takes the gc fence, or the company row `FOR UPDATE` or `NOWAIT`. Any other
    function that does must test the core first, or be on the test's list with a reason: the fence itself, a legacy
    path that folder-v2 never reaches, an open folder-v2 site with its owner, or a partial one (it tests the core
    first, but a folder-v2 branch still takes the lock). A listed function that is gone or now tests the core first
    (a partial one: no longer takes the lock) must come off the list;
  - every function that changes a job's status or lease owner takes the job `FOR UPDATE` first (or in the same
    statement);
  - only the run mutex's functions name `qorpera_execution_run_budgets`. On folder-v2, `qorpera_folder_tool_run` takes
    it `FOR UPDATE` before it enters the run (and takes the job), and the receipt begin and the transcript's callers go
    through `qorpera_folder_tool_run` first;
  - the folder fence `FOR UPDATE`, or updated, only in the pause's and deletion's drains and resume; `FOR NO KEY
    UPDATE` only in member management, creation, the operator's start, founding and deletion's entry; never
    `FOR SHARE`;
  - no deferrable constraints or triggers on `qorpera_folder_%` tables. On the other tables the folder core's
    functions write, each deferred constraint is listed with why it is light: an empty foreign key on agents, the
    native presence clean-up (SKIP LOCKED), the coding turn checks and a session input's foreign key.

  Every list fails on a stale entry, so a renamed function or table never passes silently. The test reads function
  text with comments removed, and counts a function as testing the core when a core literal or a call into the
  folder core comes before its first such lock. That is a careful reading, not a proof: the list's reasons are the
  evidence. The full rank order and lock upgrades inside folder-v2 bodies are not read from text; the race tests
  (633, 644, 648, 812 and the slices' own) and the C1e load test check those by running them.

  The open sites on 4 October 2026 (inventory §16, and the review of #779), by owner:
  - S1: identity recovery and retirement;
  - A1: office activation wakes (C1c-3l);
  Office access (C1c-3k part 2), the quiet coding check-ins (`20260930026000`), the sign-in machines (P13, §6.14), and
  a run's machine and node update drains (C1c-3n, §6.15) moved off the list on 4 October, and so did artifacts with
  `20260930041000`: a member's `register_artifact_v2`, or a run's artifact output, inserted an artifact with no core
  test, and the artifact triggers, graph completion and the GC plans then took the gc fence. Every artifact path and
  member function that would take it now refuses folder-v2 first (0A000), which 838 pins, and the artifact entries are
  `legacy`.
  Each slice removes its lines from 838's list as it moves its sites; a partial line pins its core test's text, so a
  changed test fails until the line is checked again. The test prints the open lines as a NOTICE, which a failing run
  shows.
- **Deletion drains the folder fence** for `folder-v2` (C1C §5.5): the folder pause's second phase, with no gc fence.

### 6.1 Inventory, split and decisions (2026-09-29)

The inventory (scratchpad `reports/C1c3-inventory.md`) covers every site above and finds more: the founding lobby,
invitation joins, model logins and account refresh, identity recovery, a run's machine reservation, node update drains.
It splits C1c-3 into thirteen PRs, in dependency order: 3a (a member's posts and writes, below), 3b (the answers:
`answer_interaction`'s thread branch, `finish_email_draft_action`, `answer_action_review`), 3c and 3d (member
management and its triggers, joins and the founding lobby), 3e (the dynamic-routine tick), 3f (the compute fence and
company machines), 3g (deletion drains the fence), 3h and 3i (coding machines, attach and turns), 3j to 3l (offices,
screens, agents starting the computer) and 3m (the activation checks, last). A real company needs 3a to 3e; Company
Computers and views need 3f, 3j, 3k and 3m too.

Decisions:
- **Member management serializes on the folder fence `FOR NO KEY UPDATE`**: remove, leave, role change, joins,
  founding and company deletion's last-member check. Every effect holds the fence `KEY SHARE`, which that mode does
  not block; stop and resume (`FOR UPDATE`) and other member management wait for it. No new row.
- **Plain conversations refuse `folder-v2`** (0A000) until C3 and C4 give them `folder-v2` runs: today their inputs
  would be accepted and never delivered. Their creators still run: `qorpera_ensure_staff_session` (web `api.ts`, cloud
  client `hosted-primary.ts`) and the seven `create_shared_session` functions open `folder-v2` conversations, and
  `ensure_staff_session` adds a kickoff input that nothing delivers (part 1's session materializer skips `folder-v2`).
  Nothing is lost, since every later input refuses. C3 and C4 refuse or deliver them. 3b's answers keep the gc fence
  on `folder-v2` until 3b. Legacy sweep D15 (20260930414000) later dropped the seven `create_shared_session`
  functions.
- Who creates a `folder-v2` office, and who owns the machine-event and worker drains on `folder-v2`, are decided with
  3f and 3j. 3f decided the drains: they go with 3i (§6.5).

### 6.2 C1c-3a as built (migration 20260928289620, tests 660 and 661)

- `qorpera_folder_company_enter(env, profile, targets, refuse_paused)`: the prelude of a member's action without a
  run: the pause (refused when asked), the fence `KEY SHARE` with the pause read again, rank 0, then the targets at
  ranks 1 to 7 as the run entry locks them. The company row is never a target; ranks 8 and 9 are not taken.
- **Posting** (`qorpera_folder_post_room_message`): the enter helper with the poster (rank 1), the room's agents
  (rank 2), the room `FOR SHARE`, and the poster's and the agents' memberships `KEY SHARE` (rank 4); the agents read
  again under those locks, a changed set refusing as a retryable conflict (QRC01, 661 C); the conversation `FOR
  UPDATE`; the input and mentions; the transcript events (the operation clock), then admission, which is the last lock
  before the folder clock (661 K: a coworker message holds the clock and then wants admission); admission only when a
  wake follows; the wakes. Images refuse first, before the pause and the login (660 §3), until C1d. A group chat with
  no agent posts without admission; F2's group files need two agents, so on `folder-v2` that happens only once none
  of a chat's agents is active any more, for example all archived (660 §4 uses hand-built rows). Since legacy sweep
  F1e (20260930248000) `qorpera_post_company_room_message` only calls it.
- **The room `FOR SHARE` is a named exception to core §9** ("`FOR KEY SHARE` for rows referenced"). Snapshot-v1
  posting took its room `FOR SHARE` too.
  - A save that changes a group chat (F2's group hook) takes the room `FOR NO KEY UPDATE` at rank 4 and names no
    conversation. It writes the clock in an earlier unit (another chat's rename, an agent's edit) before it updates this
    chat's conversation.
  - With the room only `KEY SHARE`, a post holding the conversation and wanting the clock met such a save holding the
    clock and wanting the conversation: a deadlock (review r1 B1). A membership change also landed beside a post past
    its recheck, which then refused at its wake with 42501, not QRC01.
  - With `FOR SHARE`, the save waits at the room before it writes: a two-chat rename (661 I), an agent or the poster
    leaving (661 J), and the same for a retry (661 L).
  - Nothing else conflicts: runs hold group rooms `KEY SHARE`, thread-room writers already took `FOR UPDATE`, and within
    rank 4 rooms come before members, in key order.
  - F2 naming the chat's conversation at rank 11 (§5.9, test 10b) would make the exception unnecessary.
  - C1c-3b's answers take the thread room `FOR SHARE` too (§6.3).
  - Not held off: an agent archived while a post waits (the staff row `FOR NO KEY UPDATE` and its own thread rooms, not
    the group chat's room). The post then refuses at its wake (42501 "Wake recipient authority is unavailable"), and
    the member posts again.
- **A room delivery's retry**: its job and run locks first, as today, then the enter helper in place of the gc fence
  (the room `FOR SHARE`, as a post takes it; its targets are optional, since the checks after them refuse as today), and
  admission before its wake.
- **An email draft** takes neither the company row nor the fence on `folder-v2` (it names the company in no row it
  writes): the conversation, the draft, the action.
- **A member's own review rule**: the company row `KEY SHARE`, then the member's row `FOR NO KEY UPDATE`, where an agent's
  rule for that member serializes too (661 E); a member removed while the rule waited refuses (42501).
- **Refusals** (0A000): `append_session_input`, `request_session_turn` and its v2; the conversation attachment uploads;
  and any `folder-v2` input with images, inserted or changed (the upload check returned early for every company off
  the path gateway).
- Not in 3a: `member_manage_company_machine` goes with 3f. `member_office_catalog` takes the gc fence before checking
  membership on either core; that is fixed on its own (it affects live companies).

### 6.3 C1c-3b as built (migration 20260928319670, tests 662 and 663)

- `qorpera_folder_enter_agent_thread(session, member)`: the prelude of a member's answer in an agent's thread. It reads
  the thread room without a lock, then calls the enter helper with the member (rank 1), the agent (rank 2), the room
  `FOR SHARE` as a post takes it, and both memberships (rank 4). No target is required, since each caller's own checks
  refuse as today. It reads no pause: each caller reads the pause under the fence where it does today, so a replayed
  answer still returns its receipt while the company is paused (662 §2). It returns false, locking nothing, when the
  conversation is not an agent's thread.
- **An answer to a card** (`answer_interaction`): the prelude in place of the gc fence; the conversation `FOR UPDATE`;
  the input; the transcript events (the clock), then admission, then the wake (663 D). A group chat keeps its 22023; any
  other conversation refuses 0A000 before any lock, as plain conversations' inputs do since 3a.
- **An email draft's completion** (`finish_email_draft_action`, the secret broker): the prelude before its own
  conversation lock when the draft sits in an agent's thread (663 B). The answer it gives then takes the same rows again
  in the same modes, which never waits (core §9's activation check refuses only a stronger mode). The answer to a sent
  email now reaches the agent (662 §5); before, it refused at the wake and the completion swallowed the refusal.
- **The broker's claim** (`claim_email_draft_action`) takes the same prelude before its conversation lock (663 E). A
  claim of an action already completed (a double click, a retry after a sent email) replays the completion under that
  lock; with the prelude after it, an agent's rename of the thread's agent met the replay in a cycle (review r1 S1).
- **An answer to an action-review card** (`answer_action_review`): the prelude, the conversation, then the review
  (§5.7's card exception), "Always allow"'s company rule, the input, the events, admission, then the wake (663 C). A
  card still held by a call takes the input and the events only, with no admission. A card outside an agent's thread
  refuses 0A000.
- **Refusal order.** On `folder-v2` the answers' new refusals (a group chat's 22023, a plain conversation's 0A000) come
  before the cleanup refusal, the argument checks, the author and approver checks and the replay receipt. No
  `folder-v2` company holds data that would show the difference: cards left group chats before `folder-v2` existed.
- **The rule cap is not serialized.** "Always allow" inserts a company rule row (F2-4 keeps it a row until C3) with
  no company row `FOR UPDATE`, so two answers at once can each pass the 48 KiB check and go over by one rule. The cap
  bounds the reviewer's prompt; it is not an invariant, and `folder-v2` companies keep their rules in `rules/` (F2-4's
  saves there are not serialized with "Always allow" either).
- **The thread room `FOR SHARE`** extends §6.2's exception to the answers. Today every writer of a thread room takes it
  `FOR UPDATE` (an agent's rename or archive, and member changes through `ensure_agent_thread_internal`), so `KEY
  SHARE` would also wait for them. `FOR SHARE` matches posting and would also hold off a future `FOR NO KEY UPDATE`
  writer of a thread room (663 A).
- Not in 3b: `prepare_email_draft_action` takes the draft `FOR UPDATE` and inserts an action row whose only foreign key
  names the draft, so it takes no company row at all.

### 6.4 C1c-3c as built (migration 20260928399690, tests 664 and 665)

- `qorpera_folder_member_change_enter(company, member, mode)`: the prelude of a member change, in core §3's order.
  Modes are `remove` (removing a member, or leaving), `role` and `join`. It takes locks only; the callers keep their
  checks and messages.
  1. **Removal only:** the jobs its connection revoke will end (queued or leased, paid by a connection the member owns
     in this company), `FOR UPDATE` in id order. They come before the fence: a run of the member's holds its job and
     then asks for the member row (665 A).
  2. The folder fence `FOR NO KEY UPDATE` (§6.1's decision). Effects hold it `KEY SHARE`, which this mode does not
     block. Member changes and joins wait for each other (665 B, E); stop and resume (`FOR UPDATE`) wait for them, and
     they for stop and resume, by the lock modes (a join caught behind a stop holds no invitation: 665 H).
  3. The company row `KEY SHARE` (rank 0). A join stops here; its own statements then take the invitation, the new
     member row and, in the thread trigger, the rooms and their conversations, in that order.
  4. **Removal only:** an open founding table's row `FOR NO KEY UPDATE`, which `founding_member_left` updates (before
     the members, as the founding lobby orders it).
  5. Rank 1 in key order: the member `FOR UPDATE`, and when the member is a founder, the other founders `KEY SHARE`
     (the guard's reads). The member's role is read under the fence, so the founders cannot change meanwhile. A
     member that does not exist ends the prelude here (the caller refuses with P0002).
  6. Rank 4: every agent thread room `FOR UPDATE` in id order. The thread trigger rewrites them and their room members.
     A post or an answer holding a room `FOR SHARE` makes the change wait there, before it writes (665 C).
  7. **Removal only**, rank 5 in C1B §8's order: the member's connections (model logins), then its compute identities,
     `FOR NO KEY UPDATE` in id order. Until P13 (20260930035000, §6.14) the identities came first, which deadlocked with
     a sign-in's completion: it holds the model login and then takes the identity through the sign-in's epoch trigger.
  8. Rank 8: the member's pending capture tickets, the grants it issued (and, for a removal, the grants on its own
     secrets), then its own secrets, `FOR NO KEY UPDATE` in id order.
  9. Rank 11: the conversations the change writes, `FOR UPDATE` in id order: the agent threads and, for a removal, the
     member's open private conversations.
  The delete or update that follows fires the foreign-key cascade first (the member's presence devices), then the
  triggers in name order: the browser membership revocation, vault rows, the founding row and seats, the threads,
  access state, private conversations and their execution bindings, compute identities, connections and, through the
  connection cascade, the jobs. The rows the prelude locks are found held, in the same or a stronger mode. The rest
  are not pre-locked, and none can close a cycle (review r1 N1, by pgrowlocks before and after the delete):
  - room members: every other locker takes the room first, in a mode that conflicts with the room `FOR UPDATE`;
  - the operation clock: taken at the first conversation write, after rank 11, as everywhere;
  - access state, browser revocations, presence devices and execution bindings: no other writer holds them across a
    lock the change needs (access state's other writer, `stop_company_work`, takes the company row first; on `folder-v2`
    since 3g, the fence `FOR NO KEY UPDATE` and rank 0 in the request, the drain and the row `FOR UPDATE` in the
    finisher, §6.10);
  - a removed member's run-owned rows (assignment, reservation, native lease, inputs, wakes): behind its job, which
    the prelude holds first.
  The steps the tests do not pin are defensive: rank 11, the other founders' `KEY SHARE`, the founding row, the vault
  rows, and the guard's company-row `KEY SHARE`. The connections and compute identities are pinned since P13 (900 D).
- **Removing a member, leaving and a role change** take the prelude in place of the company row `FOR UPDATE`. A role
  change takes the member row `FOR UPDATE` too, which the function then takes again: with `FOR NO KEY UPDATE` first,
  the change would take the rooms and then wait to strengthen the row behind a run's or post's `KEY SHARE`, while
  that post waited at a room the change holds (665 G; 40P01 with the weaker mode).
- **The founder guard** takes the company row `KEY SHARE` on `folder-v2`, for its "being deleted" check. The fence
  serializes the departures it compares: two founders leaving at once meet there, and the second sees no founder left
  (665 B). Its marker text is unchanged. A member change never waits for a company-row `KEY SHARE` holder (665 D).
- **Joining by invitation** takes the fence and the company row before the invitation row (reading the invitation's
  company once). Deletion's stop removes invitations, so a join that took the invitation first would meet it in a
  cycle (665 H; 40P01 with the prelude after the invitation).
- **Hiring or activating an agent** (F2's hook, `qorpera_folder_structured_targets`): a save of an agent that has no
  thread room yet names every member row `KEY SHARE` at rank 1. That is a new agent, or one first saved archived (a
  staff row but no room) and now activated. The room the save creates copies the roster without a lock
  (`ensure_agent_thread_internal`) and is not yet visible to a member change's rank-4 lock, so before this a removal
  or a demotion could commit beside the save and leave the member active in the new thread (a new viewer could then
  post there; review r1 S1, r2 R1). Now they meet at the member rows (665 F: a hire beside a removal and a demotion,
  and an activation beside a removal). For an agent that has a room, a rename or a status change already names that
  room at rank 4, where a member change meets it. The state files doc records the branch next to the hook's other
  targets.
- **Views are not closed.** A removed member's view refuses at its next use: resolving it checks membership, and its
  commit takes the member row at rank 1.
- Not in 3c:
  - `delete_hosted_profile` still takes the company row `FOR UPDATE` (through `request_company_deletion`'s gc fence);
    3g owns deletion. A join serializes with it at rank 0 meanwhile. (Done in 3g, §6.10: the fence `FOR NO KEY UPDATE`.)
  - A job queued for the member's connection after the prelude's read still reaches the connection trigger's job
    lock late; 3d gives the triggers `NOWAIT` modes that refuse retryably (built in 3d-1, §6.6). No job creator
    serves `folder-v2` before C3/C4. Account deletion cannot end the member's own runs:
    `runner_jobs.created_by_user_id` is `ON DELETE RESTRICT`, and a member's login pays only for work that member
    started.
  - Pre-existing, for 3d: capture completion and secret rotation take vault rows before the creator's member row
    (`FOR SHARE`), against a removal's rank order; a joiner misses an agent thread created at the same moment (on
    master too; still open after 3d-1, §6.6). For 3g: the last member's leave during the purge can meet
    `finish_company_deletion` once (40P01, which heals: finish retries and the leave refuses). Likewise 3f's sweep of
    stopped task machines (§6.5): while it waits at a `folder-v2` company's row it holds that company's fence `KEY
    SHARE`, and the purge's cascade wants the fence `FOR UPDATE` while it holds the row. Both must land within
    milliseconds of one admission pass (a deletion request committed after the sweep's cursor opened, then a finisher
    tick), and it heals: the pass retries next pass, or the finisher's 40P01 or 5 s lock timeout retries next minute.
    3g's deletion drain takes the fence `FOR UPDATE` before rank 0, so the sweep's fence `NOWAIT` then skips the
    company.
  - The founding lobby's own functions (`lock_company_founding`, `remove_company_founder`, `respond_company_founding`)
    go with 3d (built in 3d-1, §6.6).

### 6.5 C1c-3f as built (migration 20260930002000, test 824)

- `qorpera_folder_machine_fence(company)`: a machine path's company locks on `folder-v2`. It takes the folder fence `KEY
  SHARE` (stop and resume wait for it; member changes, `FOR NO KEY UPDATE`, do not), then the company row `KEY SHARE`
  (rank 0). It reads no pause: the paths that end a machine must run while the company is paused, and the node
  reservation reads the pause again after it, as before.
- **The executor** (`company_machine_fence_briefly`, still under its 2 s `lock_timeout`) takes it. Custody (suspend,
  release, running, commands, the executor's authorization) then locks the machine, the placement, the allocation, the
  node and the demand. Admission takes the company-machines advisory lock and the machine first, and placing takes the
  executor row before the allocation. Behind a stop's second phase, admission waits at most its 2 s and leaves the company
  for a later pass (824 A).
- **Placing a machine and reserving its node** take it again. Every caller already holds it in the same modes (admission's
  brief fence, or a run's folder tool run), so it never waits. **Suspend and release** skip their second gc fence, which
  custody's fence replaces (824 C2).
- **The reservation branches for the `machine` kind only** (824 B2). Coding (3h) and office (3j) reservations still come
  from callers that take the gc fence first, and a folder fence taken under their company row would come after rank 0,
  against core §3's order.
- **A member's start, stop or delete**: the fence, rank 0 and the member's row `KEY SHARE` (rank 1), then the member's write
  access read again, before the advisory lock and the machine. Before, the gc fence was taken before the machine was even
  looked up, so any member who could write could hold a `folder-v2` company row `FOR UPDATE`. A removal in flight makes the
  start wait at the member row, and then refuse (824 G).
- **The sweep of stopped task machines** (admission's last loop) takes a `folder-v2` company's fence `KEY SHARE NOWAIT`: a
  company being stopped is swept on a later pass. It then takes the company row `KEY SHARE`, never `FOR UPDATE NOWAIT`.
  - That wait is only behind a holder of the row stronger (824 E3), which until 3g may want locks the pass holds.
    Deletion's gc fence wants the company's machine lock and machines next, and the pass's disk give-up holds such
    locks: it takes no fence and keeps them to the end of the pass. A node update drain locked several companies' rows in
    id order (`authorize_node_update_drain`, `node_update_locked`; since C1c-3n only their fences `KEY SHARE` on
    `folder-v2`, §6.15), and deletion's finisher handles several companies in one transaction; an earlier sweep in the
    pass holds other companies' rows.
  - So the sweep waits for a `folder-v2` company's row only while the pass has given up no disk and holds no other
    company's row. Otherwise that company waits a pass (824 E4, E5). A pass that waits holds nothing such a holder wants
    but that company's own fence `KEY SHARE`, which only deletion's purge wants (see the 3g note in §6.4).
  - A pass can still wait behind another old gc-fence holder of the row (a sign-in, until §6.1's other sites move).
  - It inserts no wake, so core §3 step 10's one-company rule does not apply.
- **Giving up a disabled executor** takes each `folder-v2` company's fence in place of the gc fence, in the same id order.
- **An agent's `machine_start`** serves `folder-v2`: its refusal line gave way to the marker. Its authority check is the
  folder tool run (the run mutex, the job, the fence, rank 0), then the receipt, the advisory lock, the machine and the rows
  admission takes (824 B shows it runs beside a folder effect). Its final authority check takes the same rows again in the
  same modes.
- **Snapshot-v1** keeps each patched statement in the `else` branch. Each body with its branch reversed is byte for byte
  the definition before 3f (824 H until 3 October; legacy sweep A, #829, removed that digest).
- **Decided with 3f** (§6.1): the machine-event drain on `folder-v2` goes with 3i; the worker drain is F2's (F2-5b-3,
  the shared folder drains' `workers`). Both deliver to a
  parent run and need the per-company admission loop (`qorpera_drain_machine_wakes` skipped `folder-v2` until legacy
  sweep F3b, 20260930295000, dropped it; until 3i, a
  `folder-v2` run is not told when its machine is running or its command ended). Who creates a `folder-v2` office stays
  with 3j.
- Not in 3f:
  - the coding and office kinds of the reservation (3h, 3j);
  - a run's own machine reservation and model logins (§6.1's other sites: C3 at the latest);
  - `stop_company_work`'s machine stop, under deletion's gc fence (3g).
  - `record_company_machine_error` updates one machine row and takes no company lock, on either core.
- **Legacy sweep F2c (20260930292000)** left each of these paths only its `folder-v2` branch: the executor's brief fence,
  placing, custody's suspend and release, a member's start, stop or delete, the sweep and giving up an executor lost
  their gc fence. A company without a folder fails in the machine fence (42501 "Company folder is unavailable", 824 A
  and D), and the sweep skips it (824 E). 824 E5 now sweeps a second `folder-v2` company's machine first. The node
  reservation takes the machine fence for every kind (§6.8, §6.15), and the machine, always-on and coding check-ins
  ask on every company.

### 6.6 C1c-3d-1 as built (migration 20260930002650, tests 817 and 818)

- **Joining by invitation** (#581 N1). The join's prelude runs only for the invitee of a live invitation: its email and
  expiry are in the prelude's `WHERE`, as in the select that follows, so a caller the join refuses (P0002) takes no
  fence (818 A, 817 §2). The `join` mode now also takes the joiner's member row if it exists `FOR NO KEY UPDATE`
  (rank 1: an existing member accepting an invitation updates it), then every agent thread room `FOR UPDATE` (rank 4)
  and their conversations `FOR UPDATE` (rank 11), in id order, before the invitation, so the thread trigger finds them
  held. A join beside a post waits at the room, holding no invitation, and lands (818 B); an existing member's join
  waits at its own member row before any room (818 E3: a thread's model change holds the member row `FOR SHARE` and
  then the room). 657 E2 now runs the real join.
- **The founding lobby.**
  - `lock_company_founding` on `folder-v2` takes the folder fence `FOR NO KEY UPDATE` (a seat taken or given up is a
    member change), the company row `FOR NO KEY UPDATE`, then the founding row, as before. The table's name is the
    company's, which `update_company_founding` writes, so a weaker mode would be strengthened there; effects' `KEY
    SHARE` does not wait for it (818 F i). The plain seated check stays first. `open_company_founding` takes the fence
    and the company row the same way.
  - `remove_company_founder` takes the removed founder's jobs first, before the fence (core §3 step 2), through the
    prelude's new `jobs` mode. It does so only for a caller the checks under the lock let through, read first without a
    lock, so a founder the table refuses never waits at the job (818 F iv). If that read is stale (the seat was taken
    just then), the removal's own prelude takes the jobs after the fence instead: a wait holding the fence, not a cycle
    (a run holding its job asks only for `KEY SHARE` rows here).
  - `respond_company_founding` takes the thread rooms and conversations as a join does, before its member row: a seat
    taken beside a post waits at the room (818 F iii) and behind a member change at the fence (818 F ii).
    `start_company_founding` takes the member rows its role changes write (and the starter's) `FOR NO KEY UPDATE` in
    key order, then the rooms and conversations the same way, before its role changes (not raced: C2's seed is still a
    stub).
  - The order on `folder-v2`: the jobs (a removal only), the fence, the company row, the founding row, the seat, then
    the member change's ranks (existing member rows, then rooms, then conversations; a new member's row is an insert
    after them).
  - An invited seat holder passes the plain seated check, so `update_`, `invite_`, `set_founder_role`,
    `set_founder_ready` and `start_` take the fence before refusing it (42501). Accepted: the caller is a founder's
    invited friend, and before this the same call took the company row `FOR UPDATE`.
- **Trigger modes**, for rows no prelude took: an account deletion (`auth.users` cascades into member rows with no
  prelude), or a row that appeared after the prelude's read.
  - The connection cascade (`cascade_provider_connection_unavailability`) takes the jobs it ends `FOR UPDATE NOWAIT`
    in id order on `folder-v2` when the login's owner is no longer a member: its departure, earlier in the same
    transaction. (An account deletion of a login's owner or creator refuses with 23503 before the cascade:
    `owner_user_id` and `created_by_user_id` are `ON DELETE RESTRICT`.) A job queued for the member's login after the
    removal read its jobs, and held by a tool call of its run, refuses the removal; the retry lands (818 D). Any other
    status change (a member's Disconnect, an authorizer's disable, the node-login switch-off, which catches its own
    `lock_not_available`) waits for the job as before (818 D, and 818 G for the company's own login, which has no
    owner); its order against a tool call is 3d-2's.
  - The thread trigger's locks (`folder_lock_agent_threads`, `folder-v2` only) take the rooms and conversations
    `NOWAIT`. An account deletion beside a post refuses (818 E), and so does a member row written with no prelude
    (657 E2).
  - A refusal is `PGRST` with `QRC01` and HTTP 409, retryable (never 40001: test 361). A row a prelude holds is taken
    again at once, so member functions, joins and seats meet it only for a room a hire created between the prelude and
    the trigger that a post into the new thread holds.
  - The private conversations' trigger keeps its waits: an account deletion of a member with a private conversation
    refuses with 23503 anyway (`qorpera_shared_sessions.audience_user_id` is `ON DELETE RESTRICT`).
  - Existing member rows come before rooms (rank 1, then 4) in joins and Start, as in removals; a new member's row
    (a join's or a seat's) is an insert after them. Review r2 found the order the other way round (rooms first) met a
    thread's model change (`qorpera_session_model_writer`: the member row `FOR SHARE`, then the room) in a cycle
    (40P01).
- **The thread refresh** (`ensure_agent_thread_internal`) skips the conversation update on `folder-v2` when the title
  and the status stay. Joins and role changes then write no conversation state operation and take no operation clock
  for the threads (817 §2); a changed title is still written (817 §3).
- **#581 N2:** an answer to a card and a member change meet at the thread room, in both orders (818 C).
- Snapshot-v1 keeps every path: each patched body with its patch reversed is the definition before (817 §1; 664 §1 now
  strips the join's new prelude text). No snapshot-v1 digests since 3 October: legacy sweep A, #829, removed 817 §1's
  and 664 §1's.
- Not in 3d-1:
  - A joiner still misses an agent thread created at the same moment (on master too). The hire is an effect (the fence
    and the member rows `KEY SHARE`) and the joiner's member row does not exist yet, so nothing both lock conflicts. It
    heals at the next member change or agent save that refreshes the thread. Closing it needs a conflict point in the
    hook, for example the company's open invitations and seats named at rank 1.
  - The vault order (capture completion, rotation and seal against a member change; Disconnect, grant and share against
    a `folder-v2` tool call) is 3d-2.
  - Deletion's last-member check and its fence drain are 3g.
  - Account deletion stays an operator action without a prelude. In a busy company it can refuse repeatedly: any open
    transaction that writes into a thread holds its conversation `KEY SHARE`. Many members cannot be deleted at all
    (23503): a login's owner or creator, a private conversation's member, anyone who ran, posted or connected. An
    account close function that runs the prelude per company, one company per transaction, is the fix.

### 6.7 C1c-3d-2 as built: the vault's order (migration 20260930003500, test 850)

On `folder-v2` an agent's tool call takes the company row only `KEY SHARE` (rank 0), so #660's key share orders nothing
there: a vault change and a tool call, or a vault change and a member change, met in the vault rows and could
deadlock. Rank 8 now has an inner order, the one the tool call (`native_connector_locked_grant`: its grant, then the
grant's secret) and the member change's prelude (tickets, grants, secrets) already take: **capture tickets, then
grants, then secrets**, each by id, with the member row (rank 1) and the agent's staff row (rank 2) before them. Each
change below takes it on `folder-v2` only (`qorpera_company_is_folder_v2`); snapshot-v1 keeps its order (800).

| Change | Before | Now (`folder-v2`) | Test 850 |
|---|---|---|---|
| Disconnect (`revoke_cloud_secret`) | secret, then its grants | its active grants, then the secret | A |
| Grant one operation (`grant_cloud_secret_operation`) | secret, then the agent's staff row | staff row, then the secret | F |
| Share (`grant_cloud_connector`) | secret, then the (agent, tool) grants it replaces | those grants by id, then the secret; a secret of another company or environment locks nothing | B, H, J |
| Seal (`complete_cloud_secret_capture`) | ticket, then the creator's member row; for a company connection the secret (or none, a first capture), then (sharing) the grants by agent and operation | the creator's member row, then the ticket; for a company connection the grants by id, then the secret | C, D, I |
| Rotation start (`begin_cloud_secret_capture`) | secret and stale tickets, then the insert trigger's member check | the caller's member row, then the stale tickets, then the secret; a ticket that expired while it waited is taken `NOWAIT` | E, K, L |

`share_company_connection` is left as it is: the seal is its only caller and then already holds the grants it writes.

- **Test 850** builds each deadlock deterministically on 648's committed fixture: a holder keeps one row (a grant, the
  agent's staff row, a ticket, a secret) so the others queue behind it in the order that deadlocked before. The
  change must wait where the order puts it and leave the secret free (a `NOWAIT` probe), and once the holder commits
  each lands (no 40P01): A Disconnect against an agent call, F one grant against the staff row (standing in for an
  archive), B a share against an agent call, C a company rotation's seal against an agent call, D a first capture's
  seal against the owner demoting its creator, E a member's rotation start against the owner removing them, I a first
  capture's seal against a Disconnect taking the same grants by id. H: a share of another company's secret is refused
  (P0002) without queueing behind a grant. K and L time a rotation ticket to expire while a rotation's start waits for
  the secret: with no seal the start expires it and lands (K); with the broker's seal holding it, the start is refused
  with 55P03 and the seal lands (L).
- **Grants created while a change waited.** A change locks the grants it will write before the secret, so one
  created meanwhile is not among them. A Disconnect takes a grant on its secret that it did not pre-lock `NOWAIT` once
  the secret is held (an agent call may hold it and wait for the secret); a share or a seal
  (`grant_cloud_connector_operations`) takes every grant it did not pre-lock `NOWAIT`, whichever secret it is on (its
  holder may wait for a grant the change holds). Either way 55P03 (never 40001: test 361): a member's action can be
  tried again; a seal refused this way fails as the broker's "Cloud secret capture was not confirmed", and the member
  connects again. Raced
  deterministically: G (a Disconnect, with the grant committed while it waits and an agent call on it) and J (a share,
  with a new grant on another secret held as an agent call would). The member-facing refusal reaches the web client
  with Postgres' own wording; #705's member changes map theirs to QRC01.
- **Body markers:** every patched function names `20260930003500` in a comment, for the deploy guard.
- Not in 3d-2: an account's own rows (`company_account_*`) stay refused on `folder-v2` until A1-7 (P22). Archiving an
  agent (`qorpera_revoke_secret_grants_for_inactive_staff`) still revokes its grants in scan order, as it did before:
  against a vault change that now locks by id it can meet in the opposite order. A follow-up locks the agent's active
  grants by id first on `folder-v2`.

### 6.7 C1c-3j as built: the Company Computer's lock, creation and start (migration 20260930012000, test 893)

The coordinator's P06a (plan `outputs/company-accounts/p06-office-folder-v2-plan.md`). Until now no folder-v2 office
could exist, and every office path took the gc fence (the company row `FOR UPDATE`). On folder-v2:

| Path | Before | Now (`folder-v2`) |
|---|---|---|
| `assert_runtime_office_provider` (33 callers: start, activation, screen heartbeats, lifecycle, reset, software, package, delete) | gc fence, office | 3f's machine fence (the folder fence and rank 0 `KEY SHARE`), office |
| Provider set, office reservation (`reserve_runtime_machine`'s office branch, `reserve_runtime_node_machine`'s office kind) | gc fence | machine fence |
| A member's start, cancel, withdrawal and status; the provider's reserve and check (and their wrappers, before the assertion); the fleet offer and placement; the office's activation and its startup lock (`activate_runtime_office`, `lock_runtime_office_startup`, before the assertion) | gc fence, office, then the start's member or agent | `qorpera_folder_office_enter`: machine fence, the acting member and the start's requester (rank 1), the requesting agent's staff row (rank 2), then the office |
| `member_office_catalog` | gc fence, member | machine fence, member |
| `register_runtime_office` (a company's first computer) | gc fence; refused (path gateway 1 only) | machine fence, the owner or admin's member row, the seat lock (a second first registration waits and returns the same computer), the office rows |
| `check_runtime_office_adoption` with a non-empty mapping (a replaced computer's screens) | gc fence, office, then the mapping's agents and members | refused with 0A000 before any lock; C1c-3k keeps the refusal (mappings come only from adopting a legacy computer, §6.11) |
| Gates (registration, start source, guest binding, office reservation) | `path_gateway_version = 1` | also a ready folder-v2 Company File |
| The interlock trigger | gc fence on every company-computer write | returns first: a folder-v2 company has no version-1 cutover |
| A hire's default access (`runtime_office_default_access_for_staff`) | offices in scan order | offices by id (both cores) |

- **Legacy sweep F2a (20260930290000)** left the start chain only its folder-v2 mode: the assertion, provider set,
  member start, cancel and withdrawal, the provider's reserve and check, the fleet offer and placement, activation, its
  startup lock and registration lost their gc fence branch, so a company without a folder fails in the machine fence
  (42501). A member's start status is plain reads on every company, so a member of such a company gets an answer.
  Registration, start source, guest binding and restart surfaces accept only a ready folder-v2
  Company File (`path_gateway_version = 1` is gone), and adoption refuses a non-empty mapping on every company.
  `member_office_catalog` and the office reservation follow in later F2 steps.
- **Legacy sweep F2b (20260930291000)** left a computer in use only its folder-v2 path. `member_office_catalog`, a
  screen's open, the access grant, the screen events and observations, and a member's new computer take the machine
  fence on every company, so a company without a folder fails in it (42501); an agent's start fails in its tool run.
  The access status is plain reads, the start descriptor shares the active agents, and a hire's default access takes
  the seat locks, all on every company. The office preludes run on every company too: the viewers' and the browser
  grant's member rows, and a private heartbeat's and a successor activation's fence. The shared surface, an agent's
  screen and the start descriptor accept only a ready folder-v2 Company File; screenshots keep only §6.21's path;
  shell check-ins ask on every company. The office reservation follows in F2c.
- **Legacy sweep F2c (20260930292000)** left the office reservation only its `folder-v2` path:
  `reserve_runtime_machine` takes the machine fence on every company, and its office branch accepts only a ready
  `folder-v2` Company File (`path_gateway_version = 1` is gone).
- **Who creates a folder-v2 office** (the coordinator, 3 October): the folder mode of `qorpera_register_runtime_office`,
  called as the company's owner the first time the company needs its computer. Today no product path registers a
  company's first computer (later ones come from `add_runtime_office_computer`); the coordinator does it, and P38
  registers the proof company's (core §11). P14's creation commit makes no office.
- **The hire-vs-start deadlock** the gc fence hid: a hire, or an agent's return, takes the agent's staff row and then,
  through its default office access, each office's revision (the browser grant). A start took the office and then
  shared the agent's row in its start-source check. On folder-v2 the start shares the agent's row (and the members)
  before the office, which is the hire's order (staff rank 2 before offices). Test 893 C builds it: the start waits at
  the staff row holding no office, and the return lands. Activation and its startup lock run on every first start, so
  they take the same prelude (review r1: before it, the startup check waited at the owner's member row while holding
  the office; harmless while only members start, a cycle once C1c-3l lets agents start).
- **Test 893** (648's committed fixture; each "must not wait" call is sent while another session holds the company row
  `FOR NO KEY UPDATE`, which lets `KEY SHARE` through and stops anything stronger). Folder-v2 only: by the founder's
  decision of 3 October (production's companies are wiped, snapshot-v1 compatibility is dropped) it has no snapshot-v1
  case and no old-text digests.
  - A, A2, A3: registration; a second registration that waits at the owner's member row (a role change) holding no
    office, then returns the same computer; one that waits at the seat lock;
  - B: the catalog;
  - C, C2: the hire-vs-start deadlock above, through the provider's reserve wrapper; a member's start waiting at the
    member row holding no office;
  - D: status and cancel;
  - E, E2: the provider's other calls (assertion, provider status and set, check wrapper, reserve body, placement,
    offer, office and node reservations), the member's withdrawal and before-idle; the office reservation answers
    `reserved` and the node reservation reaches its provider check, so both gates and the office kind's fence are open;
    the guest binding passes its gate;
  - F: a folder-v2 adoption with screens refuses at once under the hold;
  - G: a first start end to end (request, reserve, prepare, ready); the preparation, the startup check and the
    activation each wait at the owner's member row holding no office, then land;
  - H: the ordered office walk, and exactly 25 bodies naming the migration (24 patched functions and the prelude).
- **Until C1c-3g**, an office path waiting at rank 0 behind a company deletion's gc fence holds the folder fence
  `KEY SHARE` that the purge's cascade wants: one 40P01 that heals on retry, as for 3f's sweep (§6.4).
- **Not in 3j:** screens and their events and observations, the shared surface and restart-surface gates, access
  configuration, the member's agent-office call (C1c-3k; the adoption mapping stays refused, §6.11); an agent's start, the
  descriptor and the activation-wake drain (C1c-3l). Capture and export stay refused (C1d, C3).

### 6.8 C1c-3h as built: coding machines (migration 20260930002300, test 826)

- **The company first, on the folder fence.** Every coding machine call that needs the company took the gc fence first
  (runtime v123, 20260925123000), which locks the company row `FOR UPDATE`. On `folder-v2` these calls take 3f's
  `qorpera_folder_machine_fence` in the same place: the folder fence `KEY SHARE`, then the company row `KEY SHARE`.
  - A turn's admission to its machine (`authorize_coding_machine_run`) and a plan (`plan_coding_machine`) take it
    before the worker and the session.
  - A plan takes it again before it inserts a member's new machine. The gc fence did that so two new members could not
    both upgrade a key share; `KEY SHARE` is never upgraded here.
  - Sleep (`suspend_coding_machine`) and release (`release_coding_machine`) take it before the machine.
- **The node reservation** (`reserve_runtime_node_machine`): 3f's folder branch now serves the coding kind as well as the
  machine kind. Its callers above hold the folder fence already, so it never waits. Offices keep the gc fence (3j).
- **What it means:** a folder effect (the fence and the company row `KEY SHARE`) never makes these calls wait (826 A).
  A stop's second phase (the fence `FOR UPDATE`) makes them wait at the fence before any coding row or the company row
  (826 B).
- **The pause is not read before the fence**, as in 3f's machine paths. Under the gc fence a new caller queued behind a
  waiting stop; under the fence `KEY SHARE` an admission or a plan that arrives after the pause is let in and makes the
  stop's second phase wait until the reservation reads the pause and refuses. Core §9 and the inventory (§11) ask for
  a pause check first: left for the load test (C1e), with 3f's paths.
- **Until 3g:** a coding call holding the fence `KEY SHARE` can wait at the company row behind the deletion finisher,
  whose purge wants the fence row (it deletes it by cascade): a 40P01 that heals on retry, as §6.4 notes for 3f. 3g's
  drain takes the fence `FOR UPDATE` before the company row and closes it.
- **Snapshot-v1** keeps each statement in its `else` branch, so the activation markers of 20260925123000 stay in each
  body. Each body reversed is master's text (826 D until 3 October: legacy sweep A, #829, removed the digests and kept
  the markers check), and the
  snapshot-v1 company still waits for a
  holder of its company row (826 C). 824 B2 is flipped: a `folder-v2` coding reservation no longer waits for the company
  row `KEY SHARE`, and 824 H reversed 3h's line before 3f's (no digests since 3 October; legacy sweep A, #829).
- **Inert until C3:** `manage_agent_worker` refuses `folder-v2` (the path actor), so no `folder-v2` coding session can be
  created yet. 3i brings the turn's admission (`begin_coding_turn`) and the machine-event drain; F2-5b-3 the worker drain.
- **Coding view saves** (the inventory lists tests against them for 3h): attach is unchanged, so they go with 3i's
  turn admission.
- Not in 3h: custody (`coding_machine_custody`, `authorize_coding_machine_custody`), attach and claim take no company
  lock and need no change; the secret broker's coding credential takes the company row `KEY SHARE` already (v123).
- **Legacy sweep F2c (20260930292000)** left each of these calls only its `folder-v2` line, so a company without a
  folder fails in the machine fence (42501). The gc fence lines, and with them 20260925123000's text, are gone: the
  activation template's check for that migration now looks for the folder fence line in each of the four bodies.
  Coding check-ins ask on every company. The claim's `folder-v2` filter and the worker locks' refusal stay (step G).

### 6.9 C1c-3e as built: a dynamic routine's next run (migration 20260930009500, test 819)

An agent's dynamic routine (`when: once`) gets its next run from the control-plane tick
(`qorpera_restore_dynamic_routine_runs`, inside the Company File drain that `reconcile` runs). That tick visits every
company in one transaction, so since C1c-2c part 1 it skips `folder-v2`, and a `folder-v2` dynamic routine never ran
again after its first (legacy sweep F3b, 20260930295000, dropped that tick). 3e gives it a `folder-v2` path with one company per transaction, as routine firing has
(`qorpera_folder_enqueue_routine_wake`, §5.6):
- **`qorpera_folder_dynamic_routines_due(after, limit)`** (service role) lists the `folder-v2` dynamic routines that may
  be missing their run, with the legacy tick's own filter, paged by routine id like the schedule heads, without a lock.
- **`qorpera_folder_restore_dynamic_routine_run(routine, expected version)`** (service role) handles one routine in the
  caller's transaction:
  - the folder fence `KEY SHARE` and the pause read under it, then the company row `KEY SHARE` (rank 0);
  - the version's member, agent and execution authority `KEY SHARE` (ranks 1 to 3);
  - the routine `FOR NO KEY UPDATE SKIP LOCKED` (rank 5): a save or a decision holding it makes this pass skip it
    (`busy`), as the legacy tick's `SKIP LOCKED` does;
  - the legacy checks, in the legacy order: the version and its single `once` trigger, a pending run, a live run, a
    member's Stop of the latest run (the routine pauses, once), the retry spacing, expiry and the occurrence limit;
  - the public session `KEY SHARE`, admission, then the insert, at the version's chosen instant or the retry's.
  It answers a status (`inserted`, `pending`, `running`, `changed`, `gone`, `not_folder`, `paused`, `busy`,
  `stopped`, `ended`, `suspended`) for every routine it cannot run. It raises for a caller that is not the service
  role, a missing fence or admission row, a wake whose audience changed under it (QRC01), and any other error; the
  reconciler reports those after its pass. A run the kernel refuses for want of authority (42501 from the wake's pin
  trigger) undoes the admission and the insert, suspends the routine and tells its member once, as the legacy tick
  does (`suspended`).
- The list leaves out routines at their occurrence limit (819 §8). Since 20260930027000 it lists those past their
  expiry, which the restore ends (below). A routine whose next retry would fall after its expiry is still listed, and
  answered `ended` every 30 s, until its expiry passes and the restore ends it. A raised 42501 (a missing fence or
  admission row) reaches the orchestrator as HTTP 401, which the reconciler reports like any failure; only a broken
  `folder-v2` company shows it.
- **`qorpera_ensure_dynamic_routine_run`** refuses a `folder-v2` routine (0A000) as its first line. It takes no fence
  and no ranks, and none of its callers reaches `folder-v2`: the tick skips it, and the agent tools refuse it.
- **The runner-orchestrator edge function** has two new actions, `folder_dynamic_routines` and
  `restore_dynamic_routine`. **The orchestrator's routine reconciler** calls them after the schedule heads, one restore
  per listed routine, at most every 30 s (`folderDynamicIntervalMs`), not on every poll. One routine's failure is
  reported after the pass and never stops the others. An edge function that predates the actions answers 400; the
  reconciler then reports it and asks again after ten minutes, as it does for the first-slot advance.
- **Deploy order:** the migration, then the edge function, then the orchestrator. An older orchestrator never calls the
  actions, and a `folder-v2` dynamic routine waits for it.
- Snapshot-v1 keeps its path: `ensure` with its first lines removed is the definition before (819 §1 until 3 October:
  legacy sweep A, #829, removed that digest). The legacy tick is unchanged.
- Not in 3e: the run itself (materializing a `folder-v2` wake) is C4's materializer (P28). Until then the inserted wake
  stays `queued`, and the list skips the routine (its run is pending). Like the legacy tick, the restore inserts the
  wake even when the company has no computer hours left; P28's materializer holds it ("Waiting for computer hours"),
  as routine firing's deferral does before admission.
- **Expiry (migration 20260930027000, test 889).** The legacy expiry sweep (`qorpera_expire_cloud_routines`) ran only
  inside the Company File drain, which P28 took out of the reconcile RPC. So the tick also ends `folder-v2` routines:
  - The list also names any `folder-v2` routine, of any origin and trigger, that is active or paused and past its
    `expires_at`, paused company included. A company being deleted is left to its purge (C1c-3g: effects
    refuse).
  - The restore ends such a routine first: the company row `KEY SHARE`, the routine `FOR NO KEY UPDATE SKIP LOCKED`,
    then `status = 'expired'`. It answers `ended`, or `changed` if the routine was extended, its end removed,
    retired or concluded meanwhile. The status triggers record whether it was active, and cancel a paused routine's
    queued runs. A routine held by a save answers `busy`, and the next pass ends it.
  - The legacy sweep has no caller now, so a `snapshot-v1` routine no longer expires; none remains.
  - Known: a later save of the routine's file revives it while the file still says `status: active` (F2's rule, test
    708 §4), and the next pass expires it again, until C2's queue writes the platform's status into the file.
  - An expired routine leaves the schedule heads, so the scheduler stops offering its slots, which the lifecycle
    trigger would refuse.
  - The routine file keeps its status until core C2's queue writes platform statuses into files (STATE "Status").

### 6.10 C1c-3g as built: deletion drains the folder fence (migration 20260930015000, test 828)

- **The request** (`delete_hosted_profile`, `request_company_deletion`): on `folder-v2` the fence `FOR NO KEY UPDATE`,
  member management's lock (3c), then the company row `KEY SHARE`, where they took the company row `FOR UPDATE` (the gc
  fence). A leave, a removal or a join in flight serializes with the last member's deletion at the fence (665 H: a join
  queued first joins, and the deletion then sees another member and refuses). A folder effect in flight (the fence `KEY
  SHARE`) is not waited for (828 A); once the request commits, every effect re-reads the deletion after the fence and
  refuses, but one already past its re-read can still commit for a few seconds after the request returns; the
  finisher's drain waits it out. No legacy wake-admission bump (folder effects never read it), in the request or in
  its stop. The stop's job pass still skips the jobs effects hold; the finisher ends them.
  - The request's stop now runs beside folder effects, where the row `FOR UPDATE` kept them apart. Its locks after
    rank 0 (jobs `SKIP LOCKED`, never waited for, and their termination: run events, wake occurrences, inputs; no
    conversation write or operation clock; then bootstrap jobs (none on `folder-v2`; legacy sweep D1, 20260930330000,
    dropped them and this step) and the folder creations not yet made, `SKIP LOCKED` (P14a); then coding todos, workers and sessions, the machine advisory lock and machines,
    invitations, seats, access state) come in the order every folder path takes them (3f's machines, 3h's coding calls,
    3d-2's vault, 3c's member management); no cycle found (review r2 traced the job end's triggers).
  - The old `FOR UPDATE` also waited for a transaction that had just inserted a row pointing at the company (a job
    enqueued just before). The request no longer does; the finisher's stop runs again after its drain.
- **The finisher** (`finish_company_deletion`) runs the folder pause's second phase for deletion,
  `qorpera_folder_deletion_drain`: the fence `FOR UPDATE`, which waits out every effect in flight (828 E), and its revision
  bump; then the company row `FOR UPDATE` as the purge takes it (review r1: the stop and the revocations hold jobs,
  secrets, grants and connections, and a broker seal holds the row `KEY SHARE` and waits for a secret); then the stop,
  the holdings and the revocations as before. The drain refuses a company with no deletion row, and accepts one with
  no pause row (a requester whose account is gone). So on `folder-v2` the purge, too, refuses a company with no
  deletion row: C5's reset must request deletion first.
- **The purge** takes the same drain, then the company row `FOR UPDATE`: the one `folder-v2` path that may, since it
  deletes the row. It comes after the fence, so no effect holds the row while it waits, and before the cascade's
  children, which the remaining legacy holders of the row (sign-ins until S1's `20260930035000`, node update drains
  until C1c-3n, §6.15) take after it (828 D: behind
  a holder of the row `KEY SHARE` alone, it waits at the row while it holds the fence). Since 3j a Company Computer's
  retirement takes the folder fence first on `folder-v2`, so it waits at the fence behind the finisher, not in a cycle. The finisher and
  the purge are the `folder-v2` exception to core §9's rule on the profile row (CORE §3 step 3 and §9 say so).
- **The batch** finishes its random sample in company id order, as the node update drains and the executor give-up take
  their companies, so two batches of locks never cross.
- **One window left (information):** a job or a folder creation (P14a) whose worker holds its row and read "not paused"
  just before the deletion committed can ask for the fence right after the finisher's drain took it. If that pass
  purges, the cascade locks that row `FOR UPDATE` (not `SKIP LOCKED`) while the worker waits at the fence: a 40P01 at
  practically impossible timing. It heals: either side retries, and the next pass blocks the row.
- **Closed:** the 40P01 windows §6.4 records for 3g (the last member's leave during the purge now waits at the fence) and
  for 3f's sweep (its fence `NOWAIT` skips a company whose purge holds the fence), and 3h's coding calls (§6.8).
- **Snapshot-v1** keeps each statement in its `else` branch, untested since the founder decision of 3 Oct (folder-v2 only,
  production wiped): 828 G checks only that each folder-v2 branch is there.
- `revoke_company_connector_secrets` (the finisher's only caller) still locks secrets before grants, against 3d-2's
  grants-before-secrets order, but a broker seal takes the company row `KEY SHARE` first (#660), and the finisher now
  holds the row `FOR UPDATE` before it revokes (the gc fence on snapshot-v1), so the two meet at the row, not in a
  40P01. Account deletion stays an operator action (§6.6).

### 6.11 C1c-3k part 1 as built: screens, restarts and power-off (migration 20260930019000, test 894)

The coordinator's P06b, first of two PRs (plan `outputs/company-accounts/p06-office-folder-v2-plan.md`; the PR lists the
33 callers of the provider's assertion and their locks after 3j). Folder-v2 only, by the founder's decision of 3
October: each patch is a folder-v2 branch, and the statement that was there before stays untouched in its `else` until
snapshot-v1 is removed.

| Path | Before (on folder-v2) | Now |
|---|---|---|
| The three successor activations (restart, reset, host reboot) | the status call (the office) first, then the activation's prelude: the start's people after the office | `qorpera_folder_office_enter_successor(request)`: 3j's prelude for the activation's start, first |
| Restart surfaces, shared surface, screen v1, disposal | `path_gateway_version = 1` gates: every restart path, every screen heartbeat, the agent's screen tool and disposal refused | also a ready folder-v2 Company File; the restart gate opens only with the successors ordered |
| Screen event cleanup, observation retention, disposal, `member_agent_office` 'new', the office power-off (`suspend_runtime_node_machine`) | gc fence | machine fence (the folder fence and rank 0 `KEY SHARE`); the rest as before |
| A member's start status | 3j's prelude, then the office, member and intent `FOR SHARE` | plain reads: a poll never waits for a folder stop |
| Adopting a computer's screens (a non-empty mapping) | refused with 0A000 "comes later" (3j) | still refused, for good: the orchestrator builds mappings only to adopt a legacy computer (`lxd-office-adoption-plan.ts`, `input.legacy`), which a folder-v2 company never has |

- **Test 894** (648's committed fixture; "must not wait" calls are sent while another session holds the company row
  `FOR NO KEY UPDATE`). It starts the company's computer as 893 does, then:
  - A: start status with the folder fence, the computer and the owner's member row all held `FOR UPDATE`;
  - B: the owner opens Ada's screen, the shared surface passes its gate, and the first heartbeat makes the screen's
    lifetime. The cleanup event (DESKTOP_REAPED) doesn't wait. B2: retention gets past its identity checks to its
    fence and doesn't wait;
  - C: the office power-off's node suspend doesn't wait;
  - D: with the computer in maintenance, the restart check passes its gate and finds the allocation;
  - E: with scale-out on and the computer in maintenance, a member's new computer for Ada is added without waiting;
  - F: each successor activation, sent while the owner's member row is held, waits there holding no office;
  - G: exactly 14 bodies name the migration (13 patched functions and the successor's prelude).
  893 F now expects the new refusal text.
- **Not tested here:** the screen v1 gate (the agent's screen tool, through a folder-v2 run's tool authority) and the
  operator's disposal (a signed delete document). Both are one-line changes of the same shape as the tested ones.
- **Open after part 1 (review r1), for part 2:**
  - A new computer for an agent (and 3j's first registration) no longer waits for another agent's hire or return. If
    both run together, the new computer can miss the hired agent's default access row. Placement then skips that
    computer for the agent, or, after a first registration, answers "denied". Part 2 (§6.12) makes the hire's office
    walk take the seat lock before the computers. A new hire's row is inserted, so no row lock reaches it; the seat lock
    is what meets it. 'new' and registration share the company's agents KEY SHARE before their seat lock. There is no
    cycle: after the seat lock they take agents only KEY SHARE (the foreign key), which a hire's NO KEY UPDATE never
    blocks.
  - The shared-surface gate makes `office_screen_browser_grant` reachable; it shares the viewer's member row after the
    office (`assert_runtime_office_viewer`). That is not a live cycle before C1c-3l's pin.
- **Not in part 1 (part 2, 20260930019100):**
  - access configuration and its status (a per-company serializer: swapping the gc fence alone deadlocks two capability
    changes of one agent on two computers);
  - opening a screen;
  - the private screen event;
  - the viewers and the screen's browser grant;
  - the agent's screen tool through a folder-v2 run (which also tests the screen v1 gate);
  - the view-anchor tests.

  Part 2's bodies name its own slot, so 894 G's count of 14 stays.

  C1c-3l: an agent's own start and the wake drain.

### 6.12 C1c-3k part 2 as built: access, screens and viewers in rank order (migration 20260930019100, test 895)

P06b's second PR, folder-v2 only like part 1 (the statement that was there before stays in each `else`).

| Path | Before (on folder-v2) | Now |
|---|---|---|
| `set_runtime_office_access` (and `configure_runtime_office_access` through it) | gc fence, then the computer and the access row; the access triggers then change the agent's rows (and maybe revisions) on every sibling computer, in scan order | machine fence, the acting member (rank 1), the agent (rank 2), the seat lock, then every live computer of the company `FOR UPDATE` by id, then the access row |
| `runtime_office_access_status` | gc fence | plain reads (the setter checks again under its locks) |
| The staff trigger's office walk (a hire or an agent's return) | the computers by id (3j) | the company's seat locks first, then the computers by id |
| `member_agent_office` 'new', `register_runtime_office` (folder mode) | member, seat lock, the new computer | member, the company's agents `KEY SHARE` by id, seat lock, the new computer |
| `open_runtime_office_screen` | seat lock, the computer, a plain role read | someone who may not write the company refused first; then the machine fence, the member's row, the seat lock and the computer |
| `record_runtime_screen_event`, a private heartbeat | the startup lock (the computer), then the privacy owner's member row | `qorpera_folder_office_enter_startup`: 3j's prelude with the privacy owner as its member, before the startup lock |
| Viewers (create, redeem, the input check) and `office_screen_browser_grant` | the computer, then the viewer's member row | `qorpera_folder_office_members_first`: the members' rows `FOR SHARE` by user id, then the computer. No fence on these hot paths; rank 1 alone never goes backwards |

- **Why every computer for one access change:** swapping the gc fence for the machine fence alone deadlocks two
  capability changes of one agent on two computers. Each holds its own computer and access row, and its trigger
  cascade updates the other's. It would also let an agent revoked on every computer keep access on a computer added
  meanwhile (the new computer copies a sibling's state read before the revocation committed). With every computer
  locked by id after the seat lock, the cascade finds them all held, and a new computer waits at the seat lock.
- **Why the seat lock in the hire's walk:** see §6.11 (review r2 of #759). A computer added while an agent is hired or
  returns now gets the agent's default access either way.
- **Test 895** (648's committed fixture; each case holds the earlier lock in another session and checks the call waits
  there holding no computer):
  - Z: a first registration waits at the agents (one held `FOR UPDATE`) before the seat lock;
  - A: with the low computer held, a capability change on the high one waits there, holding neither the high computer
    nor any access row, then lands, and the triggers carry the new capabilities to the low computer;
  - B, C: an access change waits at the agent, then at the seat lock, before any computer;
  - D: with the folder fence and the company row both held `FOR UPDATE`, access status answers (plain reads); with the
    company row held, an access change doesn't wait;
  - E: an agent's return waits at the seat lock before the computers;
  - F: a new computer for an agent waits at the agents before the seat lock;
  - G: opening a screen waits at the member's row before the seat lock and the computer; G2: someone outside the
    company is refused before the folder fence (it answers at once with the fence held `FOR UPDATE`);
  - H: a private heartbeat waits at the privacy owner before the computer;
  - I: creating a viewer, redeeming it, its input check and the screen's browser grant each wait at the member before
    the computer;
  - J: a computer is added under the seat lock in another session while Ada returns, then while a platform commit
    hires a new agent: each waits at the seat lock and, once the computer commits, has access on it (review r1 of #767:
    without the walk's seat lock both miss it);
  - K: exactly 13 bodies name the migration (11 patched functions, 2 helpers).
- **A small window left:** the screen's browser grant reads the screen's active viewers before it locks the computer,
  so a viewer redeemed in between has its member row shared after the computer. No member writer takes the computer,
  so this is not a cycle.
- **Not here:**
  - the agent's screen tool through a folder-v2 run (the screen v1 gate);
  - the view-anchor tests (moved to C1c-3l with the agent's screen tool);
  - the member's own browser calls (the privacy entry, browser grants and profiles), which take the member after the
    computer but no company lock.

  These go to C1c-3l, which runs agents on the computer, or to the activation checks (3m).

### 6.13 C1c-3i part a as built: coding sessions on the folder fence (migration 20260930026000, test 827)

Folder-v2 only (founder decision, 3 October 2026: production is wiped and the snapshot-v1 path is dropped), so no
snapshot-v1 branch is kept.

**Before.** A coding turn's begin, its completion, the owner's answer and a delegation locked the todo and then the
worker `FOR UPDATE`, with no company lock. A stop's drain did not wait for any of them. The begin's wake admission took
the company row `FOR UPDATE NOWAIT`, which is the 55P03 the executor retries. On `folder-v2` the begin could not run at
all, because its wake had no folder admission. The executor's claim locked candidates of several companies in one
transaction.

**The coding worker's entry.** `qorpera_lock_coding_worker`, which the begin, the completion and the answer call first,
is now the company's entry (core §3):
- the folder fence `KEY SHARE`, and rank 0;
- rank 1 the worker's owner, rank 2 the agent, rank 3 its execution authority, all `KEY SHARE`;
- rank 5 the todo and then the worker, `FOR NO KEY UPDATE` (F2's table order; the completion and the answer write the
  todo).

The coding session comes after, at the sessions step (core §3, amended: one sessions step after rank 10, `FOR UPDATE`
in id order: the conversations, then the coding sessions, then the turn inputs, as C4's materializer takes them).
Nothing takes a conversation and a coding session together today: the completion settles the worker and its session,
and its parent hears it from the worker drain in a later transaction. A worker of a company that is not `folder-v2` is
refused with 0A000.

**The begin.** It reads the pause again after the fence, since it inserts a wake. It admits on the folder admission row
(step 10) last, before its wake. There is no NOWAIT and no 55P03, so the executor's busy retry no longer fires.

**The claim.** It takes one company per call:
- its candidates are `folder-v2` sessions only;
- a candidate it does not take (an inactive worker, a live lease, another executor's pick, a switched-off node) raises
  QSK01, so its subtransaction, and every lock it took, rolls back (review r1: the fleet pick and the node switch used
  `continue`, which kept the candidate's locks);
- it waits at most 1 s for any one lock (`lock_timeout`), then skips the candidate and the rest of its company for that
  call, so a company behind a stop or a deletion costs a claim at most 1 s (review r2);
- failing an expired lease ends the call, and the next call takes the next candidate.

**The executor's quiet-session archive** (`archive_quiet_coding_sessions`) takes the quiet `folder-v2` sessions of one
environment per call, up to 8. It enters their coding workers once, together (`qorpera_lock_coding_workers`: every
worker's targets merged, so each rank is taken once in its tables' key order, and no rank is taken again after a later
one, review r2), then archives each session in id order. C3c's drain asks the quiet sessions per company (§6.20). The
legacy quiet check-ins (`ask_quiet_coding_sessions`, a wake inserter with no fence that locked other companies' coding
rows NOWAIT), which ran only when the archive entered no company and skipped `folder-v2` sessions, went in the legacy
sweep's F3a (20260930294000).

**The owner's calls.** A delegation locks the worker through the same entry. The answer, the delegation and the owner's
archive check the owner again once the entry holds the owner's member row, so a removal that committed while they waited
is refused (review r1).

**Inert** until C3 lets a `folder-v2` coding session exist (F2's worker commit refuses coding dispatch) and C4
materializes its wake.

**Tests:**
- 827:
  - A: the begin holds the fence, rank 0, the todo and the worker, a stop's second phase waits for it, and its wake is
    queued and admitted;
  - B: behind a stop's second phase it waits at the fence holding no coding row;
  - C: a paused company refuses;
  - D: the entry and an agent's worker change take turns at the worker, and a snapshot-v1 worker is refused;
  - E: the claim never takes the snapshot-v1 candidate (this executor's, and the oldest), and skips an inactive worker's
    with every lock its entry took;
  - F: failing an expired lease ends the call;
  - H: two entries on one worker, and an agent's worker tool against the entry, take turns at the todo (602's races
    1-3 and 6);
  - I: a coding machine's admission (worker, then session) and the entry: the entry waits at the worker, holding no
    session (602's race 4);
  - J: a non-owner's answer is refused at once while the worker is held (602's race 8);
  - K: a stop's second phase waits for the entry, as for the completion and the answer;
  - L: an owner removed while the answer waits at the owner's member row is refused; the owner's answer then runs,
    holding the fence, the todo, the worker and the session, and reopens the session;
  - M: the quiet-session archive holds one company's fence and both quiet workers while it archives both, and leaves the
    snapshot-v1 session alone.
- The snapshot-v1 coding tests are deleted:
  - 395, 399, 600, 601, 602 (fleet), 603, 604, 606, 627, 655, 676, 719, 737, 739, 775 and 782;
  - also the coding-claim section of 640.
- 396 keeps its dispatch, and 602 keeps its committed fixture (608, 745, 754, 797 and 800 cut at its end marker).
- The snapshot load scripts and the coding backfill script went with them. Run-on-node's `folder-core-load` step
  replaces `company-fence-load`. The load test now also samples statements running over 2 s with their wait events, and
  locates each statement timeout in the server log (a stall the server's `log_lock_waits` does not report: I/O, LWLocks,
  CPU).

**Release guard (release-owned).** v170's activation (20260928459990:39-52) pins these markers, and the generator's
template carries them:
- `v_worker := public.qorpera_lock_coding_worker(p_worker_id);` in the begin and the completion (both kept);
- `v_worker := public.qorpera_lock_coding_worker(v_worker.id);` in the answer (kept);
- `for update;` in `qorpera_lock_coding_worker` (gone);
- `where id = v_worker.id for update;` in the delegation (gone: it calls the entry).

The next cut must replace the two that are gone, for example with the body marker 20260930026000. Until then
`test-runtime-office-delete-disposition` (which replays the newest activation) refuses on them: the coordinator drops
them at the v172 cut.

**Not in 3i-a (3i-b, migration 20260930026500):**
- the `folder-v2` machine-event drain and the quiet coding check-ins, as per-company drains of the shared "folder
  drains" orchestrator step (P29a);
- lifting the machine-event refusals (the pin trigger, `folder_wake_authorized`, `folder_run_resolve`).

The progress, heartbeat and describe calls lock only the session and change no company state.

### 6.14 P13 sign-in machines as built (migration 20260930035000, test 900)

F3's activation check (838, #779) listed the sites below as `folder-v2` gc-fence holders. A sign-in's or an account
refresh's login machine was reserved and released with the sign-in `FOR UPDATE` first and the gc fence after: the
reverse of core §3's order, and on `folder-v2` a stall of every effect of the company.
- **The reservation** (`qorpera_reserve_runtime_login_machine`, `_account_refresh_machine`):
  1. it reads the sign-in with no lock and checks its capability; an unknown sign-in or a wrong capability is refused
     before any lock, on either core (900 B, I);
  2. `qorpera_folder_sign_in_machine_locks`: the fence `KEY SHARE` and rank 0 (`qorpera_folder_machine_fence`, no
     pause read), the requester's member row `FOR SHARE` (rank 1) and the identity's machine lock (C1B §8);
  3. the sign-in `FOR UPDATE` (rank 5, before the model logins), checked against what step 1 read;
  4. then as before: the identity `FOR SHARE`, the provider policy, the pause, the machine request, the allocation and
     the placement.
- **The release:** the fence and rank 0, then the sign-in, the machine request and the allocation. No pause read, so a
  paused company's machines are released (900 H).
- **The node reservation** of a login machine (`qorpera_reserve_runtime_node_machine`, kind `login`, the gateway's own
  call after the company reservation) takes the fence and rank 0 like the other `folder-v2` kinds. Kind `native` (a
  run's machine) moves with C1c-3n, which then takes the identity's machine lock in place of the gc fence: today the gc
  fence of a run's reservation is what keeps a run and a sign-in of one identity apart.
- **Two machines of one identity** stay serialized: they wait on the identity's machine lock, and the second sees the
  first's machine and is refused `COMPUTE_IDENTITY_OCCUPIED` (900 C). The unique index
  `qorpera_runtime_login_identity_occupied` keeps one live sign-in or refresh machine per identity, but without the
  lock the second would end in a 23505; a run's machine has no such index. The identity row cannot serve as the
  serializer: it comes after the sign-in in rank 5, and a stronger lock taken before the sign-in would deadlock with a
  sign-in's completion (the sign-in, then the identity through its epoch trigger).
- **Rank 5's order** (C1B §8: model logins, versions, identities) in the two paths that took an identity first: the
  member removal's prelude (§6.4 step 7) and `qorpera_record_native_provider_account_metadata`. Once the removal took
  the model logins first, the metadata's old order would have deadlocked with it. 900 D and E reproduce both deadlocks
  on the old text. Both completions (`qorpera_complete_native_provider_login`, `_model_login_sign_in_kind`) already
  follow the order: before the model login they hold the identity only `KEY SHARE` (the capsule's foreign key), which
  conflicts with neither the removal's `FOR NO KEY UPDATE` nor `FOR SHARE`, and their `FOR SHARE` comes from the
  sign-in's epoch trigger after it (900 F shows a completion beside the materializer's rank 5).
- **Snapshot-v1:** the reservations', releases' and node reservation's old statements stay in their `else` branches.
  The member removal's prelude is `folder-v2` only. The account metadata's new order holds on both cores (every other
  path also takes the model login before the identity). 900 I checks that each patched branch is present, with no
  snapshot-v1 text pins (since 3 Oct); 824 H reversed the node reservation's new layer first (no digests since 3
  October; legacy sweep A, #829).
- **Legacy sweep F2d (20260930293000)** removed the reservations' and releases' `else` branches (the node
  reservation's went in F2c, 20260930292000): `qorpera_folder_sign_in_machine_locks` takes the fence for a sign-in or
  refresh of any company and answers null only for an unknown one, so a company without a folder fails at the fence
  (42501 "Company folder is unavailable", 900 G). A release whose sign-in appears between the helper's read and its own
  select is now refused (42501) instead of taking the gc fence; a sign-in is committed by its begin call before the
  gateway has its id, so this does not happen.
- **A window P13's second part closed** (20260930049000, test 901, §6.17): `qorpera_request_login_identity_recovery` and
  `_account_refresh_identity_recovery` took the sign-in `FOR SHARE` and then the gc fence, the reverse of the new
  reservation (the row `KEY SHARE`, then the sign-in `FOR UPDATE`). They could deadlock on one sign-in when two gateway
  processes acted on it at once. They now take no sign-in lock.
- 838's `p13_allowed` list loses these sites when #779 merges: whichever of the two lands second deletes them.

### 6.15 C1c-3n as built: a run's machine and node updates (migration 20260930046000, test 849)

Found by P13's activation check (test 838). Folder-v2 only.

**Before.** These took the gc fence (the company row `FOR UPDATE`), which every folder effect holds `KEY SHARE`:
- a run's machine reservation (`reserve_runtime_machine` with a run). Since P28 materializes `folder-v2` runs, every run's
  machine start made the company's effects wait, and waited for them;
- the node reservation of a run's machine (`reserve_runtime_node_machine`, kind `native`) and every machine release
  (`release_runtime_machine`);
- the three node-update steps (`authorize_node_update_drain`, `node_update_locked`, the updater's poll, and
  `release_node_update_admission`), each for every company on the node in one transaction.

**On folder-v2 now:**
- **A run's reservation** keeps its job `FOR UPDATE` first (838's lease rule). Then it takes the folder fence and the
  company row `KEY SHARE` (`qorpera_folder_machine_fence`; the pause is read after the locks, as before), the run's
  requester's member row `KEY SHARE` (rank 1), and the identity's machine lock. That is the transaction advisory lock
  `hashtextextended('qorpera.identity-machine:' || <compute identity id>::text, 0)`, which a sign-in's machine of the
  identity takes too (S1, 20260930035000). So a run's machine and a sign-in's machine of one identity serialize, as the
  gc fence made them before. Then the run, the runner and the allocation, as before. It is patched as an `elsif` after
  3j's office branch.
- **The node reservation of a run's machine** (an `elsif` for kind `native`, after the folder branch S1 extends with
  `login`) and **a release** take the folder fence and rank 0, then their rows.
- **The node-update steps** take each company's folder fence `KEY SHARE`, in company-id order, and nothing stronger: no
  company row. Then the node rows (the node's advisory lock, the node `FOR UPDATE`, its enrollment and target), as
  before.
  - A stop's second phase or a resume (the fence `FOR UPDATE`) waits for them, so the node's pause proof (every company
    on the node paused) holds while it is recorded and checked.
  - Effects, admission and machine reservations (`KEY SHARE`) never wait for them, and they never wait for those.

**No cycle.** The node-update steps take only fences `KEY SHARE`, in company-id order, before any node row:
- Against each other (two nodes naming one company): both take fences in the same order, and `KEY SHARE` does not
  conflict with `KEY SHARE`.
- Against effects and admission: no conflict at the fences. Machine admission and a run's reservation take a company's
  fence, then node rows. The node step takes all fences before its node rows, and a company's fence `KEY SHARE` never
  waits for theirs.
- Against a stop or a resume (the fence `FOR UPDATE`): those take no node row, so they wait for the step and the step
  never waits for them while holding anything they need.
- Against a deletion's finisher: the finisher takes the fence `FOR UPDATE` first (C1C §6.10). If the step holds the
  fence, the finisher waits at the fence while it holds nothing (849 E). If the finisher holds it first, the step waits
  at that company's fence while it holds only fences of companies with a lower id, which the finisher's batch has
  already passed: it takes fences in ascending company id too. The finisher and the purge take no node, enrollment or
  target row. The stop's job pass is `SKIP LOCKED`, machines are only marked deleted, and allocations are released only
  on the provider's proof; the purge's cascade locks only the company's own rows.
- The run's reservation holds its job, then the fence and rank 0 `KEY SHARE`, its requester `KEY SHARE`, then the
  identity lock. A sign-in's reservation takes the fence, rank 0 and the requester first too, then the same identity
  lock, then its sign-in (rank 5). The sign-in path never touches jobs or runs, and the run path never touches sign-ins.
- One window, as §6.10's (information): a run's reservation that holds its job and waits at the fence behind a
  deletion's finisher meets that pass's purge, whose cascade wants the job `FOR UPDATE`. One of the two ends with
  40P01: the finisher records it and purges on its next pass, or the reservation fails in a company being deleted. They
  met at the company row before, in the same shape.
- The old body's comment that "the profile fence serializes both reservation paths" (`20260908003800`) holds only off
  `folder-v2`; there the identity's machine lock does.

A company that is not `folder-v2` keeps the gc fence in each `else` branch, untested. Legacy sweep F2c (20260930292000)
removed those branches: every company takes these paths, and one without a folder fails at its fence (42501).

**Tests.** 849:
- A: beside a folder effect or member management (the fence `FOR NO KEY UPDATE`), none of the six calls waits.
- B: behind a stop's second phase, each waits at the fence, the run's reservation holding only its job, none holding the
  company row, the allocation or the node.
- C: the run's reservation waits on the identity's machine lock after the fence, rank 0 and its requester.
- D: a resume waits for a node-update step that holds the fences.
- E: a deletion's finisher waits at the fence for a node-update step, then finishes with the node update as what holds
  the company, and no error recorded.
- F: the markers.

824 H gains this migration's layer, undone first (no digests since 3 October; legacy sweep A, #829, removed 824 H's).

### 6.16 C1c-3l part 1 as built: an agent starts the Company Computer (migration 20260930030000, test 890)

The coordinator's P06c, first of two PRs. Folder-v2 only, like 3j and 3k: the statement that was there before stays in
each `else`.

| Path | Before (on folder-v2) | Now |
|---|---|---|
| `native_office_start` (an agent's `computer_start`) | refused with 0A000 | `qorpera_folder_office_start_enter(binding)`, then the seat lock and every computer of the company by id, as before; no gc fence (the tool run holds the folder fence and rank 0) |
| `native_office_start_descriptor` | refused with 0A000 | serves folder-v2; its new computer takes the company's agents `KEY SHARE` before the seat lock (as `member_agent_office` does, §6.12); the gate accepts a ready folder-v2 Company File |
| `assert_runtime_office_start_source`, an agent's start | the agent and its access `FOR SHARE` | on folder-v2 `FOR SHARE NOWAIT` (every caller took the agent before the computer, unless its start appeared since); legacy sweep F2a (20260930290000) left only that |
| `qorpera_folder_office_enter` (3j's prelude), run again inside the call | the start's agent `FOR SHARE` | `FOR SHARE NOWAIT` when nested |

- **The prelude.** An agent's tool run takes its requester and agent only `KEY SHARE`. But the start-source check shares
  the start's agent (or member) after the computer, and a start may join another start of the same computer, whose
  agent or member it then shares. So before the seat lock and the computers, the tool run takes `FOR SHARE`:
  - the members (rank 1) and agents (rank 2) named by any current start of the company's computers;
  - the run's own agent;

  and every active agent `KEY SHARE` (a new computer's default access takes them after the computers). An agent's
  return holds its row, then wants the seat lock (the hire's walk, §6.12), then the computers: the start now waits at
  the row and never holds what the return wants.
- **A start that appears after the read.** The prelude reads the current starts plainly. If one commits before the start
  locks the computers, it may name someone the prelude did not lock, and the start then joins it:
  - a member: the start-source check shares the member after the computer. That is safe, because a member's writers
    (role change, removal) never take a seat lock or a computer;
  - an agent: the start-source check takes the agent `FOR SHARE NOWAIT` on folder-v2. An agent's return holds its row
    and wants the seat lock, so a wait there could deadlock. Only if that row is being written at that very moment does
    the start refuse (55P03). The runtime does not retry a refused `computer_start`: its receipt stays open and the run
    reports the outcome unconfirmed (review r1). So the refusal is kept to that narrow case.

  Every writer of a start holds the computer, so nothing changes after the start locks it.
- **The receipt before the start record.** The start locks its operation receipt before the start of the computer
  (a rank-9-level row before an office-level one, as it was). That is acyclic: only the run's own calls and its
  completion take the receipt, and none of them takes a start record.
- **3j's prelude, nested.** A member's start runs its before-idle body, and a provider's wrapper its unbound body, inside
  the call; both run 3j's prelude again after the computer is held. Nested (the transaction-local
  `qorpera.folder_office_entered` lists every computer the transaction entered), the prelude takes a start's agent
  `FOR SHARE NOWAIT` too. The start-source check's NOWAIT covers only the agent's row, not its access row: no prelude
  takes the access row, and no writer of it waits for a computer or the seat lock after taking it (reviews r2, r3).
  The outer prelude took the same agent unless a start appeared in between; then a wait could deadlock with that
  agent's return (890 E4 found it).
- **Test 890** (648's committed fixture; Ada's run starts the company's computer):
  - A: with the company row held, the descriptor and the authorize answer at once;
  - B: with Ada's row held (her return), Ada's start waits there holding no seat lock and no computer; the holder bumps
    the computer's revision and commits; the start lands;
  - C: with Ada's start recorded, the owner's before-idle, the provider's offer, placement, the unbound check and
    reserve, the withdrawal and the cancel each wait at Ada's row holding no computer, and never deadlock (the carried
    C-style tests from #739's review);
  - D: Ada's start joins the Co-Founder's start, waiting first at the Co-Founder's row;
  - E: the Co-Founder's start commits while Ada's start waits at the seat lock; Ada's start joins it. E1: the same with
    the Co-Founder's row being written; Ada's start refuses at once (55P03), records nothing and leaves its receipt open;
  - E2: Ada's start joins the owner's start, waiting first at the owner's row. E2b: the owner's start commits after
    Ada's read and the owner's row is held; Ada's start waits there (after the computer, which is safe) and joins;
  - E3: with an active agent's row held `FOR UPDATE`, the start waits at the agents before the seat lock;
  - E4: a member's start waits at the computer while Ada's start commits and Ada's row is being written; the member's
    start refuses at once (55P03) instead of deadlocking;
  - E1 and E4 set a lock timeout, so a wait there fails the test instead of hanging it;
  - F: the descriptor's new computer waits at the agents before the seat lock;
  - G: exactly 5 bodies name the migration.
- **Not here (part 2, §6.18):** the office-activation wake that wakes the agent once its computer is up.

### 6.18 C1c-3l part 2 as built: the agent wakes when its computer is up (migration 20260930030100, test 892)

The coordinator's P06c, second PR. When an agent's `computer_start` has to wait for the computer, its start records a
waiter (§6.16). Once the agent's turn has ended and the computer is up, a wake continues the agent's work. On folder-v2
that wake was refused, and nothing delivered the waiter. Folder-v2 only: the statement that was there before stays in
each `else`.

- **The drain** (`office_wakes`), plugged into the shared folder-drains step (P29a, `RUNTIME-COMPANY-FOLDER-LISTENER.md`
  §9) after `listen`:
  - A waiter is due (`qorpera_folder_office_waiter_due`, plain reads) once its start's turn has ended and the drain can
    act on it: deliver it (the computer is up under the start's activation) or cancel it (the turn failed or was
    cancelled, the start is gone or cancelled, or the computer was replaced). A waiter whose computer is still coming
    up waits, so its company is not listed on every pass.
  - `qorpera_folder_office_wakes_due(p_after_environment, p_limit)` lists the folder-v2 companies with a due waiter. It
    is plain reads, and leaves out companies that are paused or being deleted. `has_more` is true only for a full page,
    which alone carries the next cursor (LISTENER §9).
  - `qorpera_folder_office_wakes_company(p_environment_id, p_limit ≤ 40)` handles one company in one transaction, with
    a 2 s lock budget (each waiter writes in its own subtransaction, under core §3's 64), in rank order:
    1. it reads the work without a lock;
    2. it takes the folder fence and the company row `KEY SHARE`, then the starts' requesters, agents and their execution
       authorities `KEY SHARE` (`qorpera_folder_company_enter`, as the materializer does);
    3. it takes the waiters `FOR UPDATE SKIP LOCKED`, so a second drain of the company skips them, and then the
       admission;
    4. per waiter:
       - a failed or cancelled start, or a replaced computer, cancels it;
       - a computer not yet up, or a pause, skips it. A stop's first phase writes its pause without waiting for the
         fence, so a pause can land during the drain; the waiter then waits for a later pass, as with the old drain;
       - a waiter whose authority is gone (for example its agent's access was revoked) is cancelled;
       - an authorized one gets a queued `office-activation` wake, and the waiter is delivered. If the pin cancels the
         wake (a pause that lands inside the insert), the insert is undone and the waiter skipped, so no cancelled row
         keeps its key.

    It answers `busy` when a lock is not free within the budget, `paused`, `idle`, `deleting` or `not_folder`,
    otherwise `{state: "drained", delivered, cancelled, skipped}`. No computer row is locked. The wake's authority is
    read again when it becomes a run, and on every tool call of that run.
  - The edge function's `FOLDER_DRAINS` gets `office_wakes` (maximum 40), and the orchestrator's `CLOUD_FOLDER_DRAINS`
    gets `{name: "office_wakes", companyLimit: 16}`.
  - Since P28a nothing calls the old drain (`qorpera_drain_office_activation_wakes`). Legacy sweep F3b (20260930295000)
    dropped it.
- **The waiter check.** `qorpera_folder_office_waiter_authorized(waiter)` makes the checks of
  `qorpera_office_waiter_authorized` as plain reads, and that function answers with it on folder-v2 (since legacy sweep
  F2a, 20260930290000, on every company). A folder-v2 write's
  completed receipt counts as having its revision when it names its folder commit. The old check took
  the company row and every row `NOWAIT`. That would turn a screen heartbeat (the computer `FOR UPDATE`) into a refused
  tool call of the woken run.
- **The wake source.** `'office-activation'` leaves the folder-v2 refusal lists of `qorpera_pin_wake_occurrence`,
  `qorpera_folder_wake_authorized` and `qorpera_folder_run_resolve`. `qorpera_folder_wake_authorized` checks an
  office-activation wake's ancestry (`qorpera_office_activation_wake_ancestry`). Each list is found by its own opening
  and its own raise or return. Only the `'office-activation'` token and its comma go, with a marker line before the
  statement, and a list left empty drops its whole statement. 3i-b's `'machine-event'` edit (S3) does the same, so the
  two apply in either order.
- **Test 892** (648's committed fixture; Ada's start waits for the company's computer, which comes up):
  - A: nothing is due while Ada's turn runs; once it has ended the company is due, unless it is paused, being deleted,
    or its computer is not up. A page that is not full has no next cursor; a full one names its last company;
  - B: the drain waits behind a folder stop at the fence, holding neither the waiter nor the admission, and behind a
    member change at the start's requester, likewise. It then delivers one queued wake for Ada, scheduled at the
    activation, and a second drain is idle;
  - C: with the computer held `FOR UPDATE` (a screen heartbeat), the folder wake check answers at once. Once the computer
    is no longer active, the wake is not authorized;
  - D: the run the wake becomes resolves as Ada's agent run for that wake;
  - H: a fence held past the 2 s budget answers `busy` and changes nothing;
  - I: two drains at once: the second skips the waiter the first holds, and one wake comes;
  - J: with the admission row held, the drain waits there holding the waiter and no computer; a pause that commits
    meanwhile leaves the waiter waiting (skipped), and after the pause it is delivered;
  - K: a wake the pin cancels is undone; the waiter waits, and the next pass delivers it;
  - L: a waiter whose agent lost its access to the computer is cancelled;
  - M: with the computer held `FOR UPDATE` (a screen heartbeat), the drain delivers at once;
  - N: the admission held past the budget also answers `busy`, and the waiter waits;
  - O: a turn that also saved a company file (its write's receipt names its folder commit) still wakes its agent;
  - E: a start whose turn failed is cancelled, not woken;
  - F: only the service role lists and drains, and a page over 500 or a company limit over 40 is refused;
  - G: exactly the patched and new functions name the migration.
- **Other tests:**
  - 656 now reverses the pin trigger's new marker line;
  - 838 takes `qorpera_office_waiter_authorized` off P13's list of open folder-v2 sites: it tests the core first now;
  - 656 and 634 check that a machine event is still refused on folder-v2 (634 also checks that a hand-built office
    activation with no waiter behind it is refused by its ancestry);
  - the edge function's and the orchestrator's tests cover the new entries.

### 6.17 P13 part 2 as built: identity recovery and retirement (migration 20260930049000, test 901)

F3's activation check (838) listed eleven `folder-v2` gc-fence holders in identity recovery and retirement. Each took the
gc fence (the company row `FOR UPDATE`), on `folder-v2` a stall of every effect of the company; the login's and refresh's
recovery requests also took the sign-in before it (§6.14's window).
- **Recovery** (`qorpera_activate_identity_recovery`, `qorpera_cancel_identity_recovery`,
  `qorpera_consent_identity_recovery`, `qorpera_request_identity_recovery`, `qorpera_request_login_identity_recovery`,
  `qorpera_request_account_refresh_identity_recovery`, and `qorpera_recovery_locked`, the first step of
  `qorpera_prepare_identity_key_release`, `qorpera_commit_identity_key_release`, `qorpera_complete_identity_recovery` and
  `qorpera_identity_recovery_completion_authority`):
  1. the caller's or the recovery service's unlocked check, as before (#575);
  2. `qorpera_folder_identity_recovery_locks`: the fence `KEY SHARE` and rank 0 (`qorpera_folder_machine_fence`), then
     every member row of the company `FOR SHARE` in user id order (rank 1);
  3. the identity `FOR UPDATE`, the recovery, the target and the backups, as before.

  Every member row, because the call chain reads members `FOR SHARE` after the identity: the caller, the recovery's owner
  of record and the consenting member (activation, which consent and the requests call, reads the last two). Which rows
  those are, and their roles, is only known there; holding them all first means none that exists then is newly locked
  after the identity. A member who joins meanwhile can be, which is harmless: a row just committed holds nothing. It
  blocks member writes (role changes, removals, rule saves, display names) for the length of a rare recovery call, never
  a reader or a `KEY SHARE` (C1B §8). A nested activation calls the helper again and re-takes rows it holds.
- **A member's recovery decision** (`qorpera_decide_member_identity_recovery`, patched too though it never took the gc
  fence itself) runs `qorpera_review_member_identity_recovery`, which reads the identity `FOR SHARE`, before the request,
  consent or cancellation that takes it `FOR UPDATE`. On master the gc fence in `qorpera_recovery_member_role`
  serialized the whole decision per company. On `folder-v2` the decision now takes the helper and the identity
  `FOR UPDATE` before the review, after an unlocked check of what the review requires (a caller it would refuse takes no
  lock and gets the review's own error). Two decisions on one identity, or a decision and the removal of the identity's
  owner, then queue instead of both upgrading the review's `FOR SHARE` (901 I).
- **No sign-in held `FOR SHARE`** (C1B §8 gives the argument):
  - a login's or refresh's recovery request reads its sign-in or refresh request with no lock, and checks it again under
    the identity's lock: pending, not expired, and re-pinned to no other recovery epoch since the first read (what the
    old `FOR SHARE` held still). A sign-in pinned to an older epoch than the identity's, which the gateway recovers
    from after another node's recovery, still goes through (901 F);
  - a key backup's preparation (`qorpera_prepare_identity_key_backup`, which the backup's completion calls) takes the
    fence and rank 0, then its sign-in `FOR KEY SHARE` before the identity, because the backup and its receipt reference
    the sign-in. `KEY SHARE` conflicts only with `FOR UPDATE`, which completions, repins and machine reservations take
    before the identity too, and not with a new sign-in's cancellation. It is checked again under the identity's lock
    the same way (pending or completed).

  This closes §6.14's window.
- **Fence and rank 0 only:** a recovery target's registration (`qorpera_register_identity_recovery_target`), the recovery
  member role (`qorpera_recovery_member_role`, then its own member row) and an identity's retirement confirmation
  (`qorpera_confirm_runtime_identity_retirement`). The registration and the confirmation then take the identity's
  machine lock (C1B §8), which serializes two of them on one identity as the gc fence did: the second finds the first's
  target or receipt and replays it, instead of failing on its key with 23505 (901 L). It also orders a confirmation
  after a machine reservation of the identity still in flight. The confirmation needs nothing more: the node deletes the
  volume on an unlocked read of `qorpera_runtime_identity_retirements_due` before it confirms, the confirmation only
  records that evidence, and the deletion's finisher and purge take the fence `FOR UPDATE`.
- **No cycle:**
  - Against effects that hold only the company (`KEY SHARE` at the fence and rank 0), no conflict. Against a stop or a
    resume (the fence `FOR UPDATE`), they wait at the fence holding nothing (901 B).
  - Against member writes (member management and the removal's prelude, rule saves, display names, joins): all take
    their member rows at rank 1 before any identity, so they wait for recovery or it waits for them holding no identity
    (901 H, I).
  - Against a new sign-in (the identity `FOR SHARE`, then the earlier sign-in `FOR NO KEY UPDATE`) and a completion (the
    sign-in, then the identity): recovery holds no sign-in, the backup only `KEY SHARE` (901 C, D). A completion that
    already holds the identity `KEY SHARE` takes its epoch trigger's `FOR SHARE` without queueing behind recovery's
    waiting `FOR UPDATE`, and finishes first (901 E).
  - Against a sign-in's or a run's machine reservation (the fence, rank 0, the requester's member row, the identity's
    machine lock, the sign-in `FOR UPDATE`, the identity `FOR SHARE`): the member locks are compatible, recovery takes
    neither the machine lock nor the sign-in, and the backup takes the sign-in before the identity, as they do (901 J).
- **Snapshot-v1** keeps the gc fence in each `else` branch, untested (`folder-v2` only since 3 Oct). Legacy sweep F2d
  (20260930293000) removed those branches and the decision's `folder-v2` condition: every company takes these paths,
  and one without a folder fails at its fence (42501 "Company folder is unavailable", 901 M). A key backup's and a
  login's or refresh's recovery request no longer hold their sign-in `FOR SHARE` on any company.

**Tests.** 901 (dblink, waits checked through `pg_blocking_pids`, locks probed `NOWAIT`):
- A: beside a folder effect (the fence and the company row `KEY SHARE`), every call finishes: target registration, backup
  preparation and completion, the three requests, consent, cancellation, a key release, the member role and a
  retirement confirmation.
- B: behind a stop's second phase, each call waits at the fence holding no identity, member row, sign-in, refresh
  request or company row, then goes on.
- C: a new sign-in cancels the earlier one at once while a login's recovery request and a backup's preparation on it wait
  at the identity; both then refuse on their re-check. A refresh's request refuses the same way once its refresh request
  is cancelled meanwhile.
- D: a completion holds the sign-in and the identity `KEY SHARE`; the request waits for it at the identity, holding an
  uninvolved member's row, then refuses the completed sign-in.
- E: a completion and a key release on an identity whose recovery is approved: the release waits at the identity, the
  completion's trigger refuses the fenced generation (42501, no deadlock), the release goes on.
- F: the recovery completes (commit and completion through `qorpera_recovery_locked`), and a request on the identity's
  sign-in, still pinned to the older epoch, goes through, as does its replay.
- G: the helper is postgres-only and holds the fence and the company row `KEY SHARE` and every member row `FOR SHARE`,
  and no identity.
- H: a role change and a recovery, in either order, queue (no 40P01).
- I: two decisions on one identity (the member's consent, the owner's cancellation) queue, and the second finds its
  review changed; a decision and the removal of the identity's owner queue, the decision holding no identity.
- J: a backup's completion and a login machine reservation of one sign-in queue at the sign-in.
- L: two registrations of one target, and two successful retirement confirmations of one identity (the company's
  deletion requested, its machines ended over ten minutes ago), serialize on the identity's machine lock; the second
  replays the first's target or receipt.
- K: each patched branch is present, with no snapshot-v1 text pins.
- M: on a company without a folder, the owner's recovery member role and recovery decision fail at the fence (F2d).

Fault runs (a temporary driver on the test machine), 26 faults, each caught where intended: a site or the helper that
keeps the gc fence in A; the login's request holding its sign-in in B (or, without B, in C); a dropped re-check, or the
backup holding its sign-in `FOR SHARE` (taken after the fence), in C; the helper without the member rows, or with the
owners only, in D; the re-check comparing the identity's epoch in F; members `FOR UPDATE` in G; the decision without
its locks in I; the backup without its `KEY SHARE` in J; the registration or the confirmation without the identity's
machine lock in L.

838's `p13_allowed` list loses the eleven sites.

### 6.19 P06d part 1 as built: a screenshot stored nowhere travels in its answer (runtime only)

The coordinator approved the P06d design on 4 October: on folder-v2 nothing stores a screenshot. Its PNG goes from the
office service to the native host in the screenshot's own perform answer, and the model gets it from the host's memory.
The screenshot's receipt is its record. This part is the runtime. Part 2 (SQL) lifts 3l part 3's refusal (§6.22) and
gives the capture its folder-v2 authority (§6.21). Until then nothing reaches this path.

- **The office service** (`CloudCompanyComputerScreenshots.publish`):
  - when the capture's authorize answers `{state: "authorized", storage: "none"}`, it uploads nothing;
  - the published identity must name the operation's receipt (`assetId` is the receipt id);
  - the PNG then waits in memory for the native gateway's answer.

  `{state: "authorized"}` alone still means the stored legacy path. A session keeps one publisher for its whole life,
  so a new automation (a reattached browser) doesn't lose a waiting screenshot.
- **The native gateway** attaches the waiting PNG as `image` (base64), and only to a `computer_screenshot` perform
  answer, taking it once. An answer with `image` may be up to 11 MiB (`COMPANY_COMPUTER_NATIVE_MAX_SCREENSHOT_RESPONSE`,
  an 8 MiB PNG as base64). Every other answer keeps the 48 KiB bound.
- **The native host** (`HttpCompanyComputerNativeEndpoint.perform`):
  - reads a screenshot's answer up to 11 MiB;
  - accepts `image` only on a screenshot's answer, only as strict base64, only with JSON content whose identity names
    this receipt, and only when the bytes are exactly that capture's (PNG header, size, width, height, sha256);
  - then hands the bytes to the run's capture reader and returns the content without them, so the receipt stores only
    the identity, as before.

  The factory makes one capture reader per run and shares it between the endpoint and the boundary's
  `CloudNativeCaptureImages`.
- **To the model.** `read` makes the SQL read check, takes the bytes from memory once, checks them, and makes the SQL
  check again. It never fetches them from the object store. A second read finds nothing in memory and goes to the
  object store, as a stored capture does.
- **Bounds.** `CompanyComputerInlineScreenshots` holds at most 4 screenshots, each for at most 60 s, on both sides; past
  the bound the oldest goes. The executor runs one operation at a time, so one is the usual count.
- **Mixed versions:**
  - an old office service with the new host: no `image` ever comes;
  - a new office service with an old host: it sends `image` only after a `storage: none` answer, which no database
    gives until part 2;
  - part 2 is applied after this release has rolled to every node and office (v173).
- **Tests:**
  - `cloud-company-computer-screenshots.test.ts`:
    - nothing uploaded, the receipt named, and the pixels taken once;
    - any other storage answer or identity refused;
    - an inline read with both SQL checks and no fetch;
    - pixels that aren't the published capture's refused;
    - the holder's 4 and 60 s bounds;
  - `cloud-company-computer-native.test.ts`, over real TLS:
    - a 256 KiB PNG (past the 48 KiB bound) goes from the guest session through the gateway, the host, the receipt
      and the capture reader to the model's data URL, with no object fetch;
    - `image` on a non-screenshot answer, on an identity naming another receipt, on text content, or as malformed
      base64 is refused before anything is kept.

### 6.20 C1c-3i part b as built: machine events reach their runs (migration 20260930058000, test 848)

**Before.** A company machine's events (`qorpera_company_machine_events`: a command that ended, a machine that runs, one
stopped before it ran) never reached a folder-v2 run:
- the pin trigger refused a `machine-event` wake (0A000);
- `qorpera_folder_wake_authorized` answered false for it;
- `qorpera_folder_run_resolve` refused its run (0A000);
- the legacy drain skipped folder-v2, and since P28 nothing calls it.

**The source kind on folder-v2.**
- The three refusals lose the `'machine-event'` token only. Each list is found by its own statement and count-checked.
  A list left empty (A1's C1c-3l removes `'office-activation'`, in either order) drops its whole statement.
- `qorpera_folder_wake_authorized` admits the event in a parent's room conversation, as a worker's completion is, and
  checks its chain with `qorpera_machine_wake_ancestry`.
- The pin trigger's agent branch already takes the parent's conversation, starter sponsor and ancestry for it, and
  P28's materializer copies the parent's capability and publication.

**Continuing a parent run** (two helpers, for any drain that continues one):
- `qorpera_folder_parent_continuation(parent, source_kind)`, with no locks:
  - `ready`;
  - `running` (its job is queued or leased: wait);
  - `pending` (a wake of that kind for it is queued, or materialized with its job missing, queued or leased: one at a
    time);
  - `stopped` (job cancelled, or revivals stopped: suppress; since C3c a `worker-completion` asks
    `qorpera_worker_revival_stopped`, which skips the quiet questions, and every other kind
    `qorpera_machine_revival_stopped`);
  - `gone` (no run or job: undeliverable).
- `qorpera_folder_insert_continuation(parent, source_kind, source_id, payload)`: the agent wake, under the caller's
  admission. The pin trigger fills the conversation, requester, payer and causal chain.

**The drain** (`machine_events` in the shared folder drains, LISTENER §9):
- **`qorpera_folder_machine_events_due`** lists the folder-v2 environments, not deleting and not paused, with a waiting
  event whose parent is ready, stopped or gone. A new partial index on waiting events by environment serves it.
- **`qorpera_folder_machine_events_company(environment, limit ≤ 64)`:**
  1. plain reads of the parents (oldest event first), each classified;
  2. the folder fence `KEY SHARE`, rank 0, and the ready parents' requesters, agents and authorities `KEY SHARE`
     (ranks 1 to 3, as the listener's wakes);
  3. `deleting` / `paused` answers;
  4. each parent's events `FOR UPDATE SKIP LOCKED` (run-owned rows, at most 8, oldest first), in parent-id order,
     classified again under them;
  5. the parents' conversations `KEY SHARE` in id order, then admission once;
  6. one wake per parent, its events in at most 6 KiB (as the legacy drain cut them).

  A queued wake marks its events delivered. A pause at admission leaves them waiting. A stopped parent's events are
  suppressed, and a gone parent's, or one whose wake is refused (42501, P0002, 55000, check, unique, size), are
  undeliverable; the answer names the last refusal (`lastError`). 55P03 and 40P01 answer `busy`.

**No cycle.** It takes nothing stronger than `KEY SHARE` before its events, and its events are its own rows:
- effects never wait for it, and it never waits for them;
- a stop's second phase, a resume or a deletion's finisher (the fence `FOR UPDATE`) makes it wait at the fence while it
  holds nothing;
- two steps of one company skip each other's events.

**Quiet coding check-ins** (C3c, migration 20260930107500, tests 934 and 936; STATE-FILES §8 "Plan (C3)"): the drain
`coding_checkins`, built once C3a opened coding dispatch on folder-v2. A check-in is a `worker-completion` wake for the
worker's steering run, classified by `qorpera_folder_parent_continuation`. It is inserted directly rather than through
`qorpera_folder_insert_continuation`, because it keeps the legacy key, which a new turn and a stopped question read.
- **`qorpera_folder_coding_checkins_due`** lists the folder-v2 environments, not deleting, not paused and not out of
  computer hours, with a due session of a worker neither erased nor retired whose parent is ready, stopped or gone.
- **`qorpera_folder_coding_checkins_company(environment, limit ≤ 32)`:**
  1. plain reads of the due sessions, longest quiet first, each parent classified;
  2. the folder fence `KEY SHARE`, rank 0, each session's coding worker rows (`qorpera_coding_worker_targets`, none
     required) and the ready parents' requesters, agents and authorities `KEY SHARE` (ranks 1 to 5);
  3. `deleting` / `paused` / `at_zero` answers;
  4. the ready parents' conversations `KEY SHARE` in id order (rank 10), then the sessions `FOR NO KEY UPDATE` in
     worker order, each read again under them;
  5. admission, last, only when a question is to be asked; one question per parent, its parent classified again.

  An erased or retired worker, or a stopped parent, has its mark counted as asked (`suppressed`); a gone parent's, or a
  refused wake's (42501, P0002, 55000, check, unique, size), is `undeliverable`, and the answer names the last refusal
  (`lastError`). 55P03 and 40P01 answer `busy`.

**No cycle, for the check-ins.** The step takes a coding worker's rows as every writer of a coding worker does
(`qorpera_coding_worker_targets`, in rank order under the fence), the session rows after rank 10 as core §3 puts them,
and admission last.

**Tests of the check-ins.** 934 covers the parents, the marks, the question, the refusals and the answers. 936 (dblink, on
648's committed fixture) covers the step against other connections:
- A: locks:
  - beside an effect, no wait;
  - behind a stop's second phase, it waits at the fence holding no session, worker, todo or member row.
- B: one continuation of a parent across transactions. The step and F2's worker drain (either first), and two steps
  holding different sessions of one parent, meet at admission and leave one queued `worker-completion` wake.
- C: a lock timeout answers `busy` and marks nothing.

**b9's machine check-ins** (#800, stacked later) use the same helpers with a new source kind, `machine-checkin`, which
they add to the pin trigger's agent branch, the wake checks and the materializer's parent copy. Busy coding sessions'
check-ins (20260930109000) ride the same kind to the worker's steering run.

**Tests.** 848, on 648's committed fixture:
- A: no folder-v2 refusal names the kind, and a continuation without admission is refused.
- B: the drain:
  - a running parent's events wait;
  - an ended one's oldest 8 go in one authorized wake into its conversation, under one admission;
  - one continuation at a time, then the rest;
  - a long batch is cut to 6 KiB;
  - cancelled and gone parents;
  - a paused company is left alone, then served after the resume.
- C: locks:
  - beside an effect, no wait;
  - behind a stop's second phase, it waits at the fence holding no event or member row;
  - held events are skipped;
  - a lock timeout answers `busy`.
- D: grants, bounds and the page.
- E: markers.

656 §1 no longer pins the pin trigger's snapshot-v1 text (no snapshot-v1 pins since 3 October).

### 6.21 P06d part 2 as built: screenshots on folder-v2, stored nowhere (migration 20260930057000, test 910)

The SQL half of P06d (design approved by the coordinator on 4 October; the runtime half is §6.19). It lifts 3l part 3's
refusal (§6.22): an agent's screenshot on a folder-v2 company now works, and nothing stores it. **Apply it only after
every office runs the P06d part 1 office code** (v172 or later, by package or image): an older office service fails
on `storage: none` and leaves its receipt open. The coordinator settles the office lane before v173.

- **The operation.** `qorpera_native_office_operation` no longer refuses a screenshot on folder-v2. At begin, a folder-v2
  screenshot's office resource keeps the resources it is taken under, in a new column `target_resources`: the office
  grant and its version, the privacy version, and the browser profile, grant and version for a browser screenshot.
- **The capture** (`qorpera_native_office_capture`), folder-v2 branch:
  - authorize answers `{state: "authorized", storage: "none"}`, so the office service uploads nothing;
  - publish answers the screenshot's identity under the operation's receipt (`assetId` is the receipt id), after the
    operation's own check, as the stored path does;
  - no artifact, capture row, retention hold or company object is made. The receipt, completed with that identity, is
    the screenshot's record.
- **The check** (`qorpera_folder_office_captures_checked(binding, authority, assets)`, plain reads, no lock). The caller
  reads the run's authority once for the whole set (review r1's H1 on #793: per-screenshot reads took about 3 s for
  64). Each screenshot must be:
  - this run's completed `computer_screenshot:` receipt, with exactly that identity as its answer;
  - with its office resource drained, on the same run and screen;
  - taken under resources that are still current: the computer still the company's and shared, at the same privacy
    version; the agent's access active at the same grant and version; for a browser screenshot, the browser grant
    still active at the same version on the same prepared profile (review r1's M1).

  It does **not** ask that the computer be running (the coordinator's decision of 4 October): an idle power-off must
  not end a run that took a screenshot. A grant change, a privacy change or a member's private session still withdraws
  it, because the image may show private data; the run then ends at its next model request, as on the stored path.
- **Its users.** The capture read and the capture-set check answer through it on folder-v2. The folder-v2 context view
  (`qorpera_folder_record_context_view`) now takes a screenshot output: it checks the output's shape in its loop
  (22023 "Native capture invalid") and the view's screenshots as one set after it. Before, it refused any screenshot
  with 0A000.
- **Legacy sweep F2b (20260930291000)** made this the only path: the capture, the capture-set check and the read keep
  their folder-v2 branch on every company. The stored path's tails go: 20260930190000's 0A000 refusal of a snapshot-v1
  screenshot and the object reads. `qorpera_native_office_operation` keeps a screenshot's target resources on every
  company.
- **Tests:**
  - 910 (648's committed fixture; the computer up and Ada's screen acquired):
    - A: Ada's desktop screenshot runs through the operation and the capture with nothing stored, and its resource
      keeps the descriptor's resources;
    - B: the read and the set check answer it; a changed identity, an unknown one, and another run's screenshot (its
      receipt and resource both naming that run) are refused;
    - C: a computer that is not running does not withdraw it;
    - D: a privacy version change, a private session, a changed grant version, a revoked access, and a browser grant
      it was taken under that is no longer active each withdraw it;
    - E: the context view records a view with it and refuses a changed one;
    - F: a set of 64 is checked within 2 s;
    - G: the markers.
  - 652's screenshot case now expects the shape refusal; 647 no longer pins the capture;
  - 891 (3l part 3's refusal) is retired.

### 6.22 C1c-3l part 3 as built: no screenshot on folder-v2 yet (migration 20260930030200, test 891)

P06d part 2 (§6.21) lifts this refusal and replaces test 891 with 910. The runtime's relay of a refusal at authorize
(`CloudToolAuthorizeRefusal`) stays for any later use.

The coordinator's P06c, third PR. Before, an agent's `computer_screenshot` on a folder-v2 company was authorized and its
receipt began; only then did `qorpera_native_office_capture` refuse with 0A000. The receipt stayed open, and an open
receipt fences the run's later operations.

- **The refusal.** `qorpera_native_office_operation` now refuses a screenshot on folder-v2:
  - at authorize, which the runtime calls before it begins the receipt, it answers `{state: "refused", message}`
    ("Screenshots are not available on this computer yet. For a web page, use a browser snapshot instead.");
  - at begin and check it raises 0A000.
  - finish is unchanged: it finds no resource for a refused screenshot and raises 42501.

  No receipt opens, and the run goes on. Every other kind of operation is unchanged.
- **What the model sees.** The runtime gives the message to the model as the tool's answer: `REFUSED: Screenshots are
  not available…`. Three narrow runtime changes do it:
  - the Company Computer's effect control turns exactly that answer to an authorize, with a message of 1 to 512
    printable ASCII characters, into a `CloudToolAuthorizeRefusal`. Any other answer is still unconfirmed;
  - the operation executor relays that refusal only from the authorize before the receipt. Raised at any later step,
    or any other error there, it is still an unknown outcome;
  - the tool boundary relays it as any tool's refusal (`CloudToolRefusal`): denied, with its plain reason.

  A retry with the same operation key gets the same refusal, and a new key is refused again. The registry still
  keeps only the SQLSTATE of an error, never its message. A runtime from before this release reports an unconfirmed
  outcome instead, and still opens no receipt.
- **Why not the screenshot itself.** Review r1 of the first version, which sent the screenshot "to the model only",
  found two gaps:
  - the pixels stay in the Company Computer's office service, but the native host reads them, and only a 48 KiB JSON
    answer passes between the two;
  - the folder-v2 context view (`qorpera_folder_record_context_view`, 652) refuses a model request that carries a
    screenshot.

  Real screenshots on folder-v2 are their own design: a short-lived pixel transfer from the office service to the
  native host, and screenshot support in the folder-v2 context view. That needs a guest and runtime release.
- **Test 891** (648's committed fixture; the company's computer started and active, as in 893):
  - A: Ada's desktop and browser screenshots are refused at authorize with the message, and the run has no screenshot
    receipt;
  - B: her screen operation still authorizes, and the run's next operation begins, is admitted, finishes and completes;
  - C: a screenshot whose receipt began anyway is refused at begin and at check, and takes no office resource;
  - D: exactly the patched function names the migration.
- **Runtime tests:**
  - `cloud-company-computer-effect-control.test.ts`: only that exact answer to an authorize becomes the refusal. A
    message that isn't plain, is empty or too long, an extra key, or the same answer at begin stays unconfirmed;
  - `cloud-native-tool-operations.test.ts`: the refusal comes back from the authorize before the receipt, and the same
    key answers it again with no receipt. A plain `CloudToolRefusal` there, or the refusal after the receipt began,
    stays an unknown outcome and keeps its fence;
  - `cloud-native-tool-boundary.test.ts`: the model gets `REFUSED: <message>`.

### 6.23 Company accounts on folder-v2 as built (migration 20260930072000, test 925)

A1-7, the design `a1-scratch/accounts-folder-v2-design.md`, approved by the coordinator on 4 October with three
conditions (below). Until now every account function refused a folder-v2 company (0A000, "Accounts for folder companies
come with their connection file"); since 3 October every company is folder-v2, so accounts were unusable. Each ported
function now serves folder-v2 only and refuses any other company with 0A000 "Accounts need a company on the company
folder", read before any lock: through the run's job (the broker calls and the agent's read) or the account's
environment (a removal). No snapshot-v1 path is left, and no account function reaches the gc fence. The connection file
already worked on folder-v2 (P22): opening marks it, closing revokes the secret and the writer deletes the file.

| Function | Order on folder-v2 |
|---|---|
| `qorpera_company_account_call` (every broker call but the fill) | plain reads (the switch, the authority, the job of the authority's company), the core through the job, the run check (`qorpera_native_tool_locked_run` → `qorpera_folder_tool_run`: the run mutex, the job and the fence `KEY SHARE`, the company row `KEY SHARE` at rank 0, the run's principals), then the call's own arguments. It no longer reads the receipt. |
| `qorpera_company_account_receipt` (new, internal) | the receipt `FOR UPDATE` with exactly the call's old checks: this run's executing `cloud_tool` receipt, the input and downstream digests, the key `company_account:<action>:<account>:<key>`, every comparison null-safe |
| use, a new version, the state | the call; the secret, then the account (`qorpera_company_account_locked`, rank 8); then the receipt; then the work. A close of a closed account answers it after checking its receipt, with no vault row locked |
| describe-open | the call, then the receipt (no vault row) |
| open | the call; the company's account claim (rank 9); under it the repeat, the id, the todo, the duplicate login and the vault name; the receipt; the inserts. A repeat answers its account after checking its receipt |
| fill | plain reads and the core as the call; the envelope; the run check; the computer (office, screen, activation) by plain reads; the secret, then the account; then the receipt |
| find | the core through the job (a job of the old core is answered `refused` 0A000; a binding that names no job raises 42501), then the run check (a folder-v2 binding is now validated: the refusal came first until now), then plain reads |
| remove (owner, admin) | plain checks (the role, the account, the core); `qorpera_folder_company_enter` (the pause refused, the fence `KEY SHARE` with the pause read again, the company row `KEY SHARE` at rank 0, the caller's member row `KEY SHARE` at rank 1, required); the deletion and the role again; the secret, then the account `FOR UPDATE`; the revoke and close as before |

Unchanged: the list, `qorpera_company_account_mail`, the triggers, the descriptor, `qorpera_company_account_locked`, and
the operator switch (`qorpera_company_account_settings.enabled`). The runtime still hides the `company_account` tool on
folder companies (`!context.folder`); offering it is the next PR (TypeScript, a later train).

- **The receipt after the vault rows.** Core §3 puts run-owned rows after rank 9 (§5.7); the account calls locked the
  receipt first. No path held a secret and then waited for a receipt, so this keeps one order rather than fixing a known
  deadlock. The call still refuses a missing receipt id, digest or (after the opening) account before any vault row,
  with the receipt's refusal, so "a missing account is a broker fault, never 'no such account'" (794) holds.
- **The company's account claim** (the coordinator's conditions): `pg_advisory_xact_lock(hashtextextended(
  'qorpera.company-accounts:' || <company>, 0))`, transaction-scoped, built as E1's per-company lock for hooks and
  mailboxes (`'qorpera.event-hooks:' || <company>`, #815) so the two namespaces never share a key. E1 has no shared helper,
  so each names its namespace once, inline. It is listed in core §3 step 4 at rank 9: test 838 lists no lock-order sites
  or advisory locks (its checks are the gc fence, the job, the run mutex, the folder fence's modes and deferred
  constraints), so the rank list is the record. It replaces the old company lock that kept the duplicate check and the
  vault-name loop free of races. A race now waits for the claim and answers "already has this account" or the replay.
- **The unique indexes stay the final guard.** A 23505 on `qorpera_company_accounts_open_login` or
  `qorpera_cloud_secrets_active_name` (a writer that took no claim) answers the duplicate check's own refusal, 23505
  "The company already has this account; use it"; any other conflict (the secret's primary key: the broker's chosen id)
  stays a broker fault in Postgres' words.
- **Error order.** A call that is not its receipt's is still refused, now after the vault rows (use, version, state,
  fill) or after the checks under the claim (open): an opening for a login the company already has answers "already has
  this account" before its receipt is checked. Nothing is written before the receipt.
- **Tests.**
  - **925** (924's base: Alice's leased run): A, every function end to end (describe, open with Alice's todo and a live
    company mailbox, find, use, a version, connected, needs_person, a fill into the computer, the list, closed, an
    owner's removal; the connection files marked); B, a real snapshot-v1 company (its own authority, job and account) is
    refused by each ported function, writing nothing; C, a 23505 on either index answers the duplicate's refusal, forced in
    one session by a `BEFORE INSERT` trigger that writes the conflicting row after the plain check (and the primary key
    stays raw); D, the bodies: exactly the ten functions name the migration, the core before any lock, the vault rows
    before the receipt, the claim before the receipt and the inserts, the removal's enter before its vault rows; E, a
    removal on a paused company is refused (55000) and changes nothing.
  - **794, 813, 807** move onto 924's base in place (807 keeps its directly written computer rows: the fill only reads
    them), each with its cases; the folder-v2 refusal they checked is now the old core's refusal. 809 moves in B3 (#841).
  - **797** moves onto 648's committed fixture: 1 and 2 as before; 3, a removal against a use: the use's run check no
    longer takes the company row `FOR UPDATE`, so they meet at rank 8 in one order (the removal holds the secret and waits
    for the account, the use waits for the secret holding neither the account nor its receipt), the removal lands and
    the use is refused; 4, a held secret makes a use wait before it locks its receipt (a `NOWAIT` probe finds the receipt
    free); 5, a held claim makes an opening wait with its receipt free, and it answers its replay (5a) or "already has this
    account" (5b); a writer without the claim is caught by the login's (5c) and the vault name's (5d) indexes, their
    23505 answered the same way.

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
