# Shared execution service

One long-lived execution host per node serves every member run on that node.
A run is a **sandbox**: a pair of one-run systemd units (the member's native
provider host and the single-lane runner) on a numbered **slot** with its own
two accounts, two loopback ports, tmpfs credentials and scratch directories.
A sandbox starts in about a second; the virtual machine it replaces booted in
seventeen. The 2026-09-22 amendment in `QORPERA-RUNTIME-CONTRACT.md` § 19
records the contract effect.

What does **not** change:

- the guest image: the execution host boots the pinned LXD runner guest image
  and runs its `qorpera-native-provider-host.mjs`, `qorpera-ephemeral-runner.mjs`
  and bubblewrap containment unchanged; this package only adds the service,
  two unit templates, the slot accounts and the co-located orchestrator;
- the control plane: the same runner rows (`qorpera_provision_execution_runner`),
  the same company-ceiling reservation per sandbox
  (`qorpera_reserve_runtime_machine` / `qorpera_release_runtime_machine`), the
  same assignment protocol, the node's existing native adapter id;
- login custody: the member's Compute Identity volume is attached to the
  execution host under `/var/lib/qorpera/identities/<computeIdentityId>`; the
  service reads the capsule master key for one run and hands it to that run's
  native host as a systemd credential; the credential capsule is opened only
  inside the native host's private scratch root, as in a one-run guest.

## Layout inside the execution host

