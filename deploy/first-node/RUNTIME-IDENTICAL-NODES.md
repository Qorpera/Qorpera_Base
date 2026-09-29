# Identical nodes (Stateless Compute steps 2–4)

Design page for the founder: "Identical Nodes" (https://claude.ai/artifact/8Gm5z4Jym3fpLWpeXe4t9Y).
Lead plan: Rebuild Map workstream S3. Step 1, model logins in the vault, is
`RUNTIME-LOGIN-VAULT.md`; its change 3 removes the identity-home pin that still sends every
member run to the login's node. This file is the technical design, and it grows one section per
change.

## Target

- Both nodes run the same services: the inventory observer and node agent with a build space, a
  shared execution host (fast host) plus the fresh-VM overflow path, the vault and its helper, the
  machine services (coding, company machines, test machines), and the company-folder services (F3).
- One placement for every machine kind. A node is eligible when it is enabled, freshly `ready`,
  inventory-ready and has room for the machine's own size. A warm conversation (the conversation's
  last run ended within the warm window on that node) and a sleeping machine with its own disk stay
  on their node. Otherwise the most free room wins: the smaller of free CPU share and free memory
  share.
- A node is serving or emptying. Emptying stops new placement on that node and leaves running work
  alone.
- Rolling updates. Migrations must be safe for the running bundle, and one node at a time is
  emptied, updated and returned. Each orchestrator declares the bundle it runs, and a claim matches
  `qorpera_execution_runs.runtime_bundle_sha256`. The host already refuses any other bundle
  (`assertCloudRuntimeBundle`). A company-wide pause remains only for releases whose database
  changes the running bundle cannot live with.
- One inventory policy shape for both nodes. The fast host is listed by role, and its image must
  come from a signed release installed on the node. Build machines go in a declared build space
  counted against headroom. Everything else stays exact.

## Change 1: the serving switch (migration `20260928180700`)

- **The switch is `qorpera_runtime_nodes.enabled`.** These require it (the last two as changed
  here):
  - `qorpera_runtime_node_placement_candidates`, used by the node chooser, the login route pick
    and the company machine fleet;
  - the fresh branch of `qorpera_coding_executor_pick`;
  - `qorpera_reserve_runtime_node_machine`, which refuses a new reservation and a sleeping
    machine's wake with `NODE_DISABLED`. A reservation the node already holds (reserved and awake)
    passes admission again, because coding turns and sign-ins re-ask it before each step, so they
    finish.
  - `qorpera_claim_coding_session`: an executor on an emptying node starts no new coding turn. A
    turn it is running keeps its lease and finishes. Its queued turns are left out of the
    candidate query, so they take no locks and do not crowd out a lapsed turn waiting to be failed.
