# Runs on the folder core (C4, P28)

Status: built, 4 October 2026 (Q1, the coordinator's slice P28): part 1 (§2, §3; migration `20260930018000`, #756) and
the runtime (§6, #761, #766). §4 and §5 turned out not to be needed (coordinator, 4 October). The founder decided on 3 October that production's companies are wiped and the
legacy (`snapshot-v1`) implementation gets no compatibility. So this builds `folder-v2` runs only, with no else-branch
for the old core.

**First milestone,** with F2's P14b: a new company whose Co-Founder answers. Creation writes the Co-Founder's kickoff and
its turn request, and no wake (RUNTIME-COMPANY-FOLDER-CREATION.md "The first run"). Before part 1 nothing turned that
into a run, and nothing answered a founder's post in a thread either: posts, answers, coworker messages and routine
firing insert queued wakes, and the wake materializer skips `folder-v2`.

## 1. Why the old materializers cannot serve the folder core

The orchestrator's 2 s reconcile lane calls one RPC, `qorpera_reconcile_runner_orchestrator`. That RPC runs the turn,
session, wake and proposal-review materializers in one transaction across every company. Each of them:
- takes the profile row `FOR UPDATE NOWAIT` (`qorpera_serialize_wake_admission`) and the Company File row, both of which
  core §9 forbids on `folder-v2`;
- needs the head snapshot and a substrate, which `folder-v2` never has;
- writes the job's and the run's substrate and snapshot ids, which are `NOT NULL`.

Wake admission must also handle exactly one company per transaction (core §3 step 10), because the admission mark holds
one company. So the folder materializer is new code, run once per company, each time in its own transaction.

## 2. Schema

- `qorpera_runner_jobs.substrate_version_id`, `qorpera_execution_runs.substrate_version_id` and
  `qorpera_execution_runs.company_snapshot_id` become nullable. Their foreign keys stay; dropping the columns is C6.
- `qorpera_execution_runs.company_seq bigint`: the folder clock's `last_seq` for the run's environment when it is
  materialized. The run was composed as of at least this commit (core §6, "The pin"); reads stay live.
- The check `qorpera_execution_runs_company_pin`: a run has its substrate and snapshot together, and exactly one of
  the snapshot and `company_seq`.
- The broker's description (`qorpera_folder_runner_broker_describe`) adds `company_seq` to the run's JSON. That
  parser is an open record.

## 3. The materializer (P28 part 1, migration `20260930018000`, SQL test 874)

**`qorpera_folder_materialize_due(after, limit)`** (service role) lists the companies with due work, paged by profile id,
without a lock. A company is due when it is `folder-v2`, not paused, not at zero hours, and has either:
- a queued turn request at the head of its open conversation, with its input pending and no live turn there; or
- a queued wake whose `not_before` has passed. A wake left waiting with its reason counts again after 30 seconds, so a
  full login is not retried on every pass.

Partial indexes on `(profile_id, admission_scan_at, created_at, id) where status = 'queued'` serve the per-company
reads of wakes and turn requests.

**`qorpera_folder_materialize_company(profile, limit ≤ 16)`** (service role) handles one company, in the caller's
transaction, in core §3's order:
1. **The work, read without a lock:** at most `limit` items, turn requests and due wakes in one scan order (oldest scan
   first), so neither starves the other. A request behind an earlier one in its conversation, or behind a live turn,
   is not work this pass. This only names the rows to lock. The turn requests then run first, then the wakes, each in
   this order.
2. **The fence and ranks 0 to 5,** through `qorpera_folder_company_enter`: the pause, the fence `KEY SHARE`, the pause
   again (paused: the answer `paused`, nothing written), the company row `KEY SHARE`, then:
   - rank 1: each requester's member row `KEY SHARE`;
   - rank 2: each agent's staff row `KEY SHARE`;
   - rank 3: each wake's agent's execution authority `KEY SHARE`;
   - rank 4: a room wake's room `FOR SHARE`, as posting takes it;
   - rank 5: a routine wake's routine `FOR NO KEY UPDATE`, as firing takes it (the wake's status trigger updates its
     authorization count).
3. **Rank 5's last tables** (C1B §8): the model logins (connections, then their versions) `FOR UPDATE`, as the
   reservation locks them, then the compute identities `FOR SHARE NOWAIT`. A busy or recovering identity leaves its
   items queued.
4. **The work rows** `FOR UPDATE SKIP LOCKED`, still queued. Each moves to the back of the scan order.
5. **The conversations** `FOR UPDATE`, then the turn inputs `FOR UPDATE`, in id order, then the company's operation
   clock `FOR NO KEY UPDATE` when there are turns. A turn's transcript events update the clock, and admission comes
   after it. Taking it once here means no item takes it after another item has admitted.
6. **Each item, in its own subtransaction:**
   - the old materializers' checks: one turn at a time per conversation, the author's access, the agent, the sponsor
     binding and connection, the payer, the computer, the native capsule, or for a wake its authority, sponsor,
     computer and compute;
   - the job and run with no substrate or snapshot, `company_seq` from the clock, and the run's insert triggers;
   - `qorpera_reserve_execution_sponsor_authority` (reservation, budget, model policy);
   - for a turn: the input claimed, its transcript events (the operation clock), the request `materialized`;
   - for a wake: the wake `materialized`. A room post's events were appended when it was posted;
   - `qorpera_folder_admit_wakes`, once per transaction, then the run's `queued` event. For a turn, the event's trigger
     inserts the `first-run` or `human` wake under that admission.
7. **Refusals,** as the old materializers made them:
   - a turn request fails with its input, for a reason found before any write;
   - a wake is cancelled for missing authority or compute, or left queued with its reason for a missing computer or a
     busy identity;
   - a full reservation (`QFM01`) undoes the item's subtransaction: the request fails, or the wake waits with its
     reason;
   - the run's own refusals (42501: no model authority, the payer, the audience; 23505: a first run already woken;
     P0002) undo the item and fail the request or cancel the wake;
   - a stop or zero hours that arrives meanwhile (55000) or a busy row undoes the item and leaves it queued;
   - any other error undoes the item and leaves it queued (a wake with its reason), at the back of the scan order, so
     one item never stops the company.

