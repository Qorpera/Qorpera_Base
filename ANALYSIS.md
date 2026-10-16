# Runtime lock analysis (v23 live, 2026-09-12)

Scope: analysis only. `qorpera_validate_native_provider_execution_lease` keeps
its job -> profile-fence order (migration `20260912000400`). Lock sequences
below were read from the deployed function bodies at `7d745d309` (plus this
lane's migration) in a disposable PostgreSQL, not from the live node.

## Lock sequences (row locks, in statement order)

| Function | Order |
| --- | --- |
| `qorpera_validate_native_provider_execution_lease` | jobs[J] FOR UPDATE -> profiles[P] FOR UPDATE + wake_admission_fences[P] FOR UPDATE (`qorpera_lock_profile_gc_fence`) -> compute_identities[I] FOR SHARE -> runs/jobs/leases FOR SHARE |
| `qorpera_reserve_runtime_machine` | jobs[J] FOR UPDATE -> fence[P] -> runs[R] FOR SHARE -> runners[N] FOR SHARE -> allocations FOR UPDATE |
| `qorpera_assign_runner_job` | claims[C] FOR UPDATE -> jobs[J] FOR UPDATE -> runners[N] UPDATE / FOR UPDATE |
| `qorpera_claim_runner_job_for_orchestrator` | orchestrators[O] FOR NO KEY UPDATE SKIP LOCKED (heartbeat, only when 5 s old; no reconcile since 20260930482000) -> queued jobs FOR UPDATE SKIP LOCKED |
| `qorpera_reconcile_runner_orchestrator_without_sponsored_turns` | bulk UPDATE queued jobs (3 statements, join order decides row order) -> leased jobs FOR UPDATE SKIP LOCKED + `qorpera_terminalize_runner_attempt` (jobs[J] FOR UPDATE) -> stale runners FOR UPDATE SKIP LOCKED (this lane) -> bulk UPDATE assignments, claims |
| `qorpera_renew_runner_job` | jobs[J] FOR UPDATE |
| `qorpera_complete_runner_job_v6` | jobs[J] FOR UPDATE -> ... -> `qorpera_complete_runner_job_v4` (job/runner updates) |
| `qorpera_accept_runner_assignment` | runners[N] FOR UPDATE -> assignments -> jobs[J] FOR UPDATE -> claims[C] |
| `qorpera_claim_runner_job` | runners[N] FOR UPDATE -> leased jobs loop -> candidate job FOR UPDATE |
| `qorpera_revoke_runner` | runners[N] FOR UPDATE -> leased jobs (`qorpera_terminalize_runner_attempt`: jobs[J] FOR UPDATE) |
| `qorpera_release_runtime_machine` | fence[P] -> allocations FOR UPDATE |
| `qorpera_claim_company_object_gc` (before this lane) | fence[P1], fence[P2], ... accumulated for every visited profile, never released inside the 8 s statement |
| fence-first RPCs (pause, Company File writes, wake admission, office lifecycle, machine limits) | fence[P] -> their own tables; none of the 66 fence callers locks `qorpera_runner_jobs` or `qorpera_runners` after the fence |
| `qorpera_set_chatgpt_plan_work_while_away`, turning a plan on with a routine to start (added 2026-10-01, `20260928369985`) | profiles[P] FOR KEY SHARE (the lock its routine version insert's foreign key takes, first, so it is never awaited while the login is held) -> waiting routines FOR UPDATE SKIP LOCKED, id order -> consent: profile_members[P,U] FOR SHARE -> provider_connections[C] FOR UPDATE -> binding, versions, cursors, routine rows; `lock_timeout` 2 s, a timeout answers 55P03. Without a routine to start: the consent's two locks only. The key share is held across the member-row and connection waits, so exclusive company-row takers (an agent tool call's fence FOR UPDATE, a deletion request) wait behind the switch for that long, each switch wait at most 2 s. One cycle remains, rare: an operator deleting a founder's account (the cascade locks the member row, then the founder guard wants the company row FOR UPDATE) while that founder presses Turn on (key share held, waiting for that member row); PostgreSQL breaks it after deadlock_timeout (1 s); on the switch's side that, like a lock wait over 2 s, answers 55P03 busy with nothing changed |

## What the live symptoms are

### The 5-minute cancellations and the run aborts: a convoy, not a cycle

There is no profile-fence-first path that later waits on a job row, so
job -> fence (validation, machine reservation) cannot close a cycle with the
fence-first writers. What happens instead:

1. `qorpera_claim_company_object_gc` takes fence[P] (and the fences of every
   profile it visits) and then works for the whole 8 s budget; the statement
   is cancelled and rolled back, so the fence is held for ~8 s every 5 min.
2. A native host's lease validation for a run in P holds jobs[J] and waits on
   fence[P].
3. `qorpera_renew_runner_job`, `qorpera_assign_runner_job` (holding claims[C]),
   `qorpera_complete_runner_job_v6` and the reconciler's terminalize step all
   queue behind jobs[J] (the "row-lock queues on qorpera_runner_jobs").
4. Every waiter inherits the role's 8 s `statement_timeout` / `lock_timeout`;
   whichever expires first returns 500 to its caller. For the host that is a
   failed validation, which aborts the native execution fail-closed
   (`Native provider bridge request failed (422)`, `category=cancelled`).

This lane removes step 1 (candidate selection without the fence, the fence
only around one profile's lease insert) and raises the per-function
`lock_timeout` for the RPCs in step 3 to 25 s. Note that a function-level
`statement_timeout` cannot re-arm the timer the calling statement already
started from the role value (verified in `360_runtime_contention_hardening`):
until the `authenticator` role's `statement_timeout` is raised for these
calls, the 8 s ceiling still applies to the whole statement.

### The two `deadlock detected` events: job <-> runner order inversion

The only closable cycle in the table above is between the job row and the
runner row:

- `qorpera_assign_runner_job` holds claims[C] and jobs[J], then waits on
  runners[N] (the logical-computer UPDATE and the `for update` runner select).
- `qorpera_accept_runner_assignment` (and `qorpera_claim_runner_job`,
  `qorpera_revoke_runner`) hold runners[N] first, then wait on jobs[J].

With the same job J and runner N this is a deadlock:

```
assign:  C -> J (held) -> N (wait)
accept:  N (held) -> assignment -> J (wait)
```

The pair (J, N) is the same when the orchestrator re-assigns a job whose
earlier assignment it is superseding ("Superseded after orchestrator
recovery") to the runner that is at that moment accepting the earlier
assignment. That is exactly the retry storm the convoy above produces: the
8 s cancellations make the orchestrator and the guest retry against the same
job/runner pair, so the inversion becomes reachable. The second variant is
`qorpera_reserve_runtime_machine` (J -> fence -> runners[N] FOR SHARE) against
`qorpera_accept_runner_assignment` (N -> J) for the same run: FOR SHARE on N
conflicts with the FOR UPDATE the accept path holds, and the accept path
waits on J.

The reconciler's new stale-runner step locks runner rows before the
orchestrator claim path locks a queued job (N -> J), but only rows that are
`active` with a session expired more than 30 minutes ago and no queued or
leased job, using SKIP LOCKED. Such a runner cannot be an assignment target
(assignment requires a live session), so it does not participate in the
J -> N order of `qorpera_assign_runner_job`.

## Recommended follow-up (not done here)

1. Make the runner-side paths job-first: in `qorpera_accept_runner_assignment`
   and `qorpera_claim_runner_job`, take jobs[J] FOR UPDATE before
   runners[N] FOR UPDATE (or replace the runner FOR UPDATE with FOR SHARE /
   a plain read plus a conditional UPDATE). That aligns every path on
   claims -> jobs -> runners and removes the only cycle in the table. Keep
   validation as it is (job -> fence): dropping its job FOR UPDATE, as the
   proposal also suggests, would be the alternative, but the 20260912000400
   lock selector exists precisely to serialize direct host monitoring behind
   the job the tools already hold.
2. Deployment step for item 1 of this lane: raise `statement_timeout` for the
   PostgREST `authenticator` role (or scope it via the PostgREST pre-request
   hook to these RPCs) to at least 25 s; the per-function `lock_timeout`
   declared here is effective immediately, the per-function
   `statement_timeout` only after that change. This is a live configuration
   change and is out of scope for this local lane.
3. Reconciler bulk updates: the three `update qorpera_runner_jobs ... where
   status = 'queued'` statements join `qorpera_execution_runs` and can lock
   queued rows in planner order; two orchestrator claims running reconcile
   concurrently can invert that order. Add `for update skip locked` candidate
   selection (as the leased-job loop already does) or serialize reconcile per
   orchestrator with `pg_try_advisory_xact_lock(orchestrator_id)`.
4. Freeze runtime bundle v24 after this migration is accepted: the bundle
   manifest's `authorization` component hashes every migration, so
   `scripts/generate-cloud-runtime-bundle.mjs --check` reports the manifest
   as stale until the generator's activation constants are bumped and the
   v24 activation migration is generated.