- **Work pinned to the node by a disk stays pinned.** It waits for the node to return:
  - runs of a member whose login lives on the node (the identity-home rule, until logins move
    into the vault, `20260928180600`);
  - a sleeping machine's wake;
  - a new coding turn for a member whose machine is there (the sticky branches of the executor
    pick send it to that node's executor, which does not start it while the node empties);
  - a sign-in the gateway chooser already routed there.

  The switch needs no pause, but for those members emptying acts like one. Queued runs fail after
  24 h. Since 27 September node 2 holds every login, so until logins are in the vault, empty
  node 2 only briefly.
- **`qorpera_set_runtime_node_serving(node, serving, expectedVersion, reason)`** (service role)
  flips only `enabled`:
  - It takes the same node-only locks as `qorpera_configure_runtime_node`: the advisory lock,
    then the node row.
  - It keeps the node's policy version and records `(node, version, serving, reason)` in
    `qorpera_runtime_node_serving_changes`, one row per switch. The observer's inventory receipt
    names the node version; a new version would refuse every admission, held ones included, until
    the next scan. `enabled` is not part of the inventory context.
  - It sets `enabled` in the stored policy of that version too, so the signed updater, which checks
    and restores `enabled` from it, and anyone who rebuilds a policy from it see the node as it is.
  - The version check guards against a policy change in between, not against another switch: two
    operators or scripts switching the same node do not see each other. `lastChange` in the drain
    status says who switched last. `qorpera_configure_runtime_node`'s version check does not see a
    switch either: a configure built from a policy read before a switch sets `enabled` back to what
    that policy said. Do not switch a node while its policy is being changed; read the stored
    policy right before a configure, and check `lastChange` in the drain status afterwards.
  - A node switched off before a signed update stays off after it, because the updater restores
    `enabled`. Switch it back on once the update has finished.
  - It needs no company pause and locks no company row.
  - It refuses with 55000 while the older signed updater (`20260921010000`) has any unresumed
    target for the node, because a prepared update binds `enabled`.
  - Asking for the current state returns `changed: false`.
- **Claim.** The orchestrator claim returns nothing when the orchestrator's adapter maps, through
  `qorpera_runtime_node_providers` of kind native, only to switched-off nodes. Claim replays still
  work. Adapters with no node row behave as before. An adapter that also maps to a serving node
  keeps claiming; the drain status reports it. Before this change, the fast host kept claiming on
  a switched-off node, because it reserves no node demand.
- **Admission deferral** (`qorpera_release_runner_job_claim`):

  | Refusal | Who waits |
  |---|---|
  | Node-local: `SANDBOX_CAPACITY_EXHAUSTED`, `SANDBOX_RETIRING`, `NODE_DISABLED`, `NODE_OBSERVATION_UNAVAILABLE`, `NODE_HARDWARE_CHANGED`, `NODE_CAPACITY_EXHAUSTED`, `NODE_PROVIDER_UNCONFIGURED` | Only the refusing orchestrator, 15 s |
  | Node-local, while another orchestrator's refuser-only wait on the job is unexpired (its refusal of any kind) | Every orchestrator, 15 s (no ping-pong between two full nodes) |
  | `NODE_NOT_PREFERRED`, `NODE_IDENTITY_ELSEWHERE` | The refuser, 5 s (unchanged) |
  | Anything else | Everyone, 15 s (unchanged) |

  Before this change, a full fast host made every node wait 15 s.
- **`qorpera_runtime_node_drain_status(node)`** (service role) reports:
  - `serving` and the last change;
  - `runs`: claims held by the node's orchestrators, counting `claimed`/`assigned`, and each
    leased job's newest `accepted` claim. This covers fast-host sandboxes, which the node agent's
    quiet gate cannot see.
  - `runMachines` (native demands) and `signIns` (login demands);
  - `codingTurns`: sessions preparing, running or publishing under a live lease of one of the
    node's coding executors. Swapping the executor would end them.
  - `machinesAwake` by demand kind and `machinesAsleep` (suspended demands);
  - the node's orchestrators, and `orchestratorsServingElsewhere`: orchestrators whose adapter also
    maps to another serving node, which the switch does not stop.

  `readyForUpdate` means not serving, no runs, run machines, sign-ins, coding turns or other
  reservations, and nobody serving elsewhere. `readyForRestart` additionally means no awake
  machine. Parked warm hosts inside the fast host are not in the database. They end within the
  warm window (5 min), or when the host is cleared, as in today's cut script.

### Rollout (coordinator, at a cut)

No runner, image, provider or guest change. It is SQL only and safe for the running bundle, so the
migration can go in any cut without a pause.

0. **Before applying** (read-only), check that no live orchestrator sits on a switched-off node.
   After the migration such an orchestrator stops claiming at once.

   ```sql
   select n.id, n.label, n.enabled, o.id, o.provider_adapter
   from public.qorpera_runner_orchestrators o
   join public.qorpera_runtime_node_providers p on p.provider_kind = 'native' and p.provider_id = o.provider_adapter
   join public.qorpera_runtime_nodes n on n.id = p.node_id
   where o.status <> 'revoked' and not n.enabled;
   ```

   It must return no rows, or only nodes that should stay empty. Also check for unfinished
   signed-updater targets; the switch refuses on a node that has one, and nothing cancels a
   target:

   ```sql
   select node_id, revision, disabled_version, resumed_version
   from public.qorpera_node_update_targets where resumed_version is null;
   ```
1. Apply `20260928180700` (dry run first), after S1's `20260928180600`. Guard marker for the release branch:
   `qorpera_runtime_orchestrator_nodes(v_adapter)` present in
   `qorpera_claim_runner_job_for_orchestrator`. Check that it is ABSENT live first.
2. Read-only check that each live orchestrator's adapter maps to exactly one node:

   ```sql
   select o.id, o.provider_adapter, o.status, array_agg(n.node_id) nodes, bool_or(n.enabled) serving
   from public.qorpera_runner_orchestrators o
   left join lateral public.qorpera_runtime_orchestrator_nodes(o.provider_adapter) n on true
   where o.status <> 'revoked'
   group by o.id, o.provider_adapter, o.status;
   ```

   An active orchestrator with no node is not stopped by the switch; enroll its adapter as a native
   node provider on its node first. One with two nodes is not stopped while the other serves.
3. Use (service role claims):
   - empty: `select public.qorpera_set_runtime_node_serving('<node>', false, <version>, '<reason>')`;
   - watch `qorpera_runtime_node_drain_status('<node>')` until `readyForUpdate`;
   - clear parked warm hosts if the fast host is rebuilt;
   - return with `true`. The node is placeable at once: its version and inventory receipt did not
     change.

   Until logins are in the vault, runs of members whose login lives on the node wait while it is
   empty. Keep that window short.

## Change 3: runs follow the placement (migration `20260928183000`)

It is stacked on three changes:
- logins in the vault change 3 (`20260928180600`, #427), whose `qorpera_compute_identity_login_in_vault`
  frees a run from the login's home node;
- change 1 (`20260928180700`, #424);
- change 4 (`20260928182000`, #429).

It sorts after change 4 because it reads its bundle declarations.

- **Dispatch roles.** `qorpera_set_runner_orchestrator_dispatch_role(orchestrator, 'fast' |
  'overflow' | null)` (service role). `fast` is a shared execution host; `overflow` is the
  fresh-VM path. An orchestrator without a role claims exactly as before.
- **Which fast hosts count.** Only fast hosts that are:
  - active and live (heartbeat within 30 s);
  - on a serving node;
  - allowed by the run's login (`qorpera_runtime_run_adapter_allowed`, the claim's own home rule);
  - declared for the run's bundle, or for none.
- **`qorpera_runtime_run_placement(job, run)`** (service role) gives the preferred node and the
  reason:
  - `WARM_CONVERSATION`: the conversation's previous run completed within 5 minutes, and its
    newest accepted claim is one of those fast hosts. It is found through the new index
    `qorpera_execution_runs_session_created`. The lookup is keyed on the conversation only. In a
    group chat the previous run may be another agent's, which is harmless: the fast host matches
    its warm slots by agent and version itself.
  - `LEAST_BUSY`: the node whose fast hosts hold the fewest runs. It counts held claims, and each
    leased job's newest accepted claim, never the run's own. Every node has the same fast host,
    so this is the most free fast room. Ties go to the lower node id.
  - `NO_FAST_HOST`: none may take it.
- **Claim turn**, a claim predicate:
  - A fast host claims at once on the preferred node. Elsewhere it claims after a 1.5 s head
    start, or at once when the preferred node's orchestrator refused.
  - An overflow orchestrator claims when:
    - a fast host refused the run (`SANDBOX_CAPACITY_EXHAUSTED`, `SANDBOX_RETIRING`, or
      `NODE_NOT_PREFERRED` from a fast host), even inside that refusal's wait. It never does so
      within 15 s of its own refusal of that run, read from its released claim, so two full
      paths cannot trade a job back and forth;
    - no fast host may take the run;
    - or the run has waited 10 s.
  - Waits count from `queued_at`, so a retry or a sponsor handoff starts them again.
- **One authority.** `qorpera_reserve_runtime_machine` no longer asks the node chooser
  (`qorpera_runtime_node_placement_decide`) about a run claimed by an orchestrator with a role.
  - The chooser ranks by free ledger slots and could refuse the chosen fast host (the fast host
    reserves no node demand).
  - Instead, the reservation records the claim turn's placement in `qorpera_runtime_node_placements`
    (`decision placed`, `reason CLAIM_TURN_<reason>`).
  - The claim's `orchestrator_claimed` event carries `placement: {reason, nodeId}`. Since the run's
    own claim never counts, the event and the record name the same preferred node (an overflow
    claim is recorded on its own node, with the fast host's node as preferred). A fast host whose
    adapter has no node row is recorded as `unbound`.
- **Roles and re-registration.** A rebuild re-registers on the same adapter and keeps the role.
  Re-registering on another adapter (another node or path) clears it.
- **Cost.** It reads orchestrators and node rows by key, held claims through their partial index,
  leased jobs through the queue index, claims by run, and previous runs through the new index. It
  returns early on the time checks before it computes a placement, and it adds no lock.

### Rollout (coordinator)

1. **Order.** Apply after `20260928180600`, `20260928180700` and `20260928182000` (dry run first).
   - The index is built first, under `lock_timeout 10s`. It holds a short write lock on
     `qorpera_execution_runs` (about 0.25 s per 300k rows).
   - The orchestrator table is altered last, so claims wait only for the rest of the transaction.
   - **Activation guard:** `qorpera_runtime_claim_turn(p_orchestrator_id, job, run)` present in the
     claim function. Check that it is ABSENT live first.
2. **Before setting roles** (read-only):
   - every active orchestrator maps to exactly one node (change 1's step 2 query);
   - no live orchestrator stays without a role, because a runner without one claims at once and
     bypasses the placement. Revoke stale ones: da49750d was revoked in v142. This query must list
     nothing once roles are set:

     ```sql
     select id, provider_adapter, last_heartbeat_at from public.qorpera_runner_orchestrators
     where status = 'active' and dispatch_role is null;
     ```
3. **Set roles**, and don't use roles for member runs before every active login is in the vault:
   - node 2's exec host orchestrator: `fast`;
   - node 1's fresh-VM orchestrator: `overflow`;
   - node 1's fast host, once created: `fast`.

   With only node 2's fast host, runs whose login lives on node 1 still go to node 1 at once,
   because no fast host may take them. Runs node 2's fast host refuses go to node 1 at once. With
   two fast hosts, work that fast hosts do not serve (proposal review, other harnesses) is refused
   by one of them first and then goes to the overflow at once; it may meet both fast hosts, as it
   does without roles.
4. **Check.**
   - the query in step 2 lists nothing;
   - `orchestrator_claimed` events carry `placement`;
   - `qorpera_runtime_node_placements` rows read `CLAIM_TURN_*`;
   - member reply start is about 2 s.

   To undo, set the roles to `null`.

## Change 4: each run keeps its version (migration `20260928182000`)

- **How a run gets its bundle.** A run is bound to a runtime bundle when it is created: its
  inputs' bundle, else the active bundle (`20260828019300`). The run's host refuses any other
  bundle (`assertCloudRuntimeBundle`). Today every cut pauses all companies, so that no run of
  the old bundle remains when the new one activates.
- **Where old-bundle runs come from after a switch:**
  - inputs accepted before the switch;
  - the retry of a failed run (a new run whose inputs keep the old bundle);
  - a sponsorship request approved later.
- **Declaring a bundle.** `qorpera_declare_runner_orchestrator_bundle(orchestrator, sha | null)`
  (service role) records the bundle an orchestrator's hosts run. The bundle must be registered,
  and the orchestrator not revoked.
  - A declared orchestrator claims only runs whose `runtime_bundle_sha256` equals its
    declaration. The claim reads the declaration by primary key.
  - An undeclared orchestrator claims as before.
  - **Re-registering an orchestrator clears its declaration.** Every fast-host rebuild does
    that, and the rebuilt host may run another bundle. So a leftover declaration cannot outlive
    the host it described; after a rebuild, declare again.
- **`qorpera_runtime_bundle_roll_status()`** (service role) lists the active bundle and, for
  every bundle with work or a declaring orchestrator:
  - queued runs (unclaimed) and running runs (claimed or leased);
  - inputs not yet turned into a run, with the oldest one's time;
  - the declaring orchestrators with their nodes, serving state and heartbeats;
  - `servedBy` and `servedOnServingNode`: live, active orchestrators on a serving node, or with no
    node row, that declare this bundle or nothing.

  It also lists `undeclared`, the active orchestrators that declare nothing whatever their
  heartbeat (a rebuilt host left stopped claims at its first call), and `undeclaredLive`, the part
  of those with a heartbeat. `servedBy` is an upper bound: an undeclared orchestrator's host
  refuses bundles it does not run, the identity-home rule still applies, and a just re-registered
  orchestrator counts as live for up to 2 minutes before it starts. During a roll `undeclared`
  must be empty.
- **Things read from the active bundle.** Old-bundle runs themselves are not affected: a run's
  model policy comes from its own bundle, and only a conversation's displayed defaults follow the
  active one. Two cases need care:
  - A packaged office checks its package's bundle against the active bundle on every start, reset
    and install. Across a switch, a packaged office on the old package cannot start or reset
    until its package is renewed for the new bundle, as at every cut today.
  - A release whose migrations change what the old host reads or sends pauses (see
    `RUNTIME-ROLLING-UPDATE.md`).

### Use in a rolling update (change 7 writes the full procedure)

A bundle can be declared only once it is registered, and the activation migration registers and
activates it in one step. So the updated node stays switched off until the activation:

1. Apply the release's migrations. They must be safe for the running bundle N.
2. Declare every orchestrator on node B as N.
3. Empty node A (`qorpera_set_runtime_node_serving`), wait for `readyForUpdate`, then update it:
   node release, image, fast host rebuilt without a declaration. The rebuild re-registers the fast
   host's orchestrator, which clears any declaration. Start A's orchestrators; while A is switched
   off they claim nothing.
4. Activate N+1 with A still switched off. New inputs and runs bind to N+1 and wait briefly: B is
   declared N and A claims nothing.
5. Declare **every** orchestrator on node A as N+1, the rebuilt fast host included; `undeclared`
   must be empty and no orchestrator on A may still be declared N. Return node A to serving: it
   takes the N+1 runs. Node B finishes N.
6. When `qorpera_runtime_bundle_roll_status()` shows no queued or running N runs, and no N input
   that can still run, empty node B and update it; declare all of node B's orchestrators as N+1
   (N+1 is registered now, so B's fast host rebuild can declare it with
   `EXEC_RUNTIME_BUNDLE_SHA256`) and return it.
7. Clear every declaration.

### Rollout (coordinator)

SQL only, safe for the running bundle, and nothing changes until an operator declares.
- **Activation guard** for the release branch: `declared.runtime_bundle_sha256` present in the
  claim function. Check that it is ABSENT live first.
- **Stacking.** This PR is stacked on change 1 (#424) and needs `20260928180700` first
  (`qorpera_runtime_orchestrator_nodes`).
- **Every cut's preflight**, paused or rolling: no declaration may be left over. A leftover
  declaration stops that orchestrator from claiming runs of the new bundle.

  ```sql
  select id, provider_adapter, runtime_bundle_sha256 from public.qorpera_runner_orchestrators
  where runtime_bundle_sha256 is not null and status <> 'revoked';
  ```

  This must return no rows before a paused cut.

## A failed start moves the run on (migration `20260929240000`)

Found on 2026-09-29 (v148, A1): node 1 reserved a machine for a vault run's attempt, its start failed, and
every retry asked for the same runner. Node 2's exec host was refused it ("runner client id is already bound
to other compute authority"), node 1 could not replay its stopped acquisition, and the run failed after
eight dispatch failures.

Why: each attempt of a run has one runner, provisioned by whichever node acquires it under the attempt's
acquisition id (`runAttemptAcquisitionId`: the run id for attempt 1, a hash for later ones). The same id names
the attempt's machine allocation, a runner holds one allocation ever, and the attempt count only rose when a
runner accepted an assignment.

Now:
- **The claim release moves the attempt on.** When a claim release counts an infrastructure failure, and the
  attempt's allocation (read by its primary key, `qorpera_run_attempt_acquisition_id`, the SQL twin of the
  providers' function) is released while its runner is still pending, the release:
  - revokes the runner (receipt `runner_revoked`, reason `attempt_start_failed`);
  - raises the job's attempt count;
  - records the node that failed in `qorpera_runtime_run_start_failures` (one row per run, the latest);
  - adds `attempt_abandoned` and `start_failed_node_id` to the `infrastructure_retry` event.
  The next claim is the next attempt: a new acquisition id, runner, allocation and placement row.
- **Not moved on:**
  - a placement refusal (`ADMISSION_REFUSED:*`, including `NODE_NOT_PREFERRED`);
  - a pending runner without an allocation (the rebind of `20260928235000` gives it to the next provider);
  - an allocation that is not yet released (its machine may still exist). Its provider releases it, and a
    later failure then moves the attempt on.
- **The attempt budget.** If the raised count reaches the cap (8), the job fails at once ("Runner failed to
  start on its final attempt") instead of waiting unclaimable.
- **The failed node ranks last.** Both the node chooser (`qorpera_runtime_node_placement_decide`, now with a
  fifth argument; a reservation passes the run's failed node) and the claim turn's placement
  (`qorpera_runtime_run_placement`) rank that node after every other eligible node that fits. The claim turn
  doesn't prefer a warm host on it either. It is a ranking, not a ban: when it is the only node that fits, the
  run still goes there. Logins are unchanged.
- **The exec host's machine key names the attempt** (runner-orchestrator). The key of a released allocation
  stays taken, so a later attempt of the same run on the same slot needs its own.
- **Locks.** The release takes the job row (as before), then the runner row, and reads the allocation and its
  placement by primary key; the run's failure row is written last. A reservation reads the failure row by the
  run id it already holds. No company-wide lock.

### Rollout (coordinator)

The migration is safe for the running bundle: providers keep calling the same RPCs, and the four-argument
chooser still works. The exec host's new machine key ships with the next provider build; until then a retry
on the same slot of node 2 can still collide, as today. No activation guard is needed.