It answers `{state: done, run_ids, failed, cancelled, blocked, skipped}`, or `idle`, `paused`, `at_zero`,
`not_folder` with nothing written. The subtransactions stay under the 64 the snapshot cache holds: one for the
enter, one per identity and one per item, each at most 16, plus the orchestrator wake-up trigger's (the review's
probe measured 30 for a 16-item pass).

**Model logins and identities** sit at rank 5, after the hook's tables (coordinator, 4 October; C1B §8 lists the
exact order). That matches the reservation's own order, the login consent (the member, then the connection) and the
runner's native lease (the job, then the connection). The old materializers took the conversation first; they no
longer run.

**The orchestrator:**
- The runner-orchestrator edge function gets the actions `folder_materialize_due` and `folder_materialize_company`.
- `CloudFolderRunMaterializer`, in the reconcile lane by default, calls them on every pass (2 s). It sends each
  company its own request, so each runs in its own transaction, before `reconcile` and the claim.
- An edge function that predates them answers 400. The lane reports it and asks again after ten minutes, as for
  C1c-3e.

**The legacy materializers** leave `reconcile` (coordinator, 4 October: production's companies were wiped). The RPC
keeps its heartbeat, the queued-job failures and the lease reconciliation. The functions themselves, their drains
and their tests go with A1's legacy-removal slice.

**Known gaps:**
- A run's model: `agent.md`'s `model` does not reach runs yet (F2-1b). A login that is not a native subscription
  needs a `qorpera_staff_provider_models` row, or the run's insert refuses 42501 and the item fails. The first run
  uses the founder's ChatGPT login, which answers `provider-default`.
- At zero hours the company is not listed, and its queued wakes show no reason.

## 4. Plain conversations: not needed

Not needed: `folder-v2` conversations are rooms. `qorpera_append_session_input`, `qorpera_request_session_turn` and its
v2 keep refusing `folder-v2` (0A000, C1c-3a):
- For one agent, the web opens the agent's thread (`qorpera_agent_thread`); for several, a group chat. Both are rooms,
  and posting in them already runs on `folder-v2` (C1c-3a's post, then §3's room wakes).
- The web falls back to `qorpera_request_session_turn_v2` only for a session that is not a room, and nothing creates one
  on `folder-v2`: `ensureStaffSession` and `appendPrompt` have no caller in the interface.
- A1's legacy-removal slice can delete the plain-session paths later.

## 5. The first run's dead request: not needed

`qorpera_queue_agent_first_run` returns an existing request whatever its status, so a failed first run cannot be started
again through `qorpera_start_agent_first_run`. Nothing calls that function, though. A founder whose Co-Founder's first
run failed posts in its thread, which wakes it (§3's room wakes). Kept here for whoever adds a restart:
- `qorpera_wake_first_run_once` is unique on `(environment_id, staff_agent_id)` with no status filter. A restart after
  the first run's wake exists would hit it (23505, which the materializer turns into a failed request). A restart must
  either reuse that wake or replace the first-run request only before it has a run.
- A member-private conversation's run insert takes the member row `FOR SHARE`
  (`qorpera_require_current_private_audience`), above rank 1's `KEY SHARE`.
- Since P15 a first run's turn request is the follow-up queue's, queued after the agent's default grant. A restart
  refuses while the agent's subject is not converged (a pending mark, a dirty work row, or no default grant), and runs
  in its own transaction after any kick, so it never meets the converge holding the kickoff input.

## 6. Runtime (separate PR, P28b)

- **The wake envelope's `pins`** are parsed as closed, with exactly four keys. The runtime must accept `companySeq`
  before SQL sends it. So the run's `company_seq` reaches the runtime through the run JSON first. `pins.companySeq`
  follows once that runtime is live.
- **The Co-Founder's overlay** points it at `organization/agents` and `organization/formation.json`, which do not exist
  on `folder-v2`. It needs the `agents/` and `vision/` wording, or the Co-Founder's first answer will be lost on missing
  files.

## 7. Not in P28

- F2's worker drain (F2-5b-3) and the listener (P29). Each runs in its own transaction, one company at a time, as its
  own orchestrator step before the materializer's list (coordinator, 4 October). A drain admits wakes, and admission
  must come after the materializer's ranks, so neither runs inside `qorpera_folder_materialize_company`.
- Human-task wakes (P31).
- Machine events (C1c-3i), the observability views (P32), and the edge functions (P26).

## 8. Switch-on

- Every host must run the #709 builds first: the orchestrator, the LXD providers and the shared execution guests (C1C
  §5.10).
- Then the runtime of P28b.
- Then creation (P39).
