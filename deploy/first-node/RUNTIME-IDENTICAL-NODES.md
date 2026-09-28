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

- The switch is `qorpera_runtime_nodes.enabled`. Every placement copy already requires it:
  - `qorpera_runtime_node_placement_candidates`, used by the node chooser, the login route pick
    and the company machine fleet;
  - `qorpera_coding_executor_pick`;
  - `qorpera_reserve_runtime_node_machine`, which refuses a new reservation, or the resume of a
    suspended one, with `NODE_DISABLED`.

  Existing reservations stay, so running work finishes.
- `qorpera_set_runtime_node_serving(node, serving, expectedVersion, reason)` (service role) flips
  only `enabled`:
  - It takes the same node-only locks as `qorpera_configure_runtime_node`: the advisory lock,
    then the node row.
  - It writes the next policy version with the same values and `enabled` changed, and records
    `(node, version, serving, reason)` in `qorpera_runtime_node_serving_changes`.
  - It needs no company pause and locks no company row.
  - While the older signed updater (`20260921010000`) holds the node, it refuses with 55000.
  - Asking for the current state returns `changed: false`.
- A version bump means the observer's next inventory receipt is needed before the node is
  inventory-ready again (about 5 s). This matters only when the node returns to service.
- The orchestrator claim returns nothing when the orchestrator's adapter maps, through
  `qorpera_runtime_node_providers` of kind native, only to switched-off nodes. Claim replays still
  work. Adapters with no node row keep today's behaviour.

  Before this change, the fast host kept claiming on a switched-off node, because it reserves no
  node demand.
- Admission deferral (`qorpera_release_runner_job_claim`):

  | Refusal | Who waits |
  |---|---|
  | Node-local: `SANDBOX_CAPACITY_EXHAUSTED`, `SANDBOX_RETIRING`, `NODE_DISABLED`, `NODE_OBSERVATION_UNAVAILABLE`, `NODE_HARDWARE_CHANGED`, `NODE_CAPACITY_EXHAUSTED`, `NODE_PROVIDER_UNCONFIGURED` | Only the refusing orchestrator, 15 s |
  | A second node-local refusal by another orchestrator, inside the first one's wait | Every orchestrator, 15 s (no ping-pong between two full nodes) |
  | `NODE_NOT_PREFERRED`, `NODE_IDENTITY_ELSEWHERE` | The refuser, 5 s (unchanged) |
  | Anything else | Everyone, 15 s (unchanged) |

  Before this change, a full fast host made every node wait 15 s.
- `qorpera_runtime_node_drain_status(node)` (service role) reports:
  - `serving` and the last change;
  - `runs`: claims held by the node's orchestrators, counting `claimed`/`assigned`, and `accepted`
    while the job is `leased`/`running`. This covers fast-host sandboxes, which the node agent's
    quiet gate cannot see.
  - `runMachines` (native demands) and `signIns` (login demands);
  - `machinesAwake` by kind (office, coding, machine) and `machinesAsleep` (suspended demands);
  - the node's orchestrators.

  `readyForUpdate` means not serving and no runs, run machines, sign-ins or other reservations.
  `readyForRestart` additionally means no awake machine. Parked warm hosts inside the fast host
  are not in the database. They end within the warm window (5 min), or when the host is cleared,
  as in today's cut script.

### Rollout (coordinator, at a cut)

No runner, image, provider or guest change. It is SQL only and safe for the running bundle, so the
migration can go in any cut without a pause.

1. Apply `20260928180000` (dry run first). Guard marker for the release branch:
   `qorpera_runtime_orchestrator_nodes(v_adapter)` present in
   `qorpera_claim_runner_job_for_orchestrator`. Check that it is ABSENT live first.
2. Read-only check that each live orchestrator's adapter maps to its node:

   ```sql
   select o.id, o.provider_adapter, o.status, n.node_id, n.enabled
   from public.qorpera_runner_orchestrators o
   left join lateral public.qorpera_runtime_orchestrator_nodes(o.provider_adapter) n on true
   where o.status <> 'revoked';
   ```

   An active orchestrator with no node row is not stopped by the switch. Enroll its adapter as a
   native node provider on its node before relying on the switch.
3. Use: `select public.qorpera_set_runtime_node_serving('<node>', false, <version>, '<reason>')`
   (service role claims). Watch `qorpera_runtime_node_drain_status('<node>')` until
   `readyForUpdate`. Clear parked warm hosts if the update rebuilds the fast host. Return with
   `serving = true`. The observer's next receipt makes the node placeable again.