| Path | Owner | Purpose |
|---|---|---|
| `/opt/qorpera/shared-execution/qorpera-shared-execution-service.mjs` | root | the service (`shared-execution-cli.ts`) |
| `/opt/qorpera/runner-orchestrator/qorpera-runner-orchestrator.mjs` | root | co-located orchestrator, talks to the service on loopback |
| `/etc/qorpera/shared-execution.env`, `/etc/qorpera/shared-execution-credentials/` | root 0600/0700 | service configuration and its systemd credentials |
| `/etc/qorpera/runner-orchestrator.env` | root 0600 | orchestrator configuration (`QORPERA_RUNNER_PROVIDER_URL=http://127.0.0.1:18450`) |
| `/var/lib/qorpera/identities/<id>` | root, one mount each | attached Compute Identity volumes (the node's login gateway attaches them, see below) |
| `/var/lib/qorpera-shared-execution/journals/<acquisition>.json` | root | live sandbox journal (`qorpera.shared-execution-journal/v1`); terminal ones move to `journals/archive/<acquisition>.<ms>.<state>.json` |
| `/var/lib/qorpera-shared-execution/slots/<n>/host` | `qorpera-shared-host-<n>` | native host scratch (capsule opened here, wiped after the run) |
| `/var/lib/qorpera-shared-execution/slots/<n>/runner/{state,workspace}` | `qorpera-shared-runner-<n>` | runner authority state and workspace |
| `/run/qorpera-shared-execution/slots/<n>/{credentials/*,native-provider.env}` | root 0600, tmpfs | what PID 1 hands to the two units (`LoadCredential=`, `EnvironmentFile=`) |

Slot `n` listens on `portBase + 2n` (native host) and `portBase + 2n + 1`
(assignment inbox), both loopback. The runner configuration is written into
the slot's runner state, owned by the slot's runner account; no directory is
shared between the service and a slot.

## Sandbox lifecycle

1. `acquire`: work this host does not serve — another harness, proposal
   review — is answered as an `admission_refused` deferral with reason
   `NODE_NOT_PREFERRED`, which defers this orchestrator only so the provider
   that serves it can claim the job. A free slot or a deferral
   (`SANDBOX_CAPACITY_EXHAUSTED`); mint slot credentials; provision the
   runner; journal `reserving`; journal that the reservation is requested,
   then reserve the company ceiling (a refusal surfaces as the same 422 the
   LXD provider uses); verify the identity volume against the cloud recovery
   authority (marker, key digest, recovery epoch marker — never initialise);
   write the slot material; `starting`; start the host unit if it is not up,
   wait for `/healthz`; start the runner unit if it is not up, wait for its
   inbox; `registered`. A replay after a service restart resumes from
   whichever step the journal recorded.
2. `deliver`: post the assignment capability to the slot's inbox; `assigned`.
3. `reconcile` (every orchestrator poll and every 5 s on the service's own
   timer): unit states are read in one `systemctl is-active` query; a
   `registered`/`assigned` sandbox whose runner unit has exited is retired; a
   `reserving`/`starting` sandbox older than ten minutes is retired.
4. retire, in three phases so no lock is held while units stop: mark
   `stopping`; stop runner then host unit (bounded, never blocking); then
   verify both are down, remove the tmpfs material, empty the slot scratch,
   release the company ceiling exactly once (a reservation whose reply was
   lost is released on a best-effort basis), and archive the journal as
   `stopped` under `journals/archive/`. A retirement that keeps failing (a
   unit that will not die, a release the control plane does not confirm) is
   retried on every pass and after twelve failures archived as `lost` with the
   reason, so the slot returns to service and the live set stays small.

Retries: a retry of the same attempt after its sandbox was retired starts a
fresh sandbox with fresh credentials; a retry while that sandbox is still
retiring, or a later attempt while the prior one still holds a slot, is
deferred (`SANDBOX_RETIRING`) rather than failed; an older attempt than the
one holding the slot is refused.

## Warm conversations (contract amendment 2026-09-27)

Off unless `QORPERA_SHARED_EXECUTION_WARM_IDLE_MS` is set (at most 30 minutes;
the ratified window is 5 minutes, `300000`).

- An attended run (`session_turn` or `room_delivery` with a session) carries a
  conversation key: member login, company, agent and version, session, sponsor
  connection, model and compute template. Its native host gets
  `QORPERA_NATIVE_WARM_IDLE_MS` and keeps the run's opened capsule afterwards
  (see `packages/runtime`), and readies one spare Codex process.
- When such a run's runner exits, the slot **parks** instead of retiring: the
  runner stops, its state and one-run credentials are wiped, the company
  ceiling is released, the journal is archived `stopped`, and
  `warm/<slot>.json` records the key, the host's identity epoch and key digest,
  its bridge digest and the end of the window. The host unit keeps running.
- The next run with the same key claims the slot under the lock after the
  identity is read again exactly as for a new sandbox; a changed epoch or key,
  a stopped host or a passed window evicts the slot (SIGKILL, full wipe) and
  the run starts a fresh sandbox. A claimed slot gets new runner credentials,
  keeps the host's bridge credential and scratch, and starts only the runner.
- A parked slot counts as busy. When no slot is free, the slot parked longest
  gives way. Reconcile ends parked slots whose window passed or whose host
  stopped, stops hosts that neither a journal nor a warm record tracks, and
  (once per service start) wipes the scratch of every untracked slot.
- `rebuild-exec-host.sh` refuses while any slot unit runs, parked hosts
  included: stop the orchestrator, wait one window (5 minutes) for the parked
  hosts to end, then rebuild. With `EXEC_CLEAR_PARKED=1` the script ends parked
  hosts itself once the orchestrator is stopped (no run can claim them then); a
  runner unit or an active journal (a run in flight) still refuses. A rolling
  update uses it on a node that takes no runs (`RUNTIME-ROLLING-UPDATE.md`), with
  `EXEC_START_ORCHESTRATOR=1` to start the orchestrator again once the host is
  healthy and declared (the script fails unless it is still running a few
  seconds later): while the node takes no runs it reports heartbeats and claims
  nothing. A release still owed by a slot whose retries ran out sits in
  `journals/archive/*.lost.json`, which the rebuild wipes; in a roll the node's
  drain gate (`readyForNodeRelease`, no run machine left) covers it.

## A fast host on every node (identical nodes, change 5, 2026-09-28)

Design: "Identical Nodes" (https://claude.ai/artifact/8Gm5z4Jym3fpLWpeXe4t9Y) and
`deploy/first-node/RUNTIME-IDENTICAL-NODES.md` (from change 1, #424). Every node runs one execution
host, named `qorpera-exec-<short node name>` (`qorpera-exec-node01`, `qorpera-exec-node02`), sized so that one node alone carries the busiest five minutes of the
last week, parked warm hosts included. The fresh-VM path stays on every node as overflow.

**Sizing for light threads (2 Oct 2026).** A thread turn runs no command and gets no box (Jonas,
2 Oct: F3's run box moves to the machines), so a slot holds only its native host with Codex
(`MemoryMax=2G`, `CPUQuota=200%`) and its runner. The host is sized for turns at once, not heavy work:

- **4 slots per node, every node the same**: `EXEC_SLOTS=4 EXEC_SLOT_CPU=1 EXEC_SLOT_GIB=3`, so
  4 vCPU / 12 GiB. A slot's native host cannot pass 2 GiB, and the third GiB is for its runner and
  its share of the service, the orchestrator and the page cache. A turn mostly waits on the model;
  Codex's start (about 1.3 s) is the CPU peak, and `CPUQuota=200%` lets a slot use two vCPUs while
  others wait.
- **Why 4.** The busiest five minutes of the last week had 5 runs at once (28 Sep), at most 2 of
  them members'. Both nodes together hold 8 warm slots. While one node is emptied (a rolling
  update), the other holds 4, and a fifth run at once starts on that node's fresh-VM path (about
  17 s) or waits for a slot: a parked warm slot gives way to a new run. Raise the count when one
  node's peak passes 4.
- **Every node the same.** Placement prefers the node whose fast hosts hold the fewest runs (it
  counts runs, not slots), so a smaller host fills first. Node 2's host moves from 2 slots
  (4 vCPU / 8 GiB) to 4 slots (4 vCPU / 12 GiB), and node 2's headroom grows by 4 GiB: the observer
  needs the node's operating allowance, every infrastructure entry and the build space to fit inside
  the headroom (`runtime-node-inventory.ts`), and node 2's 32 GiB (25 Sep, "Capacity sizing") is its
  24 GiB allowance plus the 8 GiB host (step 8 reads the live values first).
- **Measure, then keep or adjust.** Before node 1's host is made, read the peak memory of node 2's
  slot units over a busy day (read-only). systemd logs each run unit's peak when it stops, Codex
  included (bubblewrap keeps it in the native host unit's cgroup):

  ```sh
  for u in 'qorpera-shared-run-host@*' 'qorpera-shared-runner@*'; do echo "$u"; lxc exec qorpera-exec-node02 --project qn25b2 -- journalctl --since -1d --no-pager -o cat -u "$u" | grep -o '[0-9.]*[KMG] memory peak' | sort -h | tail -3; done
  ```

  The guest's journal reaches back only to the host's last rebuild.

  If a unit's stop line carries no peak, sample live units repeatedly during busy minutes (a unit's
  cgroup goes when its run ends): `cat "/sys/fs/cgroup$(systemctl show -P ControlGroup "$u")/memory.peak"`
  for each `qorpera-shared-run-host@*` / `qorpera-shared-runner@*` unit. Keep 3 GiB per slot while the
  native host stays under 1.5 GiB and the runner under 0.5 GiB; otherwise use `EXEC_SLOT_GIB=4`
  (16 GiB).

- **`rebuild-exec-host.sh` has no node defaults.** `EXEC_VM`, `EXEC_PROJECT`, `EXEC_PACKAGE`,
  `EXEC_STAGING` and `EXEC_SLOTS` are required. The pilot default of 16 slots was wrong for
  node 2, which runs 2.
  - The staged `shared-execution.env` must set `QORPERA_SHARED_EXECUTION_SLOTS` to `EXEC_SLOTS`,
    since the service reads its slot count there (default 16). The script refuses otherwise, and
    also when a line it rewrites is missing (`QORPERA_NATIVE_CODEX_FENCE_SHA256`,
    `QORPERA_RUNNER_ORCHESTRATOR_CONTROL_TOKEN`). The cut lane passes the host's own value, so it
    agrees.
  - Optional `EXEC_RUNTIME_BUNDLE_SHA256` declares the re-registered orchestrator's bundle
    (rolling updates, migration `20260928182000`), as the last step, once the host is set up.
    Without it the orchestrator claims runs of any bundle; once that migration is live,
    re-registration clears an earlier declaration. Only a registered bundle can be declared, and
    the activation registers it: a rebuild before the activation runs without the variable, and
    the operator declares the orchestrator after the activation while the node is still switched
    off (`deploy/first-node/RUNTIME-ROLLING-UPDATE.md`). A refused declaration leaves the host set
    up and undeclared, and the script exits 1.
  - `EXEC_PREFLIGHT_ONLY=1` checks the inputs and changes nothing.
- **`create-exec-host.sh <fingerprint>`** makes a new host on any node:
  - it takes the same variables plus `EXEC_PROFILE`, `EXEC_POOL`, `EXEC_NETWORK` and the
    optional `EXEC_SLOT_CPU`/`EXEC_SLOT_GIB` (default 2 / 4), but never a bundle declaration;
  - it checks every input first (the rebuild's checks, and that the profile has no
    `user.qorpera.*` key, which the observer refuses on an infrastructure entry);
  - it creates the VM with the run VMs' profile, pool and isolated NIC and no identity devices;
  - it installs through `rebuild-exec-host.sh` in its new-host mode (`EXEC_FRESH=1`: nothing to
    stop, check or rebuild);
  - it prints two infrastructure entries: the exact one, and one listed by its job
    (`"role": "execution-host"`, `deploy/first-node/NODE-EXEC-HOST-BY-ROLE.md`). Use the one
    listed by its job only once that document's rollout steps 0–3 are done for the node;
  - if a step after `lxc init` fails, it deletes the VM it made. An orchestrator row it
    registered stays: nothing runs behind it, but the bundle roll status lists it as undeclared
    until it is revoked. There is no function for that: the coordinator sets its `status` to `revoked` in
    `qorpera_runner_orchestrators` by hand. A revoked id can never be registered again, so the next
    attempt needs a new id.
  - the staged `QORPERA_SHARED_EXECUTION_HOST_ID` must equal `EXEC_VM`, so a staging folder
    copied from another node is refused;

### Node 1, in this order (coordinator)

1. **Prerequisites.**
   - Logins in the vault change 3 is live (`20260928180600`), so member runs are not pinned to node 2's
     identity volumes. The two logins still on node 2's disk (2742ef0f, 544fb8b7) stay pinned to node
     2's host, with or without node 1's: the agreed exception.
   - **Dispatch roles are set** (identical nodes change 3, `RUNTIME-IDENTICAL-NODES.md` "Rollout"): node
     2's host `fast`, node 1's fresh-VM orchestrator `overflow`. Node 1's host and its fresh-VM
     orchestrator register with the same adapter (`native25-phql-a1`); only the role tells them apart.
     Without roles they would race for the same runs. The change 3 rule "every active login in the vault
     first" was about logins on node 1's disk: node 1's host attaches no identity volume, so it would
     claim such a run and hold it back. Before setting the roles, and again before step 7, run the
     login-homes query of `RUNTIME-ROLLING-UPDATE.md` step 1: no `homes` may contain node 1 (on 2 Oct
     both homes were node 2). Also check, read-only, that no queued run lacks a compute identity
     (`compute_identity_id is null`): the fast host fails such work with a counted error instead of
     refusing it, so with roles it would spend its attempts there.
   - `20260929999997` is live: after one fast host refuses a run for capacity, the fresh-VM path leaves
     it to the other node's fast host.
   - `NODE-EXEC-HOST-BY-ROLE.md` rollout steps 0–3 are done for node 1, so the host is listed by its job
     from day one and a rebuild never needs a re-enrol (the release that pins its image is staged on
     node 1 first).
2. **Quiet time.** From `lxc init` (step 5) until step 6, node 1's observer sees an instance its policy
   does not list and reports node 1 unavailable: node 1 takes no new work, computers included (the VM's
   boot, up to 4 minutes, the install and the observer restart). Pick a quiet few minutes and switch
   node 1's runs off first (`qorpera_set_runtime_node_runs`); node 2 serves runs
   meanwhile. Work already running on node 1 is not stopped.
3. **Room.** Raise node 1's headroom by the host's size, 4000 mcpu and 12 GiB at 4 slots
   (`qorpera_configure_runtime_node`, version CAS). It must still admit node 1's company machine.
4. **Staging.** Prepare the staging directory as root:
   - `shared-execution.env` from `shared-execution.env.example`, with node 1's native adapter
     (`QORPERA_RUNNER_PROVIDER_ADAPTER`), `QORPERA_SHARED_EXECUTION_HOST_ID=qorpera-exec-node01`,
     node 1's `QORPERA_RUNNER_NODE_ID`, `QORPERA_SHARED_EXECUTION_SLOTS=4` (the example says 16) and
     `QORPERA_SHARED_EXECUTION_WARM_IDLE_MS=300000`;
   - `runner-orchestrator.env` for a **new** orchestrator id, with a
     `QORPERA_RUNNER_ORCHESTRATOR_CONTROL_TOKEN=` line for the script to fill. Never copy node 2's
     id: registering it here would take over node 2's orchestrator;
   - the credentials, as for node 2;
   - every node 1 service URL on node 1's `:10000` front (tailnet address 100.75.4.70): `QORPERA_CLOUD_SECRET_BROKER_URL` (the example said
     `:10443` until 2 Oct; `RUNTIME-LOGIN-VAULT.md`), `QORPERA_NATIVE_OBJECT_GATEWAY_URL` and the computer
     URL. The guest guard on `qorpera0` (#684, observe mode first) lets a guest reach node 1 only on
     its listed ports (443, 8443, 8444, 10000, 18443, 18444, 18543, 18544), DNS and the coding gateway
     `10.41.0.1:8789`, plus the public internet (the model relay, Supabase).

   Node 1's LXD provider must **not** set `QORPERA_LXD_EXECUTION_HOST_INSTANCE`/`_PROJECT`. With
   logins in the vault no identity volume is attached to the host, and an attached one would
   change its inventory digest.
5. **Create.**
   `EXEC_VM=qorpera-exec-node01 EXEC_PROJECT=<node 1 run project> EXEC_PROFILE=<run profile> EXEC_POOL=qorpera-vm EXEC_NETWORK=qorpera0 EXEC_SLOTS=4 EXEC_SLOT_CPU=1 EXEC_SLOT_GIB=3 EXEC_PACKAGE=… EXEC_STAGING=… create-exec-host.sh <current image>`.
   Its orchestrator is registered and stays stopped. **Set its role before anything else:**
   `qorpera_set_runner_orchestrator_dispatch_role(<new id>, 'fast')`. A live orchestrator without a role
   claims at once and bypasses the placement.
6. **Enroll by role.** Replace node 1's inventory policy with the printed entry listed by its job
   (`"role": "execution-host"`) added (`qorpera_replace_runtime_node_inventory`). Write the observer
   configuration and restart the observer, then check that node 1 reports `ready`.
7. **Start.** Re-run the login-homes query (step 1). Start the host's orchestrator and switch node 1's
   runs on again. Check:
   - the new orchestrator row has `dispatch_role = 'fast'` and a fresh heartbeat;
   - change 3's query lists no active orchestrator without a role;
   - the first member run on node 1 starts in about 2 s, and `qorpera_runtime_node_placements` rows read
     `CLAIM_TURN_*` with both nodes.
8. **Node 2 to the same size.** Placement counts runs, not slots, so the two hosts must match. With node
   1's host serving, node 2's change needs no pause, only node 2 emptied of runs (its two disk logins
   wait meanwhile). Node 2 reads `unavailable` from the limit change (3) until its policy is replaced (6).
   1. Switch node 2's runs off and wait for `readyForNodeRelease`. No new computer starts on node 2
      until step 6 either: pick a quiet few minutes.
   2. Read node 2's policy (`headroom*`, the operating allowance, every infrastructure entry, the build
      space) and raise its headroom by 4 GiB (`qorpera_configure_runtime_node`, version CAS; the runs
      switch survives a new policy version). The sum must fit.
   3. Stop the VM (`lxc stop qorpera-exec-node02 --project qn25b2`), set `limits.cpu=4` and
      `limits.memory=12GiB`, start it. The rebuild needs a running VM, and keeps the stored limits.
   4. Set `QORPERA_SHARED_EXECUTION_SLOTS=4` in node 2's staging and rebuild:
      `EXEC_SLOTS=4 … rebuild-exec-host.sh <current image>` (the VM restart in step 3 ended any parked
      warm host; the installer makes the extra slot accounts). Without `EXEC_START_ORCHESTRATOR=1` its
      orchestrator stays stopped.
   5. Compute the role digest (the entry declares identity volumes):
      `lxc query '/1.0/instances/qorpera-exec-node02?project=qn25b2' | python3 deploy/shared-execution/exec-host-inventory-digest.py --pool qorpera-vm --source-prefix phql-a1-identity- --role execution-host`
      (from a checkout of the release commit).
   6. Replace node 2's policy with that digest and `memoryBytes` 12884901888 in the host's entry, and
      sync the observer. Node 2 reads `ready`.
   7. Start the orchestrator (its role stays: same adapter), check a fresh heartbeat, and switch node 2's
      runs on.
9. **Later, for symmetry:** a fresh-VM `overflow` orchestrator on node 2 (the node agent's orchestrator
   role, node 2's adapter, a new id). Until then, while node 1 is emptied, node 2 has no overflow: a fifth
   run at once waits for a slot, and work the fast hosts do not serve (proposal review, other harnesses,
   non-subscription sponsors) waits for node 1's whole turn, as it does today.

**Undo node 1's host.** Stop node 1's host **before** clearing any role: with no roles, node 1's two
orchestrators would race on one adapter. Either:
- **park it:** in the VM, `systemctl disable --now qorpera-runner-orchestrator.service` (it leaves the
  placement after 30 s). The VM and its policy entry stay, so node 1 stays `ready`; or
- **remove it:** switch node 1's runs off; stop the orchestrator as above; `lxc stop` and `lxc delete
  qorpera-exec-node01`; then remove its entry from node 1's policy and sync the observer (an instance
  the policy does not list, stopped or not, makes node 1 `unavailable`, so the VM goes first); lower the
  headroom; revoke its orchestrator row (a revoked id never registers again); switch node 1's runs on.

### In a rolling update

Both nodes now have a host, so each node's turn rebuilds its own (`RUNTIME-ROLLING-UPDATE.md` steps 5
and 8): node A's before the switch, without a bundle declaration; node B's after it, declared N+1. Each
rebuild is gated on its own node's drain receipt and agent apply, keeps the host's role (same adapter),
and needs no re-enrol (listed by role). While a node is emptied, its host and its fresh-VM orchestrator
both stop claiming (one adapter), and the other node's host takes the runs. Node 1's fresh-VM path is the
overflow during node 2's turn; node 2 has none during node 1's turn until step 9.

## Installing an execution host (pilot runbook, node 2)

This is how node 2's host was first made, kept for the record. The pilot sized it for 16 slots;
node 2 runs 2 today. For a new host use `create-exec-host.sh` above.

```sh
# On the node host, as a member of the lxd group. The pinned image is the
# provider's QORPERA_LXD_IMAGE_FINGERPRINT.
lxc init <image-fingerprint> qorpera-exec-node02 --project qn25b2 --vm \
  -p native25-job-a1 -s qorpera-vm \
  -c limits.cpu=16 -c limits.memory=32GiB -c boot.mode=uefi-secureboot \
  -d root,size=80GiB
lxc config device add qorpera-exec-node02 eth0 nic network=qorpera0 name=eth0 \
  security.ipv4_filtering=true security.ipv6_filtering=true \
  security.mac_filtering=true security.port_isolation=true --project qn25b2
# Identity volumes that exist already; later ones are attached by the node's
# login gateway (see "Identity volumes on the execution host").
for id in <computeIdentityId...>; do
  lxc config device add qorpera-exec-node02 "identity-${id}" disk pool=qorpera-vm \
    source="phql-a1-identity-${id}" path="/var/lib/qorpera/identities/${id}" --project qn25b2
done
lxc start qorpera-exec-node02 --project qn25b2
# Stage the package (node scripts/package-shared-execution-service.mjs --out <dir>)
# under /var/lib/qorpera-bootstrap/shared-execution and run the installer.
lxc file push --project qn25b2 -r <dir>/ qorpera-exec-node02/var/lib/qorpera-bootstrap/
lxc exec qorpera-exec-node02 --project qn25b2 -- \
  env QORPERA_SHARED_EXECUTION_SLOTS=16 bash /var/lib/qorpera-bootstrap/shared-execution/install-shared-execution-guest.sh
```

Then, inside the host: write `/etc/qorpera/shared-execution.env` from
`shared-execution.env.example`, place the service key, a fresh provider token,
the object-gateway token, the secret-broker runtime token and CA and the
office routes under `/etc/qorpera/shared-execution-credentials/`, write
`/etc/qorpera/runner-orchestrator.env` for an orchestrator enrolled with the
node's native adapter id, and enable `qorpera-shared-execution.service` and
`qorpera-runner-orchestrator.service`. Stop the node host's own orchestrator
first: two orchestrators with the same adapter compete for the same jobs.

Every newly pinned image needs the host rebuilt (its runner artifacts carry
the bundle pin and the Codex fence): as root on the node host,
`deploy/shared-execution/rebuild-exec-host.sh <fingerprint>` refuses while a
sandbox runs, rebuilds the instance in place, reinstalls the package, takes
the fence digest from the image, pushes the staged configuration and starts
the service; the orchestrator is started by hand once the cut is live.

When the policy lists the host exactly, the node's inventory observer pins the
host's configuration digest (it includes the `image.*` keys), so a rebuild makes
the node `unavailable` for placement and logins until the inventory policy is
re-enrolled. A host listed by role (`"role": "execution-host"`, #436,
`deploy/first-node/NODE-EXEC-HOST-BY-ROLE.md`) needs no re-enrol while the
release that pins its image is staged on the node. Re-enrolling: recompute the
digest with `exec-host-inventory-digest.py` (below) from
`lxc query /1.0/instances/<vm>?project=<project>`, replace the policy with
`qorpera_replace_runtime_node_inventory(policy, previous_sha256)`, write the
observer configuration and restart the observer. The host may carry no
`user.qorpera.*` key other than `user.qorpera.management_vm`. A rebuild keeps
every device, the identity devices included (`rebuild-exec-host.sh` refuses to
start the host if one went missing).

## Identity volumes on the execution host (2026-09-27)

A member's login lives on a Compute Identity volume that the node's login
gateway creates (`<QORPERA_LXD_IDENTITY_VOLUME_PREFIX><uuid>` in
`QORPERA_LXD_STORAGE_POOL`, project `QORPERA_LXD_PROJECT`), right after the
node reserved a login machine for that sign-in, account refresh or recovery.
The execution host reads it from exactly one disk device per identity, the
shape operators attached by hand since the pilot:

```
identity-<uuid>: { type: disk, pool: <pool>, source: <prefix><uuid>,
                   path: /var/lib/qorpera/identities/<uuid> }
```

No other key (no `readonly`, `required`, `shift`, mount options); read-write
like the volume's every other mount (login VM, one-run guest). The execution
service only reads it. The rule lives in
`packages/runner-orchestrator/src/execution-host-identity.ts`.

**Who attaches.** The node's LXD provider process (its login gateway), when
`QORPERA_LXD_EXECUTION_HOST_INSTANCE` and `QORPERA_LXD_EXECUTION_HOST_PROJECT`
are set (both or neither; the project must be the gateway's own, because
identity volumes are per project on `qn25b2`):

- right after it creates or finds the identity volume of a sign-in, account
  refresh or recovery on this node, before the login VM exists; bounded at
  30 s, and a failure is logged and never fails the login;
- on every reconcile pass (every 5 s), a sweep retries that attach for every
  login this node placed whose journal is still in the gateway's state root
  (live, or released less than a day ago), when its volume is exactly the
  gateway's: name `<prefix><uuid>`, custom filesystem volume, the configured
  size and the markers `user.qorpera.schema=qorpera.compute-identity-volume/v1`,
  `user.qorpera.compute_identity_id=<uuid>`,
  `user.qorpera.provider_adapter=<this adapter>`. It never attaches a volume
  for a login this node did not place (an admission refused, a volume made by
  anything else).

The host is read once; each missing identity is then its own change, decided
on its own read and written under that read's ETag, so a concurrent writer
(another attach, an operator) makes it retry from a fresh read rather than
overwrite, and a volume LXD cannot hot-plug never holds up the others. It only
adds devices: a device already named `identity-<uuid>` in any other shape (or
from a profile) is logged as refused and left alone. A lasting problem is
logged once a minute. LXD hot-plugs the disk into the running VM and its agent
mounts it; a stopped host gets it at its next start. A run that arrives before
the mount is deferred by the service (`NODE_IDENTITY_ELSEWHERE`, up to 2
minutes), as before.

**Inventory.** The node inventory policy entry of the host declares
`"identityVolumes": {"pool": "<pool>", "sourcePrefix": "<prefix>"}` (virtual
machines only; set through `qorpera_replace_runtime_node_inventory`). For that
entry the observer leaves devices of exactly the shape above out of the
configuration digest (only when the instance carries the device itself and its
expanded form is identical) and reports their identities, sorted, as the
entry's `identities`. Everything else in the entry stays exact: any other
device, config key, profile, size or type change is still a difference and
makes the node `unavailable`.

Which identities the host may mount
(`20260927190000_runtime_exec_host_identity_devices.sql`): those this node ever
reserved a login or account-refresh machine for (`qorpera_runtime_node_demands`,
kind `login`, reserved; released later or not) — the gateway creates an
identity volume only right after that reservation. For a node whose policy
declares an identity host the inventory context carries this set as
`acceptedIdentities`; the observer marks the host `INSTANCE_AUTHORITY_DIFFERS`
and publishes the node `unavailable` when any other identity is attached (the
receipt names the identities), and the registry checks the same set again. It
does not look at the identity's current home or status: a recovery in
progress, a home moved to another node or a member who left never takes the
node out. An `identities` report for an entry that does not declare
`identityVolumes` is refused; without the declaration, an attach changes the
digest exactly as before, and other nodes' context is unchanged.

Digest for enrolment (read-only). Once the entry declares `identityVolumes`,
every re-enrolment (each rebuild) **must** use this digest; the old full
digest no longer matches and would take the node out. The operator wrappers
must import `configuration()` from it (or copy it) instead of their own
`shape()`:

```sh
lxc query '/1.0/instances/qorpera-exec-node02?project=qn25b2' \
  | python3 deploy/shared-execution/exec-host-inventory-digest.py \
      --pool qorpera-vm --source-prefix phql-a1-identity-
# {"configurationSha256": "...", "identities": ["2742ef0f-…", "544fb8b7-…", "aba576d5-…"]}
```

Without `--pool/--source-prefix` it prints the old full digest (every device
counted), for an entry without `identityVolumes`.

**Detach.** Only a deleted company's identities are detached automatically:
the login gateway detaches the device, deletes the volume and confirms both
gone (company delete D4, `deploy/first-node/RUNTIME-COMPANY-DELETE.md`). A
rebuild that runs meanwhile stops with "lost Compute Identity devices"; when
the volume is gone too, it was retired: run the rebuild again. Nothing else
detaches automatically. A device of an identity whose
home moved to another node, or of a member who left, stays harmless: the
service refuses a stale copy (recovery epoch marker) and the identity stays
accepted, so it never takes the node out. To remove one (no live sandbox of
that identity: check `journals/` and `warm/`), remove the device and, in the
same step, rename or delete the volume, otherwise a sweep may put the device
back within 5 s (while that identity has a placed journal in the gateway's
state root):

```sh
lxc config device remove qorpera-exec-node02 identity-<uuid> --project qn25b2 \
  && lxc storage volume rename qorpera-vm phql-a1-identity-<uuid> retired-identity-<uuid> --project qn25b2
```

Removing a device changes nothing in the digest. Renaming a volume makes the
next login of that identity on this node create a fresh volume (and recover
into it).

### Rollout at a release cut (node 2)

Two provider settings on node 2, next to the current
`QORPERA_LXD_PROJECT=qn25b2`, `QORPERA_LXD_STORAGE_POOL=qorpera-vm`,
`QORPERA_LXD_IDENTITY_VOLUME_PREFIX=phql-a1-identity-`:

```
QORPERA_LXD_EXECUTION_HOST_INSTANCE=qorpera-exec-node02
QORPERA_LXD_EXECUTION_HOST_PROJECT=qn25b2
```

Both files, in the same step, before the provider restarts: the fixed
launcher (`deploy/node-agent/qorpera-node-launch.py`) starts a role only when
the env file's keys are exactly `node.json`'s fixed, secret and release keys
and every fixed value matches.

- `/etc/qorpera-node/provider.env.json`: add both under `env`;
- `/etc/qorpera-node/node.json` (root, 0444): add both, same values, under
  `roles.provider.fixed`.

Node 1 never sets them, its execution host included: with logins in the vault no identity volume is
attached to a host. Only node 2's host carries the two logins still on its disk.

Before the pause, read-only: every identity device already on the host must
be an accepted identity, or node 2 reads `unavailable` from step 4 on. Take
the uuids from the host's `identity-*` devices (today 2742ef0f…, 544fb8b7…,
aba576d5…); every row must say `true`:

```sql
-- node 2 = a139d86c-6134-426f-aea4-d9bb0e3122d1; uses the (node_id, allocation_id) index
select v.id, exists(select 1 from public.qorpera_runtime_node_demands d
    join public.qorpera_runtime_machine_allocations a on a.id = d.allocation_id
  where d.node_id = 'a139d86c-6134-426f-aea4-d9bb0e3122d1' and d.provider_kind = 'login'
    and d.reserved_at is not null and a.login_compute_identity_id = v.id) as accepted
from unnest(array[<each device's uuid>]::uuid[]) v(id);
```

Any `false`: detach it (see Detach) before step 4, or leave `identityVolumes`
undeclared until it is resolved.

Order, inside the usual pause:

1. SQL: `20260927190000_runtime_exec_host_identity_devices.sql` (three
   function replacements: enrol, observe, inventory context). Old observers,
   old policies and nodes without an identity host keep working unchanged.
2. Node release apply on node 2: provider build with this change plus the two
   settings above (both files); node observer package from the same source
   (`scripts/package-runtime-node-observer.mjs`). An observer older than this
   change cannot parse a policy that declares `identityVolumes`, so it must be
   the new build before step 4.
3. Execution host rebuild as usual (`rebuild-exec-host.sh`); it keeps and
   checks the identity devices.
4. Inventory: compute the digest with `exec-host-inventory-digest.py --pool
   qorpera-vm --source-prefix phql-a1-identity-`, take the current policy, set
   the exec host entry's `configurationSha256` to it and add
   `"identityVolumes": {"pool": "qorpera-vm", "sourcePrefix": "phql-a1-identity-"}`
   (once; later cuts keep it and only change the digest), replace it with
   `qorpera_replace_runtime_node_inventory(policy, previous_sha256)`, write the
   same policy into the observer configuration and restart the observer.
5. Check: node 2's observation is `ready` and its latest inventory receipt
   lists the exec host entry with `identities` = the devices on the host at
   that moment (the pre-checked ones, plus any login attached since). Resume,
   start the exec host orchestrator.
   Older volumes: the sweep only retries logins whose journal is still in the
   gateway's state root (released less than a day ago), so a volume from an
   older login that nobody attached stays unattached, and that member's runs
   keep failing until their next sign-in or refresh on node 2. List them
   (`lxc storage volume list qorpera-vm --project qn25b2 -f csv -c n | grep
   '^phql-a1-identity-'`, minus the host's `identity-*` devices), run the
   pre-check query on their uuids, and attach each accepted one by hand in the
   exact shape (now safe: the digest does not change and the identity is
   accepted) or ask that member to refresh. Leave any not-accepted one alone.
6. Acceptance: the next sign-in or account refresh on node 2 logs `attached
   Compute Identity <uuid>` (new identity) or nothing (already attached); node
   2 stays `ready` throughout; that member's first run is accepted on the exec
   host without an operator.

Rollback:

- Attach only: remove the two settings from both files (`provider.env.json`
  and `node.json` `roles.provider.fixed`) and restart the provider. Nothing
  else changes; new logins need the manual attach again, which (with the
  declared policy) no longer takes node 2 out as long as the identity is
  accepted.
- Everything: first replace the policy with the exec host entry without
  `identityVolumes` and the full digest (`exec-host-inventory-digest.py`
  without flags), update the observer configuration and restart it; then roll
  the node release back. The two settings may stay in both files: an older
  provider does not read them. The SQL can stay: it
  accepts old observers and policies unchanged. To restore the previous
  functions exactly, re-create them from
  `20260908003900_runtime_node_inventory.sql` (enrol, context) and
  `20260913000200_runtime_conflict_fences_and_lock_order.sql` (observe).

## Pilot findings (node 2, 2026-09-22)

- Six runs; the last four completed. Job created → runner accepted 2.1–5.4 s
  (one-run VM: 17–18 s); post → reply visible 12.5–20 s (was ~36 s).
- The pinned image runs `unattended-upgrades`: on the first long-lived host
  it upgraded 83 packages at 03:58Z and `needrestart` restarted every
  service, sandboxes included. The installer now masks the apt timers and
  the upgrade service; the pilot host was patched by hand and therefore
  differs from the pinned image until it is rebuilt.
- The native provider host does not exit on SIGTERM; a 45 s stop timeout
  held the slot. The host unit now stops in 10 s and the service never
  blocks on a stop.

## Capacity sizing (2026-09-25)

Node 2's execution host was reduced to **4 vCPU / 8 GiB, with two slots**.
The orchestrator and execution service share that allocation. The 16-vCPU,
32-GiB, 16-slot commands above describe the original pilot, not measured
minimum requirements. Preserve the deployed slot count in both the guest
environment and the host's staging environment when rebuilding.

Drain before changing size: hold new node admissions, stop and disable the
orchestrator, then stop the execution service. Check for live slot units and
unarchived journals again **after** the service stops: an acquire already in
flight can finish during shutdown. Refuse the resize if either remains.
Preserve the VM disk and identity mounts, update its limits and slot count,
and replace the inventory configuration digest. Update the observer and node
headroom together; resume dispatch only after fresh inventory is ready.

The deployed host allowance remains 4 CPU / 24 GiB, so node 2's total
infrastructure headroom is 8 CPU / 32 GiB after resizing. Customer CPU sharing
is a separate versioned node policy: `cpuAllocationRatio: 2` permits twice
the physical CPU remaining after headroom. Physical inventory stays unchanged
and RAM is never multiplied. Office and coding machines consume the same
customer budget; their guest vCPU and RAM sizes remain unchanged.

Acceptance included two concurrent synthetic workers allocating 1.5 GiB each
and exercising four CPU threads in total, plus the shared-slot lifecycle
tests. This verifies basic operation after resizing, not representative native
agent throughput. Measure real run latency, queue delay and peak memory before
raising execution concurrency.

## Not in this package

- Node capacity accounting for the execution host itself (`qorpera_reserve_runtime_node_machine`):
  the pilot host is not registered as a node machine; register it with the
  coordinator once the sandbox sizes have been measured.
- Login custody in the cloud secret broker (design § 3): with a single
  execution host the identity-home rule is already trivially satisfied.
- The proposal-review guest: it keeps its copy-isolated one-run VM.

## Second review round (2026-09-22)

- Unit state is read strictly: only an exit status with one state per unit is
  knowledge; a timeout, an abort or a spawn failure raises "Unit state is
  unavailable" and the pass gives up instead of reporting every unit inactive
  (which would have retired every running sandbox). `reloading`/`refreshing`
  count as active.
- Retire sends SIGKILL to a unit that ignored its stop. While anything still
  runs in a slot the journal stays `stopping` and the slot is quarantined; a
  sandbox is recorded `lost` only when its units are gone and the release RPC
  kept failing, and the archived `lost` journal keeps the allocation owed:
  reconcile retries the release from the archive until the control plane
  confirms.
- A same-attempt retry after the sandbox retired fails fast ("cannot be
  replayed after its sandbox retired"): the control plane binds the runner row
  to its first activation secret, so a fresh sandbox could never activate.
- The slot wipe also removes the runner account's `.local` and `.cache`
  (podman storage), so a tenant killed before its own `podman rm` leaves no
  rootfs to the next tenant of the same account.
- `rebuild-exec-host.sh` stops the orchestrator first, refuses while any slot
  unit is alive or any live journal exists, and keeps the service key off the
  command line.
