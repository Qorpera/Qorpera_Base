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

## Change 1: the serving switch (migration `20260928180000`)

- **The switch is `qorpera_runtime_nodes.enabled`.** These already require it:
  - `qorpera_runtime_node_placement_candidates`, used by the node chooser, the login route pick
    and the company machine fleet;
  - the fresh branch of `qorpera_coding_executor_pick`;
  - `qorpera_reserve_runtime_node_machine`, which refuses a new reservation and a sleeping
    machine's wake with `NODE_DISABLED`. A reservation the node already holds (reserved and awake)
    passes admission again, because coding turns and sign-ins re-ask it before each step, so they
    finish.
  - `qorpera_claim_coding_session`: an executor on an emptying node starts no new coding turn. A
    turn it is running keeps its lease and finishes.
- **Work pinned to the node by a disk stays pinned.** It waits for the node to return:
  - runs of a member whose login lives on the node (the identity-home rule, until logins move
    into the vault, `20260928161000`);
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
  - It needs no company pause and locks no company row.
  - It refuses with 55000 while the older signed updater (`20260921010000`) has any unresumed
    target for the node, because a prepared update pins the node's version.
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
1. Apply `20260928180000` (dry run first). Guard marker for the release branch:
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
   - return with `true`. The observer's next receipt makes the node placeable again.

   Until logins are in the vault, runs of members whose login lives on the node wait while it is
   empty. Keep that window short.

## Change 4: each run keeps its version (migration `20260928182000`)

- **How a run gets its bundle.** A run is bound to a runtime bundle when it is created: its
  inputs' bundle, else the active bundle (`20260828019300`). The run's host refuses any other
  bundle (`assertCloudRuntimeBundle`). Today every cut pauses all companies, so that no run of
  the old bundle remains when the new one activates.
- **Where old-bundle runs come from after a switch:**
  - inputs accepted before the switch;
  - the retry of a run that failed (it keeps its run);
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
  - `servedBy` and `servedOnServingNode`: live orchestrators on a serving node, or with no node
    row, that declare this bundle or nothing.

  It also lists `undeclaredLive`, the live orchestrators that declare nothing. `servedBy` is an
  upper bound: an undeclared orchestrator's host refuses bundles it does not run, the
  identity-home rule still applies, and a just re-registered orchestrator counts as live for up
  to 2 minutes before it starts. During a roll `undeclaredLive` should be empty.
- **Things read from the active bundle.** Old-bundle runs themselves are not affected: a run's
  model policy comes from its own bundle, and only a conversation's displayed defaults follow the
  active one. Two cases need care:
  - The office package install requires an exact match with the active bundle, so a release that
    changes the office package installs it after the switch, or pauses.
  - A release whose migrations change what the old host reads or sends pauses (see
    `RUNTIME-ROLLING-UPDATE.md`).

### Use in a rolling update (change 7 writes the full procedure)

1. Apply the release's migrations. They must be safe for the running bundle N.
2. Empty node A (`qorpera_set_runtime_node_serving`), wait for `readyForUpdate`, then update it:
   node release, image, rebuild the fast host. The rebuild re-registers the fast host's
   orchestrator, which clears any declaration.
3. Declare **every** orchestrator on node A as N+1, the rebuilt fast host included, and every
   orchestrator on node B as N. `undeclaredLive` must be empty. Return node A to serving.
4. Activate N+1: new inputs and runs bind to N+1, and only node A takes them. Node B finishes N.
5. When `qorpera_runtime_bundle_roll_status()` shows no queued or running N runs, and no N input
   that can still run, empty node B and update it. Its rebuild clears its fast host's
   declaration; declare all of node B's orchestrators as N+1 and return it.
6. Clear every declaration.

### Rollout (coordinator)

SQL only, safe for the running bundle, and nothing changes until an operator declares.
- **Activation guard** for the release branch: `declared.runtime_bundle_sha256` present in the
  claim function. Check that it is ABSENT live first.
- **Stacking.** This PR is stacked on change 1 (#424) and needs `20260928180000` first
  (`qorpera_runtime_orchestrator_nodes`).
- **Every cut's preflight**, paused or rolling: no declaration may be left over. A leftover
  declaration stops that orchestrator from claiming runs of the new bundle.

  ```sql
  select id, provider_adapter, runtime_bundle_sha256 from public.qorpera_runner_orchestrators
  where runtime_bundle_sha256 is not null and status <> 'revoked';
  ```

  This must return no rows before a paused cut.
